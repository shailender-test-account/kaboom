import InboundSourceProvenance from "@/components/intent/InboundSourceProvenance";
import { useEffect, useMemo, useState } from "react";
import type { HpBiDetail, HpBiRecord } from "./types";
import { CONTRIBUTION_LABELS, matchesContribution, mergeContributionRecords } from "./contributions";
import type { Contribution } from "./contributions";
import ActivityEvidenceDialog from "./ActivityEvidenceDialog";
import type { ActivityInspection } from "./ActivityEvidenceDialog";
import { combineSourceRecords } from "./sourceEvidence";

export type ContactMetric = "contacts" | "engagedContacts" | "touchpoints" | "leads" | "hot" | "warm" | "opportunities" | "closedWon" | "closedLost";
export const CONTACT_METRIC_LABELS: Record<ContactMetric, string> = {
  contacts: "Contacts", engagedContacts: "Engaged contacts", touchpoints: "Touchpoints", leads: "Leads",
  hot: "Hot leads", warm: "Warm leads", opportunities: "Opportunities", closedWon: "Closed won", closedLost: "Closed lost",
};
const TOUCH = ["attendance", "invitation", "digital", "content", "other", "interest"];
const PAGE = 25;
const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");

export function isEligibleRecord(r: HpBiRecord, metric: ContactMetric): boolean {
  const k = norm(r.kind);
  switch (metric) {
    case "contacts": return true;
    case "touchpoints": return TOUCH.includes(k);
    case "engagedContacts": return TOUCH.includes(k) && r.contactId != null;
    case "leads": return k === "lead";
    case "hot": return k === "lead" && norm(r.status) === "hot";
    case "warm": return k === "lead" && norm(r.status) === "warm";
    case "opportunities": return k === "opportunity";
    case "closedWon": return k === "won" || k === "closed_won";
    case "closedLost": return k === "lost" || k === "closed_lost";
  }
}

export function actionLabel(r: Pick<HpBiRecord, "kind" | "status">): string {
  const k = norm(r.kind), s = norm(r.status);
  if(s==="telesales_contact")return "Telesales contact";
  if(s==="sales_rep_contact")return "Sales rep contact";
  if (["form_submit", "form_submitted", "form_submission"].includes(s)) return "Form submitted";
  if (k === "other" || k === "interest") return k === "interest" || s.includes("interest") ? "Product interest" : "Feedback response";
  if (k === "lead") return s === "hot" ? "Hot lead" : s === "warm" ? "Warm lead" : "Lead";
  if (k === "opportunity") return "Opportunity";
  if (k === "won" || k === "closed_won") return "Closed won";
  if (k === "lost" || k === "closed_lost") return "Closed lost";
  if (s.includes("open")) return "Email open (not a verified click)";
  if (s.includes("click") && s.includes("email")) return "Email link click";
  if (s.includes("page_view") || s.includes("pageview")) return "Page view";
  if (s.includes("cta")) return "CTA click";
  if (s.includes("form")) return "Form submitted";
  if (s.includes("call")) return "Call completed";
  if (s.includes("download")) return "Download";
  if (k === "invitation") return "Invitation";
  if (k === "attendance") return "Attendance";
  if (k === "content") return "Content engagement" + (s ? ` (${s.replace(/_/g, " ")})` : "");
  if (k === "digital") return "Digital activity" + (s ? ` (${s.replace(/_/g, " ")})` : "");
  return k.replace(/_/g, " ") || "Activity";
}

export function istText(s: string): string {
  const d = new Date(s);
  if (isNaN(d.getTime())) return "Invalid date";
  return `${d.toLocaleString("en-IN", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false, timeZone: "Asia/Kolkata" })} IST`;
}

const UNATTR = "unattributed", UNAVAIL = "unavailable";
const btn = "rounded border border-[#c5d3df] bg-white px-2.5 py-1 text-xs font-semibold text-[#0B2A4A] hover:bg-[#eef3f7] disabled:opacity-40";
const inp = "rounded border border-[#c5d3df] bg-white px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-[#0096D6]/40";

