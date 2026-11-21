import { useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import { useGetMonitoringHistoryAccounts } from "@workspace/api-client-react";
import { formatReportDate, formatReportDateTime } from "@/lib/reportTime";
import MonitoringQualityWarning from "./MonitoringQualityWarning";

export default function MonitoringHistoryAccounts({ date, endDate, status, configId, scheduleName, onClose }: {
  date: string; endDate?: string; status: "completed" | "failed"; configId?: number; scheduleName: string; onClose: () => void;
}) {
  const [page, setPage] = useState(1);
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    panel.current?.scrollIntoView?.({ behavior: "smooth", block: "start" });
  }, [date, endDate, status]);
  const { data, isLoading, isError, isFetching, refetch } = useGetMonitoringHistoryAccounts({
    date, ...(endDate ? { endDate } : {}), status, configId, page, pageSize: 20,
  }, { query: { refetchInterval: 30_000 } });
  const pages = Math.max(1, Math.ceil((data?.totalAccounts ?? 0) / 20));

  return <section ref={panel} aria-label={endDate ? "Accounts checked in selected range" : "Accounts checked on selected day"} data-testid="history-accounts" className="mt-4 rounded-lg border border-stone-200 bg-stone-50 p-4">
    <div className="flex items-start justify-between gap-3">
      <div>
        <h3 className="text-sm font-bold">{status === "completed" ? "Completed" : "Failed"} · {formatReportDate(date)}{endDate && ` – ${formatReportDate(endDate)}`} (IST)</h3>
        <p className="text-xs text-stone-500">{scheduleName}. Read-only history; opening this list does not run research or retry checks.</p>
      </div>
      <button type="button" onClick={onClose} className="text-xs font-semibold underline">Close account list</button>
    </div>
    {isError ? <p role="alert" className="mt-3 text-xs text-red-800">Could not load accounts. <button type="button" onClick={() => refetch()} className="underline">Reload account list</button></p>
      : isLoading ? <p role="status" className="mt-3 text-xs">Loading accounts…</p>
      : data && <>
        <p className="my-3 text-xs font-semibold">{data.totalAccounts.toLocaleString()} unique accounts · {data.totalChecks.toLocaleString()} {status} provider checks</p>
        <p className="mb-2 text-xs text-stone-500">Each account appears once. All its checks {endDate ? "in this IST date range" : "on this IST day"} are shown below; failed and completed lists can contain the same account.</p>
        {!data.items.length ? <p className="py-3 text-xs">No accounts on this page.</p> :
          <ul className="divide-y divide-stone-200">{data.items.map(account => <li key={account.accountId} className="py-3 text-xs" data-testid={`history-account-${account.accountId}`}>
            <Link href={`/intent/accounts/${account.accountId}`} className="font-semibold text-emerald-800 underline">
              {account.accountName ?? `Account #${account.accountId}`} · Open account analysis
            </Link>
            <p className="mt-1 text-stone-600">{account.completedChecks} completed checks · {account.failedChecks} failed checks</p>
            <ul className="mt-1 space-y-1 text-stone-600">{account.attempts.map((attempt, index) => <li key={`${attempt.runId}-${index}`}>
              {attempt.provider} · {attempt.status} · {formatReportDateTime(attempt.completedAt)} · Run #{attempt.runId}
              <MonitoringQualityWarning quality={attempt.researchQuality}/>
            </li>)}</ul>
          </li>)}</ul>}
        <div className="mt-3 flex items-center justify-between text-xs">
          <span>Page {page} / {pages}{isFetching ? " · Updating…" : ""}</span>
          <div className="flex gap-3">
            <button type="button" aria-label="Previous account page" disabled={page <= 1 || isFetching} onClick={() => setPage(p => p - 1)} className="font-semibold underline disabled:opacity-40">Previous</button>
            <button type="button" aria-label="Next account page" disabled={page >= pages || isFetching} onClick={() => setPage(p => p + 1)} className="font-semibold underline disabled:opacity-40">Next</button>
          </div>
        </div>
      </>}
  </section>;
}
