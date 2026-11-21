import { useMemo, useRef, useState, type ReactNode } from "react";
import type { HpBiDetail, HpBiFilters } from "./types";
import { dateText, dateTimeText, fyLabel, moneyText, num, hasPeriodRecords } from "./format";
import { Chip } from "./ui";
import ContactActivity, { type ContactMetric } from "./ContactActivity";
import ActivityEvidenceDialog, { type ActivityInspection } from "./ActivityEvidenceDialog";
import OpportunityPeopleDialog, { opportunityMetricLabels, type OpportunitySelection } from "./OpportunityPeopleDialog";
import type { OpportunityMetric } from "./structured";
import EngagementHistory from "@/components/EngagementHistory";
import SubmissionDateEditor from "@/components/intent/SubmissionDateEditor";
import CrmDealQuality from "./CrmDealQuality";
import { combineSourceRecords } from "./sourceEvidence";
import WorkbookProfile from "./WorkbookProfile";
import GccProfiling from "./GccProfiling";
import AccountLocations from "./AccountLocations";
import MonitoringContext, { MonitoringSourceEvidence } from "./MonitoringContext";
import AccountIntentTags from "./AccountIntentTags";
import { categoryRows, distinct, monthEnd, quarters } from "./structured";

const lab = "text-[10.5px] uppercase tracking-wider font-semibold text-[#5d7388]";
const inp = "w-full rounded border border-[#c5d3df] bg-white px-2 py-1 text-xs";
const NA = "Not available";
const S = ({ id, n, title, note, children }: { id: string; n?: number; title: string; note?: string; children: ReactNode }) => (
  <section data-testid={`section-${id}`} className="rounded-lg border border-[#d5e0ea] bg-white p-3 space-y-2">
    <h4 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#0B2A4A]">{n !== undefined ? `${n}. ` : ""}{title}</h4>
    {note && <p className="text-[11px] text-[#5d7388]">{note}</p>}{children}</section>);
const mixed = (vals: (string | boolean | null | undefined)[], fmt: (v: string) => string = v => v) => {
  const k = distinct(vals); if (!k.length) return NA; return k.length > 1 ? `Mixed: ${k.map(fmt).join(" / ")}` : fmt(k[0]);
};
const yn = (v: string) => (v === "true" ? "Yes" : v === "false" ? "No" : v);

