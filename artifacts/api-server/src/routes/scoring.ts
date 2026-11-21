import { Router, type IRouter } from "express";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db, scoringRulesTable, scoreThresholdsTable } from "@workspace/db";
import { requireAuth } from "../middlewares/requireAuth";
import { computeIntentScore, SCORE_SOURCES } from "../lib/intentScoring";
import { logger } from "../lib/logger";
import {
  CreateScoringRuleBody,
  UpdateScoringRuleBody,
  UpdateScoringRuleParams,
  DeleteScoringRuleParams,
} from "@workspace/api-zod";

const router: IRouter = Router();
router.use(requireAuth);

// ── Formula version tracker ───────────────────────────────────────────────────
// scoring_rules has no tenant_id — rules are global and affect all tenants.
// We therefore track a single global change timestamp using tenant_id = 0 as a
// sentinel (no real tenant ever has id=0).  The GET /api/scoring/stale-status
// endpoint compares this global timestamp against each requesting tenant's own
// last recompute run_at, so every tenant sees the banner after any rule change.
const GLOBAL_VERSION_TENANT_ID = 0;

async function touchFormulaVersion(): Promise<void> {
  await db.execute(sql`
    INSERT INTO scoring_formula_versions (tenant_id, rules_changed_at)
    VALUES (${GLOBAL_VERSION_TENANT_ID}, NOW())
    ON CONFLICT (tenant_id) DO UPDATE
      SET rules_changed_at = NOW()
  `);
}

router.get("/scoring-rules", async (req, res, next): Promise<void> => {
  try {
    const rules = await db.select().from(scoringRulesTable);
    res.json(rules.map(r => ({ ...r, isActive: r.isActive === "true" })));
  } catch (err) { next(err); }
});

router.post("/scoring-rules", async (req, res, next): Promise<void> => {
  const parsed = CreateScoringRuleBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  try {
    const user = req.user as any;
    const [rule] = await db.insert(scoringRulesTable).values({
      ...parsed.data,
      isActive: parsed.data.isActive !== false ? "true" : "false",
    }).returning();
    await touchFormulaVersion();
    res.status(201).json({ ...rule, isActive: rule.isActive === "true" });
  } catch (err) { next(err); }
});

router.patch("/scoring-rules/:id", async (req, res, next): Promise<void> => {
  const params = UpdateScoringRuleParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const parsed = UpdateScoringRuleBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  try {
    const user = req.user as any;
    const updateData: any = { ...parsed.data };
    if (typeof parsed.data.isActive === "boolean") {
      updateData.isActive = parsed.data.isActive ? "true" : "false";
    }
    const [rule] = await db.update(scoringRulesTable).set(updateData).where(eq(scoringRulesTable.id, params.data.id)).returning();
    if (!rule) { res.status(404).json({ error: "Rule not found" }); return; }
    await touchFormulaVersion();
    res.json({ ...rule, isActive: rule.isActive === "true" });
  } catch (err) { next(err); }
});

router.delete("/scoring-rules/:id", async (req, res, next): Promise<void> => {
  const params = DeleteScoringRuleParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  try {
    const user = req.user as any;
    await db.delete(scoringRulesTable).where(eq(scoringRulesTable.id, params.data.id));
    await touchFormulaVersion();
    res.sendStatus(204);
  } catch (err) { next(err); }
});

// ── Stale-score status ────────────────────────────────────────────────────────
// GET /api/scoring/stale-status
// Returns whether any contact scores may be stale because scoring rules were
// changed after the last bulk recompute.
// isStale is true when:
//   - rules_changed_at exists AND there has never been a recompute, OR
//   - rules_changed_at > the latest recompute run_at (rule change happened after last run)
router.get("/scoring/stale-status", async (req, res, next): Promise<void> => {
  try {
    const user = req.user as any;
    const { tenantId } = user;

    // scoring_rules is global — use the global sentinel row (tenant_id=0) so
    // a rule change made by any admin is visible to every tenant.
    // Only a fully successful recompute (errors = 0) clears the stale signal;
    // a run that failed for some contacts leaves scores stale for those contacts.
    const result = await db.execute(sql`
      SELECT
        fv.rules_changed_at,
        (
          SELECT run_at FROM score_recompute_log
          WHERE tenant_id = ${tenantId}
            AND errors     = 0
          ORDER BY id DESC
          LIMIT 1
        ) AS last_recompute_at
      FROM scoring_formula_versions fv
      WHERE fv.tenant_id = ${GLOBAL_VERSION_TENANT_ID}
    `);

    const row = (result.rows as any[])[0];

    if (!row) {
      // No rule changes ever recorded — scores cannot be stale from a rule edit
      res.json({ isStale: false, rulesChangedAt: null, lastRecomputeAt: null });
      return;
    }

    const rulesChangedAt = row.rules_changed_at as string | null;
    const lastRecomputeAt = row.last_recompute_at as string | null;

    const isStale =
      rulesChangedAt !== null &&
      (lastRecomputeAt === null ||
        new Date(rulesChangedAt) > new Date(lastRecomputeAt));

    res.json({ isStale, rulesChangedAt, lastRecomputeAt });
  } catch (err) { next(err); }
});

