import { hpEvidenceKindMatches } from "./hpBiEvidenceKinds";
import { pool } from "@workspace/db";
import { isHpClientName } from "./hpClientScope";
import { loadHpAttributedEvents } from "../routes/accountsAnalytics";
import { canonicalizeInbound, parsePurchaseTimeframeMonths, repairInboundProductInterestClassifications } from "./inboundAccounts";
import { field, fiscalBounds, hpDimensions, hpContextFields, hpLeadStatus, normalizeRad, positiveProduct, text, ensureHpAccountRegister } from "./hpBiImport";
import { hpMissingFields } from "./hpAccountCompletion";
import { inboundCategories, inboundCategoryForInterest, loadInboundCategoryRules } from "./inboundTaxonomy";
import { isCrmMirror, loadHpCrm, projectHpCrm, crmIssueLimit } from "./hpBiCrm";
import { loadHpGtmQualification } from "./hpGtmQualification";
import { enrichEngagementContacts, strongestQualification, storedPoints } from "./engagementHistory";
import { groupQuestionnaireRecords, linkQuestionnaireRecords } from "./hpSourceEvidence";
import { canonicalInboundSubmissionSql } from "./inboundSubmissionDuplicates";
import { hpSalesAssignments, ownershipFields } from "./hpSalesAssignments";
import { opportunityCategory } from "./hpBiOpportunityFilter";
import { loadHpMonitoringContext } from "./hpMonitoringContext";
import { filterHpAccountQualification } from "./hpAccountSort";
import { hpMonitoringCoverage, matchesHpMonitoring, type HpMonitoringFilter } from "./hpMonitoringCoverage";
import { inboundSubmissionId, readInboundProvenance, type InboundProvenance } from "./inboundSubmissionProvenance";
import { loadHpPriorityEvidence, priorityForAccounts } from "./hpAccountPriorityData";
import { loadHpWarmRouting } from "./hpWarmRouting";

import { sortHpAccounts, type HpAccountSortField } from "./hpAccountSort";
export interface HpFilters { monitoring?: HpMonitoringFilter; gtmSource?: "lead_form" | "event_feedback"; qualification?: "Hot"|"Warm"|"Cold"; salesPerson?: string; opportunity?: string; clientId: number; year: number; sortBy?: HpAccountSortField; sortDir?: "asc" | "desc"; sortCurrency?: string; segment?: string; rad?: string; basis?: string; search?: string; newOnly?: boolean; abmOnly?: boolean; incompleteOnly?: boolean; groupResponses?: boolean; page: number; pageSize: number; parentKey?: string; dimension?: string; dimensionValue?: string; month?: number; quarter?: number; kind?: string; category?: string; start?: string; end?: string }
export type BusinessRecord = { id: string; accountId: number; contactId: number | null; kind: string; occurredAt: string;
  provenance?: InboundProvenance;
  sourceSubmissionId?: number;
  category: string | null; product: string | null; horizonMonths: number | null; orderValue: number | null;
  currency: string | null; source: string; sourceName: string | null; status: string | null; externalEventId?: string | null; lineage?: Record<string, unknown>; exclusionReasons?: string[];
  responseRecordId?: string; qualificationRecordId?: string };
