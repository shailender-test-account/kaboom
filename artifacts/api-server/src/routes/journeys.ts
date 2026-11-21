import { Router, type IRouter } from "express";
import { and, eq, asc, sql } from "drizzle-orm";
import { z } from "zod";
import { db, pool, journeysTable, journeyPagesTable, clientsTable, playsTable } from "@workspace/db";
import { requireAuth } from "../middlewares/requireAuth";
import { logger } from "../lib/logger";
import { resolvePageContent } from "./publicJourneys";
import {
  CreateJourneyBody,
  UpdateJourneyBody,
  GetJourneyParams,
  UpdateJourneyParams,
  DeleteJourneyParams,
  ListJourneysQueryParams,
  CreateJourneyPageBody,
  UpdateJourneyPageBody,
  ListJourneyPagesParams,
  CreateJourneyPageParams,
  ReorderJourneyPagesBody,
  ReorderJourneyPagesParams,
  UpdateJourneyPageParams,
  DeleteJourneyPageParams,
} from "@workspace/api-zod";
const router: IRouter = Router();

type PageRow = {
  id: number; journeyId: number; title: string; pageType: string;
  content: string | null; sortOrder: number; ctaText: string | null;
  ctaEnabled: boolean; viewCount: number; createdAt: string;
  pageStage: string | null; score: number; isPublished: boolean;
  ctaType: string | null; ctaAssetUrl: string | null; gatingAction: string | null;
};

export async function enrichJourney(j: typeof journeysTable.$inferSelect) {
  const pages = await fetchPages(j.id);
  const totalViews = (pages as PageRow[]).reduce((sum, p) => sum + (p.viewCount ?? 0), 0);
  const [client] = await db.select({ name: clientsTable.name, logoUrl: clientsTable.logoUrl })
    .from(clientsTable)
    .where(eq(clientsTable.id, j.clientId));
  const linkedPlaysResult = await db.execute(sql`
    SELECT p.id, p.name FROM journey_plays jp
    JOIN abm_plays p ON p.id = jp.play_id
    WHERE jp.journey_id = ${j.id} AND p.tenant_id = ${j.tenantId}
      AND p.client_id = ${j.clientId}
    ORDER BY p.name ASC
  `);
  const linkedPlaysRows = linkedPlaysResult.rows as { id: number; name: string }[];
  const contactCountResult = await db.execute(sql`
    SELECT COUNT(DISTINCT jc.contact_id)::int AS cnt
    FROM journey_contacts jc JOIN contacts c ON c.id=jc.contact_id
    WHERE jc.journey_id=${j.id} AND c.tenant_id=${j.tenantId}
      AND c.client_id=${j.clientId}
  `);
  type CountRow = { cnt: number };
  const contactCount: number = ((contactCountResult.rows as CountRow[])[0]?.cnt ?? 0);
  return {
    ...j,
    pageCount: pages.length,
    totalViews,
    clientName: client?.name ?? null,
    clientLogoUrl: client?.logoUrl ?? null,
    linkedPlays: linkedPlaysRows,
    linkedPlaysCount: linkedPlaysRows.length,
    contactCount,
  };
}

function normalizePages(pages: any[]) {
  return pages.map(p => ({ ...p, ctaEnabled: p.ctaEnabled === "true" || p.ctaEnabled === true }));
}

async function fetchPages(journeyId: number) {
  try {
    const result = await db.execute(sql`
      SELECT
        p.id, p.journey_id AS "journeyId", p.title, p.page_type AS "pageType",
        p.content, p.sort_order AS "sortOrder", p.cta_text AS "ctaText",
        p.cta_enabled AS "ctaEnabled", p.view_count AS "viewCount",
        p.created_at AS "createdAt", p.page_stage AS "pageStage",
        p.bi_category AS "biCategory", p.bi_product AS "biProduct", p.bi_program AS "biProgram",
        p.score, p.is_published AS "isPublished",
        p.cta_type AS "ctaType", p.cta_asset_url AS "ctaAssetUrl",
        p.gating_action AS "gatingAction"
      FROM journey_pages p
      WHERE p.journey_id = ${journeyId}
      ORDER BY p.sort_order ASC
    `);
    return normalizePages(result.rows as any[]);
  } catch (err: any) {
    const detail = err?.message ?? String(err);
    logger.error({ journeyId, pgError: detail }, "fetchPages query failed — possible schema drift");
    throw err;
  }
}

router.use(requireAuth);

