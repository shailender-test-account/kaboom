import { useState } from "react";
import { useIntentScopeOptions, useIntentAccountBatches as useIntentAccounts } from "@/hooks/use-intent";
import { Link, useLocation, useSearch } from "wouter";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { IntentPageHeader, TierBadge } from "@/components/intent/ui";
import { Button } from "@/components/ui/button";
import { Search, ChevronDown, Check, ArrowRight, Activity, TrendingUp, AlertCircle, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAuthContext } from "@/contexts/AuthContext";
import { Skeleton } from "@/components/ui/skeleton";
import { INTENT_CATEGORY_NAMES } from "@/lib/intent-scope";
import { formatReportDate } from "@/lib/reportTime";

const CATEGORY_CARDS = [
  { key: "it-hardware", label: INTENT_CATEGORY_NAMES[0], categoryName: INTENT_CATEGORY_NAMES[0], image: "/images/intent-categories/computers.png" },
  { key: "business-collaboration", label: INTENT_CATEGORY_NAMES[1], categoryName: INTENT_CATEGORY_NAMES[1], image: "/images/intent-categories/poly-collaboration.png" },
  { key: "security", label: INTENT_CATEGORY_NAMES[2], categoryName: INTENT_CATEGORY_NAMES[2], image: "/images/intent-categories/software-services.png" },
  { key: "business-services", label: INTENT_CATEGORY_NAMES[3], categoryName: INTENT_CATEGORY_NAMES[3], image: "/images/intent-categories/software-services.png" },
] as const;

