import { pool } from "@workspace/db";
import { ownershipFields } from "./hpSalesAssignments";

export type SalesActor = { id: number; tenantId: number; email: string; role: string; clientIds?: number[] | null };
export type SalesAccess = { user: SalesActor; visibility: "owned" | "all" };
export async function loadSalesAccess(user: SalesActor): Promise<SalesAccess> {
  if (user.role === "admin") return { user, visibility: "all" };
  const row = (await pool.query("SELECT visibility FROM sales_user_access WHERE tenant_id=$1 AND user_id=$2",
    [user.tenantId, user.id])).rows[0];
  return { user, visibility: row?.visibility === "all" ? "all" : "owned" };
}

/** Trusted aliases only; all actor data remains bound parameters. */
export function salesOwnerSql(account: string, userId: string, email: string) {
  return `(EXISTS(SELECT 1 FROM sales_account_owners sao
    WHERE sao.tenant_id=${account}.tenant_id AND sao.client_id=${account}.client_id AND sao.account_id=${account}.id AND sao.user_id=${userId})
    OR EXISTS(SELECT 1 FROM hp_account_profiles hp WHERE hp.tenant_id=${account}.tenant_id
      AND hp.client_id=${account}.client_id AND hp.company_id=${account}.id AND ${email}::text<>''
      AND (${ownershipFields.map(([field]) => `lower(btrim(hp.${field}))=lower(btrim(${email}::text))`).join(" OR ")})))`;
}
export function salesScopeSql(access: SalesAccess, alias: string, params: unknown[]) {
  const clauses: string[] = [];
  if (Array.isArray(access.user.clientIds) && access.user.role !== "admin") {
    params.push(access.user.clientIds);
    clauses.push(`${alias}.client_id=ANY($${params.length}::int[])`);
  }
  if (access.visibility === "owned") {
    params.push(access.user.id, access.user.email);
    clauses.push(salesOwnerSql(alias, `$${params.length - 1}`, `$${params.length}`));
  }
  return clauses.length ? clauses.join(" AND ") : "true";
}
export async function maySeeSalesAccount(access: SalesAccess, accountId: number, clientId?: number) {
  const params: unknown[] = [access.user.tenantId, accountId, clientId ?? null];
  const scope = salesScopeSql(access, "c", params);
  return !!(await pool.query(`SELECT 1 FROM companies c WHERE c.tenant_id=$1 AND c.id=$2
    AND ($3::int IS NULL OR c.client_id=$3) AND ${scope}`, params)).rowCount;
}
