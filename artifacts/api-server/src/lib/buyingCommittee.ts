import { pool } from "@workspace/db";
import { z } from "zod";
import { isHpClient } from "./hpBiImport";
import { getIntegrationConfig } from "./integrationCredentials";
import { committeeCountry } from "./buyingCommitteeCountry";

export const committeeCategories = ["Security", "Collaboration", "IT Hardware", "Business Services"] as const;
const roles: Record<typeof committeeCategories[number], string[]> = {
  Security: ["Chief Information Security Officer", "Head of Information Security", "IT Security Manager", "Head of IT", "IT Procurement Manager"],
  Collaboration: ["Head of Digital Workplace", "Unified Communications Manager", "Collaboration Manager", "Head of IT", "IT Procurement Manager"],
  "IT Hardware": ["Chief Information Officer", "IT Director", "IT Infrastructure Manager", "End User Computing Manager", "IT Procurement Manager"],
  "Business Services": ["Chief Operating Officer", "Head of IT Services", "Service Delivery Manager", "Head of Procurement", "IT Procurement Manager"],
};
export const designationSuggestions = (categories: readonly (typeof committeeCategories[number])[]) =>
  [...new Set(categories.flatMap(category => roles[category]))];
export function committeeError(message: string, status = 400): never {
  throw Object.assign(new Error(message), { status });
}
export const committeePlanSchema = z.object({
  clientId: z.number().int().positive(), name: z.string().trim().min(1).max(150),
  includeRoster: z.boolean(), audienceIds: z.array(z.number().int().positive()).max(20),
  accountIds: z.array(z.number().int().positive()).min(1).max(50),
  categories: z.array(z.enum(committeeCategories)).min(1).max(4),
  designations: z.array(z.string().trim().min(2).max(100)).min(1).max(40),
  limitPerAccount: z.number().int().min(1).max(10).default(10),
  domains: z.record(z.string(), z.string().trim().max(253)).default({}),
  country: z.string().trim().max(100).refine(v => !!committeeCountry(v), "Select a valid contact country.")
    .transform(v => committeeCountry(v)!).optional(),
}).refine(p => p.includeRoster || p.audienceIds.length > 0, "Select a roster or database source.")
  .refine(p => new Set(p.accountIds).size === p.accountIds.length, "Select each account only once.");
export type CommitteeConfig = z.infer<typeof committeePlanSchema> & { requestBudget?: number };
export function committeeDomain(input: unknown): string {
  if (typeof input !== "string" || !input.trim()) return "";
  try {
    const url = new URL(input.includes("://") ? input.trim() : `https://${input.trim()}`);
    const domain = url.hostname.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
    if (!/^(?=.{3,253}$)(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)
      || url.username || url.password || url.port || /(^|\.)(localhost|local|internal|invalid|test|example)$/.test(domain)) return "";
    return domain;
  } catch { return ""; }
}
export async function requireHpCommitteeClient(tenantId: number, clientId: number) {
  if (!await isHpClient(tenantId, clientId)) committeeError("Select a tenant-owned HP client.", 404);
}
export async function apolloCommitteeConfig(tenantId: number) {
  const config = await getIntegrationConfig(tenantId, "apollo");
  return { configured: typeof config?.apiKey === "string" && !!config.apiKey && config.enabled !== false,
    maxRequests: Math.max(1, Math.min(500, Number(config?.maxRequestsPerRun) || 20)), apiKey: config?.apiKey as string | undefined };
}
export async function validateCommitteeSources(tenantId: number, clientId: number, audienceIds: number[]) {
  await requireHpCommitteeClient(tenantId, clientId);
  if (!audienceIds.length) return;
  const rows = await pool.query(`SELECT id FROM intent_audiences WHERE tenant_id=$1
    AND (client_id=$2 OR client_id IS NULL) AND id=ANY($3::int[])`, [tenantId, clientId, audienceIds]);
  if (rows.rows.length !== new Set(audienceIds).size) committeeError("A selected database is unavailable in this HP client.", 404);
}
/** Intersection with owned HP accounts; sources are unioned, never override client scope. */
const accountWhere = `c.tenant_id=$1 AND c.client_id=$2
  AND (($3::boolean AND EXISTS(SELECT 1 FROM hp_account_profiles p WHERE p.tenant_id=c.tenant_id
    AND p.client_id=c.client_id AND p.company_id=c.id))
    OR EXISTS(SELECT 1 FROM intent_audience_companies ac WHERE ac.tenant_id=c.tenant_id
      AND ac.company_id=c.id AND ac.audience_id=ANY($4::int[])))`;
