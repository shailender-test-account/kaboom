import { Router, type IRouter } from "express";
import { permittedClientIds } from "../lib/requestClientScope";
import { z } from "zod";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { pool } from "@workspace/db";
import { requireAuth, requireRole } from "../middlewares/requireAuth";
import { apolloCommitteeConfig, approveCommitteePlan, committeeAccounts, committeeCategories, committeeError,
  committeePlan, committeePlanSchema, copyCommitteePlan, designationSuggestions, requireHpCommitteeClient, saveCommitteePlan } from "../lib/buyingCommittee";
import { readCommitteeContacts } from "../lib/buyingCommitteeContacts";
import { committeeCountries } from "../lib/buyingCommitteeCountry";
import { exportCommitteeCsv } from "../lib/buyingCommitteeExport";
import { startCommitteeExportAudit, finishCommitteeExportAudit, type ExportOutcome } from "../lib/buyingCommitteeExportAudit";
import { CopyBuyingCommitteePlanParams, CopyBuyingCommitteePlanResponse, ExportBuyingCommitteeContactsQueryParams, LookupBuyingCommitteeDomainBody, LookupBuyingCommitteeDomainResponse } from "@workspace/api-zod";
import { lookupCommitteeDomain } from "../lib/buyingCommitteeDomains";
import { sourceCommitteeAccount } from "../lib/buyingCommitteeApollo";
import { SaveBuyingCommitteeContactBody, SaveBuyingCommitteeContactResponse } from "@workspace/api-zod";
import { saveCommitteeContact } from "../lib/buyingCommitteeSaveContact";
import { hasManageGrant } from "@workspace/api-zod";

const router: IRouter = Router();
router.use("/buying-committee", requireAuth);
const positive = z.coerce.number().int().positive().max(2147483647);
const ids = z.string().max(12000).optional().transform(v => v ? v.split(",").map(Number) : [])
  .pipe(z.array(z.number().int().positive()).max(1000));
