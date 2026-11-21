/**
 * Tests for persona tracking on POST /api/contest/entries.
 *
 * Covers:
 *  1. Valid persona values (executive, itmanager, none) are accepted (201)
 *  2. An invalid persona value is rejected with 400
 *  3. Omitting persona defaults to "none" and the entry is saved (201)
 *  4. persona is stored in the DB INSERT (verified via pool.query call args)
 *  5. persona column is returned in GET /api/contest/entries list response
 *  6. persona column is present in GET /api/contest/entries/export CSV header
 */

import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import express, { Request, Response, NextFunction } from "express";
import request from "supertest";

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockPoolQuery = vi.fn();

vi.mock("@workspace/db", () => ({
  pool: { query: (...args: unknown[]) => mockPoolQuery(...args) },
}));

vi.mock("../lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
  requireRole: (...roles: string[]) =>
    (req: Request, res: Response, next: NextFunction): void => {
      const user = (req as any)._mockUser as { role: string } | undefined;
      if (!user) { res.status(401).json({ error: "Unauthorized" }); return; }
      if (!roles.includes(user.role)) { res.status(403).json({ error: "Forbidden" }); return; }
      next();
    },
}));

vi.mock("../services/email", () => ({
  sendEmail: vi.fn().mockResolvedValue(true),
}));

import contestRouter, { _resetIpBucketsForTesting } from "../routes/contest";

// ── App builder ───────────────────────────────────────────────────────────────

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    const roleHeader = req.headers["x-mock-role"] as string | undefined;
    if (roleHeader) {
      const mockUser = { role: roleHeader, tenantId: 1 };
      (req as any)._mockUser = mockUser;
      (req as any).user      = mockUser;
    }
    next();
  });
  app.use("/api", contestRouter);
  return app;
}

// ── Shared valid payload (no persona — tests add/omit it individually) ─────────

const BASE_BODY = {
  name: "Jane Smith",
  org: "Acme Corp",
  designation: "IT Manager",
  email: "jane@example.com",
  mobile: "+1-555-0100",
  scenario: "airport",
  challenges: ["bg_noise"],
};

/** Make pool.query accept the two-step (INSERT + claim) sequence for a POST. */
function setupPostMocks() {
  mockPoolQuery.mockImplementation((sql: string) => {
    const s = sql.trim();
    if (s.includes("INSERT INTO contest_entries")) {
      return Promise.resolve({ rows: [{ id: 42, submitted_at: new Date().toISOString() }] });
    }
    if (s.includes("contest_confirmation_claims")) {
      return Promise.resolve({ rows: [{ email_normalized: "jane@example.com" }] });
    }
    return Promise.resolve({ rows: [] });
  });
}

// ── POST /api/contest/entries — persona validation ────────────────────────────

describe("POST /api/contest/entries – persona field", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetIpBucketsForTesting();
    setupPostMocks();
  });

  it.each(["executive", "itmanager", "none"] as const)(
    "accepts persona=%s and returns 201",
    async (persona) => {
      const app = buildApp();
      const res = await request(app)
        .post("/api/contest/entries")
        .send({ ...BASE_BODY, persona });
      expect(res.status).toBe(201);
      expect(res.body.ok).toBe(true);
    },
  );

  it("rejects an unknown persona value with 400", async () => {
    const app = buildApp();
    const res = await request(app)
      .post("/api/contest/entries")
      .send({ ...BASE_BODY, persona: "cxo" });
    expect(res.status).toBe(400);
  });

  it("defaults persona to 'none' when the field is omitted and saves the entry (201)", async () => {
    const app = buildApp();
    const res = await request(app)
      .post("/api/contest/entries")
      .send(BASE_BODY); // no persona key
    expect(res.status).toBe(201);

    // The INSERT SQL must have been called; persona='none' is the 14th param
    const insertCall = mockPoolQuery.mock.calls.find(
      ([sql]: [string]) => sql.includes("INSERT INTO contest_entries"),
    );
    expect(insertCall).toBeDefined();
    const params = insertCall![1] as unknown[];
    expect(params[13]).toBe("none"); // 14th param (0-indexed = 13)
  });

  it("stores the supplied persona value in the DB INSERT", async () => {
    const app = buildApp();
    await request(app)
      .post("/api/contest/entries")
      .send({ ...BASE_BODY, persona: "executive" });

    const insertCall = mockPoolQuery.mock.calls.find(
      ([sql]: [string]) => sql.includes("INSERT INTO contest_entries"),
    );
    expect(insertCall).toBeDefined();
    const params = insertCall![1] as unknown[];
    expect(params[13]).toBe("executive");
  });
});

// ── GET /api/contest/entries – persona in list response ──────────────────────

const ENTRY_WITH_PERSONA = {
  id: 1,
  name: "Alice",
  org: "Acme",
  designation: "IT Manager",
  email: "alice@example.com",
  mobile: "+1-555-0100",
  current_brand: null,
  demo_interest: null,
  marketing_consent: false,
  scenario: "airport",
  challenges: JSON.stringify(["bg_noise"]),
  utm_source: null,
  utm_medium: null,
  utm_campaign: null,
  persona: "executive",
  submitted_at: new Date().toISOString(),
};

describe("GET /api/contest/entries – persona in list", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns persona value in each entry object", async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [ENTRY_WITH_PERSONA] })
      .mockResolvedValueOnce({ rows: [{ total: "1" }] });

    const app = buildApp();
    const res = await request(app)
      .get("/api/contest/entries")
      .set("x-mock-role", "admin");

    expect(res.status).toBe(200);
    expect(res.body.entries[0].persona).toBe("executive");
  });
});

// ── GET /api/contest/entries/export – persona in CSV ────────────────────────

describe("GET /api/contest/entries/export – persona in CSV", () => {
  beforeEach(() => vi.clearAllMocks());

  it("includes 'persona' in the CSV header row", async () => {
    mockPoolQuery.mockResolvedValue({ rows: [] });
    const app = buildApp();
    const res = await request(app)
      .get("/api/contest/entries/export")
      .set("x-mock-role", "admin");

    expect(res.status).toBe(200);
    const header = res.text.split("\r\n")[0];
    expect(header).toContain("persona");
  });

  it("includes the persona value in the exported data row", async () => {
    mockPoolQuery.mockResolvedValue({ rows: [ENTRY_WITH_PERSONA] });
    const app = buildApp();
    const res = await request(app)
      .get("/api/contest/entries/export")
      .set("x-mock-role", "admin");

    expect(res.status).toBe(200);
    expect(res.text).toContain("executive");
  });
});
