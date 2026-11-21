import { pool } from "@workspace/db";
import { hpDimensions, usable } from "./hpBiImport";

type Profile = { company_id: number; name: string; hp_id: string | null; parent_key: string; parent_name: string;
  legal_name: string | null; top_name: string | null; mid_name: string | null; st_name: string | null;
  partial_name: string | null; aliases: string[]; dimensions: Record<string, any>; [key: string]: any };
const exact = (v: unknown) => String(v ?? "").trim().toLowerCase();
/** Candidate generation only. Removing corporate suffixes must never approve identity. */
const candidateName = (v: unknown) => exact(v).replace(/[^a-z0-9]+/g, " ")
  .replace(/\b(private|pvt|limited|ltd|incorporated|inc|corporation|corp)\b/g, " ").replace(/\s+/g, " ").trim();
const names = (p: Profile) => [p.name, p.legal_name, p.top_name, p.mid_name, p.st_name, p.partial_name, ...(p.aliases ?? [])].filter(usable);
const meaningfulTokens = (v: unknown) => candidateName(v).split(" ").filter(t =>
  (t.length >= 4 || /\d/.test(t)) && !["india", "group", "global", "services", "solutions", "international"].includes(t));
export function createRosterCandidateFinder(profiles: Profile[]) {
  const indexed = profiles.map(p => ({ p, labels: names(p).map(n => ({ exact: exact(n), normalized: candidateName(n), tokens: new Set(meaningfulTokens(n)) })) }));
  return (name: string) => {
    const strict = exact(name), normalized = candidateName(name), tokens = meaningfulTokens(name);
    return indexed.flatMap(({ p, labels }) => {
      const reason = labels.some(n => n.exact === strict) ? "Exact workbook name or hierarchy label"
        : normalized.length >= 4 && labels.some(n => n.normalized === normalized) ? "Similar legal name — review required"
        : tokens.length && labels.some(n => {
          const overlap = tokens.filter(t => n.tokens.has(t)).length;
          return overlap >= Math.ceil(tokens.length * 0.75) && overlap / Math.max(n.tokens.size, tokens.length) >= 0.4;
        }) ? "Shared company-name terms — review required" : null;
      return reason ? [{ accountId: Number(p.company_id), name: p.name, hpId: p.hp_id!,
        parentName: p.parent_name, reason }] : [];
    }).sort((a, b) => {
      const rank = (r: string) => r.startsWith("Exact") ? 0 : r.startsWith("Similar") ? 1 : 2;
      return rank(a.reason) - rank(b.reason) || a.name.localeCompare(b.name);
    }).slice(0, 8);
  };
}
export const rosterCandidates = (name: string, profiles: Profile[]) => createRosterCandidateFinder(profiles)(name);
export async function loadHpRosterAnalysis(tenantId: number, clientId: number) {
  const [profiles, inbound, coverage, imported] = await Promise.all([
    pool.query(`SELECT p.*,c.name FROM hp_account_profiles p JOIN companies c ON c.id=p.company_id
      AND c.tenant_id=p.tenant_id AND c.client_id=p.client_id WHERE p.tenant_id=$1 AND p.client_id=$2`, [tenantId, clientId]),
    pool.query(`SELECT s.account_id,COUNT(*)::int responses,
      COUNT(*) FILTER(WHERE classification='hot')::int hot,COUNT(*) FILTER(WHERE classification='warm')::int warm,
      COUNT(*) FILTER(WHERE classification='cold')::int cold FROM intent_inbound_submissions s
      JOIN companies c ON c.id=s.account_id AND c.tenant_id=s.tenant_id AND c.client_id=s.client_id
      WHERE s.tenant_id=$1 AND s.client_id=$2 GROUP BY s.account_id`, [tenantId, clientId]),
    pool.query(`SELECT e.key,COUNT(*) FILTER(WHERE btrim(e.value::text,'" ')<>'' AND lower(btrim(e.value::text,'" ')) NOT IN ('-','n/a','na','null','none'))::int populated
      FROM hp_account_profiles p CROSS JOIN LATERAL jsonb_array_elements(p.variants) v
      CROSS JOIN LATERAL jsonb_each(v) e WHERE p.tenant_id=$1 AND p.client_id=$2 AND p.hp_id IS NOT NULL
      AND e.key<>'_source' GROUP BY e.key`, [tenantId, clientId]),
    pool.query(`SELECT file_name,rows FROM hp_bi_imports WHERE tenant_id=$1 AND client_id=$2 AND kind='accounts'
      ORDER BY imported_at DESC,id DESC LIMIT 1`, [tenantId, clientId]),
  ]);
  const byId = new Map<number, Profile>(profiles.rows.map(p => [Number(p.company_id), p]));
  const roster = profiles.rows.filter(p => p.hp_id) as Profile[];
  const findCandidates = createRosterCandidateFinder(roster);
  const accounts = inbound.rows.map(r => {
    const p = byId.get(Number(r.account_id))!;
    const link = Number(p.dimensions?._rosterAssociation?.accountId);
    const target = byId.get(link);
    const linked = !!target?.hp_id;
    const candidates = p.hp_id ? [] : linked ? rosterCandidates(target.name, [target]) : findCandidates(p.name);
    return { accountId: Number(r.account_id), name: p.name,
      parentKey: linked ? target.parent_key : p.dimensions?._rosterAssociation?.previousParentKey ?? p.parent_key,
      responses: r.responses, hot: r.hot, warm: r.warm, cold: r.cold,
      status: r.hot ? "Hot" : r.warm ? "Warm" : r.cold ? "Cold" : "Unclassified",
      mapping: p.hp_id ? "roster" : linked ? "linked" : candidates.length ? "review" : "unmatched",
      // Retain the saved expected ID so a missing target can be unlinked or replaced.
      targetAccountId: Number.isSafeInteger(link) && link > 0 ? link : null, candidates };
  });
  return { columns: Object.entries(hpDimensions).map(([key, label]) => ({ key, label,
    populatedRows: Number(coverage.rows.find(r => r.key === label)?.populated ?? 0) })),
    // Coverage counts stored source variants, not merely the last import's row count.
    sourceRows: roster.reduce((sum, p) => sum + (Array.isArray(p.variants) ? p.variants.length : 0), 0),
    rosterAccounts: roster.length,
    fileName: imported.rows[0]?.file_name ?? null, accounts,
    responses: accounts.reduce((sum, a) => sum + a.responses, 0) };
}
/** Reporting association only: never transfer contacts, submissions, enrollments or legal IDs. */
export async function associateHpRoster(tenantId: number, clientId: number, sourceId: number,
  targetId: number | null, expectedId: number | null, userId: number | null) {
  const client = await pool.connect();
  const error = (message: string, status: number) => Object.assign(new Error(message), { status });
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1::int,914357)", [tenantId]);
    await client.query("SELECT pg_advisory_xact_lock($1::int,$2::int)", [tenantId, clientId]);
    const p = (await client.query(`SELECT p.* FROM hp_account_profiles p JOIN companies c ON c.id=p.company_id
      AND c.tenant_id=p.tenant_id AND c.client_id=p.client_id WHERE p.tenant_id=$1 AND p.client_id=$2 AND p.company_id=$3
      AND EXISTS(SELECT 1 FROM intent_inbound_submissions s WHERE s.tenant_id=p.tenant_id
        AND s.client_id=p.client_id AND s.account_id=p.company_id) FOR UPDATE OF p`, [tenantId, clientId, sourceId])).rows[0];
    if (!p || p.hp_id) throw error("Select an owned GTM-only account; a roster identity cannot be repurposed.", 404);
    const current = p.dimensions?._rosterAssociation;
    if ((current?.accountId ?? null) !== expectedId) throw error("Mapping changed since review. Reload before confirming.", 409);
    const dimensions = { ...p.dimensions };
    let parentKey = current?.previousParentKey ?? p.parent_key;
    let parentName = current?.previousParentName ?? p.parent_name;
    if (targetId != null) {
      const target = (await client.query(`SELECT p.* FROM hp_account_profiles p JOIN companies c ON c.id=p.company_id
        AND c.tenant_id=p.tenant_id AND c.client_id=p.client_id WHERE p.tenant_id=$1 AND p.client_id=$2
        AND p.company_id=$3 AND p.hp_id IS NOT NULL`, [tenantId, clientId, targetId])).rows[0];
      if (!target) throw error("Roster target not found in the same HP client.", 404);
      dimensions._rosterAssociation = { accountId: targetId, hpId: target.hp_id, name: target.legal_name,
        previousParentKey: parentKey, previousParentName: parentName, approvedBy: userId, approvedAt: new Date().toISOString() };
      parentKey = target.parent_key; parentName = target.parent_name;
    } else delete dimensions._rosterAssociation;
    await client.query(`UPDATE hp_account_profiles SET parent_key=$4,parent_name=$5,dimensions=$6::jsonb,updated_at=now(),
      edits=edits||jsonb_build_array(jsonb_build_object('at',now(),'action','roster-reporting-association','targetAccountId',$7::int))
      WHERE tenant_id=$1 AND client_id=$2 AND company_id=$3`,
    [tenantId, clientId, sourceId, parentKey, parentName, JSON.stringify(dimensions), targetId]);
    await client.query("COMMIT");
    return { associated: targetId != null, sourceAccountId: sourceId, targetAccountId: targetId };
  } catch (e) { await client.query("ROLLBACK"); throw e; }
  finally { client.release(); }
}
