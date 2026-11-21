/**
 * Tests confirming a sequence run cannot be permanently stuck when background
 * audience resolution fails mid-launch.
 *
 * Three scenarios covered:
 *  1. The POST handler's background setImmediate throws during audience
 *     resolution → the run is immediately marked status='error' (not left at
 *     total_contacts=-1 forever).
 *  2. resumeInterruptedRuns SKIPS runs with total_contacts=-1 that are <15 min
 *     old (they are still resolving in the background).
 *  3. resumeInterruptedRuns EXPIRES runs with total_contacts=-1 that are >15
 *     min old to status='error' (background resolution never completed).
 */

import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import express from "express";
import request from "supertest";

// ── Constants ─────────────────────────────────────────────────────────────────

const TENANT_ID  = 11;
const USER_ID    = 55;
const SEQ_ID     = 7;
const NEW_RUN_ID = 1001;

// ── Pool query mock ───────────────────────────────────────────────────────────

type QueryResult = { rows: Record<string, unknown>[] };

const queryQueue: (QueryResult | Error)[] = [];
const allQueries: { sql: string; params: unknown[] }[] = [];

const mockPoolQuery: Mock = vi.fn().mockImplementation((sql: string, params: unknown[]) => {
  allQueries.push({ sql: (sql ?? "").trim(), params: params ?? [] });
  const next = queryQueue.shift();
  if (next instanceof Error) return Promise.reject(next);
  return Promise.resolve(next ?? { rows: [] });
});

/** Push a successful result for the next pool.query call. */
function enqueue(rows: Record<string, unknown>[]): void {
  queryQueue.push({ rows });
}

/** Push a rejection for the next pool.query call. */
function enqueueThrow(msg = "DB error"): void {
  queryQueue.push(new Error(msg));
}

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock("@workspace/db", () => ({
  pool: { query: (...args: unknown[]) => mockPoolQuery(...args) },
  db: {
    execute: vi.fn().mockResolvedValue({ rows: [] }),
  },
}));

vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { tenantId: TENANT_ID, id: USER_ID };
    next();
  },
}));

vi.mock("../services/queue", () => ({
  enqueueRunStart: vi.fn().mockResolvedValue("enqueued"),
}));

vi.mock("../services/runEnrollmentService", () => ({
  runContactEnrollment: vi.fn().mockResolvedValue(undefined),
  parseContactListIds:  (v: unknown) =>
    Array.isArray(v) ? (v as number[]) : [],
}));

vi.mock("../lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../utils/segmentFilter", () => ({
  buildContactsWhereClause: vi.fn().mockResolvedValue("1=1"),
}));

// ── Import SUT after mocks ────────────────────────────────────────────────────

import sequenceRunsRouter, { resumeInterruptedRuns } from "../routes/sequenceRuns";

// ── App used for HTTP scenarios ───────────────────────────────────────────────

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/api", sequenceRunsRouter);
  return app;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Flush all pending setImmediate callbacks (one macro-task tick). */
function flushSetImmediate(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

// ── Reset before each test ────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  queryQueue.length = 0;
  allQueries.length = 0;
});

// ══════════════════════════════════════════════════════════════════════════════
// Scenario 1 — background resolution throws → run marked status='error'
// ══════════════════════════════════════════════════════════════════════════════

