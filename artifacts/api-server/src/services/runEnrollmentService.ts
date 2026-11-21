import { pool } from "@workspace/db";
import { hpAuthorizationField, hpRuleDeliveryAllowed } from "../lib/hpRuleSequence";
import { logger } from "../lib/logger";
import { enqueueStepsBulk, isTenantQueueAvailable } from "./queue";
import { sendEmail, renderTemplate, injectJourneyTrackingLinks, injectAllEmailTrackingLinks, generateClickToken, injectHoneypotLink } from "./email";
import { withLiveEnrollment } from "./liveEnrollmentGuard";

/**
 * Background enrollment loop.
 * Creates sequence_enrollments and dispatches the first step to BullMQ or runs inline.
 *
 * Run status lifecycle:
 *  - BullMQ path (Redis + published steps): enrollment sets status='running' and leaves it
 *    there; the sequence-worker's complete() → maybeCompleteRun() transitions to 'completed'
 *    when the last enrollment finishes its step chain.
 *  - Inline path (no Redis OR no published steps): inline email send is awaited before
 *    marking the run 'completed', so the status reflects actual delivery completion.
 *  - All-skipped edge case: if enrolled===0, the run is completed immediately regardless
 *    of path (no step jobs were dispatched).
 *
 * Safety guarantees:
 *  - Exclusive claim: transitions run to 'running' via UPDATE WHERE status IN ('pending','scheduled').
 *  - Progress continuity: reads current enrolled/skipped from DB for correct resume.
 *  - BullMQ deduplication (jobId) + exclusive claim prevent double-processing.
 *  - Pause/cancel respected: polls run status every 20 contacts.
 */
/**
 * Returns the Nth next valid send Date (n=1 → first valid day after today).
 * sendDays uses ISO weekday numbers: 1=Mon…7=Sun.
 * Always starts from tomorrow so today is never re-used.
 */
function getNthNextSendDate(sendDays: number[], sendWindowStart: string, n: number): Date {
  const [hStr = "9", mStr = "0"] = sendWindowStart.split(":");
  const h = parseInt(hStr, 10);
  const m = parseInt(mStr, 10);
  const d = new Date();
  d.setDate(d.getDate() + 1); // start from tomorrow
  let count = 0;
  for (let attempt = 0; attempt < 365; attempt++) {
    const jsDay  = d.getDay();
    const isoDay = jsDay === 0 ? 7 : jsDay;
    if ((sendDays as number[]).includes(isoDay)) {
      count++;
      if (count >= n) break;
    }
    d.setDate(d.getDate() + 1);
  }
  d.setHours(h, m, 0, 0);
  return d;
}

/** Convenience: first valid send date after today (n=1). */
function getNextSendDate(sendDays: number[], sendWindowStart: string): Date {
  return getNthNextSendDate(sendDays, sendWindowStart, 1);
}

