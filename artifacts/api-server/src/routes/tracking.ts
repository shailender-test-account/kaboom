/**
 * Email open/click tracking pixel endpoint.
 *
 * GET /api/track/open?cid=CONTACT_ID&tid=TENANT_ID&tmpl=TEMPLATE_ID&enr=ENROLLMENT_ID
 *
 * - No authentication required (called by email clients loading the pixel)
 * - Returns a 1×1 transparent GIF immediately (speed first)
 * - Bot detection (timing, IP CIDR, User-Agent) prevents scanner events from
 *   inflating lead scores or creating activity_events
 * - Legitimate opens: records email_events row, updates lead_score, inserts activity_events
 */
import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";
import { logger } from "../lib/logger";
import { computeIntentScore } from "../lib/intentScoring";
import { classifyRequest, parseUserAgent } from "../lib/botDetection";

const router: IRouter = Router();

const TRANSPARENT_GIF = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
  "base64"
);

router.get("/track/open", async (req, res): Promise<void> => {
  const cid   = parseInt(req.query.cid  as string ?? "");
  const tid   = parseInt(req.query.tid  as string ?? "");
  const tmpl  = parseInt(req.query.tmpl as string ?? "");
  const enr   = parseInt(req.query.enr  as string ?? "");
  // sentAt is unix seconds when the email was dispatched (injected into pixel URL at send time)
  const sentAt = parseInt(req.query.sa as string ?? "");

  // Return the GIF immediately regardless of bot status
  res.setHeader("Content-Type", "image/gif");
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
  res.setHeader("Pragma", "no-cache");
  res.end(TRANSPARENT_GIF);

  if (!cid || !tid) return;

  // Bot detection — runs after response is sent (fire-and-forget)
  let { isBot, reason } = classifyRequest(req, isNaN(sentAt) ? null : sentAt);

  // Honeypot enforcement: if a prior honeypot hit was recorded for this
  // contact+enrollment, treat this pixel as bot regardless of timing/IP/UA.
  if (!isBot && !isNaN(enr) && enr > 0) {
    const honeypotRow = await pool.query<{ id: number }>(
      `SELECT id FROM bot_sessions
       WHERE contact_id = $1 AND (enrollment_id = $2 OR enrollment_id IS NULL)
       LIMIT 1`,
      [cid, enr]
    ).catch(() => ({ rows: [] }));
    if (honeypotRow.rows.length > 0) {
      isBot = true;
      reason = "honeypot_flagged";
    }
  }

  try {
    // Parse UA for non-bot opens — stored in metadata for client/device analytics
    const rawUa = req.headers["user-agent"] ?? "";
    const uaParsed = !isBot ? parseUserAgent(rawUa) : null;

    // Always record the email_events row — mark is_bot so analytics can filter
    await pool.query(
      `INSERT INTO email_events (tenant_id, contact_id, template_id, event_type, metadata, occurred_at, is_bot)
       VALUES ($1, $2, $3, 'opened', $4, NOW(), $5)`,
      [
        tid,
        cid,
        isNaN(tmpl) ? null : tmpl,
        JSON.stringify({
          enrollmentId: isNaN(enr) ? null : enr,
          source: "pixel",
          botReason: reason,
          ...(uaParsed ? {
            emailClient: uaParsed.emailClient,
            deviceType: uaParsed.deviceType,
            os: uaParsed.os,
          } : {}),
        }),
        isBot,
      ]
    );

    if (isBot) {
      logger.info({ cid, tid, reason }, "Bot pixel load detected — score NOT updated");
      return;
    }

    const ruleRows = await pool.query<{ points: number }>(
      `SELECT points FROM scoring_rules
       WHERE event_type = 'email_open' AND is_active = 'true'
       ORDER BY id LIMIT 1`
    );
    const points: number = ruleRows.rows[0]?.points ?? 0;

    await pool.query(
      `UPDATE contacts
       SET lead_score = GREATEST(0, lead_score + $1)
       WHERE id = $2 AND tenant_id = $3`,
      [points, cid, tid]
    );

    await pool.query(
      `INSERT INTO activity_events
         (tenant_id, contact_id, event_type, description, source, score_delta, created_at, is_bot)
       VALUES ($1, $2, 'email_open', 'Email opened', 'email', $3, NOW(), FALSE)`,
      [tid, cid, points]
    );

    computeIntentScore(cid, tid)
      .catch(err => logger.warn({ err, cid, tid }, "computeIntentScore failed after pixel track"));

    logger.info({ cid, tid, tmpl, points }, "Email open tracked via pixel");
  } catch (err) {
    logger.warn({ err, cid, tid }, "Failed to record email open pixel");
  }
});

export default router;
