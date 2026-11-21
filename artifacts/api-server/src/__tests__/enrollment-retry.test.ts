/**
 * Route-level tests for the errored-enrollment retry endpoint.
 *
 * POST /api/sequences/:seqId/runs/:runId/enrollments/:enrollmentId/retry
 *
 * Business rules verified:
 *  1. Errored enrollment on an active (running/paused) run → 200, enrollment reset.
 *  2. Cancelled run → 409, UPDATE never issued.
 *  3. Completed run → 409, UPDATE never issued.
 *  4. Non-errored enrollment (e.g. active/completed) → 404 (UPDATE WHERE guards block it).
 *  5. Run belonging to a different tenant → 404 (tenant isolation).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Query mock infrastructure ─────────────────────────────────────────────────

type QueryResult = { rows: Record<string, unknown>[] };
const allQueries: { sql: string; params: unknown[] }[] = [];
const queryQueue: (QueryResult | (() => QueryResult))[] = [];

const mockPoolQuery = vi.fn().mockImplementation((sqlStr: string, params: unknown[]) => {
  allQueries.push({ sql: sqlStr.trim(), params: params ?? [] });
  const next = queryQueue.shift();
  if (next === undefined) return Promise.resolve({ rows: [] });
  if (typeof next === "function") return Promise.resolve((next as () => QueryResult)());
  return Promise.resolve(next);
});

function enqueue(result: QueryResult | (() => QueryResult)): void {
  queryQueue.push(result);
}

// ── Module mocks (must come before any import that uses them) ─────────────────

vi.mock("@workspace/db", () => ({
  pool: { query: (...args: unknown[]) => mockPoolQuery(...args) },
  db: {
    execute: vi.fn().mockResolvedValue({ rows: [] }),
  },
}));

// requireAuth is applied via router.use — mock it to inject a fake user so
// we can test the route logic without a real session / passport setup.
vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (req: Record<string, unknown>, _res: unknown, next: () => void) => {
    req["user"] = { id: 1, tenantId: 10 };
    next();
  },
}));

vi.mock("../services/runEnrollmentService", () => ({
  runContactEnrollment: vi.fn().mockResolvedValue(undefined),
  parseContactListIds: vi.fn().mockReturnValue([]),
}));

vi.mock("../services/queue", () => ({
  enqueueRunStart: vi.fn().mockResolvedValue("unavailable"),
}));

vi.mock("../workers/sequence-worker", () => ({
  maybeCompleteRun: vi.fn().mockResolvedValue(undefined),
  startWorker: vi.fn(),
  startRunEnrollmentWorker: vi.fn(),
  startWorkersForConnection: vi.fn(),
  resumeInterruptedRuns: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../utils/segmentFilter", () => ({
  buildContactsWhereClause: vi.fn().mockReturnValue(null),
}));

// ── Import SUT after mocks ────────────────────────────────────────────────────

import express from "express";
import request from "supertest";
import sequenceRunsRouter from "../routes/sequenceRuns";

// ── Helpers ───────────────────────────────────────────────────────────────────

function createApp() {
  const app = express();
  app.use(express.json());
  app.use("/api", sequenceRunsRouter);
  return app;
}

const SEQ_ID        = 5;
const RUN_ID        = 42;
const ENROLLMENT_ID = 99;
const TENANT_ID     = 10;

function runRow(status: string) {
  return { rows: [{ id: RUN_ID, status, tenant_id: TENANT_ID }] };
}

function enrollmentUpdated() {
  return { rows: [{ id: ENROLLMENT_ID }] };
}

function noRowsUpdated() {
  return { rows: [] };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  allQueries.length = 0;
  queryQueue.length = 0;
});

describe("POST /api/sequences/:seqId/runs/:runId/enrollments/:enrollmentId/retry", () => {

  // 1. Happy path — errored enrollment on a running run
  it("returns 200 and resets the enrollment when the run is 'running' and the enrollment is errored", async () => {
    enqueue(runRow("running"));       // SELECT sequence_runs
    enqueue(enrollmentUpdated());     // UPDATE sequence_enrollments

    const res = await request(createApp())
      .post(`/api/sequences/${SEQ_ID}/runs/${RUN_ID}/enrollments/${ENROLLMENT_ID}/retry`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, enrollmentId: ENROLLMENT_ID });
  });

  // 1b. Paused run — resume runner does not check parent run status, so
  //     activating an enrollment on a paused run would send emails despite
  //     the pause. Must be rejected.
  it("returns 409 when the run is 'paused' (resume runner would bypass the pause)", async () => {
    enqueue(runRow("paused"));

    const res = await request(createApp())
      .post(`/api/sequences/${SEQ_ID}/runs/${RUN_ID}/enrollments/${ENROLLMENT_ID}/retry`);

    expect(res.status).toBe(409);
    const updateQ = allQueries.find(q => /UPDATE sequence_enrollments/i.test(q.sql));
    expect(updateQ).toBeUndefined();
  });

  // 2. Verify the reset SQL sets the expected fields
  it("issues an UPDATE that sets status='active', resume_at=NOW(), resume_error_count=0", async () => {
    enqueue(runRow("running"));
    enqueue(enrollmentUpdated());

    await request(createApp())
      .post(`/api/sequences/${SEQ_ID}/runs/${RUN_ID}/enrollments/${ENROLLMENT_ID}/retry`);

    const updateQ = allQueries.find(q =>
      /UPDATE sequence_enrollments/i.test(q.sql) &&
      /status\s*=\s*'active'/i.test(q.sql)
    );
    expect(updateQ).toBeDefined();
    expect(/resume_at\s*=\s*NOW\(\)/i.test(updateQ!.sql)).toBe(true);
    expect(/resume_error_count\s*=\s*0/i.test(updateQ!.sql)).toBe(true);
  });

  // 3. The UPDATE WHERE clause must guard on status='errored' so non-errored
  //    enrollments cannot be accidentally reset.
  it("UPDATE SQL includes WHERE status='errored' guard so active/completed enrollments are not touched", async () => {
    enqueue(runRow("running"));
    enqueue(enrollmentUpdated());

    await request(createApp())
      .post(`/api/sequences/${SEQ_ID}/runs/${RUN_ID}/enrollments/${ENROLLMENT_ID}/retry`);

    const updateQ = allQueries.find(q =>
      /UPDATE sequence_enrollments/i.test(q.sql) &&
      /status\s*=\s*'active'/i.test(q.sql)
    );
    expect(updateQ).toBeDefined();
    // WHERE clause must include the errored guard
    expect(/'errored'/i.test(updateQ!.sql)).toBe(true);
  });

  // 4. Cancelled runs — update must NOT be issued
  it("returns 409 and does NOT issue an UPDATE when the run is cancelled", async () => {
    enqueue(runRow("cancelled"));
    // No second enqueue — if the route issues a query, it reads from the empty
    // queue and gets { rows: [] }, which does NOT affect the 409 assertion.

    const res = await request(createApp())
      .post(`/api/sequences/${SEQ_ID}/runs/${RUN_ID}/enrollments/${ENROLLMENT_ID}/retry`);

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/cancelled/i);

    // Critically, no UPDATE must have been issued — only the SELECT for run status.
    const updateQ = allQueries.find(q =>
      /UPDATE sequence_enrollments/i.test(q.sql)
    );
    expect(updateQ).toBeUndefined();
  });

  // 5. Completed run — the common "last errored enrollment" scenario: maybeCompleteRun
  //    fires and marks the run completed, but an errored enrollment remains. The
  //    endpoint must allow retry and atomically reactivate the run to 'running'.
  it("returns 200 and reactivates the run to 'running' when the run is completed", async () => {
    enqueue(runRow("completed"));  // SELECT sequence_runs
    enqueue(enrollmentUpdated());  // UPDATE sequence_enrollments
    // UPDATE sequence_runs (reactivation) will read from empty queue → { rows: [] } — fine

    const res = await request(createApp())
      .post(`/api/sequences/${SEQ_ID}/runs/${RUN_ID}/enrollments/${ENROLLMENT_ID}/retry`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true });
  });

  it("issues a run-reactivation UPDATE when retrying on a completed run", async () => {
    enqueue(runRow("completed"));
    enqueue(enrollmentUpdated());

    await request(createApp())
      .post(`/api/sequences/${SEQ_ID}/runs/${RUN_ID}/enrollments/${ENROLLMENT_ID}/retry`);

    // Two UPDATEs must be issued: one for the enrollment, one to reactivate the run.
    const runReactivation = allQueries.find(q =>
      /UPDATE sequence_runs/i.test(q.sql) &&
      /status\s*=\s*'running'/i.test(q.sql) &&
      /status\s*=\s*'completed'/i.test(q.sql)
    );
    expect(runReactivation).toBeDefined();
    expect(runReactivation!.params).toContain(RUN_ID);
  });

  it("does NOT issue a run-reactivation UPDATE when the run is already 'running'", async () => {
    enqueue(runRow("running"));
    enqueue(enrollmentUpdated());

    await request(createApp())
      .post(`/api/sequences/${SEQ_ID}/runs/${RUN_ID}/enrollments/${ENROLLMENT_ID}/retry`);

    const runReactivation = allQueries.find(q =>
      /UPDATE sequence_runs/i.test(q.sql) &&
      /status\s*=\s*'running'/i.test(q.sql)
    );
    expect(runReactivation).toBeUndefined();
  });

  // 6. Error-state run — retrying would send work from a broken run
  it("returns 409 and does NOT issue an UPDATE when the run is in 'error' state", async () => {
    enqueue(runRow("error"));

    const res = await request(createApp())
      .post(`/api/sequences/${SEQ_ID}/runs/${RUN_ID}/enrollments/${ENROLLMENT_ID}/retry`);

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/error/i);

    const updateQ = allQueries.find(q => /UPDATE sequence_enrollments/i.test(q.sql));
    expect(updateQ).toBeUndefined();
  });

  // 7. Pending run — initial enrollment process has not yet started; retry would race
  it("returns 409 and does NOT issue an UPDATE when the run is pending", async () => {
    enqueue(runRow("pending"));

    const res = await request(createApp())
      .post(`/api/sequences/${SEQ_ID}/runs/${RUN_ID}/enrollments/${ENROLLMENT_ID}/retry`);

    expect(res.status).toBe(409);
    const updateQ = allQueries.find(q => /UPDATE sequence_enrollments/i.test(q.sql));
    expect(updateQ).toBeUndefined();
  });

  // 8. Scheduled run — same race risk as pending
  it("returns 409 and does NOT issue an UPDATE when the run is scheduled", async () => {
    enqueue(runRow("scheduled"));

    const res = await request(createApp())
      .post(`/api/sequences/${SEQ_ID}/runs/${RUN_ID}/enrollments/${ENROLLMENT_ID}/retry`);

    expect(res.status).toBe(409);
    const updateQ = allQueries.find(q => /UPDATE sequence_enrollments/i.test(q.sql));
    expect(updateQ).toBeUndefined();
  });

  // 6. Non-errored enrollment — UPDATE returns 0 rows → 404
  it("returns 404 when the enrollment is not in errored state (UPDATE returns 0 rows)", async () => {
    enqueue(runRow("running"));
    enqueue(noRowsUpdated());  // enrollment is active/completed — WHERE status='errored' guards

    const res = await request(createApp())
      .post(`/api/sequences/${SEQ_ID}/runs/${RUN_ID}/enrollments/${ENROLLMENT_ID}/retry`);

    expect(res.status).toBe(404);
  });

  // 7. Tenant isolation — run not found for wrong tenant → 404
  it("returns 404 when the run does not belong to the authenticated tenant", async () => {
    // SELECT returns empty (tenant mismatch)
    enqueue({ rows: [] });

    const res = await request(createApp())
      .post(`/api/sequences/${SEQ_ID}/runs/${RUN_ID}/enrollments/${ENROLLMENT_ID}/retry`);

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  // 8. Invalid path parameters — 400
  it("returns 400 for non-numeric path parameters", async () => {
    const res = await request(createApp())
      .post(`/api/sequences/abc/runs/${RUN_ID}/enrollments/${ENROLLMENT_ID}/retry`);

    expect(res.status).toBe(400);
  });
});
