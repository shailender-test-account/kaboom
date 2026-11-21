import { ArrowLeft } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { HpBiDashboard, HpBiPeriod } from "./types";
import type { EvidenceQuery } from "./EvidenceDialog";
import { moneyText, num } from "./format";

export type MetricKey = "accounts" | "contacts" | "touchpoints" | "leads" | "hot" | "opps" | "oppValue" | "prospective" | "booked" | "won" | "lost" | "score";
type Action = { label: string; run: "accounts" | "scoring" | "evidence"; query?: EvidenceQuery };
interface Def { title: string; value: string; counts: string; qtr?: (q: HpBiPeriod) => string; seg?: boolean; cat?: boolean; extra: [string, string][]; action: Action }

function define(k: MetricKey, d: HpBiDashboard): Def {
  const s = d.summary;
  const money = (v: Record<string, number>) => moneyText(v);
  switch (k) {
    case "accounts": return { title: "Legal accounts", value: num(s.accounts), counts: "Legal accounts matching the current filters. A roster count is not a lead count; accounts without contacts or activity stay included.", seg: true,
      extra: [["Parent groups", num(s.parentAccounts)], ["New accounts", num(s.newAccounts)], ["Accounts with touchpoints", num(s.engagedAccounts)]], action: { label: "Open filtered accounts table", run: "accounts" } };
    case "contacts": return { title: "Contacts", value: num(s.contacts), counts: "Contacts linked to the matching accounts. Contacts are people, not leads. Quarter figures below show distinct engaged contacts, not the full contact roster.", seg: true, qtr: q => `${num(q.contacts)} engaged contacts`,
      extra: [["New contacts", num(s.newContacts)], ["Engaged contacts", num(s.engagedContacts)]], action: { label: "Open filtered accounts table", run: "accounts" } };
    case "touchpoints": return { title: "Touchpoints", value: num(s.touchpoints), counts: "Dated engagement records in this fiscal year: invitations, attendance, digital, content and other.", seg: true, cat: true, qtr: q => num(q.touchpoints),
      extra: [["Accounts touched", `${num(s.engagedAccounts)} of ${num(s.accounts)}`], ["Engaged contacts", num(s.engagedContacts)]], action: { label: "Open touchpoint records", run: "evidence", query: { title: "All touchpoints", kind: "touchpoint" } } };
    case "leads": return { title: "Actual leads", value: num(s.leads), counts: "Explicit lead records only. Roster membership, responses and scores are not leads.", seg: true, cat: true, qtr: q => `${num(q.leads)} (${num(q.hot)} Hot / ${num(q.warm)} Warm)`,
      extra: [["Hot", num(s.hot)], ["Warm", num(s.warm)]], action: { label: "Open lead records", run: "evidence", query: { title: "Actual leads", kind: "lead" } } };
    case "hot": return { title: "Hot leads", value: num(s.hot), counts: "Leads with a selected product and a purchase horizon of 3 months or less.", seg: true, cat: true, qtr: q => num(q.hot),
      extra: [["Of actual leads", num(s.leads)], ["Warm", num(s.warm)]], action: { label: "Open hot lead records", run: "evidence", query: { title: "Hot leads", kind: "hot" } } };
    case "opps": return { title: "Opportunities", value: num(s.opportunities), counts: "Actual opportunity records. A handoff or response is not an opportunity.", cat: true, qtr: q => num(q.opportunities),
      extra: [["Opportunity value", money(s.values)]], action: { label: "Open opportunity records", run: "evidence", query: { title: "Opportunities", kind: "opportunity" } } };
    case "oppValue": return { title: "Opportunity value", value: money(s.values), counts: "Total Order Value on explicit opportunity records, kept per currency and never converted.", cat: true, qtr: q => money(q.values),
      extra: [["Opportunities", num(s.opportunities)], ["Unpriced opportunities", num(d.quality.unpricedOpportunities)], ["Value without currency", num(d.quality.missingCurrency)]], action: { label: "Open opportunity records", run: "evidence", query: { title: "Opportunities", kind: "opportunity" } } };
    case "prospective": return { title: "Prospective ToV", value: money(s.prospectiveValues), counts: "Submitted Total Order Value on lead and prospective records, separately per currency. Not booked business and not an opportunity.", cat: true, qtr: q => money(q.prospectiveValues ?? {}),
      extra: [["Booked value (separate)", money(s.bookedValues)]], action: { label: "Open prospective-value records", run: "evidence", query: { title: "Prospective value source records", kind: "prospective_value" } } };
    case "booked": return { title: "Booked value", value: money(s.bookedValues), counts: "Value on explicit closed_won records only, per currency.", cat: true, qtr: q => money(q.bookedValues ?? {}),
      extra: [["Closed won", num(s.closedWon ?? 0)], ["Closed lost", num(s.closedLost ?? 0)]], action: { label: "Open closed-won records", run: "evidence", query: { title: "Closed won outcomes", kind: "closed_won" } } };
    case "won": return { title: "Closed won", value: num(s.closedWon ?? 0), counts: "Outcome records with an actual closed-won date.", cat: true, qtr: q => num(q.closedWon ?? 0),
      extra: [["Booked value", money(s.bookedValues)], ["Closed lost", num(s.closedLost ?? 0)]], action: { label: "Open closed-won records", run: "evidence", query: { title: "Closed won outcomes", kind: "closed_won" } } };
    case "lost": return { title: "Closed lost", value: num(s.closedLost ?? 0), counts: "Outcome records with an actual closed-lost date.", cat: true, qtr: q => num(q.closedLost ?? 0),
      extra: [["Closed won", num(s.closedWon ?? 0)]], action: { label: "Open closed-lost records", run: "evidence", query: { title: "Closed lost outcomes", kind: "closed_lost" } } };
    case "score": return { title: "Mean current intent score", value: s.contacts ? num(s.score) : "Unavailable", counts: "Mean of existing stored contact scores right now. It is a current snapshot, not fiscal-year activity, and not a lead count.",
      extra: [["Contacts scored", num(s.contacts)]], action: { label: "Open Scoring Logic", run: "scoring" } };
  }
}