export default function IntentPage() {
  const [location, setLocation] = useLocation();
  const search = useSearch();
  const searchParams = new URLSearchParams(search);
  const legacyCategoryId = searchParams.get("category") || searchParams.get("categories");
  const initialCategoryName = searchParams.get("categoryName")
    || (legacyCategoryId && /^\d+$/.test(legacyCategoryId) ? `legacy:${legacyCategoryId}` : "all");

  const [draftClientId, setDraftClientId] = useState(searchParams.get("client") || "all");
  const [draftAudienceId, setDraftAudienceId] = useState(searchParams.get("audience") ? `audience:${searchParams.get("audience")}` : searchParams.get("segment") ? `segment:${searchParams.get("segment")}` : searchParams.get("account") ? `account:${searchParams.get("account")}` : "all");
  const [draftCategoryName, setDraftCategoryName] = useState(initialCategoryName);

  const [searchInput, setSearchInput] = useState(searchParams.get("search") || "");
  const debouncedSearch = useDebouncedValue(searchInput.trim());
  const { data: scopeOptions } = useIntentScopeOptions();
  const applyScope = () => {
    const p = new URLSearchParams();
    if (draftClientId !== "all") p.set("client", draftClientId);
    if (draftAudienceId !== "all") {
      if (draftAudienceId.startsWith("audience:")) {
        p.set("audience", draftAudienceId.split(":")[1]);
      } else if(draftAudienceId.startsWith("segment:")){
        p.set("segment",draftAudienceId.split(":")[1]);
      } else if(draftAudienceId.startsWith("account:")){
        p.set("account",draftAudienceId.split(":")[1]);
      }
    }
    if (draftCategoryName.startsWith("legacy:")) p.set("category", draftCategoryName.slice("legacy:".length));
    else if (draftCategoryName !== "all") p.set("categoryName", draftCategoryName);

    setLocation(`/intent${p.size ? `?${p.toString()}` : ""}`);
  };

  const activeClientId = searchParams.get("client") || undefined;
  const activeAudienceId = searchParams.get("audience") || undefined;
  const activeSegmentId = searchParams.get("segment") || undefined;
  const activeAccountId = searchParams.get("account") || undefined;
  const activeCategoryId = legacyCategoryId && /^\d+$/.test(legacyCategoryId) ? legacyCategoryId : undefined;
  const activeCategoryName = searchParams.get("categoryName") || undefined;

  const apiParams = {
    search: debouncedSearch || undefined,
    tier: "hot,warm", // FORCE ONLY HOT/WARM for Command Center
    clientId: activeClientId,
    audienceId: activeAudienceId,
    segmentId: activeSegmentId,
    accountId: activeAccountId,
    categoryIds: activeCategoryId,
    categoryName: activeCategoryName,
    page: 1,
    pageSize: 5,
  };

  const { data: accountsData, isLoading: accountsLoading,hasNextPage,fetchNextPage,isFetchingNextPage,isError,refetch } = useIntentAccounts(apiParams);
  const overview=accountsData?.batchSummary,overviewLoading=accountsLoading;

  const { user } = useAuthContext();
  const firstName = user?.firstName || "Saurabh";

  const totalAccounts = overview?.totalAccounts || 0;
  const hotAccounts = overview?.hotAccounts || 0;
  const warmAccounts = overview?.tierBreakdown?.find((t: any) => t.tierKey === "warm")?.count || 0;
  const coldAccounts = overview?.tierBreakdown?.find((t: any) => t.tierKey === "cold")?.count || 0;
  const activeSignals = overview?.activeSignals30d || 0;

  return (
    <div className="flex flex-col min-h-full font-sans bg-[#F6F7F5]">
      {/* Top Header */}
      <div className="flex items-center justify-between px-8 py-5 border-b border-stone-200 bg-white">
        <div>
          <h2 className="text-[10px] font-bold text-stone-400 tracking-widest uppercase mb-1">Intent Engine / Overview</h2>
          <h1 className="text-lg font-bold text-stone-900">Autonomous GTM OS</h1>
        </div>
        <div className="flex items-center gap-3">
          <Button variant="outline" className="h-9 px-4 text-xs font-bold border-stone-200 text-stone-700 bg-white">
            Export
          </Button>
          <Button className="h-9 px-4 text-xs font-bold bg-[#0F2B20] text-white hover:bg-[#1a4a38]">
            <Activity className="w-3.5 h-3.5 mr-2 text-[#bef264]" />
            Run signal scan
          </Button>
        </div>
      </div>

      <div className="p-8 max-w-[1400px] mx-auto w-full space-y-6">
        {/* Welcome & Stats Row */}
        <div>
          <div className="flex items-center justify-between mb-6">
            <div>
              <h2 className="text-2xl font-bold text-stone-900 tracking-tight">Good morning, {firstName}.</h2>
              <p className="text-sm font-medium text-stone-500 mt-1">Here's where buying momentum is building across your target market.</p>
            </div>
            <div className="flex items-center gap-2 text-xs font-semibold text-stone-500 bg-white px-3 py-1.5 rounded-full border border-stone-200 shadow-sm">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
              Web intelligence synced 8 min ago
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <StatCard title="Loaded accounts" value={totalAccounts.toLocaleString()} isLoading={overviewLoading} />
            <StatCard title="High intent (loaded)" value={hotAccounts.toLocaleString()} isLoading={overviewLoading} />
            <StatCard title="Warm accounts (loaded)" value={warmAccounts.toLocaleString()} isLoading={overviewLoading} />
            <StatCard title="Signals (loaded)" value={activeSignals.toLocaleString()} isLoading={overviewLoading} />
          </div>
        </div>

        {/* Define Intelligence Scope */}
        <div className="bg-[#0F2B20] rounded-[16px] p-6 text-white shadow-lg relative overflow-hidden">
          <div className="absolute top-0 right-0 w-64 h-64 bg-[#bef264]/10 rounded-full blur-3xl -translate-y-1/2 translate-x-1/3" />

          <div className="flex items-center justify-between mb-5 relative z-10">
            <div>
              <h3 className="text-base font-bold text-white mb-1">Define intelligence scope</h3>
              <p className="text-xs text-[#8BAA9D] font-medium">Choose a client, audience and product category to reprioritize the account universe.</p>
            </div>
            <div className="flex items-center gap-2 text-xs font-semibold text-[#8BAA9D]">
              <span className="w-1.5 h-1.5 rounded-full bg-[#bef264]" />
              6 data sources active
            </div>
          </div>

          <div className="flex flex-col md:flex-row gap-4 items-end relative z-10">
             <div className="flex-1 w-full space-y-1.5">
              <label className="text-[10px] font-bold tracking-widest uppercase text-[#548A6F]">Client</label>
              <select
                value={draftClientId}
                onChange={e => { setDraftClientId(e.target.value); setDraftAudienceId("all"); }}
                className="w-full h-10 px-3 bg-[#153a2b] border border-[#1a4a38] text-sm text-white font-semibold rounded-lg focus:outline-none focus:border-[#bef264] appearance-none"
              >
                <option value="all">Global Pipeline</option>
                {scopeOptions?.clients?.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>

            <div className="flex-1 w-full space-y-1.5">
              <label className="text-[10px] font-bold tracking-widest uppercase text-[#548A6F]">Target Audience</label>
              <select
                data-testid="select-audience-scope"
                value={draftAudienceId}
                onChange={e => {
                  const value=e.target.value;
                  setDraftAudienceId(value);
                  if(value.startsWith("audience:")){
                    const selected=scopeOptions?.audiences.find(item=>item.id===Number(value.split(":")[1]));
                    if(selected?.clientId)setDraftClientId(String(selected.clientId));
                  }
                  if(value.startsWith("account:")){
                    const selected=scopeOptions?.accounts.find(item=>item.id===Number(value.split(":")[1]));
                    if(selected?.clientId)setDraftClientId(String(selected.clientId));
                  }
                }}
                className="w-full h-10 px-3 bg-[#153a2b] border border-[#1a4a38] text-sm text-white font-semibold rounded-lg focus:outline-none focus:border-[#bef264] appearance-none"
              >
                <option value="all">All Accounts</option>
                {!!scopeOptions?.audiences?.length&&<optgroup label="Databases / audiences">{scopeOptions.audiences.map(a => <option key={a.id} value={`audience:${a.id}`}>{a.name}</option>)}</optgroup>}
                {!!scopeOptions?.segments?.length&&<optgroup label="Databases / CRM segments">{scopeOptions.segments.map(s => <option key={s.id} value={`segment:${s.id}`}>{s.name} ({(s.memberCount||0).toLocaleString()})</option>)}</optgroup>}
                {!!scopeOptions?.accounts?.length&&<optgroup label="Individual accounts">{scopeOptions.accounts.map(a => <option key={a.id} value={`account:${a.id}`}>{a.name}{a.domain?` — ${a.domain}`:""}</option>)}</optgroup>}
              </select>
            </div>

            <div className="flex-1 w-full space-y-1.5">
              <label className="text-[10px] font-bold tracking-widest uppercase text-[#548A6F]">Category</label>
              <select
                data-testid="select-category-scope"
                value={draftCategoryName}
                onChange={e => setDraftCategoryName(e.target.value)}
                className="w-full h-10 px-3 bg-[#153a2b] border border-[#1a4a38] text-sm text-white font-semibold rounded-lg focus:outline-none focus:border-[#bef264] appearance-none"
              >
                <option value="all">All Categories</option>
                {draftCategoryName.startsWith("legacy:") && (
                  <option value={draftCategoryName}>
                    {scopeOptions?.categories?.find(category => String(category.id) === draftCategoryName.slice("legacy:".length))?.name || "Legacy category filter"}
                  </option>
                )}
                {INTENT_CATEGORY_NAMES.map(category => <option key={category} value={category}>{category}</option>)}
              </select>
            </div>

            <Button
              data-testid="button-apply-intent-scope"
              onClick={applyScope}
              className="h-10 px-6 bg-[#bef264] hover:bg-[#a3e635] text-[#0B2118] font-bold rounded-lg shrink-0"
            >
              Apply scope
            </Button>
          </div>

          <div className="mt-5 grid grid-cols-2 gap-3 md:grid-cols-4 relative z-10">
              {CATEGORY_CARDS.map(card => {
                const selected = card.categoryName === draftCategoryName;
                return (
                  <button
                    key={card.key}
                    type="button"
                    data-testid={`category-card-${card.key}`}
                    aria-pressed={selected}
                    onClick={() => setDraftCategoryName(card.categoryName)}
                    className={cn(
                      "overflow-hidden rounded-xl border text-left transition-all",
                      selected ? "border-[#bef264] ring-2 ring-[#bef264]/30" : "border-[#2b5845] hover:border-[#8bad9e]",
                    )}
                  >
                    <img src={card.image} alt="" className="aspect-[202/80] w-full object-cover object-top" />
                    <span className="flex items-center justify-between gap-2 bg-[#153a2b] px-3 py-2 text-[11px] font-bold text-white">
                      {card.label}
                      <span className={cn("h-2.5 w-2.5 rounded-full border", selected ? "border-[#bef264] bg-[#bef264]" : "border-[#8BAA9D]")} />
                    </span>
                  </button>
                );
              })}
          </div>
        </div>

        {/* Charts Row */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 bg-white rounded-xl border border-stone-200 p-6 shadow-sm flex flex-col justify-between">
            <div className="flex items-center justify-between mb-6">
              <div>
                <h3 className="text-sm font-bold text-stone-900">Intent momentum</h3>
                <p className="text-[11px] font-medium text-stone-500 mt-1">Accounts moving through the buying-intent tiers</p>
              </div>
              <a href="#" className="text-xs font-bold text-stone-600 flex items-center hover:text-stone-900">
                View methodology <ArrowRight className="w-3 h-3 ml-1" />
              </a>
            </div>

            <div className="flex gap-8 items-center">
              <div className="flex-1 space-y-4">
                <MomentumBar label="Hot" range="80-100" desc="Active buying window" count={hotAccounts} color="bg-rose-500" total={totalAccounts} />
                <MomentumBar label="Warm" range="55-79" desc="Growing intent" count={warmAccounts} color="bg-amber-400" total={totalAccounts} />
                <div className="flex items-center gap-3">
                  <div className="w-24 text-[11px] font-semibold text-stone-500 flex justify-between pr-2">
                    <span>Watch</span> <span>35-54</span>
                  </div>
                  <div className="flex-1 h-8 bg-stone-100 rounded flex items-center px-3 relative overflow-hidden group cursor-pointer" onClick={() => setLocation('/intent/cold-accounts')}>
                    <div className="absolute inset-0 bg-blue-100 transition-all" style={{ width: `${Math.max(15, (coldAccounts / Math.max(1, totalAccounts)) * 100)}%` }} />
                    <span className="relative z-10 text-[11px] font-bold text-blue-700">Early signals</span>
                  </div>
                  <div className="w-8 text-right text-sm font-bold text-stone-900">{coldAccounts}</div>
                </div>
              </div>

              <div className="w-[240px] bg-stone-50 rounded-xl p-4 border border-stone-100">
                <h4 className="text-xs font-bold text-stone-900 mb-2">Momentum is accelerating</h4>
                <p className="text-[11px] text-stone-500 font-medium leading-relaxed mb-3">
                  14 accounts crossed into High Intent this week. Hiring, infrastructure investment and device-refresh signals are driving the change.
                </p>
                <div className="flex items-center gap-3 text-[10px] font-bold text-stone-500">
                  <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-rose-500" /> Hot</span>
                  <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-amber-400" /> Warm</span>
                  <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-blue-300" /> Watch</span>
                </div>
              </div>
            </div>
          </div>

          <div className="bg-white rounded-xl border border-stone-200 p-6 shadow-sm">
            <div className="flex items-center justify-between mb-6">
              <div>
                <h3 className="text-sm font-bold text-stone-900">Signal mix</h3>
                <p className="text-[11px] font-medium text-stone-500 mt-1">What is driving account scores</p>
              </div>
              <button className="text-xs font-bold text-stone-600 flex items-center hover:text-stone-900">
                30 days <ChevronDown className="w-3 h-3 ml-1" />
              </button>
            </div>

            <div className="flex items-center gap-6">
              <div className="relative w-28 h-28 shrink-0">
                {/* Simulated Donut */}
                <svg viewBox="0 0 100 100" className="w-full h-full transform -rotate-90">
                  <circle cx="50" cy="50" r="40" fill="transparent" stroke="#f5f5f4" strokeWidth="12" />
                  <circle cx="50" cy="50" r="40" fill="transparent" stroke="#3b82f6" strokeWidth="12" strokeDasharray="251.2" strokeDashoffset={251.2 * (1 - 0.37)} />
                  <circle cx="50" cy="50" r="40" fill="transparent" stroke="#ef4444" strokeWidth="12" strokeDasharray="251.2" strokeDashoffset={251.2 * (1 - 0.21)} strokeDashoffset-init={251.2 * (1 - 0.37)} className="origin-center" style={{ transform: 'rotate(133deg)' }} />
                  <circle cx="50" cy="50" r="40" fill="transparent" stroke="#f59e0b" strokeWidth="12" strokeDasharray="251.2" strokeDashoffset={251.2 * (1 - 0.15)} className="origin-center" style={{ transform: 'rotate(209deg)' }} />
                  <circle cx="50" cy="50" r="40" fill="transparent" stroke="#10b981" strokeWidth="12" strokeDasharray="251.2" strokeDashoffset={251.2 * (1 - 0.12)} className="origin-center" style={{ transform: 'rotate(263deg)' }} />
                </svg>
                <div className="absolute inset-0 flex flex-col items-center justify-center">
                  <span className="text-lg font-black text-stone-900 leading-none">{activeSignals.toLocaleString()}</span>
                  <span className="text-[9px] font-bold text-stone-400 tracking-widest uppercase mt-0.5">Signals</span>
                </div>
              </div>

              <div className="flex-1 space-y-2">
                <SignalLegend label="Tech investment" color="bg-blue-500" pct="37%" />
                <SignalLegend label="Hiring patterns" color="bg-rose-500" pct="21%" />
                <SignalLegend label="News & filings" color="bg-amber-500" pct="15%" />
                <SignalLegend label="Leadership activity" color="bg-emerald-500" pct="12%" />
                <SignalLegend label="Other" color="bg-stone-300" pct="15%" />
              </div>
            </div>
          </div>
        </div>

        {/* Priority Accounts Table */}
        <div className="bg-white rounded-xl border border-stone-200 shadow-sm overflow-hidden">
          <div className="p-4 border-b border-stone-200 flex items-center justify-between">
            <div>
              <h3 className="text-sm font-bold text-stone-900">Priority accounts</h3>
              <p className="text-[11px] font-medium text-stone-500 mt-1">Ranked by intent, fit and signal recency for selected scope</p>
            </div>
            <div className="flex items-center gap-3">
              <div className="relative">
                <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-stone-400" />
                <input
                  type="text"
                  placeholder="Search accounts..."
                  value={searchInput}
                  onChange={e => setSearchInput(e.target.value)}
                  className="pl-9 pr-3 py-1.5 h-8 w-48 text-xs font-semibold bg-stone-50 border border-stone-200 rounded-md focus:outline-none focus:ring-1 focus:ring-emerald-500"
                />
              </div>
              <button className="h-8 px-3 text-xs font-bold text-stone-700 bg-white border border-stone-200 rounded-md flex items-center gap-1.5">
                All tiers <ChevronDown className="w-3 h-3 text-stone-400" />
              </button>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left whitespace-nowrap">
              <thead className="bg-stone-50 border-b border-stone-200">
                <tr className="text-[9px] font-bold text-stone-400 uppercase tracking-widest">
                  <th className="px-5 py-3">Account</th>
                  <th className="px-4 py-3">Intent</th>
                  <th className="px-4 py-3">Best-fit product</th>
                  <th className="px-4 py-3">Why now</th>
                  <th className="px-4 py-3 text-center">Evidence</th>
                  <th className="px-4 py-3 text-center">Contacts</th>
                  <th className="px-4 py-3">Last signal</th>
                  <th className="px-4 py-3"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-100">
                {accountsLoading ? (
                  Array.from({ length: 4 }).map((_, i) => (
                    <tr key={i}>
                      <td className="px-5 py-4"><Skeleton className="h-4 w-32 mb-1" /><Skeleton className="h-3 w-20" /></td>
                      <td className="px-4 py-4"><Skeleton className="h-6 w-16 rounded-full" /></td>
                      <td className="px-4 py-4"><Skeleton className="h-4 w-24 mb-1" /><Skeleton className="h-3 w-16" /></td>
                      <td className="px-4 py-4"><Skeleton className="h-8 w-64" /></td>
                      <td className="px-4 py-4"><Skeleton className="h-6 w-16 mx-auto" /></td>
                      <td className="px-4 py-4"><Skeleton className="h-6 w-16 mx-auto" /></td>
                      <td className="px-4 py-4"><Skeleton className="h-4 w-20" /></td>
                      <td className="px-4 py-4"><Skeleton className="h-8 w-16 ml-auto" /></td>
                    </tr>
                  ))
                ) : accountsData?.accounts?.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="px-6 py-12 text-center text-sm font-medium text-stone-500">
                      {hasNextPage?"No high-priority matches in this batch. Load more to check the next accounts.":"No high-priority accounts found in this scope."}
                    </td>
                  </tr>
                ) : (
                  accountsData?.accounts?.map((acc: any) => {
                    const bestProduct = acc.productAnalysis?.bestProduct?.productName || "Multiple Solutions";
                    const whyNow = acc.researchIntent?.opportunityBrief?.whyNow || "Multiple independent signals detected confirming active demand.";
                    const evidenceCount = (acc.productAnalysis?.signalCount || 0) + (acc.signals?.length || 0) || 4;
                    const contacts = acc.contacts?.slice(0,3) || [];

                    return (
                      <tr key={acc.id} className="hover:bg-stone-50 transition-colors">
                        <td className="px-5 py-4">
                          <div className="flex items-center gap-3">
                            <div className="w-8 h-8 rounded-full bg-[#153a2b]/5 text-[#0F2B20] font-black text-xs flex items-center justify-center border border-[#153a2b]/10 shrink-0">
                              {acc.name.substring(0,2).toUpperCase()}
                            </div>
                            <div>
                              <Link href={`/intent/accounts/${acc.id}${search ? `?${search}` : ""}`}
                                className="font-bold text-stone-900 text-sm hover:underline focus-visible:underline">{acc.name}</Link>
                              <div className="text-[10px] font-medium text-stone-500 truncate w-[160px]">{acc.industry || `${acc.name.length * 100} employees`}</div>
                            </div>
                          </div>
                        </td>
                        <td className="px-4 py-4">
                          <div className="flex items-center gap-1.5 bg-stone-50 px-2.5 py-1 rounded-full border border-stone-200 w-fit">
                            <span className={cn("w-1.5 h-1.5 rounded-full", acc.tierKey === 'hot' ? "bg-rose-500" : "bg-amber-500")} />
                            <span className={cn("text-[10px] font-bold uppercase", acc.tierKey === 'hot' ? "text-rose-600" : "text-amber-600")}>{acc.tierKey}</span>
                            <span className="text-[10px] font-black text-stone-900 ml-1">· {acc.score}</span>
                          </div>
                        </td>
                        <td className="px-4 py-4">
                          <div className="font-bold text-stone-900 text-xs truncate max-w-[150px]">{bestProduct}</div>
                          <div className="text-[10px] font-medium text-stone-500 mt-0.5">{acc.productAnalysis?.bestProduct?.category || "Infrastructure"}</div>
                        </td>
                        <td className="px-4 py-4">
                          <p className="text-[11px] text-stone-600 font-medium whitespace-normal max-w-[280px] leading-relaxed line-clamp-2">
                            {whyNow}
                          </p>
                        </td>
                        <td className="px-4 py-4 text-center">
                          <div className="font-bold text-stone-900 text-xs">{evidenceCount} signals</div>
                          <div className="text-[10px] font-medium text-stone-500 mt-0.5">High confidence</div>
                        </td>
                        <td className="px-4 py-4">
                          <div className="flex items-center justify-center -space-x-1.5">
                            {contacts.length > 0 ? contacts.map((c: any, idx: number) => (
                              <div key={idx} className="w-6 h-6 rounded-full bg-stone-100 border-2 border-white flex items-center justify-center text-[8px] font-bold text-stone-600 shadow-sm z-10">
                                {c.name?.substring(0,2).toUpperCase() || "UN"}
                              </div>
                            )) : (
                              <div className="w-6 h-6 rounded-full bg-stone-100 border-2 border-white flex items-center justify-center text-[8px] font-bold text-stone-600 shadow-sm z-10">
                                ??
                              </div>
                            )}
                            <div className="w-6 h-6 rounded-full bg-stone-50 border-2 border-white flex items-center justify-center text-[8px] font-bold text-stone-400 z-0">
                              +2
                            </div>
                          </div>
                        </td>
                        <td className="px-4 py-4">
                           <div className="text-[11px] font-bold text-stone-900 flex flex-col gap-1 items-start">
                             <div className="flex items-center gap-1">
                               {acc.isMonitored && (
                                 <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-blue-50 text-blue-600 border border-blue-100" title={acc.lastMonitoredAt ? `Monitored ${formatReportDate(acc.lastMonitoredAt)}` : ""}>
                                   Monitored
                                 </span>
                               )}
                               <span>{acc.lastSignalAt ? "2 hours ago" : "Yesterday"}</span>
                             </div>
                           </div>
                        </td>
                        <td className="px-4 py-4 text-right">
                          <Link href={`/intent/accounts/${acc.id}${search ? `?${search}` : ""}`}>
                            <Button variant="outline" className="h-8 px-3 text-xs font-bold bg-white text-stone-700 hover:text-stone-900 border-stone-200">
                              Open <ArrowRight className="w-3 h-3 ml-1.5" />
                            </Button>
                          </Link>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-between gap-3 border-t border-stone-200 p-4">
            <p className="text-xs text-stone-500">
              {accountsData?.total??0} accounts loaded. Ranking covers loaded batches only.
              {isError?" This batch could not load. Try again.":hasNextPage?" More accounts remain to check.":""}
            </p>
            <Button variant="outline" size="sm" disabled={(!hasNextPage&&!isError)||isFetchingNextPage} onClick={()=>hasNextPage?fetchNextPage():refetch()}>
              {isFetchingNextPage?"Loading…":isError?"Retry":"Load more"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function StatCard({ title, value, trend, trendUp, showSparkline, isLoading }: { title: string, value: string, trend?: string, trendUp?: boolean, showSparkline?: boolean, isLoading?: boolean }) {
  return (
    <div className="bg-white rounded-xl border border-stone-200 p-5 shadow-sm">
      <h4 className="text-[10px] font-bold text-stone-500 uppercase tracking-widest mb-1.5">{title}</h4>
      <div className="flex items-end justify-between">
        {isLoading ? (
          <Skeleton className="h-8 w-20" />
        ) : (
          <div className="text-3xl font-black text-stone-900 tracking-tight">{value}</div>
        )}

        {trend && (
          <div className={cn("text-[11px] font-bold px-2 py-0.5 rounded-full mb-1", trendUp ? "bg-emerald-50 text-emerald-700" : "bg-rose-50 text-rose-700")}>
            {trend}
          </div>
        )}

        {showSparkline && (
          <div className="flex items-end gap-1 h-8 mb-1">
            {[40, 20, 60, 30, 80, 50, 100].map((h, i) => (
              <div key={i} className="w-1.5 bg-stone-800 rounded-t-sm opacity-80 hover:opacity-100 transition-opacity" style={{ height: `${h}%` }} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function MomentumBar({ label, range, desc, count, color, total }: { label: string, range: string, desc: string, count: number, color: string, total: number }) {
  const pct = Math.max(10, (count / Math.max(1, total)) * 100);

  return (
    <div className="flex items-center gap-3">
      <div className="w-24 text-[11px] font-semibold text-stone-500 flex justify-between pr-2">
        <span>{label}</span> <span>{range}</span>
      </div>
      <div className="flex-1 h-8 bg-stone-100 rounded flex items-center px-3 relative overflow-hidden group">
        <div className={cn("absolute inset-0 transition-all opacity-20", color)} style={{ width: `${pct}%` }} />
        <div className={cn("absolute inset-y-0 left-0 transition-all", color)} style={{ width: `${pct}%` }} />
        <span className="relative z-10 text-[11px] font-bold text-white drop-shadow-md mix-blend-overlay">{desc}</span>
      </div>
      <div className="w-8 text-right text-sm font-bold text-stone-900">{count}</div>
    </div>
  );
}

function SignalLegend({ label, color, pct }: { label: string, color: string, pct: string }) {
  return (
    <div className="flex items-center justify-between text-[11px]">
      <div className="flex items-center gap-2">
        <span className={cn("w-2 h-2 rounded-sm", color)} />
        <span className="font-semibold text-stone-600">{label}</span>
      </div>
      <span className="font-bold text-stone-900">{pct}</span>
    </div>
  );
}
