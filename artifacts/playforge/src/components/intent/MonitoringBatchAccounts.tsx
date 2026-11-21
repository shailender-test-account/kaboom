import { useState } from "react";
import { Link } from "wouter";
import { useGetMonitoringBatchAccounts } from "@workspace/api-client-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { formatReportDateTime } from "@/lib/reportTime";
import MonitoringQualityWarning from "./MonitoringQualityWarning";

export type MonitoringBatchSelection = {
  configId: number; runId: number; scheduleName: string;
  status: "all" | "processed" | "completed" | "failed" | "remaining"; lane?: "warm" | "prospect";
};
export default function MonitoringBatchAccounts({selection, onClose}: {selection: MonitoringBatchSelection; onClose: () => void}) {
  const [page, setPage] = useState(1);
  const {data, isLoading, isError, isFetching, refetch} = useGetMonitoringBatchAccounts({
    configId: selection.configId, runId: selection.runId, status: selection.status, lane: selection.lane, page, pageSize: 20,
  }, {query: {refetchInterval: 30_000}});
  const pages = Math.max(1, Math.ceil((data?.totalAccounts ?? 0)/20));
  return <Dialog open onOpenChange={open => {if (!open) onClose();}}>
    <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
      <DialogHeader>
        <DialogTitle className="capitalize">{selection.status === "all" ? "All batch" : selection.status} accounts</DialogTitle>
        <DialogDescription>{selection.scheduleName}{selection.lane ? ` · ${selection.lane === "warm" ? "Warm rechecks" : "Prospect discovery"}` : ""}. Read-only results for the selected batch; no research or retries are started.</DialogDescription>
      </DialogHeader>
      {isError ? <p role="alert" className="text-sm text-red-800">Could not load accounts. <button onClick={() => refetch()} className="underline">Retry loading</button></p>
        : isLoading ? <p role="status">Loading accounts…</p> : <>
          <p className="text-sm font-semibold">{data?.totalAccounts.toLocaleString()} accounts</p>
          {!data?.items.length ? <p className="text-sm text-stone-500">No accounts match this status.</p> :
            <ul className="divide-y">{data.items.map(account => <li key={account.accountId} className="space-y-1 py-3 text-sm">
              {account.available ? <Link href={`/intent/accounts/${account.accountId}`} className="font-semibold text-emerald-800 underline">
                {account.accountName ?? `Account #${account.accountId}`} · View details
              </Link> : <span className="font-semibold">Account #{account.accountId} · no longer available</span>}
              <p className="text-xs capitalize text-stone-600">{account.status} · {account.provider}
                {account.completedAt ? ` · ${formatReportDateTime(account.completedAt)}` : " · Not completed yet"}</p>
              {account.error && <p className="text-xs text-amber-800">{account.error}</p>}
              <MonitoringQualityWarning quality={account.researchQuality}/>
            </li>)}</ul>}
          <div className="flex items-center justify-between text-xs">
            <span>Page {page} / {pages}{isFetching ? " · Updating…" : ""}</span>
            <div className="flex gap-4">
              <button disabled={page <= 1 || isFetching} onClick={() => setPage(p => p-1)} className="underline disabled:opacity-40">Previous</button>
              <button disabled={page >= pages || isFetching} onClick={() => setPage(p => p+1)} className="underline disabled:opacity-40">Next</button>
            </div>
          </div>
        </>}
    </DialogContent>
  </Dialog>;
}