export async function runContactEnrollment(
  runId: number,
  sequenceId: number,
  tenantId: number,
  contactIds: number[],
  playId?: number
): Promise<void> {
  // Atomic claim: set status → running. Only proceeds if in a startable state.
  const claimResult = await pool.query<{ enrolled: number; skipped: number }>(
    `UPDATE sequence_runs
     SET status = 'running', started_at = COALESCE(started_at, NOW())
     WHERE id = $1 AND status IN ('pending', 'scheduled')
     RETURNING COALESCE(enrolled, 0) AS enrolled, COALESCE(skipped, 0) AS skipped`,
    [runId]
  );
  if (!claimResult.rows[0]) {
    logger.info({ runId }, "Run enrollment skipped — run not in startable state");
    return;
  }

  let enrolled = claimResult.rows[0].enrolled;
  let skipped  = claimResult.rows[0].skipped;

  // Read daily send cap and schedule settings for this run.
  // daily_cap = null means unlimited (send everything in one pass).
  const capRow = await pool.query<{
    daily_cap: number | null;
    send_window_start: string | null;
    send_days: number[] | null;
    skip_recently_enrolled: boolean | null;
  }>(
    `SELECT daily_cap, send_window_start, send_days, skip_recently_enrolled FROM sequence_runs WHERE id = $1`,
    [runId]
  );
  const dailyCap              = capRow.rows[0]?.daily_cap ?? null;
  const sendWindowStart       = capRow.rows[0]?.send_window_start ?? "09:00";
  const sendDays              = capRow.rows[0]?.send_days ?? [1, 2, 3, 4, 5];
  // Default true (match historic behaviour); only skip the 24h window when admin explicitly allows re-enrollment.
  const skipRecentlyEnrolled  = capRow.rows[0]?.skip_recently_enrolled ?? true;

  // Count enrollments already made TODAY for this run so a mid-day server restart
  // doesn't reset the counter and accidentally double-send against the cap.
  let enrolledToday = 0;
  if (dailyCap !== null) {
    const { rows: todayRows } = await pool.query<{ cnt: string }>(
      `SELECT COUNT(*) AS cnt FROM sequence_enrollments
       WHERE run_id = $1 AND enrolled_at >= CURRENT_DATE`,
      [runId]
    );
    enrolledToday = parseInt(todayRows[0]?.cnt ?? "0", 10);
  }
  let enrolledThisSession = 0;

  // Fetch the first published step. If null, fall back to inline processing
  // (either sequence not yet published, or sequence has no steps).
  const firstStepRow = await pool.query<{ id: number }>(
    `SELECT id FROM sequence_steps WHERE sequence_id = $1 ORDER BY step_order ASC LIMIT 1`,
    [sequenceId]
  );
  const firstStepId    = firstStepRow.rows[0]?.id ?? null;
  const queueAvailable = await isTenantQueueAvailable(tenantId);

  // Inline path when: Redis unavailable OR no published steps exist.
  // When Redis is available but no steps are published, we must still deliver
  // emails — there's nothing to enqueue, so inline is the only option.
  const useInline = !queueAvailable || firstStepId === null;

  const inlineEnrollments: Array<{ enrollmentId: number; contactId: number }> = [];

  // Completes the current run at the daily cap and schedules continuation runs
  // for whatever contacts remain. Extracted so it can also run BEFORE the loop:
  // a recovered run whose cap is already consumed for today must still schedule
  // its remainder instead of silently exiting.
  const completeAtCapAndScheduleRemainder = async (remaining: number[]): Promise<void> => {
    // Persist current enrolled/skipped progress
    await pool.query(
      `UPDATE sequence_runs SET enrolled=$2, skipped=$3 WHERE id=$1`,
      [runId, enrolled, skipped]
    ).catch(() => {});

    // Flush inline emails BEFORE returning so today's batch actually delivers.
    if (useInline && inlineEnrollments.length > 0) {
      await processInlineEnrollments(sequenceId, tenantId, inlineEnrollments, runId);
    }

    // Mark today's run as completed
    await pool.query(
      `UPDATE sequence_runs SET status='completed', completed_at=NOW() WHERE id=$1`,
      [runId]
    ).catch(() => {});

    if (remaining.length > 0) {
      // Fetch run metadata to copy into continuation runs
      const metaRes = await pool.query<{
        journey_id: number | null; client_id: number | null;
        segment_id: number | null; play_id: number | null;
        send_window_start: string; send_window_end: string;
        send_days: number[]; started_by: number | null;
      }>(
        `SELECT journey_id, client_id, segment_id, play_id,
                send_window_start, send_window_end, send_days, started_by
         FROM sequence_runs WHERE id=$1`,
        [runId]
      );
      const meta = metaRes.rows[0];
      const sdArr: number[] = Array.isArray(meta?.send_days) ? meta.send_days : [1, 2, 3, 4, 5];
      const cap = dailyCap!;

      // Split remaining into daily chunks and create one run per chunk
      for (let chunk = 0, day = 1; chunk < remaining.length; chunk += cap, day++) {
        const batch       = remaining.slice(chunk, chunk + cap);
        const scheduledAt = getNthNextSendDate(sdArr, meta?.send_window_start ?? "09:00", day);
        await pool.query(
          `INSERT INTO sequence_runs
             (sequence_id, tenant_id, journey_id, client_id, segment_id, play_id,
              contact_list_ids, status, total_contacts, enrolled, skipped, errors,
              daily_cap, send_window_start, send_window_end, send_days,
              scheduled_at, started_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'scheduled',$8,0,0,0,$9,$10,$11,$12,$13,$14)`,
          [
            sequenceId, tenantId,
            meta?.journey_id ?? null, meta?.client_id ?? null,
            meta?.segment_id ?? null, meta?.play_id ?? null,
            batch, batch.length,
            cap, meta?.send_window_start ?? "09:00", meta?.send_window_end ?? "18:00",
            sdArr, scheduledAt.toISOString(), meta?.started_by ?? null,
          ]
        ).catch(err => logger.warn({ err, runId, day }, "Failed to create continuation run"));
      }
      logger.info(
        { runId, dailyCap, remaining: remaining.length, futureRuns: Math.ceil(remaining.length / dailyCap!) },
        "Daily cap reached — completed run, created scheduled continuation runs"
      );
    } else {
      logger.info({ runId, dailyCap }, "Daily cap reached — no remaining contacts");
    }
  };

  // Restart-safety: if today's cap is already consumed (e.g. the process died
  // right after the cap-sized chunk was inserted but before continuation runs
  // were created), schedule the remainder now instead of looping zero times.
  if (dailyCap !== null && enrolledToday >= dailyCap && contactIds.length > 0) {
    await completeAtCapAndScheduleRemainder([...new Set(contactIds)]);
    return;
  }

  // Batched enrollment: the previous per-contact loop performed 3-4 awaited DB
  // round-trips per contact (tens of thousands of serial queries for large runs,
  // taking 30-60+ minutes). Each chunk now costs a fixed handful of queries.
  //
  // NOTE on cursor semantics: workers resume interrupted runs using
  // (enrolled + skipped) as an offset into the raw contact_list_ids, so we must
  // iterate the RAW list and account for every raw element. In-list duplicates
  // are filtered per chunk (they'd bypass the INSERT's pre-existing-row guard)
  // and counted as skipped to keep the cursor consistent.
  // 2 000-contact chunks: 4x fewer iterations vs 500.
  // Cancellation + progress-persist run every CANCEL_EVERY chunks to avoid
  // one DB round-trip per chunk on the critical path.
  const CHUNK_SIZE    = 2000;
  const CANCEL_EVERY  = 5;   // check run status every ~10 000 contacts
  const PERSIST_EVERY = 5;   // write enrolled/skipped progress every ~10 000 contacts
  const seen = new Set<number>();
  let chunkIndex = 0;

  for (let i = 0; i < contactIds.length; ) {
    // Throttled cancellation check
    if (chunkIndex % CANCEL_EVERY === 0) {
      const { rows: stRows } = await pool.query<{ status: string }>(
        `SELECT status FROM sequence_runs WHERE id=$1`,
        [runId]
      );
      if (stRows[0]?.status !== "running") break;
    }
    chunkIndex++;

    // Never enroll past the daily cap: bound the chunk by remaining cap headroom.
    let chunkSize = CHUNK_SIZE;
    if (dailyCap !== null) {
      const capRemaining = dailyCap - (enrolledToday + enrolledThisSession);
      if (capRemaining <= 0) break; // handled by cap block below on previous chunk
      chunkSize = Math.min(CHUNK_SIZE, capRemaining);
    }
    const rawChunk = contactIds.slice(i, i + chunkSize);
    i += rawChunk.length;

    const chunk: number[] = [];
    for (const cid of rawChunk) {
      if (seen.has(cid)) { skipped++; continue; }
      seen.add(cid);
      chunk.push(cid);
    }
    if (chunk.length === 0) continue;

    let inserted: Array<{ id: number; contact_id: number }> = [];
    try {
      // Single batch INSERT with the re-enrollment guard; sets current_step_id inline.
      // ON CONFLICT against the partial unique index (idx_seq_enrollments_active_unique)
      // absorbs races with concurrent runs inserting after this statement's snapshot —
      // only the contested rows are dropped, not the whole chunk.
      // The 24-hour re-enrollment guard mirrors the prefilter in resolveContactIds.
      // When the run was created with skipRecentlyEnrolled=false, we only block
      // currently-active enrollments — not recently-completed ones.
      const recentClause = skipRecentlyEnrolled
        ? `OR se.enrolled_at >= NOW() - INTERVAL '24 hours'`
        : "";
      const insResult = await pool.query<{ id: number; contact_id: number }>(
        `WITH live_contacts AS MATERIALIZED (
           SELECT c.id FROM contacts c
           JOIN unnest($2::int[]) AS ids(cid) ON ids.cid=c.id
           WHERE c.tenant_id=$5
           FOR KEY SHARE OF c
         )
         INSERT INTO sequence_enrollments
           (sequence_id, contact_id, status, enrolled_at, run_id, current_step_id)
         SELECT $1, live_contacts.id, 'active', NOW(), $3, $4
         FROM live_contacts
         WHERE NOT EXISTS (
           SELECT 1 FROM sequence_enrollments se
            WHERE se.sequence_id = $1 AND se.contact_id = live_contacts.id
             AND (se.status = 'active' ${recentClause})
         )
         ON CONFLICT (sequence_id, contact_id) WHERE status = 'active' DO NOTHING
         RETURNING id, contact_id`,
        [sequenceId, chunk, runId, firstStepId, tenantId]
      );
      inserted = insResult.rows;
    } catch (err) {
      logger.warn({ err, runId, chunkStart: i - rawChunk.length }, "Batch enrollment failed — skipping chunk");
      skipped += chunk.length;
      await pool.query(
        `UPDATE sequence_runs SET enrolled=$2, skipped=$3 WHERE id=$1`,
        [runId, enrolled, skipped]
      ).catch(() => {});
      continue;
    }

    skipped += chunk.length - inserted.length;

    if (inserted.length > 0) {
      const insertedContactIds = inserted.map(r => r.contact_id);

      // Each side-write locks only still-live contacts for its statement.
      // A deletion either waits and removes these rows, or finishes first and
      // these writes skip the deleted contact.
      pool.query(
        `WITH live_contacts AS MATERIALIZED (
           SELECT c.id FROM contacts c JOIN unnest($4::int[]) AS ids(cid) ON ids.cid=c.id
           WHERE c.tenant_id=$1 FOR KEY SHARE OF c
         )
         INSERT INTO activity_events
           (tenant_id, contact_id, event_type, description, metadata, created_at)
         SELECT $1, id, 'sequence_enrolled', $2, $3::jsonb, NOW()
         FROM live_contacts`,
        [tenantId, `Enrolled in sequence run #${runId}`,
         JSON.stringify({ sequenceId, runId }), insertedContactIds]
      ).catch(err => logger.warn({ err, runId }, "Batch activity_events insert failed"));

      if (playId) {
        pool.query(
          `WITH live_contacts AS MATERIALIZED (
             SELECT c.id FROM contacts c JOIN unnest($3::int[]) AS ids(cid) ON ids.cid=c.id
             WHERE c.tenant_id=$1 FOR KEY SHARE OF c
           )
           INSERT INTO play_contacts (tenant_id, play_id, contact_id, enrolled_at)
           SELECT $1, $2, id, NOW() FROM live_contacts
           ON CONFLICT (play_id, contact_id) DO NOTHING`,
          [tenantId, playId, insertedContactIds]
        ).catch(() => {});
      }

      if (useInline) {
        for (const r of inserted) {
          inlineEnrollments.push({ enrollmentId: r.id, contactId: r.contact_id });
        }
      } else {
        // BullMQ path: bulk-enqueue first steps. On failure, compensate by marking
        // the chunk's enrollments completed so maybeCompleteRun() is not blocked.
        try {
          await enqueueStepsBulk(
            inserted.map(r => ({
              enrollmentId: r.id,
              stepId:    firstStepId!,
              sequenceId,
              contactId: r.contact_id,
              tenantId,
              runId,
            }))
          );
        } catch (enqErr) {
          logger.warn(
            { enqErr, runId, count: inserted.length },
            "Failed to bulk-enqueue steps — compensating enrollments to prevent stalled run"
          );
          await pool.query(
            `UPDATE sequence_enrollments SET status='completed', completed_at=NOW()
             WHERE id = ANY($1::int[])`,
            [inserted.map(r => r.id)]
          ).catch(() => {});
        }
      }

      enrolled            += inserted.length;
      enrolledThisSession += inserted.length;
    }

    // Throttled progress persist — once every PERSIST_EVERY chunks or on the last one
    const isLastChunk = i >= contactIds.length;
    if (chunkIndex % PERSIST_EVERY === 0 || isLastChunk) {
      pool.query(
        `UPDATE sequence_runs SET enrolled=$2, skipped=$3 WHERE id=$1`,
        [runId, enrolled, skipped]
      ).catch(() => {});
    }

    // Daily cap enforcement: once dailyCap emails are sent today, complete
    // the current run and create separate scheduled runs for each remaining
    // daily batch — one visible entry per day in the All Runs list.
    if (dailyCap !== null && enrolledToday + enrolledThisSession >= dailyCap) {
      const remaining = contactIds.slice(i).filter(cid => !seen.has(cid));
      await completeAtCapAndScheduleRemainder([...new Set(remaining)]);
      return;
    }
  }

  if (useInline && inlineEnrollments.length > 0) {
    // Inline path: send emails synchronously so run completion reflects real delivery.
    await processInlineEnrollments(sequenceId, tenantId, inlineEnrollments, runId);
  }

  // Run completion:
  //  - Inline path or all-skipped: mark completed now (delivery is done or there's nothing to wait for).
  //  - BullMQ path with enrolled contacts: leave as 'running'; the worker's
  //    maybeCompleteRun() will transition to 'completed' when the last step finishes.
  //  - BullMQ path where all enqueues failed: the per-contact compensation above marks
  //    those enrollments 'completed' immediately; catch this here so the run doesn't stall.
  const { rows: statusRows } = await pool.query<{ status: string }>(
    `SELECT status FROM sequence_runs WHERE id=$1`,
    [runId]
  );
  if (statusRows[0]?.status === "running") {
    let completedNow = enrolled === 0;

    if (!completedNow) {
      // Both paths: a run is only actually done once no enrollment remains 'active'.
      // Inline enrollments can now be 'active' with a resume_at (paused at a wait
      // step) — those must NOT be treated as complete just because useInline is true.
      // The sequenceResumeRunner poller will call maybeCompleteRun() once the last
      // paused enrollment finishes its remaining steps.
      const { rows: activeRows } = await pool.query<{ cnt: string }>(
        `SELECT COUNT(*) FILTER (WHERE status = 'active') AS cnt
         FROM sequence_enrollments WHERE run_id = $1`,
        [runId]
      );
      if (Number(activeRows[0]?.cnt ?? 1) === 0) {
        completedNow = true;
      }
    }

    if (completedNow) {
      await pool.query(
        `UPDATE sequence_runs
         SET status='completed', completed_at=NOW(), enrolled=$2, skipped=$3
         WHERE id=$1`,
        [runId, enrolled, skipped]
      );
    } else {
      // BullMQ path: final count update; status stays 'running' for worker to complete
      await pool.query(
        `UPDATE sequence_runs SET enrolled=$2, skipped=$3 WHERE id=$1`,
        [runId, enrolled, skipped]
      );
    }
  }
}

