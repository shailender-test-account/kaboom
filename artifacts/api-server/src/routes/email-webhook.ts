import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, emailEventsTable, contactsTable, sequenceEnrollmentsTable, pool } from "@workspace/db";
import { verifyUnsubscribeToken } from "../services/email";
import { logger } from "../lib/logger";
import { evaluateRoutingRules } from "../lib/scoringEngine";
import { computeIntentScore } from "../lib/intentScoring";

const router: IRouter = Router();

// Stage/heat classification is now handled entirely by computeIntentScore.
// Legacy scoreToStage() function removed — do not re-add score-threshold stage mutations.

async function recordEmailActivity(opts: {
  tenantId: number;
  contactId: number;
  activityEventType: string;
  description: string;
}): Promise<void> {
  const { tenantId, contactId, activityEventType, description } = opts;

  const { rows: ruleRows } = await pool.query<{ points: number }>(
    `SELECT points FROM scoring_rules
     WHERE event_type = $1 AND is_active = 'true'
     ORDER BY id LIMIT 1`,
    [activityEventType]
  );
  const points: number = ruleRows[0]?.points ?? 0;

  const { rows: contactRows } = await pool.query<{ lead_score: number }>(
    `SELECT lead_score FROM contacts WHERE id = $1 AND tenant_id = $2 LIMIT 1`,
    [contactId, tenantId]
  );
  const oldScore = Number(contactRows[0]?.lead_score ?? 0);
  const newScore = Math.max(0, oldScore + points);

  if (points !== 0) {
    await pool.query(
      `UPDATE contacts SET lead_score = GREATEST(0, COALESCE(lead_score, 0) + $1) WHERE id = $2 AND tenant_id = $3`,
      [points, contactId, tenantId]
    );
  }

  await pool.query(
    `INSERT INTO activity_events
       (tenant_id, contact_id, event_type, description, source, score_delta, created_at)
     VALUES ($1, $2, $3, $4, 'email', $5, NOW())`,
    [tenantId, contactId, activityEventType, description, points]
  );

  evaluateRoutingRules({ tenantId, contactId, newScore, oldScore, tagsAdded: [] })
    .catch(err => logger.warn({ err }, "evaluateRoutingRules failed after email webhook activity"));

  computeIntentScore(contactId, tenantId)
    .catch(err => logger.warn({ err }, "computeIntentScore failed after email webhook activity"));
}

