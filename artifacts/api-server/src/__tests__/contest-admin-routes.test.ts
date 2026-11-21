/**
 * Tests for admin-only contest routes:
 *   GET /api/contest/entries
 *   GET /api/contest/entries/export
 *
 * Covers:
 *  1. Non-admin is rejected with 403
 *  2. Unauthenticated request is rejected with 401
 *  3. Admin receives entries list with total count
 *  4. Scenario filter returns only matching rows
 *  5. demoInterest=yes filter returns only matching rows
 *  6. demoInterest=none filter returns only rows with NULL demo_interest
 *  7. Text search (search=) filters by name/org/email/designation
 *  8. Export returns CSV with correct headers
 *  9. CSV export neutralizes formula-injection prefixes (=, +, -, @)
 * 10. Export applies the same scenario/demoInterest/search filters
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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

vi.mock("../services/email", () => ({
  sendEmail: vi.fn().mockResolvedValue(true),
}));

// requireRole returns a middleware; the mock must honour the role check.
vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
  requireRole: (...roles: string[]) =>
    (req: Request, res: Response, next: NextFunction): void => {
      const user = (req as any)._mockUser as { role: string } | undefined;
      if (!user) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }
      if (!roles.includes(user.role)) {
        res.status(403).json({ error: "Forbidden" });
        return;
      }
      next();
    },
}));

import contestRouter from "../routes/contest";

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildApp() {
  const app = express();
  app.use(express.json());
  // Inject a synthetic _mockUser onto req so the requireRole mock can inspect it.
  // Also set req.user (with a stub tenantId) so route handlers that read
  // req.user.tenantId don't throw when the real auth middleware is mocked out.
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

const ENTRY = {
  id: 1,
  name: "Alice",
  org: "Acme",
  designation: "IT Manager",
  email: "alice@example.com",
  mobile: "+1-555-0100",
  current_brand: "Jabra",
  demo_interest: "yes",
  marketing_consent: false,
  scenario: "airport",
  challenges: JSON.stringify(["bg_noise"]),
  utm_source: "linkedin",
  utm_medium: "cpc",
  utm_campaign: "q3-2025",
  submitted_at: new Date().toISOString(),
};

/** Returns rows: [ENTRY], total: 1 for any query */
function mockOneEntry(overrides: Partial<typeof ENTRY> = {}) {
  const entry = { ...ENTRY, ...overrides };
  mockPoolQuery.mockResolvedValue({ rows: [entry] });
}

/** First call → list rows, second call → count */
function mockListAndCount(entries: Partial<typeof ENTRY>[], total?: number) {
  const rows = entries.map(o => ({ ...ENTRY, ...o }));
  mockPoolQuery
    .mockResolvedValueOnce({ rows })
    .mockResolvedValueOnce({ rows: [{ total: String(total ?? rows.length) }] });
}

// ── Authorization ─────────────────────────────────────────────────────────────

describe("GET /api/contest/entries – authorization", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 401 when unauthenticated", async () => {
    const app = buildApp();
    const res = await request(app).get("/api/contest/entries");
    expect(res.status).toBe(401);
  });

  it("returns 403 for a non-admin user", async () => {
    const app = buildApp();
    const res = await request(app)
      .get("/api/contest/entries")
      .set("x-mock-role", "editor");
    expect(res.status).toBe(403);
  });

  it("returns 200 for an admin user", async () => {
    mockListAndCount([]);
    const app = buildApp();
    const res = await request(app)
      .get("/api/contest/entries")
      .set("x-mock-role", "admin");
    expect(res.status).toBe(200);
  });
});

describe("GET /api/contest/entries/export – authorization", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 401 when unauthenticated", async () => {
    const app = buildApp();
    const res = await request(app).get("/api/contest/entries/export");
    expect(res.status).toBe(401);
  });

  it("returns 403 for a non-admin user", async () => {
    const app = buildApp();
    const res = await request(app)
      .get("/api/contest/entries/export")
      .set("x-mock-role", "manager");
    expect(res.status).toBe(403);
  });

  it("returns 200 CSV for an admin", async () => {
    mockPoolQuery.mockResolvedValue({ rows: [] });
    const app = buildApp();
    const res = await request(app)
      .get("/api/contest/entries/export")
      .set("x-mock-role", "admin");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/csv/);
  });
});

// ── List endpoint ─────────────────────────────────────────────────────────────