// ── Inline email processor (no-Redis fallback) ─────────────────────────────────

export type EnrollmentRef = { enrollmentId: number; contactId: number };

type ContactRow = {
  id: number; email: string; first_name: string; last_name: string;
  company_name: string | null; lead_score: number; tags: string[] | null;
};

type TemplateRow = {
  id: number; subject: string; body_html: string; body_text: string;
};

type StepRow = {
  id: number; step_order: number; step_type: string;
  config: Record<string, unknown>;
  wait_duration: number | null; wait_unit: string | null;
  true_next_step_id: number | null; false_next_step_id: number | null;
};

/**
 * Process all sequence steps for a batch of enrolled contacts without BullMQ.
 * Email steps are sent immediately; wait durations are logged but not honoured
 * (no scheduler available). Condition and tag steps are evaluated in-process.
 */
export async function processInlineEnrollments(
  sequenceId: number,
  tenantId: number,
  enrollments: EnrollmentRef[],
  runId?: number
): Promise<void> {
  // Fetch all published steps ordered by step_order
  const stepsRes = await pool.query<StepRow>(
    `SELECT id, step_order, step_type,
            config, wait_duration, wait_unit,
            true_next_step_id, false_next_step_id
     FROM sequence_steps
     WHERE sequence_id = $1
     ORDER BY step_order ASC`,
    [sequenceId]
  );
  const publishedSteps = stepsRes.rows;

  let totalFailures = 0;

  // If the sequence has never been published, fall back to walking nodes_json
  if (publishedSteps.length === 0) {
    totalFailures = await processInlineFromNodesJson(sequenceId, tenantId, enrollments);
  } else {
    for (const { enrollmentId, contactId } of enrollments) {
      const failures = await processContactStepsInline(
        enrollmentId, contactId, tenantId, sequenceId, publishedSteps, 0
      );
      totalFailures += failures;
    }
  }

  // Persist any send failures to the run so the report shows an accurate error count
  if (runId && totalFailures > 0) {
    await pool.query(
      `UPDATE sequence_runs SET errors = COALESCE(errors, 0) + $2 WHERE id = $1`,
      [runId, totalFailures]
    ).catch(err => logger.warn({ err, runId, totalFailures }, "Failed to update run error count"));
  }
}

