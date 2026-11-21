import { Router, type IRouter } from "express";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@workspace/db";
import { requireAuth } from "../middlewares/requireAuth";

const router: IRouter = Router();
router.use(requireAuth);

type AuthUser = { tenantId: number; id: number };

// Verify that all foreign-key references in a rule body belong to the given tenant.
// Returns an error message string if any reference is foreign, null if all pass.
async function verifyRuleRefs(
  d: { journeyId?: number; enrollSequenceId?: number; applyClientId?: number; applySegmentId?: number },
  tenantId: number,
): Promise<string | null> {
  if (d.journeyId) {
    const r = await db.execute(sql`SELECT 1 FROM journeys WHERE id = ${d.journeyId} AND tenant_id = ${tenantId} LIMIT 1`);
    if (!r.rows.length) return "journeyId not found in this tenant";
  }
  if (d.enrollSequenceId) {
    const r = await db.execute(sql`SELECT 1 FROM email_sequences WHERE id = ${d.enrollSequenceId} AND tenant_id = ${tenantId} LIMIT 1`);
    if (!r.rows.length) return "enrollSequenceId not found in this tenant";
  }
  if (d.applyClientId) {
    const r = await db.execute(sql`SELECT 1 FROM clients WHERE id = ${d.applyClientId} AND tenant_id = ${tenantId} LIMIT 1`);
    if (!r.rows.length) return "applyClientId not found in this tenant";
  }
  if (d.applySegmentId) {
    const r = await db.execute(sql`SELECT 1 FROM segments WHERE id = ${d.applySegmentId} AND tenant_id = ${tenantId} LIMIT 1`);
    if (!r.rows.length) return "applySegmentId not found in this tenant";
  }
  return null;
}

const RuleBody = z.object({
  name: z.string().default(""),
  conditionType: z.enum(["score_above","score_below","score_range","tag_added","tag_removed","intent_state_is"]),
  conditionValue: z.record(z.unknown()),
  journeyId: z.number().optional(),
  enrollSequenceId: z.number().optional(),
  applyTo: z.enum(["all","client","segment"]).default("all"),
  applyClientId: z.number().optional(),
  applySegmentId: z.number().optional(),
  ifAlreadyInJourney: z.enum(["skip","re_add"]).default("skip"),
  reenrollAfterCompletion: z.boolean().default(false),
  isActive: z.boolean().default(true),
});

// GET /api/journeys/:id/routing-rules — per-journey rules
router.get("/journeys/:id/routing-rules", async (req, res, next): Promise<void> => {
  const journeyId = parseInt(req.params.id);
  if (isNaN(journeyId)) { res.status(400).json({ error: "Invalid id" }); return; }
  try {
    const user = req.user as AuthUser;
    const rows = (await db.execute(sql`
      SELECT r.*, seq.name AS sequence_name
      FROM journey_routing_rules r
      LEFT JOIN email_sequences seq ON seq.id = r.enroll_sequence_id
      WHERE r.tenant_id = ${user.tenantId} AND r.journey_id = ${journeyId}
      ORDER BY r.created_at DESC
    `)).rows;
    res.json(rows);
  } catch (err) { next(err); }
});

// POST /api/journeys/:id/routing-rules — create rule for a journey
router.post("/journeys/:id/routing-rules", async (req, res, next): Promise<void> => {
  const journeyId = parseInt(req.params.id);
  if (isNaN(journeyId)) { res.status(400).json({ error: "Invalid id" }); return; }
  const parsed = RuleBody.safeParse({ ...req.body, journeyId });
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  try {
    const user = req.user as AuthUser;
    const d = parsed.data;
    const refErr = await verifyRuleRefs(
      { journeyId, enrollSequenceId: d.enrollSequenceId, applyClientId: d.applyClientId, applySegmentId: d.applySegmentId },
      user.tenantId,
    );
    if (refErr) { res.status(403).json({ error: refErr }); return; }
    const row = (await db.execute(sql`
      INSERT INTO journey_routing_rules
        (tenant_id, name, condition_type, condition_value, journey_id, enroll_sequence_id,
         apply_to, apply_client_id, apply_segment_id, if_already_in_journey, reenroll_after_completion, is_active)
      VALUES (${user.tenantId}, ${d.name}, ${d.conditionType}, ${JSON.stringify(d.conditionValue)}::jsonb,
              ${journeyId}, ${d.enrollSequenceId ?? null},
              ${d.applyTo}, ${d.applyClientId ?? null}, ${d.applySegmentId ?? null},
              ${d.ifAlreadyInJourney}, ${d.reenrollAfterCompletion}, ${d.isActive})
      RETURNING *
    `)).rows[0];
    res.status(201).json(row);
  } catch (err) { next(err); }
});

