import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";
import { requireAuth } from "../middlewares/requireAuth";
import { logger } from "../lib/logger";

const router: IRouter = Router();

router.use(requireAuth);

/**
 * GET /api/admin/pipeline-check?email=X
 *
 * Returns the current stage, intent score, heat tag, and recent signal events
 * for a contact (looked up by email within the caller's tenant).
 * Auth-gated + tenant-scoped — never leaks cross-tenant data.
 */
router.get("/admin/pipeline-check", async (req, res, next): Promise<void> => {
  try {
    const tenantId = (req as any).user?.tenantId as number | undefined;
    if (!tenantId) { res.status(401).json({ error: "Not authenticated" }); return; }

    const email = (req.query.email as string | undefined)?.toLowerCase().trim();
    if (!email) {
      res.status(400).json({ error: "Query param 'email' is required" });
      return;
    }

    const { rows: contactRows } = await pool.query<{
      id: number;
      stage: string | null;
      intent_score: number | null;
      raw_intent_score: number | null;
      intent_state: string | null;
      tags: string[] | null;
    }>(
      `SELECT id, stage, intent_score, raw_intent_score, intent_state, tags
       FROM contacts
       WHERE email = $1 AND tenant_id = $2
       LIMIT 1`,
      [email, tenantId]
    );

    if (!contactRows[0]) {
      res.status(404).json({ error: "Contact not found" });
      return;
    }

    const contact = contactRows[0];
    const contactId = contact.id;

    // Derive heat tag from tags array
    const HEAT_TAGS = ["very-hot", "hot", "warm", "cold"];
    const heatTag = contact.tags?.find(t => HEAT_TAGS.includes(t)) ?? "cold";

    // Last email_click event
    const { rows: clickRows } = await pool.query<{
      id: number; created_at: string; description: string;
    }>(
      `SELECT id, created_at, description
       FROM activity_events
       WHERE contact_id = $1 AND tenant_id = $2 AND event_type = 'email_click'
       ORDER BY created_at DESC LIMIT 1`,
      [contactId, tenantId]
    );

    // Last email_open event
    const { rows: openRows } = await pool.query<{
      id: number; created_at: string;
    }>(
      `SELECT id, created_at
       FROM activity_events
       WHERE contact_id = $1 AND tenant_id = $2 AND event_type = 'email_open'
       ORDER BY created_at DESC LIMIT 1`,
      [contactId, tenantId]
    );

    // Last page_view event
    const { rows: pvRows } = await pool.query<{
      id: number; created_at: string;
    }>(
      `SELECT id, created_at
       FROM activity_events
       WHERE contact_id = $1 AND tenant_id = $2 AND event_type = 'page_view'
       ORDER BY created_at DESC LIMIT 1`,
      [contactId, tenantId]
    );

    logger.info({ contactId, tenantId, email }, "Pipeline check performed");

    res.json({
      contactId,
      email,
      stage:          contact.stage ?? "pre-aware",
      intentScore:    contact.intent_score  ?? 0,
      rawIntentScore: contact.raw_intent_score ?? 0,
      intentState:    contact.intent_state  ?? null,
      heatTag,
      lastEmailClick:  clickRows[0]
        ? { id: clickRows[0].id, occurredAt: clickRows[0].created_at, description: clickRows[0].description }
        : null,
      lastEmailOpen:   openRows[0]
        ? { id: openRows[0].id, occurredAt: openRows[0].created_at }
        : null,
      lastPageView:    pvRows[0]
        ? { id: pvRows[0].id, occurredAt: pvRows[0].created_at }
        : null,
    });
  } catch (err) { next(err); }
});

/**
 * GET /api/admin/backfill-aware-stage/preview
 *
 * Dry-run: returns the count + up to 10 sample contacts (name, email) that
 * WOULD be advanced by the backfill, without mutating anything.
 * Admin role required, tenant-scoped.
 */