/**
 * Compute the wall-clock time a paused enrollment should resume at.
 * Defaults duration to 1 when missing/invalid rather than 0, since a 0 (or
 * missing) duration would resume immediately and reproduce the "wait is
 * skipped" bug this function exists to fix. Callers log a warning whenever
 * this default kicks in so misconfigured wait steps are visible in logs.
 */
function computeResumeAt(duration: number, unit: string): Date {
  const msPerUnit: Record<string, number> = {
    minutes: 60_000,
    hours: 3_600_000,
    days: 86_400_000,
  };
  const ms = msPerUnit[unit] ?? msPerUnit.hours;
  return new Date(Date.now() + duration * ms);
}

/**
 * Walk sequence steps linearly for a single contact, starting at `startIndex`.
 * Email steps send immediately. Wait steps now pause the enrollment: they
 * record `resume_at` + `current_step_id` (the next step) and return without
 * marking the enrollment completed. A separate poller (sequenceResumeRunner)
 * picks up enrollments whose resume_at has elapsed and calls
 * `resumeContactFromWait` to continue this same walk from where it left off.
 * The enrollment is only marked 'completed' when the step list is exhausted.
 */
async function processContactStepsInline(
  enrollmentId: number,
  contactId: number,
  tenantId: number,
  sequenceId: number,
  steps: StepRow[],
  startIndex: number
): Promise<number> {
  const contactRes = await pool.query<ContactRow>(
    `SELECT c.id, c.email, c.first_name, c.last_name,
            co.name AS company_name, c.lead_score, c.tags
     FROM contacts c
     LEFT JOIN companies co ON co.id = c.company_id AND co.tenant_id = c.tenant_id
     WHERE c.id = $1 AND c.tenant_id = $2`,
    [contactId, tenantId]
  );
  const contact = contactRes.rows[0];
  if (!contact || !contact.email) {
    logger.warn({ enrollmentId, contactId }, "processContactStepsInline: contact missing or has no email");
    return 0;
  }

  let sendFailures = 0;

  for (let idx = startIndex; idx < steps.length; idx++) {
    const step = steps[idx];

    const envRes = await pool.query<{ status: string }>(
      `SELECT status FROM sequence_enrollments WHERE id=$1`,
      [enrollmentId]
    );
    if (envRes.rows[0]?.status !== "active") return sendFailures;

    if (step.step_type === "email") {
      const ok = await sendEmailStep(step, contact, tenantId, enrollmentId, sequenceId);
      if (!ok) sendFailures++;
    } else if (step.step_type === "wait") {
      const rawDuration = step.wait_duration;
      const unit = step.wait_unit ?? "hours";
      const missingDuration = !rawDuration || rawDuration <= 0;
      const duration = missingDuration ? 1 : rawDuration;
      if (missingDuration) {
        logger.warn(
          { enrollmentId, contactId, stepId: step.id, sequenceId, unit },
          `Wait step ${step.id} has no duration configured — defaulting to 1 ${unit}. ` +
          "Open the sequence editor and set the intended delay on this step."
        );
      }
      const resumeAt = computeResumeAt(duration, unit);
      const nextStep = steps[idx + 1] ?? null;
      await pool.query(
        `UPDATE sequence_enrollments SET current_step_id=$1, resume_at=$2 WHERE id=$3`,
        [nextStep?.id ?? null, resumeAt, enrollmentId]
      ).catch(() => {});
      logger.info(
        { enrollmentId, contactId, stepId: step.id, resumeAt, duration, unit },
        "Inline mode: pausing enrollment at wait step until resume_at"
      );
      return sendFailures;
    } else if (step.step_type === "tag") {
      const cfg = step.config;
      const tag = String(cfg.tagName ?? "");
      if (tag) {
        const op = String(cfg.operation ?? "add");
        const tagQ = op === "add"
          ? `UPDATE contacts SET tags = array_append(COALESCE(tags,'{}'), $1) WHERE id=$2 AND NOT ($1 = ANY(COALESCE(tags,'{}')))`
          : `UPDATE contacts SET tags = array_remove(COALESCE(tags,'{}'), $1) WHERE id=$2`;
        await pool.query(tagQ, [tag, contactId]).catch(() => {});
      }
    }
    // condition steps: continue linearly (branching not feasible in inline mode)
  }

  // Step list exhausted naturally — enrollment is done.
  await pool.query(
    `UPDATE sequence_enrollments SET status='completed', completed_at=NOW(), current_step_id=NULL, resume_at=NULL WHERE id=$1`,
    [enrollmentId]
  ).catch(() => {});

  return sendFailures;
}