// ── Score Thresholds ─────────────────────────────────────────────────────────

const ThresholdBody = z.object({
  label: z.string().min(1),
  minScore: z.number().int().min(0).max(500),
  color: z.string().min(1),
});

router.get("/score-thresholds", async (req, res, next): Promise<void> => {
  try {
    const user = req.user as any;
    const rows = await db
      .select()
      .from(scoreThresholdsTable)
      .where(eq(scoreThresholdsTable.tenantId, user.tenantId));
    res.json(rows);
  } catch (err) { next(err); }
});

router.post("/score-thresholds", async (req, res, next): Promise<void> => {
  const parsed = ThresholdBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  try {
    const user = req.user as any;
    const [row] = await db
      .insert(scoreThresholdsTable)
      .values({ ...parsed.data, tenantId: user.tenantId })
      .returning();
    res.status(201).json(row);
  } catch (err) { next(err); }
});

router.patch("/score-thresholds/:id", async (req, res, next): Promise<void> => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const parsed = ThresholdBody.partial().safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  try {
    const user = req.user as any;
    const [row] = await db
      .update(scoreThresholdsTable)
      .set(parsed.data)
      .where(and(eq(scoreThresholdsTable.id, id), eq(scoreThresholdsTable.tenantId, user.tenantId)))
      .returning();
    if (!row) { res.status(404).json({ error: "Threshold not found" }); return; }
    res.json(row);
  } catch (err) { next(err); }
});

router.delete("/score-thresholds/:id", async (req, res, next): Promise<void> => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  try {
    const user = req.user as any;
    await db
      .delete(scoreThresholdsTable)
      .where(and(eq(scoreThresholdsTable.id, id), eq(scoreThresholdsTable.tenantId, user.tenantId)));
    res.sendStatus(204);
  } catch (err) { next(err); }
});

// ── Stage Configs ─────────────────────────────────────────────────────────────

const StageConfigBody = z.object({
  label: z.string().min(1).max(50),
  color: z.string().min(1),
  minScore: z.number().int().min(0).max(500),
  description: z.string().optional(),
});

router.get("/stages", async (req, res, next): Promise<void> => {
  try {
    const user = req.user as any;
    const result = await db.execute(sql`
      SELECT id, slug, label, color, min_score AS "minScore", description, display_order AS "displayOrder"
      FROM stage_configs WHERE tenant_id = ${user.tenantId} ORDER BY display_order
    `);
    res.json(result.rows as any[]);
  } catch (err) { next(err); }
});

router.patch("/stages/:id", async (req, res, next): Promise<void> => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const parsed = StageConfigBody.partial().safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  try {
    const user = req.user as any;
    const { label, color, minScore, description } = parsed.data;
    const result = await db.execute(sql`
      UPDATE stage_configs SET
        label       = COALESCE(${label ?? null}, label),
        color       = COALESCE(${color ?? null}, color),
        min_score   = COALESCE(${minScore ?? null}, min_score),
        description = COALESCE(${description ?? null}, description)
      WHERE id = ${id} AND tenant_id = ${user.tenantId}
      RETURNING id, slug, label, color, min_score AS "minScore", description, display_order AS "displayOrder"
    `);
    const row = (result.rows as any[])[0];
    if (!row) { res.status(404).json({ error: "Stage not found" }); return; }
    res.json(row);
  } catch (err) { next(err); }
});