describe("GET /api/contest/entries – list", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns entries array and total", async () => {
    mockListAndCount([ENTRY], 1);
    const app = buildApp();
    const res = await request(app)
      .get("/api/contest/entries")
      .set("x-mock-role", "admin");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ total: 1 });
    expect(res.body.entries).toHaveLength(1);
    expect(res.body.entries[0].email).toBe("alice@example.com");
  });

  it("passes scenario filter to the database query", async () => {
    mockListAndCount([]);
    const app = buildApp();
    await request(app)
      .get("/api/contest/entries?scenario=airport")
      .set("x-mock-role", "admin");
    // The first pool.query call is the list; verify the SQL includes a scenario filter.
    const [listSql] = mockPoolQuery.mock.calls[0] as [string, unknown[]];
    expect(listSql).toContain("LOWER(scenario)");
  });

  it("passes demoInterest=yes filter to the database query", async () => {
    mockListAndCount([]);
    const app = buildApp();
    await request(app)
      .get("/api/contest/entries?demoInterest=yes")
      .set("x-mock-role", "admin");
    const [listSql] = mockPoolQuery.mock.calls[0] as [string, unknown[]];
    expect(listSql).toContain("demo_interest");
  });

  it("passes demoInterest=none filter (NULL check) to the query", async () => {
    mockListAndCount([]);
    const app = buildApp();
    await request(app)
      .get("/api/contest/entries?demoInterest=none")
      .set("x-mock-role", "admin");
    const [listSql] = mockPoolQuery.mock.calls[0] as [string, unknown[]];
    expect(listSql).toContain("demo_interest IS NULL");
  });

  it("passes text search filter to the database query", async () => {
    mockListAndCount([]);
    const app = buildApp();
    await request(app)
      .get("/api/contest/entries?search=alice")
      .set("x-mock-role", "admin");
    const [listSql] = mockPoolQuery.mock.calls[0] as [string, unknown[]];
    expect(listSql).toContain("ILIKE");
  });

  it("normalizes email whitespace and casing when matching a contact", async () => {
    mockListAndCount([]);
    const app = buildApp();
    await request(app)
      .get("/api/contest/entries")
      .set("x-mock-role", "admin");

    const [listSql] = mockPoolQuery.mock.calls[0] as [string, unknown[]];
    expect(listSql).toContain("LOWER(BTRIM(COALESCE(ce.email, '')))");
    expect(listSql).toContain("LOWER(BTRIM(COALESCE(ct.email, '')))");
  });

  it("uses normalized phone only as an unambiguous fallback", async () => {
    mockListAndCount([]);
    const app = buildApp();
    await request(app)
      .get("/api/contest/entries")
      .set("x-mock-role", "admin");

    const [listSql] = mockPoolQuery.mock.calls[0] as [string, unknown[]];
    expect(listSql).toContain("REGEXP_REPLACE(COALESCE(ce.mobile, ''), '[^0-9]', '', 'g')");
    expect(listSql).toContain("REGEXP_REPLACE(COALESCE(ct.phone, ''), '[^0-9]', '', 'g')");
    expect(listSql).toContain("NOT EXISTS (SELECT 1 FROM candidates em WHERE em.email_match)");
    expect(listSql).toContain("(SELECT COUNT(*) FROM candidates pm WHERE pm.phone_match) = 1");
  });
});

// ── Export endpoint ───────────────────────────────────────────────────────────

