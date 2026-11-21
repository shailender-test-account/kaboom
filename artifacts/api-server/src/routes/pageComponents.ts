import { Router, type IRouter } from "express";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@workspace/db";
import { requireAuth } from "../middlewares/requireAuth";

const router: IRouter = Router();
router.use(requireAuth);

const POSITIONS = ["floating", "inline", "top_strip", "top_bar", "bottom_bar", "modal", "popup", "_default"] as const;

const PageComponentBody = z.object({
  journeyPageId: z.number().int(),
  componentType: z.enum(["cta", "form", "banner"]),
  componentId: z.number().int(),
  position: z.enum(POSITIONS).default("inline"),
  sortOrder: z.number().int().default(0),
  overrideConfig: z.record(z.unknown()).default({}),
});

const PageComponentPatchBody = z.object({
  journeyPageId: z.number().int().optional(),
  position: z.enum(POSITIONS).optional(),
  sortOrder: z.number().int().optional(),
  overrideConfig: z.record(z.unknown()).optional(),
});

router.get("/page-components", async (req, res, next): Promise<void> => {
  const pageId = req.query.pageId ? parseInt(req.query.pageId as string) : NaN;
  const journeyId = req.query.journeyId ? parseInt(req.query.journeyId as string) : NaN;
  if (isNaN(pageId) && isNaN(journeyId)) {
    res.status(400).json({ error: "pageId or journeyId query param required" }); return;
  }
  try {
    const user = req.user as any;
    const whereClause = !isNaN(journeyId)
      ? sql`jp.journey_id = ${journeyId}`
      : sql`pc.journey_page_id = ${pageId}`;
    const result = await db.execute(sql`
      SELECT
        pc.id,
        pc.journey_page_id  AS "journeyPageId",
        pc.component_type   AS "componentType",
        pc.component_id     AS "componentId",
        pc.position,
        pc.sort_order       AS "sortOrder",
        pc.override_config  AS "overrideConfig",
        pc.created_at       AS "createdAt",
        CASE pc.component_type
          WHEN 'cta'    THEN cb.name
          WHEN 'form'   THEN jf.name
          WHEN 'banner' THEN b.name
        END AS "componentName",
        cb.name           AS "ctaName",
        cb.label          AS "ctaLabel",
        cb.action_type    AS "ctaActionType",
        cb.action_config  AS "ctaActionConfig",
        cb.style_config   AS "ctaStyleConfig",
        jf.name           AS "formName",
        jf.config         AS "formConfig",
        b.name            AS "bannerName",
        b.config          AS "bannerConfig",
        b.position        AS "bannerPosition"
      FROM page_components pc
      JOIN journey_pages jp ON jp.id = pc.journey_page_id
      JOIN journeys j ON j.id = jp.journey_id AND j.tenant_id = ${user.tenantId}
      LEFT JOIN cta_buttons cb     ON cb.id = pc.component_id AND pc.component_type = 'cta'
      LEFT JOIN journey_forms jf   ON jf.id = pc.component_id AND pc.component_type = 'form'
      LEFT JOIN banners b          ON b.id  = pc.component_id AND pc.component_type = 'banner'
      WHERE ${whereClause}
      ORDER BY jp.sort_order ASC, pc.sort_order ASC, pc.created_at ASC
    `);
    res.json(result.rows as any[]);
  } catch (err) { next(err); }
});

router.post("/page-components", async (req, res, next): Promise<void> => {
  const parsed = PageComponentBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  try {
    const user = req.user as any;
    const { journeyPageId, componentType, componentId, position, sortOrder, overrideConfig } = parsed.data;
    // Verify journeyPageId belongs to the authenticated tenant
    const ownerCheck = await db.execute(sql`
      SELECT jp.id FROM journey_pages jp
      JOIN journeys j ON j.id = jp.journey_id AND j.tenant_id = ${user.tenantId}
      WHERE jp.id = ${journeyPageId} LIMIT 1
    `);
    if ((ownerCheck.rows as any[]).length === 0) {
      res.status(404).json({ error: "Journey page not found" }); return;
    }

    // Verify componentId belongs to the same tenant for each component type
    if (componentType === "cta") {
      const check = await db.execute(sql`
        SELECT id FROM cta_buttons WHERE id = ${componentId} AND tenant_id = ${user.tenantId} LIMIT 1
      `);
      if ((check.rows as any[]).length === 0) {
        res.status(404).json({ error: "CTA button not found" }); return;
      }
    } else if (componentType === "form") {
      const check = await db.execute(sql`
        SELECT id FROM journey_forms WHERE id = ${componentId} AND tenant_id = ${user.tenantId} LIMIT 1
      `);
      if ((check.rows as any[]).length === 0) {
        res.status(404).json({ error: "Journey form not found" }); return;
      }
    } else if (componentType === "banner") {
      const check = await db.execute(sql`
        SELECT id FROM banners WHERE id = ${componentId} AND tenant_id = ${user.tenantId} LIMIT 1
      `);
      if ((check.rows as any[]).length === 0) {
        res.status(404).json({ error: "Banner not found" }); return;
      }
    }

    const result = await db.execute(sql`
      INSERT INTO page_components
        (journey_page_id, component_type, component_id, position, sort_order, override_config)
      VALUES (
        ${journeyPageId}, ${componentType}, ${componentId}, ${position},
        ${sortOrder}, ${JSON.stringify(overrideConfig)}::jsonb
      )
      RETURNING
        id,
        journey_page_id AS "journeyPageId",
        component_type  AS "componentType",
        component_id    AS "componentId",
        position,
        sort_order      AS "sortOrder",
        override_config AS "overrideConfig",
        created_at      AS "createdAt"
    `);
    res.status(201).json((result.rows as any[])[0]);
  } catch (err) { next(err); }
});

