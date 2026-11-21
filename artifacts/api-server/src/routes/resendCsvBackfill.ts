/**
 * POST /api/admin/resend-csv-backfill
 *
 * Accepts a JSON body of parsed Resend export rows and retroactively advances
 * matched contacts to the `aware` stage, records an `email_click` activity
 * event, and recomputes intent scores.
 *
 * Query params:
 *   ?dry_run=true  — look up contacts and return preview counts; make no changes
 *
 * Body: { rows: Array<{ email: string; clickedAt?: string }> }
 *
 * Returns:
 *   { preview: true, matched, skippedAlreadyAware, unmatched }  (dry_run)
 *   { updated, skipped, unmatched, details[] }                  (live run)
 *
 * Dedup: if a contact already has an email_click event on the same UTC day as
 * clickedAt (or today if absent), the activity event is skipped — but the stage
 * is still advanced if needed.
 */

import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";
import { requireAuth, requireRole } from "../middlewares/requireAuth";
import { logger } from "../lib/logger";
import { computeIntentScore, SCORE_SOURCES } from "../lib/intentScoring";
import { recordBackfillRun } from "./resendBackfill";

const router: IRouter = Router();
router.use(requireAuth);

type AuthUser = { tenantId: number; id: number; role: string };

type InputRow = { email: string; clickedAt?: string | null };

const STAGE_RANK: Record<string, number> = {
  "pre-aware": 0, "aware": 1, "pre-engage": 2,
  "engage": 3, "advance-engage": 4, "action": 5,
};

function isPreAware(stage: string | null): boolean {
  const rank = STAGE_RANK[stage ?? "pre-aware"] ?? 0;
  return rank < STAGE_RANK["aware"];
}