// ── Batch Recompute Intent Scores ────────────────────────────────────────────
// POST /api/scoring/recompute — admin only; backfills all contacts for the tenant.
router.post("/scoring/recompute", async (req, res, next): Promise<void> => {
  try {
    const user = req.user as any;
    if (user.role !== "admin") {
      res.status(403).json({ error: "Admin access required" }); return;
    }
    const { tenantId } = user;

    // Snapshot scores + names before recompute so we can diff afterwards.
    const beforeRows = (await db.execute(sql`
      SELECT id,
             COALESCE(NULLIF(TRIM(CONCAT(first_name, ' ', last_name)), ''), email) AS name,
             email,
             COALESCE(intent_score, 0) AS score
      FROM contacts
      WHERE tenant_id = ${tenantId}
      ORDER BY id
    `)).rows as Array<{ id: number; name: string; email: string; score: number }>;

    const beforeMap = new Map(beforeRows.map(r => [r.id, { name: r.name, email: r.email, score: Number(r.score) }]));

    // NOTE: We intentionally do NOT rebuild activity_events.score_delta from
    // scoring_rules here. Page-view events store an authoritative page-specific
    // score_delta (sourced from journey_pages.score at ingestion time, including
    // explicit zeros). There is no page_id column on activity_events to
    // distinguish page-override rows from global-rule rows, so a bulk overwrite
    // would corrupt those authoritative values.
    //
    // What recompute DOES refresh: all formula-level bonuses (stage progression,
    // email engagement, velocity, account ABM) that are computed fresh from
    // historical event timestamps and contact state — not from score_delta sums.
    let updated = 0;
    let errors = 0;

    for (const row of beforeRows) {
      try {
        // Pass source:ADMIN_RECOMPUTE so routing rules are suppressed.
        // A full bulk recompute is a retroactive correction (it reprocesses
        // historical activity events), not a live behaviour signal. Firing
        // routing rules on every state change during a recompute could enroll
        // contacts in journeys or sequences they are not ready for, or reset
        // added_at timestamps for contacts already mid-sequence.
        await computeIntentScore(row.id, tenantId, { source: SCORE_SOURCES.ADMIN_RECOMPUTE });
        updated++;
      } catch (err) {
        errors++;
        logger.warn({ err, contactId: row.id, tenantId }, "computeIntentScore failed during recompute");
      }
    }

    // Fetch new scores after recompute to build the change log.
    const afterRows = (await db.execute(sql`
      SELECT id, COALESCE(intent_score, 0) AS score
      FROM contacts
      WHERE tenant_id = ${tenantId}
    `)).rows as Array<{ id: number; score: number }>;

    const changes: Array<{
      id: number; name: string; email: string;
      oldScore: number; newScore: number; delta: number;
    }> = [];

    for (const after of afterRows) {
      const before = beforeMap.get(after.id);
      if (!before) continue;
      const oldScore = before.score;
      const newScore = Number(after.score);
      if (newScore !== oldScore) {
        changes.push({ id: after.id, name: before.name, email: before.email, oldScore, newScore, delta: newScore - oldScore });
      }
    }

    // Sort by absolute delta descending — biggest movers first.
    changes.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

    const timestamp = new Date().toISOString();

    // Append this run to the history log (one row per run, not upsert).
    const insertResult = await db.execute(sql`
      INSERT INTO score_recompute_log (tenant_id, run_at, total, updated, errors, changes)
      VALUES (
        ${tenantId},
        ${timestamp}::timestamptz,
        ${beforeRows.length},
        ${updated},
        ${errors},
        ${JSON.stringify(changes)}::jsonb
      )
      RETURNING id
    `);
    const insertedId = Number((insertResult.rows[0] as any)?.id ?? 0);

    res.json({
      id: insertedId,
      updated,
      errors,
      total: beforeRows.length,
      timestamp,
      changes,
    });
  } catch (err) { next(err); }
});