router.post("/email/webhook", async (req, res, next): Promise<void> => {
  try {
    const events = Array.isArray(req.body) ? req.body : [req.body];
    for (const event of events) {
      const eventType = event.type?.replace("email.", "") ?? event.type;
      // Resend delivers recipient address in data.to[] or top-level email field
      const recipientEmail: string | undefined =
        (Array.isArray(event.data?.to) ? event.data.to[0] : undefined)
        ?? event.data?.email
        ?? event.email;
      // Resend sends tags as [{name, value}] array; normalize to key→value object
      const rawTags = event.data?.tags ?? {};
      const tags: Record<string, string> = Array.isArray(rawTags)
        ? Object.fromEntries(rawTags.map((t: any) => [t.name, String(t.value ?? "")]))
        : rawTags;
      const tenantId = tags.tenantId ? parseInt(tags.tenantId) : 1;
      let contactId: number | null = tags.contactId ? parseInt(tags.contactId) : null;
      const templateId = tags.templateId ? parseInt(tags.templateId) : null;
      const enrollmentIdFromTag = tags.enrollmentId ? parseInt(tags.enrollmentId) : null;

      // Fallback: if contactId wasn't in the Resend tags, look up the contact by
      // recipient email so opens/clicks still update the correct record.
      if (!contactId && recipientEmail) {
        const { rows: emailRows } = await pool.query<{ id: number }>(
          `SELECT id FROM contacts WHERE email = $1 AND tenant_id = $2 LIMIT 1`,
          [recipientEmail.toLowerCase(), tenantId]
        );
        if (emailRows[0]) contactId = emailRows[0].id;
      }

      const typeMap: Record<string, string> = {
        "email.sent": "sent",
        "email.delivered": "delivered",
        "email.opened": "opened",
        "email.clicked": "clicked",
        "email.bounced": "bounced",
        // complained = spam report; preserve as distinct event type (NOT collapsed to unsubscribed)
        "email.complained": "complained",
        sent: "sent", delivered: "delivered", opened: "opened",
        clicked: "clicked", bounced: "bounced", complained: "complained",
      };
      const mappedType = typeMap[eventType] ?? eventType;

      if (tenantId && mappedType) {
        // Enrich metadata with structured fields extracted from Resend tags
        // so deliverability queries can join via (metadata->>'enrollmentId')::int
        const enrichedMetadata = {
          ...(typeof event.data === "object" && event.data !== null ? event.data : { raw: event }),
          ...(enrollmentIdFromTag ? { enrollmentId: enrollmentIdFromTag } : {}),
        };
        await db.insert(emailEventsTable).values({
          tenantId,
          contactId,
          templateId,
          eventType: mappedType,
          metadata: enrichedMetadata,
        });
      }

      // ── Score + activity_events for opens and clicks ────────────────────────
      if (contactId && tenantId && (mappedType === "clicked" || mappedType === "opened")) {
        const activityEventType = mappedType === "clicked" ? "email_click" : "email_open";
        const description = mappedType === "clicked" ? "Email link clicked" : "Email opened";
        try {
          // For opens: deduplicate — skip if the tracking pixel already recorded
          // an email_open activity_event for this contact in the last 10 minutes
          if (mappedType === "opened") {
            const { rows: existing } = await pool.query<{ id: number }>(
              `SELECT id FROM activity_events
               WHERE contact_id = $1 AND event_type = 'email_open'
               AND created_at > NOW() - INTERVAL '10 minutes' LIMIT 1`,
              [contactId]
            );
            if (existing.length > 0) {
              // Pixel already handled this open — skip to avoid double-counting
            } else {
              await recordEmailActivity({ tenantId, contactId, activityEventType, description });
            }
          } else {
            // For clicks: deduplicate — skip if the /public/click/:token route
            // already recorded an email_click for this contact in the last 10 minutes.
            // The click-redirect route is the authoritative source; the webhook is a
            // fallback for cases where the tracking redirect was not followed (e.g.
            // one-click unsubscribe headers, preloaded URLs by some clients).
            const { rows: existingClick } = await pool.query<{ id: number }>(
              `SELECT id FROM activity_events
               WHERE contact_id = $1 AND event_type = 'email_click'
               AND created_at > NOW() - INTERVAL '10 minutes' LIMIT 1`,
              [contactId]
            );
            if (existingClick.length === 0) {
              await recordEmailActivity({ tenantId, contactId, activityEventType, description });
              // Advance to 'aware' stage on email click — webhook path (Path B).
              // Atomic CTE: the UPDATE and history INSERT happen in one statement
              // so concurrent webhook deliveries for the same contact cannot produce
              // duplicate rows (Path B vs Path B).
              //
              // Cross-path guard: the WHERE clause checks BOTH the stage column AND
              // the tag array. Path A (advanceStageInDB) appends the 'aware' tag
              // WITHOUT updating the stage column in its CTE. Without the tag check
              // here, a Path A that wins the row lock first would leave stage='pre-aware',
              // allowing this CTE to also match and insert a second history row.
              // The `NOT ('aware' = ANY(...))` guard closes that gap: whichever path
              // appends the tag first makes the other's UPDATE match 0 rows.
              const { rowCount } = await pool.query(
                `WITH advanced AS (
                   UPDATE contacts
                   SET stage = 'aware',
                       tags  = CASE WHEN 'aware' = ANY(COALESCE(tags, '{}')) THEN tags
                                    ELSE array_append(COALESCE(tags, '{}'), 'aware') END
                   WHERE id = $2 AND tenant_id = $1
                     AND COALESCE(stage, 'pre-aware') = 'pre-aware'
                     AND NOT ('aware' = ANY(COALESCE(tags, '{}')))
                   RETURNING id, tenant_id, lead_score
                 )
                 INSERT INTO contact_stage_history
                   (tenant_id, contact_id, from_stage, to_stage, score_at_transition, created_at)
                 SELECT tenant_id, id, 'pre-aware', 'aware', lead_score, NOW()
                 FROM advanced`,
                [tenantId, contactId]
              );
              if ((rowCount ?? 0) > 0) {
                logger.info({ contactId, tenantId }, "Contact advanced to aware stage via email click webhook (Path B)");
              }
              // Re-run intent score now that stage has been advanced — recordEmailActivity
              // already called computeIntentScore internally, but that ran BEFORE the
              // stage/tag update above, so a second pass is needed to reflect the new stage.
              computeIntentScore(contactId, tenantId)
                .catch(err => logger.warn({ err, contactId, tenantId }, "computeIntentScore failed after webhook stage advancement"));
            }
          }
        } catch (err) {
          logger.warn({ err, contactId, tenantId, mappedType }, "Failed to record activity_event for email webhook");
        }
      }

      // Both explicit unsubscribe and spam complaints suppress the contact
      if ((mappedType === "unsubscribed" || mappedType === "complained") && contactId) {
        await db.update(sequenceEnrollmentsTable)
          .set({ status: "unsubscribed" })
          .where(eq(sequenceEnrollmentsTable.contactId, contactId));
        await db.update(contactsTable)
          .set({ status: "unsubscribed", dnc: true })
          .where(eq(contactsTable.id, contactId));
      }
    }
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ── GET /unsubscribe — show confirmation page (bots cannot submit forms) ──────
router.get("/unsubscribe", async (req, res): Promise<void> => {
  const { email, token } = req.query as { email?: string; token?: string };
  if (!email || !token) {
    res.status(400).send("<h2>Invalid unsubscribe link</h2>");
    return;
  }
  if (!verifyUnsubscribeToken(email, token)) {
    res.status(403).send("<h2>Invalid or expired link</h2>");
    return;
  }
  // Show a confirmation page — the actual unsubscribe only fires on POST.
  // Email security scanners only perform GET requests; this stops bot-triggered unsubscribes.
  const safeEmail = email.replace(/[<>&"]/g, c => ({ "<":"&lt;",">":"&gt;","&":"&amp;",'"':"&quot;" }[c] ?? c));
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Unsubscribe</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background:#f9fafb; margin:0; display:flex; align-items:center; justify-content:center; min-height:100vh; }
    .card { background:#fff; border-radius:12px; box-shadow:0 4px 24px rgba(0,0,0,.08); padding:48px 40px; max-width:440px; width:100%; text-align:center; }
    h2 { margin:0 0 12px; font-size:22px; color:#111827; }
    p  { margin:0 0 28px; color:#6b7280; font-size:15px; line-height:1.6; }
    .email { font-weight:600; color:#374151; }
    .btn { display:inline-block; background:#6366f1; color:#fff; border:none; border-radius:8px; padding:12px 28px; font-size:15px; font-weight:600; cursor:pointer; text-decoration:none; }
    .btn:hover { background:#4f46e5; }
    .cancel { display:block; margin-top:16px; font-size:13px; color:#9ca3af; text-decoration:none; }
    .cancel:hover { color:#374151; }
  </style>
</head>
<body>
  <div class="card">
    <h2>Unsubscribe from emails?</h2>
    <p>Confirm that you want to stop receiving campaign emails at<br/><span class="email">${safeEmail}</span></p>
    <form method="POST" action="/api/unsubscribe">
      <input type="hidden" name="email" value="${safeEmail}" />
      <input type="hidden" name="token" value="${token}" />
      <button type="submit" class="btn">Yes, unsubscribe me</button>
    </form>
    <a class="cancel" href="javascript:history.back()">No, take me back</a>
  </div>
</body>
</html>`);
});

// ── POST /unsubscribe — performs the actual unsubscribe after confirmation ────
router.post("/unsubscribe", async (req, res, next): Promise<void> => {
  const { email, token } = req.body as { email?: string; token?: string };
  if (!email || !token) {
    res.status(400).send("<h2>Invalid request</h2>");
    return;
  }
  try {
    if (!verifyUnsubscribeToken(email, token)) {
      res.status(403).send("<h2>Invalid or expired link</h2>");
      return;
    }
    const contacts = await db.select().from(contactsTable).where(eq(contactsTable.email, email.toLowerCase()));
    for (const contact of contacts) {
      await db.update(contactsTable).set({ status: "unsubscribed", dnc: true }).where(eq(contactsTable.id, contact.id));
      await db.update(sequenceEnrollmentsTable).set({ status: "unsubscribed" })
        .where(eq(sequenceEnrollmentsTable.contactId, contact.id));
      await db.insert(emailEventsTable).values({
        tenantId: contact.tenantId,
        contactId: contact.id,
        eventType: "unsubscribed",
        metadata: { source: "unsubscribe_link" },
      });
    }
    logger.info({ email }, "Contact unsubscribed via confirmed link");
    res.send(`<!DOCTYPE html><html lang="en"><body style="font-family:sans-serif;text-align:center;padding:60px;background:#f9fafb;">
<div style="background:#fff;border-radius:12px;box-shadow:0 4px 24px rgba(0,0,0,.08);padding:48px 40px;max-width:440px;margin:0 auto;">
<h2 style="color:#111827;margin-bottom:12px;">You have been unsubscribed</h2>
<p style="color:#6b7280;">You will no longer receive campaign emails. If this was a mistake, please contact the sender.</p>
</div></body></html>`);
  } catch (err) { next(err); }
});

export default router;
