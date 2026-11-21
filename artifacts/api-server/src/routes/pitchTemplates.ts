import { Router, type IRouter } from "express";
import { z } from "zod";
import { pool } from "@workspace/db";
import { requireAuth } from "../middlewares/requireAuth";

const router: IRouter = Router();
router.use(requireAuth);

const TemplateBody = z.object({
  name:                          z.string().min(1),
  productKey:                    z.string().min(1),
  productName:                   z.string().optional().nullable(),
  campaignFirstMessage:          z.string().optional().nullable(),
  campaignFirstMessageHindi:     z.string().optional().nullable(),
  languageMode:                  z.enum(["auto", "englishOnly", "hindiOnly"]).optional().nullable(),
  notAPitchDisclaimer:           z.string().optional().nullable(),
  notAPitchDisclaimerHindi:      z.string().optional().nullable(),
  hookContext:                   z.string().optional().nullable(),
  hookContextHindi:              z.string().optional().nullable(),
  needDiscoveryQuestion:         z.string().optional().nullable(),
  needDiscoveryQuestionHindi:    z.string().optional().nullable(),
  bridgeStatement:               z.string().optional().nullable(),
  bridgeStatementHindi:          z.string().optional().nullable(),
  offerName:                     z.string().optional().nullable(),
  offerNameHindi:                z.string().optional().nullable(),
  offerDuration:                 z.string().optional().nullable(),
  offerWhatTheyGet:              z.string().optional().nullable(),
  offerFreeStatement:            z.string().optional().nullable(),
  valueBullets:                  z.string().optional().nullable(),
  cta:                           z.string().optional().nullable(),
});

// ── GET /pitch-templates ───────────────────────────────────────────────────────
router.get("/pitch-templates", async (req, res, next): Promise<void> => {
  try {
    const user = req.user as any;
    const rows = await pool.query(
      `SELECT * FROM pitch_templates WHERE tenant_id = $1 ORDER BY name ASC`,
      [user.tenantId]
    );
    res.json(rows.rows);
  } catch (err) { next(err); }
});

// ── POST /pitch-templates ──────────────────────────────────────────────────────
router.post("/pitch-templates", async (req, res, next): Promise<void> => {
  try {
    const user = req.user as any;
    const parsed = TemplateBody.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
    const d = parsed.data;

    const result = await pool.query<{ id: number }>(
      `INSERT INTO pitch_templates (
        tenant_id, name, product_key, product_name,
        campaign_first_message, campaign_first_message_hindi,
        language_mode,
        not_a_pitch_disclaimer, not_a_pitch_disclaimer_hindi,
        hook_context, hook_context_hindi,
        need_discovery_question, need_discovery_question_hindi,
        bridge_statement, bridge_statement_hindi,
        offer_name, offer_name_hindi, offer_duration,
        offer_what_they_get, offer_free_statement, value_bullets, cta,
        created_at, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,NOW(),NOW())
      RETURNING id`,
      [
        user.tenantId, d.name, d.productKey, d.productName ?? null,
        d.campaignFirstMessage ?? null, d.campaignFirstMessageHindi ?? null,
        d.languageMode ?? "auto",
        d.notAPitchDisclaimer ?? null, d.notAPitchDisclaimerHindi ?? null,
        d.hookContext ?? null, d.hookContextHindi ?? null,
        d.needDiscoveryQuestion ?? null, d.needDiscoveryQuestionHindi ?? null,
        d.bridgeStatement ?? null, d.bridgeStatementHindi ?? null,
        d.offerName ?? null, d.offerNameHindi ?? null,
        d.offerDuration ?? "15–20 minutes",
        d.offerWhatTheyGet ?? null, d.offerFreeStatement ?? null,
        d.valueBullets ?? null, d.cta ?? null,
      ]
    );
    const row = await pool.query(`SELECT * FROM pitch_templates WHERE id = $1`, [result.rows[0].id]);
    res.status(201).json(row.rows[0]);
  } catch (err) { next(err); }
});

