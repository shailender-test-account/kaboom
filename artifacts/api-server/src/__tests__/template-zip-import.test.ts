/**
 * Tests for POST /api/templates/import-zip
 *
 * Covers:
 *  1. Rejects request with no file
 *  2. Rejects an invalid (non-zip) buffer
 *  3. Rejects a zip with no HTML file
 *  4. Imports HTML + images: uploads each image, rewrites src/background/url()
 *     references to storage URLs, creates the template, registers media assets
 *  5. Leaves absolute http(s)/data: references untouched
 *  6. Prefers index.html when multiple HTML files exist
 *  7. Uses <title> as the subject, zip filename as the template name
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import AdmZip from "adm-zip";

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockInsertValues = vi.fn();
const mockDbExecute = vi.fn().mockResolvedValue({ rows: [] });

vi.mock("@workspace/db", () => ({
  db: {
    insert: vi.fn(() => ({
      values: (vals: unknown) => {
        mockInsertValues(vals);
        return {
          returning: async () => [{ id: 42, ...(vals as object) }],
        };
      },
    })),
    select: vi.fn(),
    execute: (...args: unknown[]) => mockDbExecute(...args),
  },
  emailTemplatesTable: {},
  contactsTable: {},
}));

vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (req: any, _res: unknown, next: () => void) => {
    req.user = { id: 1, tenantId: 1, role: "admin" };
    next();
  },
  requireRole: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock("../lib/email/templateRenderer", () => ({
  BUILT_IN_TEMPLATES: [],
  loadTemplateHtml: vi.fn(),
  renderTemplate: vi.fn(),
  htmlToPlainText: (html: string) => html.replace(/<[^>]+>/g, " ").trim(),
}));

vi.mock("../services/email", () => ({
  sendEmail: vi.fn(),
  injectJourneyTrackingLinks: vi.fn(),
}));

let uploadCounter = 0;
vi.mock("../lib/objectStorage", () => ({
  ObjectStorageService: class {
    async getObjectEntityUploadURL() {
      uploadCounter += 1;
      return `https://storage.googleapis.com/bucket/.private/uploads/img-${uploadCounter}`;
    }
    normalizeObjectEntityPath(url: string) {
      const id = url.split("/").pop();
      return `/objects/uploads/${id}`;
    }
  },
  ObjectNotFoundError: class extends Error {},
}));

// fetch is used for the presigned PUT
const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
vi.stubGlobal("fetch", mockFetch);

import templatesRouter from "../routes/templates";

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api", templatesRouter);
  return app;
}

function makeZip(files: Record<string, string | Buffer>): Buffer {
  const zip = new AdmZip();
  for (const [name, content] of Object.entries(files)) {
    zip.addFile(name, Buffer.isBuffer(content) ? content : Buffer.from(content));
  }
  return zip.toBuffer();
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

beforeEach(() => {
  vi.clearAllMocks();
  mockFetch.mockResolvedValue({ ok: true, status: 200 });
  mockDbExecute.mockResolvedValue({ rows: [] });
  uploadCounter = 0;
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("POST /api/templates/import-zip", () => {
  it("rejects a request without a file", async () => {
    const res = await request(buildApp()).post("/api/templates/import-zip");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no file/i);
  });

  it("rejects an invalid zip buffer", async () => {
    const res = await request(buildApp())
      .post("/api/templates/import-zip")
      .attach("file", Buffer.from("this is not a zip"), "mailer.zip");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid zip/i);
  });

  it("rejects a zip with no HTML file", async () => {
    const buf = makeZip({ "images/logo.png": PNG });
    const res = await request(buildApp())
      .post("/api/templates/import-zip")
      .attach("file", buf, "mailer.zip");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no html/i);
  });

  it("imports HTML, uploads images, and rewrites references", async () => {
    const html = `<html><head><title>Big Sale</title></head><body>
      <img src="images/hero.png">
      <img src="./logo.png">
      <td background="images/bg.jpg">x</td>
      <div style="background-image:url('images/hero.png')"></div>
      <img src="https://cdn.example.com/keep.png">
      <img src="data:image/gif;base64,R0lGOD">
    </body></html>`;
    const buf = makeZip({
      "index.html": html,
      "images/hero.png": PNG,
      "logo.png": PNG,
      "images/bg.jpg": PNG,
    });

    const res = await request(buildApp())
      .post("/api/templates/import-zip")
      .attach("file", buf, "summer-mailer.zip");

    expect(res.status).toBe(201);
    expect(res.body.imagesImported).toBe(3);
    // one presigned PUT per image
    expect(mockFetch).toHaveBeenCalledTimes(3);
    // media_assets INSERT per image
    expect(mockDbExecute).toHaveBeenCalledTimes(3);

    const saved = mockInsertValues.mock.calls[0][0] as any;
    expect(saved.tenantId).toBe(1);
    expect(saved.name).toBe("summer-mailer");
    expect(saved.subject).toBe("Big Sale");
    // all three local refs rewritten to storage URLs
    expect(saved.bodyHtml).toMatch(/src="\/api\/storage\/objects\/uploads\/img-\d+"/);
    expect(saved.bodyHtml).toMatch(/background="\/api\/storage\/objects\/uploads\/img-\d+"/);
    expect(saved.bodyHtml).toMatch(/url\('\/api\/storage\/objects\/uploads\/img-\d+'\)/);
    // no unresolved local refs remain
    expect(saved.bodyHtml).not.toMatch(/src="images\//);
    expect(saved.bodyHtml).not.toMatch(/src="\.\/logo/);
    // absolute + data: untouched
    expect(saved.bodyHtml).toContain('src="https://cdn.example.com/keep.png"');
    expect(saved.bodyHtml).toContain('src="data:image/gif;base64,R0lGOD"');
  });

  it("prefers index.html over other HTML files", async () => {
    const buf = makeZip({
      "other.html": "<html><body>WRONG</body></html>",
      "index.html": "<html><head><title>Right</title></head><body>RIGHT</body></html>",
    });
    const res = await request(buildApp())
      .post("/api/templates/import-zip")
      .attach("file", buf, "m.zip");
    expect(res.status).toBe(201);
    const saved = mockInsertValues.mock.calls[0][0] as any;
    expect(saved.bodyHtml).toContain("RIGHT");
    expect(saved.subject).toBe("Right");
  });

  it("falls back to zip filename when no <title>", async () => {
    const buf = makeZip({ "mail.html": "<html><body>Hello</body></html>" });
    const res = await request(buildApp())
      .post("/api/templates/import-zip")
      .attach("file", buf, "october-blast.zip");
    expect(res.status).toBe(201);
    const saved = mockInsertValues.mock.calls[0][0] as any;
    expect(saved.name).toBe("october-blast");
    expect(saved.subject).toBe("october-blast");
  });

  it("rewrites srcset candidates while keeping descriptors", async () => {
    const buf = makeZip({
      "index.html": '<img srcset="images/a.png 1x, https://cdn.x/b.png 2x">',
      "images/a.png": PNG,
    });
    const res = await request(buildApp())
      .post("/api/templates/import-zip")
      .attach("file", buf, "m.zip");
    expect(res.status).toBe(201);
    const saved = mockInsertValues.mock.calls[0][0] as any;
    expect(saved.bodyHtml).toMatch(/srcset="\/api\/storage\/objects\/uploads\/img-\d+ 1x, https:\/\/cdn\.x\/b\.png 2x"/);
  });

  it("skips SVG files (not uploaded as images)", async () => {
    const buf = makeZip({
      "index.html": '<img src="a.svg"><img src="b.png">',
      "a.svg": "<svg onload=\"alert(1)\"></svg>",
      "b.png": PNG,
    });
    const res = await request(buildApp())
      .post("/api/templates/import-zip")
      .attach("file", buf, "m.zip");
    expect(res.status).toBe(201);
    expect(res.body.imagesImported).toBe(1);
    const saved = mockInsertValues.mock.calls[0][0] as any;
    // svg ref left as-is (not rewritten, not uploaded)
    expect(saved.bodyHtml).toContain('src="a.svg"');
  });

  it("rejects a zip with too many entries", async () => {
    const files: Record<string, string | Buffer> = { "index.html": "<html></html>" };
    for (let i = 0; i < 201; i++) files[`f${i}.txt`] = "x";
    const res = await request(buildApp())
      .post("/api/templates/import-zip")
      .attach("file", makeZip(files), "m.zip");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/too many files/i);
  });

  it("returns 502 when an image upload fails", async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500 });
    const buf = makeZip({
      "index.html": '<img src="a.png">',
      "a.png": PNG,
    });
    const res = await request(buildApp())
      .post("/api/templates/import-zip")
      .attach("file", buf, "m.zip");
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/failed to upload/i);
  });
});
