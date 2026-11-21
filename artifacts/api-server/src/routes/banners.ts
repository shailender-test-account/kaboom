import { Router, type IRouter } from "express";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@workspace/db";
import { requireAuth } from "../middlewares/requireAuth";
import { sendEmail, buildUnsubscribeFooter, buildConfirmationEmailParts, generateFormPreviewToken } from "../services/email";

const router: IRouter = Router();
router.use(requireAuth);

// ── Banner config schema (new extended shape, backward-compat with old fields) ─

const TagTargetingSchema = z.object({
  mode: z.enum(["everyone", "with_tag", "without_tag"]).default("everyone"),
  tag: z.string().default(""),
});

const BannerConfigSchema = z.object({
  // Legacy fields (kept for backward compat)
  template: z.string().optional(),
  bgColor: z.string().default("#4f46e5"),
  textColor: z.string().default("#ffffff"),
  heading: z.string().default(""),
  body: z.string().default(""),
  ctaText: z.string().optional(),
  ctaUrl: z.string().optional(),
  // Audience targeting (legacy)
  targetTags: z.array(z.string()).optional(),
  tagMatch: z.enum(["any", "all"]).optional(),
  enablePersonalization: z.boolean().optional(),
  // New extended fields
  type: z.enum(["text", "image"]).default("text"),
  imageUrl: z.string().optional(),
  overlayText: z.string().optional(),
  overlaySubtext: z.string().optional(),
  textAlignment: z.enum(["left", "center", "right"]).optional(),
  textVertical: z.enum(["top", "middle", "bottom"]).optional(),
  textShadow: z.boolean().optional(),
  fontFamily: z.string().optional(),
  headlineFontSize: z.number().optional(),
  subtextFontSize: z.number().optional(),
  padding: z.number().optional(),
  animationType: z.enum(["none", "slide_top", "slide_bottom", "fade"]).default("none"),
  animationDelay: z.number().default(0),
  dismissButton: z.boolean().default(false),
  dismissDuration: z.enum(["session", "7d", "30d", "forever"]).default("session"),
  clickBehavior: z.enum(["none", "url", "cta"]).default("none"),
  clickUrl: z.string().optional(),
  openInNewTab: z.boolean().optional(),
  ctaButtonId: z.number().int().nullable().optional(),
  ctaButtonPosition: z.enum(["right", "below"]).optional(),
  tagTargeting: TagTargetingSchema.optional(),
}).passthrough();

const BannerBody = z.object({
  name: z.string().min(1),
  position: z.preprocess(
    v => v === "top_bar" || v === "inline" ? "top"
       : v === "bottom_bar" ? "bottom"
       : v === "right" ? "popup"
       : v,
    z.enum(["top", "bottom", "popup"]),
  ).default("top"),
  zone: z.enum(["top", "bottom", "sidebar"]).nullable().optional(),
  status: z.enum(["active", "inactive", "scheduled"]).default("active"),
  start_date: z.string().nullable().optional(),
  end_date: z.string().nullable().optional(),
  original_width: z.number().int().nullable().optional(),
  original_height: z.number().int().nullable().optional(),
  file_size: z.number().nullable().optional(),
  original_filename: z.string().nullable().optional(),
  config: BannerConfigSchema.default({}),
});

const ZoneSettingsBody = z.object({
  rotation_interval_seconds: z.number().int().min(1).max(300).default(5),
  mobile_behavior: z.enum(["hide", "show"]).default("hide"),
});

// ── Form config schema (new extended shape, backward-compat) ──────────────────

const FormFieldSchema = z.object({
  id: z.string(),
  type: z.enum([
    "short_text", "long_text", "email", "phone",
    "checkbox_group", "radio_group", "dropdown",
    "consent", "tnc", "privacy_policy",
    "section_heading", "divider",
    // legacy types
    "text", "textarea", "select",
  ]),
  label: z.string().default(""),
  placeholder: z.string().optional(),
  required: z.boolean().default(false),
  mapToContactField: z.string().optional(),
  options: z.array(z.string()).optional(),
  rows: z.number().optional(),
  consentText: z.string().optional(),
  storeAsTag: z.boolean().optional(),
  tncUrl: z.string().optional(),
  privacyUrl: z.string().optional(),
  dividerColor: z.string().optional(),
  dividerStyle: z.string().optional(),
}).passthrough();

