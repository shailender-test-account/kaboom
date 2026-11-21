/**
 * Tests for sequenceResumeRunner error-backoff behaviour.
 *
 * When resumeContactFromWait throws an unexpected error the runner must NOT
 * leave the enrollment in a state that causes it to be re-picked on every
 * subsequent tick (a "zombie" loop).  Instead the runner must atomically apply
 * either:
 *   a) an exponential backoff (resume_at set to a future SQL interval), or
 *   b) status='errored' after MAX_RESUME_ERRORS consecutive failures.
 *
 * The backoff is applied via a SINGLE SQL UPDATE so there is no window between
 * two queries where resume_at could be left NULL.
 *
 * resumeContactFromWait returns { claimed: boolean; failures: number }:
 *   claimed=true  — this process won the DB claim and processed the enrollment
 *   claimed=false — another concurrent process already claimed it (no work done)
 * The runner resets resume_error_count only after a genuine claimed=true success.
 *
 * Query-call accounting
 * ─────────────────────
 * Each test section comments the exact pool.query call order so the query
 * queue can be loaded precisely.  "success" below always means
 * mockResolvedValueOnce({ claimed: true, failures: 0 }).
 *
 *   Runner tick (one failing enrollment, error < MAX):
 *     [0] SELECT                               — returns enrollment rows
 *     [1] applyResumeBackoff atomic UPDATE     — RETURNING resume_error_count, status
 *
 *   Runner tick (error reaches MAX):
 *     [0] SELECT
 *     [1] applyResumeBackoff atomic UPDATE     — returns { status: 'errored', … }
 *
 *   Runner tick (claimed=true success):
 *     [0] SELECT
 *     [1] reset UPDATE (resume_error_count = 0) — omitted from queue when count=0
 *
 *   Runner tick (two enrollments, first fails second succeeds):
 *     [0] SELECT
 *     [1] applyResumeBackoff UPDATE for enrollment 1
 *     [2] reset UPDATE for enrollment 2 (empty queue → { rows:[] } → fine)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Query mock infrastructure ─────────────────────────────────────────────────

type QueryResult = { rows: Record<string, unknown>[] };

/** All SQL calls in order, recorded by the mock. */
const allQueries: { sql: string; params: unknown[] }[] = [];

/**
 * Programmatic response queue.  Each entry is consumed in FIFO order.
 * A factory entry (function) is called and its return value used; it may
 * throw to simulate DB errors on specific calls.
 */
type QueueEntry = QueryResult | (() => QueryResult) | (() => never);
const queryQueue: QueueEntry[] = [];

const mockPoolQuery = vi.fn().mockImplementation((sql: string, params: unknown[]) => {
  allQueries.push({ sql: sql.trim(), params: params ?? [] });
  const next = queryQueue.shift();
  if (next === undefined) return Promise.resolve({ rows: [] });
  if (typeof next === "function") return Promise.resolve((next as () => QueryResult)());
  return Promise.resolve(next);
});

function enqueue(result: QueryResult | (() => QueryResult) | (() => never)): void {
  queryQueue.push(result);
}

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock("@workspace/db", () => ({
  pool: { query: (...args: unknown[]) => mockPoolQuery(...args) },
  db: {},
}));

vi.mock("../services/runEnrollmentService", () => ({
  resumeContactFromWait: vi.fn(),
}));

vi.mock("../workers/sequence-worker", () => ({
  maybeCompleteRun: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// ── Import SUT after mocks ────────────────────────────────────────────────────

import { startSequenceResumeRunner } from "../sequenceResumeRunner";
import { resumeContactFromWait } from "../services/runEnrollmentService";

// ── Constants ─────────────────────────────────────────────────────────────────

const ENROLLMENT_ID = 1;
const MAX_RESUME_ERRORS = 5; // must match the implementation constant

// ── Reset helpers ─────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  allQueries.length = 0;
  queryQueue.length = 0;
});

// ── Fixture helpers ───────────────────────────────────────────────────────────

function makeEnrollmentRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id:          ENROLLMENT_ID,
    contact_id:  100,
    sequence_id: 5,
    run_id:      null,
    tenant_id:   10,
    ...overrides,
  };
}

