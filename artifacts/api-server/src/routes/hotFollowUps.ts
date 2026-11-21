import { Router } from "express";
import { z } from "zod";
import { pool } from "@workspace/db";
import { canAccess, ListHotFollowUpsQueryParams, ListHotFollowUpsResponse,
  UpdateHotFollowUpBody, UpdateHotFollowUpParams, UpdateHotFollowUpResponse } from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { hotContactAllowedSql, syncHotFollowUps } from "../lib/hpHotFollowUps";
import { hpClientNameSql } from "../lib/hpClientScope";
import type { PoolClient } from "pg";
import { salesFeedbackAccess, requestSalesAccess } from "../middlewares/salesFeedbackAccess";
import { salesScopeSql, maySeeSalesAccount } from "../lib/salesAccountAccess";

const router = Router();
router.use("/sales-feedback/hot-follow-ups", requireAuth, salesFeedbackAccess, (req, res, next) => {
  if (!canAccess(req.user as any, "gtm", req.method !== "GET")
      && !canAccess(req.user as any, "sales", req.method !== "GET")) {
    res.status(403).json({ error: "Sales Dashboard or Sales Feedback section access required." }); return;
  }
  next();
});
const id = z.coerce.number().int().positive();
const handle = (fn: (req: any, res: any) => Promise<void>) => async (req: any, res: any, next: any) => {
  try { await fn(req, res); } catch (error) {
    if (error instanceof z.ZodError) { res.status(400).json({ error: error.message }); return; }
    next(error);
  }
};
async function assignees(tenantId: number, executor: Pick<PoolClient, "query"> = pool, clientId?: number) {
  return (await executor.query(`SELECT id,first_name||' '||last_name AS name,role,section_permissions AS "sectionPermissions"
    FROM users WHERE tenant_id=$1 AND ($2::int IS NULL OR role='admin' OR client_ids IS NULL OR client_ids @> jsonb_build_array($2::int))
    ORDER BY first_name,id`, [tenantId, clientId ?? null])).rows
    .filter(u => canAccess(u, "gtm", true) || canAccess(u, "sales", true)).map(({ id, name }) => ({ id, name }));
}
const joins = `JOIN contacts ct ON ct.id=f.contact_id AND ct.tenant_id=f.tenant_id AND ct.client_id=f.client_id AND ct.company_id=f.account_id
  JOIN companies c ON c.id=f.account_id AND c.tenant_id=f.tenant_id AND c.client_id=f.client_id
  JOIN clients cl ON cl.id=f.client_id AND cl.tenant_id=f.tenant_id`;
const columns = `f.id,f.client_id AS "clientId",f.account_id AS "accountId",f.contact_id AS "contactId",
  concat_ws(' ',ct.first_name,ct.last_name) AS "contactName",c.name AS "accountName",ct.phone,ct.email,
  f.status,f.assignee_id AS "assigneeId",(SELECT first_name||' '||last_name FROM users u WHERE u.id=f.assignee_id AND u.tenant_id=f.tenant_id) AS "assigneeName",
  f.created_at AS "createdAt",f.completed_at AS "completedAt",f.completion_note AS "completionNote",f.evidence,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('id',j.id,'name',j.name)) FROM journey_contacts jc JOIN journeys j
    ON j.id=jc.journey_id AND j.tenant_id=f.tenant_id AND j.client_id=f.client_id WHERE jc.contact_id=f.contact_id),'[]') AS journeys,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('id',s.id,'name',s.name,'status',e.status)) FROM sequence_enrollments e
    JOIN email_sequences s ON s.id=e.sequence_id AND s.tenant_id=f.tenant_id AND s.client_id=f.client_id
    WHERE e.contact_id=f.contact_id),'[]') AS sequences`;

