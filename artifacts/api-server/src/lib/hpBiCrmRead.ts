import { pool } from "@workspace/db";
import type { BusinessRecord } from "./hpBiMetrics";

export const crmIssueLimit = 25;
export interface CrmReadScope {
  selectedIds: Set<number>; start: string; end: string; showUnlinked: boolean;
  mirrors: BusinessRecord[];
}

// A single statement gives coverage and enrichment the same snapshot. The
// materialized narrow facts omit notes/audit JSON and scan only the client scope.
// All counts are exact; only the explicitly labelled issue preview is bounded.
export async function readHpCrm(tenantId: number, clientId: number, scope: CrmReadScope) {
  const asOf = `LEAST((NOW() AT TIME ZONE 'Asia/Kolkata')::date,($6::date-1))`;
  const open = `opp_valid AND actual_opportunity_date<=${asOf}
    AND ((stage IN ('proposal','negotiation') AND actual_outcome_date IS NULL) OR actual_outcome_date>${asOf})
    AND $5::date<=${asOf}`;
  const wonDuration = `out_valid AND out_in AND opp_valid AND stage='closed_won'
    AND actual_outcome_date>=actual_opportunity_date`;
  const references = [...new Set(scope.mirrors.flatMap(r => {
    const match = r.source === "excel" && r.externalEventId
      ? /^crm:deal:(\d+):(opportunity|outcome)$/.exec(r.externalEventId) : null;
    const id = match ? Number(match[1]) : 0;
    return Number.isSafeInteger(id) && id > 0 && id <= 2147483647 ? [id] : [];
  }))];
  const [facts, identities] = await Promise.all([
    pool.query(`WITH scoped AS MATERIALIZED (
      SELECT d.id,d.company_id,d.contact_id,d.title,d.stage,d.value,d.currency,d.value_meaning,
        d.booked_value,d.opportunity_confirmed,d.actual_opportunity_date,d.actual_outcome_date,
        d.expected_close_date,d.updated_at,c.name account_name,p.company_id profile_account_id,
        CASE WHEN d.contact_id IS NULL THEN true ELSE COALESCE(
          ct.id IS NOT NULL AND NOT ct.is_anonymous AND ct.company_id=d.company_id,false) END contact_valid
      FROM deals d
      LEFT JOIN companies c ON c.id=d.company_id AND c.tenant_id=d.tenant_id AND c.client_id=d.client_id
      LEFT JOIN hp_account_profiles p ON p.company_id=c.id AND p.tenant_id=d.tenant_id AND p.client_id=d.client_id
      LEFT JOIN contacts ct ON ct.id=d.contact_id AND ct.tenant_id=d.tenant_id AND ct.client_id=d.client_id
      WHERE d.tenant_id=$1 AND d.client_id=$2 AND (
        (p.company_id IS NOT NULL AND c.name<>'' AND d.company_id=ANY($3::int[]))
        OR ($4::boolean AND (p.company_id IS NULL OR c.name='')))
    ), flags AS (
      SELECT *,
        COALESCE(profile_account_id IS NOT NULL AND account_name<>'' AND contact_valid
          AND opportunity_confirmed AND stage=ANY($7::text[])
          AND actual_opportunity_date BETWEEN '0001-01-01'::date AND '9999-12-31'::date,false) opp_valid,
        COALESCE(profile_account_id IS NOT NULL AND account_name<>'' AND contact_valid
          AND stage=ANY($8::text[])
          AND actual_outcome_date BETWEEN '0001-01-01'::date AND '9999-12-31'::date,false) out_valid,
        COALESCE(actual_opportunity_date >= $5::date AND actual_opportunity_date < $6::date,false) opp_in,
        COALESCE(actual_outcome_date >= $5::date AND actual_outcome_date < $6::date,false) out_in,
        COALESCE(upper(currency)=ANY($9::text[]),false) currency_valid,
        COALESCE(value>=0 AND value::text NOT IN ('NaN','Infinity','-Infinity'),false) value_valid,
        COALESCE(booked_value>=0 AND booked_value::text NOT IN ('NaN','Infinity','-Infinity'),false) booked_valid
      FROM scoped
    ), classified AS MATERIALIZED (
      SELECT *,opp_valid AND opp_in opp_included,out_valid AND out_in out_included,
        NOT opp_valid OR NOT opp_in
        OR (opp_valid AND opp_in AND (value_meaning<>'total_order_value' OR NOT value_valid OR NOT currency_valid))
        OR (stage=ANY($8::text[]) AND (NOT out_valid OR NOT out_in
          OR (stage='closed_won' AND (NOT booked_valid OR NOT currency_valid)))) has_issue
      FROM flags
    ), summary AS (
      SELECT count(*)::int total,count(*) FILTER(WHERE opp_included)::int "includedOpportunities",
        count(*) FILTER(WHERE out_included)::int "includedOutcomes",
        count(*) FILTER(WHERE has_issue)::int "incompleteDeals",
        count(*) FILTER(WHERE NOT opp_included AND NOT out_included)::int "excludedDeals",
        jsonb_build_object(
          'asOfDate',CASE WHEN $5::date<=${asOf} THEN ${asOf}::text ELSE NULL END,
          'openDeals',CASE WHEN $5::date<=${asOf} THEN count(*) FILTER(WHERE ${open})::int ELSE NULL END,
          'avgOpenDealAge',avg(${asOf}-actual_opportunity_date) FILTER(WHERE ${open}),
          'avgDaysToClose',avg(actual_outcome_date-actual_opportunity_date) FILTER(WHERE ${wonDuration}),
          'closedDurationSamples',count(*) FILTER(WHERE ${wonDuration})::int
        ) AS lifecycle
      FROM classified
    ), preview AS (SELECT id FROM classified WHERE has_issue ORDER BY id LIMIT $10)
    SELECT 'summary' type,to_jsonb(summary) data FROM summary
    UNION ALL
    SELECT 'deal' type,to_jsonb(f) - ARRAY['opp_valid','out_valid','opp_in','out_in',
      'currency_valid','value_valid','booked_valid','opp_included','out_included','has_issue'] data
      FROM classified f WHERE f.opp_in OR f.out_in OR f.id IN (SELECT id FROM preview)
    UNION ALL
    SELECT 'issue' type,jsonb_build_object('id',id) data FROM preview`,
    [tenantId, clientId, [...scope.selectedIds], scope.showUnlinked,
      // Actual CRM days are India calendar dates, NOT the UTC date of the instant.
      scope.start.slice(0, 10), scope.end.slice(0, 10),
      ["proposal", "negotiation", "closed_won", "closed_lost"], ["closed_won", "closed_lost"],
      Intl.supportedValuesOf("currency"), crmIssueLimit]),
    // Indexed existence probes, never enumerate historical identities or audit
    // versions. No account/year predicate: moved/deleted deals still own mirrors.
    references.length ? pool.query(`SELECT ref.id FROM unnest($3::int[]) ref(id)
      WHERE EXISTS(SELECT 1 FROM deals d WHERE d.tenant_id=$1 AND d.client_id=$2 AND d.id=ref.id)
        OR EXISTS(SELECT 1 FROM deal_audit a WHERE a.tenant_id=$1 AND a.client_id=$2 AND a.deal_id=ref.id)`,
      [tenantId, clientId, references]) : Promise.resolve({ rows: [] }),
  ]);
  const deals = facts.rows.filter(r => r.type === "deal").map(r => ({
    ...r.data, updated_at: new Date(r.data.updated_at),
    expected_close_date: r.data.expected_close_date ? new Date(r.data.expected_close_date) : null,
  })).sort((a, b) => Number(a.id) - Number(b.id));
  const { lifecycle, ...coverage } = facts.rows.find(r => r.type === "summary")!.data;
  return {
    deals, coverage, lifecycle,
    issueIds: new Set<number>(facts.rows.filter(r => r.type === "issue").map(r => Number(r.data.id))),
    knownIds: new Set<number>(identities.rows.map(r => Number(r.id))),
  };
}