router.get("/journeys", async (req, res, next): Promise<void> => {
  const qp = ListJourneysQueryParams.safeParse(req.query);
  try {
    const user = req.user as any;
    const journeys = await db
      .select()
      .from(journeysTable)
      .where(
        and(
          eq(journeysTable.tenantId, user.tenantId),
          qp.success && qp.data.clientId ? eq(journeysTable.clientId, qp.data.clientId) : undefined,
        ),
      );
    const result = await Promise.all(journeys.map(enrichJourney));
    res.json(result);
  } catch (err) { next(err); }
});

router.post("/journeys", async (req, res, next): Promise<void> => {
  const parsed = CreateJourneyBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  try {
    const user = req.user as any;
    const slug = parsed.data.name.toLowerCase().replace(/[^a-z0-9]+/g, "-") + "-" + Date.now();
    const [journey] = await db
      .insert(journeysTable)
      .values({ ...parsed.data, tenantId: user.tenantId, slug, status: parsed.data.status ?? "draft" })
      .returning();
    res.status(201).json(await enrichJourney(journey));
  } catch (err) { next(err); }
});

router.get("/journeys/:id", async (req, res, next): Promise<void> => {
  const params = GetJourneyParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  try {
    const user = req.user as any;
    const [journey] = await db.select().from(journeysTable).where(eq(journeysTable.id, params.data.id));
    if (!journey || journey.tenantId !== user.tenantId) { res.status(404).json({ error: "Journey not found" }); return; }
    res.json(await enrichJourney(journey));
  } catch (err) { next(err); }
});

router.patch("/journeys/:id", async (req, res, next): Promise<void> => {
  const params = UpdateJourneyParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const parsed = UpdateJourneyBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  try {
    const user = req.user as any;
    const [existing] = await db.select().from(journeysTable).where(eq(journeysTable.id, params.data.id));
    if (!existing || existing.tenantId !== user.tenantId) { res.status(404).json({ error: "Journey not found" }); return; }
    const updateSet: Record<string, any> = { ...parsed.data };
    if (parsed.data.name && parsed.data.name !== existing.name) {
      updateSet.slug = parsed.data.name.toLowerCase().replace(/[^a-z0-9]+/g, "-") + "-" + Date.now();
    }
    const [journey] = await db.update(journeysTable).set(updateSet).where(eq(journeysTable.id, params.data.id)).returning();
    res.json(await enrichJourney(journey));
  } catch (err) { next(err); }
});

// ── Contest Scenario Videos ───────────────────────────────────────────────────
router.patch("/journeys/:id/scenario-videos", async (req, res, next): Promise<void> => {
  const journeyId = parseInt(req.params.id);
  if (isNaN(journeyId)) { res.status(400).json({ error: "Invalid id" }); return; }
  const BodySchema = z.object({
    airport: z.string().nullable().optional(),
    support: z.string().nullable().optional(),
    home:    z.string().nullable().optional(),
  });
  const parsed = BodySchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  try {
    const user = req.user as any;
    const [existing] = await db.select().from(journeysTable).where(eq(journeysTable.id, journeyId));
    if (!existing || existing.tenantId !== user.tenantId) { res.status(404).json({ error: "Journey not found" }); return; }
    // Strip empty strings → null so the contest page knows there's no video
    const clean = {
      airport: parsed.data.airport?.trim() || null,
      support: parsed.data.support?.trim() || null,
      home:    parsed.data.home?.trim()    || null,
    };
    const [updated] = await db.update(journeysTable)
      .set({ scenarioVideos: clean } as any)
      .where(eq(journeysTable.id, journeyId))
      .returning();
    res.json(await enrichJourney(updated));
  } catch (err) { next(err); }
});

// ── Journey Schedule (start/end dates) ───────────────────────────────────────
router.patch("/journeys/:id/schedule", async (req, res, next): Promise<void> => {
  const journeyId = parseInt(req.params.id);
  if (isNaN(journeyId)) { res.status(400).json({ error: "Invalid id" }); return; }

  const BodySchema = z.object({
    startDate: z.string().nullable().optional(),
    endDate: z.string().nullable().optional(),
  });
  const parsed = BodySchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  try {
    const user = req.user as any;
    const [existing] = await db.select().from(journeysTable).where(eq(journeysTable.id, journeyId));
    if (!existing || existing.tenantId !== user.tenantId) { res.status(404).json({ error: "Journey not found" }); return; }

    const { startDate, endDate } = parsed.data;
    await db.execute(sql`
      UPDATE journeys SET
        start_date = ${startDate !== undefined ? (startDate ?? null) : sql`start_date`},
        end_date   = ${endDate   !== undefined ? (endDate   ?? null) : sql`end_date`}
      WHERE id = ${journeyId}
    `);
    const [updated] = await db.select().from(journeysTable).where(eq(journeysTable.id, journeyId));
    res.json(await enrichJourney(updated));
  } catch (err) { next(err); }
});