router.post("/admin/resend-csv-backfill", requireRole("admin"), async (req, res, next): Promise<void> => {
  const user = req.user as AuthUser;
  const tenantId = user.tenantId;
  const isDryRun = req.query.dry_run === "true";

  const body = req.body as { rows?: unknown };
  if (!Array.isArray(body?.rows)) {
    res.status(400).json({ error: "Body must be { rows: Array<{ email, clickedAt? }> }" });
    return;
  }

  const inputRows = (body.rows as InputRow[]).filter(r => typeof r.email === "string" && r.email.includes("@"));
  if (inputRows.length === 0) {
    res.status(400).json({ error: "No valid email rows provided" });
    return;
  }
  if (inputRows.length > 5000) {
    res.status(400).json({ error: "Too many rows (max 5,000 per request)" });
    return;
  }

  try {
    const emails = inputRows.map(r => r.email.toLowerCase().trim());
    const uniqueEmails = [...new Set(emails)];

    const { rows: contactRows } = await pool.query<{
      id: number;
      email: string;
      stage: string | null;
      lead_score: number;
    }>(
      `SELECT id, LOWER(email) AS email, stage, COALESCE(lead_score, 0) AS lead_score
       FROM contacts
       WHERE tenant_id = $1 AND LOWER(email) = ANY($2::text[])`,
      [tenantId, uniqueEmails]
    );

    const contactByEmail = new Map<string, typeof contactRows[0]>();
    for (const c of contactRows) contactByEmail.set(c.email, c);

    const matched: number[] = [];
    const skippedAlreadyAware: number[] = [];
    const unmatched: string[] = [];

    for (const email of uniqueEmails) {
      const contact = contactByEmail.get(email);
      if (!contact) { unmatched.push(email); continue; }
      if (!isPreAware(contact.stage)) { skippedAlreadyAware.push(contact.id); continue; }
      matched.push(contact.id);
    }

    if (isDryRun) {
      res.json({
        preview: true,
        total_rows: uniqueEmails.length,
        matched: matched.length,
        skipped_already_aware: skippedAlreadyAware.length,
        unmatched: unmatched.length,
        unmatched_emails: unmatched.slice(0, 20),
      });
      return;
    }

    const emailToRow = new Map<string, InputRow>();
    for (const r of inputRows) emailToRow.set(r.email.toLowerCase().trim(), r);

    const summary = {
      updated: 0,
      skipped: skippedAlreadyAware.length + unmatched.length,
      unmatched: unmatched.length,
      event_skipped_duplicate: 0,
      routing_rules_suppressed: 0,
    };

    const details: Array<{
      email: string;
      contactId: number;
      action: "updated" | "skipped" | "unmatched";
      reason?: string;
    }> = [];

    for (const email of unmatched) {
      details.push({ email, contactId: 0, action: "unmatched" });
    }
    for (const cid of skippedAlreadyAware) {
      const email = [...contactByEmail.entries()].find(([, c]) => c.id === cid)?.[0] ?? "";
      details.push({ email, contactId: cid, action: "skipped", reason: "already_aware_or_beyond" });
    }

    for (const contactId of matched) {
      const contact = contactRows.find(c => c.id === contactId)!;
      const email = contact.email;
      const inputRow = emailToRow.get(email);
      const occurredAt = inputRow?.clickedAt ? new Date(inputRow.clickedAt) : new Date();
      if (isNaN(occurredAt.getTime())) { }
      const safeOccurredAt = isNaN(occurredAt.getTime()) ? new Date() : occurredAt;

      try {
        // Atomic CTE: UPDATE and INSERT happen in one statement — if the contact was
        // already advanced (or this runs twice), the WHERE guard produces 0 RETURNING rows
        // and the INSERT inserts nothing, preventing duplicate history entries.
        await pool.query(
          `WITH advanced AS (
             UPDATE contacts
             SET tags = (
                   SELECT ARRAY(SELECT DISTINCT unnest(COALESCE(tags, '{}') || ARRAY['aware']))
                 ),
                 stage = 'aware',
                 updated_at = NOW()
             WHERE id = $1 AND tenant_id = $2
               AND COALESCE(stage, 'pre-aware') = 'pre-aware'
             RETURNING id, COALESCE(lead_score, 0) AS score_at_transition
           )
           INSERT INTO contact_stage_history
             (tenant_id, contact_id, from_stage, to_stage, score_at_transition, created_at)
           SELECT $2, id, 'pre-aware', 'aware', score_at_transition, $3
           FROM advanced`,
          [contactId, tenantId, safeOccurredAt]
        );

        const dayStr = safeOccurredAt.toISOString().slice(0, 10);
        const { rows: existingClick } = await pool.query<{ id: number }>(
          `SELECT id FROM activity_events
           WHERE contact_id = $1 AND tenant_id = $2
             AND event_type = 'email_click'
             AND created_at::date = $3::date
           LIMIT 1`,
          [contactId, tenantId, dayStr]
        );

        if (existingClick.length === 0) {
          const { rows: ruleRows } = await pool.query<{ points: number }>(
            `SELECT points FROM scoring_rules
             WHERE event_type = 'email_click' AND is_active = 'true'
             ORDER BY id LIMIT 1`
          );
          const points = ruleRows[0]?.points ?? 0;

          await pool.query(
            `INSERT INTO activity_events
               (tenant_id, contact_id, event_type, description, source, score_delta, created_at)
             VALUES ($1, $2, 'email_click', 'Backfilled from Resend export', 'resend_csv_backfill', $3, $4)`,
            [tenantId, contactId, points, safeOccurredAt]
          );

          if (points !== 0) {
            await pool.query(
              `UPDATE contacts SET lead_score = GREATEST(0, COALESCE(lead_score, 0) + $1),
                                   last_activity = $2
               WHERE id = $3 AND tenant_id = $4`,
              [points, safeOccurredAt, contactId, tenantId]
            );
          }
        } else {
          summary.event_skipped_duplicate++;
        }

        // Pass source:"backfill" so that computeIntentScore skips evaluateRoutingRules.
        // A CSV backfill is a historical data correction (retroactively crediting a past
        // email click), not a live behaviour signal. Routing rules fired here could enroll
        // contacts in journeys or sequences they are not ready for, and — for rules with
        // if_already_in_journey="re_add" — could reset the added_at timestamp for contacts
        // already mid-sequence, causing them to lose their place. The intent score and heat
        // tag are still recomputed and persisted; only the side-effecting rule evaluation
        // is suppressed. When rules are suppressed a `sequence_enrollment_skipped` activity
        // event is written to the contact's timeline so admins have visibility.
        const scoreResult = await computeIntentScore(contactId, tenantId, { source: SCORE_SOURCES.BACKFILL }).catch(err => {
          logger.warn({ err, contactId }, "computeIntentScore failed after csv backfill");
          return null;
        });
        if (scoreResult?.routingRulesSuppressed) {
          summary.routing_rules_suppressed++;
        }

        summary.updated++;
        details.push({ email, contactId, action: "updated" });
      } catch (err) {
        logger.warn({ err, contactId, email }, "resend-csv-backfill: failed to process contact");
        details.push({ email, contactId, action: "skipped", reason: "error" });
        summary.skipped++;
      }
    }

    logger.info({
      tenantId,
      total_rows: uniqueEmails.length,
      updated: summary.updated,
      skipped: summary.skipped,
      unmatched: summary.unmatched,
      event_skipped_duplicate: summary.event_skipped_duplicate,
      routing_rules_suppressed: summary.routing_rules_suppressed,
    }, "resend-csv-backfill complete");

    recordBackfillRun({
      tenantId,
      triggeredBy: user.id,
      source: "csv_upload",
      totalRows: uniqueEmails.length,
      updated: summary.updated,
      skipped: summary.skipped,
      unmatched: summary.unmatched,
      extra: {
        event_skipped_duplicate: summary.event_skipped_duplicate,
        contacts: details.slice(0, 500).map(d => ({ id: d.contactId, action: d.action, email: d.email })),
      },
    });

    res.json({
      ok: true,
      total_rows: uniqueEmails.length,
      updated: summary.updated,
      skipped: summary.skipped,
      unmatched: summary.unmatched,
      event_skipped_duplicate: summary.event_skipped_duplicate,
      /** Number of contacts whose intent state changed during this backfill, meaning
       *  routing rules (e.g. sequence enrollment triggers) would have fired under
       *  normal evaluation but were intentionally suppressed. A `sequence_enrollment_skipped`
       *  activity event is written to each such contact's timeline for admin visibility. */
      routing_rules_suppressed: summary.routing_rules_suppressed,
      details: details.slice(0, 200),
    });
  } catch (err) {
    next(err);
  }
});

export default router;