const SubmitButtonSchema = z.object({
  label: z.string().default("Submit"),
  bgColor: z.string().optional(),
  textColor: z.string().optional(),
  sizePreset: z.enum(["small", "medium", "large", "full"]).optional(),
  borderRadius: z.enum(["sharp", "slightly_rounded", "pill"]).optional(),
}).passthrough();

const OnSubmitSchema = z.object({
  thankYouTitle: z.string().default("Thank you!"),
  thankYouBody: z.string().default(""),
  deliveryAssetId: z.number().int().nullable().optional(),
  deliveryMethod: z.enum(["download_button", "email"]).optional(),
  enrollSequenceId: z.number().int().nullable().optional(),
  redirectUrl: z.string().optional(),
  redirectDelay: z.number().optional(),
}).passthrough();

const ConfirmationEmailSchema = z.object({
  enabled: z.boolean().default(false),
  subject: z.string().default(""),
  body: z.string().default(""),
});

const JourneyFormConfigSchema = z.object({
  // Legacy fields
  heading: z.string().optional(),
  body: z.string().optional(),
  imageUrl: z.string().optional(),
  fields: z.array(FormFieldSchema).default([]),
  ctaText: z.string().optional(),
  successMessage: z.string().optional(),
  assetUrl: z.string().optional(),
  // New extended fields
  layout: z.enum(["centered_card", "full_width", "two_column", "minimal_inline"]).default("centered_card"),
  headerElements: z.unknown().optional(),
  submitButton: SubmitButtonSchema.optional(),
  textBelowSubmit: z.string().optional(),
  onSubmit: OnSubmitSchema.optional(),
  styling: z.record(z.unknown()).optional(),
  tagTargeting: TagTargetingSchema.optional(),
  ctaButtonId: z.number().int().nullable().optional(),
  ctaPosition: z.enum(["above_fields", "below_submit", "inline_bottom"]).optional(),
  confirmationEmail: ConfirmationEmailSchema.optional(),
  notifyOnSubmit: z.boolean().optional(),
}).passthrough();

const JourneyFormBody = z.object({
  name: z.string().min(1),
  config: JourneyFormConfigSchema.default({}),
});

// ── Banners CRUD ──────────────────────────────────────────────────────────────

const BANNER_SELECT = sql`
  b.id,
  b.tenant_id AS "tenantId",
  b.name,
  b.position,
  b.zone,
  b.status,
  b.start_date AS "startDate",
  b.end_date AS "endDate",
  b.original_width AS "originalWidth",
  b.original_height AS "originalHeight",
  b.file_size AS "fileSize",
  b.original_filename AS "originalFilename",
  b.config,
  b.created_at AS "createdAt"
`;

// Unqualified version for INSERT/UPDATE RETURNING clauses (no table alias)
const BANNER_RETURNING = sql`
  id,
  tenant_id AS "tenantId",
  name,
  position,
  zone,
  status,
  start_date AS "startDate",
  end_date AS "endDate",
  original_width AS "originalWidth",
  original_height AS "originalHeight",
  file_size AS "fileSize",
  original_filename AS "originalFilename",
  config,
  created_at AS "createdAt"
`;