/**
 * Resume a single enrollment that was paused at a wait step whose resume_at
 * has now elapsed. Looks up where it left off via current_step_id and
 * continues the linear walk from there. Called by the sequenceResumeRunner
 * poller (see scheduledActions-style setInterval in sequenceResumeRunner.ts).
 *
 * `current_step_id` is positive for published-steps enrollments (a real
 * sequence_steps.id) and negative for the nodes_json fallback path (encodes
 * `-(nodeIndex + 1)` — see processInlineFromNodesJson doc comment).
 */
/**
 * Result returned by resumeContactFromWait.
 *
 * `claimed` is true only when THIS invocation won the atomic DB claim (set
 * resume_at = NULL on the row).  It is false when another concurrent runner
 * process already claimed the enrollment — in that case no email was sent and
 * the error counter must NOT be reset, because the other process may have
 * recorded a failure/backoff that should count toward the consecutive-error
 * threshold.
 *
 * `failures` is the number of email send failures encountered during this
 * resume walk (0 when claimed is false).
 */
export type ResumeResult = { claimed: boolean; failures: number };

export async function resumeContactFromWait(
  enrollmentId: number,
  contactId: number,
  tenantId: number,
  sequenceId: number
): Promise<ResumeResult> {
  // Atomic claim: clear resume_at ONLY if it is still set (IS NOT NULL).
  // Returns current_step_id so we don't need a separate SELECT.
  // If two resume-runner ticks fire concurrently, only one UPDATE wins;
  // the other gets 0 rows back and bails — this is the definitive fix for
  // the double-send race where both ticks see the same enrollment and both
  // send the email.
  const claimRes = await pool.query<{ current_step_id: number | null }>(
    `UPDATE sequence_enrollments
     SET resume_at = NULL
     WHERE id = $1 AND status = 'active' AND resume_at IS NOT NULL
     RETURNING current_step_id`,
    [enrollmentId]
  );

  if (claimRes.rows.length === 0) {
    // Another concurrent tick already claimed this enrollment — skip silently.
    logger.info({ enrollmentId, contactId }, "resumeContactFromWait: enrollment already claimed by another runner tick — skipping to prevent double-send");
    return { claimed: false, failures: 0 };
  }

  const currentStepId = claimRes.rows[0]?.current_step_id ?? null;

  if (currentStepId !== null && currentStepId < 0) {
    const nodesJsonSteps = await loadNodesJsonSteps(sequenceId, tenantId);
    const startIndex = -currentStepId - 1;
    if (startIndex < 0 || startIndex >= nodesJsonSteps.length) {
      logger.warn(
        { enrollmentId, contactId, currentStepId, startIndex, sequenceId },
        "resumeContactFromWait: nodes_json index out of range — marking enrollment completed"
      );
      await pool.query(
        `UPDATE sequence_enrollments SET status='completed', completed_at=NOW(), resume_at=NULL WHERE id=$1`,
        [enrollmentId]
      ).catch(() => {});
      return { claimed: true, failures: 0 };
    }
    const failures = await processContactNodesJsonSteps(enrollmentId, contactId, tenantId, sequenceId, nodesJsonSteps, startIndex);
    return { claimed: true, failures };
  }

  const stepsRes = await pool.query<StepRow>(
    `SELECT id, step_order, step_type, config, wait_duration, wait_unit,
            true_next_step_id, false_next_step_id
     FROM sequence_steps
     WHERE sequence_id = $1
     ORDER BY step_order ASC`,
    [sequenceId]
  );
  const steps = stepsRes.rows;

  const startIndex = currentStepId ? steps.findIndex(s => s.id === currentStepId) : -1;

  if (startIndex === -1) {
    logger.warn(
      { enrollmentId, contactId, currentStepId, sequenceId },
      "resumeContactFromWait: current_step_id not found among published steps — marking enrollment completed"
    );
    await pool.query(
      `UPDATE sequence_enrollments SET status='completed', completed_at=NOW(), resume_at=NULL WHERE id=$1`,
      [enrollmentId]
    ).catch(() => {});
    return { claimed: true, failures: 0 };
  }

  const failures = await processContactStepsInline(enrollmentId, contactId, tenantId, sequenceId, steps, startIndex);
  return { claimed: true, failures };
}

