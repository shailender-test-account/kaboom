import { pool } from "@workspace/db";
import { isCurrentResearchOpportunityBrief } from "./researchOpportunityInterpreter";
import { isUnattributedResearch as isUnattributedProcurement } from "./publicResearchAttribution";
import { monitoredAccountContext } from "./monitoredAccountContext";
import { analyzeMonitoringFindings } from "./monitoringFindingAnalysis";
import { hpEffectiveParentSql } from "./hpParentResearch";

type Heat = "Hot" | "Warm" | "Cold";
export interface MonitoringContext {
  accountId: number; accountName: string; lastCheckedAt: string | null; runStatus: string | null;
  researchScope?: "parent" | "member";
  memberAccountIds?: number[];
  analysisAccountId?: number | null;
  takeaways?: ReturnType<typeof monitoredAccountContext>["takeaways"];
  validationSummary?: string | null;
  businessDirections?: ReturnType<typeof monitoredAccountContext>["businessDirections"];
  sourceEvidence?: ReturnType<typeof monitoredAccountContext>["evidence"];
  findings: {
    evidenceId: number; occurredAt: string; excerpt: string; sourceUrl: string; heat: Heat;
    categories: { name: string; heat: Heat; rationale: string;
      products: { productId: number; name: string; rationale: string }[] }[]; nextAction: string | null;
  }[];
}
export interface MonitoringRow {
  account_id: number; account_name: string; last_checked_at: Date | string | null; run_status: string | null;
  evidence_id: number | null; occurred_at: Date | string | null; excerpt: string | null;
  source_url: string | null; context: Record<string, unknown> | null; brief: unknown;
  event_type?: string | null; original_excerpt?: string | null; reviewed_by?: number | null;
  raw_evidence?: unknown; account_domain?: string | null;
}
const rank: Record<Heat, number> = { Hot: 0, Warm: 1, Cold: 2 };
const date = (value: Date | string | null) => value ? new Date(value).toISOString() : null;
/** Preserve the exact original-source inputs consumed by geography/date guards. */
function sourceContextSql(value: string) {
  const eventKeys = ["description", "headline", "title", "affected_market", "event_location", "city", "location", "market"];
  const event = (path: string) => `jsonb_build_object(${eventKeys.map(key => `'${key}',${path}->'${key}'`).join(",")})`;
  return `jsonb_build_object(
    'publishedDate',${value}->'publishedDate','published_date',${value}->'published_date',
    'sourceTitle',${value}->'sourceTitle',
    'rawEvent',${event(`(${value}->'rawEvent')`)} || jsonb_build_object('data',${event(`(${value}->'rawEvent'->'data')`)}))`;
}
function scoringContextSql(value: string) {
  return `${sourceContextSql(value)} || jsonb_build_object(
    'searchKind',${value}->'searchKind','originalExcerpt',${value}->'originalExcerpt',
    'scope',${value}->'scope','country',${value}->'country',
    'aiReview',CASE WHEN ${value}->'aiReview' IS NULL OR ${value}->'aiReview' IN ('null'::jsonb,'false'::jsonb,'0'::jsonb,'""'::jsonb)
      THEN false ELSE true END)`;
}
function publicUrl(value: unknown) {
  try { const url = new URL(String(value)); return /^https?:$/.test(url.protocol) ? url.href : null; }
  catch { return null; }
}