export default function MetricSummaryDialog({ metric, data, onBack, onEvidence, onAccounts, onScoring }: {
  metric: MetricKey | null; data: HpBiDashboard; onBack: () => void;
  onEvidence: (q: EvidenceQuery, from: MetricKey) => void; onAccounts: (from: MetricKey) => void; onScoring: (from: MetricKey) => void;
}) {
  const def = metric ? define(metric, data) : null;
  const run = () => {
    if (!metric || !def) return;
    if (def.action.run === "accounts") onAccounts(metric);
    else if (def.action.run === "scoring") onScoring(metric);
    else if (def.action.query) onEvidence(def.action.query, metric);
  };
  return (
    <Dialog open={!!metric} onOpenChange={o => !o && onBack()}>
      <DialogContent className="max-w-2xl max-h-[88vh] overflow-y-auto" data-testid="dialog-metric-summary">
        {def && (
          <>
            <button type="button" data-testid="button-summary-back" onClick={onBack} className="self-start inline-flex items-center gap-1 text-xs font-semibold text-[#05628f] hover:underline"><ArrowLeft className="w-3.5 h-3.5" />Back to dashboard</button>
            <DialogHeader>
              <DialogTitle>{def.title} · FY {data.year}</DialogTitle>
              <DialogDescription>{def.counts}</DialogDescription>
            </DialogHeader>
            <div className="text-3xl font-semibold text-[#0B2A4A] tabular-nums" data-testid="text-summary-value" style={{ fontFamily: "'Barlow Semi Condensed', sans-serif" }}>{def.value}</div>
            <dl className="grid grid-cols-[1fr_auto] gap-y-1 text-xs">{def.extra.map(([k, v]) => <div key={k} className="contents"><dt className="text-[#5d7388]">{k}</dt><dd className="text-right tabular-nums font-medium">{v}</dd></div>)}</dl>
            {def.qtr && <section><h4 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#0B2A4A] border-b border-[#d5e0ea] pb-1 mb-1">By quarter</h4>
              <dl className="grid grid-cols-[1fr_auto] gap-y-0.5 text-xs">{data.quarters.map(q => <div key={q.label} className="contents"><dt className="text-[#5d7388]">{q.label}</dt><dd className="text-right tabular-nums">{q.isFuture && !def.qtr!(q).match(/[1-9]/) ? "Not yet started" : def.qtr!(q)}</dd></div>)}</dl></section>}
            {def.seg && <section><h4 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#0B2A4A] border-b border-[#d5e0ea] pb-1 mb-1">By GTM segment</h4>
              <ul className="text-xs space-y-0.5">{data.segments.map(x => <li key={x.name} className="flex justify-between gap-2"><span>{x.name}</span><span className="tabular-nums text-[#5d7388]">{num(x.accounts)} accts / {num(x.contacts)} contacts / {num(x.leads)} leads / {num(x.touchpoints)} tp</span></li>)}</ul>
              <h4 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#0B2A4A] border-b border-[#d5e0ea] pb-1 mb-1 mt-3">By RAD</h4>
              <ul className="text-xs space-y-0.5">{data.rads.map(x => <li key={x.name} className="flex justify-between gap-2"><span>{x.name}</span><span className="tabular-nums text-[#5d7388]">{num(x.accounts)} accts / {num(x.leads)} leads / {num(x.touchpoints)} tp</span></li>)}</ul></section>}
            {def.cat && metric && data.categories.length > 0 && <section><h4 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#0B2A4A] border-b border-[#d5e0ea] pb-1 mb-1">Category breakdown · up to six</h4>
              <ul className="text-xs space-y-0.5">{data.categories.slice(0, 6).map(c => <li key={c.name} className="flex justify-between gap-2"><span>{c.name}</span><span className="tabular-nums text-[#5d7388]">{categoryText(metric, c)}</span></li>)}</ul></section>}
            <button type="button" data-testid="button-summary-action" onClick={run} className="self-start rounded bg-[#0B2A4A] px-4 py-2 text-xs font-semibold text-white hover:bg-[#123b66]">{def.action.label}</button>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function categoryText(k: MetricKey, c: HpBiDashboard["categories"][number]): string {
  switch (k) {
    case "touchpoints": return `${num(c.touchpoints)} tp`;
    case "leads": return `${num(c.leads)} leads`;
    case "hot": return `${num(c.hot)} Hot`;
    case "opps": return `${num(c.opportunities)} opps`;
    case "oppValue": return moneyText(c.values);
    case "prospective": return moneyText(c.prospectiveValues ?? {});
    case "booked": return moneyText(c.bookedValues ?? {});
    case "won": return `${num(c.closedWon ?? 0)} won`;
    default: return `${num(c.closedLost ?? 0)} lost`;
  }
}
