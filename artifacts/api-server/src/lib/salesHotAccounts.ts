import { pool } from "@workspace/db";
import type { PoolClient } from "pg";
import { canAccess, ListSalesHotAccountsResponse } from "@workspace/api-zod";
import { loadHpPriorityEvidence } from "./hpAccountPriorityData";
import { formState } from "./hpAccountPriority";
import { positiveProduct } from "./hpBiImport";
import { ownershipFields } from "./hpSalesAssignments";
import { salesScopeSql, type SalesAccess } from "./salesAccountAccess";
type SalesHotAccount = ReturnType<typeof ListSalesHotAccountsResponse.parse>["items"][number];
type SalesHotEvidence = SalesHotAccount["evidence"][number];
type SalesOwner = SalesHotAccount["owners"][number];

export async function salesAssignableUsers(tenantId: number, clientId: number, db: Pick<PoolClient, "query"> = pool, lock = false) {
  return (await db.query(`SELECT id,first_name||' '||last_name AS name,email,role,
    section_permissions AS "sectionPermissions" FROM users WHERE tenant_id=$1
    AND (role='admin' OR client_ids IS NULL OR client_ids @> jsonb_build_array($2::int)) ORDER BY first_name,id
    ${lock ? "FOR SHARE" : ""}`,
  [tenantId, clientId])).rows.filter(u => canAccess(u, "sales"));
}

async function accountOwners(tenantId: number, ids: number[], db: Pick<PoolClient, "query"> = pool): Promise<Map<number, SalesOwner[]>> {
  if (!ids.length) return new Map();
  const result = await db.query(`WITH roster AS (
    SELECT DISTINCT p.company_id AS account_id,lower(btrim(e.email)) AS email
    FROM hp_account_profiles p CROSS JOIN LATERAL unnest(ARRAY[${ownershipFields.map(([field]) => `p.${field}`).join(",")}]) e(email)
    JOIN companies c ON c.id=p.company_id AND c.tenant_id=p.tenant_id AND c.client_id=p.client_id
    WHERE p.tenant_id=$1 AND p.company_id=ANY($2::int[]) AND e.email LIKE '%@%'
  )
  SELECT o.account_id,u.id AS "userId",u.first_name||' '||u.last_name AS name,u.email,'assigned' AS source
  FROM sales_account_owners o JOIN users u ON u.id=o.user_id AND u.tenant_id=o.tenant_id
  JOIN companies c ON c.id=o.account_id AND c.tenant_id=o.tenant_id AND c.client_id=o.client_id
  WHERE o.tenant_id=$1 AND o.account_id=ANY($2::int[])
  UNION ALL SELECT r.account_id,u.id AS "userId",COALESCE(u.first_name||' '||u.last_name,r.email) AS name,r.email,'roster' AS source
  FROM roster r LEFT JOIN users u ON u.tenant_id=$1 AND lower(btrim(u.email))=r.email
  ORDER BY account_id,source,name`, [tenantId, ids]);
  const owners = new Map<number, SalesOwner[]>();
  for (const row of result.rows) {
    const { account_id, ...owner } = row;
    const list = owners.get(Number(account_id)) ?? [];
    list.push(owner as SalesOwner);
    owners.set(Number(account_id), list);
  }
  return owners;
}

/** Live saved first-party facts. Visibility is not permission to call or enroll.
 * Old declared Hot evidence remains visible, separately marked for reconfirmation;
 * the stricter existing fresh-contact call queue is intentionally unchanged. */
