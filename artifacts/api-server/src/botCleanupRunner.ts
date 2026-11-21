import { pool } from "@workspace/db";
import { logger } from "./lib/logger";
import { computeIntentScore, SCORE_SOURCES } from "./lib/intentScoring";

/**
 * Weekly automated bot-event cleanup runner.
 *
 * WHY THIS EXISTS
 * ───────────────
 * Corporate email security gateways (Microsoft Safe Links, Proofpoint, Mimecast)
 * pre-scan every URL in a sequence email within seconds-to-minutes of delivery.
 * These scans fire tracking events (email_click → page_view → scroll_depth) that
 * are indistinguishable from real human engagement at the HTTP level.  The click
 * handler now blocks clicks arriving within 5 minutes of send (CLICK_BOT_TIMING_
 * WINDOW_SEC = 300), but this runner cleans up any that slipped through the
 * previous 15-second window and backdates the damage from prior weeks.
 *
 * SCHEDULE
 * ────────
 * Ticks every 24 hours.  On each tick it checks when the cleanup last ran.
 * If it has been ≥ 7 days (or never), it runs the full cleanup for ALL tenants.
 * Using a daily tick + DB-stored last-run timestamp means a server restart never
 * causes a missed week — the runner simply picks up where it left off next tick.
 *
 * WHAT IT DELETES
 * ────────────────
 * 1. email_click activity_events that arrived within 5 minutes of the preceding
 *    email_sent for the same contact (Safe Links fires within ~2 min of delivery;
 *    real humans click hours later).
 * 2. page_view / scroll_depth / email_open events for the same contact that
 *    landed within 30 seconds of one of those bot clicks (the scanner followed
 *    the redirect and the journey JS fired tracking — all fake).
 *
 * After deletion it adjusts lead_score (subtract deleted score_delta) and
 * recomputes intent_score for every affected contact.
 */

const WEEKLY_MS      = 7 * 24 * 60 * 60 * 1000;   // 7 days
const TICK_MS        = 24 * 60 * 60 * 1000;        // check daily
const BOT_WINDOW_SEC = 300;                         // must match CLICK_BOT_TIMING_WINDOW_SEC