// GET /api/journey-routing-rules — global list
router.get("/journey-routing-rules", async (req, res, next): Promise<void> => {
  try {
    const user = req.user as AuthUser;
    const rows = (await db.execute(sql`
      SELECT r.*, j.name AS journey_name
      FROM journey_routing_rules r
      JOIN journeys j ON j.id = r.journey_id
      WHERE r.tenant_id = ${user.tenantId}
      ORDER BY r.created_at DESC
    `)).rows;
    res.json(rows);
  } catch (err) { next(err); }
});

// POST /api/journey-routing-rules — create global rule
router.post("/journey-routing-rules", async (req, res, next): Promise<void> => {
  const parsed = RuleBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  try {
    const user = req.user as AuthUser;
    const d = parsed.data;
    const refErr = await verifyRuleRefs(
      { journeyId: d.journeyId, enrollSequenceId: d.enrollSequenceId, applyClientId: d.applyClientId, applySegmentId: d.applySegmentId },
      user.tenantId,
    );
    if (refErr) { res.status(403).json({ error: refErr }); return; }
    const row = (await db.execute(sql`
      INSERT INTO journey_routing_rules
        (tenant_id, name, condition_type, condition_value, journey_id, enroll_sequence_id,
         apply_to, apply_client_id, apply_segment_id, if_already_in_journey, reenroll_after_completion, is_active)
      VALUES (${user.tenantId}, ${d.name}, ${d.conditionType}, ${JSON.stringify(d.conditionValue)}::jsonb,
              ${d.journeyId ?? null}, ${d.enrollSequenceId ?? null},
              ${d.applyTo}, ${d.applyClientId ?? null}, ${d.applySegmentId ?? null},
              ${d.ifAlreadyInJourney}, ${d.reenrollAfterCompletion}, ${d.isActive})
      RETURNING *
    `)).rows[0];
    res.status(201).json(row);
  } catch (err) { next(err); }
});

// PUT /api/journey-routing-rules/:id — full replacement
router.put("/journey-routing-rules/:id", async (req, res, next): Promise<void> => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const parsed = RuleBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  try {
    const user = req.user as AuthUser;
    const d = parsed.data;
    const refErr = await verifyRuleRefs(
      { journeyId: d.journeyId, enrollSequenceId: d.enrollSequenceId, applyClientId: d.applyClientId, applySegmentId: d.applySegmentId },
      user.tenantId,
    );
    if (refErr) { res.status(403).json({ error: refErr }); return; }
    const row = (await db.execute(sql`
      UPDATE journey_routing_rules SET
        name                      = ${d.name},
        condition_type            = ${d.conditionType},
        condition_value           = ${JSON.stringify(d.conditionValue)}::jsonb,
        journey_id                = ${d.journeyId ?? null},
        enroll_sequence_id        = ${d.enrollSequenceId ?? null},
        apply_to                  = ${d.applyTo},
        apply_client_id           = ${d.applyClientId ?? null},
        apply_segment_id          = ${d.applySegmentId ?? null},
        if_already_in_journey     = ${d.ifAlreadyInJourney},
        reenroll_after_completion = ${d.reenrollAfterCompletion},
        is_active                 = ${d.isActive}
      WHERE id = ${id} AND tenant_id = ${user.tenantId}
      RETURNING *
    `)).rows[0];
    if (!row) { res.status(404).json({ error: "Not found" }); return; }
    res.json(row);
  } catch (err) { next(err); }
});

// PATCH /api/journey-routing-rules/:id — set is_active explicitly
router.patch("/journey-routing-rules/:id", async (req, res, next): Promise<void> => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  try {
    const user = req.user as AuthUser;
    const { isActive } = req.body as { isActive: boolean };
    if (typeof isActive !== "boolean") { res.status(400).json({ error: "isActive must be boolean" }); return; }
    const row = (await db.execute(sql`
      UPDATE journey_routing_rules SET is_active = ${isActive}
      WHERE id = ${id} AND tenant_id = ${user.tenantId}
      RETURNING *
    `)).rows[0];
    if (!row) { res.status(404).json({ error: "Not found" }); return; }
    res.json(row);
  } catch (err) { next(err); }
});

// PATCH /api/journey-routing-rules/:id/toggle
router.patch("/journey-routing-rules/:id/toggle", async (req, res, next): Promise<void> => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  try {
    const user = req.user as AuthUser;
    const row = (await db.execute(sql`
      UPDATE journey_routing_rules SET is_active = NOT is_active
      WHERE id = ${id} AND tenant_id = ${user.tenantId}
      RETURNING *
    `)).rows[0];
    if (!row) { res.status(404).json({ error: "Not found" }); return; }
    res.json(row);
  } catch (err) { next(err); }
});

// DELETE /api/journey-routing-rules/:id
router.delete("/journey-routing-rules/:id", async (req, res, next): Promise<void> => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  try {
    const user = req.user as AuthUser;
    await db.execute(sql`DELETE FROM journey_routing_rules WHERE id = ${id} AND tenant_id = ${user.tenantId}`);
    res.sendStatus(204);
  } catch (err) { next(err); }
});

export default router;