router.get("/sales-feedback/hot-follow-ups", handle(async (req, res) => {
  const v = ListHotFollowUpsQueryParams.extend({ clientId: id.optional(), accountId: id.optional(), contactId: id.optional(),
    parentKey: z.string().min(1).max(200).optional(), status: z.enum(["open", "completed"]).default("open"),
    page: id.max(100000).default(1) }).refine(v => !v.parentKey || v.clientId, "Parent scope requires clientId.").parse(req.query);
  const tenantId = req.user.tenantId;
  const access = requestSalesAccess(req);
  if (v.accountId || v.contactId) {
    const accountParams: unknown[] = [tenantId, v.clientId ?? null, v.accountId ?? null, v.contactId ?? null];
    const ownedScope = salesScopeSql(access, "c", accountParams);
    const accounts = (await pool.query(`SELECT DISTINCT c.id,c.client_id FROM companies c
      JOIN clients cl ON cl.id=c.client_id AND cl.tenant_id=c.tenant_id
      WHERE c.tenant_id=$1 AND ($2::int IS NULL OR c.client_id=$2) AND ($3::int IS NULL OR c.id=$3)
      AND ($4::int IS NULL OR EXISTS(SELECT 1 FROM contacts ct WHERE ct.id=$4 AND ct.tenant_id=c.tenant_id
        AND ct.client_id=c.client_id AND ct.company_id=c.id)) AND ${hpClientNameSql("cl.name")} AND ${ownedScope}`,
      accountParams)).rows;
    for (const account of accounts) await syncHotFollowUps(tenantId, account.client_id, [account.id]);
  }
  const params: unknown[] = [tenantId, v.clientId ?? null, v.accountId ?? null, v.contactId ?? null, v.parentKey ?? null, v.status];
  const ownerScope = salesScopeSql(access, "c", params);
  const scope = `f.tenant_id=$1 AND ($2::int IS NULL OR f.client_id=$2) AND ($3::int IS NULL OR f.account_id=$3)
    AND ($4::int IS NULL OR f.contact_id=$4) AND ($5::text IS NULL OR EXISTS(SELECT 1 FROM hp_account_profiles p
      WHERE p.tenant_id=f.tenant_id AND p.client_id=f.client_id AND p.company_id=f.account_id AND p.parent_key=$5))
    AND ${hpClientNameSql("cl.name")} AND ${hotContactAllowedSql} AND ${ownerScope}`;
  // Revalidate the entire scoped candidate set BEFORE pagination. Otherwise a
  // revoked first page can conceal eligible people further down the queue.
  const candidate = (await pool.query(`SELECT DISTINCT f.client_id,f.account_id FROM hp_hot_follow_ups f ${joins}
    WHERE ${scope} AND f.status=$6 ORDER BY f.client_id,f.account_id`, params)).rows;
  for (const clientId of new Set(candidate.map(r => Number(r.client_id)))) {
    const ids = candidate.filter(r => r.client_id === clientId).map(r => Number(r.account_id));
    for (let start = 0; start < ids.length; start += 100)
      await syncHotFollowUps(tenantId, clientId, ids.slice(start, start + 100));
  }
  // Filter evidence freshness in SQL as well, so paging cannot expose unvalidated stale records.
  const current = `AND EXISTS(SELECT 1 FROM jsonb_array_elements(f.evidence) e
    WHERE (e->>'at')::timestamptz<=NOW() AND (e->>'at')::timestamptz>=NOW()-interval '30 days'
    AND (e->>'months')::numeric BETWEEN 0 AND 3
    AND NOW()<=CASE WHEN (e->>'months')::numeric=0 THEN (e->>'at')::timestamptz+interval '30 days'
      ELSE (e->>'at')::timestamptz+make_interval(months=>ceil((e->>'months')::numeric)::int) END)`;
  const [result, team] = await Promise.all([
    // One statement/snapshot supplies both the total and page, and enriches only
    // the paged IDs with journey/sequence context.
    pool.query(`WITH eligible AS MATERIALIZED(
      SELECT f.id FROM hp_hot_follow_ups f ${joins} WHERE ${scope} AND f.status=$6 ${current}
    ), paged AS (SELECT id FROM eligible ORDER BY id LIMIT 25 OFFSET $${params.length + 1})
    SELECT (SELECT count(*)::int FROM eligible) AS total,
      COALESCE((SELECT jsonb_agg(item ORDER BY item.id) FROM (
        SELECT ${columns} FROM paged p JOIN hp_hot_follow_ups f ON f.id=p.id ${joins}
      ) item),'[]'::jsonb) AS items`, [...params, (v.page - 1) * 25]),
    assignees(tenantId, pool, Array.isArray(req.user.clientIds) ? v.clientId : undefined),
  ]);
  res.json(ListHotFollowUpsResponse.parse({ ...result.rows[0], page: v.page, pageSize: 25,
    assignees: access.visibility === "all" ? team : team.filter(u => u.id === access.user.id) }));
}));