describe("POST /sequences/:seqId/runs — background resolution failure", () => {
  /**
   * Wire pool.query for the POST handler's synchronous phase (before the 201),
   * then inject a throw for the first background query so resolution crashes.
   *
   * Query order (synchronous, before 201):
   *  1. verifyTenantOwnsEntity (SELECT 1 FROM email_sequences)
   *  2. seqCheck (nodes_json + step_count)
   *  3. INSERT sequence_runs RETURNING *
   *
   * Query order (background setImmediate):
   *  4. validate contactIds (SELECT id FROM contacts) → THROW
   *  5. error UPDATE (status='error')
   */
  function wireForResolutionFailure(): void {
    // 1. ownership check — sequence exists
    enqueue([{ "?column?": 1 }]);
    // 2. seqCheck — has 1 published step so the template guard passes
    enqueue([{ nodes_json: null, step_count: "1" }]);
    // 3. INSERT — run created with sentinel total_contacts = -1
    enqueue([{
      id: NEW_RUN_ID, tenant_id: TENANT_ID, sequence_id: SEQ_ID,
      status: "pending", total_contacts: -1, enrolled: 0, skipped: 0,
      created_at: new Date().toISOString(),
    }]);
    // 4. background: validate contactIds → crash
    enqueueThrow("Simulated DB failure during audience resolution");
    // 5. background: error UPDATE
    enqueue([]);
  }

  it("responds 201 before the background task runs", async () => {
    wireForResolutionFailure();

    const res = await request(makeApp())
      .post(`/api/sequences/${SEQ_ID}/runs`)
      .send({ sequenceId: SEQ_ID, contactIds: [1, 2, 3] });

    expect(res.status).toBe(201);
  });

  it("marks the run status='error' when background audience resolution throws", async () => {
    wireForResolutionFailure();

    await request(makeApp())
      .post(`/api/sequences/${SEQ_ID}/runs`)
      .send({ sequenceId: SEQ_ID, contactIds: [1, 2, 3] });

    // Let the setImmediate fire and the error UPDATE execute
    await flushSetImmediate();
    await flushSetImmediate(); // second flush — the outer setImmediate schedules the inner work

    const errorUpdate = allQueries.find(
      q => /UPDATE sequence_runs\s+SET status\s*=\s*'error'/i.test(q.sql)
        && q.params.includes(NEW_RUN_ID)
    );
    expect(errorUpdate).toBeDefined();
  });

  it("does NOT leave total_contacts at -1 indefinitely (error UPDATE is called, not skipped)", async () => {
    wireForResolutionFailure();

    await request(makeApp())
      .post(`/api/sequences/${SEQ_ID}/runs`)
      .send({ sequenceId: SEQ_ID, contactIds: [1, 2, 3] });

    await flushSetImmediate();
    await flushSetImmediate();

    // The stamping UPDATE (SET contact_list_ids, total_contacts) must NOT have
    // been called — resolution crashed before reaching that point.
    const stompUpdate = allQueries.find(
      q => /SET contact_list_ids/i.test(q.sql)
    );
    expect(stompUpdate).toBeUndefined();

    // But the error update must have fired.
    const errorUpdate = allQueries.find(
      q => /UPDATE sequence_runs\s+SET status\s*=\s*'error'/i.test(q.sql)
    );
    expect(errorUpdate).toBeDefined();
  });

  it("run INSERT uses total_contacts=-1 sentinel (resolving state captured in DB)", async () => {
    wireForResolutionFailure();

    await request(makeApp())
      .post(`/api/sequences/${SEQ_ID}/runs`)
      .send({ sequenceId: SEQ_ID, contactIds: [1, 2, 3] });

    // -1 is a literal in the SQL VALUES clause (not a $N param), so check the SQL text.
    const insertQuery = allQueries.find(
      q => /INSERT INTO sequence_runs/i.test(q.sql)
        && /VALUES\s*\([\s\S]*,-1,/i.test(q.sql)
    );
    expect(insertQuery).toBeDefined();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Scenario 2 — resumeInterruptedRuns skips young sentinel runs (<15 min)
// ══════════════════════════════════════════════════════════════════════════════

describe("resumeInterruptedRuns — skips runs with total_contacts=-1 that are <15 min old", () => {
  /**
   * Wire pool.query for resumeInterruptedRuns:
   *  1. UPDATE running → pending (stale running reset)    → no rows
   *  2. UPDATE pending + total_contacts=-1 + >15min → error  (expiry step)
   *  3. SELECT pending/scheduled runs for processing      → empty (sentinel runs excluded)
   */
  function wireSentinelRunsExcluded(): void {
    enqueue([]);  // 1. stale running reset
    enqueue([]);  // 2. expiry UPDATE (>15 min sentinel → error)
    enqueue([]);  // 3. SELECT — no eligible runs (young sentinel excluded by WHERE total_contacts <> -1)
  }

  it("issues the WHERE total_contacts <> -1 guard when selecting runs to process", async () => {
    wireSentinelRunsExcluded();

    await resumeInterruptedRuns();

    // The SELECT spans multiple lines so use [\s\S]* instead of .* to cross newlines.
    const selectQuery = allQueries.find(
      q => /SELECT[\s\S]*FROM sequence_runs/i.test(q.sql)
        && /status\s*=\s*'pending'/i.test(q.sql)
    );
    expect(selectQuery).toBeDefined();
    // The guard must exclude sentinel rows
    expect(selectQuery!.sql).toMatch(/total_contacts\s*<>\s*-1/i);
  });

  it("does not attempt to enqueue or enroll a sentinel run that is <15 min old", async () => {
    wireSentinelRunsExcluded();

    const { enqueueRunStart } = await import("../services/queue");
    const { runContactEnrollment } = await import("../services/runEnrollmentService");

    await resumeInterruptedRuns();

    expect(enqueueRunStart).not.toHaveBeenCalled();
    expect(runContactEnrollment).not.toHaveBeenCalled();
  });

  it("completes without error when only young sentinel runs are present", async () => {
    wireSentinelRunsExcluded();

    await expect(resumeInterruptedRuns()).resolves.toBeUndefined();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Scenario 3 — resumeInterruptedRuns expires old sentinel runs (>15 min) to error
// ══════════════════════════════════════════════════════════════════════════════

describe("resumeInterruptedRuns — expires runs with total_contacts=-1 that are >15 min old", () => {
  /**
   * Wire pool.query for resumeInterruptedRuns — same 3 calls as above.
   * We inspect the expiry UPDATE's SQL to confirm the correct WHERE clause.
   */
  function wireForExpiryCheck(): void {
    enqueue([]);  // 1. stale running reset
    enqueue([]);  // 2. expiry UPDATE (the one being tested)
    enqueue([]);  // 3. SELECT eligible runs
  }

  it("issues an UPDATE ... SET status='error' for sentinel runs older than 15 minutes", async () => {
    wireForExpiryCheck();

    await resumeInterruptedRuns();

    const expiryUpdate = allQueries.find(
      q => /UPDATE sequence_runs\s+SET status\s*=\s*'error'/i.test(q.sql)
        && /total_contacts\s*=\s*-1/i.test(q.sql)
    );
    expect(expiryUpdate).toBeDefined();
  });

  it("expiry UPDATE targets only pending runs (not completed or cancelled)", async () => {
    wireForExpiryCheck();

    await resumeInterruptedRuns();

    const expiryUpdate = allQueries.find(
      q => /UPDATE sequence_runs\s+SET status\s*=\s*'error'/i.test(q.sql)
        && /total_contacts\s*=\s*-1/i.test(q.sql)
    );
    expect(expiryUpdate!.sql).toMatch(/status\s*=\s*'pending'/i);
  });

  it("expiry UPDATE uses a 15-minute age threshold", async () => {
    wireForExpiryCheck();

    await resumeInterruptedRuns();

    const expiryUpdate = allQueries.find(
      q => /UPDATE sequence_runs\s+SET status\s*=\s*'error'/i.test(q.sql)
        && /total_contacts\s*=\s*-1/i.test(q.sql)
    );
    // Should reference a 15-minute interval
    expect(expiryUpdate!.sql).toMatch(/15\s+minutes/i);
  });

  it("expiry runs before the SELECT that picks up eligible runs", async () => {
    wireForExpiryCheck();

    await resumeInterruptedRuns();

    const expiryIdx = allQueries.findIndex(
      q => /UPDATE sequence_runs[\s\S]*SET status\s*=\s*'error'/i.test(q.sql)
        && /total_contacts\s*=\s*-1/i.test(q.sql)
    );
    // SELECT spans multiple lines — use [\s\S]* to cross newlines
    const selectIdx = allQueries.findIndex(
      q => /SELECT[\s\S]*FROM sequence_runs/i.test(q.sql)
        && /status\s*=\s*'pending'/i.test(q.sql)
    );
    expect(expiryIdx).toBeGreaterThanOrEqual(0);
    expect(selectIdx).toBeGreaterThan(expiryIdx);
  });

  it("does not enqueue or enroll expired sentinel runs (they are moved to error, not pending)", async () => {
    // After expiry they become status='error', so the SELECT for processing
    // won't return them — no enrollment attempt should be made.
    wireForExpiryCheck();

    const { enqueueRunStart } = await import("../services/queue");
    const { runContactEnrollment } = await import("../services/runEnrollmentService");

    await resumeInterruptedRuns();

    expect(enqueueRunStart).not.toHaveBeenCalled();
    expect(runContactEnrollment).not.toHaveBeenCalled();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Scenario 4 — GET /sequences/:seqId/runs surfaces total_contacts=-1 while resolving
// ══════════════════════════════════════════════════════════════════════════════

describe("GET /sequences/:seqId/runs — sentinel run in resolving state", () => {
  /**
   * Wire pool.query for the GET handler's synchronous phase:
   *  1. verifyTenantOwnsEntity (SELECT 1 FROM email_sequences) → sequence exists
   *
   * db.execute is overridden per-test to return the sentinel run row.
   */

  it("returns HTTP 200 with total_contacts=-1 while audience resolution is in progress", async () => {
    // ownership check
    enqueue([{ "?column?": 1 }]);

    const { db } = await import("@workspace/db");
    (db.execute as Mock).mockResolvedValueOnce({
      rows: [{
        id: NEW_RUN_ID,
        tenant_id: TENANT_ID,
        sequence_id: SEQ_ID,
        status: "pending",
        total_contacts: -1,
        enrolled: 0,
        skipped: 0,
        created_at: new Date().toISOString(),
        sequence_name: "Test Seq",
        journey_name: null,
        client_name: null,
        started_by_name: "Test User",
      }],
    });

    const res = await request(makeApp()).get(`/api/sequences/${SEQ_ID}/runs`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].total_contacts).toBe(-1);
  });

  it("preserves status='pending' (not 'error') for a run still within the 15-min window", async () => {
    enqueue([{ "?column?": 1 }]);

    const { db } = await import("@workspace/db");
    (db.execute as Mock).mockResolvedValueOnce({
      rows: [{
        id: NEW_RUN_ID,
        tenant_id: TENANT_ID,
        sequence_id: SEQ_ID,
        status: "pending",
        total_contacts: -1,
        enrolled: 0,
        skipped: 0,
        created_at: new Date().toISOString(),
        sequence_name: "Test Seq",
        journey_name: null,
        client_name: null,
        started_by_name: "Test User",
      }],
    });

    const res = await request(makeApp()).get(`/api/sequences/${SEQ_ID}/runs`);

    expect(res.status).toBe(200);
    expect(res.body[0].status).toBe("pending");
    // UI can detect the resolving state via total_contacts === -1
    expect(res.body[0].total_contacts).toBe(-1);
  });

  it("does not return 4xx or 5xx when a sentinel run is present", async () => {
    enqueue([{ "?column?": 1 }]);

    const { db } = await import("@workspace/db");
    (db.execute as Mock).mockResolvedValueOnce({
      rows: [{
        id: NEW_RUN_ID,
        tenant_id: TENANT_ID,
        sequence_id: SEQ_ID,
        status: "pending",
        total_contacts: -1,
        enrolled: 0,
        skipped: 0,
        created_at: new Date().toISOString(),
        sequence_name: "Test Seq",
        journey_name: null,
        client_name: null,
        started_by_name: "Test User",
      }],
    });

    const res = await request(makeApp()).get(`/api/sequences/${SEQ_ID}/runs`);

    expect(res.status).toBeLessThan(400);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Scenario 5 — GET /sequences/:seqId/runs shows status='error' after sentinel expiry
// ══════════════════════════════════════════════════════════════════════════════

describe("GET /sequences/:seqId/runs — expired sentinel run surfaces as status='error'", () => {
  /**
   * After resumeInterruptedRuns runs its expiry UPDATE, a stale sentinel run
   * transitions from status='pending' / total_contacts=-1 to status='error'.
   * The GET endpoint must surface this error state so the UI can stop polling
   * and show a clear failure message rather than a confusing stale count.
   */

  it("returns status='error' for a run whose sentinel was expired by resumeInterruptedRuns", async () => {
    enqueue([{ "?column?": 1 }]);

    const { db } = await import("@workspace/db");
    (db.execute as Mock).mockResolvedValueOnce({
      rows: [{
        id: NEW_RUN_ID,
        tenant_id: TENANT_ID,
        sequence_id: SEQ_ID,
        status: "error",
        total_contacts: -1,
        enrolled: 0,
        skipped: 0,
        created_at: new Date(Date.now() - 20 * 60 * 1000).toISOString(), // 20 min ago
        sequence_name: "Test Seq",
        journey_name: null,
        client_name: null,
        started_by_name: "Test User",
      }],
    });

    const res = await request(makeApp()).get(`/api/sequences/${SEQ_ID}/runs`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].status).toBe("error");
  });

  it("returns total_contacts=-1 alongside status='error' so UI can distinguish from a normal error run", async () => {
    enqueue([{ "?column?": 1 }]);

    const { db } = await import("@workspace/db");
    (db.execute as Mock).mockResolvedValueOnce({
      rows: [{
        id: NEW_RUN_ID,
        tenant_id: TENANT_ID,
        sequence_id: SEQ_ID,
        status: "error",
        total_contacts: -1,
        enrolled: 0,
        skipped: 0,
        created_at: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
        sequence_name: "Test Seq",
        journey_name: null,
        client_name: null,
        started_by_name: "Test User",
      }],
    });

    const res = await request(makeApp()).get(`/api/sequences/${SEQ_ID}/runs`);

    expect(res.status).toBe(200);
    expect(res.body[0].status).toBe("error");
    expect(res.body[0].total_contacts).toBe(-1);
  });

  it("end-to-end: resumeInterruptedRuns expiry followed by GET returns status='error'", async () => {
    // Wire resumeInterruptedRuns (3 queries)
    enqueue([]);  // 1. stale running reset
    enqueue([]);  // 2. expiry UPDATE — moves old sentinel → error
    enqueue([]);  // 3. SELECT eligible runs → empty (no unexpired pending runs)

    await resumeInterruptedRuns();

    // Now simulate the UI polling GET — the run was expired to 'error'
    enqueue([{ "?column?": 1 }]);  // ownership check for GET

    const { db } = await import("@workspace/db");
    (db.execute as Mock).mockResolvedValueOnce({
      rows: [{
        id: NEW_RUN_ID,
        tenant_id: TENANT_ID,
        sequence_id: SEQ_ID,
        status: "error",
        total_contacts: -1,
        enrolled: 0,
        skipped: 0,
        created_at: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
        sequence_name: "Test Seq",
        journey_name: null,
        client_name: null,
        started_by_name: "Test User",
      }],
    });

    const res = await request(makeApp()).get(`/api/sequences/${SEQ_ID}/runs`);

    expect(res.status).toBe(200);
    expect(res.body[0].status).toBe("error");
    expect(res.body[0].total_contacts).toBe(-1);
  });
});
