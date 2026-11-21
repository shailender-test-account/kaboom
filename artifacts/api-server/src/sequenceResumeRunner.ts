import { pool } from "@workspace/db";
import { logger } from "./lib/logger";
import { resumeContactFromWait } from "./services/runEnrollmentService";
import { maybeCompleteRun } from "./workers/sequence-worker";
import { hpAuthorizedEnrollmentSql, hpRuleSequenceEnabled } from "./lib/hpRuleSequence";

/**
 * Maximum consecutive resume failures before an enrollment is permanently
 * marked 'errored'.  Each failure below this threshold applies an
 * exponential backoff computed in SQL:
 *   count 1 → 5 min, 2 → 10 min, 3 → 20 min, 4 → 40 min, 5 → errored.
 */
const MAX_RESUME_ERRORS = 5;

/**
 * Polls for inline-mode enrollments paused at a wait step whose resume_at
 * has elapsed, and resumes them. Modeled on scheduledActions.ts's 60s tick.
 *
 * Why this exists: processContactStepsInline() (runEnrollmentService.ts) now
 * pauses at wait steps instead of skipping them (previous bug: step-2 email
 * was sent immediately after step-1 because waits were ignored). Since there
 * is no BullMQ/Redis scheduler in this environment, this poller is the only
 * thing that ever resumes a paused enrollment.
 *
 * Error backoff: if resumeContactFromWait throws unexpectedly (DB timeout,
 * malformed step config, etc.) the runner applies exponential backoff via a
 * single atomic UPDATE rather than leaving the enrollment in a state that
 * causes it to be re-picked on every subsequent tick ("zombie" loop).
 * After MAX_RESUME_ERRORS consecutive failures the enrollment is marked
 * 'errored' and maybeCompleteRun is invoked so its run does not stall.
 *
 * Counter semantics: resume_error_count tracks *consecutive* failures.  It is
 * reset to 0 only when resumeContactFromWait returns `claimed: true` (meaning
 * this process actually won the atomic claim and processed the enrollment).  A
 * claim-lost result (claimed: false) does NOT reset the counter, because the
 * winning process may have recorded a failure/backoff that must accumulate.
 *
 * Atomicity guarantee: the backoff/errored transition is a single SQL
 * statement.  If the atomic claim inside resumeContactFromWait already ran
 * (clearing resume_at to NULL) and processing then throws, the catch-block
 * UPDATE restores a future resume_at so the poller re-selects the enrollment
 * on a later tick rather than losing it with resume_at = NULL.
 */
export function startSequenceResumeRunner({ approvedHpOnly = false }: { approvedHpOnly?: boolean } = {}): void {
  // Reentrancy guard: if a tick is already in flight (e.g. large batch took
  // longer than 60s), skip the next tick entirely rather than running two
  // concurrent instances that could both pick up the same enrollment.
  // The atomic claim inside resumeContactFromWait is the primary guard;
  // this flag is defense-in-depth that also avoids unnecessary DB load.
  let running = false;

  setInterval(async () => {
    if (approvedHpOnly && !hpRuleSequenceEnabled()) return;
    if (running) {
      logger.info("Sequence resume runner: previous tick still in flight — skipping this tick");
      return;
    }
    running = true;
    try {
      const { rows } = await pool.query<{
        id: number; contact_id: number; sequence_id: number; run_id: number | null; tenant_id: number;
      }>(
        `SELECT se.id, se.contact_id, se.sequence_id, se.run_id, es.tenant_id
         FROM sequence_enrollments se
         JOIN email_sequences es ON es.id = se.sequence_id
         WHERE se.status = 'active' AND se.resume_at IS NOT NULL AND se.resume_at <= NOW()
           ${approvedHpOnly ? `AND ${hpAuthorizedEnrollmentSql}` : ""}
         ORDER BY se.resume_at ASC
         LIMIT 50`
      );

      const touchedRunIds = new Set<number>();

      for (const row of rows) {
        try {
          const result = await resumeContactFromWait(row.id, row.contact_id, row.tenant_id, row.sequence_id);

          if (result.claimed) {
            // This process genuinely processed the enrollment — add its run to
            // the completion check set and reset the consecutive-error counter.
            if (row.run_id) touchedRunIds.add(row.run_id);
            await pool.query(
              `UPDATE sequence_enrollments
               SET resume_error_count = 0
               WHERE id = $1 AND resume_error_count > 0`,
              [row.id]
            ).catch(resetErr =>
              logger.warn({ resetErr, enrollmentId: row.id }, "sequenceResumeRunner: failed to reset error count after successful resume")
            );
          }
          // claimed=false means another concurrent runner won the claim —
          // do NOT reset the counter; that runner may have recorded a failure.
        } catch (err) {
          logger.warn({ err, enrollmentId: row.id }, "sequenceResumeRunner: failed to resume enrollment");
          const wasErrored = await applyResumeBackoff(row.id);
          // When the enrollment is permanently errored its run must be checked
          // for completion — otherwise a run whose only remaining enrollment
          // just errored will stay 'running' forever because no successful
          // resume will ever fire maybeCompleteRun for it.
          if (wasErrored && row.run_id) {
            touchedRunIds.add(row.run_id);
          }
        }
      }

      for (const runId of touchedRunIds) {
        await maybeCompleteRun(runId).catch(err =>
          logger.warn({ err, runId }, "sequenceResumeRunner: maybeCompleteRun failed")
        );
      }

      if (rows.length > 0) {
        logger.info({ resumedCount: rows.length }, "Sequence resume runner: resumed paused enrollments");
      }
    } catch (err) {
      logger.warn({ err }, "Sequence resume runner error");
    } finally {
      running = false;
    }
  }, 60_000);

  logger.info("Sequence resume runner started (60s tick)");
}

