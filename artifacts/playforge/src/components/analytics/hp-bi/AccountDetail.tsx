import { useEffect, useMemo, useRef, useState } from "react";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { useToast } from "@/hooks/use-toast";
import { useAddHpRecord, useHpBiDetail, useUpdateHpProfile } from "./api";
import type { HpBiDetail, HpBiFilters } from "./types";
import { HP_DIMENSIONS, READONLY_DIMENSIONS, dateText, dateTimeText, moneyText, num, hasPeriodRecords } from "./format";
import { Chip, ErrorBox, HBar, Skel } from "./ui";
import CrmDealQuality from "./CrmDealQuality";
import ManageAccountPanel from "./ManageAccountPanel";
import SubmissionDateEditor from "@/components/intent/SubmissionDateEditor";
import { combineSourceRecords } from "./sourceEvidence";
import ContactActivity, { type ContactMetric } from "./ContactActivity";
import EngagementHistory from "@/components/EngagementHistory";
import StructuredAccountView from "./StructuredAccountView";
import type { AccountLayout } from "./structured";
import ActivityEvidenceDialog, { type ActivityInspection } from "./ActivityEvidenceDialog";
import AccountLocations from "./AccountLocations";
import GccProfiling from "./GccProfiling";
import AccountIntentTags from "./AccountIntentTags";
import AccountPriority from "./AccountPriority";
import CommitteeContacts from "@/components/buying-committee/CommitteeContacts";

const KINDS = ["invitation", "attendance", "digital", "content", "other", "interest", "lead", "opportunity", "closed_won"];
const inp = "w-full rounded border border-[#c5d3df] bg-white px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-[#0096D6]/40";
const lab = "text-[10.5px] uppercase tracking-wider font-semibold text-[#5d7388]";

