import { useEffect, useMemo, useState } from "react";
import { getGetHpParentHeatmapQueryKey, useGetHpParentHeatmap } from "@workspace/api-client-react";
import type { GetHpParentHeatmapParams, HpParentHeatmapMetric, HpParentHeatmapMonthsItem } from "@workspace/api-client-react";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import ContactActivity, { isEligibleRecord } from "./ContactActivity";
import type { ContactMetric } from "./ContactActivity";
import { useHpBiDetail } from "./api";
import type { HpBiDetail, HpBiFilters, HpBiRecord } from "./types";
import { currentFiscalYear } from "./format";

export type HeatmapMetric = HpParentHeatmapMetric;
export const HEATMAP_METRICS: { value: HeatmapMetric; label: string; note: string }[] = [
  { value: "touchpoints", label: "Touchpoints", note: "Source-record counts, not unique people." },
  { value: "engagedContacts", label: "Engaged contacts", note: "Distinct people per month; the FY total is distinct across the year, not the sum of months." },
  { value: "emailClicks", label: "Email clicks", note: "Source-record counts of email link clicks, not unique people." },
  { value: "emailOpens", label: "Email opens", note: "Source-record counts of opens. Opens are not verified clicks." },
  { value: "leads", label: "Leads", note: "Source-record counts, not unique people." },
  { value: "hot", label: "Hot leads", note: "Server-qualified hot leads; source-record counts." },
  { value: "opportunities", label: "Opportunities", note: "Source-record counts, not unique people." },
];
const label = (m: HeatmapMetric) => HEATMAP_METRICS.find(x => x.value === m)!.label;

export function inMonth(r: HpBiRecord, m: Pick<HpParentHeatmapMonthsItem, "start" | "end">): boolean {
  const t = new Date(r.occurredAt).getTime();
  return t >= new Date(m.start).getTime() && t < new Date(m.end).getTime();
}
export function heatmapContactMetric(metric: HeatmapMetric): ContactMetric {
  return metric === "emailClicks" || metric === "emailOpens" ? "touchpoints" : metric;
}
export function filterHeatmapRecords(records: HpBiRecord[], metric: HeatmapMetric, month: Pick<HpParentHeatmapMonthsItem, "start" | "end">, knownContacts?: Set<number>): HpBiRecord[] {
  return records.filter(r => {
    if (!inMonth(r, month)) return false;
    if (metric === "emailClicks") return r.kind === "digital" && r.status === "email_click";
    if (metric === "emailOpens") return r.kind === "digital" && r.status === "email_open";
    if (metric === "engagedContacts" && knownContacts && !knownContacts.has(r.contactId!)) return false;
    return isEligibleRecord(r, metric);
  });
}

interface Cell { parentKey: string; parentName: string; month: HpParentHeatmapMonthsItem; value: number }

// sequential blue ramp, continuous by value/maxCell
const LOW: [number, number, number] = [234, 243, 249], HIGH: [number, number, number] = [5, 98, 143];
export function cellColor(v: number, max: number) {
  const t = max > 0 ? Math.min(1, Math.max(0, v / max)) : 0;
  const c = LOW.map((l, i) => Math.round(l + (HIGH[i] - l) * t));
  return { background: `rgb(${c.join(",")})`, color: t > 0.5 ? "#fff" : "#0B2A4A" };
}
const btn = "rounded border border-[#c5d3df] bg-white px-2.5 py-1 text-xs font-semibold text-[#0B2A4A] hover:bg-[#eef3f7] disabled:opacity-40";

