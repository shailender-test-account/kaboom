import { Router, type IRouter } from "express";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@workspace/db";
import { requireAuth } from "../middlewares/requireAuth";

const router: IRouter = Router();
router.use(requireAuth);

const CtaActionConfigSchema = z.object({
  url: z.string().optional(),
  openInNewTab: z.boolean().optional(),
  assetId: z.number().int().optional(),
  formId: z.number().int().optional(),
  deliveryAssetId: z.number().int().nullable().optional(),
  pageOrder: z.number().int().optional(),
  pageLabel: z.string().optional(),
}).passthrough();

const CtaStyleConfigSchema = z.object({
  fontFamily: z.string().optional(),
  fontSize: z.number().optional(),
  fontWeight: z.string().optional(),
  bgColor: z.string().optional(),
  textColor: z.string().optional(),
  borderColor: z.string().optional(),
  noBorder: z.boolean().optional(),
  sizePreset: z.enum(["small", "medium", "large", "full"]).optional(),
  borderRadius: z.enum(["sharp", "slightly_rounded", "pill"]).optional(),
  icon: z.string().optional(),
  iconPosition: z.enum(["left", "right"]).optional(),
}).passthrough();

const CtaButtonBody = z.object({
  name: z.string().min(1),
  label: z.string().min(1),
  actionType: z.enum(["url", "download", "gated_form", "jump_page", "just_submit"]),
  actionConfig: CtaActionConfigSchema.default({}),
  styleConfig: CtaStyleConfigSchema.default({}),
});

router.get("/cta-buttons", async (req, res, next): Promise<void> => {
  try {
    const user = req.user as any;
    const result = await db.execute(sql`
      SELECT
        cb.id,
        cb.tenant_id   AS "tenantId",
        cb.name,
        cb.label,
        cb.action_type AS "actionType",
        cb.action_config AS "actionConfig",
        cb.style_config  AS "styleConfig",
        cb.created_at  AS "createdAt",
        (
          SELECT COUNT(*)::int FROM (
            SELECT id FROM banners
              WHERE (config->>'ctaButtonId')::int = cb.id AND tenant_id = cb.tenant_id
            UNION ALL
            SELECT id FROM journey_forms
              WHERE (config->>'ctaButtonId')::int = cb.id AND tenant_id = cb.tenant_id
            UNION ALL
            SELECT id FROM page_components
              WHERE component_type = 'cta' AND component_id = cb.id
          ) sub
        ) AS "usedIn"
      FROM cta_buttons cb
      WHERE cb.tenant_id = ${user.tenantId}
      ORDER BY cb.created_at DESC
    `);
    res.json(result.rows as any[]);
  } catch (err) { next(err); }
});

router.get("/cta-buttons/:id", async (req, res, next): Promise<void> => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  try {
    const user = req.user as any;
    const result = await db.execute(sql`
      SELECT id, tenant_id AS "tenantId", name, label,
             action_type AS "actionType", action_config AS "actionConfig",
             style_config AS "styleConfig", created_at AS "createdAt"
      FROM cta_buttons WHERE id = ${id} AND tenant_id = ${user.tenantId}
    `);
    const row = (result.rows as any[])[0];
    if (!row) { res.status(404).json({ error: "CTA button not found" }); return; }
    res.json(row);
  } catch (err) { next(err); }
});

router.post("/cta-buttons", async (req, res, next): Promise<void> => {
  const parsed = CtaButtonBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  try {
    const user = req.user as any;
    const { name, label, actionType, actionConfig, styleConfig } = parsed.data;
    const result = await db.execute(sql`
      INSERT INTO cta_buttons (tenant_id, name, label, action_type, action_config, style_config)
      VALUES (
        ${user.tenantId}, ${name}, ${label}, ${actionType},
        ${JSON.stringify(actionConfig)}::jsonb,
        ${JSON.stringify(styleConfig)}::jsonb
      )
      RETURNING id, tenant_id AS "tenantId", name, label,
                action_type AS "actionType", action_config AS "actionConfig",
                style_config AS "styleConfig", created_at AS "createdAt"
    `);
    res.status(201).json((result.rows as any[])[0]);
  } catch (err) { next(err); }
});

router.patch("/cta-buttons/:id", async (req, res, next): Promise<void> => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const parsed = CtaButtonBody.partial().safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  try {
    const user = req.user as any;
    const { name, label, actionType, actionConfig, styleConfig } = parsed.data;
    const result = await db.execute(sql`
      UPDATE cta_buttons SET
        name         = ${name         !== undefined ? name         : sql`name`},
        label        = ${label        !== undefined ? label        : sql`label`},
        action_type  = ${actionType   !== undefined ? actionType   : sql`action_type`},
        action_config= ${actionConfig !== undefined ? sql`${JSON.stringify(actionConfig)}::jsonb` : sql`action_config`},
        style_config = ${styleConfig  !== undefined ? sql`${JSON.stringify(styleConfig)}::jsonb`  : sql`style_config`}
      WHERE id = ${id} AND tenant_id = ${user.tenantId}
      RETURNING id, tenant_id AS "tenantId", name, label,
                action_type AS "actionType", action_config AS "actionConfig",
                style_config AS "styleConfig", created_at AS "createdAt"
    `);
    const row = (result.rows as any[])[0];
    if (!row) { res.status(404).json({ error: "CTA button not found" }); return; }
    res.json(row);
  } catch (err) { next(err); }
});

router.delete("/cta-buttons/:id", async (req, res, next): Promise<void> => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  try {
    const user = req.user as any;
    await db.execute(sql`
      DELETE FROM cta_buttons WHERE id = ${id} AND tenant_id = ${user.tenantId}
    `);
    res.sendStatus(204);
  } catch (err) { next(err); }
});

export default router;
