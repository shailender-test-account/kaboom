/**
 * Stress test: GET /api/email-sequences/:id/enrollments with 1 000 rows.
 *
 * Verifies that the endpoint stays responsive (≤ 200 ms total round-trip,
 * including JSON serialisation) when a sequence has 200 contacts each
 * re-enrolled 5 times, producing 1 000 rows in the DB result set.
 *
 * The DB is fully mocked so this is a pure in-process timing measurement —
 * network, connection-pool latency, and real query execution are excluded.
 * The test therefore isolates the cost of:
 *   - the pool.query() call (mocked to return 1 000 rows instantly)
 *   - Express request/response serialisation
 *   - JSON stringification of the 1 000-row payload
 *
 * Done-looks-like assertions (from the task spec):
 *  ✓  1 000-row payload is returned with HTTP 200
 *  ✓  Every row carries re_enrollment_number (assigned DB-side via ROW_NUMBER)
 *  ✓  Total handler time (excl. real DB I/O) is ≤ 200 ms
 *  ✓  Row count in the response matches the fixture exactly
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// ── Constants ─────────────────────────────────────────────────────────────────

const TENANT_ID   = 1;
const SEQUENCE_ID = 42;

const CONTACTS       = 200;
const RE_ENROLLMENTS = 5;
const TOTAL_ROWS     = CONTACTS * RE_ENROLLMENTS; // 1 000

// ── Fixture ───────────────────────────────────────────────────────────────────

/**
 * Builds 1 000 enrollment rows mirroring the shape produced by the raw SQL
 * in GET /email-sequences/:id/enrollments (pool.query with ROW_NUMBER).
 *
 * Rows are interleaved across contacts (round-robin by re-enrollment number)
 * then sorted newest-first, matching the ORDER BY enrolled_at DESC the API
 * applies.
 */
function buildFixtureRows() {
  const rows: Array<{
    id: number;
    sequence_id: number;
    contact_id: number;
    status: string;
    current_step_id: number | null;
    enrolled_at: string;
    completed_at: string | null;
    first_name: string;
    last_name: string;
    email: string;
    lead_score: number;
    re_enrollment_number: number;
  }> = [];

  for (let round = 0; round < RE_ENROLLMENTS; round++) {
    for (let c = 0; c < CONTACTS; c++) {
      const contactId  = 10_000 + c;
      const enrolledMs =
        Date.now() -
        (RE_ENROLLMENTS - round) * 7 * 24 * 60 * 60 * 1000 +
        c * 60 * 1000;
      const isLatest = round === RE_ENROLLMENTS - 1;
      rows.push({
        id:                   c * RE_ENROLLMENTS + round + 1,
        sequence_id:          SEQUENCE_ID,
        contact_id:           contactId,
        status:               isLatest ? "active" : "completed",
        current_step_id:      null,
        enrolled_at:          new Date(enrolledMs).toISOString(),
        completed_at:         isLatest ? null : new Date(enrolledMs + 3_600_000).toISOString(),
        first_name:           `First${c}`,
        last_name:            `Last${c}`,
        email:                `contact${c}@load.test`,
        lead_score:           (c % 100) + 1,
        re_enrollment_number: round + 1,
      });
    }
  }

  // Sort newest-first to match ORDER BY enrolled_at DESC
  return rows.sort(
    (a, b) => new Date(b.enrolled_at).getTime() - new Date(a.enrolled_at).getTime(),
  );
}

const FIXTURE_ROWS = buildFixtureRows();

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockPoolQuery = vi.fn();

vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { id: 1, tenantId: TENANT_ID, role: "admin" };
    next();
  },
}));

