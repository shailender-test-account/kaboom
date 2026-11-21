import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Download, ArrowLeft } from "lucide-react";
import { hpPivotQuery, useHpParentPivot } from "./api";
import type { HpBiFilters } from "./types";
import type { HpPivotInput, PivotBreakdown, PivotMetric, PivotMetrics, PivotPortfolio } from "./pivot-types";
import { HP_DIMENSIONS, RADS, SEGMENT_VIEWS, GOV_EDU, dateText, download, money, nf } from "./format";
import { ErrorBox, Panel, Skel } from "./ui";
import ParentPicker from "./ParentPicker";
import SavedParentViews from "./SavedParentViews";
import { initialPivotDraft, resolvePivotDates, pivotViewConfig, reopenPivotView, type PivotDraft } from "./pivot-views";

const METRICS: [PivotMetric, string, boolean][] = [["touchpoints", "Touchpoints", false], ["engagedContacts", "Distinct engaged contacts", false],
  ["leads", "Leads", false], ["hot", "Hot leads", false], ["warm", "Warm leads", false], ["opportunities", "Opportunities", false],
  ["closedWon", "Closed won", false], ["closedLost", "Closed lost", false], ["opportunityValue", "Opportunity value", true],
  ["prospectiveValue", "Prospective value", true], ["bookedValue", "Booked value", true]];
const BREAKDOWNS: [PivotBreakdown, string][] = [["total", "Total"], ["segment", "Segment"], ["portfolio", "PS / Print portfolio"],
  ["segment_portfolio", "Segment and portfolio"], ["rad", "RAD"]];
const PORTFOLIOS: PivotPortfolio[] = ["PS", "Print", "Unassigned"];
const SEGMENTS = [...SEGMENT_VIEWS.filter(s => s !== "Overall"), GOV_EDU];
const iso = (d: Date) => d.toISOString().slice(0, 10);
const valid = (s: string) => /^(20\d{2}|2100)-\d{2}-\d{2}$/.test(s) && Number.isFinite(Date.parse(`${s}T00:00:00Z`)) && iso(new Date(`${s}T00:00:00Z`)) === s;
function rangeError(label: string, s: string, e: string) {
  if (!valid(s) || !valid(e)) return `${label}: enter a valid start and end date.`;
  if (s > e) return `${label}: start date is after end date.`;
  const lim = new Date(`${s}T00:00:00Z`); lim.setUTCFullYear(lim.getUTCFullYear() + 3);
  if (new Date(`${e}T00:00:00Z`) >= lim) return `${label}: range cannot exceed 3 years.`;
  return null;
}
const isMoney = (m: PivotMetric) => METRICS.find(x => x[0] === m)![2];
const mval = (m: PivotMetrics, k: PivotMetric) => m[k];
const positive = (v: number | Record<string, number>) => typeof v === "number" ? v > 0 : Object.keys(v).length > 0;
const fmtMoney = (r: Record<string, number>) => { const e = Object.entries(r); return e.length ? e.map(([c, v]) => /^[A-Z]{3}$/.test(c) ? money(c, v) : `${c} ${nf.format(v)}`) : []; };
function Val({ v }: { v: number | Record<string, number> }) {
  if (typeof v === "number") return <>{nf.format(v)}</>;
  const l = fmtMoney(v); return l.length ? <>{l.map(x => <span key={x} className="block">{x}</span>)}</> : <span className="text-[#8CA0B3]">None</span>;
}
function Change({ c, p }: { c: number | Record<string, number>; p: number | Record<string, number> }) {
  if (typeof c === "number" && typeof p === "number") {
    const d = c - p; return <>{d > 0 ? "+" : ""}{nf.format(d)}{p > 0 ? <span className="block text-[10px] text-[#5d7388]">{(d / p * 100).toFixed(1)}%</span> : <span className="block text-[10px] text-[#5d7388]">{c === 0 ? "No activity" : "New activity"}</span>}</>;
  }
  const cr = c as Record<string, number>, pr = p as Record<string, number>;
  const cur = [...new Set([...Object.keys(cr), ...Object.keys(pr)])];
  if (!cur.length) return <span className="text-[#8CA0B3]">None</span>;
  return <>{cur.map(k => { const d = (cr[k] ?? 0) - (pr[k] ?? 0); return <span key={k} className="block">{(d > 0 ? "+" : "") + (/^[A-Z]{3}$/.test(k) ? money(k, d) : `${k} ${nf.format(d)}`)}</span>; })}</>;
}
const radText = (r: Record<string, number>) => { const e = Object.entries(r); return e.length ? e.map(([k, v]) => `${k} ${nf.format(v)}`).join(", ") : "None supplied"; };
const inp = "rounded border border-[#c5d3df] bg-white px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-[#0096D6]/40";
const btn = "rounded px-3 py-1.5 text-xs font-semibold";