function Pager({ page, total, onPage, id }: { page: number; total: number; onPage: (p: number) => void; id: string }) {
  const pages = Math.max(1, Math.ceil(total / PAGE));
  return (
    <div className="flex items-center justify-between gap-2 pt-2 text-xs text-[#5d7388]" data-testid={`${id}-pager`}>
      <span>{total === 0 ? "0 rows" : `Rows ${page * PAGE + 1}-${Math.min(total, (page + 1) * PAGE)} of ${total}`}</span>
      <span className="flex items-center gap-2">
        <button type="button" className={btn} disabled={page <= 0} onClick={() => onPage(page - 1)} data-testid={`${id}-prev`}>Previous</button>
        <span>Page {page + 1} of {pages}</span>
        <button type="button" className={btn} disabled={page >= pages - 1} onClick={() => onPage(page + 1)} data-testid={`${id}-next`}>Next</button>
      </span>
    </div>
  );
}

interface Person { key: string; id: number | null; name: string; email: string; title: string; account: string; count: number; last: string | null; selectable: boolean; note?: string }

export default function ContactActivity({ detail, metric, year, contributionRecords }: { detail: HpBiDetail; metric: ContactMetric; year?: number; contributionRecords?: HpBiRecord[] }) {
  const [search, setSearch] = useState("");
  const [action, setAction] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [pPage, setPPage] = useState(0);
  const [rPage, setRPage] = useState(0);
  const [flag, setFlag] = useState<Contribution | "">("");
  const [separate, setSeparate] = useState(false);
  const [inspection, setInspection] = useState<ActivityInspection | null>(null);
  const timelineId = "contact-activity-records";
  const jump = () => document.querySelector(`[data-testid="${timelineId}"]`)?.scrollIntoView?.({ behavior: "smooth", block: "start" });
  const selectPerson = (key: string, evidence: Contribution | "" = flag) => {
    setSelected(key); setFlag(evidence); setAction(""); setRPage(0); jump();
  };
  useEffect(() => { setSelected(null); setFlag(""); setAction(""); setInspection(null); setPPage(0); setRPage(0); }, [metric, year, detail.account?.parentKey]);

  const accountName = useMemo(() => {
    const m = new Map(detail.members.map(x => [x.id, x.name]));
    return (id: number) => m.get(id) ?? "Unknown legal account";
  }, [detail]);
  const contactById = useMemo(() => new Map(detail.contacts.map(c => [c.id, c])), [detail]);
  const keyOf = (r: HpBiRecord) => r.contactId == null ? UNATTR : contactById.has(r.contactId) ? String(r.contactId) : UNAVAIL;

  const eligible = useMemo(() => detail.records.filter(r => isEligibleRecord(r, metric)), [detail, metric]);
  const context = useMemo(() => mergeContributionRecords(contributionRecords ?? detail.records, detail.formEvidence), [contributionRecords, detail.records, detail.formEvidence]);
  const flags: Contribution[] = ["forms", "hot", "warm"];
  const contributionsByContact = useMemo(() => {
    const byContact = new Map<number, Record<Contribution, number>>();
    for (const r of context) {
      if (r.contactId == null || !contactById.has(r.contactId)) continue;
      const counts = byContact.get(r.contactId) ?? { forms: 0, hot: 0, warm: 0 };
      for (const f of ["forms", "hot", "warm"] as Contribution[]) if (matchesContribution(r, f)) counts[f]++;
      byContact.set(r.contactId, counts);
    }
    return byContact;
  }, [context, contactById]);
  const flagCounts = (id: number | null) => id == null ? { forms: 0, hot: 0, warm: 0 } : contributionsByContact.get(id) ?? { forms: 0, hot: 0, warm: 0 };
  const contributorCounts = Object.fromEntries(flags.map(f => [f, [...contributionsByContact.values()].filter(c => c[f] > 0).length])) as Record<Contribution, number>;
  const evidenceRecords = useMemo(() => flag ? context.filter(r => matchesContribution(r, flag)) : eligible, [context, eligible, flag]);
  const actions = useMemo(() => [...new Set(evidenceRecords.map(actionLabel))].sort(), [evidenceRecords]);
  const actionOk = (r: HpBiRecord) => !action || actionLabel(r) === action;
  const actionRecords = useMemo(() => evidenceRecords.filter(actionOk), [evidenceRecords, action]); // eslint-disable-line react-hooks/exhaustive-deps

  const people = useMemo(() => {
    const agg = new Map<string, { count: number; last: string | null }>();
    for (const r of actionRecords) {
      const k = keyOf(r), a = agg.get(k) ?? { count: 0, last: null };
      a.count++; if (!a.last || r.occurredAt > a.last) a.last = r.occurredAt;
      agg.set(k, a);
    }
    const out: Person[] = [];
    for (const c of detail.contacts) {
      const a = agg.get(String(c.id));
      if (!a && (metric !== "contacts" || flag)) continue;
      out.push({ key: String(c.id), id: c.id, name: c.name, email: c.email ?? "No email", title: c.title ?? "Title unknown", account: accountName(c.companyId), count: a?.count ?? 0, last: a?.last ?? null, selectable: true });
    }
    for (const [key, name, note] of [[UNATTR, "Account-level, no contact identified", "No person is attributed to these records."], [UNAVAIL, "Contact unavailable (deleted or out of scope)", "The linked contact record cannot be shown."]]) {
      const a = agg.get(key);
      if (a) out.push({ key, id: null, name, email: "Not available", title: "Not available", account: "Various legal accounts", count: a.count, last: a.last, selectable: true, note });
    }
    const q = search.trim().toLowerCase();
    return out.filter(p => !q || p.name.toLowerCase().includes(q) || p.email.toLowerCase().includes(q))
      .sort((a, b) => (b.last ?? "").localeCompare(a.last ?? "") || a.name.localeCompare(b.name));
  }, [detail, actionRecords, metric, search, accountName, flag]); // eslint-disable-line react-hooks/exhaustive-deps

  const visibleKeys = useMemo(() => new Set(people.map(p => p.key)), [people]);
  const timeline = useMemo(() => actionRecords
    .filter(r => selected ? keyOf(r) === selected : visibleKeys.has(keyOf(r)))
    .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt) || a.id.localeCompare(b.id)),
  [actionRecords, selected, visibleKeys]); // eslint-disable-line react-hooks/exhaustive-deps

  const selectedPerson = selected ? people.find(p => p.key === selected) ?? null : null;
  const distinct = new Set(eligible.filter(r => r.contactId != null && contactById.has(r.contactId)).map(r => r.contactId)).size;
  const displayedTimeline = separate ? timeline : combineSourceRecords(timeline);
  const pageP = Math.min(pPage, Math.max(0, Math.ceil(people.length / PAGE) - 1));
  const pageR = Math.min(rPage, Math.max(0, Math.ceil(displayedTimeline.length / PAGE) - 1));
  const label = CONTACT_METRIC_LABELS[metric];
  const who = (r: HpBiRecord) => { const k = keyOf(r); return k === UNATTR ? "Account-level (no contact)" : k === UNAVAIL ? "Contact unavailable" : contactById.get(r.contactId!)!.name; };
  const evidenceLink = "text-[#05628f] hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#0096D6] text-left";

  return (
    <section className="space-y-3 text-[#10243B]" data-testid="contact-activity" aria-label={`${label} contact activity`}>
      <header>
        <h3 className="text-base font-semibold text-[#0B2A4A]" style={{ fontFamily: "'Barlow Semi Condensed', sans-serif" }}>{label}: contact evidence{year ? ` · FY${year}` : ""}</h3>
        <p className="text-xs text-[#41586e] mt-1" data-testid="contact-activity-summary">
          <button type="button" className={evidenceLink} onClick={() => { setFlag(""); setAction(""); setSelected(null); setSearch(""); setRPage(0); jump(); }}>{eligible.length} source record{eligible.length === 1 ? "" : "s"}</button>{" from "}
          <button type="button" className={evidenceLink} onClick={() => { setFlag(""); setSelected(null); setAction(""); setSearch(""); setPPage(0); }}>{distinct} distinct identified {distinct === 1 ? "person" : "people"}</button>. Record counts can exceed people because one person can have many records, and duplicate uploads remain visible as separate records. Times are shown in IST (Asia/Kolkata). Email opens are not verified human clicks.
        </p>
      </header>
      <div className="rounded border border-[#d5e0ea] bg-[#f6f9fb] p-2 space-y-2" data-testid="contact-contribution-summary">
        <p className="text-xs">Among {detail.contacts.length} contacts in account scope, in the selected reporting period:</p>
        <div className="flex flex-wrap gap-2">
          {flags.map(f => <button type="button" key={f} className={btn} aria-pressed={flag === f} data-testid={`contribution-filter-${f}`}
            onClick={() => { setFlag(f); setSelected(null); setAction(""); setSearch(""); setPPage(0); setRPage(0); }}>
            {contributorCounts[f]} {f === "forms" ? "form contributors" : `${CONTRIBUTION_LABELS[f]} contributors`}
          </button>)}
          <button type="button" className={btn} disabled={!flag} onClick={() => { setFlag(""); setAction(""); setSelected(null); setRPage(0); setPPage(0); }} data-testid="contribution-reset">Back to {label.toLowerCase()}</button>
        </div>
        <p className="text-[10.5px] text-[#5d7388]">Flags use attributable source evidence, not engagement scores. Hot/Warm are per lead response; a person can have both. Unknown or deleted contacts are not included in contributor counts.</p>
        {flag && <p className="text-xs font-semibold" role="status">Showing {CONTRIBUTION_LABELS[flag].toLowerCase()} evidence for this period. The selected metric totals above are unchanged.</p>}
      </div>
      <div className="flex flex-wrap gap-2 items-center">
        <input type="search" className={`${inp} min-w-[200px] flex-1`} placeholder="Search person or email" aria-label="Search person or email" value={search}
          onChange={e => { setSearch(e.target.value); setPPage(0); setRPage(0); }} data-testid="contact-activity-search" />
        <select className={inp} aria-label="Filter by action" value={action} onChange={e => { setAction(e.target.value); setPPage(0); setRPage(0); }} data-testid="contact-activity-action">
          <option value="">All actions</option>
          {actions.map(a => <option key={a} value={a}>{a}</option>)}
        </select>
        <button type="button" className={btn} disabled={!selected} onClick={() => { setSelected(null); setRPage(0); }} data-testid="contact-activity-all-people">All people</button>
      </div>

      <div className="rounded border border-[#d5e0ea] bg-white overflow-x-auto" data-testid="contact-activity-people">
        <p className="px-2 pt-2 text-[10.5px] text-[#5d7388] sm:hidden">Swipe the table horizontally for record counts and last activity.</p>
        <table className="w-full text-xs">
          <caption className="sr-only">People</caption>
          <thead><tr className="text-left text-[10.5px] uppercase tracking-wider text-[#5d7388] bg-[#f6f9fb]">
            <th className="p-2">Person / contributor flags</th><th className="p-2">Email / title</th><th className="p-2">Legal account</th><th className="p-2 text-right">Records</th><th className="p-2">Last activity (IST)</th></tr></thead>
          <tbody>
            {people.length === 0 && <tr><td colSpan={5} className="p-4 text-center text-[#5d7388]" data-testid="contact-activity-people-empty">No people match these filters for {label.toLowerCase()}.</td></tr>}
            {people.slice(pageP * PAGE, pageP * PAGE + PAGE).map(p => (
              <tr key={p.key} className={`border-t border-[#e3ebf2] ${selected === p.key ? "bg-[#e6f4fb]" : ""}`}>
                <td className="p-2 font-medium">
                  <button type="button" aria-pressed={selected === p.key} className="text-left text-[#05628f] hover:underline" data-testid={`contact-activity-person-${p.key}`}
                    onClick={() => selectPerson(p.key)}>{p.name}</button>
                  <div className="flex flex-wrap gap-1 mt-1">{flags.filter(f => flagCounts(p.id)[f] > 0).map(f =>
                    <button type="button" key={f} data-testid={`person-flag-${p.key}-${f}`} onClick={() => selectPerson(p.key, f)}
                      className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold ${f === "hot" ? "border-red-200 bg-red-50 text-red-800" : f === "warm" ? "border-amber-200 bg-amber-50 text-amber-800" : "border-sky-200 bg-sky-50 text-sky-800"}`}
                      title={`Show ${CONTRIBUTION_LABELS[f].toLowerCase()} source evidence for ${p.name}`}>{CONTRIBUTION_LABELS[f]}</button>)}</div>
                  {p.note && <div className="text-[10.5px] font-normal text-[#5d7388]">{p.note}</div>}
                </td>
                <td className="p-2">{p.id != null ? <button type="button" className={evidenceLink} onClick={() => setInspection({ person: contactById.get(p.id!)! })}><div>{p.email}</div><div className="text-[#5d7388]">{p.title}</div></button> : <><div>{p.email}</div><div>{p.title}</div></>}</td>
                <td className="p-2">{p.id != null ? <button type="button" className={evidenceLink} onClick={() => setInspection({ accountId: contactById.get(p.id!)!.companyId })}>{p.account}</button> : p.account}</td>
                <td className="p-2 text-right tabular-nums"><button type="button" className={evidenceLink} aria-label={`${p.count} records for ${p.name}`} onClick={() => selectPerson(p.key)}>{p.count}</button></td>
                <td className="p-2 tabular-nums">{p.last ? <button type="button" className={evidenceLink} onClick={() => {
                  const latest = actionRecords.filter(r => keyOf(r) === p.key).sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))[0];
                  if (latest) setInspection({ record: latest });
                }}>{istText(p.last)}</button> : "No matching activity"}</td>
              </tr>))}
          </tbody>
        </table>
        <div className="px-2 pb-2"><Pager id="contact-activity-people-page" page={pageP} total={people.length} onPage={setPPage} /></div>
      </div>

      <div className="rounded border border-[#d5e0ea] bg-white p-2" data-testid="contact-activity-records">
        <h4 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#0B2A4A] border-b border-[#d5e0ea] pb-1 mb-2" data-testid="contact-activity-timeline-title">
          Source timeline, newest first{selectedPerson ? ` · ${selectedPerson.name}` : " · all people"} ({timeline.length})
        </h4>
        <label className="flex items-center gap-2 mb-2 text-xs"><input type="checkbox" checked={separate} onChange={e => { setSeparate(e.target.checked); setRPage(0); }} />Show each source record separately</label>
        {displayedTimeline.length !== timeline.length && <p className="mb-2 text-xs text-[#5d7388]">Activity and qualified lead from the same questionnaire are shown together. {timeline.length} source records in {displayedTimeline.length} entries; metric totals are unchanged.</p>}
        {timeline.length === 0 ? <p className="text-xs text-[#5d7388] p-3" data-testid="contact-activity-records-empty">No source records match these filters.</p> : (
          <ul className="divide-y divide-[#e3ebf2] text-xs">
            {displayedTimeline.slice(pageR * PAGE, pageR * PAGE + PAGE).map(r => (
              <li key={r.id} className="py-2 grid gap-x-3 gap-y-0.5 sm:grid-cols-[210px_1fr]" data-testid={`contact-activity-record-${r.id}`}>
                <button type="button" className={`${evidenceLink} tabular-nums font-medium self-start`} onClick={() => setInspection({ record: r })}><time dateTime={r.occurredAt}>{istText(r.occurredAt)}</time></button>
                <div className="min-w-0">
                  <button type="button" className={evidenceLink} data-testid={`inspect-record-${r.id}`} onClick={() => setInspection({ record: r })}><strong>{actionLabel(r)}</strong> · {who(r)} · {accountName(r.accountId)}</button>
                  <button type="button" className={`${evidenceLink} block`} onClick={() => setInspection({ record: r })}>Product/category: {[r.product, r.category].filter(Boolean).join(" / ") || "Not provided"} · {r.horizonMonths == null ? "Purchase timeframe not provided" : `${r.horizonMonths} months`}</button>
                  <button type="button" className={`${evidenceLink} block`} onClick={() => setInspection({ record: r })}>Page/program: {r.sourceName || "Not provided"} · Source: {r.source}</button>
                  <button type="button" className={`${evidenceLink} block text-[10.5px] font-mono break-all`} onClick={() => setInspection({ record: r })}>Source ID: {r.externalEventId ?? r.id}{r.externalEventId ? ` · Record ${r.id}` : ""}</button>
                  <InboundSourceProvenance provenance={r.provenance} />
                  {r.relatedRecords?.map(source => <button key={source.id} type="button" className={`${evidenceLink} block mt-1`} onClick={() => setInspection({ record: source })}>Same submission: questionnaire activity · view record {source.id}</button>)}
                </div>
              </li>))}
          </ul>)}
        <Pager id="contact-activity-records-page" page={pageR} total={displayedTimeline.length} onPage={setRPage} />
      </div>
      <ActivityEvidenceDialog value={inspection} detail={detail} onClose={() => setInspection(null)} dateText={istText} />
    </section>
  );
}