vi.mock("@workspace/db", () => {
  // Thenable chain for db.select()…
  function makeThenableChain(result: unknown[]): any {
    const chain: any = {};
    chain.then  = (resolve: (v: unknown) => void, reject?: (e: unknown) => void) =>
      Promise.resolve(result).then(resolve, reject);
    chain.catch = (fn: (e: unknown) => void) => Promise.resolve(result).catch(fn);
    for (const m of ["from", "where", "orderBy", "limit", "offset", "leftJoin"]) {
      chain[m] = vi.fn().mockReturnValue(chain);
    }
    return chain;
  }

  // Use literals here — vi.mock factories are hoisted before constants initialize
  const sequenceRow = { id: 42, tenantId: 1, nodesJson: { nodes: [], edges: [] } };

  return {
    db: {
      select: () => makeThenableChain([sequenceRow]),
      insert: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    pool: { query: (...args: unknown[]) => mockPoolQuery(...args) },
    emailSequencesTable:      Symbol("emailSequencesTable"),
    sequenceEnrollmentsTable: Symbol("sequenceEnrollmentsTable"),
    sequenceStepsTable:       Symbol("sequenceStepsTable"),
    contactsTable:            Symbol("contactsTable"),
    playsTable:               Symbol("playsTable"),
  };
});

vi.mock("../services/queue", () => ({
  enqueueStep:            vi.fn().mockResolvedValue(undefined),
  isTenantQueueAvailable: vi.fn().mockResolvedValue(true),
}));

vi.mock("../lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("drizzle-orm", () => ({
  and:     (...args: unknown[]) => ({ _type: "and",   args }),
  eq:      (...args: unknown[]) => ({ _type: "eq",    args }),
  asc:     (...args: unknown[]) => ({ _type: "asc",   args }),
  desc:    (...args: unknown[]) => ({ _type: "desc",  args }),
  inArray: (...args: unknown[]) => ({ _type: "inArray", args }),
  sql:     Object.assign(
    (strings: TemplateStringsArray, ...vals: unknown[]) => ({ _type: "sql", strings, vals }),
    { join: vi.fn().mockReturnValue({ _type: "sql_join" }) },
  ),
}));

// ── Import router AFTER mocks ─────────────────────────────────────────────────

import emailSequencesRouter from "../routes/email-sequences";

// ── App factory ───────────────────────────────────────────────────────────────

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api", emailSequencesRouter);
  return app;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe(`GET /api/email-sequences/:id/enrollments — ${TOTAL_ROWS}-row stress (${CONTACTS} contacts × ${RE_ENROLLMENTS} re-enrollments)`, () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // pool.query is called once by this endpoint to fetch enrollment rows
    mockPoolQuery.mockResolvedValue({ rows: FIXTURE_ROWS });
  });

  it(`returns HTTP 200 with all ${TOTAL_ROWS} rows`, async () => {
    const app = express();
    app.use(express.json());
    app.use("/api", emailSequencesRouter);

    const res = await request(app)
      .get(`/api/email-sequences/${SEQUENCE_ID}/enrollments`)
      .expect(200);

    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(TOTAL_ROWS);
  });

  it("every row carries a re_enrollment_number field", async () => {
    const app = buildApp();
    const res = await request(app)
      .get(`/api/email-sequences/${SEQUENCE_ID}/enrollments`)
      .expect(200);

    for (const row of res.body as any[]) {
      expect(typeof row.re_enrollment_number).toBe("number");
      expect(row.re_enrollment_number).toBeGreaterThanOrEqual(1);
    }
  });

  it(`total handler time (excl. real DB I/O) is ≤ 200 ms for ${TOTAL_ROWS} rows`, async () => {
    const app = buildApp();
    const start = performance.now();
    await request(app)
      .get(`/api/email-sequences/${SEQUENCE_ID}/enrollments`)
      .expect(200);
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(200);
  });

  it("response rows preserve the same order the DB returned (enrolled_at DESC)", async () => {
    const app = buildApp();
    const res = await request(app)
      .get(`/api/email-sequences/${SEQUENCE_ID}/enrollments`)
      .expect(200);

    const body = res.body as Array<{ enrolled_at: string }>;
    for (let i = 0; i < body.length - 1; i++) {
      expect(
        new Date(body[i].enrolled_at).getTime(),
      ).toBeGreaterThanOrEqual(
        new Date(body[i + 1].enrolled_at).getTime(),
      );
    }
  });

  it("unique contact IDs in the response match the fixture (200 distinct contacts)", async () => {
    const app = buildApp();
    const res = await request(app)
      .get(`/api/email-sequences/${SEQUENCE_ID}/enrollments`)
      .expect(200);

    const contactIds = new Set(
      (res.body as Array<{ contact_id: number }>).map((r) => r.contact_id),
    );
    expect(contactIds.size).toBe(CONTACTS);
  });
});
