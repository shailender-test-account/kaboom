import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { ArrowRight, ChevronLeft, ChevronRight, Radar, Search } from "lucide-react";
import { usePriorityOpportunities } from "@/hooks/use-opportunities";
import { formatReportDate } from "@/lib/reportTime";
import type { ListMonitoredAccounts200 } from "@workspace/api-client-react";
import MonitoredResearchContext from "@/components/intent/MonitoredResearchContext";

type MonitoredResponse = ListMonitoredAccounts200;
const dateLabel = (value: string | null) => value
  ? formatReportDate(value)
  : "Not completed";
const statusClass: Record<string, string> = {
  hot: "bg-rose-50 text-rose-700",
  warm: "bg-amber-50 text-amber-800",
  review: "bg-blue-50 text-blue-700",
};
const sourceLabel = (source: string) => source === "lead_form" ? "Lead form"
  : source === "event_feedback" ? "Event Feedback"
    : source.startsWith("monitor") ? "Monitoring" : "Inbound";
const priorityColumns = "lg:grid-cols-[minmax(0,2fr)_minmax(85px,.7fr)_minmax(105px,.85fr)_minmax(100px,.85fr)_minmax(100px,.85fr)_auto]";

import {monitoredAccountsQuery} from "./monitored-accounts-query";

export function useMonitoredAccounts(page = 1, search = "", accountId?: number, enabled = true) {
  const {params,queryKey}=monitoredAccountsQuery(page,search,accountId);
  return useQuery<MonitoredResponse>({
    queryKey,
    enabled,
    queryFn: async () => {
      const response = await fetch(`/api/intent/opportunities/monitored-accounts?${params}`, { credentials: "include" });
      if (!response.ok) throw new Error(`Monitoring accounts unavailable (${response.status})`);
      return response.json() as Promise<MonitoredResponse>;
    },
    staleTime: 30_000,
    refetchOnMount: "always",
    refetchInterval: 60_000,
  });
}

export function AccountIntelligenceOverview() {
  return <section aria-label="Autonomous GTM OS overview">
    <div className="inbound-overview">
      <p className="inbound-kicker">The decision workspace</p>
      <div className="flex flex-wrap items-end justify-between gap-6">
        <div>
          <h2 className="mt-3">Know who to act on.<br/>Know why now.</h2>
          <p className="mt-3 max-w-xl text-sm leading-relaxed">Follow inbound interest and monitored account evidence in one place, without treating research as a form response.</p>
        </div>
        <Link href="/intent/sales-dashboard" className="inline-flex items-center gap-2 text-xs font-bold">
          Full Sales Decision Cockpit <ArrowRight className="h-4 w-4" />
        </Link>
      </div>
      <div className="inbound-process">
        {[
          ["01 · Intake", "Forms + event feedback"],
          ["02 · Qualify", "Account × product"],
          ["03 · Monitor", "Research + recheck"],
          ["04 · Decide", "Evidence before handoff"],
        ].map(([step, description]) =>
          <div key={step}>
            <strong>{step}</strong><span>{description}</span>
          </div>
        )}
      </div>
    </div>
  </section>;
}