// ── GET /pitch-templates/:id ───────────────────────────────────────────────────
router.get("/pitch-templates/:id", async (req, res, next): Promise<void> => {
  try {
    const user = req.user as any;
    const id = parseInt(req.params.id);
    if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
    const row = await pool.query(
      `SELECT * FROM pitch_templates WHERE id = $1 AND tenant_id = $2`,
      [id, user.tenantId]
    );
    if (!row.rows[0]) { res.status(404).json({ error: "Not found" }); return; }
    res.json(row.rows[0]);
  } catch (err) { next(err); }
});

// ── PATCH /pitch-templates/:id ─────────────────────────────────────────────────
router.patch("/pitch-templates/:id", async (req, res, next): Promise<void> => {
  try {
    const user = req.user as any;
    const id = parseInt(req.params.id);
    if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
    const parsed = TemplateBody.partial().safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
    const d = parsed.data;

    const existing = await pool.query(
      `SELECT id FROM pitch_templates WHERE id=$1 AND tenant_id=$2`,
      [id, user.tenantId]
    );
    if (!existing.rows[0]) { res.status(404).json({ error: "Not found" }); return; }

    await pool.query(
      `UPDATE pitch_templates SET
        name                         = COALESCE($2,  name),
        product_key                  = COALESCE($3,  product_key),
        product_name                 = COALESCE($4,  product_name),
        campaign_first_message       = COALESCE($5,  campaign_first_message),
        campaign_first_message_hindi = COALESCE($6,  campaign_first_message_hindi),
        language_mode                = COALESCE($7,  language_mode),
        not_a_pitch_disclaimer       = COALESCE($8,  not_a_pitch_disclaimer),
        not_a_pitch_disclaimer_hindi = COALESCE($9,  not_a_pitch_disclaimer_hindi),
        hook_context                 = COALESCE($10, hook_context),
        hook_context_hindi           = COALESCE($11, hook_context_hindi),
        need_discovery_question      = COALESCE($12, need_discovery_question),
        need_discovery_question_hindi= COALESCE($13, need_discovery_question_hindi),
        bridge_statement             = COALESCE($14, bridge_statement),
        bridge_statement_hindi       = COALESCE($15, bridge_statement_hindi),
        offer_name                   = COALESCE($16, offer_name),
        offer_name_hindi             = COALESCE($17, offer_name_hindi),
        offer_duration               = COALESCE($18, offer_duration),
        offer_what_they_get          = COALESCE($19, offer_what_they_get),
        offer_free_statement         = COALESCE($20, offer_free_statement),
        value_bullets                = COALESCE($21, value_bullets),
        cta                          = COALESCE($22, cta),
        updated_at = NOW()
       WHERE id = $1`,
      [
        id,
        d.name ?? null, d.productKey ?? null, d.productName ?? null,
        d.campaignFirstMessage ?? null, d.campaignFirstMessageHindi ?? null,
        d.languageMode ?? null,
        d.notAPitchDisclaimer ?? null, d.notAPitchDisclaimerHindi ?? null,
        d.hookContext ?? null, d.hookContextHindi ?? null,
        d.needDiscoveryQuestion ?? null, d.needDiscoveryQuestionHindi ?? null,
        d.bridgeStatement ?? null, d.bridgeStatementHindi ?? null,
        d.offerName ?? null, d.offerNameHindi ?? null,
        d.offerDuration ?? null,
        d.offerWhatTheyGet ?? null, d.offerFreeStatement ?? null,
        d.valueBullets ?? null, d.cta ?? null,
      ]
    );
    const updated = await pool.query(`SELECT * FROM pitch_templates WHERE id=$1`, [id]);
    res.json(updated.rows[0]);
  } catch (err) { next(err); }
});

// ── DELETE /pitch-templates/:id ────────────────────────────────────────────────
router.delete("/pitch-templates/:id", async (req, res, next): Promise<void> => {
  try {
    const user = req.user as any;
    const id = parseInt(req.params.id);
    if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
    const existing = await pool.query(
      `SELECT id FROM pitch_templates WHERE id=$1 AND tenant_id=$2`,
      [id, user.tenantId]
    );
    if (!existing.rows[0]) { res.status(404).json({ error: "Not found" }); return; }
    await pool.query(`DELETE FROM pitch_templates WHERE id=$1`, [id]);
    res.sendStatus(204);
  } catch (err) { next(err); }
});

export default router;