describe("GET /api/contest/entries/export – CSV", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns all columns in the CSV header", async () => {
    mockPoolQuery.mockResolvedValue({ rows: [] });
    const app = buildApp();
    const res = await request(app)
      .get("/api/contest/entries/export")
      .set("x-mock-role", "admin");
    const firstLine = res.text.split("\r\n")[0];
    expect(firstLine).toContain("name");
    expect(firstLine).toContain("email");
    expect(firstLine).toContain("scenario");
    expect(firstLine).toContain("demo_interest");
    expect(firstLine).toContain("utm_source");
  });

  it("applies scenario filter to the export query", async () => {
    mockPoolQuery.mockResolvedValue({ rows: [] });
    const app = buildApp();
    await request(app)
      .get("/api/contest/entries/export?scenario=home")
      .set("x-mock-role", "admin");
    const [sql] = mockPoolQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("LOWER(scenario)");
  });

  it("applies search filter to the export query", async () => {
    mockPoolQuery.mockResolvedValue({ rows: [] });
    const app = buildApp();
    await request(app)
      .get("/api/contest/entries/export?search=bob")
      .set("x-mock-role", "admin");
    const [sql] = mockPoolQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("ILIKE");
  });

  it("neutralizes formula-injection prefixes in exported cells", async () => {
    const malicious = {
      ...ENTRY,
      name: "=HYPERLINK(\"http://evil.example\")",
      org: "+ExcelFormula",
      designation: "-CMD",
      email: "@malicious@example.com",
      utm_source: null,
      utm_medium: null,
      utm_campaign: null,
    };
    mockPoolQuery.mockResolvedValue({ rows: [malicious] });
    const app = buildApp();
    const res = await request(app)
      .get("/api/contest/entries/export")
      .set("x-mock-role", "admin");
    expect(res.status).toBe(200);
    // Every formula-leading cell must be prefixed with a single-quote inside the quotes
    expect(res.text).toContain(`'=HYPERLINK`);
    expect(res.text).toContain(`'+ExcelFormula`);
    expect(res.text).toContain(`'-CMD`);
    expect(res.text).toContain(`'@malicious`);
  });

  it("sets correct Content-Disposition attachment header", async () => {
    mockPoolQuery.mockResolvedValue({ rows: [] });
    const app = buildApp();
    const res = await request(app)
      .get("/api/contest/entries/export")
      .set("x-mock-role", "admin");
    expect(res.headers["content-disposition"]).toMatch(/attachment.*filename/);
    expect(res.headers["content-disposition"]).toMatch(/contest-entries/);
  });
});

// ── Persona filter ─────────────────────────────────────────────────────────────

describe("GET /api/contest/entries – persona filter", () => {
  beforeEach(() => vi.clearAllMocks());

  it("passes persona=executive filter to the database query", async () => {
    mockListAndCount([]);
    const app = buildApp();
    await request(app)
      .get("/api/contest/entries?persona=executive")
      .set("x-mock-role", "admin");
    const [listSql] = mockPoolQuery.mock.calls[0] as [string, unknown[]];
    expect(listSql).toContain("LOWER(persona)");
  });

  it("passes persona=itmanager filter to the database query", async () => {
    mockListAndCount([]);
    const app = buildApp();
    await request(app)
      .get("/api/contest/entries?persona=itmanager")
      .set("x-mock-role", "admin");
    const [listSql] = mockPoolQuery.mock.calls[0] as [string, unknown[]];
    expect(listSql).toContain("LOWER(persona)");
  });

  it("persona=none filter matches NULL and literal 'none' rows (IS NULL OR LOWER(persona) = 'none')", async () => {
    mockListAndCount([]);
    const app = buildApp();
    await request(app)
      .get("/api/contest/entries?persona=none")
      .set("x-mock-role", "admin");
    const [listSql] = mockPoolQuery.mock.calls[0] as [string, unknown[]];
    expect(listSql).toContain("persona IS NULL");
    expect(listSql).toContain("LOWER(persona) = 'none'");
  });
});

describe("GET /api/contest/entries/export – persona filter", () => {
  beforeEach(() => vi.clearAllMocks());

  it("applies persona=executive filter to the export query", async () => {
    mockPoolQuery.mockResolvedValue({ rows: [] });
    const app = buildApp();
    await request(app)
      .get("/api/contest/entries/export?persona=executive")
      .set("x-mock-role", "admin");
    const [sql] = mockPoolQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("LOWER(persona)");
  });

  it("applies persona=none filter to the export query (IS NULL OR 'none')", async () => {
    mockPoolQuery.mockResolvedValue({ rows: [] });
    const app = buildApp();
    await request(app)
      .get("/api/contest/entries/export?persona=none")
      .set("x-mock-role", "admin");
    const [sql] = mockPoolQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("persona IS NULL");
    expect(sql).toContain("LOWER(persona) = 'none'");
  });

  it("persona column is present in the CSV header", async () => {
    mockPoolQuery.mockResolvedValue({ rows: [] });
    const app = buildApp();
    const res = await request(app)
      .get("/api/contest/entries/export?persona=itmanager")
      .set("x-mock-role", "admin");
    expect(res.status).toBe(200);
    const header = res.text.split("\r\n")[0];
    expect(header).toContain("persona");
  });
});