// ── Journey Header Config ─────────────────────────────────────────────────────
router.patch("/journeys/:id/header", async (req, res, next): Promise<void> => {
  const journeyId = parseInt(req.params.id);
  if (isNaN(journeyId)) { res.status(400).json({ error: "Invalid id" }); return; }
  const BodySchema = z.object({
    headerLogoUrl:    z.string().nullable().optional(),
    headerLogoShowBg: z.boolean().optional(),
    headerBtnText:    z.string().nullable().optional(),
    headerBtnUrl:     z.string().nullable().optional(),
    headerBtnType:    z.string().optional(),
    headerTagline:    z.string().nullable().optional(),
  });
  const parsed = BodySchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  try {
    const user = req.user as any;
    const [existing] = await db.select().from(journeysTable).where(eq(journeysTable.id, journeyId));
    if (!existing || existing.tenantId !== user.tenantId) { res.status(404).json({ error: "Journey not found" }); return; }
    const { headerLogoUrl, headerLogoShowBg, headerBtnText, headerBtnUrl, headerBtnType, headerTagline } = parsed.data;
    await db.execute(sql`
      UPDATE journeys SET
        header_logo_url    = ${headerLogoUrl    !== undefined ? headerLogoUrl    : sql`header_logo_url`},
        header_logo_show_bg = ${headerLogoShowBg !== undefined ? headerLogoShowBg : sql`header_logo_show_bg`},
        header_btn_text    = ${headerBtnText    !== undefined ? headerBtnText    : sql`header_btn_text`},
        header_btn_url     = ${headerBtnUrl     !== undefined ? headerBtnUrl     : sql`header_btn_url`},
        header_btn_type    = ${headerBtnType    !== undefined ? headerBtnType    : sql`header_btn_type`},
        header_tagline     = ${headerTagline    !== undefined ? headerTagline    : sql`header_tagline`}
      WHERE id = ${journeyId}
    `);
    const [updated] = await db.select().from(journeysTable).where(eq(journeysTable.id, journeyId));
    res.json(await enrichJourney(updated));
  } catch (err) { next(err); }
});

router.delete("/journeys/:id", async (req, res, next): Promise<void> => {
  const params = DeleteJourneyParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  try {
    const user = req.user as any;
    const [existing] = await db.select().from(journeysTable).where(eq(journeysTable.id, params.data.id));
    if (!existing || existing.tenantId !== user.tenantId) { res.status(404).json({ error: "Journey not found" }); return; }
    await db.delete(journeyPagesTable).where(eq(journeyPagesTable.journeyId, params.data.id));
    await db.delete(journeysTable).where(eq(journeysTable.id, params.data.id));
    res.sendStatus(204);
  } catch (err) { next(err); }
});

