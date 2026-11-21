import { useState, useMemo } from "react";
import { Link, useLocation } from "wouter";
import { useIntentAccounts, useIntentOverview, useIntentScopeOptions } from "@/hooks/use-intent";
import { IntentPageHeader, TierBadge } from "@/components/intent/ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Search, ChevronLeft, ChevronRight, Activity, Users, Building2, Snowflake } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { formatReportDate, formatReportDateTime } from "@/lib/reportTime";

export default function IntentColdAccountsPage() {
  const [location, setLocation] = useLocation();
  const searchParams = new URLSearchParams(window.location.search);

  const [searchInput, setSearchInput] = useState(searchParams.get("search") || "");
  const page = Number(searchParams.get("page")) || 1;

  const apiParams = {
    search: searchInput || undefined,
    tier: "cold", // strict restriction
    clientId: searchParams.get("client") || undefined,
    audienceId: searchParams.get("audience") || undefined,
    categoryIds: searchParams.get("category") || undefined,
    page,
    pageSize: 20,
    sortBy: "score",
    sortDir: "desc",
  };

  const { data, isLoading, isError } = useIntentAccounts(apiParams);

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const p = new URLSearchParams(searchParams);
    if (searchInput.trim()) {
      p.set("search", searchInput.trim());
    } else {
      p.delete("search");
    }
    p.delete("page");
    setLocation(`${location}?${p.toString()}`);
  };

  const goToPage = (newPage: number) => {
    const p = new URLSearchParams(searchParams);
    if (newPage <= 1) p.delete("page");
    else p.set("page", String(newPage));
    setLocation(`${location}?${p.toString()}`);
  };

  return (
    <div className="flex flex-col min-h-full font-sans text-stone-900 bg-[#F6F7F5]">
      <IntentPageHeader
        title="Cold Accounts Repository"
        breadcrumbs="INTENT ENGINE"
      />

      <div className="p-6 max-w-[1200px] mx-auto w-full space-y-6">

        {/* Intro Banner */}
        <div className="bg-white rounded-xl border border-blue-200 p-5 shadow-sm bg-gradient-to-r from-blue-50 to-white relative overflow-hidden">
          <div className="absolute top-0 right-0 w-32 h-32 bg-blue-100 rounded-full blur-3xl -translate-y-1/2 translate-x-1/3 opacity-50" />
          <div className="flex items-start gap-4 relative z-10">
            <div className="w-10 h-10 rounded-full bg-blue-100 flex items-center justify-center border border-blue-200 shrink-0 text-blue-600">
              <Snowflake className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base font-bold text-stone-900">Background monitoring</h2>
              <p className="text-xs font-medium text-stone-600 mt-1 max-w-2xl leading-relaxed">
                These accounts have low or no detectable buying signals right now. They are separated from your primary views to reduce noise. Our continuous monitoring engine tracks these in the background and will elevate them to Warm or Hot when activity surges.
              </p>
            </div>
          </div>
        </div>

        {/* Table */}
        <div className="bg-white rounded-xl border border-stone-200 shadow-sm overflow-hidden flex flex-col">
          <div className="p-4 border-b border-stone-200 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div className="flex items-center gap-2">
              <h3 className="font-bold text-sm text-stone-900">Monitored Accounts</h3>
              <span className="bg-blue-50 text-blue-700 text-[10px] font-bold px-1.5 py-0.5 rounded border border-blue-100 uppercase tracking-widest">{data?.total || 0} Total</span>
            </div>

            <form onSubmit={handleSearchSubmit} className="flex items-center gap-2">
              <div className="relative">
                <Search className="w-4 h-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-stone-400" />
                <Input
                  placeholder="Search cold accounts..."
                  className="pl-9 h-9 w-64 text-xs font-medium border-stone-200 bg-stone-50 focus-visible:ring-blue-500"
                  value={searchInput}
                  onChange={(e) => setSearchInput(e.target.value)}
                />
              </div>
            </form>
          </div>

          <div className="overflow-x-auto min-h-[300px]">
            <table className="w-full text-left text-sm whitespace-nowrap">
              <thead className="bg-stone-50 text-stone-500 text-xs uppercase font-bold tracking-widest border-b border-stone-200">
                <tr>
                  <th className="px-6 py-3 font-bold">Account</th>
                  <th className="px-6 py-3 font-bold">Score</th>
                  <th className="px-6 py-3 font-bold">Engagement</th>
                  <th className="px-6 py-3 font-bold">Monitored</th>
                  <th className="px-4 py-3 w-[80px]"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-100">
                {isError ? (
                  <tr>
                    <td colSpan={5} className="px-6 py-12 text-center text-rose-500">
                      Error loading accounts.
                    </td>
                  </tr>
                ) : isLoading ? (
                  Array.from({ length: 5 }).map((_, i) => (
                    <tr key={i}>
                      <td className="px-6 py-4"><Skeleton className="h-4 w-32" /></td>
                      <td className="px-6 py-4"><Skeleton className="h-4 w-8" /></td>
                      <td className="px-6 py-4"><Skeleton className="h-4 w-40" /></td>
                      <td className="px-6 py-4"><Skeleton className="h-4 w-24" /></td>
                      <td className="px-4 py-4"></td>
                    </tr>
                  ))
                ) : (data?.accounts || []).length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-6 py-12 text-center">
                      <Building2 className="w-8 h-8 text-stone-300 mx-auto mb-3" />
                      <p className="text-sm font-bold text-stone-900">No cold accounts found</p>
                      <p className="text-xs text-stone-500 mt-1">Try adjusting your search.</p>
                    </td>
                  </tr>
                ) : (
                  (data?.accounts || []).map((account: any, i: number) => {
                    const signalCount = account.canonicalCategoryIntent?.signalCount
                      ?? (account.contributions || []).filter((item: any) => item.key !== "breadth_bonus").reduce((sum: number, item: any) => sum + Number(item.signalCount || 0), 0);

                    return (
                      <tr key={account.id || i} className="hover:bg-stone-50 group cursor-pointer transition-colors" onClick={() => setLocation(`/intent/accounts/${account.id}`)}>
                        <td className="px-6 py-4">
                          <div className="font-bold text-[13px] text-stone-900">{account.name}</div>
                          <div className="text-[11px] font-medium text-stone-500 mt-0.5 truncate max-w-[200px]">{account.industry || "Unknown Industry"}</div>
                        </td>
                        <td className="px-6 py-4">
                          <div className="flex items-center gap-2">
                            <span className="font-black text-base text-stone-900">{account.score || 0}</span>
                            <span className="bg-stone-100 text-stone-600 px-1.5 py-0.5 text-[9px] font-bold uppercase rounded">Cold</span>
                          </div>
                        </td>
                        <td className="px-6 py-4">
                          <div className="flex items-center gap-4 text-xs">
                            <div className="flex items-center gap-1.5 text-stone-600 font-medium">
                              <Activity className="w-3.5 h-3.5 text-stone-400" />
                              {signalCount} signals
                            </div>
                            <div className="flex items-center gap-1.5 text-stone-600 font-medium">
                              <Users className="w-3.5 h-3.5 text-stone-400" />
                              {(account.contacts || []).length} contacts
                            </div>
                          </div>
                        </td>
                        <td className="px-6 py-4">
                          <span
                            title={account.lastResearchedAt ? `Last monitored ${formatReportDateTime(account.lastResearchedAt)}` : "This account has not been monitored yet"}
                            className="cursor-help text-[11px] font-semibold text-stone-500 underline decoration-dotted underline-offset-4"
                          >
                            {account.lastResearchedAt ? formatReportDate(account.lastResearchedAt) : "Not yet"}
                          </span>
                        </td>
                        <td className="px-4 py-4 text-right">
                          <Button variant="ghost" size="icon" className="w-8 h-8 rounded-full opacity-0 group-hover:opacity-100 transition-opacity" asChild>
                            <Link href={`/intent/accounts/${account.id}`}>
                              <ChevronRight className="w-4 h-4 text-stone-400" />
                            </Link>
                          </Button>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
          {!isLoading && !isError && (data?.totalPages || 0) > 1 && (
            <div className="flex items-center justify-between gap-4 border-t border-stone-200 px-4 py-3">
              <p className="text-xs font-medium text-stone-500">
                Page {page} of {data?.totalPages} · {data?.total} accounts
              </p>
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => goToPage(page - 1)}>
                  <ChevronLeft className="mr-1 h-4 w-4" /> Previous
                </Button>
                <Button variant="outline" size="sm" disabled={page >= (data?.totalPages || 1)} onClick={() => goToPage(page + 1)}>
                  Next <ChevronRight className="ml-1 h-4 w-4" />
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
