/**
 * End-to-end smoke test for contest entry submission and retrieval.
 *
 * The round-trip test uses a stateful pool mock: the INSERT handler captures
 * the exact SQL parameters that POST /contest/entries passes, then the SELECT
 * handler for GET /contest/entries returns a DB row reconstructed from those
 * same parameters — so the test genuinely validates that what is written by
 * POST is what GET retrieves, rather than independently mocking both sides.
 *
 * challenges is asserted as a native JS array throughout.  PostgreSQL's pg
 * driver automatically parses JSONB columns to native types, so a correctly
 * working route will always return an array here — never a raw JSON string.
 *
 * Covers:
 *  1. POST returns 201 with the new entry id and submittedAt timestamp
 *  2. INSERT receives challenges as a JSON string, demo_interest, and UTM params
 *  3. Round-trip: GET /contest/entries (admin) reflects the row inserted by POST
 *  4. challenges comes back as a parsed array in the GET response
 *  5. demo_interest and UTM columns survive the round-trip intact
 *  6. Unauthenticated GET is rejected with 401
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
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

import contestRouter, { _resetIpBucketsForTesting } from "./contest";

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

// ── Shared fixtures ───────────────────────────────────────────────────────────

const SUBMITTED_AT = "2026-08-16T10:00:00.000Z";

const VALID_ENTRY = {
  name:             "Jane Smith",
  org:              "Acme Corp",
  designation:      "IT Manager",
  email:            "jane@example.com",
  mobile:           "+1-555-0100",
  scenario:         "airport",
  challenges:       ["bg_noise", "echo"],
  demoInterest:     "yes",
  marketingConsent: true,
  utmSource:        "linkedin",
  utmMedium:        "cpc",
  utmCampaign:      "q3-poly",
  persona:          "itmanager",
};

/**
 * Wire pool.query for a successful POST only.
 * The INSERT handler returns a fixed id + timestamp.
 * The confirmation-claim INSERT returns the winning row so the email fires.
 */
function setupPostMocks(entryId = 1) {
  mockPoolQuery.mockImplementation((sql: string) => {
    const s = sql.trim();
    if (s.includes("INSERT INTO contest_entries")) {
      return Promise.resolve({ rows: [{ id: entryId, submitted_at: SUBMITTED_AT }] });
    }
    if (s.includes("contest_confirmation_claims")) {
      return Promise.resolve({ rows: [{ email_normalized: "jane@example.com" }] });
    }
    return Promise.resolve({ rows: [] });
  });
}

// ── POST /api/contest/entries ─────────────────────────────────────────────────

describe("POST /api/contest/entries — submit a valid entry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetIpBucketsForTesting();
    setupPostMocks();
  });

  it("returns 201 with ok:true, the new entry id, and a submittedAt timestamp", async () => {
    const app = buildApp();
    const res = await request(app)
      .post("/api/contest/entries")
      .send(VALID_ENTRY);

    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.id).toBe(1);
    expect(res.body.submittedAt).toBe(SUBMITTED_AT);
  });

  it("passes challenges as a JSON string at INSERT parameter index 9 (10th param)", async () => {
    const app = buildApp();
    await request(app).post("/api/contest/entries").send(VALID_ENTRY);

    const insertCall = mockPoolQuery.mock.calls.find(
      ([sql]: [string]) => sql.includes("INSERT INTO contest_entries"),
    );
    expect(insertCall).toBeDefined();
    const params = insertCall![1] as unknown[];

    const challengesParam = params[9];
    expect(typeof challengesParam).toBe("string");
    expect(JSON.parse(challengesParam as string)).toEqual(["bg_noise", "echo"]);
  });

  it("passes demo_interest at INSERT parameter index 6 (7th param)", async () => {
    const app = buildApp();
    await request(app).post("/api/contest/entries").send(VALID_ENTRY);

    const insertCall = mockPoolQuery.mock.calls.find(
      ([sql]: [string]) => sql.includes("INSERT INTO contest_entries"),
    );
    expect(insertCall).toBeDefined();
    const params = insertCall![1] as unknown[];
    expect(params[6]).toBe("yes");
  });

  it("passes UTM fields at INSERT parameter indices 10, 11, 12", async () => {
    const app = buildApp();
    await request(app).post("/api/contest/entries").send(VALID_ENTRY);

    const insertCall = mockPoolQuery.mock.calls.find(
      ([sql]: [string]) => sql.includes("INSERT INTO contest_entries"),
    );
    expect(insertCall).toBeDefined();
    const params = insertCall![1] as unknown[];
    expect(params[10]).toBe("linkedin");
    expect(params[11]).toBe("cpc");
    expect(params[12]).toBe("q3-poly");
  });

  it("stores null for omitted UTM fields", async () => {
    const app = buildApp();
    const { utmSource, utmMedium, utmCampaign, ...noUtm } = VALID_ENTRY;
    await request(app).post("/api/contest/entries").send(noUtm);

    const insertCall = mockPoolQuery.mock.calls.find(
      ([sql]: [string]) => sql.includes("INSERT INTO contest_entries"),
    );
    expect(insertCall).toBeDefined();
    const params = insertCall![1] as unknown[];
    expect(params[10]).toBeNull();
    expect(params[11]).toBeNull();
    expect(params[12]).toBeNull();
  });
});

// ── GET /api/contest/entries — 401 without auth ───────────────────────────────

describe("GET /api/contest/entries — auth guard", () => {
  it("returns 401 when no auth header is sent", async () => {
    const app = buildApp();
    const res = await request(app).get("/api/contest/entries");
    expect(res.status).toBe(401);
  });
});

