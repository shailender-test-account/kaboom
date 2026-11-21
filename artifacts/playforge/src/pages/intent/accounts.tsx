import { useEffect, useState } from "react";
import { Link, useLocation, useSearch } from "wouter";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useIntentAccountBatches as useIntentAccounts } from "@/hooks/use-intent";
import { IntentPageHeader, TierBadge } from "@/components/intent/ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Search, ChevronRight, Activity, Users, Building2 } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { getScopeParams, buildScopeQs, INTENT_CATEGORY_NAMES } from "@/lib/intent-scope";
import { cn } from "@/lib/utils";
import { formatReportDate, formatReportDateTime } from "@/lib/reportTime";

const CATEGORY_CARDS = [
  { key: "it-hardware", label: INTENT_CATEGORY_NAMES[0], image: "/images/intent-categories/computers.png" },
  { key: "business-collaboration", label: INTENT_CATEGORY_NAMES[1], image: "/images/intent-categories/poly-collaboration.png" },
  { key: "security", label: INTENT_CATEGORY_NAMES[2], image: "/images/intent-categories/software-services.png" },
  { key: "business-services", label: INTENT_CATEGORY_NAMES[3], image: "/images/intent-categories/software-services.png" },
] as const;

export default function IntentAccountsPage() {
  const [location, setLocation] = useLocation();
  const search = useSearch();
  const searchParams = new URLSearchParams(search);
  const scopeParams = getScopeParams(searchParams);
  const qs = buildScopeQs(scopeParams);
  
  const [searchInput, setSearchInput] = useState(scopeParams.search || "");
  const debouncedSearch = useDebouncedValue(searchInput.trim());
  useEffect(() => setSearchInput(scopeParams.search || ""), [scopeParams.search]);
  useEffect(() => {
    if (debouncedSearch === (scopeParams.search || "")) return;
    const nextScope: Record<string, any> = { ...scopeParams, search: debouncedSearch };
    delete nextScope.page;
    const nextQs = buildScopeQs(nextScope);
    setLocation(`${location}${nextQs ? `?${nextQs}` : ""}`);
  }, [debouncedSearch]);
  const apiParams = {
    ...scopeParams,
    page: Number(scopeParams.page) || 1,
    pageSize: 5,
    sortBy: "score",
    sortDir: "desc",
  };
  
  const { data, isLoading, isError,hasNextPage,fetchNextPage,isFetchingNextPage,refetch } = useIntentAccounts(apiParams);
  const overview=data?.batchSummary,overviewLoading=isLoading;
  const selectedCategoryName = String(scopeParams.categoryName || "");
  const categoryCards = CATEGORY_CARDS;
  
  const totalAccounts = data?.total || 0;
  
  const hotCount = overview?.hotAccounts || 0;
  const warmCount = overview?.tierBreakdown?.find((t: any) => t.tierKey === "warm")?.count || 0;
  const coldCount = overview?.tierBreakdown?.find((t: any) => t.tierKey === "cold")?.count || 0;
  const hotMin = overview?.tierThresholds?.find(t => t.key === "hot")?.minScore;
  const warmMin = overview?.tierThresholds?.find(t => t.key === "warm")?.minScore;

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const nextScope = { ...scopeParams };
    if (searchInput.trim()) {
      nextScope.search = searchInput.trim();
    } else {
      delete nextScope.search;
    }
    delete nextScope.page;
    const nextQs = buildScopeQs(nextScope);
    setLocation(`${location}${nextQs ? `?${nextQs}` : ""}`);
  };


  const handleCategoryClick = (categoryName: string) => {
    const nextScope = { ...scopeParams };
    nextScope.categoryName = categoryName;
    delete nextScope.categoryIds;
    delete nextScope.subcategoryIds;
    delete nextScope.productId;
    delete nextScope.page;
    setLocation(`${location}?${buildScopeQs(nextScope)}`);
  };

  const clearCategory = () => {
    const nextScope = { ...scopeParams };
    delete nextScope.categoryName;
    delete nextScope.categoryIds;
    delete nextScope.subcategoryIds;
    delete nextScope.productId;
    delete nextScope.page;
    setLocation(`${location}?${buildScopeQs(nextScope)}`);
  };

  return (
    <div className="flex flex-col min-h-full font-sans text-stone-900">
      <IntentPageHeader 
        title="Account opportunity map"
        breadcrumbs={`${totalAccounts} LOADED ACCOUNTS`}
      />
      
      <div className="p-6 max-w-[1200px] mx-auto w-full space-y-6">
        
        {/* Opportunity lens */}
        <div className="bg-white rounded-xl border border-stone-200 p-5 shadow-sm">
          <div className="flex flex-col gap-4">
            <div>
              <div className="text-[10px] font-bold tracking-widest uppercase text-stone-500 mb-1">Opportunity lens</div>
              <h2 className="text-base font-bold text-stone-900">Find the strongest account × category match</h2>
              <p className="text-xs font-medium text-stone-500 mt-1">
                Choose a category to see every relevant account ranked from Hot to Cold. Product-level detail remains inside each account.
              </p>
            </div>
            <div>
              <div className="mb-2 flex items-center justify-between gap-3">
                <span className="text-[10px] font-black uppercase tracking-widest text-stone-400">Choose a category</span>
                {selectedCategoryName && (
                  <button type="button" onClick={clearCategory} className="text-[9px] font-black uppercase tracking-widest text-stone-400 hover:text-stone-700">
                    Clear category
                  </button>
                )}
              </div>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {categoryCards.map(card => {
                  const selected = selectedCategoryName === card.label;
                  return (
                    <button
                      key={card.key}
                      type="button"
                      data-testid={`account-category-card-${card.key}`}
                      aria-pressed={selected}
                      onClick={() => handleCategoryClick(card.label)}
                      className={cn(
                        "group overflow-hidden rounded-lg border bg-white text-left transition-all",
                        selected ? "border-emerald-600 ring-2 ring-emerald-100 shadow-sm" : "border-stone-200 hover:border-stone-400 hover:shadow-sm",
                      )}
                    >
                      <div className="aspect-[202/112] overflow-hidden bg-stone-100">
                        <img src={card.image} alt="" className="h-full w-full object-cover object-top transition-transform duration-300 group-hover:scale-[1.02]" />
                      </div>
                      <div className="flex items-center justify-between gap-2 px-2.5 py-2">
                        <span className="text-[10px] font-black leading-tight text-stone-800 sm:text-[11px]">{card.label}</span>
                        <span className={cn("h-2.5 w-2.5 shrink-0 rounded-full border", selected ? "border-emerald-600 bg-emerald-600" : "border-stone-300 bg-white")} />
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        </div>

        {/* Stats summary */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="bg-white rounded-xl border border-stone-200 p-5 shadow-sm">
            <div className="flex items-center gap-1.5 mb-2">
              <div className="w-2 h-2 rounded-full bg-rose-500" />
              <span className="text-xs font-bold text-stone-700">Hot</span>
            </div>
            <div className="text-3xl font-black text-stone-900 tracking-tight">{overviewLoading ? "-" : hotCount}</div>
            <div className="text-[10px] font-medium text-stone-400 mt-2">{hotMin == null ? "Configured Hot tier" : `≥${hotMin}`} · act within 48 hours</div>
          </div>
          <div className="bg-white rounded-xl border border-stone-200 p-5 shadow-sm">
            <div className="flex items-center gap-1.5 mb-2">
              <div className="w-2 h-2 rounded-full bg-amber-500" />
              <span className="text-xs font-bold text-stone-700">Warm</span>
            </div>
            <div className="text-3xl font-black text-stone-900 tracking-tight">{overviewLoading ? "-" : warmCount}</div>
            <div className="text-[10px] font-medium text-stone-400 mt-2">{warmMin == null || hotMin == null ? "Configured Warm tier" : `${warmMin}–${hotMin - 1}`} · nurture and monitor</div>
          </div>
          <div className="bg-white rounded-xl border border-stone-200 p-5 shadow-sm">
            <div className="flex items-center gap-1.5 mb-2">
              <div className="w-2 h-2 rounded-full bg-stone-500" />
              <span className="text-xs font-bold text-stone-700">Monitor</span>
            </div>
            <div className="text-3xl font-black text-stone-900 tracking-tight">{overviewLoading ? "-" : coldCount}</div>
            <div className="text-[10px] font-medium text-stone-400 mt-2">{warmMin == null ? "Below Warm" : `<${warmMin}`} · watch for confirmation</div>
          </div>
        </div>

        {/* Table */}
        <div className="bg-white rounded-xl border border-stone-200 shadow-sm overflow-hidden flex flex-col">
          <div className="p-4 border-b border-stone-200 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div className="flex items-center gap-2">
              <h3 className="font-bold text-sm text-stone-900">Accounts to act on</h3>
              <span className="bg-emerald-50 text-emerald-700 text-[10px] font-bold px-1.5 py-0.5 rounded border border-emerald-100 uppercase tracking-widest">Live</span>
            </div>
            
            <form onSubmit={handleSearchSubmit} className="flex items-center gap-2">
              <div className="relative">
                <Search className="w-4 h-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-stone-400" />
                <Input 
                  placeholder="Search account..." 
                  className="pl-9 h-9 w-64 text-xs font-medium border-stone-200 bg-stone-50 focus-visible:ring-emerald-500"
                  value={searchInput}
                  onChange={(e) => setSearchInput(e.target.value)}
                />
              </div>
              <Button type="submit" variant="outline" className="h-9 text-xs">Search</Button>
            </form>
          </div>
          
          <div className="overflow-x-auto min-h-[300px]">
            <table className="w-full text-left text-sm whitespace-nowrap">
              <thead className="bg-stone-50 text-stone-500 text-xs uppercase font-bold tracking-widest border-b border-stone-200">
                <tr>
                  <th className="px-6 py-3 font-bold">Account</th>
                   <th className="px-6 py-3 font-bold">Priority Category</th>
                  <th className="px-6 py-3 font-bold">Status</th>
                  <th className="px-6 py-3 font-bold">Score</th>
                  <th className="px-6 py-3 font-bold">Engagement</th>
                  <th className="px-6 py-3 font-bold">Monitored</th>
                  <th className="px-4 py-3 w-[80px]"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-100">
                {isError ? (
                  <tr>
                    <td colSpan={7} className="px-6 py-12 text-center text-rose-500">
                      Error loading accounts.
                    </td>
                  </tr>
                ) : isLoading ? (
                  Array.from({ length: 5 }).map((_, i) => (
                    <tr key={i}>
                      <td className="px-6 py-4"><Skeleton className="h-4 w-32" /></td>
                      <td className="px-6 py-4"><Skeleton className="h-4 w-24" /></td>
                      <td className="px-6 py-4"><Skeleton className="h-4 w-16" /></td>
                      <td className="px-6 py-4"><Skeleton className="h-4 w-8" /></td>
                      <td className="px-6 py-4"><Skeleton className="h-4 w-40" /></td>
                      <td className="px-4 py-4"></td>
                    </tr>
                  ))
                ) : (data?.accounts || []).length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-6 py-12 text-center">
                      <Building2 className="w-8 h-8 text-stone-300 mx-auto mb-3" />
                      <p className="text-sm font-bold text-stone-900">{hasNextPage?"No matches in this batch — load more to continue":"No accounts found"}</p>
                      <p className="text-xs text-stone-500 mt-1">Try adjusting your filters or search.</p>
                    </td>
                  </tr>
                ) : (
                  (data?.accounts || []).map((account: any, i: number) => {
                    const hottestCategory = account.intentStatus?.categories?.find((category: any) => category.status === "hot")
                      ?? account.intentStatus?.categories?.find((category: any) => category.status === "warm");
                    const topCategory = selectedCategoryName
                      ? selectedCategoryName
                      : hottestCategory?.name || account.productAnalysis?.bestProduct?.category || "Needs evidence";
                    const signalCount = account.canonicalCategoryIntent?.signalCount
                      ?? (account.contributions || []).filter((item: any) => item.key !== "breadth_bonus").reduce((sum: number, item: any) => sum + Number(item.signalCount || 0), 0);
                    
                    return (
                      <tr key={account.id || i} className="hover:bg-stone-50 group cursor-pointer transition-colors" onClick={() => setLocation(`/intent/accounts/${account.id}${qs ? `?${qs}` : ''}`)}>
                        <td className="px-6 py-4">
                          <div className="font-bold text-[13px] text-stone-900">{account.name}</div>
                          <div className="text-[11px] font-medium text-stone-500 mt-0.5 truncate max-w-[200px]">{account.industry || "Unknown Industry"}</div>
                        </td>
                        <td className="px-6 py-4">
                          <div className="inline-flex items-center px-2 py-1 rounded bg-stone-100 text-stone-700 text-[10px] font-bold border border-stone-200 truncate max-w-[150px]">
                             {topCategory}
                          </div>
                        </td>
                        <td className="px-6 py-4">
                          <div className="flex flex-col items-start gap-1">
                            <TierBadge tier={account.intentStatus?.accountStatus || account.tierLabel || "Monitor"} />
                            {account.intentStatus?.accountFlag === "category_open" && (
                              <span className="rounded border border-violet-200 bg-violet-50 px-1.5 py-0.5 text-[8px] font-black uppercase tracking-widest text-violet-700">Category open</span>
                            )}
                          </div>
                        </td>
                        <td className="px-6 py-4">
                          <div className="flex items-center gap-2">
                            <span className="font-black text-base text-stone-900">{account.score || 0}</span>
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
                            <Link href={`/intent/accounts/${account.id}${qs ? `?${qs}` : ''}`}>
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
          {!isLoading && (
            <div className="flex items-center justify-between gap-4 border-t border-stone-200 px-4 py-3">
              <p className="text-xs font-medium text-stone-500">
                {data?.total??0} accounts loaded · Counts and intent ranking cover loaded batches only.
                {isError?" Could not load this batch. Try again.":""}
              </p>
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" disabled={(!hasNextPage&&!isError)||isFetchingNextPage} onClick={() => hasNextPage?fetchNextPage():refetch()}>
                  {isFetchingNextPage?"Loading…":isError?"Retry":"Load more"} <ChevronRight className="ml-1 h-4 w-4" />
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}