router.get("/banners", async (req, res, next): Promise<void> => {
  try {
    const user = req.user as any;
    const result = await db.execute(sql`
      SELECT
        ${BANNER_SELECT},
        COALESCE(pc.used_in, 0)::int AS "usedInCount",
        COALESCE(jn.journey_names, '[]'::jsonb) AS "usedInJourneys",
        COALESCE(pn.play_names, '[]'::jsonb) AS "usedInPlays"
      FROM banners b
      LEFT JOIN (
        SELECT component_id, COUNT(DISTINCT jp.journey_id)::int AS used_in
        FROM page_components pc2
        JOIN journey_pages jp ON jp.id = pc2.journey_page_id
        WHERE pc2.component_type = 'banner'
        GROUP BY component_id
      ) pc ON pc.component_id = b.id
      LEFT JOIN (
        SELECT pc2.component_id,
          jsonb_agg(DISTINCT jsonb_build_object('id', j.id, 'name', j.name)) AS journey_names
        FROM page_components pc2
        JOIN journey_pages jp ON jp.id = pc2.journey_page_id
        JOIN journeys j ON j.id = jp.journey_id AND j.tenant_id = ${user.tenantId}
        WHERE pc2.component_type = 'banner'
        GROUP BY pc2.component_id
      ) jn ON jn.component_id = b.id
      LEFT JOIN (
        SELECT pc2.component_id,
          jsonb_agg(DISTINCT jsonb_build_object('id', ap.id, 'name', ap.name)) AS play_names
        FROM page_components pc2
        JOIN journey_pages jp ON jp.id = pc2.journey_page_id
        JOIN journeys j ON j.id = jp.journey_id AND j.tenant_id = ${user.tenantId}
        JOIN journey_plays jpx ON jpx.journey_id = j.id
        JOIN abm_plays ap ON ap.id = jpx.play_id
        WHERE pc2.component_type = 'banner'
        GROUP BY pc2.component_id
      ) pn ON pn.component_id = b.id
      WHERE b.tenant_id = ${user.tenantId}
      ORDER BY b.created_at DESC
    `);
    res.json(result.rows as any[]);
  } catch (err) { next(err); }
});

// Zone settings routes must come before /:id to avoid matching
router.get("/banners/zone-settings", async (req, res, next): Promise<void> => {
  try {
    const user = req.user as any;
    const result = await db.execute(sql`
      SELECT zone, rotation_interval_seconds AS "rotationIntervalSeconds", mobile_behavior AS "mobileBehavior"
      FROM banner_zone_settings
      WHERE tenant_id = ${user.tenantId}
    `);
    const rows = result.rows as any[];
    const settings: Record<string, { rotationIntervalSeconds: number; mobileBehavior: string }> = {};
    for (const row of rows) {
      settings[row.zone] = { rotationIntervalSeconds: row.rotationIntervalSeconds, mobileBehavior: row.mobileBehavior };
    }
    // Fill defaults
    for (const zone of ["top", "bottom", "sidebar"]) {
      if (!settings[zone]) settings[zone] = { rotationIntervalSeconds: 5, mobileBehavior: "hide" };
    }
    res.json(settings);
  } catch (err) { next(err); }
});

router.patch("/banners/zone-settings/:zone", async (req, res, next): Promise<void> => {
  const zone = req.params.zone;
  if (!["top", "bottom", "sidebar"].includes(zone)) {
    res.status(400).json({ error: "Invalid zone. Must be top, bottom, or sidebar." }); return;
  }
  const parsed = ZoneSettingsBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  try {
    const user = req.user as any;
    await db.execute(sql`
      INSERT INTO banner_zone_settings (tenant_id, zone, rotation_interval_seconds, mobile_behavior)
      VALUES (${user.tenantId}, ${zone}, ${parsed.data.rotation_interval_seconds}, ${parsed.data.mobile_behavior})
      ON CONFLICT (tenant_id, zone) DO UPDATE SET
        rotation_interval_seconds = EXCLUDED.rotation_interval_seconds,
        mobile_behavior = EXCLUDED.mobile_behavior
    `);
    res.json({ ok: true, zone, ...parsed.data });
  } catch (err) { next(err); }
});

router.get("/banners/:id/usage", async (req, res, next): Promise<void> => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  try {
    const user = req.user as any;
    // Journey/page usage
    const journeyResult = await db.execute(sql`
      SELECT
        pc.id AS "componentId",
        jp.id AS "pageId",
        jp.title AS "pageTitle",
        jp.sort_order AS "pageOrder",
        j.id AS "journeyId",
        j.name AS "journeyName",
        j.slug AS "journeySlug",
        j.status AS "journeyStatus"
      FROM page_components pc
      JOIN journey_pages jp ON jp.id = pc.journey_page_id
      JOIN journeys j ON j.id = jp.journey_id AND j.tenant_id = ${user.tenantId}
      WHERE pc.component_type = 'banner' AND pc.component_id = ${id}
      ORDER BY j.name ASC, jp.sort_order ASC
    `);
    // Play usage (via journey_plays join)
    const playResult = await db.execute(sql`
      SELECT DISTINCT
        ap.id AS "playId",
        ap.name AS "playName",
        ap.status AS "playStatus"
      FROM page_components pc
      JOIN journey_pages jp ON jp.id = pc.journey_page_id
      JOIN journeys j ON j.id = jp.journey_id AND j.tenant_id = ${user.tenantId}
      JOIN journey_plays jpx ON jpx.journey_id = j.id
      JOIN abm_plays ap ON ap.id = jpx.play_id
      WHERE pc.component_type = 'banner' AND pc.component_id = ${id}
      ORDER BY ap.name ASC
    `);
    res.json({
      journeys: journeyResult.rows as any[],
      plays: playResult.rows as any[],
    });
  } catch (err) { next(err); }
});

