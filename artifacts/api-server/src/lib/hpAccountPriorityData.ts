import { pool } from "@workspace/db";
import type { PoolClient } from "pg";
import { canonicalInboundSubmissionSql } from "./inboundSubmissionDuplicates";
import { loadHpMonitoringContext } from "./hpMonitoringContext";
import { field, positiveProduct } from "./hpBiImport";
import { parsePurchaseTimeframeMonths } from "./inboundAccounts";
import { calculateAccountPriority, formState, type PriorityForm, type PriorityActivity, type PrioritySignal } from "./hpAccountPriority";
import { isWarmNurtureContact } from "./hpNurturePolicy";

async function evidenceQueries(queries: (() => Promise<{ rows: any[] }>)[], parallel: boolean) {
  if (parallel) return Promise.all(queries.map(query => query()));
  // A transaction client has one connection; avoid pg's deprecated query queue.
  const results: { rows: any[] }[] = [];
  for (const query of queries) results.push(await query());
  return results;
}

/** Batched, owned evidence only. No provider requests or model calls. */
export async function loadHpPriorityEvidence(tenantId: number, clientId: number, accountIds: number[], now = new Date(), includeMonitoring = true,
  executor: Pick<PoolClient, "query"> = pool) {
  const forms: PriorityForm[] = [], activities: PriorityActivity[] = [], signals: PrioritySignal[] = [];
  const respondents = new Set<number>(), blockedContacts = new Set<number>();
  if (!accountIds.length) return { forms, activities, signals, respondents, blockedContacts };
  const params = [tenantId, clientId, accountIds];
  const [inbound, leads, journeyForms, activity, monitored, blocked, salesFeedback] = await evidenceQueries([
    () => executor.query(`SELECT s.id,s.account_id,s.contact_id,s.product_interest,s.affinity_reviews,s.purchase_timeframe_months,
      COALESCE(s.submitted_at,s.created_at) AS at
      FROM intent_inbound_submissions s JOIN companies c ON c.id=s.account_id AND c.tenant_id=s.tenant_id AND c.client_id=s.client_id
      LEFT JOIN contacts ct ON ct.id=s.contact_id AND ct.tenant_id=s.tenant_id AND ct.client_id=s.client_id AND ct.company_id=s.account_id AND NOT ct.is_anonymous
      WHERE s.tenant_id=$1 AND s.client_id=$2 AND s.account_id=ANY($3::int[])
      AND (s.contact_id IS NULL OR ct.id IS NOT NULL)
      AND COALESCE(s.identity_review,'')<>'keep' AND COALESCE(s.routing_error,'') NOT ILIKE '%email%another account%'
      AND ${canonicalInboundSubmissionSql("s")}`, params),
    () => executor.query(`SELECT r.id,r.account_id,r.contact_id,r.product,r.horizon_months,r.occurred_at AS at
      FROM hp_bi_records r JOIN companies c ON c.id=r.account_id AND c.tenant_id=r.tenant_id AND c.client_id=r.client_id
      LEFT JOIN contacts ct ON ct.id=r.contact_id AND ct.tenant_id=r.tenant_id AND ct.client_id=r.client_id AND ct.company_id=r.account_id AND NOT ct.is_anonymous
      WHERE r.tenant_id=$1 AND r.client_id=$2 AND r.account_id=ANY($3::int[]) AND r.kind='lead'
      AND (r.contact_id IS NULL OR ct.id IS NOT NULL) AND r.source_key NOT LIKE 'inbound:%'
      AND r.source NOT IN ('questionnaire','questionnaire response')`, params),
    () => executor.query(`SELECT f.id,c.company_id AS account_id,c.id AS contact_id,f.field_values,jf.config,f.submitted_at AS at
      FROM form_submissions f JOIN contacts c ON c.id=f.contact_id AND c.tenant_id=f.tenant_id AND NOT c.is_anonymous
      JOIN journeys j ON j.id=f.journey_id AND j.tenant_id=f.tenant_id AND j.client_id=c.client_id
      LEFT JOIN journey_forms jf ON jf.id=f.form_id AND jf.tenant_id=f.tenant_id
      WHERE f.tenant_id=$1 AND c.client_id=$2 AND c.company_id=ANY($3::int[])`, params),
    () => executor.query(`SELECT c.company_id AS account_id,c.id AS contact_id,a.stage,max(a.created_at) AS at
      FROM activity_events a JOIN contacts c ON c.id=a.contact_id AND c.tenant_id=a.tenant_id AND NOT c.is_anonymous
      JOIN journeys j ON j.id=a.journey_id AND j.tenant_id=a.tenant_id AND j.client_id=c.client_id
      WHERE a.tenant_id=$1 AND c.client_id=$2 AND c.company_id=ANY($3::int[])
      AND (a.client_id IS NULL OR a.client_id=$2) AND (a.company_id IS NULL OR a.company_id=c.company_id)
      AND a.event_type='page_view' AND NOT COALESCE(a.is_bot,false)
      AND a.created_at >= $4::timestamptz-interval '2 years' AND a.created_at<=$4
      GROUP BY c.company_id,c.id,a.stage`, [...params, now.toISOString()]),
    () => includeMonitoring ? executor.query(`SELECT DISTINCT e.account_id FROM intent_evidence e JOIN companies c
      ON c.id=e.account_id AND c.tenant_id=e.tenant_id
      WHERE e.tenant_id=$1 AND c.client_id=$2 AND e.account_id=ANY($3::int[])
      AND e.review_status='approved' AND e.occurred_at>=$4::timestamptz-interval '180 days'`, [...params, now.toISOString()]) : Promise.resolve({rows: []}),
    () => executor.query(`SELECT DISTINCT s.contact_id FROM intent_inbound_submissions s
      JOIN contacts c ON c.id=s.contact_id AND c.tenant_id=s.tenant_id AND c.client_id=s.client_id AND c.company_id=s.account_id
      WHERE s.tenant_id=$1 AND s.client_id=$2 AND s.account_id=ANY($3::int[])
      AND (s.identity_review='keep' OR s.routing_error ILIKE '%email%another account%')`, params),
    () => executor.query(`SELECT f.id,f.account_id,f.contact_id,f.product,f.timing_months,f.occurred_at AS at
      FROM sales_feedback f JOIN contacts ct ON ct.id=f.contact_id AND ct.tenant_id=f.tenant_id AND ct.client_id=f.client_id AND ct.company_id=f.account_id
      JOIN companies c ON c.id=f.account_id AND c.tenant_id=f.tenant_id AND c.client_id=f.client_id
      WHERE f.tenant_id=$1 AND f.client_id=$2 AND f.account_id=ANY($3::int[])
      AND f.review_status='approved' AND f.approved_qualification AND f.occurred_at IS NOT NULL AND NOT ct.is_anonymous
      AND NOT EXISTS(SELECT 1 FROM sales_feedback newer WHERE newer.tenant_id=f.tenant_id AND newer.record_key=f.record_key AND newer.id>f.id)`,params),
  ], executor === pool);
  const push = (row: any, product: string, months: unknown, reference: string) => {
    if (!positiveProduct(product) || !row.at) return;
    forms.push({ accountId: Number(row.account_id), contactId: row.contact_id ? Number(row.contact_id) : null,
      product, months: months === null || months === undefined ? null : Number(months),
      at: new Date(row.at).toISOString(), reference, overrides: row.affinity_reviews ?? null });
  };
  for (const row of [...inbound.rows, ...leads.rows, ...journeyForms.rows]) if (row.contact_id) respondents.add(Number(row.contact_id));
  for (const row of blocked.rows) blockedContacts.add(Number(row.contact_id));
  for (const row of inbound.rows) for (const selection of String(row.product_interest ?? "").split(/[,;|\n]/)) {
    if (row.affinity_reviews?.[selection.trim()] !== "rejected")
      push(row, selection.trim(), row.purchase_timeframe_months, `inbound:${row.id}`);
  }
  for (const row of leads.rows) push(row, row.product ?? "", row.horizon_months, `bi:${row.id}`);
  for (const row of salesFeedback.rows) {
    if(row.contact_id)respondents.add(Number(row.contact_id));
    push(row,row.product??"",row.timing_months,`sales-feedback:${row.id}`);
  }
  for (const row of journeyForms.rows) {
    const fields = { ...row.field_values };
    for (const f of row.config?.fields ?? []) for (const key of [f.label, f.mapToBiField, f.mapToContactField])
      if (key && row.field_values?.[f.id] !== undefined) fields[key] = row.field_values[f.id];
    push(row, String(field(fields, "productInterest", "product", "service", "solution") ?? ""),
      parsePurchaseTimeframeMonths(field(fields, "horizonMonths", "timeframe", "purchase timeframe")), `form:${row.id}`);
  }
  for (const row of activity.rows) activities.push({ accountId: Number(row.account_id), contactId: Number(row.contact_id),
    stage: row.stage, at: new Date(row.at).toISOString() });
  // Priority uses validated heat/products only, not account-detail research cards
  // or monitoring-run history across the entire roster.
  if (monitored.rows.length) for (const account of await loadHpMonitoringContext(tenantId, clientId, monitored.rows.map(r => Number(r.account_id)), "priority")) {
    for (const finding of account.findings.filter(finding => finding.heat !== "Cold")) signals.push({ accountId: account.accountId, heat: finding.heat,
      at: finding.occurredAt, url: finding.sourceUrl,
      products: finding.categories.flatMap(c => c.products.length ? c.products.map(p => p.name) : [c.name]) });
  }
  return { forms, activities, signals, respondents, blockedContacts };
}
export type HpPriorityEvidence = Awaited<ReturnType<typeof loadHpPriorityEvidence>>;
export function priorityForAccounts(data: HpPriorityEvidence, ids: Set<number>, now = new Date()) {
  return calculateAccountPriority(data.forms.filter(r => ids.has(r.accountId)), data.activities.filter(r => ids.has(r.accountId)),
    data.signals.filter(r => ids.has(r.accountId)), now);
}
/** Only attributable people with current product evidence may enter product journeys. */
export function warmRoutingCandidates(data: HpPriorityEvidence, ids: Set<number>, now = new Date()) {
  const result: { accountId: number; contactId: number; product: string; overrides?: Record<string, unknown> | null }[] = [];
  for (const form of data.forms) if (ids.has(form.accountId) && form.contactId && !data.blockedContacts.has(form.contactId)
    && formState(form, now).current && formState(form, now).value > 0)
    result.push({ accountId: form.accountId, contactId: form.contactId, product: form.product, overrides: form.overrides });
  // With no declared form match, require recent attributable journey behaviour.
  for (const activity of data.activities) if (ids.has(activity.accountId) && ["engage", "advance-engage", "action"].includes(activity.stage)
    && !data.respondents.has(activity.contactId) && !data.blockedContacts.has(activity.contactId)
    && Date.parse(activity.at) >= now.getTime() - 30 * 86400000) {
    for (const signal of data.signals.filter(s => s.accountId === activity.accountId && s.heat !== "Cold"))
      for (const product of signal.products) result.push({ accountId: activity.accountId, contactId: activity.contactId, product });
  }
  return result.filter(candidate => isWarmNurtureContact(candidate.contactId, candidate.accountId, data, now));
}