export default function StructuredAccountView({ d, filters, parentKey, initialMetric = "touchpoints", manage, profile, recordForm, committee }: { d: HpBiDetail; filters: HpBiFilters; parentKey: string; initialMetric?: ContactMetric; manage: ReactNode; profile: ReactNode; recordForm: ReactNode; committee?: ReactNode }) {
  const [metric, setMetric] = useState<ContactMetric>(initialMetric);
  const [inspection, setInspection] = useState<ActivityInspection | null>(null);
  const [opportunitySelection, setOpportunitySelection] = useState<OpportunitySelection | null>(null);
  const [historyContact, setHistoryContact] = useState<number | null>(null);
  const [periodStart, setPeriodStart] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const a = d.account, ms = d.members;
  const qs = useMemo(() => quarters(d), [d]);
  const cats = useMemo(() => categoryRows(d), [d]);
  const records = useMemo(() => [...d.records].sort((x, y) => x.occurredAt.localeCompare(y.occurredAt)), [d]);
  const detailView = useMemo(() => {
    if (!periodStart) return d; const s = Date.parse(periodStart), e = monthEnd(periodStart);
    const w = (r: { occurredAt: string }) => Date.parse(r.occurredAt) >= s && Date.parse(r.occurredAt) < e;
    return { ...d, records: d.records.filter(w), formEvidence: d.formEvidence?.filter(w) };
  }, [d, periodStart]);
  const open = (m: ContactMetric, p: string | null = null) => { setMetric(m); setPeriodStart(p); ref.current?.scrollIntoView?.({ behavior: "smooth", block: "start" }); };
  const buyers = distinct(ms.flatMap(m => m.buyerCategories)), white = cats.filter(c => c.whitespace);
  const profiled = ms.some(m => m.buyerCategories.length || m.whitespaceCategories.length);
  const first = d.months[0], last = d.months[d.months.length - 1];
  const fyStart = first ? dateText(first.start) : NA, fyEnd = last ? dateText(new Date(monthEnd(last.start) - 1).toISOString()) : NA;
  const row = (k: string, v: ReactNode) => <div key={k} className="flex justify-between gap-3 border-t border-[#e3ebf2] py-1 text-xs"><span className="text-[#5d7388]">{k}</span><span className="font-medium text-right" data-testid={`ctx-${k}`}>{v}</span></div>;
  const opportunityLink = (value: ReactNode, metric: OpportunityMetric, category?: string) => <button type="button"
    aria-label={`View ${opportunityMetricLabels[metric].toLowerCase()} for ${category ?? "all categories"}`}
    onClick={() => setOpportunitySelection({ metric, category })}
    className="rounded px-1 font-semibold text-[#05628f] underline decoration-dotted underline-offset-2 hover:bg-[#e6f4fc] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#0096D6]">{value}</button>;
  return (
    <div className="space-y-4 mt-4 pb-8 hpbi-fade" data-testid="structured-account">
      {committee && <S id="committee" title="Buying Committee">{committee}</S>}
      <S id="context" n={1} title="Account Context">
        {row("Account name", a.parentName || a.name)}{row("GTM segment", a.segment || NA)}{row("Account classification", a.rad || NA)}
        {row("ABM classification", mixed(ms.map(m => m.abmClassification)))}{row("Global account", mixed(ms.map(m => m.globalAccount), yn))}
        {row("Industry", a.industry || NA)}{row("Employee size", a.employeeSize == null ? NA : num(a.employeeSize))}{row("Buying behavior", mixed(ms.map(m => m.buyingBehavior)))}
        {row("City", <AccountLocations members={ms} />)}
        <p className="text-[11px] text-[#5d7388]">{ms.length} member account{ms.length === 1 ? "" : "s"}; values differing between members are shown as Mixed, empty ones as Not available.</p>
        <GccProfiling members={ms} />
        <WorkbookProfile members={ms} />
        <MonitoringContext contexts={d.monitoringContext} clientId={filters.clientId} sourcePrefix="hp-account-source" />
        <details data-testid="details-edit-context"><summary className="cursor-pointer text-xs font-semibold text-[#05628f]">Edit account context</summary><div className="mt-2">{profile}</div></details>
        <details><summary className="cursor-pointer text-xs font-semibold text-[#05628f]">Manage account</summary><div className="mt-2">{manage}</div></details>
      </S>
      <S id="opportunity" n={2} title="Account Opportunity" note="Whitespace is shown only where explicitly supplied; absent categories are never inferred.">
        <AccountIntentTags d={d} opportunities />
        <div className="text-xs" data-testid="opportunity-buyers"><span className={lab}>Current buyer categories </span>{buyers.length ? buyers.map(c => <span key={c} className="mr-1"><Chip tone="blue">{c}</Chip></span>) : <span className="text-[#5d7388]">{profiled ? "None recorded" : NA}</span>}</div>
        <div className="text-xs" data-testid="opportunity-whitespace"><span className={lab}>Whitespace categories </span>{white.length ? white.map(c => <span key={c.category} className="mr-1"><Chip tone="teal">{c.category}</Chip></span>) : <span className="text-[#5d7388]">{profiled ? "None identified" : "Not available. No buyer or whitespace data supplied, so absent categories are unknown."}</span>}</div>
        <p className="text-[11px] text-[#41586e]" data-testid="opportunity-account-flags">Account-level flags, not a per-category claim. Propensity: {mixed(ms.map(m => m.propensity))}. Profiled: {mixed(ms.map(m => m.profiled), yn)}.</p>
        {cats.length > 0 && <div className="overflow-x-auto"><table className="w-full text-xs" data-testid="table-whitespace"><thead><tr className="text-left text-[10.5px] uppercase text-[#5d7388]">{["Category", "Relationship", "Marketing coverage", "Solutions of interest", "Source of interest", "Contacts engaged", "Leads", "Opps", "Opportunity ToV"].map(h => <th key={h} className="py-1 pr-2">{h}</th>)}</tr></thead>
          <tbody>{cats.map(c => <tr key={c.category} className="border-t border-[#e3ebf2] align-top" data-testid={`ws-${c.category}`}>
            <td className="py-1 pr-2 font-medium">{c.category}</td><td>{c.buyer && <Chip tone="blue">Buyer</Chip>}{c.whitespace && <Chip tone="teal">Whitespace</Chip>}{!c.buyer && !c.whitespace && <span>Observed interest only</span>}</td><td>{opportunityLink(c.touches ? `${c.touches} touchpoint${c.touches === 1 ? "" : "s"}` : "None recorded", "touchpoints", c.category)}</td>
            <td>{c.products.join(", ") || NA}</td><td>{c.sources.join(", ") || NA}</td><td>{opportunityLink(c.contacts, "engagedContacts", c.category)}</td><td>{opportunityLink(c.leads, "leads", c.category)}</td><td>{opportunityLink(c.opps, "opportunities", c.category)}</td><td>{opportunityLink(moneyText(c.tov), "value", c.category)}</td></tr>)}</tbody></table>
          <p className="text-[11px] text-[#5d7388] mt-1">Coverage, engaged contacts, leads, opportunities and ToV use the selected fiscal year and records tagged with the category. Observed interest does not establish buyer or whitespace status. Opportunity ToV excludes records without a currency or marked not counted as money; currencies are never combined.</p></div>}
        <p className="text-xs text-[#41586e]">Account totals (FY): {opportunityLink(num(a.engagedContacts), "engagedContacts")} engaged contacts / {opportunityLink(num(a.leads), "leads")} leads / {opportunityLink(num(a.opportunities), "opportunities")} opportunities. Opportunity ToV: {opportunityLink(moneyText(a.values), "value")}. Prospective: {moneyText(a.prospectiveValues)}. Booked: {moneyText(a.bookedValues)}.</p>
        <details><summary className="cursor-pointer text-xs font-semibold text-[#05628f]">Supporting evidence: recorded product interest, all dates</summary>
          {!d.recordedInterests?.length ? <p className="text-xs text-[#5d7388] mt-1">No declared product interest recorded.</p> : <ul className="mt-1 space-y-1 text-xs" data-testid="list-recorded-interests">{d.recordedInterests.map((r, i) => <li key={i} className="rounded border border-[#e3ebf2] px-2 py-1"><strong>{r.product}</strong> / {ms.find(m => m.id === r.accountId)?.name ?? "Account"} / {r.contactId ? d.contacts.find(c => c.id === r.contactId)?.name ?? "Linked contact" : "Account-level response"} / {r.source} / {dateText(r.occurredAt)}</li>)}</ul>}
          {d.interestsTruncated && <p className="text-xs text-amber-800 mt-2">Showing preferences from the latest 1,000 source records.</p>}</details>
        <CrmDealQuality crm={d.crmDeals} scopeNote="this account" />
      </S>
      <S id="engagement" n={3} title="Marketing Engagement" note={`Quarters of ${fyLabel(filters.year ?? 0)}. Volume and quality are shown side by side; no new score is inferred.`}>
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">{([["contacts", "Contacts", a.contacts], ["engagedContacts", "Engaged", a.engagedContacts], ["touchpoints", "Touch", a.touchpoints], ["leads", "Leads", a.leads], ["hot", "Hot", a.hot], ["warm", "Warm", a.warm], ["opportunities", "Opps", a.opportunities], ["closedWon", "Won", a.closedWon ?? 0], ["closedLost", "Lost", a.closedLost ?? 0]] as [ContactMetric, string, number][]).map(([m, l, v]) =>
          <button key={m} type="button" data-testid={`detail-metric-${m}`} aria-pressed={metric === m} onClick={() => open(m)} className={`rounded border py-1.5 text-center ${metric === m ? "border-[#0096D6] bg-[#e6f4fc]" : "border-[#d5e0ea] bg-white hover:bg-[#eaf6fc]"}`}><span className="block text-sm font-semibold tabular-nums">{num(v)}</span><span className="block text-[10px] uppercase text-[#5d7388]">{l}</span></button>)}</div>
        <div className="overflow-x-auto"><table className="w-full text-xs" data-testid="table-quarters"><thead><tr className="text-left text-[10.5px] uppercase text-[#5d7388]">{["Quarter", "Touch", "Contacts", "Invites", "Attended", "Digital", "Content", "Other", "Leads", "Hot/Warm", "Opps", "ToV", "Categories"].map(h => <th key={h} className="py-1 pr-2">{h}</th>)}</tr></thead>
          <tbody>{qs.map(q => <tr key={q.label} className="border-t border-[#e3ebf2] align-top" data-testid={`quarter-${q.label}`}>
            <td className="py-1 pr-2 font-medium">{q.label} <span className="text-[#5d7388]">{q.months[0].label}-{q.months[q.months.length - 1].label}</span></td><td>{q.touchpoints}</td><td>{q.contacts == null ? NA : q.contacts}</td>
            <td>{q.invitations}</td><td>{q.attendance}</td><td>{q.digital}</td><td>{q.content}</td><td>{q.other}</td><td>{q.leads}</td><td>{q.hot}/{q.warm}</td><td>{q.opportunities}</td><td>{moneyText(q.values)}</td><td>{q.categories.join(", ") || "None"}</td></tr>)}</tbody></table>
          <p className="text-[11px] text-[#5d7388] mt-1">Quarter contacts are distinct identified people with marketing touchpoints, not a sum of monthly distinct counts. Account-level touches may lack a contact; Not available means no touchpoints identify one. The journey score below is all-date, not a historical quarter score.</p></div>
        <div ref={ref} className="scroll-mt-4">
          {periodStart && <div className="mb-2 text-xs font-semibold">{d.months.find(m => m.start === periodStart)?.label} evidence only / <button type="button" className="text-[#05628f] hover:underline" onClick={() => setPeriodStart(null)}>Back to full fiscal year</button></div>}
          <ContactActivity key={`${parentKey}-${filters.year}-${metric}-${periodStart}`} detail={detailView} metric={metric} year={filters.year} /></div>
      </S>
      <S id="journey" n={4} title="Account Journey" note={`Selected ${fyLabel(filters.year ?? 0)}: ${fyStart} to ${fyEnd}. Change the fiscal year in the header (FY2027 is Nov 2026 - Oct 2027).`}>
        <ul className="space-y-1" data-testid="list-detail-months">{d.months.map(m => { const none = m.isFuture && !hasPeriodRecords(m); return (
          <li key={m.start} className="grid grid-cols-[56px_1fr] gap-2 text-xs border-t border-[#e3ebf2] py-1" data-testid={`journey-month-${m.label}`}>
            <button type="button" className="text-[#05628f] hover:underline text-left" onClick={() => open("contacts", m.start)}>{m.label}</button>
            <span className="text-[#41586e]">{none ? "Not started" : `${m.touchpoints} touchpoints / ${m.leads} leads / ${m.opportunities} opps / ${m.closedWon ?? 0} won / ${m.closedLost ?? 0} lost / ToV ${moneyText(m.values)}`}</span></li>); })}</ul>
        <p className="text-xs text-[#41586e]" data-testid="journey-routes">Journeys: {a.journeys?.length ? a.journeys.map(j => j.name).join(", ") : "None recorded"}. Pending routes {num(a.pendingJourneyRoutes ?? 0)} / failed {num(a.failedJourneyRoutes ?? 0)} / unavailable {num(a.unavailableJourneyRoutes ?? 0)}.</p>
        {a.gtm && <div data-testid="account-gtm-qualification" className="text-xs"><h5 className={lab}>GTM qualification · all responses, independent of fiscal year</h5><Chip tone={a.gtm.status === "Hot" ? "hot" : a.gtm.status === "Warm" ? "warm" : "gray"}>{a.gtm.status}</Chip>
          <p className="text-[#5d7388] mt-1">{a.gtm.hotAccounts} Hot / {a.gtm.warmAccounts} Warm legal accounts. Responses using upload/import dates: {a.gtm.uploadDateResponses ?? 0}. Correct a submission date below to update fiscal-year and monthly totals.</p>
          <ul className="mt-2 space-y-2">{(d.gtmResponses ?? []).map(r => <li key={r.reference} className="rounded border border-[#d5e0ea] p-2"><strong>{r.product}</strong> / {r.status} / {r.horizonMonths === null ? "Purchase timeframe not provided" : `${r.horizonMonths} months`}
            <p className="text-[#5d7388]">{ms.find(m => m.id === r.accountId)?.name} / {r.source} / {r.reference}</p><SubmissionDateEditor id={Number(r.reference.split(":")[1])} submittedAt={r.submittedAt} origin={r.submissionDateOrigin} /></li>)}</ul>
          <p className="text-[11px] text-[#5d7388] mt-1">Up to five product responses per legal account; Hot evidence is shown first. Counts include all qualifying responses.</p></div>}
        <div data-testid="source-gtm-responses" className="text-xs"><h5 className={lab}>Source GTM responses (Hot / Warm / Cold), all dates</h5>
          {!d.sourceGtmResponses?.length ? <p className="text-[#5d7388] mt-1">No source GTM responses recorded.</p> : <ul className="mt-1 space-y-1">{d.sourceGtmResponses.map(r => <li key={r.reference} className="rounded border border-[#e3ebf2] px-2 py-1"><Chip tone={r.classification?.toLowerCase() === "hot" ? "hot" : r.classification?.toLowerCase() === "warm" ? "warm" : "gray"}>{r.classification ? r.classification.charAt(0).toUpperCase() + r.classification.slice(1).toLowerCase() : "Unclassified"}</Chip> {r.product ?? "Product not provided"} / {r.submittedAt ? dateText(r.submittedAt) : "Date unavailable"} / {ms.find(m => m.id === r.accountId)?.name ?? "Account"}{r.contactId ? ` / ${d.contacts.find(c => c.id === r.contactId)?.name ?? "Linked contact"}` : ""} / {r.source} / route: {r.routingStatus ?? "none recorded"}</li>)}</ul>}
          {d.sourceGtmTruncated && <p className="text-xs text-amber-800">Showing up to 1,000 source responses; account totals include all responses.</p>}
          <p className="text-[11px] text-[#5d7388] mt-1">Raw source classifications; separate from the HP-qualified section above. These are responses, not actual leads.</p></div>
        <details data-testid="details-chronology"><summary className="cursor-pointer text-xs font-semibold text-[#05628f]">Chronology of source records ({records.length})</summary>
          {records.length === 0 ? <p className="text-xs text-[#5d7388] mt-1">No records for this fiscal year.</p> : <ul className="space-y-1 text-xs mt-1" data-testid="list-records">{combineSourceRecords(records).map(r => <li key={r.id} className="rounded border border-[#e3ebf2] px-2 py-1 flex flex-wrap gap-x-2 items-center">
            {r.relatedRecords?.map(source => <button key={source.id} type="button" className="text-[#05628f] hover:underline text-left" onClick={() => setInspection({ record: source })}>Same questionnaire: activity record {source.id}</button>)}
            <button type="button" className="text-[#05628f] hover:underline" onClick={() => setInspection({ record: r })}>View source details</button>
            <span className="tabular-nums text-[#5d7388]">{dateTimeText(r.occurredAt)}</span><Chip tone={r.kind === "opportunity" ? "blue" : r.kind === "lead" ? "teal" : "gray"}>{r.kind}</Chip>
            <strong>{r.contactId === null ? "Account-level" : d.contacts.find(c => c.id === r.contactId)?.name ?? "Contact unavailable"}</strong><span>{[r.category, r.product].filter(Boolean).join(" / ") || "No category"}</span>
            {r.horizonMonths != null && <Chip tone={r.product && r.horizonMonths >= 0 && r.horizonMonths <= 3 ? "hot" : r.product && r.horizonMonths > 3 && r.horizonMonths <= 6 ? "warm" : "gray"}>{r.horizonMonths} mo</Chip>}
            {r.exclusionReasons?.length ? <span className="text-[#8f4f0f]">Not counted as money: {r.exclusionReasons.join("; ")}</span> : null}
            {r.orderValue != null && <span className="font-medium">{r.currency ? `${r.currency} ${num(r.orderValue)}` : `${num(r.orderValue)} (no currency)`}</span>}
            {r.externalEventId && <span className="text-[10px] font-mono text-[#5d7388] break-all">{r.externalEventId}</span>}
            <span className="text-[#8CA0B3]">{r.sourceName || r.source}{r.status ? ` / ${r.status}` : ""}</span></li>)}</ul>}</details>
        <details><summary className="cursor-pointer text-xs font-semibold text-[#05628f]">New record</summary><div className="mt-2">{recordForm}</div></details>
      </S>
      <S id="relationship" n={5} title="Relationship Score" note="Proxy only: the existing journey score, not a new relationship formula.">
        <p className="text-2xl font-semibold tabular-nums text-[#0B2A4A]" data-testid="relationship-score">{num(a.score)}</p>
        <p className="text-xs text-[#41586e]">Journey score is the sum of contact engagement points, uncapped. Recency and breadth are shown below as context and are not weighted into it; ToV is not newly weighted. Qualification is separate: {a.status ?? "Unqualified"}.</p>
        <p className="text-xs text-[#41586e]" data-testid="relationship-context">Selected-FY context — last activity: {a.lastActivity ? dateText(a.lastActivity) : NA}. Breadth: {num(a.engagedContacts)} engaged of {num(a.contacts)} linked contacts. Score and history remain all-date.</p>
        {d.contacts.length === 0 ? <p className="text-xs text-[#5d7388]">No contacts linked.</p> : <ul className="divide-y divide-[#e3ebf2] text-xs" data-testid="list-contacts">{d.contacts.map(c => <li key={c.id} className="py-1.5"><button type="button" className="flex justify-between gap-2 w-full text-left text-[#05628f] hover:underline" onClick={() => setInspection({ person: c })}><span className="min-w-0"><span className="block truncate">{c.name} {c.isNew && <Chip tone="teal">New</Chip>}</span><span className="block truncate text-[#5d7388]">{c.title || "Title unknown"} / {c.email || "No email"}</span></span><span className="tabular-nums font-semibold">{c.score}</span></button></li>)}</ul>}
        <div data-testid="account-engagement-history"><h5 className={lab}>Engagement history, all dates</h5>
          <EngagementHistory allowRouting key={`h-${filters.clientId}-${parentKey}`} target={{ parentKey, clientId: filters.clientId }} title="Parent account qualification and history" />
          {d.contacts.length > 0 && <label className={`${lab} block mt-2`}>Per-contact history<select data-testid="select-history-contact" className={inp} value={historyContact ?? ""} onChange={e => setHistoryContact(e.target.value ? Number(e.target.value) : null)}><option value="">Choose a contact</option>{d.contacts.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>}
          {historyContact != null && <EngagementHistory allowRouting key={`hc-${historyContact}`} target={{ contactId: historyContact }} title="Contact history" />}</div>
      </S>
      <MonitoringSourceEvidence contexts={d.monitoringContext} sourcePrefix="hp-account-source" />
      <ActivityEvidenceDialog value={inspection} detail={d} onClose={() => setInspection(null)} dateText={dateTimeText} />
      {opportunitySelection && <OpportunityPeopleDialog key={`${opportunitySelection.category ?? "*"}-${opportunitySelection.metric}`} selection={opportunitySelection} detail={d}
        onClose={() => setOpportunitySelection(null)} onInspect={record => { setOpportunitySelection(null); setInspection({ record }); }} />}
    </div>
  );
}