// POST /api/journeys/:id/duplicate — deep-clone journey + pages + page_components
router.post("/journeys/:id/duplicate", async (req, res, next): Promise<void> => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  try {
    const user = req.user as any;
    const [source] = await db.select().from(journeysTable).where(eq(journeysTable.id, id));
    if (!source || source.tenantId !== user.tenantId) { res.status(404).json({ error: "Journey not found" }); return; }

    const newSlug = source.name.toLowerCase().replace(/[^a-z0-9]+/g, "-") + "-copy-" + Date.now();
    const [newJourney] = await db.insert(journeysTable).values({
      tenantId: source.tenantId,
      name: `Copy of ${source.name}`,
      slug: newSlug,
      description: source.description,
      clientId: source.clientId,
      status: "draft",
      theme: source.theme,
      headerLogoUrl: source.headerLogoUrl,
      headerLogoShowBg: source.headerLogoShowBg,
      headerBtnText: source.headerBtnText,
      headerBtnUrl: source.headerBtnUrl,
      headerBtnType: source.headerBtnType,
      headerTagline: source.headerTagline,
      navigationMode: source.navigationMode,
    }).returning();

    const sourcePages = (await db.execute(
      sql`SELECT * FROM journey_pages WHERE journey_id = ${id} ORDER BY sort_order ASC`
    )).rows as any[];

    for (const page of sourcePages) {
      const newPageRows = (await db.execute(sql`
        INSERT INTO journey_pages
          (journey_id, title, page_type, content, sort_order, cta_text, cta_enabled,
           page_stage, score, is_published, cta_type, cta_asset_url, gating_action)
        VALUES
          (${newJourney.id}, ${page.title}, ${page.page_type}, ${page.content ?? null},
           ${page.sort_order}, ${page.cta_text ?? null}, ${page.cta_enabled ?? "false"},
           ${page.page_stage ?? null}, ${page.score ?? 0}, ${page.is_published ?? true},
           ${page.cta_type ?? null}, ${page.cta_asset_url ?? null}, ${page.gating_action ?? "none"})
        RETURNING id
      `)).rows as any[];
      const newPageId = newPageRows[0]?.id;
      if (!newPageId) continue;

      const comps = (await db.execute(
        sql`SELECT component_type, component_id, position, sort_order, override_config
            FROM page_components WHERE journey_page_id = ${page.id} ORDER BY sort_order ASC`
      )).rows as any[];

      for (const comp of comps) {
        await db.execute(sql`
          INSERT INTO page_components
            (journey_page_id, component_type, component_id, position, sort_order, override_config)
          VALUES
            (${newPageId}, ${comp.component_type}, ${comp.component_id}, ${comp.position},
             ${comp.sort_order ?? 0},
             ${comp.override_config != null ? JSON.stringify(comp.override_config) : null}::jsonb)
        `);
      }
    }

    res.status(201).json(await enrichJourney(newJourney));
  } catch (err) { next(err); }
});

router.get("/journeys/:id/pages", async (req, res, next): Promise<void> => {
  const params = ListJourneyPagesParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  try {
    res.json(await fetchPages(params.data.id));
  } catch (err) { next(err); }
});

router.post("/journeys/:id/pages", async (req, res, next): Promise<void> => {
  const params = CreateJourneyPageParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const parsed = CreateJourneyPageBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  try {
    const existingPages = await db
      .select({ id: journeyPagesTable.id })
      .from(journeyPagesTable)
      .where(eq(journeyPagesTable.journeyId, params.data.id));
    const [page] = await db
      .insert(journeyPagesTable)
      .values({
        journeyId: params.data.id,
        title: parsed.data.title,
        pageType: parsed.data.pageType,
        content: parsed.data.content ?? null,
        sortOrder: parsed.data.sortOrder ?? existingPages.length,
        ctaText: parsed.data.ctaText ?? null,
        ctaEnabled: parsed.data.ctaEnabled ? "true" : "false",
      })
      .returning();
    res.status(201).json({ ...page, ctaEnabled: page.ctaEnabled === "true" });
  } catch (err) { next(err); }
});

router.patch("/journeys/:id/pages/reorder", async (req, res, next): Promise<void> => {
  const params = ReorderJourneyPagesParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const parsed = ReorderJourneyPagesBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  try {
    await Promise.all(
      parsed.data.pageIds.map((pageId, index) =>
        db.update(journeyPagesTable).set({ sortOrder: index }).where(eq(journeyPagesTable.id, pageId)),
      ),
    );
    res.json(await fetchPages(params.data.id));
  } catch (err) { next(err); }
});

router.patch("/journeys/pages/:pageId", async (req, res, next): Promise<void> => {
  const params = UpdateJourneyPageParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const parsed = UpdateJourneyPageBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  try {
    const updateData: any = { ...parsed.data };
    if (typeof parsed.data.ctaEnabled === "boolean") {
      updateData.ctaEnabled = parsed.data.ctaEnabled ? "true" : "false";
    }
    const [page] = await db
      .update(journeyPagesTable)
      .set(updateData)
      .where(eq(journeyPagesTable.id, params.data.pageId))
      .returning();
    if (!page) { res.status(404).json({ error: "Page not found" }); return; }
    res.json({ ...page, ctaEnabled: page.ctaEnabled === "true" });
  } catch (err) { next(err); }
});

router.delete("/journeys/pages/:pageId", async (req, res, next): Promise<void> => {
  const params = DeleteJourneyPageParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  try {
    await db.delete(journeyPagesTable).where(eq(journeyPagesTable.id, params.data.pageId));
    res.sendStatus(204);
  } catch (err) { next(err); }
});