/** Read-only projection: research never becomes a contact response or a fiscal lead. */
export function monitoringContextFromRows(rows: MonitoringRow[], now = new Date(), includeResearch = true): MonitoringContext[] {
  const accounts = new Map<number, MonitoringContext>();
  const researchRows = new Map<number, MonitoringRow[]>();
  for (const row of rows) {
    const id = Number(row.account_id);
    let account = accounts.get(id);
    if (!account) {
      account = { accountId: id, accountName: row.account_name, lastCheckedAt: date(row.last_checked_at),
        runStatus: row.run_status, findings: [] };
      accounts.set(id, account);
    }
    const sourceUrl = publicUrl(row.source_url);
    if (!row.evidence_id || !row.occurred_at || !sourceUrl || !row.excerpt) continue;
    // Do not let country/query metadata, AI conclusions, or an account's name
    // manufacture India relevance for otherwise global source text.
    const context = row.context ?? {};
    const original = row.raw_evidence as { excerpt?: unknown } | null;
    if (isUnattributedProcurement({ eventType: row.event_type, searchKind: String(context.searchKind ?? ""),
      excerpt: row.excerpt, originalExcerpt: typeof original?.excerpt === "string"
        ? original.excerpt : row.original_excerpt ?? context.originalExcerpt as string | undefined, sourceUrl,
      companyName: row.account_name, companyDomain: row.account_domain, manuallyReviewed: row.reviewed_by != null })) continue;
    const sourceFinding = {
      id: Number(row.evidence_id), excerpt: row.excerpt, sourceUrl, occurredAt: date(row.occurred_at)!,
      reviewStatus: "approved", eventType: row.event_type ?? null,
      context: { ...context, originalExcerpt: row.original_excerpt ?? context.originalExcerpt },
      raw_evidence: row.raw_evidence,
    };
    if (!analyzeMonitoringFindings([sourceFinding], now, { name: row.account_name, domain: row.account_domain }).length) continue;
    researchRows.set(id, [...(researchRows.get(id) ?? []), row]);
    const brief = isCurrentResearchOpportunityBrief(row.brief) ? row.brief : null;
    const categories = (brief?.categoryConclusions ?? [])
      .filter(category => category.sourceUrls?.some(url => publicUrl(url) === sourceUrl))
      .map(category => ({ name: category.categoryName,
        heat: (category.tier === "hot" ? "Hot" : category.tier === "warm" ? "Warm" : "Cold") as Heat,
        rationale: category.rationale,
        products: category.tier === "hot" || category.tier === "warm"
          ? (category.recommendedProducts ?? []).filter(product =>
            Number.isInteger(product.productId) && product.productId > 0 &&
            typeof product.name === "string" && product.name.trim().length > 0 &&
            typeof product.rationale === "string" && product.rationale.trim().length > 0)
            .map(product => ({ productId: product.productId, name: product.name, rationale: product.rationale }))
          : [] }))
      .sort((a, b) => rank[a.heat] - rank[b.heat]);
    if (account.findings.some(finding => finding.sourceUrl === sourceUrl)) continue;
    account.findings.push({
      evidenceId: Number(row.evidence_id), occurredAt: date(row.occurred_at)!, excerpt: row.excerpt,
      sourceUrl, heat: categories[0]?.heat ?? "Cold", categories,
      nextAction: categories.length ? brief?.entryOffer ?? null : null,
    });
  }
  for (const account of accounts.values()) {
    if (!includeResearch) {
      account.findings.sort((a, b) => rank[a.heat] - rank[b.heat] || b.occurredAt.localeCompare(a.occurredAt));
      account.findings = account.findings.slice(0, 3);
      continue;
    }
    const sourceRows = researchRows.get(account.accountId) ?? [];
    const research = monitoredAccountContext(sourceRows.map(row => ({
      id: Number(row.evidence_id), excerpt: row.excerpt!, sourceUrl: row.source_url,
      occurredAt: date(row.occurred_at)!, reviewStatus: "approved", eventType: row.event_type ?? null,
      context: { ...row.context, originalExcerpt: row.original_excerpt ?? row.context?.originalExcerpt, opportunityBrief: row.brief },
      raw_evidence: row.raw_evidence,
    })), now, { name: account.accountName, domain: sourceRows[0]?.account_domain, clientName: "HP" });
    account.takeaways = research.takeaways;
    account.validationSummary = research.validationSummary;
    account.businessDirections = research.businessDirections;
    account.sourceEvidence = research.evidence;
    account.findings.sort((a, b) => rank[a.heat] - rank[b.heat] || b.occurredAt.localeCompare(a.occurredAt));
    account.findings = account.findings.slice(0, 3);
  }
  return [...accounts.values()].sort((a, b) =>
    rank[a.findings[0]?.heat ?? "Cold"] - rank[b.findings[0]?.heat ?? "Cold"] ||
    (b.lastCheckedAt ?? "").localeCompare(a.lastCheckedAt ?? "") || a.accountName.localeCompare(b.accountName));
}

