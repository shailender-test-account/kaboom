import { pool } from "@workspace/db";

export interface HpResearchSubject {
  accountId: number;
  accountName: string;
  scope: "parent" | "member";
  parentKey?: string;
  memberAccountId: number;
  memberAccountName: string;
}

/** Same reviewed-association semantics as HP Analytics. No name-based hierarchy guessing. */
export const hpEffectiveParentSql = `
  SELECT p.company_id,c.name AS member_name,c.client_id,
    CASE WHEN p.dimensions ? '_rosterAssociation' AND rp.company_id IS NULL
      THEN COALESCE(p.dimensions->'_rosterAssociation'->>'previousParentKey',p.parent_key)
      ELSE COALESCE(rp.parent_key,p.parent_key) END AS parent_key,
    CASE WHEN p.dimensions ? '_rosterAssociation' AND rp.company_id IS NULL
      THEN COALESCE(p.dimensions->'_rosterAssociation'->>'previousParentName',p.parent_name)
      ELSE COALESCE(rp.parent_name,p.parent_name) END AS parent_name
  FROM hp_account_profiles p
  JOIN companies c ON c.tenant_id=p.tenant_id AND c.client_id=p.client_id AND c.id=p.company_id
  JOIN clients cl ON cl.tenant_id=c.tenant_id AND cl.id=c.client_id AND lower(trim(cl.name))='hp'
  LEFT JOIN hp_account_profiles rp ON rp.tenant_id=p.tenant_id AND rp.client_id=p.client_id AND rp.hp_id IS NOT NULL
    AND rp.company_id=CASE WHEN p.dimensions->'_rosterAssociation'->>'accountId' ~ '^[0-9]{1,9}$'
      THEN (p.dimensions->'_rosterAssociation'->>'accountId')::int END
  WHERE p.tenant_id=$1 AND p.company_id=ANY($2::int[])`;

export function parentResearchName(name: string) {
  // WW/IN are roster scope labels, not part of the legal organization search name.
  return name.trim().replace(/\s*-\s*(WW|IN)\s*$/i, "").trim();
}

/** Parent checks must cool down all sibling targets without claiming a member check. */
export function hpParentLastCheckedSql(companyAlias = "companies") {
  if (!/^[a-z_]+$/i.test(companyAlias)) throw new Error("Invalid company SQL alias");
  return `(SELECT pc.last_researched_at
    FROM hp_account_profiles p
    LEFT JOIN hp_account_profiles rp ON rp.tenant_id=p.tenant_id AND rp.client_id=p.client_id AND rp.hp_id IS NOT NULL
      AND rp.company_id=CASE WHEN p.dimensions->'_rosterAssociation'->>'accountId' ~ '^[0-9]{1,9}$'
        THEN (p.dimensions->'_rosterAssociation'->>'accountId')::int END
    JOIN hp_parent_research_accounts m ON m.tenant_id=p.tenant_id AND m.client_id=p.client_id
      AND m.parent_key=CASE WHEN p.dimensions ? '_rosterAssociation' AND rp.company_id IS NULL
        THEN COALESCE(p.dimensions->'_rosterAssociation'->>'previousParentKey',p.parent_key)
        ELSE COALESCE(rp.parent_key,p.parent_key) END
    JOIN companies pc ON pc.id=m.account_id AND pc.tenant_id=m.tenant_id AND pc.client_id=m.client_id
    WHERE p.tenant_id=${companyAlias}.tenant_id AND p.client_id=${companyAlias}.client_id AND p.company_id=${companyAlias}.id)`;
}

export async function resolveHpResearchSubject(tenantId: number, accountId: number): Promise<HpResearchSubject> {
  const member = (await pool.query<{ name: string }>(
    "SELECT name FROM companies WHERE tenant_id=$1 AND id=$2", [tenantId, accountId])).rows[0];
  if (!member) throw new Error("Research account is no longer available");
  const fallback: HpResearchSubject = { accountId, accountName: member.name, scope: "member",
    memberAccountId: accountId, memberAccountName: member.name };
  const existingParent = (await pool.query<{ parent_key: string }>(
    "SELECT parent_key FROM hp_parent_research_accounts WHERE tenant_id=$1 AND account_id=$2", [tenantId, accountId])).rows[0];
  if (existingParent) return { ...fallback, scope: "parent", parentKey: existingParent.parent_key };
  const hierarchy = (await pool.query<{ parent_key: string; parent_name: string; client_id: number }>(
    hpEffectiveParentSql, [tenantId, [accountId]])).rows[0];
  if (!hierarchy?.parent_key?.trim() || !hierarchy.parent_name?.trim() ||
      /^(not available|unassigned|unknown|n\/a)$/i.test(hierarchy.parent_name.trim())) return fallback;
  const name = parentResearchName(hierarchy.parent_name);
  if (!name) return fallback;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Serialize identity creation across all members/schedules of the same parent.
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
      [`hp-parent:${tenantId}:${hierarchy.client_id}:${hierarchy.parent_key}`]);
    let mapped = (await client.query<{ account_id: number }>(`SELECT m.account_id
      FROM hp_parent_research_accounts m JOIN companies c ON c.id=m.account_id AND c.tenant_id=m.tenant_id AND c.client_id=m.client_id
      WHERE m.tenant_id=$1 AND m.client_id=$2 AND m.parent_key=$3`,
      [tenantId, hierarchy.client_id, hierarchy.parent_key])).rows[0];
    if (!mapped) {
      const created = (await client.query<{ id: number }>(
        "INSERT INTO companies(tenant_id,client_id,name) VALUES($1,$2,$3) RETURNING id",
        [tenantId, hierarchy.client_id, name])).rows[0];
      await client.query(`INSERT INTO hp_parent_research_accounts(tenant_id,client_id,parent_key,parent_name,account_id)
        VALUES($1,$2,$3,$4,$5)`, [tenantId, hierarchy.client_id, hierarchy.parent_key, hierarchy.parent_name, created.id]);
      mapped = { account_id: created.id };
    }
    await client.query("COMMIT");
    return { ...fallback, accountId: mapped.account_id, accountName: name, scope: "parent", parentKey: hierarchy.parent_key };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
}