// ── Page Settings (score, stage, banner, form, isPublished) ──────────────────
router.patch("/journeys/pages/:pageId/settings", async (req, res, next): Promise<void> => {
  const pageId = parseInt(req.params.pageId);
  if (isNaN(pageId)) { res.status(400).json({ error: "Invalid id" }); return; }

  const BodySchema = z.object({
    score: z.number().int().min(0).max(200).optional(),
    pageStage: z.string().nullable().optional(),
    sortOrder: z.number().int().min(0).optional(),
    isPublished: z.boolean().optional(),
    ctaType: z.enum(["next", "url", "page", "download", "gated_download"]).optional(),
    ctaAssetUrl: z.string().nullable().optional(),
    gatingAction: z.enum(["none", "form_submit", "cta_click"]).optional(),
    biCategory: z.string().max(200).nullable().optional(),
    biProduct: z.string().max(500).nullable().optional(),
    biProgram: z.string().max(500).nullable().optional(),
  });
  const parsed = BodySchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  try {
    const { score, pageStage, sortOrder, isPublished, ctaType, ctaAssetUrl, gatingAction, biCategory, biProduct, biProgram } = parsed.data;
    const result = await db.execute(sql`
      UPDATE journey_pages SET
        score          = ${score          !== undefined ? score          : sql`score`},
        page_stage     = ${pageStage     !== undefined ? pageStage     : sql`page_stage`},
        sort_order     = ${sortOrder     !== undefined ? sortOrder     : sql`sort_order`},
        is_published   = ${isPublished   !== undefined ? isPublished   : sql`is_published`},
        cta_type       = ${ctaType       !== undefined ? ctaType       : sql`cta_type`},
        cta_asset_url  = ${ctaAssetUrl   !== undefined ? ctaAssetUrl   : sql`cta_asset_url`},
        gating_action  = ${gatingAction  !== undefined ? gatingAction  : sql`gating_action`},
        bi_category = ${biCategory !== undefined ? biCategory : sql`bi_category`},
        bi_product = ${biProduct !== undefined ? biProduct : sql`bi_product`},
        bi_program = ${biProgram !== undefined ? biProgram : sql`bi_program`}
      WHERE id = ${pageId}
        AND EXISTS(SELECT 1 FROM journeys owner WHERE owner.id=journey_pages.journey_id AND owner.tenant_id=${(req.user as any).tenantId})
      RETURNING id
    `);
    const row = (result.rows as any[])[0];
    if (!row) { res.status(404).json({ error: "Page not found" }); return; }

    const [journeyRow] = (await db.execute(sql`SELECT journey_id FROM journey_pages WHERE id = ${pageId}`)).rows as any[];
    if (!journeyRow) { res.status(404).json({ error: "Page not found" }); return; }
    const pages = await fetchPages(journeyRow.journey_id);
    const page = pages.find((p: any) => p.id === pageId);
    res.json(page ?? row);
  } catch (err) { next(err); }
});