async function loadScoringBriefs(tenantId: number, clientId: number, ids: number[]) {
  const result = await pool.query<{ account_id: number; brief: unknown }>(`
    SELECT co.id AS account_id,brief.value AS brief FROM companies co
    JOIN LATERAL (
      SELECT jsonb_build_object(
        'fitmentPolicyVersion',ev.context->'opportunityBrief'->'fitmentPolicyVersion',
        'whyNow',ev.context->'opportunityBrief'->'whyNow',
        'entryOffer',ev.context->'opportunityBrief'->'entryOffer',
        'categoryConclusions',ev.context->'opportunityBrief'->'categoryConclusions') AS value
      FROM intent_evidence ev WHERE ev.tenant_id=co.tenant_id AND ev.account_id=co.id
        AND ev.evidence_kind='public_event' AND ev.review_status='approved'
        AND ev.context ? 'opportunityBrief'
        AND ev.occurred_at>=NOW()-interval '3 months' AND ev.occurred_at<=NOW()
      ORDER BY ev.id DESC LIMIT 1
    ) brief ON true
    WHERE co.tenant_id=$1 AND co.client_id=$2 AND co.id=ANY($3::int[])`, [tenantId, clientId, ids]);
  return new Map(result.rows.map(row => [Number(row.account_id), row.brief]));
}