router.get("/banners/:id", async (req, res, next): Promise<void> => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  try {
    const user = req.user as any;
    const result = await db.execute(sql`
      SELECT ${BANNER_SELECT}
      FROM banners b
      WHERE b.id = ${id} AND b.tenant_id = ${user.tenantId}
    `);
    const row = (result.rows as any[])[0];
    if (!row) { res.status(404).json({ error: "Banner not found" }); return; }
    res.json(row);
  } catch (err) { next(err); }
});

router.post("/banners", async (req, res, next): Promise<void> => {
  const parsed = BannerBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  try {
    const user = req.user as any;
    const d = parsed.data;
    const result = await db.execute(sql`
      INSERT INTO banners (
        tenant_id, name, position, zone, status,
        start_date, end_date,
        original_width, original_height, file_size, original_filename,
        config
      )
      VALUES (
        ${user.tenantId}, ${d.name}, ${d.position},
        ${d.zone ?? null}, ${d.status ?? "active"},
        ${d.start_date ?? null}, ${d.end_date ?? null},
        ${d.original_width ?? null}, ${d.original_height ?? null},
        ${d.file_size ?? null}, ${d.original_filename ?? null},
        ${JSON.stringify(d.config)}::jsonb
      )
      RETURNING ${BANNER_RETURNING}
    `);
    res.status(201).json((result.rows as any[])[0]);
  } catch (err) { next(err); }
});

router.patch("/banners/:id", async (req, res, next): Promise<void> => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const parsed = BannerBody.partial().safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  try {
    const user = req.user as any;
    const d = parsed.data;
    const result = await db.execute(sql`
      UPDATE banners SET
        name              = ${d.name              !== undefined ? d.name              : sql`name`},
        position          = ${d.position          !== undefined ? d.position          : sql`position`},
        zone              = ${d.zone              !== undefined ? d.zone              : sql`zone`},
        status            = ${d.status            !== undefined ? d.status            : sql`status`},
        start_date        = ${d.start_date        !== undefined ? d.start_date        : sql`start_date`},
        end_date          = ${d.end_date          !== undefined ? d.end_date          : sql`end_date`},
        original_width    = ${d.original_width    !== undefined ? d.original_width    : sql`original_width`},
        original_height   = ${d.original_height   !== undefined ? d.original_height   : sql`original_height`},
        file_size         = ${d.file_size         !== undefined ? d.file_size         : sql`file_size`},
        original_filename = ${d.original_filename !== undefined ? d.original_filename : sql`original_filename`},
        config            = ${d.config            !== undefined ? sql`${JSON.stringify(d.config)}::jsonb` : sql`config`}
      WHERE id = ${id} AND tenant_id = ${user.tenantId}
      RETURNING ${BANNER_RETURNING}
    `);
    const row = (result.rows as any[])[0];
    if (!row) { res.status(404).json({ error: "Banner not found" }); return; }
    res.json(row);
  } catch (err) { next(err); }
});

router.delete("/banners/:id", async (req, res, next): Promise<void> => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  try {
    const user = req.user as any;
    await db.execute(sql`DELETE FROM banners WHERE id = ${id} AND tenant_id = ${user.tenantId}`);
    res.sendStatus(204);
  } catch (err) { next(err); }
});