// ── Round-trip: POST then GET with stateful mock ──────────────────────────────
//
// The pool mock below is *stateful*:
//   - When the INSERT fires (POST handler), it captures the SQL parameters and
//     stores them in `capturedInsertParams`.
//   - When the SELECT for the list fires (GET handler), it reconstructs the DB
//     row from those same params and returns it.
//
// This guarantees the GET assertion is verifying what POST actually wrote — not
// an independently-typed fixture — so a mismatch between the INSERT params and
// the SELECT projection would cause the test to fail.
//
// challenges is returned as a native JS array in the reconstructed row because
// PostgreSQL's pg driver automatically parses JSONB columns; the test asserts
// it as such with no fallback normalization.

describe("Round-trip: POST entry is visible in subsequent GET with stateful mock", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetIpBucketsForTesting();
  });

  it("every field written by POST is returned by GET /contest/entries", async () => {
    const app = buildApp();
    let capturedInsertParams: unknown[] | null = null;

    // Stateful mock: capture INSERT params; reconstruct the row for SELECT.
    mockPoolQuery.mockImplementation((sql: string, params?: unknown[]) => {
      const s = sql.trim();

      // 1. Contest entry INSERT — capture params, return synthetic row
      if (s.includes("INSERT INTO contest_entries")) {
        capturedInsertParams = params ?? [];
        return Promise.resolve({ rows: [{ id: 42, submitted_at: SUBMITTED_AT }] });
      }

      // 2. Confirmation-claim INSERT — allow the email path to proceed
      if (s.includes("contest_confirmation_claims")) {
        return Promise.resolve({ rows: [{ email_normalized: "jane@example.com" }] });
      }

      // 3. Top-level count query (SELECT COUNT(*) AS total …) — must be checked
      //    BEFORE the list-row branch because the list SQL also embeds a
      //    COUNT(*)::int inside a lateral subquery and would otherwise match.
      if (s.startsWith("SELECT COUNT(*)") && s.includes("contest_entries")) {
        return Promise.resolve({ rows: [{ total: "1" }] });
      }

      // 4. List SELECT — reconstruct the DB row from the captured INSERT params.
      //    Column order matches the INSERT:
      //    $1=name $2=org $3=designation $4=email $5=mobile $6=current_brand
      //    $7=demo_interest $8=marketing_consent $9=scenario $10=challenges(JSON)
      //    $11=utm_source $12=utm_medium $13=utm_campaign $14=persona
      if (s.startsWith("SELECT") && s.includes("contest_entries") && capturedInsertParams) {
        const p = capturedInsertParams as unknown[];
        const row = {
          id:                   42,
          name:                 p[0],
          org:                  p[1],
          designation:          p[2],
          email:                p[3],
          mobile:               p[4],
          current_brand:        p[5] ?? null,
          demo_interest:        p[6] ?? null,
          marketing_consent:    p[7] ?? false,
          scenario:             p[8],
          // pg automatically parses JSONB → native JS type; simulate that here
          challenges:           JSON.parse(p[9] as string),
          utm_source:           p[10] ?? null,
          utm_medium:           p[11] ?? null,
          utm_campaign:         p[12] ?? null,
          persona:              p[13],
          submitted_at:         SUBMITTED_AT,
          // New lateral-join columns — null is fine for round-trip assertions
          contest_page_visits:  null,
          first_visit_at:       null,
          stage_reached_at:     null,
          contact_id:           null,
          contact_stage:        null,
          contact_lead_score:   null,
        };
        return Promise.resolve({ rows: [row] });
      }

      return Promise.resolve({ rows: [] });
    });

    // ── Step 1: POST the entry ─────────────────────────────────────────────
    const postRes = await request(app)
      .post("/api/contest/entries")
      .send(VALID_ENTRY);

    expect(postRes.status).toBe(201);
    expect(postRes.body.id).toBe(42);

    // Verify the INSERT captured params before proceeding
    expect(capturedInsertParams).not.toBeNull();

    // ── Step 2: Admin fetches the list ─────────────────────────────────────
    const getRes = await request(app)
      .get("/api/contest/entries")
      .set("x-mock-role", "admin");

    expect(getRes.status).toBe(200);
    expect(getRes.body.total).toBe(1);
    expect(getRes.body.entries).toHaveLength(1);

    const entry = getRes.body.entries[0];

    // ── Core identity fields ───────────────────────────────────────────────
    expect(entry.id).toBe(42);
    expect(entry.name).toBe(VALID_ENTRY.name);
    expect(entry.org).toBe(VALID_ENTRY.org);
    expect(entry.email).toBe(VALID_ENTRY.email);
    expect(entry.scenario).toBe(VALID_ENTRY.scenario);

    // ── challenges must be a parsed array, not a JSON string ───────────────
    // JSONB columns come back as native JS types from pg; the route must not
    // re-serialize them.  Accepting a string here would mask a contract bug.
    expect(Array.isArray(entry.challenges)).toBe(true);
    expect(entry.challenges).toEqual(["bg_noise", "echo"]);

    // ── demo_interest ──────────────────────────────────────────────────────
    expect(entry.demo_interest).toBe("yes");

    // ── UTM columns ───────────────────────────────────────────────────────
    expect(entry.utm_source).toBe("linkedin");
    expect(entry.utm_medium).toBe("cpc");
    expect(entry.utm_campaign).toBe("q3-poly");
  });
});