/**
 * After an unexpected error in resumeContactFromWait, prevent the enrollment
 * from becoming a "zombie" that is re-selected on every runner tick.
 *
 * Returns true when the enrollment was permanently marked 'errored' (so the
 * caller can invoke maybeCompleteRun for the associated run), false otherwise.
 *
 * A single atomic UPDATE handles both failure scenarios:
 *
 *  Scenario A — the atomic claim inside resumeContactFromWait threw before it
 *  could clear resume_at: resume_at is still set in the past.  The UPDATE
 *  replaces it with a future backoff timestamp so the enrollment is not
 *  re-selected on the very next tick.
 *
 *  Scenario B — the claim succeeded (resume_at was set to NULL) but later
 *  processing threw.  The UPDATE restores a future resume_at so the enrollment
 *  is picked up again once the backoff has elapsed rather than remaining stuck
 *  with resume_at = NULL forever.
 *
 * Backoff schedule (SQL POWER expression, computed server-side):
 *   error count 1 →  5 min
 *   error count 2 → 10 min
 *   error count 3 → 20 min
 *   error count 4 → 40 min
 *   error count ≥ MAX_RESUME_ERRORS → status = 'errored', resume_at = NULL
 *
 * Using SQL-side computation keeps the logic in one round-trip: there is no
 * read-then-write race and no risk of a second query failing after the first
 * already altered the row.
 */
async function applyResumeBackoff(enrollmentId: number): Promise<boolean> {
  try {
    // State guard: only apply backoff if the enrollment is still in a state
    // this runner could legitimately act on — either resume_at was already
    // cleared to NULL by a successful claim (our ambiguous failure scenario)
    // OR resume_at is still in the past (the claim never ran on PG's side).
    //
    // Crucially, if another concurrent runner already claimed and ADVANCED the
    // enrollment to a new future resume_at (or completed it), the WHERE clause
    // will not match: a future resume_at fails the `<= NOW()` guard and a
    // completed/cancelled status fails the `status = 'active'` guard.  This
    // prevents a stale catch-path UPDATE from overwriting a validly advanced
    // enrollment and corrupting its resume_at or error counter.
    const { rows } = await pool.query<{
      resume_error_count: number;
      status: string;
    }>(
      `UPDATE sequence_enrollments
       SET
         resume_error_count = COALESCE(resume_error_count, 0) + 1,
         status = CASE
           WHEN COALESCE(resume_error_count, 0) + 1 >= $2 THEN 'errored'
           ELSE status
         END,
         resume_at = CASE
           WHEN COALESCE(resume_error_count, 0) + 1 >= $2 THEN NULL
           ELSE NOW() + (5 * POWER(2, COALESCE(resume_error_count, 0)) * INTERVAL '1 minute')
         END
       WHERE id = $1
         AND status = 'active'
         AND (resume_at IS NULL OR resume_at <= NOW())
       RETURNING resume_error_count, status`,
      [enrollmentId, MAX_RESUME_ERRORS]
    );

    const result = rows[0];
    if (!result) {
      // Row not found (enrollment deleted mid-tick) — nothing to do.
      logger.warn({ enrollmentId }, "sequenceResumeRunner: applyResumeBackoff found no matching row");
      return false;
    }

    if (result.status === "errored") {
      logger.warn(
        { enrollmentId, errorCount: result.resume_error_count, maxErrors: MAX_RESUME_ERRORS },
        "sequenceResumeRunner: enrollment permanently marked errored after max resume failures"
      );
      return true;
    }

    logger.info(
      { enrollmentId, errorCount: result.resume_error_count },
      "sequenceResumeRunner: applied exponential backoff to failing enrollment"
    );
    return false;
  } catch (backoffErr) {
    // If even the backoff UPDATE fails (e.g. complete DB outage), log a
    // critical warning.  If the atomic claim already cleared resume_at the
    // enrollment will be stuck with resume_at = NULL until the next deployment
    // or manual intervention; this is the unavoidable cost of a total DB
    // failure.  For scenario A (claim never ran), resume_at is still past and
    // the enrollment will be retried on the next tick.
    logger.warn(
      { backoffErr, enrollmentId },
      "sequenceResumeRunner: CRITICAL — failed to apply error backoff; enrollment may be permanently stuck if claim already cleared resume_at"
    );
    return false;
  }
}