export async function loadSalesAccounts(access: SalesAccess,
  filters: { clientId?: number; accountId?: number; accountIds?: number[]; search?: string } = {}, now = new Date()): Promise<SalesHotAccount[]> {
  const params: unknown[] = [access.user.tenantId, filters.clientId ?? null, filters.accountId ?? null, `%${filters.search ?? ""}%`, filters.accountIds ?? null];
  const scope = salesScopeSql(access, "c", params);
  const candidates = (await pool.query(`SELECT c.id,c.name,c.client_id AS "clientId",cl.name AS "clientName"
    FROM companies c JOIN clients cl ON cl.id=c.client_id AND cl.tenant_id=c.tenant_id
    WHERE c.tenant_id=$1 AND ($2::int IS NULL OR c.client_id=$2) AND ($3::int IS NULL OR c.id=$3)
    AND ($5::int[] IS NULL OR c.id=ANY($5::int[]))
    AND (c.name ILIKE $4 OR c.domain ILIKE $4) AND ${scope}
    AND ($3::int IS NOT NULL
      OR EXISTS(SELECT 1 FROM intent_inbound_submissions s WHERE s.tenant_id=c.tenant_id AND s.client_id=c.client_id AND s.account_id=c.id)
      OR EXISTS(SELECT 1 FROM hp_bi_records r WHERE r.tenant_id=c.tenant_id AND r.client_id=c.client_id AND r.account_id=c.id AND r.kind='lead')
      OR EXISTS(SELECT 1 FROM sales_feedback f WHERE f.tenant_id=c.tenant_id AND f.client_id=c.client_id AND f.account_id=c.id AND f.approved_qualification)
      OR EXISTS(SELECT 1 FROM form_submissions f JOIN contacts ct ON ct.id=f.contact_id AND ct.tenant_id=f.tenant_id
        WHERE f.tenant_id=c.tenant_id AND ct.client_id=c.client_id AND ct.company_id=c.id))
    ORDER BY c.name,c.id`, params)).rows;
  const evidence = new Map<number, SalesHotEvidence[]>();
  for (const clientId of new Set(candidates.map(row => Number(row.clientId)))) {
    const ids = candidates.filter(row => Number(row.clientId) === clientId).map(row => Number(row.id));
    // Shared identity, review, product mapping and canonical-duplicate guards.
    const data = await loadHpPriorityEvidence(access.user.tenantId, clientId, ids, now, false);
    const seen = new Set<string>();
    for (const form of data.forms) {
      if (!positiveProduct(form.product) || form.months === null || form.months < 0 || form.months > 3
        || !Number.isFinite(Date.parse(form.at)) || Date.parse(form.at) > now.getTime()
        || (form.contactId !== null && data.blockedContacts.has(form.contactId))) continue;
      const key = JSON.stringify([form.accountId, form.contactId, form.product, form.months, form.at]);
      if (seen.has(key)) continue;
      seen.add(key);
      const list = evidence.get(form.accountId) ?? [];
      const prefix = form.reference.split(":")[0];
      list.push({ contactId: form.contactId, product: form.product, months: form.months, at: form.at,
        source: prefix === "inbound" ? "Lead form / event questionnaire" : prefix === "sales-feedback"
          ? "Approved sales feedback" : prefix === "form" ? "Journey form" : "Recorded lead",
        fresh: formState(form, now).explicit });
      evidence.set(form.accountId, list);
    }
  }
  return candidates.filter(c => filters.accountId !== undefined || evidence.has(Number(c.id))).map(c => ({
    ...c, owners: [], evidence: evidence.get(Number(c.id)) ?? [],
    hotContacts: new Set((evidence.get(Number(c.id)) ?? []).flatMap(e => e.contactId === null ? [] : [e.contactId])).size,
  }));
}
export async function enrichSalesOwners(tenantId: number, accounts: SalesHotAccount[], db: Pick<PoolClient, "query"> = pool) {
  const owners = await accountOwners(tenantId, accounts.map(account => account.id), db);
  for (const account of accounts) account.owners = owners.get(account.id) ?? [];
  return accounts;
}

// Unmatched roster email labels do not give any signed-in user ownership.
export function isSalesUnassigned(account: Pick<SalesHotAccount, "owners">) {
  return !account.owners.some(owner => owner.userId !== null);
}