export default function ParentMonthHeatmap({ filters }: { filters: HpBiFilters }) {
  const [metric, setMetric] = useState<HeatmapMetric>("touchpoints");
  const [page, setPage] = useState(1);
  const [cell, setCell] = useState<Cell | null>(null);
  const filterKey = JSON.stringify({ ...filters, page: undefined, pageSize: undefined, parentKey: undefined });
  useEffect(() => { setCell(null); setPage(1); }, [filterKey]);
  useEffect(() => { setCell(null); }, [metric, page]);

  const flag = (v?: boolean) => (v ? ("true" as const) : undefined);
  const params: GetHpParentHeatmapParams = {
    clientId: filters.clientId, year: filters.year ?? currentFiscalYear(), metric, page, pageSize: 25,
    salesPerson: filters.salesPerson, opportunity: filters.opportunity,
    segment: filters.segment || undefined, rad: (filters.rad || undefined) as GetHpParentHeatmapParams["rad"],
    basis: (filters.basis || undefined) as GetHpParentHeatmapParams["basis"], search: filters.search || undefined,
    dimension: filters.dimension || undefined, dimensionValue: filters.dimensionValue || undefined,
    newOnly: flag(filters.newOnly), abmOnly: flag(filters.abmOnly), incompleteOnly: flag(filters.incompleteOnly),
  };
  const q = useGetHpParentHeatmap(params, { query: { queryKey: getGetHpParentHeatmapQueryKey(params), staleTime: 15000, refetchInterval: 60000 } });
  const data = q.data;

  const detailQ = useHpBiDetail({ ...filters, year: params.year, parentKey: cell?.parentKey, page: undefined, pageSize: undefined }, !!cell);
  const scoped: HpBiDetail | null = useMemo(() => {
    if (!cell || !detailQ.data) return null;
    return { ...detailQ.data, formEvidence: detailQ.data.formEvidence?.filter(r => inMonth(r, cell.month)),
      records: filterHeatmapRecords(detailQ.data.records, metric, cell.month, new Set(detailQ.data.contacts.map(c => c.id))) };
  }, [cell, detailQ.data, metric]);

  const open = (c: Cell) => {
    if (typeof document !== "undefined" && document.fullscreenElement) void document.exitFullscreen?.().catch(() => undefined);
    setCell(c);
  };
  const openYear = (r: NonNullable<typeof data>["rows"][number]) => {
    if (!data?.months.length) return;
    open({ parentKey: r.parentKey, parentName: r.parentName, value: r.total, month: {
      month: 0, label: `Full FY${data.year}`, start: data.months[0].start, end: data.months.at(-1)!.end, isFuture: false,
    } });
  };
  const pages = data ? Math.max(1, Math.ceil(data.total / (data.pageSize || 25))) : 1;
  const note = HEATMAP_METRICS.find(m => m.value === metric)!.note;
  const fy = data?.year ?? params.year;

  return (
    <section className="rounded border border-[#d5e0ea] bg-white p-4 space-y-3 text-[#10243B] min-w-0" data-testid="hp-parent-month-heatmap" aria-label="Parent by month heatmap">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-[#0B2A4A]" style={{ fontFamily: "'Barlow Semi Condensed', sans-serif" }}>Parent × month · FY{fy}</h2>
          <p className="text-xs text-[#41586e] mt-1 max-w-3xl">{note} Zero means no recorded eligible activity, not confirmed absence of activity. Fiscal year runs Nov–Oct.</p>
        </div>
        <label className="text-xs font-semibold text-[#41586e] flex items-center gap-2">Metric
          <select className="rounded border border-[#c5d3df] bg-white px-2 py-1.5 text-xs" value={metric} data-testid="heatmap-metric"
            onChange={e => { setMetric(e.target.value as HeatmapMetric); setPage(1); }}>
            {HEATMAP_METRICS.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>
        </label>
      </header>

      {q.isLoading ? <div className="h-48 animate-pulse rounded bg-[#eef3f7]" data-testid="heatmap-status" role="status">Loading heatmap…</div>
      : q.isError ? <div className="p-4 rounded border border-[#e5b8b8] bg-[#fdf3f3] text-sm" data-testid="heatmap-status" role="alert">
          Could not load the heatmap. <button type="button" className={btn} onClick={() => void q.refetch()} data-testid="heatmap-retry">Retry</button></div>
      : !data || data.rows.length === 0 ? <div className="p-6 text-center text-sm text-[#5d7388] rounded border border-dashed border-[#c5d3df]" data-testid="heatmap-status">
          No parent groups match these filters for {label(metric).toLowerCase()}.</div>
      : (<>
        <div className="overflow-x-auto rounded border border-[#d5e0ea] max-w-full">
          <table className="text-xs border-separate border-spacing-0 min-w-max">
            <caption className="sr-only">{label(metric)} by parent group and fiscal month, FY{fy}</caption>
            <thead><tr>
              <th scope="col" className="sticky left-0 z-10 bg-[#f6f9fb] p-2 text-left text-[10.5px] uppercase tracking-wider text-[#5d7388] min-w-[180px] border-b border-[#d5e0ea]">Parent</th>
              {data.months.map(m => <th key={m.month} scope="col" className="bg-[#f6f9fb] p-2 text-center text-[10.5px] uppercase tracking-wider text-[#5d7388] min-w-[64px] border-b border-[#d5e0ea]">{m.label}</th>)}
              <th scope="col" className="bg-[#f6f9fb] p-2 text-right text-[10.5px] uppercase tracking-wider text-[#5d7388] border-b border-[#d5e0ea]">FY total</th>
            </tr></thead>
            <tbody>
              {data.rows.map(r => (
                <tr key={r.parentKey}>
                  <th scope="row" className="sticky left-0 z-10 bg-white p-2 text-left font-medium border-b border-[#e3ebf2]">
                     <button type="button" className="text-left text-[#05628f] hover:underline" onClick={() => openYear(r)} title={`Open full fiscal-year evidence for ${r.parentName}`}>
                       <div className="truncate max-w-[200px]">{r.parentName}</div>
                       <div className="text-[10.5px] font-normal">{r.memberCount} legal account{r.memberCount === 1 ? "" : "s"}</div>
                     </button>
                  </th>
                  {data.months.map((m, i) => {
                    const v = r.cells[i] ?? 0;
                    const dead = m.isFuture && v === 0;
                    return (
                      <td key={m.month} className="p-0 border-b border-white">
                        <button type="button" disabled={dead} data-testid={`heatmap-cell-${r.parentKey}-${m.month}`}
                          aria-label={dead ? `${r.parentName}, ${m.label}: not started` : `${r.parentName}, ${m.label}: ${v} ${label(metric).toLowerCase()}${m.isFuture ? " (future-dated records)" : ""}. Open evidence`}
                          title={dead ? "Not started" : undefined}
                          className="w-full h-10 tabular-nums font-semibold focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0096D6] focus-visible:ring-inset disabled:cursor-not-allowed"
                          style={dead ? { background: "#f3f5f7", color: "#8da0b1" } : cellColor(v, data.maxCell)}
                          onClick={() => open({ parentKey: r.parentKey, parentName: r.parentName, month: m, value: v })}>
                          {dead ? "–" : v}
                        </button>
                      </td>);
                  })}
                   <td className="p-2 text-right tabular-nums font-semibold border-b border-[#e3ebf2]" title={metric === "engagedContacts" ? "Distinct across the fiscal year" : undefined}>
                     <button type="button" className="text-[#05628f] hover:underline" onClick={() => openYear(r)} data-testid={`heatmap-total-${r.parentKey}`} aria-label={`${r.parentName}: ${r.total} ${label(metric)}, full fiscal-year evidence`}>{r.total}</button>
                   </td>
                </tr>))}
            </tbody>
          </table>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-[#5d7388]">
          <div className="flex items-center gap-2" aria-label="Intensity scale">
            <span>Low 0</span>
            <span className="h-2.5 w-40 rounded" style={{ background: `linear-gradient(to right, rgb(${LOW.join(",")}), rgb(${HIGH.join(",")}))` }} />
            <span>High {data.maxCell}</span>
          </div>
          <div className="flex items-center gap-2" data-testid="heatmap-pager">
            <span>{data.total} parent group{data.total === 1 ? "" : "s"}</span>
            <button type="button" className={btn} disabled={page <= 1} onClick={() => setPage(p => p - 1)} data-testid="heatmap-prev">Previous</button>
            <span>Page {data.page} of {pages}</span>
            <button type="button" className={btn} disabled={page >= pages} onClick={() => setPage(p => p + 1)} data-testid="heatmap-next">Next</button>
          </div>
        </div>
      </>)}

      <Sheet open={!!cell} onOpenChange={o => { if (!o) setCell(null); }}>
        <SheetContent side="right" className="w-full sm:max-w-3xl overflow-y-auto" data-testid="heatmap-evidence">
          {cell && (<>
            <SheetHeader>
              <SheetTitle>{cell.parentName} · {cell.month.label} · {label(metric)}</SheetTitle>
              <SheetDescription>
                 Parent {cell.parentName}, FY{fy}, {cell.month.month === 0 ? "full fiscal year" : `fiscal month ${cell.month.month} (${cell.month.label})`}, metric {label(metric)}. {note}
              </SheetDescription>
            </SheetHeader>
            <div className="py-3 space-y-3">
              <button type="button" className={btn} onClick={() => setCell(null)} data-testid="heatmap-back">Back to heatmap</button>
              {detailQ.isLoading ? <div className="h-32 animate-pulse rounded bg-[#eef3f7]" role="status">Loading evidence…</div>
              : detailQ.isError ? <div role="alert" className="text-sm">Could not load evidence. <button type="button" className={btn} onClick={() => void detailQ.refetch()}>Retry</button></div>
               : scoped ? <ContactActivity detail={scoped} metric={heatmapContactMetric(metric)} year={fy}
                   contributionRecords={detailQ.data?.records.filter(r => cell && inMonth(r, cell.month))} /> : null}
            </div>
          </>)}
        </SheetContent>
      </Sheet>
    </section>
  );
}