export function startBotCleanupRunner(): void {
  let running = false;

  setInterval(async () => {
    if (running) {
      logger.debug("Bot cleanup runner: previous run still in flight — skipping tick");
      return;
    }
    running = true;
    try {
      // Check when cleanup last ran (across any tenant — single global cadence).
      const { rows } = await pool.query<{ last_run: Date }>(
        `SELECT last_run FROM bot_cleanup_log ORDER BY last_run DESC LIMIT 1`
      );
      const lastRun = rows[0]?.last_run ? new Date(rows[0].last_run) : null;
      const msSinceLast = lastRun ? Date.now() - lastRun.getTime() : Infinity;

      if (msSinceLast < WEEKLY_MS) {
        const daysLeft = ((WEEKLY_MS - msSinceLast) / 86_400_000).toFixed(1);
        logger.debug({ daysLeft }, "Bot cleanup runner: next run not due yet");
        return;
      }

      logger.info({ lastRun }, "Bot cleanup runner: weekly run starting");
      const startedAt = new Date();

      // Fetch all tenant IDs that have activity_events.
      const { rows: tenants } = await pool.query<{ tenant_id: number }>(
        `SELECT DISTINCT tenant_id FROM activity_events`
      );

      let totalBotClicks        = 0;
      let totalFollowOn         = 0;
      let totalContactsRecomputed = 0;

      for (const { tenant_id } of tenants) {
        try {
          // ── Step 1: delete email_click events within BOT_WINDOW_SEC of email_sent ──
          const { rows: botClicks } = await pool.query<{
            id: number;
            contact_id: number;
            score_delta: number;
            created_at: Date;
          }>(
            `DELETE FROM activity_events
             WHERE tenant_id = $1
               AND event_type = 'email_click'
               AND id IN (
                 SELECT cl.id
                 FROM activity_events cl
                 JOIN LATERAL (
                   SELECT created_at
                   FROM activity_events
                   WHERE contact_id = cl.contact_id
                     AND tenant_id  = $1
                     AND event_type = 'email_sent'
                     AND created_at <= cl.created_at
                   ORDER BY created_at DESC
                   LIMIT 1
                 ) se ON true
                 WHERE cl.tenant_id = $1
                   AND EXTRACT(EPOCH FROM (cl.created_at - se.created_at)) < $2
               )
             RETURNING id, contact_id, COALESCE(score_delta, 0) AS score_delta, created_at`,
            [tenant_id, BOT_WINDOW_SEC]
          );

          if (botClicks.length === 0) continue;

          const botClickTimes = botClicks.map(r => ({
            contactId: r.contact_id,
            at: new Date(r.created_at),
          }));
          const affectedContactIds = [...new Set(botClicks.map(r => r.contact_id))];

          // ── Step 2: delete follow-on page_view / scroll_depth / email_open ──
          // Parameters: $1 = tenant_id, then pairs ($2,$3), ($4,$5), … for each bot click.
          let followOnDeleted = 0;
          if (botClickTimes.length > 0) {
            const valueParams = botClickTimes
              .map((_, i) => `($${i * 2 + 2}::int, $${i * 2 + 3}::timestamptz)`)
              .join(",");
            const { rowCount } = await pool.query(
              `DELETE FROM activity_events
               WHERE tenant_id = $1
                 AND event_type IN ('page_view', 'scroll_depth', 'email_open')
                 AND (contact_id, created_at) IN (
                   SELECT ae.contact_id, ae.created_at
                   FROM activity_events ae
                   WHERE ae.tenant_id = $1
                     AND ae.event_type IN ('page_view', 'scroll_depth', 'email_open')
                     AND EXISTS (
                       SELECT 1
                       FROM (VALUES ${valueParams}) AS bc(cid, clicked_at)
                       WHERE bc.cid = ae.contact_id
                         AND ae.created_at
                             BETWEEN bc.clicked_at AND bc.clicked_at + INTERVAL '30 seconds'
                     )
                 )`,
              [tenant_id, ...botClickTimes.flatMap(b => [b.contactId, b.at.toISOString()])]
            );
            followOnDeleted = rowCount ?? 0;
          }

          // ── Step 3: adjust lead_score for deleted score_delta ──
          const scoreLoss = new Map<number, number>();
          for (const r of botClicks) {
            scoreLoss.set(r.contact_id, (scoreLoss.get(r.contact_id) ?? 0) + Number(r.score_delta));
          }
          for (const [cid, loss] of scoreLoss.entries()) {
            if (loss !== 0) {
              await pool.query(
                `UPDATE contacts
                 SET lead_score = GREATEST(0, COALESCE(lead_score, 0) - $1)
                 WHERE id = $2 AND tenant_id = $3`,
                [loss, cid, tenant_id]
              ).catch(() => {});
            }
          }

          // ── Step 4: recompute intent_score for affected contacts ──
          let recomputed = 0;
          for (const cid of affectedContactIds) {
            try {
              await computeIntentScore(cid, tenant_id, { source: SCORE_SOURCES.ADMIN_RECOMPUTE });
              recomputed++;
            } catch (err) {
              logger.warn({ err, contactId: cid, tenant_id }, "Bot cleanup runner: recompute failed");
            }
          }

          totalBotClicks          += botClicks.length;
          totalFollowOn           += followOnDeleted;
          totalContactsRecomputed += recomputed;

          logger.info(
            { tenant_id, botClicksDeleted: botClicks.length, followOnDeleted, recomputed },
            "Bot cleanup runner: tenant complete"
          );
        } catch (err) {
          logger.warn({ err, tenant_id }, "Bot cleanup runner: tenant-level error");
        }
      }

      // ── Persist last-run timestamp ──
      await pool.query(
        `INSERT INTO bot_cleanup_log (run_at, bot_clicks_deleted, follow_on_deleted, contacts_recomputed, duration_ms)
         VALUES ($1, $2, $3, $4, $5)`,
        [startedAt, totalBotClicks, totalFollowOn, totalContactsRecomputed, Date.now() - startedAt.getTime()]
      );

      logger.info(
        {
          totalBotClicksDeleted: totalBotClicks,
          totalFollowOnDeleted:  totalFollowOn,
          totalContactsRecomputed,
          durationMs: Date.now() - startedAt.getTime(),
        },
        "Bot cleanup runner: weekly run complete"
      );
    } catch (err) {
      logger.warn({ err }, "Bot cleanup runner: top-level error");
    } finally {
      running = false;
    }
  }, TICK_MS);

  logger.info({ tickMs: TICK_MS, windowSec: BOT_WINDOW_SEC }, "Bot cleanup runner started (24h tick, 7-day cadence)");
}