router.patch("/page-components/:id", async (req, res, next): Promise<void> => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const parsed = PageComponentPatchBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  try {
    const user = req.user as any;
    const { journeyPageId, position, sortOrder, overrideConfig } = parsed.data;

    // If moving to a different page, verify the target page belongs to the same tenant
    // and is in the same journey as the source component
    let computedSortOrder: number | undefined = sortOrder;
    if (journeyPageId !== undefined) {
      const targetCheck = await db.execute(sql`
        SELECT jp.id, jp.journey_id FROM journey_pages jp
        JOIN journeys j ON j.id = jp.journey_id AND j.tenant_id = ${user.tenantId}
        WHERE jp.id = ${journeyPageId} LIMIT 1
      `);
      const targetRow = (targetCheck.rows as any[])[0];
      if (!targetRow) {
        res.status(404).json({ error: "Target journey page not found" }); return;
      }
      // Enforce same-journey constraint
      const sourceCheck = await db.execute(sql`
        SELECT jp.journey_id FROM page_components pc
        JOIN journey_pages jp ON jp.id = pc.journey_page_id
        WHERE pc.id = ${id} LIMIT 1
      `);
      const sourceRow = (sourceCheck.rows as any[])[0];
      if (sourceRow && sourceRow.journey_id !== targetRow.journey_id) {
        res.status(400).json({ error: "Cannot move component to a page in a different journey" }); return;
      }
      // Compute deterministic sort_order = MAX(sort_order)+1 on the target page
      const maxOrder = await db.execute(sql`
        SELECT COALESCE(MAX(sort_order), 0) + 1 AS next_order
        FROM page_components
        WHERE journey_page_id = ${journeyPageId}
      `);
      computedSortOrder = (maxOrder.rows as any[])[0]?.next_order ?? 1;
    }

    const result = await db.execute(sql`
      UPDATE page_components pc
      SET
        journey_page_id= ${journeyPageId !== undefined ? journeyPageId : sql`pc.journey_page_id`},
        position       = ${position         !== undefined ? position         : sql`pc.position`},
        sort_order     = ${computedSortOrder !== undefined ? computedSortOrder : sql`pc.sort_order`},
        override_config= ${overrideConfig !== undefined ? sql`${JSON.stringify(overrideConfig)}::jsonb` : sql`pc.override_config`}
      FROM journey_pages jp
      JOIN journeys j ON j.id = jp.journey_id AND j.tenant_id = ${user.tenantId}
      WHERE pc.id = ${id} AND pc.journey_page_id = jp.id
      RETURNING
        pc.id,
        pc.journey_page_id AS "journeyPageId",
        pc.component_type  AS "componentType",
        pc.component_id    AS "componentId",
        pc.position,
        pc.sort_order      AS "sortOrder",
        pc.override_config AS "overrideConfig",
        pc.created_at      AS "createdAt"
    `);
    const row = (result.rows as any[])[0];
    if (!row) { res.status(404).json({ error: "Component not found" }); return; }
    res.json(row);
  } catch (err) { next(err); }
});

router.delete("/page-components/:id", async (req, res, next): Promise<void> => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  try {
    const user = req.user as any;
    await db.execute(sql`
      DELETE FROM page_components pc
      USING journey_pages jp, journeys j
      WHERE pc.id = ${id}
        AND pc.journey_page_id = jp.id
        AND j.id = jp.journey_id
        AND j.tenant_id = ${user.tenantId}
    `);
    res.sendStatus(204);
  } catch (err) { next(err); }
});

export default router;
