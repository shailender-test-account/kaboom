import { useState } from "react";
import { getGetMonitoringHistoryQueryKey, useGetMonitoringHistory } from "@workspace/api-client-react";
import { ChevronLeft, ChevronRight, HelpCircle, RefreshCw } from "lucide-react";
import { formatReportDate, formatReportDateTime } from "@/lib/reportTime";
import MonitoringHistoryAccounts from "./MonitoringHistoryAccounts";

const PAGE_SIZE = 10;
const DAY_OPTIONS = [7, 30, 90] as const;

export default function MonitoringHistory({ schedules }: { schedules: { id: number; name: string }[] }) {
  const [days, setDays] = useState<number>(30);
  const [configId, setConfigId] = useState<number | undefined>(undefined);
  const [page, setPage] = useState(1);
  const [selection, setSelection] = useState<{date: string; endDate?: string; status: "completed" | "failed"} | null>(null);
  const openAccounts = (date: string, status: "completed" | "failed") => setSelection({ date, status });
  const params = { days, ...(configId ? { configId } : {}) };
  const { data, isLoading, isError, isFetching, refetch, dataUpdatedAt } = useGetMonitoringHistory(params, {
    query: { queryKey: getGetMonitoringHistoryQueryKey(params), refetchInterval: 30_000 },
  });
  const items = [...(data?.items ?? [])].sort((a, b) => b.date.localeCompare(a.date));
  const openRange = (status: "completed" | "failed") => {
    if (items.length) setSelection({ date: items[items.length - 1].date, endDate: items[0].date, status });
  };
  const pages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  const current = Math.min(page, pages);
  const rows = items.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE);
  const select = "h-8 rounded-md border border-stone-200 bg-white px-2 text-xs font-semibold";

  return <section data-testid="section-monitoring-history" className="rounded-xl border border-stone-200 bg-white p-5 shadow-sm">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h2 className="flex items-center gap-1.5 text-base font-bold text-stone-900">Daily monitoring history
          <span title="Counted by the actual completion day in IST (GMT+05:30), not by the scheduled day." className="cursor-help text-stone-400"><HelpCircle className="h-3.5 w-3.5" aria-label="About daily history"/></span>
        </h2>
        <p className="mt-0.5 text-xs text-stone-500">Accomplished checks per IST day. Refreshes every 30 seconds.</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <select aria-label="Schedule" data-testid="select-history-schedule" className={select} value={configId ?? ""}
          onChange={e => { setConfigId(e.target.value ? Number(e.target.value) : undefined); setPage(1); setSelection(null); }}>
          <option value="">All schedules</option>
          {schedules.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <div role="group" aria-label="Range" className="flex overflow-hidden rounded-md border border-stone-200">
          {DAY_OPTIONS.map(d => <button key={d} type="button" data-testid={`button-history-days-${d}`} aria-pressed={days === d}
            onClick={() => { setDays(d); setPage(1); setSelection(null); }}
            className={`px-2.5 py-1 text-xs font-bold ${days === d ? "bg-stone-900 text-white" : "bg-white text-stone-600 hover:bg-stone-50"}`}>{d}d</button>)}
        </div>
        <button type="button" data-testid="button-history-refresh" aria-label="Refresh history" onClick={() => refetch()}
          className="rounded-md border border-stone-200 p-1.5 text-stone-500 hover:bg-stone-50"><RefreshCw className={`h-3.5 w-3.5 ${isFetching ? "animate-spin" : ""}`}/></button>
      </div>
    </div>

    {isError ? <p role="alert" className="mt-4 rounded border border-red-200 bg-red-50 p-3 text-xs text-red-800">Could not load monitoring history. <button className="underline" data-testid="button-history-retry" onClick={() => refetch()}>Retry</button></p>
    : isLoading ? <div data-testid="history-loading" className="mt-4 space-y-2">{Array.from({ length: 5 }, (_, i) => <div key={i} className="h-6 animate-pulse rounded bg-stone-100"/>)}</div>
    : <>
      <div className="mt-4 grid grid-cols-3 gap-2">
        <Stat testId="total-accounts" label="Unique accounts completed" value={data?.totalCompletedAccounts ?? 0} help="Distinct accounts with at least one completed check in the range. Each account counts once, so daily account numbers do not add up to this." onClick={() => openRange("completed")}/>
        <Stat testId="total-checks" label="Completed checks" value={data?.totalCompletedChecks ?? 0} help="Every finished check, including checks that found nothing." onClick={() => openRange("completed")}/>
        <Stat testId="total-failed" label="Failed checks" value={data?.totalFailedChecks ?? 0} help="Checks that ended in error. Not counted as completed." tone="amber" onClick={() => openRange("failed")}/>
      </div>
      {items.length > 0 && !data?.totalCompletedChecks && !data?.totalFailedChecks &&
        <p data-testid="history-no-activity" className="mt-3 text-xs text-stone-500">No completed or failed checks in this period. Zero dates are shown below.</p>}
      {items.length === 0 ? <p data-testid="history-empty" className="mt-4 rounded-lg border border-dashed border-stone-300 p-5 text-center text-xs text-stone-500">No completed or failed checks in the last {days} days{configId ? " for this schedule" : ""}.</p> : <>
        <table className="mt-4 w-full text-xs">
          <thead><tr className="border-b border-stone-200 text-left text-[10px] uppercase tracking-wider text-stone-500">
            <th className="py-1.5">Date (IST)</th>
            <th className="py-1.5 text-right" title="Distinct accounts completed that day. Not summable across days.">Accounts</th>
            <th className="py-1.5 text-right" title="Completed checks, including zero-finding results.">Completed checks</th>
            <th className="py-1.5 text-right" title="Failed checks; not counted as completed.">Failed</th>
          </tr></thead>
          <tbody>{rows.map(item => <tr key={item.date} data-testid={`row-history-${item.date}`} className="border-b border-stone-100 tabular-nums">
            <td className="py-1.5 font-semibold text-stone-800">{formatReportDate(item.date)}</td>
            <td className="py-1.5 text-right"><button type="button" disabled={!item.completedAccounts} onClick={() => openAccounts(item.date, "completed")} aria-label={`View completed accounts for ${item.date}`} className="underline disabled:no-underline">{item.completedAccounts.toLocaleString()}</button></td>
            <td className="py-1.5 text-right"><button type="button" disabled={!item.completedChecks} onClick={() => openAccounts(item.date, "completed")} aria-label={`View completed checks for ${item.date}`} className="underline disabled:no-underline">{item.completedChecks.toLocaleString()}</button></td>
            <td className={`py-1.5 text-right ${item.failedChecks ? "font-bold text-amber-700" : "text-stone-400"}`}><button type="button" disabled={!item.failedChecks} onClick={() => openAccounts(item.date, "failed")} aria-label={`View failed checks for ${item.date}`} className="underline disabled:no-underline">{item.failedChecks.toLocaleString()}</button></td>
          </tr>)}</tbody>
        </table>
        <div className="mt-2 flex items-center justify-between text-[11px] text-stone-500">
          <span>{items.length} day{items.length === 1 ? "" : "s"} with activity{dataUpdatedAt ? ` · updated ${formatReportDateTime(new Date(dataUpdatedAt))}` : ""}</span>
          {pages > 1 && <div className="flex items-center gap-1">
            <button aria-label="Previous history page" data-testid="button-history-prev" disabled={current <= 1} onClick={() => setPage(current - 1)} className="rounded border border-stone-200 p-0.5 disabled:opacity-40"><ChevronLeft className="h-3.5 w-3.5"/></button>
            <span>{current} / {pages}</span>
            <button aria-label="Next history page" data-testid="button-history-next" disabled={current >= pages} onClick={() => setPage(current + 1)} className="rounded border border-stone-200 p-0.5 disabled:opacity-40"><ChevronRight className="h-3.5 w-3.5"/></button>
          </div>}
        </div>
      </>}
      {selection && <MonitoringHistoryAccounts key={`${configId}-${selection.date}-${selection.endDate}-${selection.status}`} {...selection} configId={configId}
        scheduleName={schedules.find(s => s.id === configId)?.name ?? "All schedules"} onClose={() => setSelection(null)}/>}
      <details className="mt-2 text-[11px] text-stone-500"><summary className="cursor-pointer font-medium">How these numbers are counted</summary>
        <ul className="mt-1 list-disc space-y-0.5 pl-4">
          <li>Dates are the actual completion day in IST (GMT+05:30).</li>
          <li>A completion with zero findings still counts as a completed check.</li>
          <li>Failed checks are shown separately and never counted as completed.</li>
          <li>Daily account counts are unique per day; the range total is unique across the range, so daily values are not summable.</li>
        </ul>
      </details>
    </>}
  </section>;
}

function Stat({ label, value, help, testId, tone, onClick }: { label: string; value: number; help: string; testId: string; tone?: "amber"; onClick: () => void }) {
  return <div className="rounded-lg bg-stone-50 p-2.5" title={help}>
    <div className="text-[10px] font-bold uppercase tracking-wider text-stone-500">{label}</div>
    <button type="button" aria-label={`View ${label.toLowerCase()} in selected range`} onClick={onClick}
      data-testid={`text-history-${testId}`} className={`mt-0.5 text-lg font-bold tabular-nums underline decoration-dotted underline-offset-4 hover:decoration-solid ${tone && value ? "text-amber-700" : "text-stone-900"}`}>{value.toLocaleString()}</button>
  </div>;
}
