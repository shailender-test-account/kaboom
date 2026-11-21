import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import { pool } from "@workspace/db";
import { canAccess, ListSalesHotAccountsResponse, GetSalesAccountResponse, GetSalesAccountOptionsResponse,
  ReplaceSalesAccountOwnersBody, SetMemberSalesAccessBody, PreviewSalesOwnerBatchResponse,
  ConfirmSalesOwnerBatchBody, ConfirmSalesOwnerBatchResponse, GetSalesOwnerHistoryQueryParams,
  GetSalesVisibilityHistoryQueryParams, GetSalesOwnerHistoryResponse, GetSalesVisibilityHistoryResponse,
  ListSalesAccessHistoryQueryParams, ListSalesAccessHistoryResponse } from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { loadSalesAccess, type SalesAccess } from "../lib/salesAccountAccess";
import { loadSalesAccounts, enrichSalesOwners, salesAssignableUsers, isSalesUnassigned } from "../lib/salesHotAccounts";
import { previewSalesOwnerBatch, confirmSalesOwnerBatch, SalesBatchConflict } from "../lib/salesOwnerBatch";
import { beginSalesAccessChange, recordSalesAccess, salesAccessHistory, tenantSalesAccessHistory, salesAuditDateRange } from "../lib/salesAccessAudit";