// POST /api/scoring/cleanup-bot-events — admin only.
// Deletes activity_events that were almost certainly written by Safe Links / corporate
// email scanners rather than real humans:
//   • email_click events that arrived within 5 minutes of the preceding email_sent
//     (the scanner fires < 2 min after delivery; real humans click minutes-to-hours later)
//   • page_view / scroll_depth / email_open events for the same contact that landed
//     within 30 seconds of one of those bot clicks (the scanner follows the redirect
//     and the journey JS fires tracking — those events are also fake)
// After deletion, recomputes intent_score for every affected contact and adjusts
// lead_score by subtracting the score_delta of deleted events.
router.post("/scoring/cleanup-bot-events", async (req, res, next): Promise<void> => {
  try {
    const user = req.user as any;
    if (user.role !== "admin") { res.status(403).json({ error: "Admin access required" }); return; }
    const { tenantId } = user;
    const { pool } = await import("@workspace/db");

    // Step 1: find and delete email_click activity_events fired within 5 min of email_sent
    const { rows: botClicks } = await pool.query<{ id: number; contact_id: number; score_delta: number; created_at: Date }>(
      `DELETE FROM activity_events
       WHERE tenant_id = $1
         AND event_type = 'email_click'
         AND id IN (
           SELECT cl.id
           FROM activity_events cl
           JOIN LATERAL (
             SELECT created_at FROM activity_events
             WHERE contact_id = cl.contact_id
               AND tenant_id  = $1
               AND event_type = 'email_sent'
               AND created_at <= cl.created_at
             ORDER BY created_at DESC
             LIMIT 1
           ) se ON true
           WHERE cl.tenant_id = $1
             AND EXTRACT(EPOCH FROM (cl.created_at - se.created_at)) < 300
         )
       RETURNING id, contact_id, COALESCE(score_delta, 0) AS score_delta, created_at`,
      [tenantId]
    );

    const botClickIds   = botClicks.map(r => r.id);
    const botClickTimes = botClicks.map(r => ({ contactId: r.contact_id, at: new Date(r.created_at) }));
    const affectedContactIds = [...new Set(botClicks.map(r => r.contact_id))];

    // Step 2: delete page_view / scroll_depth / email_open that arrived within 30 s
    // of a bot click for the same contact (the scanner loaded the journey page)
    let followOnDeleted = 0;
    if (botClickTimes.length > 0) {
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
                 FROM (VALUES ${botClickTimes.map((_, i) => `($${i * 2 + 2}::int, $${i * 2 + 3}::timestamptz)`).join(",")}) AS bc(cid, clicked_at)
                 WHERE bc.cid = ae.contact_id
                   AND ae.created_at BETWEEN bc.clicked_at AND bc.clicked_at + INTERVAL '30 seconds'
               )
           )`,
        [tenantId, ...botClickTimes.flatMap(b => [b.contactId, b.at.toISOString()])]
      );
      followOnDeleted = rowCount ?? 0;
    }

    // Step 3: subtract deleted score_delta from lead_score for affected contacts
    const scoreLoss = new Map<number, number>();
    for (const r of botClicks) scoreLoss.set(r.contact_id, (scoreLoss.get(r.contact_id) ?? 0) + Number(r.score_delta));
    for (const [cid, loss] of scoreLoss.entries()) {
      if (loss !== 0) {
        await pool.query(
          `UPDATE contacts SET lead_score = GREATEST(0, COALESCE(lead_score, 0) - $1) WHERE id = $2 AND tenant_id = $3`,
          [loss, cid, tenantId]
        ).catch(() => {});
      }
    }

    // Step 4: recompute intent_score for every affected contact
    let recomputed = 0;
    for (const cid of affectedContactIds) {
      try {
        await computeIntentScore(cid, tenantId, { source: SCORE_SOURCES.ADMIN_RECOMPUTE });
        recomputed++;
      } catch (err) {
        logger.warn({ err, contactId: cid }, "cleanup-bot-events: recompute failed");
      }
    }

    logger.info({ tenantId, botClicksDeleted: botClickIds.length, followOnDeleted, recomputed }, "cleanup-bot-events complete");
    res.json({
      botClicksDeleted: botClickIds.length,
      followOnEventsDeleted: followOnDeleted,
      contactsRecomputed: recomputed,
    });
  } catch (err) { next(err); }
});

// ── Score Integrity Audit ─────────────────────────────────────────────────────
// GET /api/scoring/score-integrity
// Returns contacts where intent_score > 0 but SUM(score_delta) = 0,
// split into two buckets:
//   "data_gap"     — has email_open/email_click events with delta=0/NULL (need backfill)
//   "formula_only" — score is driven entirely by formula bonuses, no email events at all
router.get("/scoring/score-integrity", async (req, res, next): Promise<void> => {
  try {
    const user = req.user as any;
    if (user.role !== "admin") { res.status(403).json({ error: "Admin access required" }); return; }
    const { tenantId } = user;

    const { rows } = await (await import("@workspace/db")).pool.query<{
      id: number;
      name: string;
      email: string;
      intent_score: number;
      delta_sum: number;
      missing_delta_count: number;
      estimated_missing_delta: number;
    }>(
      `SELECT
         c.id,
         COALESCE(NULLIF(TRIM(CONCAT(c.first_name, ' ', c.last_name)), ''), c.email) AS name,
         c.email,
         COALESCE(c.intent_score, 0)                                                      AS intent_score,
         COALESCE(SUM(ae.score_delta), 0)::int                                            AS delta_sum,
         COUNT(ae.id) FILTER (
           WHERE ae.event_type IN ('email_open', 'email_click')
             AND (ae.score_delta IS NULL OR ae.score_delta = 0)
         )::int                                                                            AS missing_delta_count,
         (
           COALESCE(SUM(CASE WHEN ae.event_type = 'email_click'
                              AND (ae.score_delta IS NULL OR ae.score_delta = 0)
                         THEN 15 ELSE 0 END), 0)
           + COALESCE(SUM(CASE WHEN ae.event_type = 'email_open'
                               AND (ae.score_delta IS NULL OR ae.score_delta = 0)
                          THEN 5 ELSE 0 END), 0)
         )::int                                                                            AS estimated_missing_delta
       FROM contacts c
       LEFT JOIN activity_events ae
         ON ae.contact_id = c.id AND ae.tenant_id = c.tenant_id
       WHERE c.tenant_id     = $1
         AND c.is_anonymous IS NOT TRUE
         AND COALESCE(c.intent_score, 0) > 0
       GROUP BY c.id, c.first_name, c.last_name, c.email, c.intent_score
       HAVING COALESCE(SUM(ae.score_delta), 0) = 0
       ORDER BY c.intent_score DESC`,
      [tenantId],
    );

    const dataGap: typeof rows     = [];
    const formulaOnly: typeof rows  = [];
    for (const r of rows) {
      if (Number(r.missing_delta_count) > 0) dataGap.push(r);
      else formulaOnly.push(r);
    }

    res.json({
      dataGapCount:    dataGap.length,
      formulaOnlyCount: formulaOnly.length,
      totalCount:       rows.length,
      dataGap:    dataGap.map(r => ({
        id:                    r.id,
        name:                  r.name,
        email:                 r.email,
        intentScore:           Number(r.intent_score),
        missingDeltaCount:     Number(r.missing_delta_count),
        estimatedMissingDelta: Number(r.estimated_missing_delta),
      })),
      formulaOnly: formulaOnly.map(r => ({
        id:          r.id,
        name:        r.name,
        email:       r.email,
        intentScore: Number(r.intent_score),
      })),
    });
  } catch (err) { next(err); }
});

// POST /api/scoring/score-integrity/backfill
// Sets score_delta = 5 on email_open and score_delta = 15 on email_click events
// where the value is currently 0 or NULL, then recomputes affected contacts.
router.post("/scoring/score-integrity/backfill", async (req, res, next): Promise<void> => {
  try {
    const user = req.user as any;
    if (user.role !== "admin") { res.status(403).json({ error: "Admin access required" }); return; }
    const { tenantId } = user;

    const { pool: pg } = await import("@workspace/db");

    const { rows: updated } = await pg.query<{ contact_id: number; id: number }>(
      `UPDATE activity_events
       SET score_delta = CASE event_type
                           WHEN 'email_open'  THEN 5
                           WHEN 'email_click' THEN 15
                         END
       WHERE tenant_id  = $1
         AND event_type IN ('email_open', 'email_click')
         AND (score_delta IS NULL OR score_delta = 0)
       RETURNING id, contact_id`,
      [tenantId],
    );

    const eventsPatched    = updated.length;
    const affectedContacts = [...new Set(updated.map(r => r.contact_id))];

    let recomputed = 0;
    let errors     = 0;
    for (const cid of affectedContacts) {
      try {
        await computeIntentScore(cid, tenantId, { source: SCORE_SOURCES.ADMIN_RECOMPUTE });
        recomputed++;
      } catch (err) {
        errors++;
        logger.warn({ err, contactId: cid, tenantId }, "score-integrity backfill: recompute failed");
      }
    }

    logger.info({ tenantId, eventsPatched, recomputed, errors }, "score-integrity backfill complete");
    res.json({ eventsPatched, contactsRecomputed: recomputed, errors });
  } catch (err) { next(err); }
});

// GET /api/scoring/contact-score-history/:contactId
// Returns the last 10 score_history entries for a single contact.
router.get("/scoring/contact-score-history/:contactId", async (req, res, next): Promise<void> => {
  try {
    const user = req.user as any;
    const contactId = parseInt(req.params.contactId, 10);
    if (isNaN(contactId)) { res.status(400).json({ error: "Invalid contactId" }); return; }

    const result = await db.execute(sql`
      SELECT
        id,
        contact_id  AS "contactId",
        old_score   AS "oldScore",
        new_score   AS "newScore",
        delta,
        source,
        created_at  AS "createdAt"
      FROM score_history
      WHERE tenant_id  = ${user.tenantId}
        AND contact_id = ${contactId}
      ORDER BY created_at DESC
      LIMIT 10
    `);
    const rows = (result.rows as any[]).map(r => ({
      id:        Number(r.id),
      contactId: Number(r.contactId),
      oldScore:  Number(r.oldScore),
      newScore:  Number(r.newScore),
      delta:     Number(r.delta),
      source:    r.source ?? null,
      createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : r.createdAt,
    }));
    res.json(rows);
  } catch (err) { next(err); }
});

// POST /api/scoring/score-deltas
// Accepts { contactIds: number[] }, returns the most-recent score_history entry
// per contact, keyed by contactId.  Used by the CRM contact list to render
// delta badges without N separate requests.
router.post("/scoring/score-deltas", async (req, res, next): Promise<void> => {
  try {
    const user = req.user as any;
    const raw = req.body?.contactIds;
    if (!Array.isArray(raw) || raw.length === 0) { res.json({}); return; }

    const ids = (raw as unknown[]).map(Number).filter(n => !isNaN(n));
    if (ids.length === 0) { res.json({}); return; }

    // DISTINCT ON (contact_id) picks the most-recent row per contact because
    // we order by contact_id ASC, created_at DESC.
    const result = await db.execute(sql`
      SELECT DISTINCT ON (contact_id)
        contact_id  AS "contactId",
        old_score   AS "oldScore",
        new_score   AS "newScore",
        delta,
        source,
        created_at  AS "createdAt"
      FROM score_history
      WHERE tenant_id  = ${user.tenantId}
        AND contact_id IN (${sql.join(ids.map(id => sql`${id}`), sql`, `)})
      ORDER BY contact_id, created_at DESC
    `);

    const map: Record<number, {
      contactId: number; oldScore: number; newScore: number;
      delta: number; source: string | null; createdAt: string;
    }> = {};
    for (const r of result.rows as any[]) {
      const cid = Number(r.contactId);
      map[cid] = {
        contactId: cid,
        oldScore:  Number(r.oldScore),
        newScore:  Number(r.newScore),
        delta:     Number(r.delta),
        source:    r.source ?? null,
        createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : r.createdAt,
      };
    }
    res.json(map);
  } catch (err) { next(err); }
});

// GET /api/scoring/recompute-log — fetch the last 10 recompute runs for the tenant
router.get("/scoring/recompute-log", async (req, res, next): Promise<void> => {
  try {
    const user = req.user as any;
    const result = await db.execute(sql`
      SELECT id, run_at AS timestamp, total, updated, errors, changes
      FROM score_recompute_log
      WHERE tenant_id = ${user.tenantId}
      ORDER BY id DESC
      LIMIT 10
    `);
    const rows = result.rows as any[];
    res.json(rows.map(row => ({
      id: Number(row.id),
      timestamp: row.timestamp instanceof Date ? row.timestamp.toISOString() : row.timestamp,
      total: Number(row.total),
      updated: Number(row.updated),
      errors: Number(row.errors),
      changes: row.changes ?? [],
    })));
  } catch (err) { next(err); }
});

export default router;