export function PriorityAccountsSection() {
  const [stage, setStage] = useState<"all" | "hot" | "warm" | "review">("all");
  const opportunities = usePriorityOpportunities(stage === "all" ? undefined : stage);
  return <section aria-label="Priority accounts" className="inbound-companion">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 p-4 sm:p-5">
        <div><h3 className="font-black text-[#162e49]">Priority accounts</h3>
          <p className="mt-1 text-xs text-slate-500">Recent qualified account–product opportunities from inbound and monitoring evidence.</p></div>
        <Link href="/intent/sales-dashboard" className="text-xs font-bold text-blue-700 hover:underline">View all →</Link>
      </div>
      <div role="tablist" aria-label="Opportunity stage" className="flex gap-1 overflow-x-auto border-b border-slate-100 px-4">
        {(["all", "hot", "warm", "review"] as const).map(value =>
          <button key={value} role="tab" aria-selected={stage === value} onClick={() => setStage(value)}
            className={`whitespace-nowrap border-b-2 px-3 py-3 text-xs font-bold capitalize ${stage === value ? "border-blue-500 text-blue-700" : "border-transparent text-slate-500 hover:text-slate-800"}`}>
            {value === "hot" ? "Sales ready" : value === "warm" ? "Warm nurture" : value === "review" ? "Needs review" : "All"}
          </button>)}
      </div>
      {opportunities.isLoading ? <p className="p-6 text-sm text-slate-500">Loading opportunities…</p>
        : opportunities.isError ? <p role="alert" className="p-6 text-sm text-rose-700">Opportunities could not be loaded{opportunities.error?.name === "TimeoutError" ? " within 30 seconds" : ""}. <button className="underline" onClick={() => opportunities.refetch()}>Retry</button></p>
        : !opportunities.data?.items.length ? <p className="p-6 text-sm text-slate-500">No matches in this recent sample. <Link href="/intent/sales-dashboard" className="text-blue-700 underline">Check the full queue</Link> for more accounts.</p>
        : <div className="divide-y divide-slate-100">
            <div className={`hidden gap-3 border-b border-slate-100 bg-slate-50/70 px-4 py-2 text-[10px] font-bold uppercase tracking-wide text-slate-500 lg:grid ${priorityColumns}`}>
              <span>Account / Product</span><span>Source</span><span>Category</span><span>Journey Name</span><span>Sequence Name</span><span>Status</span>
            </div>
            {opportunities.data.items.map(item =>
              <Link key={`${item.accountId}-${item.productId}`} href={`/intent/accounts/${item.accountId}?productId=${item.productId}`}
                className={`inbound-companion-row grid gap-3 p-4 transition-colors hover:bg-blue-50/50 ${priorityColumns} lg:items-start`}>
                <div className="min-w-0">
                  <p className="text-sm font-black text-[#162e49]">{item.accountName} <span className="font-normal text-slate-400">/</span> {item.productName}</p>
                  <p className="mt-1 line-clamp-2 text-xs text-slate-600">{item.reason}</p>
                  <p className="mt-1 text-[11px] text-slate-500">People {item.score.people} · Monitoring {item.score.monitoring} · {dateLabel(item.latestActionAt)}</p>
                </div>
                <div className="grid grid-cols-2 gap-3 text-xs text-slate-700 sm:grid-cols-4 lg:contents">
                  <div className="min-w-0 break-words"><span className="block text-[10px] font-bold uppercase text-slate-500 lg:hidden">Source</span>{sourceLabel(item.source)}</div>
                  <div className="min-w-0 break-words"><span className="block text-[10px] font-bold uppercase text-slate-500 lg:hidden">Category</span>{item.categoryName || "—"}</div>
                  <div className="min-w-0 break-words"><span className="block text-[10px] font-bold uppercase text-slate-500 lg:hidden">Journey Name</span>{item.journeyName || "—"}</div>
                  <div className="min-w-0 break-words"><span className="block text-[10px] font-bold uppercase text-slate-500 lg:hidden">Sequence Name</span>{item.sequenceName || "—"}</div>
                </div>
                <div className="flex items-center justify-between gap-2 lg:justify-start">
                  <span className={`rounded-full px-2.5 py-1 text-[10px] font-bold capitalize ${statusClass[item.status] ?? statusClass.review}`}>{item.status}</span>
                  <ChevronRight className="h-4 w-4 text-slate-400" />
                </div>
              </Link>)}
          </div>}
       <div className="border-t border-slate-100 px-4 py-3 text-xs text-slate-500">Showing up to five recent opportunities{opportunities.data?.limited ? " from a recent sample" : ""} · <Link href="/intent/sales-dashboard" className="text-blue-700 hover:underline">View full queue</Link></div>
  </section>;
}