router.get("/admin/backfill-aware-stage/preview", async (req, res, next): Promise<void> => {
  try {
    const user = (req as any).user as { tenantId?: number; role?: string } | undefined;
    if (!user?.tenantId) { res.status(401).json({ error: "Not authenticated" }); return; }
    if (user.role !== "admin") { res.status(403).json({ error: "Admin role required" }); return; }

    const tenantId = user.tenantId;

    const { rows } = await pool.query<{ id: number; first_name: string | null; last_name: string | null; email: string }>(
      `SELECT c.id, c.first_name, c.last_name, c.email
       FROM contacts c
       WHERE COALESCE(c.stage, 'pre-aware') = 'pre-aware'
         AND c.tenant_id = $1
         AND EXISTS (
           SELECT 1
           FROM activity_events ae
           WHERE ae.contact_id = c.id
             AND ae.tenant_id  = c.tenant_id
             AND ae.event_type = 'email_click'
         )
       ORDER BY c.id
       LIMIT 10`,
      [tenantId]
    );

    const { rows: countRows } = await pool.query<{ total: string }>(
      `SELECT COUNT(*) AS total
       FROM contacts c
       WHERE COALESCE(c.stage, 'pre-aware') = 'pre-aware'
         AND c.tenant_id = $1
         AND EXISTS (
           SELECT 1
           FROM activity_events ae
           WHERE ae.contact_id = c.id
             AND ae.tenant_id  = c.tenant_id
             AND ae.event_type = 'email_click'
         )`,
      [tenantId]
    );

    const total = parseInt(countRows[0]?.total ?? "0", 10);

    const sample = rows.map(r => ({
      id: r.id,
      name: [r.first_name, r.last_name].filter(Boolean).join(" ") || null,
      email: r.email,
    }));

    logger.info({ tenantId, total }, "Admin backfill-aware-stage preview");
    res.json({ total, sample });
  } catch (err) { next(err); }
});

/**
 * POST /api/admin/backfill-aware-stage
 *
 * Advances contacts still at stage='pre-aware' that have at least one
 * email_click activity event to stage='aware'. Idempotent — safe to re-run.
 * Scoped to the caller's tenant. Admin role required.
 */
router.post("/admin/backfill-aware-stage", async (req, res, next): Promise<void> => {
  try {
    const user = (req as any).user as { tenantId?: number; role?: string } | undefined;
    if (!user?.tenantId) { res.status(401).json({ error: "Not authenticated" }); return; }
    if (user.role !== "admin") { res.status(403).json({ error: "Admin role required" }); return; }

    const tenantId = user.tenantId;

    const client = await pool.connect();
    try {
      const { rows: candidates } = await client.query<{ id: number; tenant_id: number }>(
        `SELECT c.id, c.tenant_id
         FROM contacts c
         WHERE COALESCE(c.stage, 'pre-aware') = 'pre-aware'
           AND c.tenant_id = $1
           AND EXISTS (
             SELECT 1
             FROM activity_events ae
             WHERE ae.contact_id = c.id
               AND ae.tenant_id  = c.tenant_id
               AND ae.event_type = 'email_click'
           )
         ORDER BY c.id`,
        [tenantId]
      );

      let advanced = 0;
      let skipped = 0;

      for (const contact of candidates) {
        // Atomic CTE: UPDATE and INSERT happen in one statement — the INSERT only
        // fires when the UPDATE RETURNING produces a row, so if this runs twice the
        // second pass yields 0 RETURNING rows and 0 history inserts (no duplicates).
        const { rowCount } = await client.query(
          `WITH advanced AS (
             UPDATE contacts
             SET stage = 'aware',
                 tags  = CASE
                           WHEN 'aware' = ANY(COALESCE(tags, '{}'))
                           THEN tags
                           ELSE array_append(COALESCE(tags, '{}'), 'aware')
                         END
             WHERE id        = $1
               AND tenant_id = $2
               AND COALESCE(stage, 'pre-aware') = 'pre-aware'
             RETURNING id, tenant_id, lead_score
           )
           INSERT INTO contact_stage_history
             (tenant_id, contact_id, from_stage, to_stage, score_at_transition, created_at)
           SELECT tenant_id, id, 'pre-aware', 'aware', lead_score, NOW()
           FROM advanced`,
          [contact.id, tenantId]
        );

        if ((rowCount ?? 0) > 0) {
          advanced++;
        } else {
          skipped++;
        }
      }

      logger.info({ tenantId, advanced, skipped }, "Admin backfill-aware-stage completed");
      res.json({ advanced, skipped });
    } finally {
      client.release();
    }
  } catch (err) { next(err); }
});

export default router;
