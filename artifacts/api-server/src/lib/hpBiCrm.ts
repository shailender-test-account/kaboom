import { opportunityStages, outcomeStages, validCurrency, validDay } from "./dealFacts";
import { occurrence } from "./hpBiImport";
import type { BusinessRecord } from "./hpBiMetrics";
export { readHpCrm as loadHpCrm, crmIssueLimit } from "./hpBiCrmRead";

export const crmReference = (id: number, kind: "opportunity" | "outcome") => `crm:deal:${id}:${kind}`;
export interface CrmIssue {
  dealId: number; title: string; accountId: number | null; accountName: string | null; reasons: string[];
  opportunityReference: string; outcomeReference: string;
}
const amount = (v: unknown) => v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) || Number(v) < 0 ? null : Number(v);
const day = (v: unknown) => typeof v === "string" ? v.slice(0, 10) : v instanceof Date ? v.toISOString().slice(0, 10) : "";
export function projectHpCrm(deals: any[], selectedIds: Set<number>, start: string, end: string, showUnlinked: boolean) {
  const records: BusinessRecord[] = [], issues: CrmIssue[] = [];
  let total = 0, includedOpportunities = 0, includedOutcomes = 0, excludedDeals = 0;
  const startMs = Date.parse(start), endMs = Date.parse(end);
  const inPeriod = (v: string) => Date.parse(v) >= startMs && Date.parse(v) < endMs;
  for (const d of deals) {
    const attributable = !!d.profile_account_id && !!d.account_name;
    if (attributable ? !selectedIds.has(Number(d.company_id)) : !showUnlinked) continue;
    total++;
    const reasons: string[] = [], common: string[] = [];
    if (!d.company_id) common.push("Missing canonical account");
    else if (!attributable) common.push("Account is not in this client's canonical HP roster");
    if (!d.contact_valid) common.push("Linked contact does not belong to this client and account");
    const currency = validCurrency(d.currency) ? d.currency.toUpperCase() : null;
    const oppDate = day(d.actual_opportunity_date), outcomeDate = day(d.actual_outcome_date);
    const oppReasons = [...common], outReasons = [...common];
    if (!d.opportunity_confirmed || !opportunityStages.has(d.stage)) oppReasons.push("Opportunity is not explicitly confirmed at Proposal or later");
    if (!validDay(oppDate)) oppReasons.push("Missing actual opportunity date");
    if (!outcomeStages.has(d.stage)) outReasons.push("No actual Won or Lost outcome");
    if (outcomeStages.has(d.stage) && !validDay(outcomeDate)) outReasons.push("Missing actual outcome date");
    const oppAt = validDay(oppDate) ? occurrence(oppDate)! : null, outAt = validDay(outcomeDate) ? occurrence(outcomeDate)! : null;
    const base = { accountId: Number(d.company_id), contactId: d.contact_id === null ? null : Number(d.contact_id),
      category: null, product: null, horizonMonths: null, source: "crm", sourceName: d.title, currency,
      lineage: { dealId: Number(d.id), valueMeaning: d.value_meaning, opportunityConfirmed: d.opportunity_confirmed,
        actualOpportunityDate: oppDate || null, actualOutcomeDate: outcomeDate || null, expectedCloseDate: d.expected_close_date,
        updatedAt: d.updated_at, currency: d.currency, suppliedOrderValue: amount(d.value), suppliedBookedValue: amount(d.booked_value) } };
    let included = false;
    if (!oppReasons.length && oppAt && inPeriod(oppAt)) {
      const moneyReasons: string[] = [];
      if (d.value_meaning !== "total_order_value") moneyReasons.push("Order value meaning is not confirmed as Total Order Value");
      if (amount(d.value) === null) moneyReasons.push("Missing supplied Total Order Value");
      if (!currency) moneyReasons.push("Missing or invalid explicit currency");
      const ref = crmReference(Number(d.id), "opportunity");
      records.push({ ...base, id: ref, externalEventId: ref, kind: "opportunity", occurredAt: oppAt, status: d.stage,
        orderValue: moneyReasons.length ? null : amount(d.value), exclusionReasons: moneyReasons });
      reasons.push(...moneyReasons.map(s => `Opportunity money: ${s}`));
      includedOpportunities++; included = true;
    } else reasons.push(...oppReasons.map(s => `Opportunity: ${s}`), ...(oppAt && !inPeriod(oppAt) ? ["Opportunity date is outside the selected fiscal year"] : []));
    if (!outReasons.length && outAt && inPeriod(outAt)) {
      const moneyReasons: string[] = [];
      if (d.stage === "closed_won") {
        if (amount(d.booked_value) === null) moneyReasons.push("Missing independently supplied booked amount");
        if (!currency) moneyReasons.push("Missing or invalid explicit currency");
      }
      const ref = crmReference(Number(d.id), "outcome");
      records.push({ ...base, id: ref, externalEventId: ref, kind: d.stage, occurredAt: outAt, status: d.stage,
        orderValue: moneyReasons.length || d.stage !== "closed_won" ? null : amount(d.booked_value), exclusionReasons: moneyReasons });
      reasons.push(...moneyReasons.map(s => `Booked money: ${s}`));
      includedOutcomes++; included = true;
    } else if (outcomeStages.has(d.stage)) reasons.push(...outReasons.map(s => `Outcome: ${s}`), ...(outAt && !inPeriod(outAt) ? ["Outcome date is outside the selected fiscal year"] : []));
    // Prospective value is a separate monetary record, never a lead/opportunity.
    // It still requires an actual supplied opportunity day for fiscal attribution.
    if (!common.length && d.value_meaning === "prospective" && oppAt && inPeriod(oppAt) && amount(d.value) !== null && currency)
      records.push({ ...base, id: `crm:deal:${d.id}:prospective`, kind: "prospective", occurredAt: oppAt, status: d.stage, orderValue: amount(d.value) });
    if (!included) excludedDeals++;
    if (reasons.length) issues.push({ dealId: Number(d.id), title: d.title, accountId: d.company_id ? Number(d.company_id) : null,
      accountName: d.account_name, reasons: [...new Set(reasons)], opportunityReference: crmReference(Number(d.id), "opportunity"), outcomeReference: crmReference(Number(d.id), "outcome") });
  }
  return { records, quality: { total, includedOpportunities, includedOutcomes, incompleteDeals: issues.length, excludedDeals, issues, suppressedMirrors: 0 } };
}
export function isCrmMirror(r: BusinessRecord, ids: Set<number>) {
  if (r.source !== "excel" || !r.externalEventId) return false;
  const match = /^crm:deal:(\d+):(opportunity|outcome)$/.exec(r.externalEventId);
  return !!match && ids.has(Number(match[1]));
}
