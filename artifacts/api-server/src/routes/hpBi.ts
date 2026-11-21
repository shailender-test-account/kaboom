import { Router, type IRouter } from "express";
import multer from "multer";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { pool } from "@workspace/db";
import { requireAuth, requireRole } from "../middlewares/requireAuth";
import { activityKinds, accountDimensions, hpContextFields, hpDimensions, importHpWorkbook, importAccountRows, isHpClient, previewHpImportAsync, previewHpAccountImpact, readHpWorkbookAsync, recordFromRow, saveHpRecord, text, ensureHpAccountRegister } from "../lib/hpBiImport";
import { claimHpWorkbookSlot } from "../lib/hpWorkbookAsync";
import { loadHpBi, type HpFilters } from "../lib/hpBiMetrics";
import { HP_ACCOUNT_SORT_FIELDS } from "../lib/hpAccountSort";
import { GetHpParentHeatmapQueryParams } from "@workspace/api-zod";
import { loadParentHeatmap } from "../lib/hpParentHeatmap";
import { captureHpLead } from "../lib/hpBiLeads";
import { inboundCategories } from "../lib/inboundTaxonomy";
import { registerHpMappingPresets } from "./hpMappingPresets";
import { mappingErrors } from "../lib/hpMappingValidation";
import { registerHpAccountManagement } from "./hpAccountManagement";
import { registerHpParentPivot } from "./hpParentPivot";
import { associateHpRoster, loadHpRosterAnalysis } from "../lib/hpRosterAnalysis";
import { UpdateHpRosterAssociationBody } from "@workspace/api-zod";
import { GetHpWarmRoutingStatusQueryParams, GetHpWarmRoutingStatusResponse } from "@workspace/api-zod";
import { loadHpWarmRoutingStatus } from "../lib/hpWarmRoutingStatus";
import { hpRoutingOptions } from "./hpAccountManagement";