export function MonitoredAccountsSection() {
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [monitorPage, setMonitorPage] = useState(1);
  useEffect(() => {
    const timer = setTimeout(() => { setSearch(query.trim()); setMonitorPage(1); }, 300);
    return () => clearTimeout(timer);
  }, [query]);
  const monitored = useMonitoredAccounts(monitorPage, search);
  return <section aria-label="Monitored accounts" id="monitored-accounts">
       <div className="inbound-companion min-w-0">
        <div className="border-b border-slate-100 p-4 sm:p-5">
          <div className="flex items-start justify-between gap-3">
            <div><h3 className="flex items-center gap-2 font-black text-[#162e49]"><Radar className="h-4 w-4 text-teal-600" /> Accounts with research insights</h3>
              <p className="mt-1 text-xs text-slate-500">Only accounts with usable cited business news, evidence-backed interpretations and HP recommendations. A completed check alone does not qualify; buying intent is unchanged.</p></div>
            <Link href="/intent/monitoring" className="shrink-0 text-xs font-bold text-blue-700 hover:underline">Schedules →</Link>
          </div>
          <label className="relative mt-4 block">
            <Search className="absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
            <span className="sr-only">Search monitored accounts</span>
            <input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search monitored accounts"
              className="h-9 w-full rounded-lg border border-slate-200 bg-slate-50 pl-9 pr-3 text-xs outline-none focus:border-blue-400" />
          </label>
        </div>
        {monitored.isLoading ? <p className="p-5 text-sm text-slate-500">Loading monitored accounts…</p>
          : monitored.isError ? <p role="alert" className="p-5 text-sm text-rose-700">Monitoring accounts could not be loaded. <button className="underline" onClick={() => monitored.refetch()}>Retry</button></p>
          : !monitored.data?.items.length ? <p className="p-5 text-sm text-slate-500">No accounts have usable news, interpretations and HP recommendations{search ? " for this search" : " yet"}. Checks with no findings or incomplete analysis are excluded. Monitoring history remains available under Schedules.</p>
          : <div className="divide-y divide-slate-100">{monitored.data.items.map(account =>
             <article key={account.id} className="inbound-companion-row block p-4">
              <div className="flex items-center justify-between gap-2">
                <Link href={`/intent/accounts/${account.id}`} className="truncate text-sm font-bold text-[#162e49] hover:underline">{account.name} →</Link>
                {account.hasInbound && <span className="shrink-0 rounded-full bg-blue-50 px-2 py-1 text-[10px] font-bold text-blue-700">Also inbound</span>}
              </div>
              <MonitoredResearchContext context={account.researchContext} sourcePage={`/intent/accounts/${account.id}`} />
              <Link href={`/intent/accounts/${account.id}#account-research-details`} className="mt-2 inline-block text-xs font-semibold text-teal-800 underline">Detailed analysis and citations →</Link>
              <p className="mt-1 text-[11px] text-slate-500">Last completed check: {dateLabel(account.lastResearchedAt)} · Latest run: {account.latestRunStatus ?? "Not recorded"}</p>
            </article>)}</div>}
        <div className="flex items-center justify-between border-t border-slate-100 px-4 py-3 text-xs text-slate-500">
          <span>{monitored.data ? `${monitored.data.total.toLocaleString()} accounts with research insights` : "Accounts with research insights"}</span>
          <div className="flex items-center gap-1">
            <button aria-label="Previous monitored accounts" disabled={monitorPage === 1 || monitored.isFetching}
              onClick={() => setMonitorPage(page => Math.max(1, page - 1))} className="rounded border p-1 disabled:opacity-30"><ChevronLeft className="h-4 w-4" /></button>
            <span className="px-1">{monitorPage}</span>
            <button aria-label="Next monitored accounts" disabled={monitored.isFetching || monitorPage * 5 >= (monitored.data?.total ?? 0)}
              onClick={() => setMonitorPage(page => page + 1)} className="rounded border p-1 disabled:opacity-30"><ChevronRight className="h-4 w-4" /></button>
          </div>
        </div>
      </div>
  </section>;
}