// ── Banner analytics ──────────────────────────────────────────────────────────
router.get("/banners/:id/analytics", async (req, res, next): Promise<void> => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  try {
    const user = req.user as any;
    const bannerCheck = await db.execute(sql`
      SELECT id FROM banners WHERE id = ${id} AND tenant_id = ${user.tenantId} LIMIT 1
    `);
    if ((bannerCheck.rows as any[]).length === 0) {
      res.status(404).json({ error: "Banner not found" }); return;
    }
    const result = await db.execute(sql`
      SELECT
        COUNT(*) FILTER (WHERE event_type = 'impression') AS impressions,
        COUNT(*) FILTER (WHERE event_type = 'click')      AS clicks,
        COUNT(*) FILTER (WHERE event_type = 'dismiss')    AS dismissals,
        COUNT(DISTINCT visitor_token) FILTER (WHERE event_type = 'impression' AND visitor_token IS NOT NULL) AS unique_visitors
      FROM banner_events
      WHERE banner_id = ${id}
    `);
    const row = (result.rows[0] as any) ?? {};
    const impressions = Number(row.impressions ?? 0);
    const clicks = Number(row.clicks ?? 0);
    const dismissals = Number(row.dismissals ?? 0);
    const uniqueVisitors = Number(row.unique_visitors ?? 0);
    const ctr = impressions > 0 ? Math.round((clicks / impressions) * 10000) / 100 : 0;
    res.json({ impressions, clicks, dismissals, uniqueVisitors, ctr });
  } catch (err) { next(err); }
});

// ── Journey Forms CRUD ────────────────────────────────────────────────────────

router.get("/journey-forms", async (req, res, next): Promise<void> => {
  try {
    const user = req.user as any;
    const result = await db.execute(sql`
      SELECT
        jf.id,
        jf.tenant_id AS "tenantId",
        jf.name,
        jf.config,
        jf.created_at AS "createdAt",
        COALESCE(s.submission_count, 0)::int AS "submissionCount"
      FROM journey_forms jf
      LEFT JOIN (
        SELECT form_id, COUNT(*)::int AS submission_count
        FROM form_submissions
        WHERE tenant_id = ${user.tenantId}
        GROUP BY form_id
      ) s ON s.form_id = jf.id
      WHERE jf.tenant_id = ${user.tenantId}
      ORDER BY jf.created_at DESC
    `);
    res.json(result.rows as any[]);
  } catch (err) { next(err); }
});

router.get("/journey-forms/:id", async (req, res, next): Promise<void> => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  try {
    const user = req.user as any;
    const result = await db.execute(sql`
      SELECT id, tenant_id AS "tenantId", name, config, created_at AS "createdAt"
      FROM journey_forms WHERE id = ${id} AND tenant_id = ${user.tenantId}
    `);
    const row = (result.rows as any[])[0];
    if (!row) { res.status(404).json({ error: "Form not found" }); return; }
    res.json(row);
  } catch (err) { next(err); }
});

router.post("/journey-forms", async (req, res, next): Promise<void> => {
  const parsed = JourneyFormBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  try {
    const user = req.user as any;
    const result = await db.execute(sql`
      INSERT INTO journey_forms (tenant_id, name, config)
      VALUES (${user.tenantId}, ${parsed.data.name}, ${JSON.stringify(parsed.data.config)}::jsonb)
      RETURNING id, tenant_id AS "tenantId", name, config, created_at AS "createdAt"
    `);
    res.status(201).json((result.rows as any[])[0]);
  } catch (err) { next(err); }
});

router.patch("/journey-forms/:id", async (req, res, next): Promise<void> => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const parsed = JourneyFormBody.partial().safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  try {
    const user = req.user as any;
    const { name, config } = parsed.data;
    const result = await db.execute(sql`
      UPDATE journey_forms SET
        name   = ${name   !== undefined ? name   : sql`name`},
        config = ${config !== undefined ? sql`${JSON.stringify(config)}::jsonb` : sql`config`}
      WHERE id = ${id} AND tenant_id = ${user.tenantId}
      RETURNING id, tenant_id AS "tenantId", name, config, created_at AS "createdAt"
    `);
    const row = (result.rows as any[])[0];
    if (!row) { res.status(404).json({ error: "Form not found" }); return; }
    res.json(row);
  } catch (err) { next(err); }
});

router.delete("/journey-forms/:id", async (req, res, next): Promise<void> => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  try {
    const user = req.user as any;
    await db.execute(sql`DELETE FROM journey_forms WHERE id = ${id} AND tenant_id = ${user.tenantId}`);
    res.sendStatus(204);
  } catch (err) { next(err); }
});

// ── Form Submissions ──────────────────────────────────────────────────────────