/**
 * Attempt to send one email step.
 * Returns true if the email was handed off to Resend successfully,
 * false if the template was missing, the contact had no email,
 * or Resend returned an error.
 */
async function sendEmailStep(
  step: StepRow,
  contact: ContactRow,
  tenantId: number,
  enrollmentId: number,
  sequenceId: number
): Promise<boolean> {
  const templateId = step.config.templateId ? Number(step.config.templateId) : null;
  if (!templateId) {
    logger.warn({ enrollmentId, sequenceId }, "sendEmailStep: no templateId on step — skipping");
    return false;
  }

  const tplRes = await pool.query<TemplateRow>(
    `SELECT id, subject, body_html, body_text FROM email_templates WHERE id=$1 AND tenant_id=$2`,
    [templateId, tenantId]
  );
  const tpl = tplRes.rows[0];
  if (!tpl) {
    logger.warn(
      { enrollmentId, sequenceId, templateId, tenantId },
      "sendEmailStep: template not found — skipping send"
    );
    return false;
  }

  // Look up the journey slug for this sequence (via its linked play → client → journey)
  // so that {{journey_url}} in email templates points to the right journey with contact identity.
  let journeyUrl = "";
  try {
    const journeyRes = await pool.query<{ slug: string }>(
      `SELECT j.slug FROM journeys j
       WHERE j.tenant_id=$3 AND j.status='published' AND (
         EXISTS(SELECT 1 FROM activity_events a WHERE a.tenant_id=j.tenant_id
           AND a.event_type='hp_rule_sequence_authorized' AND a.journey_id=j.id
           AND ${hpAuthorizationField("a","enrollmentId")}=$2::text)
         OR (
           NOT EXISTS(SELECT 1 FROM activity_events a WHERE a.tenant_id=j.tenant_id
             AND a.event_type='hp_rule_sequence_authorized' AND ${hpAuthorizationField("a","enrollmentId")}=$2::text)
           AND j.client_id IN (SELECT p.client_id FROM email_sequences s
             JOIN abm_plays p ON p.id=s.play_id AND p.tenant_id=s.tenant_id WHERE s.id=$1 AND s.tenant_id=$3)
         ))
       ORDER BY j.id ASC
       LIMIT 1`,
      [sequenceId,enrollmentId,tenantId]
    );
    if (journeyRes.rows[0]?.slug) {
      const domains = (process.env.REPLIT_DOMAINS ?? "").split(",");
      const base = process.env.BASE_URL ?? (domains[0] ? `https://${domains[0]}` : "");
      // Use path-based click token so corporate email proxies cannot strip ?cid= params
      const clickToken = generateClickToken(contact.id, tenantId, journeyRes.rows[0].slug, undefined, templateId);
      journeyUrl = `${base}/api/public/click/${clickToken}`;
    }
  } catch (err) {
    logger.warn({ err, sequenceId }, "sendEmailStep: failed to resolve journey URL");
  }

  const vars: Record<string, string> = {
    firstName:   contact.first_name  ?? "",
    lastName:    contact.last_name   ?? "",
    companyName: contact.company_name ?? "",
    playName:    String(step.config.playName ?? ""),
    journeyUrl,
  };

  const rawHtml = renderTemplate(tpl.body_html, vars);
  // Inject click-tracking into EVERY http/https link in the template (not just /j/ ones),
  // so custom CTAs like /hp/play/... are also wrapped in click-ext tokens.
  const domains = (process.env.REPLIT_DOMAINS ?? "").split(",");
  const base    = process.env.BASE_URL ?? (domains[0] ? `https://${domains[0]}` : "");
  const trackedHtml = injectAllEmailTrackingLinks(rawHtml, contact.id, {
    tenantId, baseUrl: base, templateId, enrollmentId,
  });
  const html    = injectHoneypotLink(trackedHtml, contact.id, tenantId, base, enrollmentId);
  const text    = renderTemplate(tpl.body_text, vars);
  const subject = renderTemplate(tpl.subject,   vars);

  const guarded=await withLiveEnrollment(tenantId,contact.id,enrollmentId,contact.email,async()=>{
  if (!await hpRuleDeliveryAllowed(enrollmentId, tenantId)) {
    throw new Error("Sequence delivery is paused or its approved routing destination/contact is no longer eligible.");
  }
  const sent = await sendEmail({
    to: contact.email,
    subject,
    html,
    text,
    tenantId,
    contactId:    contact.id,
    templateId,
    enrollmentId,
    tags: [
      { name: "tenantId",     value: String(tenantId) },
      { name: "contactId",    value: String(contact.id) },
      { name: "templateId",   value: String(templateId) },
      { name: "sequenceId",   value: String(sequenceId) },
      { name: "enrollmentId", value: String(enrollmentId) },
    ],
  });

  if (sent) {
    // email_events: step-stats attribution via template_id
    await pool.query(
      `INSERT INTO email_events (tenant_id, contact_id, template_id, event_type, metadata)
       VALUES ($1, $2, $3, 'sent', $4)`,
      [tenantId, contact.id, templateId, JSON.stringify({ stepId: step.id, enrollmentId, subject })]
    ).catch(() => {});

    // activity_events: contact timeline row (includes sequence_id for join)
    await pool.query(
      `INSERT INTO activity_events
         (tenant_id, contact_id, event_type, description, metadata, sequence_id, created_at)
       VALUES ($1, $2, 'email_sent', $3, $4, $5, NOW())`,
      [
        tenantId, contact.id,
        `Email sent: ${subject}`,
        JSON.stringify({ templateId, subject, sequenceId, enrollmentId }),
        sequenceId,
      ]
    ).catch(() => {});
  } else {
    logger.warn(
      { enrollmentId, contactId: contact.id, templateId, sequenceId },
      "sendEmailStep: sendEmail returned false — check Resend API key / domain verification"
    );
  }

  return sent;
  }).catch((err: unknown) => {
    logger.error({ err, enrollmentId, contactId: contact.id, stepId: step.id }, "sendEmailStep: live-enrollment guard failed");
    return { allowed: false } as const;
  });
  return guarded.allowed ? guarded.value : false;
}