router.patch("/sales-feedback/hot-follow-ups/:id", handle(async (req, res) => {
  const followUpId = UpdateHotFollowUpParams.extend({ id }).parse(req.params).id, tenantId = req.user.tenantId;
  const v = UpdateHotFollowUpBody.extend({ assigneeId: id.nullable().optional(), complete: z.literal(true).optional(),
    note: z.string().trim().max(2000).optional() }).strict()
    .refine(v => v.assigneeId !== undefined || v.complete, "Choose assignment or completion.")
    .refine(v => !v.complete || !!v.note, "Completion requires a note.").parse(req.body);
  const row = (await pool.query(`SELECT client_id,account_id FROM hp_hot_follow_ups WHERE tenant_id=$1 AND id=$2`,
    [tenantId, followUpId])).rows[0];
  const access = requestSalesAccess(req);
  if (!row || !await maySeeSalesAccount(access, row.account_id, row.client_id)) { res.status(404).json({ error: "Follow-up not found." }); return; }
  let response: { status: number; body: any } | undefined;
  await syncHotFollowUps(tenantId, row.client_id, [row.account_id], new Date(), async db => {
    const team = await assignees(tenantId, db, Array.isArray(req.user.clientIds) ? row.client_id : undefined);
    if (access.visibility === "owned" && v.assigneeId != null && v.assigneeId !== access.user.id) {
      response = { status: 403, body: { error: "Only all-account managers can assign other salespeople." } }; return;
    }
    if (v.assigneeId != null && !team.some(u => u.id === v.assigneeId)) {
      response = { status: 400, body: { error: "Choose a current team member with Sales Dashboard or Sales Feedback manage access." } }; return;
    }
    const updated = await db.query(`UPDATE hp_hot_follow_ups f SET
      assignee_id=CASE WHEN $3::boolean THEN $4::int ELSE f.assignee_id END,
      status=CASE WHEN $5::boolean THEN 'completed' ELSE f.status END,
      completed_at=CASE WHEN $5::boolean THEN NOW() ELSE f.completed_at END,
      completed_by=CASE WHEN $5::boolean THEN $6::int ELSE f.completed_by END,
      completion_note=CASE WHEN $5::boolean THEN $7::text ELSE f.completion_note END,updated_at=NOW()
      FROM contacts ct,companies c,clients cl WHERE f.tenant_id=$1 AND f.id=$2 AND f.status='open'
      AND ct.id=f.contact_id AND ct.tenant_id=f.tenant_id AND ct.client_id=f.client_id AND ct.company_id=f.account_id
      AND c.id=f.account_id AND c.tenant_id=f.tenant_id AND c.client_id=f.client_id
      AND cl.id=f.client_id AND cl.tenant_id=f.tenant_id AND ${hpClientNameSql("cl.name")} AND ${hotContactAllowedSql}
      RETURNING f.*`, [tenantId, followUpId, v.assigneeId !== undefined, v.assigneeId ?? null, !!v.complete, req.user.id, v.note ?? null]);
    if (!updated.rowCount) {
      response = { status: 409, body: { error: "This follow-up is no longer open or eligible. Refresh the worklist." } }; return;
    }
    const item = (await db.query(`SELECT ${columns} FROM hp_hot_follow_ups f ${joins} WHERE f.tenant_id=$1 AND f.id=$2`,
      [tenantId, followUpId])).rows[0];
    response = { status: 200, body: UpdateHotFollowUpResponse.parse(item) };
  });
  if (!response) throw new Error("Follow-up update did not produce a result.");
  res.status(response.status).json(response.body);
}));
export default router;