router.get("/journey-forms/:id/submissions", async (req, res, next): Promise<void> => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  try {
    const user = req.user as any;

    const formRow = await db.execute(sql`
      SELECT id, name FROM journey_forms WHERE id = ${id} AND tenant_id = ${user.tenantId}
    `);
    if (!(formRow.rows as any[])[0]) { res.status(404).json({ error: "Form not found" }); return; }

    // Parse and validate filter params
    const search = ((req.query.search as string) ?? "").trim();
    const from = (req.query.from as string) ?? "";
    const to = (req.query.to as string) ?? "";
    const journeyIdFilter = parseInt(req.query.journeyId as string) || 0;
    const searchPat = `%${search}%`;

    const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
    if (from && (!ISO_DATE.test(from) || isNaN(Date.parse(from)))) {
      res.status(400).json({ error: "Invalid 'from' date — expected YYYY-MM-DD" }); return;
    }
    if (to && (!ISO_DATE.test(to) || isNaN(Date.parse(to)))) {
      res.status(400).json({ error: "Invalid 'to' date — expected YYYY-MM-DD" }); return;
    }

    const statsRow = await db.execute(sql`
      WITH page_views_cte AS (
        SELECT COALESCE(COUNT(ae.id), 0)::int AS page_views
        FROM activity_events ae
        WHERE ae.event_type = 'page_view'
          AND ae.tenant_id = ${user.tenantId}
          AND ae.journey_id IN (
            SELECT DISTINCT jp.journey_id
            FROM page_components pc
            JOIN journey_pages jp ON jp.id = pc.journey_page_id
            WHERE pc.component_type = 'form' AND pc.component_id = ${id}
          )
      )
      SELECT
        COUNT(fs.id)::int                                                    AS total,
        COUNT(DISTINCT fs.contact_id)::int                                   AS unique_contacts,
        COUNT(CASE WHEN fs.submitted_at >= NOW() - INTERVAL '7 days' THEN 1 END)::int AS last_7d,
        COUNT(CASE WHEN fs.submitted_at >= NOW() - INTERVAL '30 days' THEN 1 END)::int AS last_30d,
        (SELECT page_views FROM page_views_cte)                              AS page_views,
        CASE
          WHEN (SELECT page_views FROM page_views_cte) > 0
          THEN ROUND(COUNT(fs.id)::numeric / (SELECT page_views FROM page_views_cte) * 100, 1)
          ELSE NULL
        END AS conversion_rate
      FROM form_submissions fs
      WHERE fs.form_id = ${id} AND fs.tenant_id = ${user.tenantId}
    `);

    const overTimeRows = await db.execute(sql`
      SELECT
        DATE_TRUNC('day', submitted_at)::date AS day,
        COUNT(*)::int AS count
      FROM form_submissions
      WHERE form_id = ${id} AND tenant_id = ${user.tenantId}
        AND submitted_at >= NOW() - INTERVAL '30 days'
      GROUP BY 1 ORDER BY 1
    `);

    // Distinct journeys that have submissions for this form (for filter dropdown)
    const journeysRows = await db.execute(sql`
      SELECT DISTINCT j.id, j.name
      FROM form_submissions fs
      JOIN journeys j ON j.id = fs.journey_id
      WHERE fs.form_id = ${id} AND fs.tenant_id = ${user.tenantId}
      ORDER BY j.name
    `);

    const submissionsRows = await db.execute(sql`
      SELECT
        fs.id,
        fs.submitted_at AS "submittedAt",
        fs.visitor_token AS "visitorToken",
        fs.field_values AS "fieldValues",
        fs.action_type AS "actionType",
        fs.journey_id AS "journeyId",
        fs.page_id AS "pageId",
        c.id AS "contactId",
        c.first_name AS "firstName",
        c.last_name AS "lastName",
        c.email,
        c.tags,
        c.lead_score AS "leadScore",
        j.name AS "journeyName"
      FROM form_submissions fs
      LEFT JOIN contacts c ON c.id = fs.contact_id
      LEFT JOIN journeys j ON j.id = fs.journey_id
      WHERE fs.form_id = ${id} AND fs.tenant_id = ${user.tenantId}
        ${search ? sql`AND (c.first_name ILIKE ${searchPat} OR c.last_name ILIKE ${searchPat} OR c.email ILIKE ${searchPat})` : sql``}
        ${from ? sql`AND fs.submitted_at >= ${from}::date` : sql``}
        ${to ? sql`AND fs.submitted_at < (${to}::date + INTERVAL '1 day')` : sql``}
        ${journeyIdFilter ? sql`AND fs.journey_id = ${journeyIdFilter}` : sql``}
      ORDER BY fs.submitted_at DESC
      LIMIT 200
    `);

    res.json({
      form: (formRow.rows as any[])[0],
      stats: (statsRow.rows as any[])[0],
      overTime: overTimeRows.rows as any[],
      journeys: journeysRows.rows as any[],
      submissions: submissionsRows.rows as any[],
    });
  } catch (err) { next(err); }
});