const iso = (v: unknown) => v instanceof Date ? v.toISOString() : text(v);
const touchKinds = new Set(["attendance", "invitation", "digital", "content", "other", "interest"]);
function addMoney(target: Record<string, number>, r: BusinessRecord) {
  if (r.orderValue !== null && r.currency && Number.isFinite(r.orderValue)) target[r.currency] = (target[r.currency] || 0) + r.orderValue;
}
const numeric = (v: unknown) => v === null || v === undefined || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null;
function toRecord(r: any): BusinessRecord {
  return { id: `hp:${r.id}`, accountId: Number(r.account_id), contactId: r.contact_id ? Number(r.contact_id) : null, kind: r.kind,
    occurredAt: iso(r.occurred_at), category: r.category, product: r.product, horizonMonths: numeric(r.horizon_months),
    orderValue: numeric(r.order_value), currency: r.currency, source: r.source, sourceName: r.source_name, status: r.status,
    sourceSubmissionId: inboundSubmissionId({ id: r.source_key ?? "" }) ?? undefined,
    externalEventId: r.external_event_id, lineage: r.lineage };
}
async function enrichSourceProvenance(tenantId: number, clientId: number, records: BusinessRecord[]) {
  const provenance = await readInboundProvenance(tenantId, clientId, records.flatMap(r => {
    const submissionId = inboundSubmissionId(r);
    return submissionId === null ? [] : [{ submissionId, accountId: r.accountId, contactId: r.contactId }];
  }));
  for (const r of records) {
    const id = inboundSubmissionId(r);
    if (id !== null && provenance.has(id)) r.provenance = provenance.get(id);
  }
}
const segmentName = (s: unknown) => text(s) === "India Inc/PSU" ? "India Inc/PSU" : text(s) || "Unclassified";
/** Actual submissions are contributor evidence even when they do not create a lead. */
export function hpFormEvidence(row: any, fields: Record<string, unknown>): BusinessRecord {
  return { id: `form:${row.id}`, accountId: Number(row.company_id), contactId: Number(row.contact_id), kind: "other",
    occurredAt: iso(row.submitted_at), category: text(field(fields, "category")) || null,
    product: text(field(fields, "productInterest", "product", "service", "solution")) || null,
    horizonMonths: parsePurchaseTimeframeMonths(field(fields, "horizonMonths", "timeframe", "purchase timeframe")),
    orderValue: numeric(field(fields, "orderValue", "totalOrderValue", "Total Order Value", "ToV")),
    currency: text(field(fields, "currency")).toUpperCase() || null,
    source: "journey form", sourceName: text(row.config?.title) || null, status: "form_submitted" };
}
export async function loadHpBiFacts(tenantId: number, filters: HpFilters, includeProfileDetails = false) {
  const { clientId, year } = filters;
  await ensureHpAccountRegister(tenantId, clientId);
  const bounds = filters.start && filters.end ? { start: filters.start, end: filters.end } : fiscalBounds(year);
  // Reviewed reporting associations inherit commercial context, never legal IDs.
  const contextKeys = ["deployment", "gtm", "account_group", "state_ut", "zone", "city", "state",
    "industry_vertical", "industry_segment", "hpi_segment", "e_cat", "emp_size", "ps_tam_k", "prt_tam_k",
    "ps_rad", "prt_rad", "rtm_ps", "ps_partners", "rtm_print", "print_partners"];
  const effectiveParentKey = `CASE WHEN p.dimensions ? '_rosterAssociation' AND rp.company_id IS NULL
    THEN COALESCE(p.dimensions->'_rosterAssociation'->>'previousParentKey',p.parent_key)
    ELSE COALESCE(rp.parent_key,p.parent_key) END`;
  const effectiveParentName = `CASE WHEN p.dimensions ? '_rosterAssociation' AND rp.company_id IS NULL
    THEN COALESCE(p.dimensions->'_rosterAssociation'->>'previousParentName',p.parent_name)
    ELSE COALESCE(rp.parent_name,p.parent_name) END`;
  const historyBounds={start:"1900-01-01T00:00:00Z",end:"9999-12-31T00:00:00Z"};
  const inPeriod=(date:unknown)=>new Date(iso(date))>=new Date(bounds.start)&&new Date(iso(date))<new Date(bounds.end);
  const [profiles, contactResult, recordResult, inboundResult, formResult, eventRows, imports, unresolved, feedbackResult] = await Promise.all([
    pool.query(`SELECT c.id,c.name,c.industry,c.last_researched_at,${includeProfileDetails ? "p.*" :
      [...new Set(["company_id", "parent_key", "parent_name", "aliases", "is_new", ...Object.keys(hpContextFields), ...Object.keys(hpDimensions)])].map(c => `p.${c}`).join(",")},
      ${contextKeys.map(k => `COALESCE(NULLIF(p.${k},''),rp.${k}) AS ${k}`).join(",")},
      ${effectiveParentKey} AS parent_key,${effectiveParentName} AS parent_name
      FROM companies c JOIN hp_account_profiles p
      ON p.company_id=c.id AND p.tenant_id=c.tenant_id AND p.client_id=c.client_id
      LEFT JOIN hp_account_profiles rp ON rp.tenant_id=p.tenant_id AND rp.client_id=p.client_id AND rp.hp_id IS NOT NULL
        AND rp.company_id=CASE WHEN p.dimensions->'_rosterAssociation'->>'accountId' ~ '^[0-9]{1,9}$'
          THEN (p.dimensions->'_rosterAssociation'->>'accountId')::int END
      WHERE c.tenant_id=$1 AND c.client_id=$2
      AND ($3::text IS NULL OR ${effectiveParentKey}=$3)`, [tenantId, clientId, includeProfileDetails ? filters.parentKey ?? null : null]),
    pool.query(`SELECT c.id,c.company_id,c.first_name,c.last_name,c.email,c.title,c.intent_score,c.lead_score,c.tags,c.stage,c.last_activity,
      COALESCE(h.is_new,false) is_new FROM contacts c JOIN hp_account_profiles p ON p.company_id=c.company_id AND p.tenant_id=c.tenant_id
      LEFT JOIN hp_bi_contacts h ON h.contact_id=c.id AND h.tenant_id=c.tenant_id AND h.client_id=$2
      WHERE c.tenant_id=$1 AND c.client_id=$2 AND p.client_id=$2 AND NOT c.is_anonymous`, [tenantId, clientId]),
    pool.query(`SELECT * FROM hp_bi_records WHERE tenant_id=$1 AND client_id=$2
      AND ((occurred_at>=$3 AND occurred_at<$4) OR kind IN ('attendance','invitation','digital','content','other','interest'))
      ORDER BY occurred_at,id`, [tenantId, clientId, bounds.start, bounds.end]),
    pool.query(`SELECT s.*,${canonicalInboundSubmissionSql("s")} AS canonical_submission,
      COALESCE(s.submitted_at,s.created_at) AS submitted_at,src.field_mappings,src.name source_name FROM intent_inbound_submissions s
      LEFT JOIN intent_inbound_sources src ON src.id=s.source_id AND src.tenant_id=s.tenant_id
      WHERE s.tenant_id=$1 AND s.client_id=$2 AND COALESCE(s.submitted_at,s.created_at)>=$3 AND COALESCE(s.submitted_at,s.created_at)<$4
        AND COALESCE(s.identity_review,'')<>'keep' AND COALESCE(s.routing_error,'') NOT ILIKE '%email%another account%'`, [tenantId, clientId, historyBounds.start, historyBounds.end]),
    pool.query(`SELECT f.*,j.client_id,c.company_id,jf.config FROM form_submissions f JOIN journeys j ON j.id=f.journey_id AND j.tenant_id=f.tenant_id
      JOIN contacts c ON c.id=f.contact_id AND c.tenant_id=f.tenant_id AND c.client_id=j.client_id AND NOT c.is_anonymous
      LEFT JOIN journey_forms jf ON jf.id=f.form_id AND jf.tenant_id=f.tenant_id
      WHERE f.tenant_id=$1 AND j.client_id=$2 AND f.submitted_at>=$3 AND f.submitted_at<$4`, [tenantId, clientId, historyBounds.start, historyBounds.end]),
    loadHpAttributedEvents(tenantId, clientId, historyBounds.start, historyBounds.end),
     pool.query(`SELECT max(imported_at) last_import,count(*) FILTER (WHERE kind='accounts') account_imports,
       max(imported_at) FILTER (WHERE kind='accounts') last_roster_import,
       COALESCE((SELECT rows FROM hp_bi_imports WHERE tenant_id=$1 AND client_id=$2 AND kind='accounts' ORDER BY id ASC LIMIT 1),0) baseline_rows
      FROM hp_bi_imports WHERE tenant_id=$1 AND client_id=$2`, [tenantId, clientId]),
    pool.query(`SELECT count(*)::int n FROM hp_bi_matches WHERE tenant_id=$1 AND client_id=$2 AND resolved_account_id IS NULL`, [tenantId, clientId]),
    pool.query(`SELECT f.id,f.account_id,f.contact_id,f.type,f.occurred_at,f.product,f.rep_name
      FROM sales_feedback f JOIN companies c ON c.id=f.account_id AND c.tenant_id=f.tenant_id AND c.client_id=f.client_id
      LEFT JOIN contacts ct ON ct.id=f.contact_id AND ct.tenant_id=f.tenant_id AND ct.client_id=f.client_id AND ct.company_id=f.account_id
      WHERE f.tenant_id=$1 AND f.client_id=$2 AND f.review_status<>'rejected'
        AND btrim(f.feedback)<>'' AND (f.contact_id IS NULL OR ct.id IS NOT NULL AND NOT ct.is_anonymous)
        AND NOT EXISTS(SELECT 1 FROM sales_feedback newer WHERE newer.tenant_id=f.tenant_id
          AND newer.record_key=f.record_key AND newer.id>f.id)`,[tenantId,clientId]),
  ]);
  const allProfiles = profiles.rows;
  // profile.id is not company.id: use company_id everywhere.
  let selected = allProfiles.filter(p => (!filters.segment || segmentName(p.gtm) === filters.segment)
    && (!filters.salesPerson || ownershipFields.some(([key]) => text(p[key]).toLowerCase() === filters.salesPerson!.trim().toLowerCase()))
    && (!filters.rad || normalizeRad(filters.basis?.toLowerCase() === "print" ? p.prt_rad : p.ps_rad) === filters.rad)
    && (!filters.newOnly || p.is_new) && (!filters.abmOnly || p.top_200)
    && (!filters.parentKey || p.parent_key === filters.parentKey)
    && (!filters.incompleteOnly || hpMissingFields(p).length > 0)
    && (!filters.search || `${p.name} ${p.legal_name ?? ""} ${p.parent_name} ${p.hp_id ?? ""} ${(p.aliases ?? []).join(" ")}`.toLowerCase().includes(filters.search.toLowerCase()))
    && (!filters.dimension || text(p[filters.dimension]).toLowerCase().includes(text(filters.dimensionValue).toLowerCase())));
  const selectedIds = new Set(selected.map(p => Number(p.company_id)));
  await repairInboundProductInterestClassifications(tenantId);
  const gtm = await loadHpGtmQualification(tenantId, clientId);
  let contacts = contactResult.rows.filter(c => selectedIds.has(Number(c.company_id)));
  const engagement = await enrichEngagementContacts(tenantId, clientId, contacts, [...selectedIds]);
  if (filters.opportunity) {
    const config = await loadInboundCategoryRules(tenantId);
    const matches = new Set<number>();
    const add = (id: number, category: unknown, product: unknown) => {
      if (selectedIds.has(id) && opportunityCategory(category, product, config) === filters.opportunity) matches.add(id);
    };
    for (const p of selected) for (const category of [...(p.buyer_categories ?? []), ...(p.whitespace_categories ?? [])])
      add(Number(p.company_id), category, null);
    for (const r of recordResult.rows) add(Number(r.account_id), r.category, r.product);
    for (const r of gtm.intentEvidence(selectedIds))
      if (r.status === "Hot" || r.status === "Warm") add(r.accountId, r.category, r.product);
    for (const r of engagement.journeyIntent)
      if (r.status === "Hot" || r.status === "Warm") add(r.accountId, r.category, r.product);
    const monitoring = await loadHpMonitoringContext(tenantId, clientId, [...selectedIds], "priority");
    for (const account of monitoring) for (const finding of account.findings) for (const category of finding.categories)
      if (category.heat === "Hot" || category.heat === "Warm") add(account.accountId, category.name, null);
    selected = selected.filter(p => matches.has(Number(p.company_id)));
    for (const id of selectedIds) if (!matches.has(id)) selectedIds.delete(id);
    contacts = contacts.filter(c => selectedIds.has(Number(c.company_id)));
    engagement.contacts = engagement.contacts.filter(c => c.companyId != null && selectedIds.has(c.companyId));
    engagement.score = engagement.contacts.reduce((sum, c) => sum + c.score, 0);
  }
  const contactQualification = new Map(engagement.contacts.map(c => [c.id, c]));
  const safeContactIds = new Set(contacts.map(c => Number(c.id)));
  const duplicateRefs = new Set(inboundResult.rows.filter(row => row.canonical_submission === false)
    .flatMap(row => [`inbound:${row.id}`, `inbound:${row.id}:response`]));
  let records = recordResult.rows.filter(row => !duplicateRefs.has(row.source_key))
    .map(toRecord).filter(r => selectedIds.has(r.accountId));
  const showUnlinked = !filters.salesPerson && !filters.opportunity && !filters.segment && !filters.rad && !filters.parentKey && !filters.search && !filters.dimension && !filters.newOnly && !filters.abmOnly;
  const crm = await loadHpCrm(tenantId, clientId, { selectedIds, start: bounds.start, end: bounds.end, showUnlinked, mirrors: records });
  const crmProjection = projectHpCrm(crm.deals, selectedIds, bounds.start, bounds.end, showUnlinked);
  Object.assign(crmProjection.quality, crm.coverage, {
    issues: crmProjection.quality.issues.filter(i => crm.issueIds.has(i.dealId)),
    issueLimit: crmIssueLimit, issuesTruncated: crm.coverage.incompleteDeals > crmIssueLimit,
  });
  crmProjection.quality.suppressedMirrors = records.filter(r => isCrmMirror(r, crm.knownIds)).length;
  records = records.filter(r => !isCrmMirror(r, crm.knownIds));
  records.push(...crmProjection.records);
  const captured = new Set(recordResult.rows.map(r => r.source_key));
  for (const row of inboundResult.rows) {
    if (row.canonical_submission === false) continue;
    if (!selectedIds.has(Number(row.account_id))) continue;
    if (!captured.has(`inbound:${row.id}:response`)) records.push({ id: `inbound:${row.id}:response`, accountId: Number(row.account_id),
      contactId: safeContactIds.has(Number(row.contact_id)) ? Number(row.contact_id) : null, kind: "other", occurredAt: iso(row.submitted_at),
      category: null, product: row.product_interest, horizonMonths: null, orderValue: null, currency: null,
      source: "questionnaire response", sourceName: row.source_name ?? row.file_name, status: null });
    if(!inPeriod(row.submitted_at))continue;
    if (captured.has(`inbound:${row.id}`)) continue;
    // A survey response becomes a lead only if it is a questionnaire or includes an explicit service/request.
    if (row.form_type === "event_feedback" && !positiveProduct(row.product_interest) && !row.requested_demo && !row.explicit_interest) continue;
    const fields = canonicalizeInbound(row.raw_fields ?? {}, row.field_mappings ?? {});
    records.push({ id: `inbound:${row.id}`, accountId: Number(row.account_id), contactId: safeContactIds.has(Number(row.contact_id)) ? Number(row.contact_id) : null,
      kind: "lead", occurredAt: iso(row.submitted_at), category: null, product: row.product_interest, horizonMonths: numeric(row.purchase_timeframe_months),
      orderValue: numeric(field(fields, "orderValue", "totalOrderValue", "Total Order Value", "ToV")),
      currency: text(field(fields, "currency")).toUpperCase() || null, source: "questionnaire", sourceName: row.source_name ?? row.file_name, status: row.classification });
  }
  const formEvidence: BusinessRecord[] = [];
  for (const row of formResult.rows) {
    if (!selectedIds.has(Number(row.company_id)) || !safeContactIds.has(Number(row.contact_id))) continue;
    const fields: Record<string, unknown> = { ...row.field_values };
    for (const f of row.config?.fields ?? []) {
      if (row.field_values?.[f.id] !== undefined) {
        if (f.mapToBiField) fields[f.mapToBiField] = row.field_values[f.id];
        if (f.mapToContactField) fields[f.mapToContactField] = row.field_values[f.id];
        if (f.label) fields[f.label] = row.field_values[f.id];
      }
    }
    const product = text(field(fields, "productInterest", "product", "service", "solution")) || null;
    const formRecord = hpFormEvidence(row, fields);
    if (includeProfileDetails&&inPeriod(row.submitted_at)) formEvidence.push(formRecord);
    // One submission is one touchpoint even if it also creates a lead.
    if(!captured.has(`form:${row.id}:response`)&&!recordResult.rows.some(record=>record.source_key===`form:${row.id}`&&touchKinds.has(record.kind)))records.push({...formRecord,id:`form:${row.id}:response`,
      externalEventId:`form_submission:${row.id}`});
    if(!inPeriod(row.submitted_at))continue;
    if (captured.has(`form:${row.id}`)) continue;
    if (!positiveProduct(product) && !row.config?.biLead && !row.config?.onSubmit?.createLead) continue;
    records.push({ ...formRecord, kind: "lead", status: null });
  }
  // Canonical first-party counts reuse Analytics identity review and bot rules.
  // Native forms also log an activity event. Pair only the same contact/form/
  // journey at submission time, one-to-one, so a response is not counted twice.
  const unmatchedForms=new Set(formResult.rows.map(row=>Number(row.id)));
  const events: BusinessRecord[] = eventRows.filter(e => {
    if(!selectedIds.has(Number(e.account_id)))return false;
    const nativeForm=/^form:(\d+)$/.exec(e.activity_source??"");
    if(nativeForm&&["form_submit","form_submitted"].includes(e.event_type)){
      const match=formResult.rows.find(row=>unmatchedForms.has(Number(row.id))
        &&Number(row.form_id)===Number(nativeForm[1])&&Number(row.contact_id)===Number(e.contact_id)
        &&Number(row.journey_id)===Number(e.journey_id)
        &&Math.abs(new Date(row.submitted_at).getTime()-new Date(e.created_at).getTime())<=60000);
      if(match){unmatchedForms.delete(Number(match.id));return false;}
    }
    return true;
  }).map(e => {
    let metadata: any = {};
    try { metadata = e.activity_metadata ? JSON.parse(e.activity_metadata) : {}; } catch { /* legacy non-JSON metadata has no BI context */ }
    const context = e.journey_props?.biContext ?? metadata.biContext ?? {};
    return ({
    id: `${e.source_type}:${e.source_id}`, accountId: Number(e.account_id),
    contactId: safeContactIds.has(Number(e.contact_id)) ? Number(e.contact_id) : null,
    kind: /download/.test(e.event_type) ? "content" : "digital", occurredAt: iso(e.created_at),
    category: context.category ?? null, product: context.product ?? null, horizonMonths: null, orderValue: null, currency: null,
    source: e.source_type, sourceName: context.program ?? (e.journey_name ? `${e.journey_name}${e.page_name ? ` / ${e.page_name}` : ""}` : e.event_type),
    status: e.event_type, externalEventId: `${e.source_type}:${e.source_id}`,
  }); });
  const firstPartyKeys = new Set(eventRows.map(e=>`${e.source_type}:${e.source_id}`));
  records = records.filter(r => !r.externalEventId || !firstPartyKeys.has(r.externalEventId) || !["digital", "content", "other", "attendance", "invitation"].includes(r.kind));
  records.push(...events);
  records.push(...feedbackResult.rows.filter(row=>selectedIds.has(Number(row.account_id))).map(row=>({
    id:`sales_feedback:${row.id}`,accountId:Number(row.account_id),
    contactId:safeContactIds.has(Number(row.contact_id))?Number(row.contact_id):null,
    // Undated interactions belong to history, never to an invented fiscal date.
    kind:"other",occurredAt:row.occurred_at?iso(row.occurred_at):"",category:null,product:row.product??null,
    horizonMonths:null,orderValue:null,currency:null,
    source:row.type==="telesales"?"telesales":"sales rep",sourceName:row.rep_name,
    status:row.type==="telesales"?"telesales_contact":"sales_rep_contact",externalEventId:`sales_feedback:${row.id}`,
  })));
  const categoryConfig = await loadInboundCategoryRules(tenantId);
  records.forEach(r => {
    if (!r.category && positiveProduct(r.product)) {
      const category = inboundCategoryForInterest(r.product!, null, categoryConfig).categoryName;
      if (inboundCategories.includes(category)) r.category = category;
    }
    if (r.kind === "lead") r.status = hpLeadStatus(r.product, r.horizonMonths);
  });
  // Stable cross-source references reconcile imported/tracked representations.
  const uniqueRecords = new Map<string, BusinessRecord>();
  records.sort((a, b) => Number(a.source === "excel") - Number(b.source === "excel"));
  records.forEach(r => {
    const key = r.externalEventId ? `${r.accountId}:${r.kind}:${r.externalEventId}` : r.id;
    if (!uniqueRecords.has(key)) uniqueRecords.set(key, r);
  });
  records = [...uniqueRecords.values()];
  const allDateTouchpoints=records.filter(record=>touchKinds.has(record.kind));
  records=records.filter(record=>inPeriod(record.occurredAt));
  records = linkQuestionnaireRecords(records);
  records.sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.id.localeCompare(b.id));
  return { bounds, selected, allProfiles, contacts, records, allDateTouchpoints, formEvidence, gtm, engagement, contactQualification, imports, unresolved, crmProjection, safeContactIds, dealLifecycle: crm.lifecycle };
}