const router: IRouter = Router();
router.use("/analytics/hp-bi", requireAuth);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 24 * 1024 * 1024, files: 1 } });
const filtersSchema = z.object({
  clientId: z.coerce.number().int().positive(), year: z.coerce.number().int().min(2000).max(2100).default(2027),
  segment: z.string().max(100).optional(), rad: z.enum(["Retention", "Acquisition", "Development", "Unknown"]).optional(),
  basis: z.enum(["PS", "Print", "ps", "print"]).optional(), search: z.string().max(200).optional(),
  newOnly: z.enum(["true", "1"]).optional().transform(Boolean), abmOnly: z.enum(["true", "1"]).optional().transform(Boolean),
  incompleteOnly: z.enum(["true", "1"]).optional().transform(Boolean),
  groupResponses: z.enum(["true", "1"]).optional().transform(Boolean),
  page: z.coerce.number().int().min(1).max(10000).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(25),
  sortBy: z.enum(HP_ACCOUNT_SORT_FIELDS).optional(), sortDir: z.enum(["asc", "desc"]).optional(),
  sortCurrency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/).optional(),
  qualification: z.enum(["Hot","Warm","Cold"]).optional(),
  gtmSource: z.enum(["lead_form", "event_feedback"]).optional(),
  monitoring: z.enum(["never", "overdue"]).optional(),
  parentKey: z.string().max(200).optional(),
  salesPerson: z.string().trim().max(320).optional(),
  opportunity: z.enum(["Business Services", "Business Collaboration", "IT Hardware", "Security"]).optional(),
  dimension: z.enum(Object.keys(hpDimensions) as [string, ...string[]]).optional(), dimensionValue: z.string().max(200).optional(),
  month: z.coerce.number().int().min(1).max(12).optional(), quarter: z.coerce.number().int().min(1).max(4).optional(),
  kind: z.string().max(50).optional(), category: z.string().max(200).optional(),
});
async function scope(req: any, input = req.query) {
  const parsed = filtersSchema.safeParse(input);
  if (!parsed.success) throw Object.assign(new Error(parsed.error.message), { status: 400 });
  const tenantId = Number(req.user.tenantId);
  if (!await isHpClient(tenantId, parsed.data.clientId)) throw Object.assign(new Error("Select a tenant-owned HP client."), { status: 404 });
  return { tenantId, filters: parsed.data as HpFilters };
}
const fail = (req: any, res: any, err: any) => {
  req.log.warn({ err }, "HP BI request failed");
  res.status(err.status ?? (err instanceof z.ZodError ? 400 : 500)).json({ error: err.status || err instanceof z.ZodError ? err.message : "HP BI operation failed. Review the file or server logs." });
};
registerHpMappingPresets(router, scope, fail);
router.get("/analytics/hp-bi/warm-routing", async (req, res): Promise<void> => {
  // This operational view is strictly admin-only, not delegated section access.
  if ((req.user as any).role !== "admin") { res.status(403).json({ error: "Admin access required." }); return; }
  try {
    const input = GetHpWarmRoutingStatusQueryParams.parse(req.query);
    const { tenantId } = await scope(req);
    const result = await loadHpWarmRoutingStatus(tenantId, input.clientId, input.status, input.after ?? "");
    const choices = await hpRoutingOptions(tenantId,input.clientId);
    // pg timestamps are Dates; the HTTP contract uses ISO strings.
    res.json(GetHpWarmRoutingStatusResponse.parse(JSON.parse(JSON.stringify({
      ...result,journeyOptions:choices.journeyOptions.filter(j => j.status==="published"),
      sequenceOptions:choices.sequenceOptions.filter(s => s.status==="active"),
      outreachPaused:process.env.COPIED_DATA_SAFE_MODE==="true",
    }))));
  } catch (err) { fail(req, res, err); }
});
router.get("/analytics/hp-bi/roster-analysis", async (req, res) => {
  try {
    const { tenantId, filters } = await scope(req);
    await ensureHpAccountRegister(tenantId, filters.clientId);
    res.json(await loadHpRosterAnalysis(tenantId, filters.clientId));
  } catch (err) { fail(req, res, err); }
});
router.post("/analytics/hp-bi/roster-analysis", requireRole("admin"), async (req, res) => {
  try {
    const body = UpdateHpRosterAssociationBody.parse(req.body);
    if (body.confirm !== true) throw Object.assign(new Error("Explicit reporting-link confirmation is required."), { status: 400 });
    const { tenantId, filters } = await scope(req, body);
    res.json(await associateHpRoster(tenantId, filters.clientId, body.sourceAccountId, body.targetAccountId,
      body.expectedTargetAccountId, Number((req.user as any).id) || null));
  } catch (err) { fail(req, res, err); }
});
router.get("/analytics/hp-bi/account-register", async (req, res) => {
  try {
    const { tenantId, filters } = await scope(req);
    await ensureHpAccountRegister(tenantId, filters.clientId);
    const params = [tenantId, filters.clientId, filters.search?.trim() || null];
    const from = `FROM hp_account_profiles p JOIN companies c
      ON c.id=p.company_id AND c.tenant_id=p.tenant_id AND c.client_id=p.client_id
      WHERE p.tenant_id=$1 AND p.client_id=$2
      AND ($3::text IS NULL OR position(lower($3) in lower(concat_ws(' ',c.name,p.hp_id,p.parent_name)))>0)`;
    const [count, rows] = await Promise.all([
      pool.query(`SELECT count(*)::int total ${from}`, params),
      pool.query(`SELECT p.company_id AS "companyId",c.name,p.hp_id AS "hpId",
        p.parent_key AS "parentKey",p.parent_name AS "parentName",
        COALESCE(p.top_200,false) AS "top200",p.abm_classification AS "abmClassification"
        ${from} ORDER BY lower(c.name),p.company_id LIMIT $4 OFFSET $5`,
        [...params, filters.pageSize, (filters.page - 1) * filters.pageSize]),
    ]);
    res.json({ items: rows.rows, total: count.rows[0].total, page: filters.page, pageSize: filters.pageSize });
  } catch (err) { fail(req, res, err); }
});
registerHpAccountManagement(router, scope, fail);
registerHpParentPivot(router, scope, fail);
router.get("/analytics/hp-bi/heatmap", async (req, res) => {
  try {
    const input = GetHpParentHeatmapQueryParams.parse(req.query);
    const s = await scope(req);
    res.json(await loadParentHeatmap(s.tenantId, s.filters, input.metric));
  } catch (err) { fail(req, res, err); }
});
router.get("/analytics/hp-bi/filter-options", async (req, res) => {
  try {
    const { tenantId, filters } = await scope(req);
    await ensureHpAccountRegister(tenantId, filters.clientId);
    const result = await pool.query(`SELECT DISTINCT lower(trim(person.email)) AS email
      FROM hp_account_profiles p JOIN companies c
        ON c.id=p.company_id AND c.tenant_id=p.tenant_id AND c.client_id=p.client_id
      CROSS JOIN LATERAL unnest(ARRAY[p.eam_email,p.pam_email,p.rm_email,p.isr_email,p.zm_email,p.poly_am_email,p.poly_mgr_email]) person(email)
      WHERE p.tenant_id=$1 AND p.client_id=$2 AND trim(COALESCE(person.email,''))<>''
        AND trim(person.email) !~* '^(?:-|n/?a|none|null|unassigned|not assigned)$'
      ORDER BY email`, [tenantId, filters.clientId]);
    res.json({ salesPeople: result.rows.map(row => row.email) });
  } catch (err) { fail(req, res, err); }
});
router.get("/analytics/hp-bi", async (req, res) => {
  try { const s = await scope(req); res.json(await loadHpBi(s.tenantId, s.filters)); } catch (err) { fail(req, res, err); }
});
router.get("/analytics/hp-bi/account", async (req, res) => {
  try {
    const s = await scope(req);
    if (!s.filters.parentKey) { res.status(400).json({ error: "parentKey required" }); return; }
    const result = await loadHpBi(s.tenantId, s.filters, true);
    if (!(result as any).account) { res.status(404).json({ error: "Account not found in selected scope" }); return; }
    res.json(result);
  } catch (err) { fail(req, res, err); }
});
router.get("/analytics/hp-bi/evidence", async (req, res) => {
  try { const s = await scope(req); res.json(await loadHpBi(s.tenantId, s.filters, "evidence")); } catch (err) { fail(req, res, err); }
});
const csvCell = (v: unknown) => {
  const s = typeof v === "object" && v !== null ? JSON.stringify(v) : text(v);
  return `"${(/^[=+\-@\t\r]/.test(s) ? "'" : "") + s.replace(/"/g, '""')}"`;
};
function csv(rows: Record<string, unknown>[], headers: string[]) {
  return "\uFEFF" + [headers.map(csvCell).join(","), ...rows.map(r => headers.map(h => csvCell(r[h])).join(","))].join("\r\n");
}
router.get("/analytics/hp-bi/export", async (req, res) => {
  try {
    const s = await scope(req);
    const result: any = await loadHpBi(s.tenantId, { ...s.filters, page: 1, pageSize: Number.MAX_SAFE_INTEGER });
    res.type("text/csv").attachment(`HP-FY${s.filters.year}-accounts.csv`).send(csv(result.accounts,
       ["name", "hpId", "parentKey", "journeys", "pendingJourneyRoutes", "failedJourneyRoutes", "unavailableJourneyRoutes", "segment", "rad", "memberCount", "isNew", "incompleteMembers", "missingFields", "gtm", "status", "priority", "contacts", "engagedContacts", "touchpoints", "leads", "hot", "warm", "opportunities", "values", "closedWon", "closedLost", "prospectiveValues", "bookedValues", "crmReferences", "score", "categories"]));
  } catch (err) { fail(req, res, err); }
});
router.get("/analytics/hp-bi/template", async (req, res) => {
  try {
    await scope({ ...req, query: { clientId: req.query.clientId } });
    const kind = z.enum(["accounts", "activities"]).parse(req.query.kind);
    const headers = kind === "accounts" ? [...Object.values(hpDimensions), ...Object.values(hpContextFields)] : ["recordId", "hpId", "accountName", "email", "kind", "occurredAt", "category", "product", "horizonMonths", "orderValue", "currency", "sourceName", "status", "externalEventId"];
    res.type("text/csv").attachment(`HP-${kind}-template.csv`).send(csv([], headers));
  } catch (err) { fail(req, res, err); }
});
for (const path of ["preview", "commit"]) {
  router.post(`/analytics/hp-bi/import${path === "preview" ? "/preview" : ""}`, requireRole("admin"), upload.single("file"), async (req, res) => {
    let release: (() => void) | undefined;
    try {
      const s = await scope(req);
      if (!req.file) { res.status(400).json({ error: "Upload an Excel or CSV file." }); return; }
      const kind = z.enum(["accounts", "activities"]).parse(req.body.kind);
      let rawMappings;
      try { rawMappings = JSON.parse(req.body.mappings || "{}"); }
      catch { res.status(400).json({ error: "Mappings must be valid JSON." }); return; }
      const mappings = z.record(z.string().min(1).max(500), z.string().min(1).max(500)).parse(rawMappings);
      if (Object.keys(mappings).length > 256) { res.status(400).json({ error: "At most 256 mappings are supported." }); return; }
      release = claimHpWorkbookSlot();
      const parsed = await readHpWorkbookAsync(req.file.buffer, kind, mappings);
      const preview = await previewHpImportAsync(req.file.buffer, kind, mappings, parsed);
      preview.errors.unshift(...mappingErrors(kind, preview.headers, mappings));
      if (path === "preview") res.json({ ...preview, ...(kind === "accounts" && !preview.errors.length
        ? { impact: await previewHpAccountImpact(s.tenantId, s.filters.clientId, req.file.buffer, mappings, parsed) } : {}) });
      else {
        if (preview.errors.length) { res.status(422).json({ error: preview.errors.join("\n") }); return; }
        if (kind === "accounts" && req.body.confirmAccounts !== "true") {
          res.status(422).json({ error: "Review the account-impact preview and explicitly approve this roster import." }); return;
        }
        res.json(await importHpWorkbook(s.tenantId, s.filters.clientId, req.file.buffer, req.file.originalname, kind, mappings, Number((req.user as any).id), parsed));
      }
    } catch (err) { fail(req, res, err); }
    finally { release?.(); }
  });
}
router.get("/analytics/hp-bi/imports", async (req, res) => {
  try { const s = await scope(req); res.json((await pool.query(`SELECT id,file_name AS "fileName",kind,rows,accounts,imported_at AS "importedAt",result
    FROM hp_bi_imports WHERE tenant_id=$1 AND client_id=$2 ORDER BY id DESC LIMIT 100`, [s.tenantId, s.filters.clientId])).rows); } catch (err) { fail(req, res, err); }
});
router.get("/analytics/hp-bi/matches", async (req, res) => {
  try { const s = await scope(req); res.json((await pool.query(`SELECT id,reason,payload,created_at AS "createdAt" FROM hp_bi_matches
    WHERE tenant_id=$1 AND client_id=$2 AND resolved_account_id IS NULL ORDER BY id LIMIT 100`, [s.tenantId, s.filters.clientId])).rows); } catch (err) { fail(req, res, err); }
});
router.get("/analytics/hp-bi/account-search", async (req, res) => {
  try {
    const s = await scope(req);
    res.json((await pool.query(`SELECT p.company_id id,c.name,p.hp_id AS "hpId" FROM hp_account_profiles p
      JOIN companies c ON c.id=p.company_id AND c.tenant_id=p.tenant_id AND c.client_id=p.client_id
      WHERE p.tenant_id=$1 AND p.client_id=$2 AND ($3='' OR c.name ILIKE '%'||$3||'%' OR p.hp_id=$3)
      ORDER BY c.name,p.company_id LIMIT 50`, [s.tenantId, s.filters.clientId, s.filters.search ?? ""])).rows);
  } catch (err) { fail(req, res, err); }
});
router.post("/analytics/hp-bi/matches/:id", requireRole("admin"), async (req, res) => {
  let client;
  try {
    const s = await scope(req);
    const id = z.coerce.number().int().positive().parse(req.params.id);
    const accountId = z.coerce.number().int().positive().parse(req.body.accountId);
    const category = req.body.reportingCategory === undefined ? null
      : z.enum(inboundCategories as [string, ...string[]]).parse(req.body.reportingCategory);
    client = await pool.connect(); await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1::int,914357)", [s.tenantId]);
    const match = (await client.query(`SELECT * FROM hp_bi_matches WHERE id=$1 AND tenant_id=$2 AND client_id=$3 AND resolved_account_id IS NULL FOR UPDATE`,
      [id, s.tenantId, s.filters.clientId])).rows[0];
    const owned = (await client.query("SELECT id FROM companies WHERE id=$1 AND tenant_id=$2 AND client_id=$3", [accountId, s.tenantId, s.filters.clientId])).rows[0];
    if (!match || !owned) throw Object.assign(new Error("Match or target account not found"), { status: 404 });
    if (match.payload.roster === true) {
      const hpId = text(match.payload.values?.hp_id);
      const current = (await client.query("SELECT hp_id FROM hp_account_profiles WHERE tenant_id=$1 AND client_id=$2 AND company_id=$3",
        [s.tenantId, s.filters.clientId, accountId])).rows[0];
      if (hpId && current?.hp_id && current.hp_id !== hpId)
        throw Object.assign(new Error("The selected CRM account already has a different HP ID. This review cannot merge or replace legal identities."), { status: 409 });
      await client.query("SELECT pg_advisory_xact_lock($1::int,$2::int)", [s.tenantId, s.filters.clientId]);
      await client.query("UPDATE hp_bi_matches SET resolved_account_id=$2 WHERE id=$1", [id, accountId]);
      const variants = match.payload.values?.variants;
      if (!hpId || !Array.isArray(variants) || !variants.length)
        throw Object.assign(new Error("Source roster rows are missing; upload the workbook again."), { status: 422 });
      const result = await importAccountRows(client, s.tenantId, s.filters.clientId, variants.map((v: any) => ({
        sheet: v._source?.sheet ?? "Reviewed roster", row: v._source?.row ?? 1, values: v,
      })), text(match.payload.fileName) || "Reviewed roster");
      if (result.unresolved) throw Object.assign(new Error("The reviewed identity still conflicts with another source account."), { status: 409 });
    } else if (match.payload.values) {
      const raw = match.payload.values;
      if (/Unknown reporting category/.test(match.reason) && !category)
        throw Object.assign(new Error("Select a saved reporting category before resolving this row."), { status: 422 });
      const email = text(raw.email).toLowerCase();
      const contactRows = email ? (await client.query(`SELECT id FROM contacts WHERE tenant_id=$1 AND client_id=$2 AND company_id=$3 AND lower(btrim(email))=$4 AND NOT is_anonymous`,
        [s.tenantId, s.filters.clientId, accountId, email])).rows : [];
      if (email && contactRows.length !== 1) throw Object.assign(new Error("Resolve the contact email identity in CRM first. Account review cannot reassign an owned contact."), { status: 409 });
      await saveHpRecord(client, s.tenantId, s.filters.clientId, accountId, contactRows[0]?.id ?? null,
        recordFromRow({ ...raw, ...(category ? { category } : {}) }), "excel", match.source_key, match.payload);
    } else {
      const p = match.payload;
      if (p.contactId) {
        const owner = (await client.query("SELECT company_id,client_id,is_anonymous FROM contacts WHERE tenant_id=$1 AND id=$2", [s.tenantId, p.contactId])).rows[0];
        if (!owner || owner.is_anonymous || owner.company_id && Number(owner.company_id) !== accountId || owner.client_id && Number(owner.client_id) !== s.filters.clientId)
          throw Object.assign(new Error("Conflicting contact owner. Use the existing identity review workflow; this action cannot move contacts."), { status: 409 });
      }
      await captureHpLead(client, { ...p, tenantId: s.tenantId, clientId: s.filters.clientId, accountId });
    }
    await client.query(`UPDATE hp_bi_matches SET resolved_account_id=$2,
      payload=CASE WHEN $3::text IS NOT NULL THEN payload || jsonb_build_object('correctedCategory',$3::text) ELSE payload END WHERE id=$1`, [id, accountId, category]);
    await client.query("COMMIT"); res.json({ resolved: true });
  } catch (err) { if (client) await client.query("ROLLBACK"); fail(req, res, err); }
  finally { client?.release(); }
});
const profileBody = z.object({
  abmClassification: z.string().max(200).nullable().optional(), top200: z.boolean().optional(),
  buyingBehavior: z.string().max(2000).nullable().optional(), propensity: z.string().max(2000).nullable().optional(),
  globalAccount: z.boolean().nullable().optional(), profiled: z.boolean().nullable().optional(),
  buyerCategories: z.array(z.string().min(1).max(200)).max(100).optional(),
  whitespaceCategories: z.array(z.string().min(1).max(200)).max(100).optional(),
  dimensions: z.record(z.string(), z.union([z.string(), z.number(), z.null()])).optional(),
}).strict();
router.patch("/analytics/hp-bi/profiles/:companyId", requireRole("admin"), async (req, res) => {
  try {
    const s = await scope(req), companyId = z.coerce.number().int().positive().parse(req.params.companyId), body = profileBody.parse(req.body);
    const existing = (await pool.query("SELECT * FROM hp_account_profiles WHERE tenant_id=$1 AND client_id=$2 AND company_id=$3", [s.tenantId, s.filters.clientId, companyId])).rows[0];
    if (!existing) { res.status(404).json({ error: "Account not found" }); return; }
    const buyers = body.buyerCategories ?? existing.buyer_categories, whitespace = body.whitespaceCategories ?? existing.whitespace_categories;
    if (buyers.some((c: string) => whitespace.includes(c))) {
      res.status(422).json({ error: "A category cannot be both a current buyer and confirmed whitespace." }); return;
    }
    const names: Record<string, string> = { abmClassification: "abm_classification", top200: "top_200", buyingBehavior: "buying_behavior", propensity: "propensity", globalAccount: "global_account",
      profiled: "profiled", buyerCategories: "buyer_categories", whitespaceCategories: "whitespace_categories" };
    const params: unknown[] = [s.tenantId, s.filters.clientId, companyId], sets: string[] = [];
    Object.entries(body).forEach(([k, v]) => {
      if (k === "dimensions") {
        if (Object.keys(v as object).some(key => key.startsWith("_"))) {
          throw Object.assign(new Error("Internal roster metadata is read-only; use the reviewed mapping controls."), { status: 400 });
        }
        const dimensions = { ...existing.dimensions, ...(v as object) };
        // Identity/hierarchy changes require re-import so they cannot silently reparent records.
        const restricted = ["hp_id", "top_id", "top_name", "mid_id", "mid_name", "act_st", "st_name", "partial_st", "partial_name", "legal_name"];
        for (const key of restricted) if (Object.keys(v as object).some(label => label === key || label === hpDimensions[key]))
          throw Object.assign(new Error("Change stable identity or hierarchy through a reviewed account import."), { status: 422 });
        params.push(JSON.stringify(dimensions)); sets.push(`dimensions=$${params.length}::jsonb`);
        const normalized = accountDimensions(dimensions);
        for (const [key, value] of Object.entries(normalized)) {
          if (restricted.includes(key)) continue;
          params.push(value); sets.push(`${key}=$${params.length}`);
        }
      } else { params.push(v); sets.push(`${names[k]}=$${params.length}`); }
    });
    if (!sets.length) { res.status(400).json({ error: "No changes supplied" }); return; }
    params.push(JSON.stringify([{ changedAt: new Date().toISOString(), userId: (req.user as any).id, values: body }]));
    sets.push(`edits=edits || $${params.length}::jsonb`);
    await pool.query(`UPDATE hp_account_profiles SET ${sets.join(",")},updated_at=now()
      WHERE tenant_id=$1 AND client_id=$2 AND company_id=$3`, params);
    res.json({ updated: true });
  } catch (err) { fail(req, res, err); }
});
const recordBody = z.object({
  accountId: z.coerce.number().int().positive(), contactId: z.coerce.number().int().positive().nullable().optional(),
  kind: z.enum(activityKinds as [string, ...string[]]), occurredAt: z.string().refine(s => Number.isFinite(Date.parse(s)), "Valid occurrence date required"),
  category: z.string().max(200).optional(), product: z.string().max(500).optional(),
  horizonMonths: z.number().nonnegative().nullable().optional(), orderValue: z.number().nonnegative().nullable().optional(),
  currency: z.string().regex(/^[A-Za-z]{3}$/).optional(), sourceName: z.string().max(500).optional(), status: z.string().max(100).optional(),
}).strict();
router.post("/analytics/hp-bi/records", requireRole("admin"), async (req, res) => {
  try {
    const s = await scope(req), b = recordBody.parse(req.body);
    const owned = (await pool.query("SELECT 1 FROM hp_account_profiles WHERE tenant_id=$1 AND client_id=$2 AND company_id=$3", [s.tenantId, s.filters.clientId, b.accountId])).rowCount;
    if (!owned) { res.status(404).json({ error: "Account not found" }); return; }
    if (b.contactId && !(await pool.query("SELECT 1 FROM contacts WHERE tenant_id=$1 AND client_id=$2 AND company_id=$3 AND id=$4 AND NOT is_anonymous",
      [s.tenantId, s.filters.clientId, b.accountId, b.contactId])).rowCount) { res.status(422).json({ error: "Contact does not belong to this account" }); return; }
    await saveHpRecord(pool, s.tenantId, s.filters.clientId, b.accountId, b.contactId ?? null, recordFromRow(b), "manual", `manual:${randomUUID()}`, { enteredBy: (req.user as any).id });
    res.status(201).json({ created: true });
  } catch (err) { fail(req, res, err); }
});
export default router;