const router = Router();
const requestTimes = new WeakMap<Request, Date>();
router.use((req, _res, next) => { requestTimes.set(req, new Date()); next(); });
const id = z.coerce.number().int().positive();
const handle = (fn: (req: Request, res: Response) => Promise<void>) => async (req: Request, res: Response, next: NextFunction) => {
  try { await fn(req, res); } catch (error) {
    if (error instanceof SalesBatchConflict) { res.status(409).json({ error: error.message }); return; }
    if (error instanceof z.ZodError) { res.status(400).json({ error: error.message }); return; }
    next(error);
  }
};
router.get("/team-access/sales-history", requireAuth, handle(async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const actor = req.user as any;
  if (actor.role !== "admin") { res.status(403).json({ error: "Administrator required." }); return; }
  const parsed = ListSalesAccessHistoryQueryParams.safeParse(req.query);
  if (!parsed.success) { res.status(400).json({ error: "Invalid history filters." }); return; }
  const { dateFrom, dateTo, ...filters } = parsed.data;
  const range = salesAuditDateRange(dateFrom, dateTo);
  if (!range) {
    res.status(400).json({ error: "Choose valid UTC dates in order, spanning no more than 366 days." }); return;
  }
  res.json(ListSalesAccessHistoryResponse.parse(await tenantSalesAccessHistory(actor.tenantId, { ...filters, ...range })));
}));
router.use("/sales/accounts", requireAuth, (req, res, next) => {
  if (!canAccess(req.user as any, "sales", req.method !== "GET")) {
    res.status(403).json({ error: "Sales Dashboard access required." }); return;
  }
  next();
});
async function detail(access: SalesAccess, accountId: number) {
  const [account] = await enrichSalesOwners(access.user.tenantId, await loadSalesAccounts(access, { accountId }));
  if (!account) return null;
  const contacts = (await pool.query(`SELECT c.id,concat_ws(' ',c.first_name,c.last_name) AS name,c.email,c.phone,
    (c.dnc OR c.status<>'active' OR EXISTS(SELECT 1 FROM call_dnc_contacts d WHERE d.tenant_id=c.tenant_id AND d.contact_id=c.id)) AS suppressed
    FROM contacts c WHERE c.tenant_id=$1 AND c.client_id=$2 AND c.company_id=$3 AND NOT c.is_anonymous ORDER BY c.first_name,c.id`,
  [access.user.tenantId, account.clientId, account.id])).rows;
  const canAssign = access.user.role === "admin";
  const assignedUserIds = account.owners.filter(o => o.source === "assigned" && o.userId !== null).map(o => o.userId!);
  const assignableUsers = canAssign ? (await salesAssignableUsers(access.user.tenantId, account.clientId))
    .map(({ id, name, email }) => ({ id, name, email })) : [];
  return { account, contacts, canAssign, assignedUserIds, assignableUsers };
}
router.get("/sales/accounts/options", handle(async (req, res) => {
  const access = await loadSalesAccess(req.user as any);
  const clients = (await pool.query(`SELECT id,name FROM clients WHERE tenant_id=$1
    AND ($2::int[] IS NULL OR id=ANY($2::int[])) ORDER BY name,id`,
  [access.user.tenantId, access.user.role === "admin" ? null : access.user.clientIds ?? null])).rows;
  res.json(GetSalesAccountOptionsResponse.parse({ clients, visibility: access.visibility, canAssign: access.user.role === "admin" }));
}));
router.get("/sales/accounts", handle(async (req, res) => {
  const v = z.object({ clientId: id.optional(), search: z.string().max(200).optional(), page: id.max(100000).default(1),
    unassigned: z.enum(["true", "false"]).optional() }).parse(req.query);
  const access = await loadSalesAccess(req.user as any);
  if (v.unassigned !== undefined && access.user.role !== "admin") {
    res.status(403).json({ error: "Administrator required." }); return;
  }
  let all = await loadSalesAccounts(access, v);
  if (v.unassigned === "true") all = (await enrichSalesOwners(access.user.tenantId, all)).filter(isSalesUnassigned);
  const items = await enrichSalesOwners(access.user.tenantId, all.slice((v.page - 1) * 25, v.page * 25));
  res.json(ListSalesHotAccountsResponse.parse({ items, total: all.length, page: v.page, pageSize: 25, visibility: access.visibility }));
}));
router.post("/sales/accounts/owners/preview", handle(async (req, res) => {
  if ((req.user as any).role !== "admin") { res.status(403).json({ error: "Administrator required." }); return; }
  res.json(PreviewSalesOwnerBatchResponse.parse(await previewSalesOwnerBatch(req.user as any, req.body)));
}));
router.post("/sales/accounts/owners/confirm", handle(async (req, res) => {
  if ((req.user as any).role !== "admin") { res.status(403).json({ error: "Administrator required." }); return; }
  const body = ConfirmSalesOwnerBatchBody.parse(req.body);
  res.json(ConfirmSalesOwnerBatchResponse.parse(await confirmSalesOwnerBatch(req.user as any, body.reviewToken)));
}));
router.get("/sales/accounts/:id", handle(async (req, res) => {
  const result = await detail(await loadSalesAccess(req.user as any), id.parse(req.params.id));
  if (!result) { res.status(404).json({ error: "Account not found." }); return; }
  res.json(GetSalesAccountResponse.parse(result));
}));
router.get("/sales/accounts/:id/owner-history", handle(async (req, res) => {
  const actor = req.user as any;
  if (actor.role !== "admin") { res.status(403).json({ error: "Administrator required." }); return; }
  const query = GetSalesOwnerHistoryQueryParams.parse(req.query);
  res.json(GetSalesOwnerHistoryResponse.parse(await salesAccessHistory(actor.tenantId, id.parse(req.params.id), "owners", query.beforeId)));
}));
router.put("/sales/accounts/:id/owners", handle(async (req, res) => {
  const requestedAt = requestTimes.get(req)!;
  const actor = req.user as any;
  if (actor.role !== "admin") { res.status(403).json({ error: "Administrator required." }); return; }
  const accountId = id.parse(req.params.id), v = ReplaceSalesAccountOwnersBody.parse(req.body);
  const db = await pool.connect();
  try {
    if (!await beginSalesAccessChange(db, actor)) {
      await db.query("ROLLBACK"); res.status(403).json({ error: "Administrator required." }); return;
    }
    const account = (await db.query("SELECT client_id FROM companies WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [actor.tenantId, accountId])).rows[0];
    if (!account) { await db.query("ROLLBACK"); res.status(404).json({ error: "Account not found." }); return; }
    const before = (await db.query(`SELECT user_id FROM sales_account_owners
      WHERE tenant_id=$1 AND account_id=$2 ORDER BY user_id`, [actor.tenantId, accountId])).rows.map(r => Number(r.user_id));
    const audit = { tenantId: actor.tenantId, actorId: actor.id, targetId: accountId, kind: "owners" as const, before, requestedAt };
    const users = (await db.query(`SELECT id,role,section_permissions AS "sectionPermissions" FROM users
      WHERE tenant_id=$1 AND id=ANY($2::int[]) AND (role='admin' OR client_ids IS NULL OR client_ids @> jsonb_build_array($3::int))
      FOR SHARE`, [actor.tenantId, v.userIds, account.client_id])).rows.filter(u => canAccess(u, "sales"));
    if (new Set(v.userIds).size !== v.userIds.length || users.length !== v.userIds.length) {
      await recordSalesAccess(db, { ...audit, after: before, rejected: true });
      await db.query("COMMIT"); res.status(400).json({ error: "Owners need Sales access and access to this client." }); return;
    }
    await db.query("DELETE FROM sales_account_owners WHERE tenant_id=$1 AND account_id=$2", [actor.tenantId, accountId]);
    for (const userId of v.userIds) await db.query(`INSERT INTO sales_account_owners(tenant_id,client_id,account_id,user_id)
      VALUES($1,$2,$3,$4)`, [actor.tenantId, account.client_id, accountId, userId]);
    await recordSalesAccess(db, { ...audit, after: [...v.userIds].sort((a, b) => a - b) });
    await db.query("COMMIT");
  } catch (error) { await db.query("ROLLBACK"); throw error; } finally { db.release(); }
  res.json(GetSalesAccountResponse.parse(await detail(await loadSalesAccess(actor), accountId)));
}));
router.use("/team-access/:id/sales-access", requireAuth, (req, res, next) => {
  if ((req.user as any).role !== "admin") { res.status(403).json({ error: "Administrator required." }); return; }
  next();
});
router.get("/team-access/:id/sales-access", handle(async (req, res) => {
  const target = (await pool.query("SELECT id,tenant_id AS \"tenantId\",role,email FROM users WHERE tenant_id=$1 AND id=$2",
    [(req.user as any).tenantId, id.parse(req.params.id)])).rows[0];
  if (!target) { res.status(404).json({ error: "User not found." }); return; }
  res.json({ visibility: (await loadSalesAccess(target)).visibility });
}));
router.get("/team-access/:id/sales-access/history", handle(async (req, res) => {
  const actor = req.user as any;
  const query = GetSalesVisibilityHistoryQueryParams.parse(req.query);
  res.json(GetSalesVisibilityHistoryResponse.parse(await salesAccessHistory(actor.tenantId, id.parse(req.params.id), "visibility", query.beforeId)));
}));
router.put("/team-access/:id/sales-access", handle(async (req, res) => {
  const requestedAt = requestTimes.get(req)!;
  const actor = req.user as any, userId = id.parse(req.params.id), v = SetMemberSalesAccessBody.parse(req.body);
  const db = await pool.connect();
  try {
    if (!await beginSalesAccessChange(db, actor)) {
      await db.query("ROLLBACK"); res.status(403).json({ error: "Administrator required." }); return;
    }
    const user = (await db.query("SELECT role FROM users WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [actor.tenantId, userId])).rows[0];
    if (!user) { await db.query("ROLLBACK"); res.status(404).json({ error: "User not found." }); return; }
    const saved = (await db.query("SELECT visibility FROM sales_user_access WHERE tenant_id=$1 AND user_id=$2",
      [actor.tenantId, userId])).rows[0];
    const before = user.role === "admin" ? "all" : saved?.visibility ?? "owned";
    const after = user.role === "admin" ? "all" : v.visibility;
    await db.query(`INSERT INTO sales_user_access(tenant_id,user_id,visibility) VALUES($1,$2,$3)
      ON CONFLICT(tenant_id,user_id) DO UPDATE SET visibility=EXCLUDED.visibility`, [actor.tenantId, userId, after]);
    await recordSalesAccess(db, { tenantId: actor.tenantId, actorId: actor.id, targetId: userId,
      kind: "visibility", before, after, requestedAt });
    await db.query("COMMIT");
    res.json({ visibility: after });
  } catch (error) { await db.query("ROLLBACK"); throw error; } finally { db.release(); }
}));
export default router;