export async function loadHpBi(tenantId: number, filters: HpFilters, detail: boolean | "evidence" = false) {
  const { clientId, year } = filters;
  const { bounds, selected, allProfiles, contacts, records, allDateTouchpoints, formEvidence, gtm, engagement, contactQualification, imports, unresolved, crmProjection, safeContactIds, dealLifecycle } =
    await loadHpBiFacts(tenantId, filters, detail === true);
  const selectedIds = new Set(selected.map(p => Number(p.company_id)));
  const allDateCounts=new Map<number,number>();
  for(const record of allDateTouchpoints)allDateCounts.set(record.accountId,(allDateCounts.get(record.accountId)??0)+1);
  if (detail === "evidence") {
    const rr = records.filter(r => {
      const month = (Number(new Intl.DateTimeFormat("en", { month: "numeric", timeZone: "Asia/Kolkata" }).format(new Date(r.occurredAt))) + 1) % 12 + 1;
      return (!filters.month || month === filters.month)
        && (!filters.quarter || Math.ceil(month / 3) === filters.quarter)
        && hpEvidenceKindMatches(r, filters.kind)
        && (!filters.category || (r.category ?? r.product) === filters.category);
    });
    const displayed: (BusinessRecord & { relatedRecords?: BusinessRecord[] })[] = filters.groupResponses ? groupQuestionnaireRecords(rr) : rr;
    const pageRecords = displayed.slice((filters.page - 1) * filters.pageSize, filters.page * filters.pageSize);
    await enrichSourceProvenance(tenantId, clientId, pageRecords.flatMap(r => [r, ...(r.relatedRecords ?? [])]));
    return { total: displayed.length, sourceRecordTotal: rr.length, page: filters.page, pageSize: filters.pageSize,
      records: pageRecords.map(r => ({
        ...r, accountName: allProfiles.find(p => Number(p.company_id) === r.accountId)?.name ?? "Unknown",
      })) };
  }
  const leadKinds = new Set(["lead"]);
  const opportunityKinds = new Set(["opportunity"]);
  function period(label: string, start: Date, end: Date, subset = records) {
    const rr = subset.filter(r => new Date(r.occurredAt) >= start && new Date(r.occurredAt) < end);
    const leads = rr.filter(r => leadKinds.has(r.kind));
    const values: Record<string, number> = {}, prospectiveValues: Record<string, number> = {}, bookedValues: Record<string, number> = {};
    rr.filter(r => opportunityKinds.has(r.kind)).forEach(r => addMoney(values, r));
    rr.filter(r => ["lead", "prospective"].includes(r.kind)).forEach(r => addMoney(prospectiveValues, r));
    rr.filter(r => r.kind === "closed_won").forEach(r => addMoney(bookedValues, r));
    return { label, start: start.toISOString(), touchpoints: rr.filter(r => touchKinds.has(r.kind)).length,
      contacts: new Set(rr.filter(r => touchKinds.has(r.kind) && r.contactId).map(r => r.contactId)).size,
      invitations: rr.filter(r => r.kind === "invitation").length, attendance: rr.filter(r => r.kind === "attendance").length,
      digital: rr.filter(r => r.kind === "digital").length, content: rr.filter(r => r.kind === "content").length,
      other: rr.filter(r => ["other", "interest"].includes(r.kind)).length, leads: leads.length,
      hot: leads.filter(r => hpLeadStatus(r.product, r.horizonMonths) === "hot").length,
      warm: leads.filter(r => hpLeadStatus(r.product, r.horizonMonths) === "warm").length,
       opportunities: rr.filter(r => opportunityKinds.has(r.kind)).length, values, prospectiveValues, bookedValues,
       closedWon: rr.filter(r => r.kind === "closed_won").length, closedLost: rr.filter(r => r.kind === "closed_lost").length,
      categories: [...new Set(rr.map(r => r.category ?? r.product).filter(Boolean))], isFuture: start.getTime() > Date.now() };
  }
  const monthDate = (i: number) => new Date(Date.UTC(year - 1, 10 + i, 1) - 330 * 60_000);
  const months = Array.from({ length: 12 }, (_, i) => period(new Intl.DateTimeFormat("en", { month: "short", timeZone: "Asia/Kolkata" }).format(monthDate(i)), monthDate(i), monthDate(i + 1)));
  const quarters = Array.from({ length: 4 }, (_, i) => period(`Q${i + 1}`, monthDate(i * 3), monthDate(i * 3 + 3)));
  const totalPeriod = period("FY", monthDate(0), monthDate(12));
  function append<K, V>(map: Map<K, V[]>, key: K, value: V) {
    const bucket = map.get(key);
    if (bucket) bucket.push(value); else map.set(key, [value]);
  }
  const grouped = new Map<string, any[]>();
  selected.forEach(p => append(grouped, p.parent_key, p));
  const recordsByAccount = new Map<number, BusinessRecord[]>();
  records.forEach(r => append(recordsByAccount, r.accountId, r));
  const contactsByAccount = new Map<number, any[]>();
  contacts.forEach(c => append(contactsByAccount, Number(c.company_id), c));
  const monitoringNow = Date.now();
  const priorityNow = new Date(monitoringNow);
  const priorityClient = (await pool.query("SELECT name FROM clients WHERE tenant_id=$1 AND id=$2", [tenantId, clientId])).rows[0]?.name;
  const priorityEvidence = isHpClientName(priorityClient)
    ? await loadHpPriorityEvidence(tenantId, clientId, [...selectedIds], priorityNow) : null;
  const warmRouting = priorityEvidence ? await loadHpWarmRouting(tenantId, clientId, [...selectedIds]) : null;
  const accounts = [...grouped.entries()].map(([key, members]) => {
    const rr = members.flatMap(m => recordsByAccount.get(Number(m.company_id)) ?? []);
    const cc = members.flatMap(m => contactsByAccount.get(Number(m.company_id)) ?? []);
    const p = period("FY", monthDate(0), monthDate(12), rr);
     const memberGtm = gtm.summarize(new Set(members.map(m => Number(m.company_id))));
    const missingFields = [...new Set(members.flatMap(hpMissingFields))];
    const segments = [...new Set(members.map(m => segmentName(m.gtm)))];
    const rads = [...new Set(members.map(m => normalizeRad(filters.basis?.toLowerCase() === "print" ? m.prt_rad : m.ps_rad)))];
    const memberIds = new Set<number>(members.map(m => Number(m.company_id)));
    const priority = priorityEvidence ? priorityForAccounts(priorityEvidence, memberIds, priorityNow) : undefined;
    if (priority && warmRouting && priorityEvidence)
      priority.routing = warmRouting.describe(priority, priorityEvidence, memberIds, priorityNow);
    return { ...hpMonitoringCoverage(members, monitoringNow), missingFields, incompleteMembers: members.filter(m => hpMissingFields(m).length > 0).length,
      priority,
      gtm: memberGtm,
      // Journey names are needed across the scope only when sorting by journey.
      ...(filters.sortBy === "journey" ? gtm.routes(new Set(members.map(m => Number(m.company_id)))) : {}),
      status: priority?.status ?? strongestQualification([
        engagement.statusForAccounts(new Set(members.map(m => Number(m.company_id)))),
         memberGtm.status as "Hot" | "Warm" | "Cold",
      ]),
      id: Number(members[0].company_id), name: members[0].parent_name, hpId: members.length === 1 ? members[0].hp_id : null,
      parentKey: key, parentName: members[0].parent_name, segment: segments.length === 1 ? segments[0] : "Mixed",
      rad: rads.length === 1 ? rads[0] : "Mixed", industry: members[0].industry_vertical ?? null, employeeSize: numeric(members[0].emp_size),
      isNew: members.some(m => m.is_new), contacts: cc.length, engagedContacts: p.contacts, touchpoints: p.touchpoints,
      touchpointsAllDates:[...memberIds].reduce((sum,id)=>sum+(allDateCounts.get(id)??0),0),
       hot: p.hot, warm: p.warm, leads: p.leads, opportunities: p.opportunities, values: p.values,
       closedWon: p.closedWon, closedLost: p.closedLost, prospectiveValues: p.prospectiveValues, bookedValues: p.bookedValues,
       score: cc.reduce((sum, c) => sum + storedPoints(c.lead_score), 0),
      memberCount: members.length, categories: p.categories, lastActivity: rr.at(-1)?.occurredAt ?? null };
  });
  sortHpAccounts(accounts, filters.sortBy, filters.sortDir, filters.sortCurrency);
   const matchingAccounts=filterHpAccountQualification(accounts,filters.qualification)
     .filter(account => matchesHpMonitoring(account, filters.monitoring))
     .filter(account => !filters.gtmSource || gtm.hasSource(
       new Set(grouped.get(account.parentKey)!.map(m => Number(m.company_id))), filters.gtmSource));
  // Compute non-sorting row details only for the requested page. Summary and
  // sort metrics above still cover the complete matching account universe.
  const enrichAccount = (account: typeof accounts[number]) => {
    const members = grouped.get(account.parentKey)!;
    const ids = new Set(members.map(m => Number(m.company_id)));
    return { ...account, salesPeople: hpSalesAssignments(members),
      ...(filters.sortBy === "journey" ? {} : gtm.routes(ids)),
      crmReferences: members.flatMap(m => recordsByAccount.get(Number(m.company_id)) ?? [])
        .filter(r => r.source === "crm" && r.externalEventId).map(r => r.externalEventId!) };
  };
  const sortCurrencies = [...new Set(accounts.flatMap(a => [...Object.keys(a.values ?? {}), ...Object.keys(a.bookedValues ?? {})]))].sort();
  const namedBreakdown = (key: "segment" | "rad") => [...new Set(selected.map(p => key === "segment" ? segmentName(p.gtm) : normalizeRad(filters.basis?.toLowerCase() === "print" ? p.prt_rad : p.ps_rad)))].map(name => {
    const memberIds = new Set(selected.filter(p => (key === "segment" ? segmentName(p.gtm) : normalizeRad(filters.basis?.toLowerCase() === "print" ? p.prt_rad : p.ps_rad)) === name).map(p => Number(p.company_id)));
    const pp = period("FY", monthDate(0), monthDate(12), records.filter(r => memberIds.has(r.accountId)));
    return { name, accounts: memberIds.size, contacts: contacts.filter(c => memberIds.has(Number(c.company_id))).length, leads: pp.leads, hot: pp.hot, touchpoints: pp.touchpoints };
  });
  const categories = [...new Set([...records.map(r => r.category ?? r.product), ...selected.flatMap(p => [...p.buyer_categories, ...p.whitespace_categories])].filter(Boolean))].map(name => {
    const rr = records.filter(r => (r.category ?? r.product) === name);
    const pp = period("FY", monthDate(0), monthDate(12), rr);
    return { name, contacts: new Set(rr.filter(r => r.contactId).map(r => r.contactId)).size, leads: pp.leads, hot: pp.hot,
       opportunities: pp.opportunities, touchpoints: pp.touchpoints, values: pp.values,
       closedWon: pp.closedWon, closedLost: pp.closedLost, prospectiveValues: pp.prospectiveValues, bookedValues: pp.bookedValues,
      buyers: selected.filter(p => p.buyer_categories.includes(name)).length, whitespace: selected.filter(p => p.whitespace_categories.includes(name)).length };
  });
  const clientName = (await pool.query("SELECT name FROM clients WHERE tenant_id=$1 AND id=$2", [tenantId, clientId])).rows[0]?.name;
  const scoring = { formula: "Stored contact intent score = min(100, engagementSum × [1 + 0.5 × ln(1 + distinct active days)] + 5 × (maximum stage rank − 1) + velocity bonus + account colleague bonus).",
    components: [
      { name: "Engagement quality", description: "Session stage weight × engagement quality × recency decay. Stage weights: aware 10, pre-engage 15, engage 20, advance-engage 25, action 30. Email micro-signals also contribute to engagementSum." },
      { name: "Frequency and recency", description: "Frequency multiplier = 1 + 0.5 × ln(1 + distinct active days). Recency multiplier = exp(−0.033 × days since activity), approximately a 21-day half-life. Accelerating recent activity earns velocity points. These are present-day stored scores, not historical quarter snapshots." },
      { name: "Account colleague bonus", description: "Human page-view activity from colleagues at the same company, in the same journey and sequence, in the last 30 days. Server send events do not count." },
      { name: "Account journey score", description: "Sum of current stored engagement points (lead_score) across identified contacts in the member companies, including zero-score contacts. No averaging or 100-point cap. Current formula-based intent scores remain separate. An account is Hot if any contact is Hot; otherwise Warm if any contact is Warm. These are current scores, not historical quarter snapshots." },
    ], hotRule: "A selected product/service and an explicit purchase horizon of 0–3 months are Hot. No seniority requirement.",
    warmRule: "Selected product/service with a horizon over 3 and up to 6 months is Warm. Beyond 6 months, no clear horizon, or no product/service is Cold. Roster entries are not leads; attendance or an invitation alone is not a lead.",
     orderValueRule: "Opportunity ToV is explicitly supplied Total Order Value, never assumed booked business. CRM opportunities require explicit confirmation at Proposal or later, a canonical HP account and an actual opportunity date. Won/lost results require a closed stage and actual outcome date; booked value is separately supplied. Expected close, created and updated dates never determine actual results. Form values are prospective. Legacy unknown value meaning or missing currency excludes money, not otherwise eligible counts. India calendar dates determine November–October periods. Currencies are never combined. Excel mirrors use crm:deal:<id>:opportunity or crm:deal:<id>:outcome and follow the current CRM correction/deletion.",
    thresholds: { veryHot: 65, hot: 40, warm: 18 } };
  if (detail) {
    await enrichSourceProvenance(tenantId, clientId, records);
    // Current-year totals and historical declared preferences are different facts.
    // Bound this query to the opened parent group's owned legal accounts.
    const history = selectedIds.size ? await pool.query(`SELECT * FROM (
      SELECT account_id,contact_id,product,occurred_at,'Recorded '||kind AS source
      FROM hp_bi_records WHERE tenant_id=$1 AND client_id=$2 AND account_id=ANY($3::int[])
        AND kind IN ('interest','lead','opportunity','closed_won') AND product IS NOT NULL
      UNION ALL
       SELECT account_id,contact_id,product_interest AS product,COALESCE(submitted_at,created_at) AS occurred_at,'Questionnaire / feedback' AS source
      FROM intent_inbound_submissions WHERE tenant_id=$1 AND client_id=$2 AND account_id=ANY($3::int[])
        AND product_interest IS NOT NULL AND COALESCE(identity_review,'')<>'keep'
        AND COALESCE(routing_error,'') NOT ILIKE '%email%another account%'
    ) h ORDER BY occurred_at DESC NULLS LAST LIMIT 1001`, [tenantId, clientId, [...selectedIds]]) : { rows: [] };
    const seen = new Set<string>();
    const recordedInterests = history.rows.slice(0, 1000).filter(row => {
      const key = `${row.account_id}:${safeContactIds.has(Number(row.contact_id)) ? row.contact_id : ""}:${text(row.product).toLowerCase()}`;
      if (!positiveProduct(row.product) || seen.has(key)) return false;
      seen.add(key); return true;
    }).map(row => ({ accountId: Number(row.account_id), contactId: safeContactIds.has(Number(row.contact_id)) ? Number(row.contact_id) : null,
      product: row.product, source: row.source, occurredAt: row.occurred_at ? iso(row.occurred_at) : null }));
    const monitoringContext = await loadHpMonitoringContext(tenantId, clientId, [...selectedIds]);
    const categoryConfig = await loadInboundCategoryRules(tenantId);
    const categorize = (rows: { product: string | null; category: string | null; status: string }[]) => rows.map(row => {
      const mapped = row.product ? inboundCategoryForInterest(row.product, null, categoryConfig).categoryName : null;
      return { ...row, category: row.category || (mapped && inboundCategories.includes(mapped) ? mapped : null) };
    });
    const intentSources = {
      gtm: categorize(gtm.intentEvidence(selectedIds)),
      journey: categorize(engagement.journeyIntent.filter(row => selectedIds.has(row.accountId))),
    };
    return { clientId, account: accounts[0] ? enrichAccount(accounts[0]) : null, monitoringContext, intentSources, formEvidence, gtmResponses: gtm.evidence(selectedIds),
      sourceGtmResponses: gtm.sourceEvidence(selectedIds),
      sourceGtmTruncated: gtm.summarize(selectedIds).inboundResponses > 1000,
      recordedInterests, interestsTruncated: history.rows.length > 1000, members: selected.map(p => ({
    id: Number(p.company_id), name: p.name, missingFields: hpMissingFields(p), dimensions: {
      ...p.dimensions, city: p.city ?? p.dimensions?.city ?? p.dimensions?.CITY ?? null, top200: p.top_200 }, variants: p.variants,
    buyerCategories: p.buyer_categories, whitespaceCategories: p.whitespace_categories, abmClassification: p.abm_classification,
    buyingBehavior: p.buying_behavior, globalAccount: p.global_account, profiled: p.profiled, propensity: p.propensity })),
    contacts: contacts.map(c => contactQualification.get(Number(c.id))!),
     records, months, crmDeals: crmProjection.quality };
  }
  return { clientId, clientName, year, ...bounds,
    summary: { accounts: selected.length, parentAccounts: accounts.length, newAccounts: selected.filter(p => p.is_new).length,
      contacts: contacts.length, newContacts: contacts.filter(c => c.is_new).length, engagedContacts: totalPeriod.contacts, touchpoints: totalPeriod.touchpoints,
      touchpointsAllDates:allDateTouchpoints.length,
      engagedAccounts: new Set(records.filter(r => touchKinds.has(r.kind)).map(r => r.accountId)).size,
      gtm: gtm.summarize(selectedIds),
      leads: totalPeriod.leads, hot: totalPeriod.hot, warm: totalPeriod.warm, opportunities: totalPeriod.opportunities, values: totalPeriod.values,
       prospectiveValues: totalPeriod.prospectiveValues, bookedValues: totalPeriod.bookedValues,
       closedWon: totalPeriod.closedWon, closedLost: totalPeriod.closedLost,
      dealLifecycle: { ...dealLifecycle,
        winRate: totalPeriod.closedWon + totalPeriod.closedLost > 0
          ? 100 * totalPeriod.closedWon / (totalPeriod.closedWon + totalPeriod.closedLost) : null,
        closedOutcomes: totalPeriod.closedWon + totalPeriod.closedLost },
      score: engagement.score },
    segments: namedBreakdown("segment"), rads: namedBreakdown("rad"), quarters, months, categories,
    accounts: matchingAccounts.slice((filters.page - 1) * filters.pageSize, filters.page * filters.pageSize).map(enrichAccount),
    matchingLegalAccounts:matchingAccounts.reduce((sum,account)=>sum+account.memberCount,0),
    sortCurrencies, total: matchingAccounts.length, page: filters.page, pageSize: filters.pageSize,
    quality: { rosterImported: Number(imports.rows[0]?.account_imports || 0) > 0,
      incompleteAccounts: selected.filter(p => hpMissingFields(p).length > 0).length,
      rosterLegalAccounts: allProfiles.length, rosterParentGroups: new Set(allProfiles.map(p => p.parent_key)).size,
      lastRosterImport: imports.rows[0]?.last_roster_import ? iso(imports.rows[0].last_roster_import) : null,
      baselineAccounts: allProfiles.filter(p => !p.is_new).length, baselineRows: Number(imports.rows[0]?.baseline_rows || 0),
      lastImport: imports.rows[0]?.last_import ? iso(imports.rows[0].last_import) : null,
      missingSegment: selected.filter(p => !p.gtm).length, missingRad: selected.filter(p => normalizeRad(filters.basis?.toLowerCase() === "print" ? p.prt_rad : p.ps_rad) === "Unknown").length,
      unlinkedContacts: Number((await pool.query("SELECT count(*)::int n FROM contacts WHERE tenant_id=$1 AND client_id=$2 AND company_id IS NULL AND NOT is_anonymous", [tenantId, clientId])).rows[0].n),
      missingHorizon: records.filter(r => r.kind === "lead" && r.horizonMonths === null).length,
      unpricedOpportunities: records.filter(r => r.kind === "opportunity" && r.orderValue === null).length,
      missingCurrency: records.filter(r => r.orderValue !== null && !r.currency).length,
       unresolvedMatches: Number(unresolved.rows[0]?.n ?? 0), crmDeals: crmProjection.quality,
       scoreDescription: "Mean current stored contact intent score (0–100), not a historical Relationship Score.",
      note: "No data means no recorded activity for the period, not confirmed absence. Imported roster accounts are not leads. Parent rows consolidate filtered subsidiaries; segment and RAD totals use legal accounts. Only explicit buyers/whitespace are shown. Deduplication across imports and tracking requires externalEventId." },
    scoring };
}