const pageSchema = z.object({ page: positive.max(10000).default(1) });
function user(req: any) { return req.user as { tenantId: number; id: number; role: string }; }
function fail(res: any, err: any) {
  res.status(err instanceof z.ZodError ? 400 : err.status ?? 500).json({
    error: err instanceof z.ZodError ? err.issues.map((i: any) => i.message).join("; ")
      : err.status ? err.message : "Buying committee operation failed. Please retry or review server logs.",
  });
}
router.get("/buying-committee/options", async (req, res) => {
  try {
    const u = user(req);
    const [clients, audiences, provider] = await Promise.all([
      pool.query("SELECT id,name FROM clients WHERE tenant_id=$1 AND ($2::int[] IS NULL OR id=ANY($2::int[])) ORDER BY name", [u.tenantId,permittedClientIds(req)]),
      pool.query(`SELECT id,name,client_id "clientId" FROM intent_audiences WHERE tenant_id=$1
        AND ($2::int[] IS NULL OR client_id=ANY($2::int[])) ORDER BY name`, [u.tenantId,permittedClientIds(req)]),
      apolloCommitteeConfig(u.tenantId),
    ]);
    const hp = clients.rows.filter(c => /^(hp|hp india|hewlett[ -]packard(?: india)?|hp inc\.?)$/i.test(c.name.trim()));
    res.json({ clients: hp, databases: audiences.rows.filter(a => a.clientId === null || hp.some(c => c.id === a.clientId)),
      configured: provider.configured, maxRequests: provider.maxRequests, canManage: hasManageGrant(u, "committee"), countries: committeeCountries });
  } catch (err) { fail(res, err); }
});
router.get("/buying-committee/accounts", async (req, res) => {
  try {
    const input = pageSchema.extend({ clientId: positive, includeRoster: z.enum(["true", "false"]).default("true"),
      audienceIds: ids, search: z.string().trim().max(200).default(""), segment: z.string().trim().max(100).default("") }).parse(req.query);
    res.json(await committeeAccounts(user(req).tenantId, input.clientId, input.includeRoster === "true", input.audienceIds, input.search, input.page, input.segment));
  } catch (err) { fail(res, err); }
});
router.get("/buying-committee/suggestions", async (req, res) => {
  try {
    const categories = z.string().max(200).transform(v => v.split(",")).pipe(z.array(z.enum(committeeCategories)).min(1).max(4)).parse(req.query.categories);
    res.json({ designations: designationSuggestions(categories) });
  } catch (err) { fail(res, err); }
});
router.post("/buying-committee/domain-lookup", requireRole("admin"), async (req, res): Promise<void> => {
  try {
    const input = LookupBuyingCommitteeDomainBody.parse(req.body);
    res.setHeader("Cache-Control", "private, no-store");
    res.json(LookupBuyingCommitteeDomainResponse.parse(await lookupCommitteeDomain(user(req).tenantId, input)));
  } catch (err) { fail(res, err); }
});
router.get("/buying-committee/plans", async (req, res) => {
  try {
    const { clientId, page } = pageSchema.extend({ clientId: positive }).parse(req.query), tenantId = user(req).tenantId;
    await requireHpCommitteeClient(tenantId, clientId);
    const [items, total] = await Promise.all([
      pool.query("SELECT * FROM buying_committee_plans WHERE tenant_id=$1 AND client_id=$2 ORDER BY id DESC LIMIT 10 OFFSET $3", [tenantId, clientId, (page - 1) * 10]),
      pool.query("SELECT count(*)::int total FROM buying_committee_plans WHERE tenant_id=$1 AND client_id=$2", [tenantId, clientId]),
    ]);
    res.json({ items: items.rows, total: total.rows[0].total });
  } catch (err) { fail(res, err); }
});
router.get("/buying-committee/plans/:id", async (req, res) => {
  try { res.json(await committeePlan(user(req).tenantId, positive.parse(req.params.id))); } catch (err) { fail(res, err); }
});
router.post("/buying-committee/plans", requireRole("admin"), async (req, res) => {
  try {
    const u = user(req);
    res.status(201).json(await saveCommitteePlan(u.tenantId, u.id, committeePlanSchema.parse(req.body)));
  } catch (err) { fail(res, err); }
});
router.put("/buying-committee/plans/:id", requireRole("admin"), async (req, res) => {
  try {
    const u = user(req);
    res.json(await saveCommitteePlan(u.tenantId, u.id, committeePlanSchema.parse(req.body), positive.parse(req.params.id)));
  } catch (err) { fail(res, err); }
});
router.post("/buying-committee/plans/:id/copy", requireRole("admin"), async (req, res): Promise<void> => {
  try {
    const { id } = CopyBuyingCommitteePlanParams.parse(req.params);
    res.setHeader("Cache-Control", "private, no-store");
    res.json(CopyBuyingCommitteePlanResponse.parse(await copyCommitteePlan(user(req).tenantId, id)));
  } catch (err) { fail(res, err); }
});
router.post("/buying-committee/plans/:id/approve", requireRole("admin"), async (req, res) => {
  try {
    const input = z.object({ revision: positive, confirm: z.literal(true) }).parse(req.body), u = user(req);
    res.json(await approveCommitteePlan(u.tenantId, u.id, positive.parse(req.params.id), input.revision));
  } catch (err) { fail(res, err); }
});
router.post("/buying-committee/plans/:id/source", requireRole("admin"), async (req, res) => {
  try {
    const input = z.object({ accountId: positive, confirm: z.literal(true), retry: z.boolean().default(false) }).parse(req.body);
    res.json(await sourceCommitteeAccount(user(req).tenantId, positive.parse(req.params.id), input.accountId, input.retry));
  } catch (err) { fail(res, err); }
});
// Downloading contact PII is deliberately stricter than viewing contacts.
router.get("/buying-committee/contacts/export", async (req, res): Promise<void> => {
  let csv: ReturnType<typeof exportCommitteeCsv> | undefined;
  const actor = user(req), progress = { rowCount: 0 };
  let auditId: number | undefined, outcome: ExportOutcome = "failed";
  const abort = new AbortController();
  const disconnected = () => { if (!res.writableFinished) abort.abort(); };
  req.once("aborted", disconnected);
  res.once("close", disconnected);
  try {
    // Safe parsing is only for audit metadata; normal strict validation follows.
    const client = positive.safeParse(req.query.clientId), accounts = ids.safeParse(req.query.accountIds);
    auditId = await startCommitteeExportAudit(actor, client.success ? client.data : null,
      accounts.success ? accounts.data : []);
    if (actor.role !== "admin") committeeError("Only administrators can export contact details", 403);
    const input = ExportBuyingCommitteeContactsQueryParams.parse(req.query);
    const accountIds = ids.parse(input.accountIds);
    if (!accountIds.length) committeeError("Select at least one HP account.");
    abort.signal.throwIfAborted();
    csv = exportCommitteeCsv(actor.tenantId, input.clientId, accountIds, progress, abort.signal, input.country);
    // Validate ownership and execute the first bounded read before sending a download.
    const first = await csv.next();
    abort.signal.throwIfAborted();
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="hp-buying-committee.csv"');
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    const remaining = csv;
    await pipeline(Readable.from((async function* () {
      if (!first.done) yield first.value;
      yield* remaining;
    })()), res, { signal: abort.signal });
    // pipeline resolves on response finish, not merely when the CSV is generated.
    outcome = "completed";
  } catch (err) {
    const error = err as { name?: string; code?: string; status?: number };
    outcome = error.name === "AbortError" || error.code === "ERR_STREAM_PREMATURE_CLOSE"
      ? "cancelled" : err instanceof z.ZodError || (error.status && error.status < 500) ? "rejected" : "failed";
    if (res.headersSent || res.destroyed) res.destroy();
    else fail(res, err);
  } finally {
    req.off("aborted", disconnected);
    res.off("close", disconnected);
    try { await csv?.return(undefined); }
    catch { outcome = "failed"; }
    if (auditId !== undefined) {
      try { await finishCommitteeExportAudit(actor, auditId, outcome, progress.rowCount); }
      catch {
        // Never log the error/query/request: it could carry contact PII.
        req.log?.error({ auditId, tenantId: actor.tenantId }, "Committee export audit finalization failed; attempt remains unfinished");
      }
    }
  }
});
router.post("/buying-committee/contacts/save", requireRole("admin"), async (req, res): Promise<void> => {
  try {
    const input = SaveBuyingCommitteeContactBody.parse(req.body);
    const result = await saveCommitteeContact(user(req).tenantId, input);
    req.log?.info({ contactId: result.contactId, created: result.created }, "Buying committee contact saved to CRM");
    res.json(SaveBuyingCommitteeContactResponse.parse(result));
  } catch (err) { fail(res, err); }
});
router.get("/buying-committee/contacts", async (req, res) => {
  try {
    const input = pageSchema.extend({ clientId: positive, accountIds: ids, pageSize: positive.max(100).default(25), planPage: positive.max(10000).default(1), country: z.string().trim().min(2).max(100).optional() }).parse(req.query);
    if (!input.accountIds.length) committeeError("Select at least one HP account.");
    res.json({ ...await readCommitteeContacts(user(req).tenantId, input.clientId, input.accountIds, input.page, input.pageSize, input.country, input.planPage),
      canExport: user(req).role === "admin", canSave: hasManageGrant(user(req), "committee") });
  } catch (err) { fail(res, err); }
});
export default router;