router.get("/journey-forms/:id/submissions/export", async (req, res, next): Promise<void> => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  try {
    const user = req.user as any;

    const formRow = await db.execute(sql`
      SELECT name FROM journey_forms WHERE id = ${id} AND tenant_id = ${user.tenantId}
    `);
    if (!(formRow.rows as any[])[0]) { res.status(404).json({ error: "Form not found" }); return; }
    const formName = (formRow.rows as any[])[0].name as string;

    const rows = await db.execute(sql`
      SELECT
        fs.submitted_at,
        c.first_name,
        c.last_name,
        c.email,
        c.lead_score,
        array_to_string(c.tags, ', ') AS tags,
        j.name AS journey_name,
        fs.field_values
      FROM form_submissions fs
      LEFT JOIN contacts c ON c.id = fs.contact_id
      LEFT JOIN journeys j ON j.id = fs.journey_id
      WHERE fs.form_id = ${id} AND fs.tenant_id = ${user.tenantId}
      ORDER BY fs.submitted_at DESC
    `);

    // Sanitize a cell value: prevent spreadsheet formula injection by prefixing
    // risky leading characters with a tab, then escape inner quotes for CSV.
    function csvCell(raw: unknown): string {
      const s = raw == null ? "" : typeof raw === "object" ? JSON.stringify(raw) : String(raw);
      const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
      return `"${safe.replace(/"/g, '""')}"`;
    }

    const headers = ["Submitted At", "First Name", "Last Name", "Email", "Lead Score", "Tags", "Journey", "Field Values"];
    const csv = [
      headers.join(","),
      ...(rows.rows as any[]).map(r =>
        [
          r.submitted_at,
          r.first_name ?? "",
          r.last_name ?? "",
          r.email ?? "",
          r.lead_score ?? "",
          r.tags ?? "",
          r.journey_name ?? "",
          r.field_values ?? {},
        ].map(csvCell).join(",")
      ),
    ].join("\n");

    const slug = formName.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="${slug}-submissions.csv"`);
    res.send(csv);
  } catch (err) { next(err); }
});

router.post("/journey-forms/:id/test-confirmation-email", async (req, res, next): Promise<void> => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  try {
    const user = req.user as any;

    const formRow = await db.execute(sql`
      SELECT name, config FROM journey_forms WHERE id = ${id} AND tenant_id = ${user.tenantId}
    `);
    const form = (formRow.rows as any[])[0];
    if (!form) { res.status(404).json({ error: "Form not found" }); return; }

    const config = form.config as any;

    const adminEmail = user.email as string | undefined;
    if (!adminEmail) {
      res.status(400).json({ error: "Your account does not have an email address" }); return;
    }

    const formName = form.name as string;

    // Accept editor-state overrides from the request body so unsaved edits are reflected
    const OverrideSchema = z.object({
      subject: z.string().optional(),
      body: z.string().optional(),
      deliveryAssetId: z.number().int().nullable().optional(),
      to: z.string().email().optional(),
    });
    const overrideParsed = OverrideSchema.safeParse(req.body);
    if (!overrideParsed.success) {
      res.status(400).json({ error: "Invalid request body", details: overrideParsed.error.message }); return;
    }
    const override = overrideParsed.data;

    // Fall back to saved config values
    const confirmationEmail = config?.confirmationEmail as
      | { subject?: string; body?: string }
      | undefined;
    const savedDeliveryAssetId = config?.onSubmit?.deliveryAssetId as number | null | undefined;

    const rawSubjectSrc = override.subject ?? confirmationEmail?.subject ?? "";
    const rawBodySrc = override.body ?? confirmationEmail?.body ?? "";
    const effectiveDeliveryAssetId = override.deliveryAssetId !== undefined
      ? override.deliveryAssetId
      : savedDeliveryAssetId;

    const { subject, bodyHtml: fullHtml } = buildConfirmationEmailParts({
      rawSubjectSrc,
      rawBodySrc,
      tokens: {
        firstName: "Alex",
        lastName: "Smith",
        email: adminEmail,
        phone: "+1 555 0100",
        formName,
        thankYouTitle: config?.onSubmit?.thankYouTitle ?? "Thank you!",
        thankYouBody: config?.onSubmit?.thankYouBody ?? "",
      },
      deliveryAssetId: effectiveDeliveryAssetId,
    });

    const recipientEmail = override.to ?? adminEmail;

    const sent = await sendEmail({
      to: recipientEmail,
      subject: `[Test] ${subject}`,
      html: fullHtml,
      tenantId: user.tenantId as number,
    });

    if (!sent) {
      res.status(502).json({ error: "Failed to send test email. Check your email integration settings." }); return;
    }

    res.json({ ok: true, sentTo: recipientEmail });
  } catch (err) { next(err); }
});

// ── Generate shareable preview token ─────────────────────────────────────────

router.post("/journey-forms/:id/generate-preview-token", async (req, res, next): Promise<void> => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  try {
    const user = req.user as any;
    const formRow = await db.execute(sql`
      SELECT id FROM journey_forms WHERE id = ${id} AND tenant_id = ${user.tenantId}
    `);
    if (!(formRow.rows as any[]).length) { res.status(404).json({ error: "Form not found" }); return; }
    const token = generateFormPreviewToken(id, user.tenantId as number);
    res.json({ token });
  } catch (err) { next(err); }
});

// ── Preview confirmation email HTML ───────────────────────────────────────────

router.get("/journey-forms/:id/preview-confirmation-email", async (req, res, next): Promise<void> => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).send("<p>Invalid id</p>"); return; }
  try {
    const user = req.user as any;

    const formRow = await db.execute(sql`
      SELECT name, config FROM journey_forms WHERE id = ${id} AND tenant_id = ${user.tenantId}
    `);
    const form = (formRow.rows as any[])[0];
    if (!form) { res.status(404).send("<p>Form not found</p>"); return; }

    const config = form.config as any;
    const formName = form.name as string;
    const confirmationEmail = config?.confirmationEmail as { subject?: string; body?: string } | undefined;

    const { subject: subjectResolved, bodyHtml: bodyBlock } = buildConfirmationEmailParts({
      rawSubjectSrc: confirmationEmail?.subject ?? "",
      rawBodySrc: confirmationEmail?.body ?? "",
      tokens: {
        firstName: "Alex",
        lastName: "Smith",
        email: "alex@example.com",
        phone: "+1 555 0100",
        formName,
        thankYouTitle: config?.onSubmit?.thankYouTitle ?? "Thank you!",
        thankYouBody: config?.onSubmit?.thankYouBody ?? "",
      },
      deliveryAssetId: config?.onSubmit?.deliveryAssetId as number | null | undefined,
    });

    const footer = buildUnsubscribeFooter("preview@example.com");

    const fullHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${subjectResolved}</title>
<style>
  body { margin: 0; padding: 0; background: #f3f4f6; }
  .email-preview-subject-bar {
    background: #1f2937;
    color: #f9fafb;
    font-family: system-ui, sans-serif;
    font-size: 12px;
    padding: 8px 24px;
  }
  .email-preview-subject-bar strong { color: #fff; }
  .email-wrapper {
    background: #ffffff;
    max-width: 600px;
    margin: 0 auto;
  }
</style>
</head>
<body>
<div class="email-preview-subject-bar">
  <strong>Subject:</strong> ${subjectResolved.replace(/</g, "&lt;").replace(/>/g, "&gt;")}
</div>
<div class="email-wrapper">
  ${bodyBlock}
  <div style="font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;padding:0 24px 16px;">
    ${footer}
  </div>
</div>
</body>
</html>`;

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.send(fullHtml);
  } catch (err) { next(err); }
});

export default router;