/**
 * Load and order the raw nodes_json nodes for a sequence (email/wait/tag types only),
 * sorted by vertical position — matching the order used at publish time.
 */
async function loadNodesJsonSteps(
  sequenceId: number,
  tenantId: number
): Promise<Array<{ type: string; data: Record<string, unknown> }>> {
  const seqRes = await pool.query<{ nodes_json: unknown }>(
    `SELECT nodes_json FROM email_sequences WHERE id=$1 AND tenant_id=$2`,
    [sequenceId, tenantId]
  );
  const nodesJson = seqRes.rows[0]?.nodes_json as {
    nodes: Array<{ type: string; data: Record<string, unknown>; position?: { y: number } }>;
  } | null;
  if (!nodesJson) return [];
  return (nodesJson.nodes ?? [])
    .filter(n => n.type === "email" || n.type === "wait" || n.type === "tag")
    .sort((a, b) => (a.position?.y ?? 0) - (b.position?.y ?? 0))
    .map(n => ({ type: n.type, data: n.data }));
}

/**
 * Fallback when the sequence has no published steps: walk nodes_json directly.
 * Unlike the old implementation (which only sent email nodes back-to-back, ignoring
 * wait nodes entirely — the same "wait skipped" bug this whole refactor fixes), this
 * walks ALL nodes in position order and pauses at wait nodes just like
 * processContactStepsInline does for published steps.
 *
 * Since sequence_steps rows don't exist for unpublished sequences, there is no real
 * step id to resume from. We reuse the `current_step_id` column (a plain integer with
 * no FK constraint) as a sentinel: negative values encode `-(nodeIndex + 1)` for the
 * nodes_json walk, so resumeContactFromWait can tell "published step id" (positive)
 * apart from "nodes_json index" (negative) and dispatch to the right resume path.
 * Returns total number of send failures across all enrollments.
 */