export async function loadHpMonitoringContext(tenantId: number, clientId: number, accountIds: number[], mode: boolean | "priority" = true) {
  const includeResearch = mode === true;
  if (!accountIds.length) return [];
  const hierarchy = (await pool.query<{ company_id: number; parent_key: string; parent_name: string }>(
    hpEffectiveParentSql, [tenantId, accountIds])).rows;
  const parents = (await pool.query<{ account_id: number; parent_key: string; parent_name: string }>(
    `SELECT m.account_id,m.parent_key,m.parent_name FROM hp_parent_research_accounts m
      JOIN companies c ON c.id=m.account_id AND c.tenant_id=m.tenant_id AND c.client_id=m.client_id
      WHERE m.tenant_id=$1 AND m.client_id=$2 AND
        (m.parent_key=ANY($3::text[]) OR m.account_id=ANY($4::int[]))`,
    [tenantId, clientId, hierarchy.map(row => row.parent_key).filter(Boolean), accountIds])).rows;
  const directParents = parents.filter(parent => accountIds.includes(parent.account_id));
  if (directParents.length) {
    const keys = directParents.map(parent => parent.parent_key);
    const candidates = (await pool.query<{company_id:number}>(`SELECT company_id FROM hp_account_profiles
      WHERE tenant_id=$1 AND client_id=$2 AND parent_key=ANY($3::text[])`, [tenantId,clientId,keys])).rows;
    if (candidates.length) {
      const members = (await pool.query<{company_id:number;parent_key:string;parent_name:string}>(
        hpEffectiveParentSql,[tenantId,candidates.map(row=>row.company_id)])).rows;
      hierarchy.push(...members.filter(row=>keys.includes(row.parent_key)&&!hierarchy.some(existing=>existing.company_id===row.company_id)));
    }
  }
  const ids = [...new Set([...accountIds, ...hierarchy.map(row=>row.company_id), ...parents.map(row => row.account_id)])];
  const briefs = !includeResearch ? await loadScoringBriefs(tenantId, clientId, ids) : new Map<number, unknown>();
  // Cold/missing/stale-policy briefs contribute exactly zero monitoring points
  // and cannot supply products for Warm routing. Do not hydrate their articles
  // merely to calculate that zero; keep the unchanged top-30 source guard for
  // every potentially contributing account.
  const readIds = mode === "priority" ? ids.filter(id => {
    const brief = briefs.get(id);
    return isCurrentResearchOpportunityBrief(brief) &&
      brief.categoryConclusions?.some(category => category.tier === "hot" || category.tier === "warm");
  }) : ids;
  if (!readIds.length) return [];
  const result = await pool.query<MonitoringRow>(`
    SELECT co.id AS account_id,co.name AS account_name,co.domain AS account_domain,
      COALESCE(run.last_completed_at,co.last_researched_at) AS last_checked_at,
      run.status AS run_status,e.id AS evidence_id,e.occurred_at,e.excerpt,e.source_url,e.context,
      e.event_type,e.original_excerpt,e.raw_evidence,e.reviewed_by,${includeResearch ? "brief.value" : "NULL::jsonb"} AS brief
    FROM companies co
    LEFT JOIN LATERAL (
      SELECT a.status,
        max(a.completed_at) FILTER (WHERE a.status='completed') OVER () AS last_completed_at
      FROM intent_research_run_accounts a
      JOIN intent_research_runs r ON r.tenant_id=a.tenant_id AND r.id=a.run_id AND r.client_id=co.client_id
      WHERE ${includeResearch ? "true" : "false"} AND a.tenant_id=co.tenant_id AND (
        (a.account_id=co.id AND COALESCE(a.summary->'researchSubject'->>'scope','member')<>'parent')
        OR a.summary->'researchSubject'->>'accountId'=co.id::text)
        AND a.summary->>'reusedParentCheck' IS DISTINCT FROM 'true'
      ORDER BY a.created_at DESC,a.id DESC LIMIT 1
    ) run ON true
    LEFT JOIN LATERAL (
      SELECT ev.id,ev.occurred_at,ev.excerpt,ev.source_url,
        ${includeResearch ? "ev.context" : scoringContextSql("ev.context")} AS context,ev.event_type,
        ev.raw_evidence->>'excerpt' AS original_excerpt,
        ${includeResearch ? "ev.raw_evidence" : `CASE WHEN jsonb_typeof(ev.raw_evidence)='object' AND ev.raw_evidence<>'{}'::jsonb
          THEN jsonb_build_object('excerpt',ev.raw_evidence->'excerpt','context',${sourceContextSql("(ev.raw_evidence->'context')")},
            'companyName',ev.raw_evidence->'companyName') ELSE ev.raw_evidence END`} AS raw_evidence,
        ev.reviewed_by FROM intent_evidence ev
      WHERE ev.tenant_id=co.tenant_id AND ev.account_id=co.id AND ev.evidence_kind='public_event'
        AND ev.review_status='approved'
        AND ev.occurred_at>=NOW()-interval '3 months' AND ev.occurred_at<=NOW()
      ORDER BY ev.occurred_at DESC,ev.id DESC LIMIT 30
    ) e ON true
    ${includeResearch ? `LEFT JOIN LATERAL (
      SELECT ev.context->'opportunityBrief' AS value FROM intent_evidence ev
      WHERE ev.tenant_id=co.tenant_id AND ev.account_id=co.id AND ev.evidence_kind='public_event'
        AND ev.review_status='approved' AND ev.context ? 'opportunityBrief'
        AND ev.occurred_at>=NOW()-interval '3 months' AND ev.occurred_at<=NOW()
      ORDER BY ev.id DESC LIMIT 1
    ) brief ON true` : ""}
    WHERE co.tenant_id=$1 AND co.client_id=$2 AND co.id=ANY($3::int[])
      AND (co.last_researched_at IS NOT NULL OR run.status IS NOT NULL OR e.id IS NOT NULL)
    ORDER BY co.id,e.occurred_at DESC,e.id DESC`, [tenantId, clientId, readIds]);
  if (!includeResearch && result.rows.length) {
    // A saved brief belongs to the account, not to every supporting source.
    // Transport it once and share the immutable value within this fresh read.
    for (const row of result.rows) row.brief = briefs.get(Number(row.account_id)) ?? null;
  }
  const contexts: MonitoringContext[] = monitoringContextFromRows(result.rows, new Date(), includeResearch).map(context => {
    const parent = parents.find(row => row.account_id === context.accountId);
    return { ...context, researchScope: parent ? "parent" as const : "member" as const,
      analysisAccountId: context.accountId,
      memberAccountIds: parent ? hierarchy.filter(row => row.parent_key === parent.parent_key).map(row => row.company_id) : [context.accountId] };
  });
  // Explicit empty parent panel prevents historical member findings becoming the
  // apparent primary analysis before the first genuine parent check has run.
  for (const key of new Set(hierarchy.map(row => row.parent_key).filter(Boolean))) {
    const members = hierarchy.filter(row => row.parent_key === key);
    // A research identity may have an automatically created company profile.
    // It is already the mapped parent, not a member of a new "company:<id>" parent.
    if (members.every(member => parents.some(parent => parent.account_id === member.company_id))) continue;
    if (!members[0]?.parent_name?.trim() || parents.some(parent => parent.parent_key === key) &&
        contexts.some(context => context.accountId === parents.find(parent => parent.parent_key === key)?.account_id)) continue;
    const parent = parents.find(row => row.parent_key === key);
    contexts.push({ accountId: parent?.account_id ?? members[0].company_id, accountName: members[0].parent_name,
      lastCheckedAt: null, runStatus: null, findings: [], researchScope: "parent", analysisAccountId: parent?.account_id ?? null,
      memberAccountIds: members.map(row => row.company_id) });
  }
  return contexts.sort((a, b) => Number(b.researchScope === "parent") - Number(a.researchScope === "parent"));
}