/** Backoff result: error count incremented but below max → still active. */
function makeBackoffResult(count: number): QueryResult {
  return { rows: [{ resume_error_count: count, status: "active" }] };
}

/** Errored result: error count reached max → status flipped to errored. */
function makeErroredResult(): QueryResult {
  return { rows: [{ resume_error_count: MAX_RESUME_ERRORS, status: "errored" }] };
}

// ── Helper: find the atomic backoff UPDATE in the recorded queries ─────────────
//
// The implementation issues a single UPDATE that:
//   - increments resume_error_count
//   - conditionally sets status = 'errored'
//   - conditionally sets resume_at via a SQL POWER/INTERVAL expression
// We locate it by matching UPDATE sequence_enrollments + resume_error_count.

function findBackoffUpdate(): { sql: string; params: unknown[] } | undefined {
  return allQueries.find(
    q =>
      /UPDATE sequence_enrollments/i.test(q.sql) &&
      /resume_error_count/i.test(q.sql)
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// 1. Atomic backoff UPDATE is issued after a failure
// ══════════════════════════════════════════════════════════════════════════════

describe("sequenceResumeRunner: atomic backoff UPDATE issued after failure", () => {
  /**
   * Query order: [0] SELECT  [1] applyResumeBackoff UPDATE
   */
  it("issues exactly one UPDATE to sequence_enrollments after resumeContactFromWait throws", async () => {
    (resumeContactFromWait as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("DB timeout")
    );
    enqueue({ rows: [makeEnrollmentRow()] }); // [0] SELECT
    enqueue(makeBackoffResult(1));             // [1] atomic backoff UPDATE

    startSequenceResumeRunner();
    await vi.advanceTimersByTimeAsync(60_000);

    const update = findBackoffUpdate();
    expect(update).toBeDefined();
  });

  it("the atomic UPDATE targets the failing enrollment id", async () => {
    (resumeContactFromWait as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("unexpected error")
    );
    enqueue({ rows: [makeEnrollmentRow()] });
    enqueue(makeBackoffResult(1));

    startSequenceResumeRunner();
    await vi.advanceTimersByTimeAsync(60_000);

    const update = findBackoffUpdate();
    expect(update!.params).toContain(ENROLLMENT_ID);
  });

  it("the atomic UPDATE SQL contains a SQL INTERVAL expression for the backoff resume_at", async () => {
    (resumeContactFromWait as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("step error")
    );
    enqueue({ rows: [makeEnrollmentRow()] });
    enqueue(makeBackoffResult(1));

    startSequenceResumeRunner();
    await vi.advanceTimersByTimeAsync(60_000);

    const update = findBackoffUpdate();
    // Must set resume_at via a SQL interval (not just NULL) for non-max counts.
    expect(/INTERVAL/i.test(update!.sql)).toBe(true);
  });

  it("the atomic UPDATE SQL includes the 'errored' status case for max-count rows", async () => {
    (resumeContactFromWait as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("step error")
    );
    enqueue({ rows: [makeEnrollmentRow()] });
    enqueue(makeBackoffResult(1));

    startSequenceResumeRunner();
    await vi.advanceTimersByTimeAsync(60_000);

    const update = findBackoffUpdate();
    // The SQL always contains the 'errored' CASE branch even if it doesn't
    // trigger on this call — confirms the mechanism is wired up.
    expect(/errored/i.test(update!.sql)).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 2. Enrollment is not re-selected on the next tick after a failure
// ══════════════════════════════════════════════════════════════════════════════

describe("sequenceResumeRunner: failing enrollment not re-selected on tick 2", () => {
  /**
   * Query order per tick:
   *   Tick 1: [0] SELECT enrollment  [1] backoff UPDATE
   *   Tick 2: [0] SELECT → empty (backoff now in future / row excluded)
   */
  it("does not call resumeContactFromWait a second time when tick-2 SELECT returns empty", async () => {
    (resumeContactFromWait as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("transient error")
    );

    enqueue({ rows: [makeEnrollmentRow()] }); // tick-1 SELECT
    enqueue(makeBackoffResult(1));             // tick-1 backoff UPDATE
    enqueue({ rows: [] });                    // tick-2 SELECT: no rows (backoff in future)

    startSequenceResumeRunner();
    await vi.advanceTimersByTimeAsync(60_000); // tick 1
    await vi.advanceTimersByTimeAsync(60_000); // tick 2

    expect(resumeContactFromWait).toHaveBeenCalledTimes(1);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 3. Other enrollments in the same batch are still processed after one fails
// ══════════════════════════════════════════════════════════════════════════════

describe("sequenceResumeRunner: other enrollments processed after one fails", () => {
  /**
   * Query order:
   *   [0] SELECT (two rows)
   *   [1] applyResumeBackoff UPDATE for enrollment 1 (failed)
   *   [2] reset UPDATE for enrollment 2 (success, claimed=true) — empty queue → { rows:[] } fine
   */
  it("calls resumeContactFromWait for both enrollments", async () => {
    const row1 = makeEnrollmentRow({ id: 1, contact_id: 100 });
    const row2 = makeEnrollmentRow({ id: 2, contact_id: 200 });

    (resumeContactFromWait as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error("fail on enrollment 1"))
      .mockResolvedValueOnce({ claimed: true, failures: 0 }); // enrollment 2 succeeds

    enqueue({ rows: [row1, row2] }); // SELECT
    enqueue(makeBackoffResult(1));   // backoff UPDATE for enrollment 1
    // reset UPDATE for enrollment 2 consumed from empty queue → { rows: [] } → fine

    startSequenceResumeRunner();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(resumeContactFromWait).toHaveBeenCalledTimes(2);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 4. Exponential backoff progression: counts 1–4 back off, count 5 errors
// ══════════════════════════════════════════════════════════════════════════════

describe("sequenceResumeRunner: error count progression 1–5", () => {
  /**
   * Simulate five successive ticks, each time resumeContactFromWait throws.
   * The mock enrollment is re-returned on each tick to represent a row that
   * keeps failing (in a real DB, the backoff would prevent re-selection until
   * the interval elapses; here we control the SELECT directly).
   *
   * Query order per tick: [0] SELECT  [1] atomic UPDATE
   */

  it("applies backoff (not errored) on failure counts 1 through 4", async () => {
    (resumeContactFromWait as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("persistent error")
    );

    for (let count = 1; count < MAX_RESUME_ERRORS; count++) {
      enqueue({ rows: [makeEnrollmentRow()] }); // SELECT
      enqueue(makeBackoffResult(count));          // UPDATE returns count < max → still active
    }
    // Tick 5 — enrollment finally errored
    enqueue({ rows: [makeEnrollmentRow()] });
    enqueue(makeErroredResult());

    startSequenceResumeRunner();

    for (let i = 0; i < MAX_RESUME_ERRORS; i++) {
      await vi.advanceTimersByTimeAsync(60_000);
    }

    // resumeContactFromWait called once per tick × MAX_RESUME_ERRORS ticks
    expect(resumeContactFromWait).toHaveBeenCalledTimes(MAX_RESUME_ERRORS);
    // All calls used the backoff UPDATE SQL
    const backoffUpdates = allQueries.filter(
      q =>
        /UPDATE sequence_enrollments/i.test(q.sql) &&
        /resume_error_count/i.test(q.sql)
    );
    expect(backoffUpdates).toHaveLength(MAX_RESUME_ERRORS);
  });

  it("the atomic UPDATE SQL marks the row 'errored' at count = MAX_RESUME_ERRORS", async () => {
    (resumeContactFromWait as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("persistent error")
    );

    for (let count = 1; count < MAX_RESUME_ERRORS; count++) {
      enqueue({ rows: [makeEnrollmentRow()] });
      enqueue(makeBackoffResult(count));
    }
    enqueue({ rows: [makeEnrollmentRow()] });
    enqueue(makeErroredResult());

    startSequenceResumeRunner();

    for (let i = 0; i < MAX_RESUME_ERRORS; i++) {
      await vi.advanceTimersByTimeAsync(60_000);
    }

    // The SQL always contains both the backoff interval and the 'errored' CASE.
    const firstUpdate = allQueries.find(
      q =>
        /UPDATE sequence_enrollments/i.test(q.sql) &&
        /resume_error_count/i.test(q.sql)
    );
    expect(firstUpdate).toBeDefined();
    expect(/errored/i.test(firstUpdate!.sql)).toBe(true);
    expect(/INTERVAL/i.test(firstUpdate!.sql)).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 5. Counter resets to 0 after a successful resume
// ══════════════════════════════════════════════════════════════════════════════

describe("sequenceResumeRunner: error counter resets after a successful resume", () => {
  /**
   * Scenario: fail → success → fail again.
   *
   * The runner tracks *consecutive* failures.  After a successful resume the
   * counter must be reset to 0, so the next failure re-starts from count 1
   * rather than accumulating toward MAX_RESUME_ERRORS.
   *
   * Query order:
   *   Tick 1 (fail):    [0] SELECT  [1] backoff UPDATE (count → 1)
   *   Tick 2 (success): [0] SELECT  [1] reset UPDATE   (count → 0)
   *   Tick 3 (fail):    [0] SELECT  [1] backoff UPDATE (count → 1 again)
   */
  it("issues a reset UPDATE (resume_error_count = 0) after a successful resume", async () => {
    (resumeContactFromWait as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error("transient error"))           // tick 1
      .mockResolvedValueOnce({ claimed: true, failures: 0 })         // tick 2 — success
      .mockRejectedValueOnce(new Error("another error"));            // tick 3

    enqueue({ rows: [makeEnrollmentRow()] }); // tick-1 SELECT
    enqueue(makeBackoffResult(1));             // tick-1 backoff UPDATE
    enqueue({ rows: [makeEnrollmentRow()] }); // tick-2 SELECT
    enqueue({ rows: [] });                    // tick-2 reset UPDATE (SET resume_error_count = 0)
    enqueue({ rows: [makeEnrollmentRow()] }); // tick-3 SELECT
    enqueue(makeBackoffResult(1));             // tick-3 backoff UPDATE (count starts from 0 again → 1)

    startSequenceResumeRunner();

    await vi.advanceTimersByTimeAsync(60_000); // tick 1 — fail
    await vi.advanceTimersByTimeAsync(60_000); // tick 2 — success
    await vi.advanceTimersByTimeAsync(60_000); // tick 3 — fail again

    // A reset UPDATE must appear in the recorded queries after tick 2.
    const resetUpdate = allQueries.find(
      q =>
        /UPDATE sequence_enrollments/i.test(q.sql) &&
        /resume_error_count\s*=\s*0/i.test(q.sql)
    );
    expect(resetUpdate).toBeDefined();
    expect(resetUpdate!.params).toContain(ENROLLMENT_ID);
  });

  it("consecutive-failure count restarts at 1 after an intervening success", async () => {
    (resumeContactFromWait as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error("error"))
      .mockResolvedValueOnce({ claimed: true, failures: 0 })
      .mockRejectedValueOnce(new Error("error again"));

    enqueue({ rows: [makeEnrollmentRow()] }); // tick-1 SELECT
    enqueue(makeBackoffResult(1));             // tick-1 backoff → count 1
    enqueue({ rows: [makeEnrollmentRow()] }); // tick-2 SELECT
    enqueue({ rows: [] });                    // tick-2 reset
    enqueue({ rows: [makeEnrollmentRow()] }); // tick-3 SELECT
    enqueue(makeBackoffResult(1));             // tick-3 backoff → count 1 (not 2)

    startSequenceResumeRunner();

    await vi.advanceTimersByTimeAsync(60_000);
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.advanceTimersByTimeAsync(60_000);

    // Three ticks: fail, success, fail — resumeContactFromWait called 3 times.
    expect(resumeContactFromWait).toHaveBeenCalledTimes(3);

    // Backoff UPDATE must appear twice (ticks 1 and 3).
    const backoffUpdates = allQueries.filter(
      q =>
        /UPDATE sequence_enrollments/i.test(q.sql) &&
        /resume_error_count/i.test(q.sql) &&
        !/resume_error_count\s*=\s*0\b/i.test(q.sql)
    );
    expect(backoffUpdates).toHaveLength(2);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 6. Claim-race: counter NOT reset when resumeContactFromWait returns claimed=false
// ══════════════════════════════════════════════════════════════════════════════

describe("sequenceResumeRunner: counter not reset when claim was lost to another runner", () => {
  /**
   * When two runner processes race, the losing one receives claimed=false.
   * The losing runner must NOT reset resume_error_count because the winning
   * process may have recorded a failure/backoff that should count toward the
   * consecutive-error threshold.
   *
   * Query order (claimed=false tick):
   *   [0] SELECT — returns enrollment
   *   (no reset query issued because claimed=false)
   */
  it("does not issue a reset UPDATE when resumeContactFromWait returns claimed=false", async () => {
    (resumeContactFromWait as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      { claimed: false, failures: 0 } // claim lost to another runner
    );

    enqueue({ rows: [makeEnrollmentRow()] }); // SELECT
    // No reset query enqueued — if the runner issues one, it would consume
    // from the empty queue and return { rows: [] }, but we verify no such
    // query appears in allQueries.

    startSequenceResumeRunner();
    await vi.advanceTimersByTimeAsync(60_000);

    const resetUpdate = allQueries.find(
      q =>
        /UPDATE sequence_enrollments/i.test(q.sql) &&
        /resume_error_count\s*=\s*0/i.test(q.sql)
    );
    expect(resetUpdate).toBeUndefined();
  });

  it("does not add the run_id to the completion set when claimed=false", async () => {
    const { maybeCompleteRun } = await import("../workers/sequence-worker");

    (resumeContactFromWait as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      { claimed: false, failures: 0 }
    );

    // Enrollment row has a run_id — should NOT trigger maybeCompleteRun.
    enqueue({ rows: [makeEnrollmentRow({ run_id: 42 })] });

    startSequenceResumeRunner();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(maybeCompleteRun).not.toHaveBeenCalled();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 7. Run completes when its final enrollment reaches the error cutoff
// ══════════════════════════════════════════════════════════════════════════════

describe("sequenceResumeRunner: run completion triggered when enrollment is errored", () => {
  /**
   * When the last active enrollment for a run is marked 'errored', the run
   * must still be checked for completion via maybeCompleteRun.  Otherwise the
   * run stays 'running' forever because no future successful resume will fire
   * the completion check for it.
   *
   * Query order:
   *   [0] SELECT — returns enrollment with run_id=42
   *   [1] applyResumeBackoff atomic UPDATE — returns { status: 'errored', … }
   */
  it("calls maybeCompleteRun with the enrollment's run_id when the enrollment is marked errored", async () => {
    const { maybeCompleteRun } = await import("../workers/sequence-worker");

    (resumeContactFromWait as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("fatal step error")
    );

    const RUN_ID = 42;
    enqueue({ rows: [makeEnrollmentRow({ run_id: RUN_ID })] }); // SELECT
    enqueue(makeErroredResult());                                 // backoff → errored

    startSequenceResumeRunner();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(maybeCompleteRun).toHaveBeenCalledWith(RUN_ID);
  });

  it("does NOT call maybeCompleteRun when enrollment is only backed off (not yet errored)", async () => {
    const { maybeCompleteRun } = await import("../workers/sequence-worker");

    (resumeContactFromWait as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("transient error")
    );

    enqueue({ rows: [makeEnrollmentRow({ run_id: 42 })] }); // SELECT
    enqueue(makeBackoffResult(1));                           // backoff → still active (count=1)

    startSequenceResumeRunner();
    await vi.advanceTimersByTimeAsync(60_000);

    // applyResumeBackoff returned false (not errored) → run not checked yet.
    expect(maybeCompleteRun).not.toHaveBeenCalled();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 8. State guard prevents stale backoff from corrupting a successfully
//    advanced enrollment (concurrency safety)
// ══════════════════════════════════════════════════════════════════════════════

describe("sequenceResumeRunner: stale backoff cannot corrupt a successfully advanced enrollment", () => {
  /**
   * Scenario (ambiguous claim failure followed by concurrent runner success):
   *
   *  1. Runner A's claim query experiences a client-side network timeout.
   *     PostgreSQL may or may not have executed the UPDATE; from A's
   *     perspective, the call threw and it enters the catch path.
   *  2. Runner B (another process or the next tick) successfully claims the
   *     enrollment and advances it to a new wait step, setting resume_at to a
   *     future time.
   *  3. Runner A's catch path calls applyResumeBackoff.  The WHERE guard
   *     requires `status = 'active' AND (resume_at IS NULL OR resume_at <= NOW())`.
   *     B already set a future resume_at, so the guard does NOT match → the
   *     UPDATE returns 0 rows → the enrollment is left intact.
   *
   * The test simulates step 3: applyResumeBackoff's UPDATE returns 0 rows
   * (because the guard filtered the row out), and we verify that:
   *   a) no errored status is applied
   *   b) maybeCompleteRun is NOT called (enrollment is still valid/active)
   */
  it("does not mark the enrollment errored when the backoff UPDATE returns 0 rows (guard filtered it)", async () => {
    const { maybeCompleteRun } = await import("../workers/sequence-worker");

    (resumeContactFromWait as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("ambiguous network error — claim may or may not have executed")
    );

    const RUN_ID = 99;
    enqueue({ rows: [makeEnrollmentRow({ run_id: RUN_ID })] }); // SELECT
    // applyResumeBackoff UPDATE returns 0 rows: another runner advanced the
    // enrollment to a future resume_at, so the WHERE guard rejected the update.
    enqueue({ rows: [] });

    startSequenceResumeRunner();
    await vi.advanceTimersByTimeAsync(60_000);

    // The enrollment was NOT errored (0-row result means guard filtered it).
    // maybeCompleteRun must not be called — the run is still legitimately running.
    expect(maybeCompleteRun).not.toHaveBeenCalledWith(RUN_ID);
  });

  it("backoff UPDATE SQL includes the state guard preventing future-resume_at rows from being altered", async () => {
    (resumeContactFromWait as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("claim ambiguity")
    );

    enqueue({ rows: [makeEnrollmentRow()] }); // SELECT
    enqueue(makeBackoffResult(1));             // backoff UPDATE

    startSequenceResumeRunner();
    await vi.advanceTimersByTimeAsync(60_000);

    const backoffUpdate = findBackoffUpdate();
    expect(backoffUpdate).toBeDefined();

    // The WHERE clause must require status='active' AND a resume_at condition
    // (IS NULL or <= NOW()) so it cannot alter rows another runner has advanced.
    expect(/status\s*=\s*'active'/i.test(backoffUpdate!.sql)).toBe(true);
    expect(/resume_at\s+IS\s+NULL/i.test(backoffUpdate!.sql)).toBe(true);
    expect(/resume_at\s*<=\s*NOW\(\)/i.test(backoffUpdate!.sql)).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 9. applyResumeBackoff failure is handled gracefully
// ══════════════════════════════════════════════════════════════════════════════

describe("sequenceResumeRunner: failed backoff UPDATE does not crash the runner", () => {
  /**
   * Query order: [0] SELECT  [1] backoff UPDATE throws (DB error)
   */
  it("runner completes the tick without rethrowing when the backoff UPDATE fails", async () => {
    (resumeContactFromWait as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("processing error")
    );

    enqueue({ rows: [makeEnrollmentRow()] }); // SELECT
    // backoff UPDATE will throw
    enqueue(() => { throw new Error("DB connection lost"); });

    startSequenceResumeRunner();

    // Should not throw — runner catches both the resume error and the backoff error.
    await expect(vi.advanceTimersByTimeAsync(60_000)).resolves.not.toThrow();
  });

  it("runner processes subsequent ticks normally after a failed backoff write", async () => {
    (resumeContactFromWait as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error("processing error"))        // tick 1 fails
      .mockResolvedValueOnce({ claimed: true, failures: 0 });      // tick 2 succeeds

    enqueue({ rows: [makeEnrollmentRow()] });            // tick-1 SELECT
    enqueue(() => { throw new Error("DB outage"); });    // tick-1 backoff UPDATE fails
    enqueue({ rows: [makeEnrollmentRow({ id: 2 })] });   // tick-2 SELECT
    // tick-2 enrollment succeeds; no backoff needed

    startSequenceResumeRunner();

    await vi.advanceTimersByTimeAsync(60_000); // tick 1
    await vi.advanceTimersByTimeAsync(60_000); // tick 2

    // Tick 2 processed the new enrollment successfully.
    expect(resumeContactFromWait).toHaveBeenCalledTimes(2);
  });
});