async function processInlineFromNodesJson(
  sequenceId: number,
  tenantId: number,
  enrollments: EnrollmentRef[]
): Promise<number> {
  const steps = await loadNodesJsonSteps(sequenceId, tenantId);

  if (steps.length === 0) {
    // Nothing to send — mark enrollments completed so they don't stay active
    for (const { enrollmentId } of enrollments) {
      await pool.query(
        `UPDATE sequence_enrollments SET status='completed', completed_at=NOW() WHERE id=$1`,
        [enrollmentId]
      ).catch(() => {});
    }
    return 0;
  }

  let totalFailures = 0;

  for (const { enrollmentId, contactId } of enrollments) {
    totalFailures += await processContactNodesJsonSteps(
      enrollmentId, contactId, tenantId, sequenceId, steps, 0
    );
  }

  return totalFailures;
}

/**
 * Walk nodes_json nodes linearly for a single contact, starting at `startIndex`.
 * Mirrors processContactStepsInline's wait-pausing behaviour for the unpublished-sequence
 * fallback path (see processInlineFromNodesJson doc comment for the sentinel encoding).
 */
async function processContactNodesJsonSteps(
  enrollmentId: number,
  contactId: number,
  tenantId: number,
  sequenceId: number,
  steps: Array<{ type: string; data: Record<string, unknown> }>,
  startIndex: number
): Promise<number> {
  const contactRes = await pool.query<ContactRow>(
    `SELECT c.id, c.email, c.first_name, c.last_name,
            co.name AS company_name, c.lead_score, c.tags
     FROM contacts c
     LEFT JOIN companies co ON co.id = c.company_id AND co.tenant_id = c.tenant_id
     WHERE c.id = $1 AND c.tenant_id = $2`,
    [contactId, tenantId]
  );
  const contact = contactRes.rows[0];
  if (!contact || !contact.email) {
    logger.warn({ enrollmentId, contactId }, "processInlineFromNodesJson: contact missing or has no email — skipping");
    return 0;
  }

  let sendFailures = 0;

  for (let idx = startIndex; idx < steps.length; idx++) {
    const node = steps[idx];

    const envRes = await pool.query<{ status: string }>(
      `SELECT status FROM sequence_enrollments WHERE id=$1`,
      [enrollmentId]
    );
    if (envRes.rows[0]?.status !== "active") return sendFailures;

    if (node.type === "email") {
      const fakeStep: StepRow = {
        id: 0,
        step_order: 0,
        step_type: "email",
        config: node.data,
        wait_duration: null,
        wait_unit: null,
        true_next_step_id: null,
        false_next_step_id: null,
      };
      const ok = await sendEmailStep(fakeStep, contact, tenantId, enrollmentId, sequenceId);
      if (!ok) sendFailures++;
    } else if (node.type === "wait") {
      const rawDuration = Number(node.data.duration ?? node.data.waitDuration ?? 0);
      const unit = String(node.data.unit ?? node.data.waitUnit ?? "hours");
      const missingDuration = !rawDuration || rawDuration <= 0;
      const duration = missingDuration ? 1 : rawDuration;
      if (missingDuration) {
        logger.warn(
          { enrollmentId, contactId, nodeIndex: idx, sequenceId, unit },
          `Wait node at index ${idx} has no duration configured — defaulting to 1 ${unit}. ` +
          "Open the sequence editor, set the intended delay, and publish this sequence."
        );
      }
      const resumeAt = computeResumeAt(duration, unit);
      const nextIndex = idx + 1;
      await pool.query(
        `UPDATE sequence_enrollments SET current_step_id=$1, resume_at=$2 WHERE id=$3`,
        [-(nextIndex + 1), resumeAt, enrollmentId]
      ).catch(() => {});
      logger.info(
        { enrollmentId, contactId, nodeIndex: idx, resumeAt, duration, unit },
        "Inline mode (nodes_json fallback): pausing enrollment at wait node until resume_at"
      );
      return sendFailures;
    } else if (node.type === "tag") {
      const tag = String(node.data.tagName ?? "");
      if (tag) {
        const op = String(node.data.operation ?? "add");
        const tagQ = op === "add"
          ? `UPDATE contacts SET tags = array_append(COALESCE(tags,'{}'), $1) WHERE id=$2 AND NOT ($1 = ANY(COALESCE(tags,'{}')))`
          : `UPDATE contacts SET tags = array_remove(COALESCE(tags,'{}'), $1) WHERE id=$2`;
        await pool.query(tagQ, [tag, contactId]).catch(() => {});
      }
    }
  }

  await pool.query(
    `UPDATE sequence_enrollments SET status='completed', completed_at=NOW(), current_step_id=NULL, resume_at=NULL WHERE id=$1`,
    [enrollmentId]
  ).catch(() => {});

  return sendFailures;
}

/**
 * Parse contact_list_ids from a sequence_run row (handles array or string formats).
 */
export function parseContactListIds(raw: unknown): number[] {
  if (Array.isArray(raw)) {
    return (raw as unknown[]).map(Number).filter(n => !isNaN(n));
  }
  if (typeof raw === "string") {
    return (raw as string).replace(/[{}]/g, "").split(",").filter(Boolean).map(Number);
  }
  return [];
}