// ── Journey ↔ Play linking ────────────────────────────────────────────────────
router.post("/journeys/:id/plays", async (req, res, next): Promise<void> => {
  const journeyId = parseInt(req.params.id);
  if (isNaN(journeyId)) { res.status(400).json({ error: "Invalid id" }); return; }
  const parsed = z.object({ playId: z.number().int() }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  try {
    const user = req.user as any;
    const [journey] = await db.select().from(journeysTable).where(eq(journeysTable.id, journeyId));
    if (!journey || journey.tenantId !== user.tenantId) { res.status(404).json({ error: "Journey not found" }); return; }
    const [play] = await db.select({ id: playsTable.id }).from(playsTable).where(and(eq(playsTable.id, parsed.data.playId), eq(playsTable.tenantId, user.tenantId)));
    if (!play) { res.status(404).json({ error: "Play not found" }); return; }
    await db.execute(sql`
      INSERT INTO journey_plays (journey_id, play_id) VALUES (${journeyId}, ${parsed.data.playId})
      ON CONFLICT DO NOTHING
    `);
    res.json(await enrichJourney(journey));
  } catch (err) { next(err); }
});

// ── GET /api/journeys/:id/builder-preview ────────────────────────────────────
// Authenticated preview endpoint — returns the same structure as the public
// viewer endpoint but bypasses status/date checks and always forces
// navigationMode: "sequential" so gate enforcement is always active.
router.get("/journeys/:id/builder-preview", async (req, res, next): Promise<void> => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  try {
    const user = req.user as any;
    const [journey] = await db.select().from(journeysTable).where(eq(journeysTable.id, id));
    if (!journey || journey.tenantId !== user.tenantId) {
      res.status(404).json({ error: "Journey not found" }); return;
    }

    const rawPages = await db.execute(sql`
      SELECT
        p.id, p.title, p.page_type AS "pageType",
        p.content, p.sort_order AS "sortOrder", p.cta_text AS "ctaText",
        p.cta_enabled AS "ctaEnabled", p.view_count AS "viewCount",
        p.is_published AS "isPublished",
        p.cta_type AS "ctaType", p.cta_asset_url AS "ctaAssetUrl",
        p.gating_action AS "gatingAction"
      FROM journey_pages p
      WHERE p.journey_id = ${id}
      ORDER BY p.sort_order ASC
    `);

    // Optional: resolve personalisation tokens when ?cid=<contactId> is supplied.
    // This is admin-only (requireAuth), so no visitor-token or cookie side-effects needed.
    const cidRaw = req.query.cid as string | undefined;
    const cidInt = cidRaw ? parseInt(cidRaw, 10) : null;
    let tokenMap: Record<string, string> = {};
    let previewContact: { firstName: string; lastName: string } | null = null;
    if (cidInt && !isNaN(cidInt)) {
      const { rows: cr } = await pool.query<{
        first_name: string | null; last_name: string | null; email: string | null;
        title: string | null; company_name: string | null; industry: string | null;
      }>(
        `SELECT c.first_name, c.last_name, c.email, c.title,
                co.name AS company_name, co.industry
         FROM contacts c
         LEFT JOIN companies co ON co.id = c.company_id
         WHERE c.id = $1 AND c.tenant_id = $2
         LIMIT 1`,
        [cidInt, user.tenantId],
      );
      if (cr.length > 0) {
        const c = cr[0];
        tokenMap = {
          firstName:   c.first_name  ?? "",
          first_name:  c.first_name  ?? "",
          lastName:    c.last_name   ?? "",
          last_name:   c.last_name   ?? "",
          companyName: c.company_name ?? "",
          company_name:c.company_name ?? "",
          email:       c.email       ?? "",
          jobTitle:    c.title       ?? "",
          title:       c.title       ?? "",
          industry:    c.industry    ?? "",
        };
        previewContact = { firstName: c.first_name ?? "", lastName: c.last_name ?? "" };
      }
    }

    const rawNormalized = normalizePages(rawPages.rows as any[]).filter((p: any) => p.isPublished !== false);
    const pages = rawNormalized.map((p: any) => resolvePageContent(p, tokenMap));

    const [client] = await db
      .select({ name: clientsTable.name, logoUrl: clientsTable.logoUrl })
      .from(clientsTable)
      .where(eq(clientsTable.id, journey.clientId));

    res.json({
      ...journey,
      // Always sequential in preview so gate enforcement is testable
      navigationMode: "sequential",
      clientName: client?.name ?? null,
      clientLogoUrl: client?.logoUrl ?? null,
      visitorContact: previewContact,
      pages,
      zoneBanners: { top: [], bottom: [], sidebar: [] },
      zoneSettings: {
        top:     { rotationIntervalSeconds: 5, mobileBehavior: "hide" },
        bottom:  { rotationIntervalSeconds: 5, mobileBehavior: "hide" },
        sidebar: { rotationIntervalSeconds: 5, mobileBehavior: "hide" },
      },
    });
  } catch (err) { next(err); }
});

router.delete("/journeys/:id/plays/:playId", async (req, res, next): Promise<void> => {
  const journeyId = parseInt(req.params.id);
  const playId = parseInt(req.params.playId);
  if (isNaN(journeyId) || isNaN(playId)) { res.status(400).json({ error: "Invalid id" }); return; }
  try {
    const user = req.user as any;
    const [journey] = await db.select().from(journeysTable).where(eq(journeysTable.id, journeyId));
    if (!journey || journey.tenantId !== user.tenantId) { res.status(404).json({ error: "Journey not found" }); return; }
    const [play] = await db.select({ id: playsTable.id }).from(playsTable).where(and(eq(playsTable.id, playId), eq(playsTable.tenantId, user.tenantId)));
    if (!play) { res.status(404).json({ error: "Play not found" }); return; }
    await db.execute(sql`DELETE FROM journey_plays WHERE journey_id = ${journeyId} AND play_id = ${playId}`);
    res.json(await enrichJourney(journey));
  } catch (err) { next(err); }
});

export default router;