export async function committeeAccounts(tenantId: number, clientId: number, includeRoster: boolean, audienceIds: number[], search: string, page: number, segment = "") {
  await validateCommitteeSources(tenantId, clientId, audienceIds);
  // Same saved GTM classification as HP Analytics; database-only accounts remain Unclassified.
  const segmentSql = "COALESCE(NULLIF(btrim(hp.gtm),''),'Unclassified')";
  const from = `FROM companies c LEFT JOIN hp_account_profiles hp
    ON hp.company_id=c.id AND hp.tenant_id=c.tenant_id AND hp.client_id=c.client_id`;
  const params = [tenantId, clientId, includeRoster, audienceIds, `%${search.replace(/[\\%_]/g, "\\$&")}%`, segment];
  const where = `${accountWhere} AND (c.name ILIKE $5 OR COALESCE(c.domain,'') ILIKE $5)
    AND ($6::text='' OR ${segmentSql}=$6)`;
  const [items, count, segments] = await Promise.all([
    pool.query(`SELECT c.id,c.name,c.domain,${segmentSql} AS segment ${from} WHERE ${where} ORDER BY lower(c.name),c.id LIMIT 20 OFFSET $7`, [...params, (page - 1) * 20]),
    pool.query(`SELECT count(*)::int total ${from} WHERE ${where}`, params),
    pool.query(`SELECT DISTINCT ${segmentSql} AS segment ${from} WHERE ${accountWhere} ORDER BY segment`, [tenantId, clientId, includeRoster, audienceIds]),
  ]);
  return { items: items.rows, total: count.rows[0].total, page, pageSize: 20, segments: segments.rows.map(r => r.segment) };
}
export async function committeeOwnedAccount(tenantId: number, input: { clientId: number; includeRoster: boolean; audienceIds: number[]; accountId: number }) {
  const result = await pool.query(`SELECT c.id,c.name,c.domain,c.website FROM companies c WHERE ${accountWhere}
    AND c.id=$5`, [tenantId, input.clientId, input.includeRoster, input.audienceIds, input.accountId]);
  if (!result.rows.length) committeeError("Account unavailable in the selected owned sources.", 404);
  return result.rows[0];
}
export async function committeePlan(tenantId: number, id: number) {
  const { rows } = await pool.query("SELECT * FROM buying_committee_plans WHERE tenant_id=$1 AND id=$2", [tenantId, id]);
  const plan = rows[0];
  if (!plan) committeeError("Buying committee plan not found.", 404);
  await requireHpCommitteeClient(tenantId, plan.client_id);
  const targets = await pool.query(`SELECT t.*,c.name FROM buying_committee_targets t
    JOIN companies c ON c.id=t.company_id AND c.tenant_id=t.tenant_id AND c.client_id=$3
    WHERE t.tenant_id=$1 AND t.plan_id=$2 ORDER BY t.id`, [tenantId, id, plan.client_id]);
  return { plan, targets: targets.rows.map(t => ({ ...t, status: t.status === "processing" && Date.now() - Date.parse(t.started_at) > 300_000 ? "interrupted" : t.status })) };
}
/** Prepare only: saving a new draft, approval and paid sourcing remain separate actions. */
export async function copyCommitteePlan(tenantId: number, id: number) {
  const { plan, targets } = await committeePlan(tenantId, id);
  if (plan.status !== "approved") committeeError("Only an approved plan can be copied for revision.", 409);
  const original = plan.config as CommitteeConfig;
  // Reuse reviewed snapshots, never today's CRM domain or an inferred country.
  const domains = Object.fromEntries(original.accountIds.map(accountId => [
    String(accountId), targets.find(t => t.company_id === accountId)?.domain ?? original.domains?.[String(accountId)] ?? "",
  ]));
  const config = committeePlanSchema.parse({
    ...original, clientId: plan.client_id, name: `${plan.name.slice(0, 136)} (revised)`, domains,
  });
  // The schema strips requestBudget and any other approval-only fields.
  return { config, accounts: original.accountIds.map(accountId => ({
    id: accountId, name: targets.find(t => t.company_id === accountId)?.name ?? `Account #${accountId}`,
  })) };
}
export async function saveCommitteePlan(tenantId: number, userId: number, config: CommitteeConfig, id?: number) {
  await validateCommitteeSources(tenantId, config.clientId, config.audienceIds);
  const selected = await pool.query(`SELECT c.id,c.name,c.domain FROM companies c WHERE ${accountWhere}
    AND c.id=ANY($5::int[]) ORDER BY c.id`, [tenantId, config.clientId, config.includeRoster, config.audienceIds, config.accountIds]);
  if (selected.rows.length !== config.accountIds.length) committeeError("Some accounts no longer belong to the selected HP roster/databases. Refresh the selection.");
  config = { ...config, categories: [...new Set(config.categories)], designations: [...new Set(config.designations)],
    domains: Object.fromEntries(selected.rows.map(account => {
      const supplied = config.domains[String(account.id)], domain = committeeDomain(supplied ?? account.domain);
      if (supplied?.trim() && !domain) committeeError(`Enter a valid company domain for ${account.name}.`);
      return [String(account.id), domain];
    })) };
  const cx = await pool.connect();
  try {
    await cx.query("BEGIN");
    let planId = id;
    if (id) {
      const updated = await cx.query(`UPDATE buying_committee_plans SET name=$3,config=$4::jsonb,revision=revision+1
        WHERE tenant_id=$1 AND id=$2 AND status='draft' AND client_id=$5 RETURNING id`,
      [tenantId, id, config.name, JSON.stringify(config), config.clientId]);
      if (!updated.rowCount) committeeError("Only an unapproved draft in this HP client can be edited.", 409);
      await cx.query("DELETE FROM buying_committee_targets WHERE tenant_id=$1 AND plan_id=$2", [tenantId, id]);
    } else {
      const result = await cx.query(`INSERT INTO buying_committee_plans(tenant_id,client_id,name,config,created_by)
        VALUES($1,$2,$3,$4::jsonb,$5) RETURNING id`, [tenantId, config.clientId, config.name, JSON.stringify(config), userId]);
      planId = result.rows[0].id;
    }
    for (const account of selected.rows) {
      const supplied = config.domains[String(account.id)];
      const domain = committeeDomain(supplied ?? account.domain);
      if (supplied?.trim() && !domain) committeeError(`Enter a valid company domain for ${account.name}.`);
      await cx.query(`INSERT INTO buying_committee_targets(tenant_id,plan_id,company_id,domain) VALUES($1,$2,$3,$4)`,
        [tenantId, planId, account.id, domain]);
    }
    await cx.query("COMMIT");
    return committeePlan(tenantId, planId!);
  } catch (err) { await cx.query("ROLLBACK"); throw err; } finally { cx.release(); }
}
export async function approveCommitteePlan(tenantId: number, userId: number, id: number, revision: number) {
  const { plan, targets } = await committeePlan(tenantId, id);
  if (!committeeCountry(plan.config.country)) committeeError("Select a contact country in Edit draft and save before approval.");
  if (targets.length !== plan.config.accountIds.length) committeeError("The saved account selection changed. Edit and review the draft again before approval.", 409);
  if (!targets.length || targets.some(t => !committeeDomain(t.domain))) committeeError("Confirm a valid company domain for every selected account before approval. Edit the draft to fill missing domains.");
  if (new Set(targets.map(t => t.domain)).size !== targets.length) committeeError("Multiple selected legal accounts share a domain. Review and source them separately to avoid misattribution.");
  const provider = await apolloCommitteeConfig(tenantId);
  if (provider.configured && targets.length * 2 > provider.maxRequests) committeeError(`This plan can use up to ${targets.length * 2} requests; the configured Apollo limit is ${provider.maxRequests}. Select fewer accounts or adjust the provider limit.`);
  const config = { ...plan.config, requestBudget: provider.maxRequests };
  const result = await pool.query(`UPDATE buying_committee_plans SET status='approved',approved_by=$3,approved_at=NOW(),config=$4::jsonb
    WHERE tenant_id=$1 AND id=$2 AND status='draft' AND revision=$5 RETURNING id`,
  [tenantId, id, userId, JSON.stringify(config), revision]);
  if (!result.rowCount) committeeError("This draft changed or was already approved. Reload and review it again.", 409);
  return committeePlan(tenantId, id);
}
