import { ChevronLeft, ChevronRight, ArrowUpDown, ArrowUp, ArrowDown } from "lucide-react";
import { Fragment } from "react";
import type { HpBiDashboard, HpBiSortField } from "./types";
import { dateText, moneyText, num } from "./format";
import { Chip, Empty } from "./ui";
import { formatReportDate, formatReportDateTime } from "@/lib/reportTime";
import type { ContactMetric } from "./ContactActivity";

const columns: { label: string; field: HpBiSortField }[] = [
  { label: "Parent / account", field: "name" }, { label: "Routed journey", field: "journey" }, { label: "Segment", field: "segment" }, { label: "RAD", field: "rad" },
  { label: "Contacts", field: "contacts" }, { label: "Touch (FY)", field: "touchpoints" }, { label: "Leads (FY)", field: "leads" },
  { label: "Hot (FY)", field: "hot" }, { label: "Opps", field: "opportunities" }, { label: "Won", field: "closedWon" },
  { label: "Lost", field: "closedLost" }, { label: "ToV", field: "values" }, { label: "Booked", field: "bookedValues" },
  { label: "Journey score", field: "score" }, { label: "Last activity", field: "lastActivity" },
  { label: "Qualification", field: "status" },
];
const initialDirection = (field: HpBiSortField): "asc" | "desc" => ["name", "journey", "segment", "rad"].includes(field) ? "asc" : "desc";
const qualificationHelp = {
  status: "HP overall priority: freshness-adjusted forms (65%), journey behaviour (25%) and monitoring (10%). Hot requires at least 65 plus fresh explicit purchase evidence; Warm is at least 35, otherwise Cold. Historical fiscal lead totals do not change.",
  source: "Actual saved form types across this account's member accounts and response history. Both are shown when Lead Form and Event Feedback Form responses exist. This is provenance, not a qualification badge.",
};
export default function AccountsTable({ data, onOpen, onMetric, onPage, fetching, sortBy, sortDir = "desc", sortCurrency = "INR", onSort, onSortCurrency,qualification,onQualification }: {
  data: HpBiDashboard; onOpen: (parentKey: string) => void; onMetric?: (parentKey: string, metric: ContactMetric) => void;
  onPage: (p: number) => void; fetching: boolean; sortBy?: HpBiSortField; sortDir?: "asc" | "desc"; sortCurrency?: string;
  onSort?: (field: HpBiSortField | undefined, direction: "asc" | "desc") => void; onSortCurrency?: (currency: string) => void;
  qualification?: "Hot"|"Warm"|"Cold";onQualification?:(value:"Hot"|"Warm"|"Cold"|undefined)=>void;
}) {
  const pages = Math.max(1, Math.ceil(data.total / data.pageSize));
  const from = data.total === 0 ? 0 : (data.page - 1) * data.pageSize + 1;
  const to = Math.min(data.total, data.page * data.pageSize);
  const textSort = sortBy && ["name", "journey", "segment", "rad"].includes(sortBy);
  const flagSort = sortBy === "status" || sortBy === "gtmStatus";
  const moneySort = sortBy === "values" || sortBy === "bookedValues";
  const ascendingLabel = sortBy === "lastActivity" ? "Oldest first" : textSort ? "A to Z" : flagSort ? "Cold first" : "Smallest to largest";
  const descendingLabel = sortBy === "lastActivity" ? "Newest first" : textSort ? "Z to A" : flagSort ? "Hot first" : "Largest to smallest";
  const metricButton = (parentKey: string, id: number, metric: ContactMetric, label: string, value: number) => (
    <button type="button" data-testid={`account-metric-${id}-${metric}`}
      aria-label={`View ${label} contact-level details`} title={`View who contributed to ${label}`}
      className="rounded px-1 py-0.5 text-[#05628f] underline decoration-dotted hover:bg-[#d9eef9] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#0096D6]"
      onKeyDown={e => e.stopPropagation()}
      onClick={e => { e.stopPropagation(); onMetric ? onMetric(parentKey, metric) : onOpen(parentKey); }}>
      {num(value)}
    </button>
  );
  return (
    <div data-testid="table-accounts-wrap">
      <details className="mb-3 text-xs text-[#41586e]">
        <summary className="cursor-pointer font-medium">What do Qualification and GTM Source mean?</summary>
        <ul className="mt-2 space-y-1">
          <li><strong>Qualification:</strong> {qualificationHelp.status}</li>
          <li><strong>GTM source:</strong> {qualificationHelp.source}</li>
        </ul>
      </details>
      {onSort && <div className="flex flex-wrap items-center gap-3 pb-3 text-xs text-[#41586e]">
        {onQualification&&<label className="flex items-center gap-2">Qualification
          <select aria-label="Filter account table by qualification" value={qualification??""}
            onChange={event=>onQualification((event.target.value||undefined) as "Hot"|"Warm"|"Cold"|undefined)}
            className="h-8 min-w-[110px] rounded border border-[#c5d3df] bg-white px-2">
            <option value="">All</option><option value="Hot">Hot</option><option value="Warm">Warm</option><option value="Cold">Cold</option>
          </select>
        </label>}
        <label className="flex items-center gap-2">Sort by
          <select aria-label="Sort accounts by" data-testid="select-account-sort" value={sortBy ?? ""} className="rounded border border-[#d5e0ea] bg-white px-2 py-1.5"
            onChange={e => { const field = (e.target.value || undefined) as HpBiSortField | undefined; onSort(field, field ? initialDirection(field) : "desc"); }}>
            <option value="">Default: Hot leads, then touchpoints</option>
            {columns.map(c => <option key={c.field} value={c.field}>{c.label}</option>)}
            <option value="engagedContacts">Engaged contacts</option>
          </select>
        </label>
        <label className="flex items-center gap-2">Order
          <select aria-label="Account sort order" data-testid="select-account-sort-order" disabled={!sortBy} value={sortDir} className="rounded border border-[#d5e0ea] bg-white px-2 py-1.5 disabled:opacity-50"
            onChange={e => onSort(sortBy, e.target.value as "asc" | "desc")}>
            <option value="desc">{descendingLabel}</option><option value="asc">{ascendingLabel}</option>
          </select>
        </label>
        {moneySort && <label className="flex items-center gap-2">Currency
          <select aria-label="Currency for amount sorting" value={sortCurrency} className="rounded border border-[#d5e0ea] bg-white px-2 py-1.5"
            onChange={e => onSortCurrency?.(e.target.value)}>
            {[...new Set([sortCurrency, ...(data.sortCurrencies ?? [])])].sort().map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>}
        <span className="text-[11px] text-[#5d7388]">{qualification?`${qualification} accounts`:"All matching accounts"} · missing values last{moneySort ? ` · ${sortCurrency} amounts only; no currency conversion` : ""}{qualification?" · Table only; dashboard totals unchanged":""}</span>
      </div>}
      {data.accounts.length === 0 ? <Empty title="No accounts match" body="Loosen the filters. Accounts with no engagement stay listed while they match the segment, RAD and search." /> : (
        <div aria-busy={fetching} className={`overflow-x-auto transition-opacity ${fetching ? "opacity-60" : ""}`}>
          <table data-testid="table-accounts" className="w-full border-collapse border border-[#c5d3df] text-xs [&_th]:border [&_th]:border-[#c5d3df] [&_td]:border [&_td]:border-[#d5e0ea]">
            <thead className="sticky top-0 bg-[#f1f6fa]"><tr className="text-left text-[10.5px] uppercase tracking-wider text-[#5d7388]">
              {columns.map(({ label, field }) => <Fragment key={field}><th aria-sort={sortBy === field ? sortDir === "asc" ? "ascending" : "descending" : "none"} className={`py-2 px-2 ${["contacts", "touchpoints", "leads", "hot", "opportunities", "closedWon", "closedLost", "values", "bookedValues", "score"].includes(field) ? "text-right" : ""}`}>
                <button type="button" aria-label={`Sort by ${label}`} title={`Sort by ${label}${field === "values" || field === "bookedValues" ? ` (${sortCurrency})` : ""}`} disabled={!onSort}
                  data-testid={`sort-account-${field}`} className="inline-flex items-center gap-1 uppercase text-left hover:text-[#05628f] focus-visible:outline focus-visible:outline-2"
                  onClick={() => onSort?.(field, sortBy === field ? sortDir === "desc" ? "asc" : "desc" : initialDirection(field))}>
                  {label}{sortBy === field ? sortDir === "asc" ? <ArrowUp className="h-3 w-3 shrink-0" /> : <ArrowDown className="h-3 w-3 shrink-0" /> : <ArrowUpDown className="h-3 w-3 shrink-0 opacity-40" />}
                </button>
              </th>{field === "name" && <th className="py-2 px-2" data-testid="th-hp-sales-person"
                title="Current assignment emails supplied in the HP account roster, labelled by role. These are HP owners, not prospect contacts.">HP salesperson</th>}</Fragment>)}
            <th className="py-2 px-2">Account score</th>
            <th className="py-2 px-2" data-testid="th-gtm-source">GTM source</th></tr></thead>
            <tbody>
              {data.accounts.map(a => (
                <tr key={a.id} tabIndex={0} role="button" onClick={() => onOpen(a.parentKey)} onKeyDown={e => e.key === "Enter" && onOpen(a.parentKey)}
                  className="border-t border-[#e3ebf2] hover:bg-[#eaf6fc] cursor-pointer focus:outline-none focus:bg-[#eaf6fc]" data-testid={`row-account-${a.id}`}>
                  <td className="py-2 px-2 max-w-[260px]">
                    <div className="font-semibold text-[#0B2A4A] truncate">{a.parentName || a.name}</div>
                    <div className="text-[10.5px] text-[#5d7388] truncate">{a.name}{a.hpId ? ` / ${a.hpId}` : ""}{a.memberCount > 1 ? ` / ${a.memberCount} members` : ""}</div>
                    <MonitoredLine a={a} onOpen={() => onOpen(a.parentKey)} />
                    <div className="flex gap-1 mt-0.5">{a.isNew && <Chip tone="teal">New</Chip>}{a.touchpoints === 0 && <Chip>{(a.touchpointsAllDates??0)>0?`${a.touchpointsAllDates} touchpoints · all dates`:"No touchpoints in selected FY"}</Chip>}{!!a.missingFields?.length && <span title={a.missingFields.join(", ")}><Chip tone="amber">Needs completion{a.memberCount > 1 ? ` (${a.incompleteMembers})` : ""}</Chip></span>}</div>
                  </td>
                  <td className="px-2 py-2 min-w-[220px] max-w-[300px]" data-testid={`hp-sales-person-${a.id}`}>
                    <SalesPeople account={a} />
                  </td>
                  <td className="px-2 py-2 min-w-[170px] max-w-[260px]" data-testid={`account-journeys-${a.id}`}>
                    {a.journeys?.length ? a.journeys.map(j => <div key={j.id} className="font-medium text-[#0B2A4A] break-words">{j.name}</div>)
                      : <span className="text-[#5d7388]">{a.unavailableJourneyRoutes ? "Routed journey unavailable" : a.failedJourneyRoutes ? "Routing error" : a.pendingJourneyRoutes ? "Not routed yet" : "No routed journey"}</span>}
                    {!!a.pendingJourneyRoutes && <div className="text-[10.5px] text-[#5d7388]">{num(a.pendingJourneyRoutes)} response{a.pendingJourneyRoutes === 1 ? "" : "s"} not routed</div>}
                    {!!a.failedJourneyRoutes && <div className="text-[10.5px] text-amber-800">{num(a.failedJourneyRoutes)} routing error{a.failedJourneyRoutes === 1 ? "" : "s"}</div>}
                    {!!a.journeys?.length && !!a.unavailableJourneyRoutes && <div className="text-[10.5px] text-amber-800">Another routed journey is unavailable</div>}
                  </td>
                  <td className="px-2">{a.segment || "Unclassified"}</td><td className="px-2">{a.rad || "Unknown"}</td>
                  <td className="px-2 text-right tabular-nums">{metricButton(a.parentKey, a.id, "contacts", "all contacts", a.contacts)}<span className="text-[#8CA0B3]"> ({metricButton(a.parentKey, a.id, "engagedContacts", "engaged contacts", a.engagedContacts)})</span></td>
                  <td className="px-2 text-right tabular-nums">{metricButton(a.parentKey, a.id, "touchpoints", "touchpoints", a.touchpoints)}</td><td className="px-2 text-right tabular-nums">{metricButton(a.parentKey, a.id, "leads", "leads", a.leads)}</td>
                  <td className="px-2 text-right tabular-nums">{metricButton(a.parentKey, a.id, "hot", "Hot leads", a.hot)}</td>
                  <td className="px-2 text-right tabular-nums">{metricButton(a.parentKey, a.id, "opportunities", "opportunities", a.opportunities)}</td>
                  <td className="px-2 text-right tabular-nums">{metricButton(a.parentKey, a.id, "closedWon", "won outcomes", a.closedWon ?? 0)}</td>
                  <td className="px-2 text-right tabular-nums">{metricButton(a.parentKey, a.id, "closedLost", "lost outcomes", a.closedLost ?? 0)}</td>
                  <td className="px-2 text-right text-[11px] whitespace-nowrap">{moneyText(a.values)}</td>
                  <td className="px-2 text-right text-[11px] whitespace-nowrap" data-testid={`text-booked-account-${a.id}`}>{moneyText(a.bookedValues)}</td>
                  <td className="px-2 text-right tabular-nums font-semibold" title="Sum of current stored contact engagement points (uncapped)">{a.contacts ? num(a.score) : "—"}</td>
                  <td className="px-2 whitespace-nowrap">{dateText(a.lastActivity)}</td>
                  <td className="px-2 whitespace-nowrap" data-testid={`flag-status-${a.id}`} title={qualificationHelp.status}>
                    <span className={`inline-block rounded border px-2 py-0.5 text-[11px] font-bold ${a.status === "Hot" ? "border-red-300 bg-red-50 text-red-800" : a.status === "Warm" ? "border-amber-300 bg-amber-50 text-amber-800" : "border-slate-200 bg-slate-100 text-slate-600"}`}>{a.status ?? "Unqualified"}</span>
                  </td>
                  <td className="px-2 text-xs whitespace-nowrap" data-testid={`account-priority-${a.id}`}
                    title={a.priority ? `Forms ${a.priority.forms}/65 · Journey ${a.priority.journey}/25 · Monitoring ${a.priority.monitoring}/10. ${a.priority.routing.reason}` : "Not available"}>
                    {a.priority ? <><strong>{a.priority.score}/100</strong>
                      <div className="text-[10px] text-[#5d7388]">{a.priority.routing.status === "Not eligible" ? "" : `Routing: ${a.priority.routing.status}`}</div>
                      {a.priority.needsReconfirmation && <div className="text-[10px] text-amber-800">Needs reconfirmation</div>}
                    </> : "—"}
                  </td>
                  <td className="px-2 text-[11px] whitespace-nowrap" data-testid={`gtm-source-${a.id}`} title={qualificationHelp.source}>
                    {a.gtm?.formTypes?.length ? a.gtm.formTypes.map(type => <div key={type}>
                      {type === "lead_form" ? "Lead Form" : "Event Feedback Form"}
                    </div>) : <span className="text-[#5d7388]">No source response</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="flex items-center justify-between pt-3 text-xs text-[#41586e]">
        <span data-testid="text-pagination">Showing {num(from)}-{num(to)} of {num(data.total)} parent groups{fetching&&<span role="status" className="ml-2 text-[#05628f]">Loading accounts…</span>}</span>
        <div className="flex items-center gap-1">
          <button data-testid="button-prev-page" disabled={fetching||data.page <= 1} onClick={() => onPage(data.page - 1)} className="p-1 rounded border border-[#d5e0ea] disabled:opacity-40 hover:bg-[#eaf6fc]" aria-label="Previous page"><ChevronLeft className="w-4 h-4" /></button>
          <span className="px-2 tabular-nums">Page {data.page} / {pages}</span>
          <button data-testid="button-next-page" disabled={fetching||data.page >= pages} onClick={() => onPage(data.page + 1)} className="p-1 rounded border border-[#d5e0ea] disabled:opacity-40 hover:bg-[#eaf6fc]" aria-label="Next page"><ChevronRight className="w-4 h-4" /></button>
        </div>
      </div>
    </div>
  );
}

function SalesPeople({ account }: { account: HpBiDashboard["accounts"][number] }) {
  const people = account.salesPeople ?? [];
  if (!people.length) return <span className="text-[#5d7388]">Not assigned in roster</span>;
  const personDetails = (person: typeof people[number]) => <div key={`${person.role}:${person.email}`} className="mb-1 break-words">
    <div><strong>{person.role}:</strong> {person.email}</div>
    {account.memberCount > 1 && <div className="text-[10.5px] text-[#5d7388]"
      title={person.accounts.map(member=>`${member.name}${member.hpId ? ` / ${member.hpId}` : ""}`).join("; ")}>
      {person.accounts.slice(0,2).map(member=>member.name).join("; ")}
      {person.accounts.length>2&&` +${person.accounts.length-2} more member accounts`}
    </div>}
  </div>;
  return <>
    {people.slice(0,2).map(personDetails)}
    {people.length>2&&<details onClick={event=>event.stopPropagation()} onKeyDown={event=>event.stopPropagation()}>
      <summary className="cursor-pointer py-1 font-semibold text-[#05628f]">Show {people.length-2} more HP owners</summary>
      {people.slice(2).map(personDetails)}
    </details>}
  </>;
}

function MonitoredLine({ a, onOpen }: { a: HpBiDashboard["accounts"][number]; onOpen: () => void }) {
  const checked = a.monitoringCheckedMembers ?? 0, total = a.monitoringTotalMembers ?? a.memberCount;
  const partial = !!a.lastMonitoredAt && total > 1 && checked < total;
  const title = a.lastMonitoredAt
    ? `Latest monitoring completed ${formatReportDateTime(a.lastMonitoredAt)}${total > 1 ? ` (latest member date; ${checked} of ${total} members monitored)` : ""}`
    : "No completed monitoring for this account yet";
  return <div data-testid={`text-last-monitored-${a.id}`} title={title} className="text-[10.5px] text-[#5d7388]">
    {a.lastMonitoredAt ? <button type="button" aria-label={`View monitoring details for ${a.parentName || a.name}`}
      onClick={event => { event.stopPropagation(); onOpen(); }} onKeyDown={event => event.stopPropagation()}
      className="mb-1 block rounded border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 font-semibold text-emerald-800 underline underline-offset-2">
      Monitoring history available
    </button> : <span className="mb-1 block text-slate-500">No completed monitoring history</span>}
    {a.lastMonitoredAt && <>Latest check {formatReportDate(a.lastMonitoredAt)} · {checked}/{total} checked{partial && <span className="text-amber-800"> · Partial coverage</span>}</>}
    {!!a.monitoringOverdueMembers && <span className="text-amber-800"> · {a.monitoringOverdueMembers}/{total} overdue (7-day rule)</span>}
  </div>;
}