function Matrix({ d }: { d: HpBiDetail }) {
  const rows = useMemo(() => {
    const m = new Map<string, { buyer: boolean; white: boolean; observed: number }>();
    const get = (k: string) => { if (!m.has(k)) m.set(k, { buyer: false, white: false, observed: 0 }); return m.get(k)!; };
    d.members.forEach(x => { x.buyerCategories.forEach(c => (get(c).buyer = true)); x.whitespaceCategories.forEach(c => (get(c).white = true)); });
    d.records.forEach(r => { if (r.category) get(r.category).observed++; });
    d.account.categories.forEach(c => { const g = get(c); if (!g.observed) g.observed = 1; });
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [d]);
  const profiled = d.members.some(x => x.buyerCategories.length > 0 || x.whitespaceCategories.length > 0);
  if (!rows.length) return <p className="text-xs text-[#5d7388]" data-testid="text-matrix-unknown">Unknown. No buyer, whitespace or observed categories supplied for this account.</p>;
  return (
    <div>
      <table className="w-full text-xs" data-testid="table-category-matrix">
        <thead><tr className="text-left text-[10.5px] uppercase text-[#5d7388]"><th className="py-1">Category</th><th>Buyer</th><th>Whitespace</th><th>Observed</th></tr></thead>
        <tbody>{rows.map(([c, v]) => (
          <tr key={c} className="border-t border-[#e3ebf2]"><td className="py-1 font-medium">{c}</td>
            <td>{v.buyer ? <Chip tone="blue">Buyer</Chip> : <span className="text-[#8CA0B3]">{profiled ? "No" : "Unknown"}</span>}</td>
            <td>{v.white ? <Chip tone="teal">Whitespace</Chip> : <span className="text-[#8CA0B3]">{profiled ? "No" : "Unknown"}</span>}</td>
            <td>{v.observed > 0 ? <Chip tone="amber">Observed{v.observed > 1 ? ` x${v.observed}` : ""}</Chip> : <span className="text-[#8CA0B3]">None</span>}</td></tr>
        ))}</tbody>
      </table>
      {!profiled && <p className="text-[11px] text-[#5d7388] mt-1">No buyer data supplied, so absent categories are unknown, not confirmed whitespace.</p>}
    </div>
  );
}

export function ProfileEditor({ d, clientId }: { d: HpBiDetail; clientId: number }) {
  const { toast } = useToast();
  const update = useUpdateHpProfile(clientId);
  const [mid, setMid] = useState(d.members[0]?.id ?? 0);
  const m = d.members.find(x => x.id === mid) ?? d.members[0];
  const [f, setF] = useState<Record<string, string>>({});
  const [dims, setDims] = useState<Record<string, string>>({});
  const [nk, setNk] = useState(""), [nv, setNv] = useState("");
  if (!m) return null;
  const v = (k: string, base: string) => (k in f ? f[k] : base);
  const set = (k: string) => (e: { target: { value: string } }) => setF(p => ({ ...p, [k]: e.target.value }));
  const top = (m.dimensions as Record<string, unknown>).top200;
  const topBase = typeof top === "boolean" ? (top ? "yes" : "no") : "";
  const reset = () => { setF({}); setDims({}); setNk(""); setNv(""); };
  const save = () => {
    const values: Record<string, unknown> = {};
    (["abmClassification", "buyingBehavior", "propensity"] as const).forEach(k => { if (k in f) values[k] = f[k].trim() || null; });
    ["globalAccount", "profiled", "top200"].forEach(k => { if (k in f) values[k] = f[k] === "" ? null : f[k] === "yes"; });
    ["buyerCategories", "whitespaceCategories"].forEach(k => { if (k in f) values[k] = f[k].split(",").map(s => s.trim()).filter(Boolean); });
    const dd: Record<string, string> = { ...dims };
    if (nk && nv.trim()) dd[nk] = nv.trim();
    if (Object.keys(dd).length) values.dimensions = dd;
    if (!Object.keys(values).length) { toast({ title: "Nothing changed" }); return; }
    update.mutate({ companyId: m.id, values }, {
      onSuccess: () => { toast({ title: "Profile saved" }); reset(); },
      onError: (e) => toast({ title: "Save failed", description: (e as Error).message, variant: "destructive" }),
    });
  };
  const tri = (b: boolean | null) => (b == null ? "" : b ? "yes" : "no");
  const TriSel = ({ k, base, label }: { k: string; base: string; label: string }) => (
    <label><span className={lab}>{label}</span><select data-testid={`select-${k}`} className={inp} value={v(k, base)} onChange={set(k)}>{k !== "top200" && <option value="">Unknown</option>}<option value="yes">Yes</option><option value="no">{k === "top200" ? "Not designated" : "No"}</option></select></label>);
  return (
    <div className="space-y-3" data-testid="form-profile">
      {!!m.missingFields?.length && <div data-testid="account-missing-fields" className="rounded border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
        <strong>Needs completion</strong><p className="mt-1">Missing workbook fields: {m.missingFields.join(", ")}.</p>
        <p className="mt-1">This account and its contacts, scores and product evidence remain included. Update editable context below; use a reviewed account import for protected HP ID or hierarchy fields.</p>
      </div>}
      <p className="text-[11px] text-[#5d7388]">Identity and hierarchy dimensions are read-only; change them through a reviewed import. Other dimensions can be edited and the server remaps normalized columns.</p>
      {d.members.length > 1 && (
        <label className="block"><span className={lab}>Member account</span>
          <select data-testid="select-member" className={inp} value={mid} onChange={e => { setMid(Number(e.target.value)); reset(); }}>{d.members.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}</select></label>)}
      <div className="grid grid-cols-2 gap-2">
        <label><span className={lab}>ABM classification</span><input data-testid="input-abm" className={inp} value={v("abmClassification", m.abmClassification ?? "")} onChange={set("abmClassification")} placeholder="Blank means not designated" /></label>
        <label><span className={lab}>Buying behavior</span><input data-testid="input-behavior" className={inp} value={v("buyingBehavior", m.buyingBehavior ?? "")} onChange={set("buyingBehavior")} /></label>
        <label><span className={lab}>Propensity</span><input data-testid="input-propensity" className={inp} value={v("propensity", m.propensity ?? "")} onChange={set("propensity")} /></label>
        <TriSel k="top200" base={topBase} label="Top 200 ABM" />
        <TriSel k="globalAccount" base={tri(m.globalAccount)} label="Global account" />
        <TriSel k="profiled" base={tri(m.profiled)} label="Profiled" />
      </div>
      <label className="block"><span className={lab}>Buyer categories (comma separated)</span><input data-testid="input-buyer-cats" className={inp} value={v("buyerCategories", m.buyerCategories.join(", "))} onChange={set("buyerCategories")} /></label>
      <label className="block"><span className={lab}>Whitespace categories (comma separated)</span><input data-testid="input-white-cats" className={inp} value={v("whitespaceCategories", m.whitespaceCategories.join(", "))} onChange={set("whitespaceCategories")} /></label>
      <div>
        <span className={lab}>Source dimensions</span>
        <div className="mt-1 grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] gap-x-3 gap-y-1 text-xs items-center">
          {Object.entries(m.dimensions).filter(([k]) => k !== "top200" && !k.startsWith("_")).map(([k, val]) => (
            <div key={k} className="contents"><label htmlFor={`dim-${k}`} className="text-[#5d7388] truncate" title={k}>{HP_DIMENSIONS[k] ?? k}</label>
              <input id={`dim-${k}`} data-testid={`input-dim-${k}`} readOnly={READONLY_DIMENSIONS.includes(k)} disabled={READONLY_DIMENSIONS.includes(k)} className={`${inp} disabled:bg-[#eef3f7] disabled:text-[#5d7388]`} value={k in dims ? dims[k] : val == null ? "" : String(val)} placeholder="Unknown" onChange={e => setDims(p => ({ ...p, [k]: e.target.value }))} /></div>))}
          {Object.keys(m.dimensions).length === 0 && <p className="col-span-2 text-[#5d7388]">No dimensions supplied.</p>}
        </div>
        <div className="grid grid-cols-2 gap-2 mt-2">
          <select data-testid="select-dim-new" className={inp} value={nk} onChange={e => setNk(e.target.value)}><option value="">Add dimension</option>{Object.entries(HP_DIMENSIONS).filter(([k]) => !(k in m.dimensions) && !READONLY_DIMENSIONS.includes(k)).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
          <input data-testid="input-dim-value" className={inp} placeholder="Value" value={nv} onChange={e => setNv(e.target.value)} />
        </div>
      </div>
      <button data-testid="button-save-profile" onClick={save} disabled={update.isPending} className="rounded bg-[#0B2A4A] text-white text-xs font-semibold px-4 py-1.5 hover:bg-[#123b66] disabled:opacity-50">{update.isPending ? "Saving" : "Save profile"}</button>
    </div>
  );
}

function RecordForm({ d, clientId }: { d: HpBiDetail; clientId: number }) {
  const { toast } = useToast();
  const add = useAddHpRecord(clientId);
  const blank = { accountId: d.members.length === 1 ? String(d.members[0].id) : "", contactId: "", kind: "digital", occurredAt: new Date().toISOString().slice(0, 10), category: "", product: "", horizon: "", value: "", currency: "", sourceName: "", status: "" };
  const [f, setF] = useState(blank);
  const set = (k: keyof typeof blank) => (e: { target: { value: string } }) => setF(p => ({ ...p, [k]: e.target.value, ...(k === "accountId" ? { contactId: "" } : {}) }));
  const needsCur = f.value !== "" && f.currency.trim().length !== 3;
  const contacts = d.contacts.filter(c => !f.accountId || c.companyId === Number(f.accountId));
  const submit = () => {
    if (needsCur || !f.accountId) return;
    add.mutate({ accountId: Number(f.accountId), contactId: f.contactId ? Number(f.contactId) : null, kind: f.kind, occurredAt: f.occurredAt,
      category: f.category || undefined, product: f.product || undefined, horizonMonths: f.horizon === "" ? null : Number(f.horizon),
      orderValue: f.value === "" ? null : Number(f.value), currency: f.currency.trim().toUpperCase() || undefined,
      sourceName: f.sourceName || undefined, status: f.status || undefined }, {
      onSuccess: () => { toast({ title: "Record added" }); setF({ ...blank, accountId: f.accountId }); },
      onError: (e) => toast({ title: "Could not add record", description: (e as Error).message, variant: "destructive" }),
    });
  };
  const explicit = f.kind === "opportunity" || f.kind === "closed_won";
  return (
    <div className="grid grid-cols-2 gap-2" data-testid="form-record">
      <label className="col-span-2"><span className={lab}>Member account</span><select data-testid="select-record-account" className={inp} value={f.accountId} onChange={set("accountId")}><option value="">Choose member account</option>{d.members.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}</select></label>
      <label><span className={lab}>Kind</span><select data-testid="select-kind" className={inp} value={f.kind} onChange={set("kind")}>{KINDS.map(k => <option key={k}>{k}</option>)}</select></label>
      <label><span className={lab}>Date</span><input data-testid="input-date" type="date" className={inp} value={f.occurredAt} onChange={set("occurredAt")} /></label>
      <label><span className={lab}>Contact</span><select data-testid="select-contact" className={inp} value={f.contactId} onChange={set("contactId")}><option value="">None / account level</option>{contacts.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
      <label><span className={lab}>Category</span><input data-testid="input-category" className={inp} value={f.category} onChange={set("category")} /></label>
      <label><span className={lab}>Product / service</span><input data-testid="input-product" className={inp} value={f.product} onChange={set("product")} /></label>
      <label><span className={lab}>Purchase horizon (months)</span><input data-testid="input-horizon" type="number" min={0} className={inp} value={f.horizon} onChange={set("horizon")} /></label>
      <label><span className={lab}>Total Order Value</span><input data-testid="input-value" type="number" min={0} className={inp} value={f.value} onChange={set("value")} /></label>
      <label><span className={lab}>Currency (ISO)</span><input data-testid="input-currency" maxLength={3} className={inp} value={f.currency} onChange={set("currency")} placeholder="INR" /></label>
      <label><span className={lab}>Source name</span><input data-testid="input-source" className={inp} value={f.sourceName} onChange={set("sourceName")} /></label>
      <label><span className={lab}>Status</span><input data-testid="input-status" className={inp} value={f.status} onChange={set("status")} /></label>
      <p className="col-span-2 text-[11px] text-[#5d7388]">{explicit ? "Counts as an actual opportunity or booked record only because you are entering it explicitly." : "A value on other kinds is prospective Total Order Value, not booked."} Selected product/service + 0–3 months is Hot; over 3 through 6 months is Warm. Over 6 months, no clear horizon, or no product/service is Cold.</p>
      {needsCur && <p className="col-span-2 text-[11px] text-[#a8400f]">Enter a 3-letter currency so the value is never mixed with another.</p>}
      <div className="col-span-2"><button data-testid="button-add-record" disabled={add.isPending || needsCur || !f.occurredAt || !f.accountId} onClick={submit} className="rounded bg-[#0096D6] text-white text-xs font-semibold px-4 py-1.5 hover:bg-[#0583b9] disabled:opacity-50">{add.isPending ? "Adding" : "Add record"}</button></div>
    </div>
  );
}

const H = ({ children }: { children: string }) => <h4 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#0B2A4A] border-b border-[#d5e0ea] pb-1 mb-2">{children}</h4>;

export default function AccountDetail({ filters, parentKey, initialMetric = "touchpoints", onClose, layout = "original" }: { filters: HpBiFilters; parentKey: string | null; initialMetric?: ContactMetric; onClose: () => void; layout?: AccountLayout }) {
  const [activeMetric, setActiveMetric] = useState<ContactMetric>(initialMetric);
  const [periodStart, setPeriodStart] = useState<string | null>(null);
  const [inspection, setInspection] = useState<ActivityInspection | null>(null);
  const [historyContact, setHistoryContact] = useState<number | null>(null);
  const activityRef = useRef<HTMLDivElement>(null);
  useEffect(() => { setActiveMetric(initialMetric); setPeriodStart(null); setInspection(null); setHistoryContact(null); }, [parentKey, initialMetric, filters.year]);
  const q = useHpBiDetail({ ...filters, parentKey: parentKey ?? undefined, page: undefined, pageSize: undefined }, !!parentKey);
  const d = q.data;
  const activityDetail = useMemo(() => {
    if (!d || !periodStart) return d;
    const start = Date.parse(periodStart), india = new Date(start + 330 * 60000);
    const end = Date.UTC(india.getUTCFullYear(), india.getUTCMonth() + 1, 1) - 330 * 60000;
    const within = (r: { occurredAt: string }) => Date.parse(r.occurredAt) >= start && Date.parse(r.occurredAt) < end;
    return { ...d, records: d.records.filter(within), formEvidence: d.formEvidence?.filter(within) };
  }, [d, periodStart]);
  const openActivity = (metric: ContactMetric, month: string | null = null) => {
    setActiveMetric(metric); setPeriodStart(month); activityRef.current?.scrollIntoView?.({ behavior: "smooth", block: "start" });
  };
  const maxM = Math.max(1, ...(d?.months.map(m => m.touchpoints) ?? [1]));
  const records = useMemo(() => [...(d?.records ?? [])].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt)), [d]);
  return (
    <Sheet open={!!parentKey} onOpenChange={o => !o && onClose()}>
      <SheetContent side="right" className="w-full sm:max-w-[640px] overflow-y-auto bg-[#f6f9fb]" data-testid="sheet-account-detail">
        <SheetHeader>
          <button type="button" data-testid="button-detail-back" onClick={onClose} className="self-start text-xs font-semibold text-[#05628f] hover:underline">&larr; Back to accounts</button>
          <SheetTitle className="text-[#0B2A4A]" style={{ fontFamily: "'Barlow Semi Condensed', sans-serif" }}>{d ? d.account.parentName || d.account.name : "Account"}</SheetTitle>
          <SheetDescription>{d ? `${d.account.segment || "Unclassified"} / ${d.account.rad || "Unknown"} / ${d.members.length} member account${d.members.length === 1 ? "" : "s"}` : "Parent account detail"}</SheetDescription>
        </SheetHeader>
        {q.isLoading && <div className="space-y-3 mt-4"><Skel className="h-20" /><Skel className="h-40" /><Skel className="h-40" /></div>}
        {q.isError && <div className="mt-4"><ErrorBox message={(q.error as Error).message} onRetry={() => q.refetch()} /></div>}
        {d && <AccountIntentTags d={d} />}
        {d && <div className="mt-3"><AccountPriority priority={d.account.priority} /></div>}
        {d && layout === "structured" && parentKey && <StructuredAccountView key={`${filters.clientId}-${parentKey}-${filters.year}-${initialMetric}`} initialMetric={initialMetric} d={d} filters={filters} parentKey={parentKey} manage={<ManageAccountPanel key={`m${d.account.id}`} d={d} clientId={filters.clientId} />} profile={<ProfileEditor key={d.account.id} d={d} clientId={filters.clientId} />} committee={<CommitteeContacts clientId={filters.clientId} accountIds={d.members.map(m => m.id)} pageSize={5} />} recordForm={<RecordForm key={`r${d.account.id}`} d={d} clientId={filters.clientId} />} />}
        {d && layout === "original" && (
          <div className="space-y-6 mt-4 pb-8 hpbi-fade">
            <section data-testid="original-buying-committee"><H>Buying Committee</H><CommitteeContacts clientId={filters.clientId} accountIds={d.members.map(m => m.id)} pageSize={5} /></section>
            <section><H>Account Opportunity · Source intent</H><AccountIntentTags d={d} opportunities /></section>
            <section data-testid="original-account-context">
              <H>Account context</H>
              <div className="flex justify-between gap-3 py-1 text-xs">
                <span className="text-[#5d7388]">City</span>
                <div className="text-right font-medium"><AccountLocations members={d.members} /></div>
              </div>
              <GccProfiling members={d.members} />
            </section>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {([
                ["contacts", "Contacts", d.account.contacts], ["engagedContacts", "Engaged (FY)", d.account.engagedContacts],
                ["touchpoints", "Touch (FY)", d.account.touchpoints], ["leads", "Leads (FY)", d.account.leads],
                ["hot", "Hot (FY)", d.account.hot], ["warm", "Warm (FY)", d.account.warm], ["opportunities", "Opps (FY)", d.account.opportunities],
                ["closedWon", "Won (FY)", d.account.closedWon ?? 0], ["closedLost", "Lost (FY)", d.account.closedLost ?? 0],
              ] as [ContactMetric, string, number][]).map(([metric, label, value]) => (
                <button type="button" key={metric} data-testid={`detail-metric-${metric}`} aria-pressed={activeMetric === metric}
                  onClick={() => openActivity(metric)}
                  className={`rounded border py-2 text-center focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#0096D6] ${activeMetric === metric ? "border-[#0096D6] bg-[#e6f4fc]" : "border-[#d5e0ea] bg-white hover:bg-[#eaf6fc]"}`}>
                  <span className="block text-sm font-semibold tabular-nums text-[#0B2A4A]">{num(value)}</span>
                  <span className="block text-[10px] uppercase tracking-wider text-[#5d7388]">{label}</span>
                </button>
              ))}
            </div>
            {d.account.touchpointsAllDates!==undefined&&<p className="text-xs text-[#5d7388]">{num(d.account.touchpointsAllDates)} touchpoints across all dates. The counters above show only the selected fiscal year; earlier activity is retained in engagement history below.</p>}
            <div ref={activityRef} className="scroll-mt-4">
              {periodStart && <div className="mb-2 text-xs font-semibold">{d.months.find(m => m.start === periodStart)?.label} evidence only · <button type="button" className="text-[#05628f] hover:underline" onClick={() => setPeriodStart(null)}>Back to full fiscal year</button></div>}
              <ContactActivity key={`${parentKey}-${filters.year}-${activeMetric}-${periodStart}`} detail={activityDetail!} metric={activeMetric} year={filters.year} />
            </div>
            {d.account.gtm && <section data-testid="account-gtm-qualification">
              <H>Historical GTM qualification · all responses</H>
              <Chip tone={d.account.gtm.status === "Hot" ? "hot" : d.account.gtm.status === "Warm" ? "warm" : "gray"}>{d.account.gtm.status}</Chip>
              <p className="text-xs text-[#5d7388] mt-2">{d.account.gtm.hotAccounts} Hot / {d.account.gtm.warmAccounts} Warm legal accounts. Responses using upload/import dates: {d.account.gtm.uploadDateResponses ?? 0}. Correct a submission date below to update its fiscal-year and monthly totals.</p>
              <ul className="mt-2 space-y-2 text-xs">{(d.gtmResponses ?? []).map(r => <li key={r.reference} className="rounded border border-[#d5e0ea] bg-white p-2">
                <strong>{r.product}</strong> · {r.status} · {r.horizonMonths === null ? "Purchase timeframe not provided" : `Purchase timeframe: ${r.horizonMonths} months`}
                <p className="text-[#5d7388] mt-1">{d.members.find(m => m.id === r.accountId)?.name} · {r.source} · {r.reference}</p>
                <SubmissionDateEditor id={Number(r.reference.split(":")[1])} submittedAt={r.submittedAt} origin={r.submissionDateOrigin}/>
              </li>)}</ul>
              <p className="text-[11px] text-[#5d7388] mt-1">Up to five product responses per legal account; Hot evidence is shown first. Counts include all qualifying responses.</p>
            </section>}
            <p className="text-xs text-[#41586e]">Journey score (sum of contact engagement points, uncapped): {num(d.account.score)}. Qualification: {d.account.status ?? "Unqualified"}.</p>
            <p className="text-xs text-[#41586e]">Opportunity ToV: {moneyText(d.account.values)}</p>
            <p className="text-xs text-[#41586e]">Prospective: {moneyText(d.account.prospectiveValues)}</p>
            <p className="text-xs text-[#41586e]" data-testid="text-account-booked">Booked business: {moneyText(d.account.bookedValues)} ({d.account.closedWon ?? 0} won / {d.account.closedLost ?? 0} lost)</p>
            <CrmDealQuality crm={d.crmDeals} scopeNote="this account" />
            <section><H>Monthly records, Nov to Oct</H>
              <ul className="space-y-1" data-testid="list-detail-months">{d.months.map(m => (
                <li key={m.start} className="grid grid-cols-[48px_1fr_auto] items-center gap-2 text-xs">
                  <button type="button" className="text-[#05628f] hover:underline text-left disabled:text-[#5d7388]" disabled={m.isFuture && !hasPeriodRecords(m)} onClick={() => openActivity("contacts", m.start)}>{m.label}</button>
                  <button type="button" aria-label={`${m.label}: ${m.touchpoints} touchpoints`} disabled={m.isFuture && !hasPeriodRecords(m)} onClick={() => openActivity("touchpoints", m.start)}><HBar value={m.isFuture && !hasPeriodRecords(m) ? 0 : m.touchpoints} max={maxM} h={7} /></button>
                  <span className="tabular-nums w-40 text-right text-[#41586e]">{m.isFuture && !hasPeriodRecords(m) ? "not started" : <>
                    {([["touchpoints", m.touchpoints, "tp"], ["leads", m.leads, "leads"], ["opportunities", m.opportunities, "opps"], ["closedWon", m.closedWon ?? 0, "won"], ["closedLost", m.closedLost ?? 0, "lost"]] as [ContactMetric, number, string][]).map(([metric, count, text], i) =>
                      <span key={metric}>{i > 0 && " / "}<button type="button" className="text-[#05628f] hover:underline" onClick={() => openActivity(metric, m.start)}>{count} {text}</button></span>)}
                  </>}</span></li>))}</ul>
            </section>
            <section><H>Category matrix</H><Matrix d={d} /></section>
            <section><H>Contacts</H>
              {d.contacts.length === 0 ? <p className="text-xs text-[#5d7388]">No contacts linked.</p> :
                <ul className="divide-y divide-[#e3ebf2] text-xs" data-testid="list-contacts">{d.contacts.map(c => (
                  <li key={c.id} className="py-1.5"><button type="button" className="flex justify-between gap-2 w-full text-left text-[#05628f] hover:underline" onClick={() => setInspection({ person: c })}>
                    <div className="min-w-0"><div className="font-medium truncate">{c.name} {c.isNew && <Chip tone="teal">New</Chip>}</div><div className="text-[#5d7388] truncate">{c.title || "Title unknown"} / {c.email || "No email"}</div></div><span className="tabular-nums font-semibold">{c.score}</span>
                  </button></li>))}</ul>}
              <button type="button" className="text-xs text-[#05628f] hover:underline mt-2" onClick={() => openActivity("contacts")}>Explore all {d.contacts.length} contacts and their contributor flags</button>
            </section>
            <section data-testid="account-engagement-history"><H>Engagement history, all dates</H>
              <EngagementHistory allowRouting key={`h-${filters.clientId}-${parentKey}`} target={{ parentKey: parentKey!, clientId: filters.clientId }} title="Parent account qualification and history" />
              {d.contacts.length > 0 && <div className="mt-3 space-y-2">
                <label className={lab}>Per-contact history
                  <select data-testid="select-history-contact" className={inp} value={historyContact ?? ""} onChange={e => setHistoryContact(e.target.value ? Number(e.target.value) : null)}>
                    <option value="">Choose a contact</option>{d.contacts.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
                {historyContact != null && <EngagementHistory allowRouting key={`hc-${historyContact}`} target={{ contactId: historyContact }} title="Contact history" />}
              </div>}
            </section>
            <section><H>Recorded product interest — all dates</H>
              <p className="text-[11px] text-[#5d7388] mb-2">Recorded preferences are retained independently of this fiscal year's totals; they do not create new leads or booked revenue.</p>
              {!d.recordedInterests?.length ? <p className="text-xs text-[#5d7388]">No declared product interest recorded.</p> :
                <ul data-testid="list-recorded-interests" className="space-y-1 text-xs">{d.recordedInterests.map((r, i) =>
                  <li key={i} className="rounded border border-[#e3ebf2] bg-white px-2 py-1.5">
                    <strong>{r.product}</strong> / {d.members.find(m => m.id === r.accountId)?.name ?? "Account"}
                    {" / "}{r.contactId ? d.contacts.find(c => c.id === r.contactId)?.name ?? "Linked contact" : "Account-level response"}
                    <span className="block text-[#5d7388]">{r.source} / {dateText(r.occurredAt)}</span>
                  </li>)}</ul>}
              {d.interestsTruncated && <p className="text-xs text-amber-800 mt-2">Showing preferences from the latest 1,000 source records.</p>}
            </section>
            <section><H>Records in order</H>
              {records.length === 0 ? <p className="text-xs text-[#5d7388]">No records for this fiscal year.</p> :
                <ul className="space-y-1 text-xs" data-testid="list-records">{combineSourceRecords(records).map(r => (
                  <li key={r.id} className="rounded border border-[#e3ebf2] bg-white px-2 py-1.5 flex flex-wrap gap-x-2 gap-y-0.5 items-center">
                    {r.relatedRecords?.map(source => <button key={source.id} type="button" className="text-[#05628f] hover:underline text-left" onClick={() => setInspection({ record: source })}>Same questionnaire: activity record {source.id}</button>)}
                    <button type="button" className="text-[#05628f] hover:underline" onClick={() => setInspection({ record: r })}>View source details</button>
                    <span className="tabular-nums text-[#5d7388]">{dateTimeText(r.occurredAt)}</span><Chip tone={r.kind === "opportunity" ? "blue" : r.kind === "lead" ? "teal" : "gray"}>{r.kind}</Chip>
                    <strong>{r.contactId === null ? "Account-level / no linked contact" : d.contacts.find(c => c.id === r.contactId)?.name ?? "Contact unavailable"}</strong>
                    <span>{[r.category, r.product].filter(Boolean).join(" / ") || "No category"}</span>
                    {r.horizonMonths != null && <Chip tone={r.product && r.horizonMonths >= 0 && r.horizonMonths <= 3 ? "hot" : r.product && r.horizonMonths > 3 && r.horizonMonths <= 6 ? "warm" : "gray"}>{r.horizonMonths} mo</Chip>}
                    {r.exclusionReasons && r.exclusionReasons.length > 0 && <span className="text-[10.5px] text-[#8f4f0f]">Not counted as money: {r.exclusionReasons.join("; ")}</span>}
                    {r.externalEventId && <span className="text-[10px] font-mono text-[#5d7388] break-all">{r.externalEventId}</span>}
                    {r.orderValue != null && <span className="font-medium">{r.currency ? `${r.currency} ${num(r.orderValue)}` : `${num(r.orderValue)} (no currency)`}</span>}
                    <span className="text-[#8CA0B3] ml-auto">{r.sourceName || r.source}{r.status ? ` / ${r.status}` : ""}</span></li>))}</ul>}
            </section>
            <ActivityEvidenceDialog value={inspection} detail={d} onClose={() => setInspection(null)} dateText={dateTimeText} />
            <section><H>Manage account</H><ManageAccountPanel key={`m${d.account.id}`} d={d} clientId={filters.clientId} /></section>
            <section><H>Edit account context</H><ProfileEditor key={d.account.id} d={d} clientId={filters.clientId} /></section>
            <section><H>New record</H><RecordForm key={`r${d.account.id}`} d={d} clientId={filters.clientId} /></section>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