type Draft = PivotDraft;
const initial = initialPivotDraft;
const toggle = <T,>(a: T[], v: T) => a.includes(v) ? a.filter(x => x !== v) : [...a, v];

export default function ParentComparison({ filters, onBack }: { filters: HpBiFilters; onBack: () => void }) {
  return <ScopedParentComparison key={filters.clientId} filters={filters} onBack={onBack} />;
}
function ScopedParentComparison({ filters, onBack }: { filters: HpBiFilters; onBack: () => void }) {
  const cache = useQueryClient();
  const [draft, setDraft] = useState<Draft>(initial);
  const [applied, setApplied] = useState<Draft>(initial);
  const [page, setPage] = useState(1);
  const [focus, setFocus] = useState<{ parent: string; column: string; period: "current" | "previous" } | null>(null);
  const [evPage, setEvPage] = useState(1);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft(d => ({ ...d, [k]: v }));

  const errors = [rangeError("Current period", draft.cs, draft.ce), rangeError("Previous period", draft.ps, draft.pe)].filter(Boolean) as string[];
  const inherited = useMemo(() => ({ clientId: filters.clientId, search: filters.search, newOnly: filters.newOnly, abmOnly: filters.abmOnly,
    incompleteOnly: filters.incompleteOnly, dimension: filters.dimension, dimensionValue: filters.dimensionValue,
    salesPerson: filters.salesPerson, opportunity: filters.opportunity }),
    [filters.clientId, filters.search, filters.newOnly, filters.abmOnly, filters.incompleteOnly, filters.dimension, filters.dimensionValue, filters.salesPerson, filters.opportunity]);
  const base: HpPivotInput = useMemo(() => ({ ...inherited, currentStart: applied.cs, currentEnd: applied.ce, previousStart: applied.ps, previousEnd: applied.pe,
    parents: applied.parents, segments: applied.segments, portfolios: applied.portfolios, rads: applied.rads, basis: applied.basis, breakdown: applied.breakdown }), [inherited, applied]);
  const pivotInput = useMemo<HpPivotInput>(() => ({ ...base, page, pageSize: 25 }), [base, page]);
  const evInput = useMemo<HpPivotInput>(() => ({ ...pivotInput, focusParent: focus?.parent, focusColumn: focus?.column, focusPeriod: focus?.period,
    focusMetric: applied.metric, evidencePage: evPage }), [pivotInput, focus, applied.metric, evPage]);
  const q = useHpParentPivot(pivotInput, true);
  const ev = useHpParentPivot(evInput, !!focus);
  const data = q.data;

  const names = useMemo(() => { const m = new Map<string, string>(); data?.options.parents.forEach(p => m.set(p.key, p.name)); data?.rows.forEach(r => m.set(r.parentKey, r.parentName)); return m; }, [data]);
  const [known, setKnown] = useState<Map<string, string>>(new Map());
  const allNames = useMemo(() => new Map([...known, ...names]), [known, names]);
  const apply = () => { if (errors.length) return; setKnown(allNames); setApplied(draft); setPage(1); setFocus(null); setEvPage(1); };
  const reset = () => { const d = initial(); setDraft(d); setApplied(d); setPage(1); setFocus(null); };
  const preset = (kind: "fy" | "cal") => setDraft(d => ({ ...d, ...resolvePivotDates(kind), datePolicy: kind }));
  const exportCsv = () => download(`/api/analytics/hp-bi/pivot?${hpPivotQuery(base)}&format=csv`);
  const metric = applied.metric;
  const mLabel = METRICS.find(m => m[0] === metric)![1];
  const open = (parent: string, column: string, period: "current" | "previous") => { setEvPage(1); setFocus({ parent, column, period }); };
  const ignoredNote = filters.segment || filters.rad || filters.basis;
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const dateField = (id: string, label: string, k: "cs" | "ce" | "ps" | "pe") => (
    <label className="flex flex-col gap-1 text-[11px] font-semibold text-[#41586e]">{label}
      <input id={id} data-testid={id} type="date" className={inp} value={draft[k]} onChange={e => setDraft(d => ({ ...d, [k]: e.target.value, datePolicy: "custom" }))} aria-invalid={errors.length > 0} /></label>);
  const checkRow = <T extends string>(label: string, vals: readonly T[], sel: T[], key: (v: T) => string, on: (v: T) => void) => (
    <fieldset className="min-w-0"><legend className="mb-1 text-xs font-semibold text-[#41586e]">{label}</legend>
      <div className="flex flex-wrap gap-x-3 gap-y-1">{vals.map(v => <label key={v} className="flex items-center gap-1 text-xs">
        <input id={key(v)} data-testid={key(v)} type="checkbox" checked={sel.includes(v)} onChange={() => on(v)} />{v}</label>)}</div></fieldset>);

  if (focus) {
    const e = ev.data?.evidence; const col = data?.columns.find(c => c.key === focus.column);
    const epages = e ? Math.max(1, Math.ceil(e.total / e.pageSize)) : 1;
    return (
      <div data-testid="pivot-evidence" className="space-y-3">
        <button type="button" data-testid="pivot-evidence-back" onClick={() => setFocus(null)} className="inline-flex items-center gap-1 text-xs font-semibold text-[#05628f] hover:underline"><ArrowLeft className="h-3.5 w-3.5" />Back to pivot</button>
        <Panel title={`Evidence: ${allNames.get(focus.parent) ?? focus.parent}`} note={`${mLabel}, ${col?.label ?? focus.column}, ${focus.period} period`}
          right={<span className="text-xs tabular-nums" data-testid="pivot-evidence-total">{e ? `${e.total.toLocaleString("en-IN")} source records` : "Loading"}</span>}>
          {ev.isLoading && <Skel className="h-40" />}
          {ev.isError && <ErrorBox message={(ev.error as Error).message} onRetry={() => ev.refetch()} />}
          {ev.data && !e && <p className="p-4 text-sm text-[#41586e]">The server returned no evidence for this cell.</p>}
          {e && e.records.length === 0 && <p className="p-4 text-sm text-[#41586e]">No source records for this cell.</p>}
          {e && e.records.length > 0 && <div className="overflow-x-auto"><table className="w-full text-xs"><thead><tr className="border-b border-[#c5d3df] text-left text-[#41586e]">
            {["Date", "Account", "Kind", "Product", "Value", "Source"].map(h => <th key={h} scope="col" className="px-2 py-1.5">{h}</th>)}</tr></thead>
            <tbody>{e.records.map(r => <tr key={r.id} className="border-b border-[#e3ebf2]"><td className="px-2 py-1.5 whitespace-nowrap">{dateText(r.occurredAt)}</td><td className="px-2 py-1.5">{r.accountName}</td>
              <td className="px-2 py-1.5">{r.kind}</td><td className="px-2 py-1.5">{r.product ?? "Not tagged"}</td>
              <td className="px-2 py-1.5 tabular-nums">{r.orderValue != null ? (r.currency ? money(r.currency, r.orderValue) : nf.format(r.orderValue)) : "None"}</td>
              <td className="px-2 py-1.5">{r.sourceName ?? r.source}</td></tr>)}</tbody></table></div>}
          <p className="mt-2 text-[11px] text-[#5d7388]">Source rows are records, not distinct people; engaged-contact counts deduplicate people and can be lower.</p>
          {e && <div className="mt-2 flex items-center gap-2 text-xs"><button className={`${btn} border border-[#c5d3df] disabled:opacity-40`} disabled={evPage <= 1} onClick={() => setEvPage(p => p - 1)}>Previous</button>
            <span className="tabular-nums">Page {e.page} of {epages}</span><button className={`${btn} border border-[#c5d3df] disabled:opacity-40`} disabled={evPage >= epages} onClick={() => setEvPage(p => p + 1)}>Next</button></div>}
        </Panel>
      </div>
    );
  }

  const cols = data?.columns ?? [];
  return (
    <div data-testid="parent-comparison" className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" data-testid="pivot-back" onClick={onBack} className="inline-flex items-center gap-1 text-xs font-semibold text-[#05628f] hover:underline"><ArrowLeft className="h-3.5 w-3.5" />Back to dashboard</button>
        <p className="text-[11px] text-[#41586e]" data-testid="pivot-inherited">Inherited from dashboard: {[filters.search && `search "${filters.search}"`, filters.newOnly && "new only", filters.abmOnly && "ABM only",
          filters.incompleteOnly && "needs completion", filters.dimension && filters.dimensionValue && `${HP_DIMENSIONS[filters.dimension] ?? filters.dimension} = ${filters.dimensionValue}`].filter(Boolean).join(", ") || "no extra scope"}.
          {ignoredNote ? " Dashboard segment, RAD and basis are replaced by the filters below." : ""}</p>
      </div>
      <Panel title="Compare parent groups" note="Activity is attributable first-party records by India date. Planning context is supplied and shown separately; it creates no leads.">
        <SavedParentViews clientId={filters.clientId} config={pivotViewConfig(draft)} valid={errors.length === 0} onOpen={view => {
          const next = reopenPivotView(view.config);
          // Even reopening identical filters must query current evidence, not reuse old results.
          cache.removeQueries({ queryKey: ["hp-parent-pivot"], type: "inactive" });
          cache.invalidateQueries({ queryKey: ["hp-parent-pivot"] });
          setDraft(next); setApplied(next); setPage(1); setFocus(null); setEvPage(1);
        }} />
        <form onSubmit={e => { e.preventDefault(); apply(); }} className="space-y-3">
          <div className="flex flex-wrap items-end gap-3">
            {dateField("pivot-current-start", "Current start", "cs")}{dateField("pivot-current-end", "Current end", "ce")}
            {dateField("pivot-previous-start", "Previous start", "ps")}{dateField("pivot-previous-end", "Previous end", "pe")}
            <button type="button" className={`${btn} border border-[#c5d3df]`} data-testid="pivot-preset-fy" onClick={() => preset("fy")}>Fiscal years</button>
            <button type="button" className={`${btn} border border-[#c5d3df]`} data-testid="pivot-preset-cal" onClick={() => preset("cal")}>Calendar years</button>
          </div>
          <p data-testid="pivot-date-policy" className="text-[11px] text-[#41586e]">
            {draft.datePolicy === "custom" ? "Fixed custom dates. Saved views keep these exact dates." :
              `${draft.datePolicy === "fy" ? "Relative fiscal years (November–October)" : "Relative calendar years (January–December)"}. Reopening resolves current and previous full years using today's India date.`}
            {` Current: ${draft.cs} to ${draft.ce}; previous: ${draft.ps} to ${draft.pe}.`}
          </p>
          {errors.length > 0 && <ul role="alert" className="text-xs text-[#b3261e]" data-testid="pivot-errors">{errors.map(m => <li key={m}>{m}</li>)}</ul>}
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <ParentPicker options={data?.options.parents ?? []} selected={draft.parents} names={allNames} onChange={p => set("parents", p)} />
            <div className="space-y-3">
              {checkRow("GCC / segment", [...new Set([...SEGMENTS, ...(data?.options.segments ?? [])])], draft.segments, v => `pivot-segment-${v}`, v => set("segments", toggle(draft.segments, v)))}
              {checkRow("PS / Print portfolio", PORTFOLIOS, draft.portfolios, v => `pivot-portfolio-${v}`, v => set("portfolios", toggle(draft.portfolios, v)))}
            </div>
            <div className="space-y-3">
              <label className="flex flex-col gap-1 text-[11px] font-semibold text-[#41586e]">RAD planning lens
                <select data-testid="pivot-rad-basis" className={inp} value={draft.basis} onChange={e => set("basis", e.target.value as "PS" | "Print")}><option value="PS">PS RAD</option><option value="Print">Print RAD</option></select></label>
              {checkRow("RAD (current planning)", [...RADS, "Unknown"], draft.rads, v => `pivot-rad-${v}`, v => set("rads", toggle(draft.rads, v)))}
              <p className="text-[11px] text-[#5d7388]">Values within a filter match any; different filters must all match.</p>
            </div>
            <div className="flex flex-col gap-2">
              <label className="flex flex-col gap-1 text-[11px] font-semibold text-[#41586e]">Metric
                <select id="pivot-metric" data-testid="pivot-metric" className={inp} value={draft.metric} onChange={e => set("metric", e.target.value as PivotMetric)}>
                  {METRICS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
              <label className="flex flex-col gap-1 text-[11px] font-semibold text-[#41586e]">Column breakdown
                <select id="pivot-breakdown" data-testid="pivot-breakdown" className={inp} value={draft.breakdown} onChange={e => set("breakdown", e.target.value as PivotBreakdown)}>
                  {BREAKDOWNS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
              <div className="flex gap-2"><button type="submit" data-testid="pivot-apply" disabled={errors.length > 0} className={`${btn} bg-[#0096D6] text-white disabled:opacity-40`}>Apply</button>
                <button type="button" data-testid="pivot-reset" onClick={reset} className={`${btn} border border-[#c5d3df]`}>Reset</button>
                <button type="button" data-testid="pivot-export" onClick={exportCsv} className={`${btn} inline-flex items-center gap-1 bg-[#0B2A4A] text-white`}><Download className="h-3.5 w-3.5" />Export CSV</button></div>
              <p className="text-[11px] text-[#5d7388]">Export includes all matching parents for the applied filters.</p>
            </div>
          </div>
        </form>
      </Panel>

      {q.isLoading && <div data-testid="pivot-loading" className="space-y-2"><Skel className="h-16" /><Skel className="h-60" /></div>}
      {q.isError && <ErrorBox message={(q.error as Error).message} onRetry={() => q.refetch()} />}
      {data && <>
        <div className="grid gap-3 sm:grid-cols-2">
          {([["current", "pivot-total-current"], ["previous", "pivot-total-previous"]] as const).map(([p, id]) => (
            <div key={p} className="rounded-lg bg-white p-3 shadow-sm"><p className="text-[11px] font-semibold uppercase tracking-wide text-[#41586e]">{p} total, {mLabel}</p>
              <p className="mt-1 text-xl font-semibold tabular-nums" data-testid={id}><Val v={mval(data.totals[p], metric)} /></p>
              <p className="text-[11px] text-[#5d7388]">{dateText(data.periods[p].start)} to {dateText(data.periods[p].end)}; all {data.total.toLocaleString("en-IN")} matching parents</p></div>))}
        </div>
        <Panel title="Pivot" note={`${mLabel} by parent group. Currencies are never converted or summed together.`}
          right={<span className="text-xs tabular-nums text-[#41586e]">{data.total.toLocaleString("en-IN")} parents / {data.population.accounts.toLocaleString("en-IN")} accounts</span>}>
          {data.rows.length === 0 ? <div data-testid="pivot-empty" className="p-6 text-center text-sm text-[#41586e]"><p className="font-semibold">No parent groups match these filters.</p><p className="mt-1 text-xs">Widen the dates or clear a filter, then apply again.</p></div> :
          <div className={`overflow-x-auto ${q.isFetching ? "opacity-60" : ""}`}><table data-testid="pivot-table" className="w-full text-xs">
            <thead><tr className="border-b border-[#c5d3df] text-left text-[#41586e]"><th scope="col" rowSpan={2} className="sticky left-0 bg-white px-2 py-1.5">Parent group</th>
              {cols.map(c => <th key={c.key} scope="colgroup" colSpan={3} className="border-l border-[#e3ebf2] px-2 py-1.5">{c.label}</th>)}</tr>
              <tr className="border-b border-[#c5d3df] text-left text-[#5d7388]">{cols.map(c => ["Current", "Previous", "Change"].map(h => <th key={c.key + h} scope="col" className="px-2 py-1 font-medium">{h}</th>))}</tr></thead>
            <tbody>{data.rows.map(r => <tr key={r.parentKey} data-testid={`pivot-row-${r.parentKey}`} className="border-b border-[#e3ebf2] align-top">
              <th scope="row" className="sticky left-0 bg-white px-2 py-1.5 text-left font-semibold">{r.parentName}<span className="block text-[10px] font-normal text-[#5d7388]">{r.accounts} accounts{r.segments.length ? `, ${r.segments.join(", ")}` : ""}</span></th>
              {cols.map(c => { const cell = r.cells[c.key]; if (!cell) return <td key={c.key} colSpan={3} className="px-2 py-1.5 text-[#8CA0B3]">None</td>;
                const cv = mval(cell.current, metric), pv = mval(cell.previous, metric);
                const cell3 = (v: typeof cv, p: "current" | "previous") => positive(v)
                  ? <button type="button" data-testid={`pivot-cell-${r.parentKey}-${c.key}-${p}`} onClick={() => open(r.parentKey, c.key, p)} className="text-left tabular-nums text-[#05628f] underline decoration-dotted" aria-label={`Show ${p} evidence for ${r.parentName}, ${c.label}`}><Val v={v} /></button>
                  : <span className="tabular-nums text-[#8CA0B3]"><Val v={v} /></span>;
                return [<td key={c.key + "c"} className="border-l border-[#e3ebf2] px-2 py-1.5">{cell3(cv, "current")}</td>,
                  <td key={c.key + "p"} className="px-2 py-1.5">{cell3(pv, "previous")}</td>,
                  <td key={c.key + "d"} className="px-2 py-1.5 tabular-nums"><Change c={cv} p={pv} /></td>]; })}
            </tr>)}</tbody></table></div>}
          {metric === "engagedContacts" && <p className="mt-2 text-[11px] text-[#5d7388]">Distinct engaged contacts are not additive across cells or periods; totals count each person once.</p>}
          {isMoney(metric) && <p className="mt-2 text-[11px] text-[#5d7388]">Each currency is shown separately.</p>}
          <div className="mt-2 flex items-center gap-2 text-xs"><button className={`${btn} border border-[#c5d3df] disabled:opacity-40`} disabled={page <= 1} onClick={() => setPage(p => p - 1)}>Previous</button>
            <span className="tabular-nums">Page {data.page} of {pages}</span><button className={`${btn} border border-[#c5d3df] disabled:opacity-40`} disabled={page >= pages} onClick={() => setPage(p => p + 1)}>Next</button></div>
        </Panel>
        {data.rows.length > 0 && <Panel title="Planning context" note="Current supplied account-planning data for the parents above. TAM is in USD thousands ($K), not historical and not revenue; it is separate from dated activity.">
          <div data-testid="pivot-planning" className="overflow-x-auto"><table className="w-full text-xs"><thead><tr className="border-b border-[#c5d3df] text-left text-[#41586e]">
            {["Parent group", "PS TAM ($K)", "Print TAM ($K)", "Missing PS TAM", "Missing Print TAM", "PS RAD accounts", "Print RAD accounts"].map(h => <th key={h} scope="col" className="px-2 py-1.5">{h}</th>)}</tr></thead>
            <tbody>{data.rows.map(r => <tr key={r.parentKey} className="border-b border-[#e3ebf2]"><th scope="row" className="px-2 py-1.5 text-left font-semibold">{r.parentName}</th>
              <td className="px-2 py-1.5 tabular-nums">{r.planning.psTamK == null ? "Not supplied" : `$${nf.format(r.planning.psTamK)}K`}</td>
              <td className="px-2 py-1.5 tabular-nums">{r.planning.printTamK == null ? "Not supplied" : `$${nf.format(r.planning.printTamK)}K`}</td>
              <td className="px-2 py-1.5 tabular-nums">{nf.format(r.planning.missingPsTam)}</td><td className="px-2 py-1.5 tabular-nums">{nf.format(r.planning.missingPrintTam)}</td>
              <td className="px-2 py-1.5">{radText(r.planning.psRad)}</td><td className="px-2 py-1.5">{radText(r.planning.printRad)}</td></tr>)}</tbody></table></div>
        </Panel>}
        <div className="space-y-1 text-[11px] text-[#5d7388]" data-testid="pivot-notes">
          <p>Unassigned activity (untagged or ambiguous): {data.unassigned.currentRecords.toLocaleString("en-IN")} current and {data.unassigned.previousRecords.toLocaleString("en-IN")} previous records. Current roster population ({data.population.contacts.toLocaleString("en-IN")} contacts) is not historical.</p>
          {data.notes.map(n => <p key={n}>{n}</p>)}</div>
      </>}
    </div>
  );
}
