import { formatReportDate, formatReportDateTime } from "@/lib/reportTime";
import { useMemo } from "react";
import { Link, useLocation, useSearch } from "wouter";
import { useSalesDashboard } from "@/hooks/use-intent";
import { IntentPageHeader } from "@/components/intent/ui";
import { Skeleton } from "@/components/ui/skeleton";
import { Flame, Activity, Target, TrendingUp, Sparkles, Calendar, ArrowRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { INTENT_CATEGORY_NAMES } from "@/lib/intent-scope";
import { OpportunityQueue } from "./opportunity-queue";

const CATEGORY_CARDS = [
  { key: "it-hardware", name: INTENT_CATEGORY_NAMES[0], image: "/images/intent-categories/computers.png" },
  { key: "business-collaboration", name: INTENT_CATEGORY_NAMES[1], image: "/images/intent-categories/poly-collaboration.png" },
  { key: "security", name: INTENT_CATEGORY_NAMES[2], image: "/images/intent-categories/software-services.png" },
  { key: "business-services", name: INTENT_CATEGORY_NAMES[3], image: "/images/intent-categories/software-services.png" },
] as const;

const HEAT_COLORS = [
  "bg-[#1F6B45]",
  "bg-[#3B82F6]",
  "bg-[#F59E0B]",
  "bg-[#14B8A6]",
  "bg-[#8B5CF6]"
];

export default function SalesDashboardPage() {
  const [, setLocation] = useLocation();
  const search = useSearch();
  const searchParams = useMemo(() => new URLSearchParams(search), [search]);
  const selectedCategoryName = searchParams.get("categoryName") || "";
  const legacyCategoryParam = searchParams.get("categoryIds") || searchParams.get("categories") || searchParams.get("category") || "";
  const legacyCategoryIds = useMemo(() => legacyCategoryParam.split(",")
    .map(Number).filter(id => Number.isSafeInteger(id) && id > 0), [legacyCategoryParam]);

  const { data: dashboard, isLoading, error, refetch } = useSalesDashboard(
    selectedCategoryName
      ? { categoryName: selectedCategoryName }
      : legacyCategoryIds.length
        ? { categoryIds: legacyCategoryIds.join(",") }
        : undefined
  );

  const selectedCategoryNames = selectedCategoryName
    ? [selectedCategoryName]
    : legacyCategoryIds.length ? dashboard?.scope.categoryNames ?? [] : [];

  const handleCategoryClick = (categoryName: string) => {
    const p = new URLSearchParams(search);
    p.delete("categoryIds");
    p.delete("categories");
    p.delete("category");
    if (selectedCategoryNames.length === 1 && selectedCategoryNames[0] === categoryName) p.delete("categoryName");
    else p.set("categoryName", categoryName);

    setLocation(`/intent/sales-dashboard${p.size ? `?${p.toString()}` : ''}`);
  };

  const clearCategory = () => {
    const p = new URLSearchParams(search);
    p.delete("categoryName");
    p.delete("categoryIds");
    p.delete("categories");
    p.delete("category");
    setLocation(`/intent/sales-dashboard${p.size ? `?${p.toString()}` : ''}`);
  };

  function formatIndianCurrency(value: number | undefined) {
    if (value == null) return "0";
    if (value >= 10000000) {
      return `₹${(value / 10000000).toFixed(1)} Cr`;
    } else if (value >= 100000) {
      return `₹${(value / 100000).toFixed(1)} L`;
    } else {
      return `₹${value.toLocaleString('en-IN')}`;
    }
  }

  return (
    <div className="flex flex-col min-h-[100dvh] font-sans bg-[#F6F7F5]">
      <IntentPageHeader
        title="Sales Decision Cockpit"
        breadcrumbs="INTENT ENGINE"
        showUtilities={false}
      />

      <div className="p-4 md:p-6 max-w-[1400px] mx-auto w-full space-y-6">
        {error && (
          <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">
            <div className="font-bold">The sales dashboard could not be loaded.</div>
            <button type="button" onClick={() => refetch()} className="mt-2 font-bold underline">Try again</button>
          </div>
        )}

        {/* Category Filter Cards */}
        <div className="bg-white p-4 rounded-xl border border-stone-200 shadow-sm">
          <div className="mb-3 flex items-center justify-between">
             <div>
               <h2 className="text-[11px] font-black tracking-widest uppercase text-stone-500">Filter by Priority Category</h2>
             </div>
              {(selectedCategoryNames.length > 0 || legacyCategoryIds.length > 0) && (
                <button data-testid="button-clear-category" onClick={clearCategory} className="text-[10px] font-bold uppercase tracking-widest text-stone-400 hover:text-stone-700 transition-colors">
                 Clear Filter
               </button>
             )}
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
             {CATEGORY_CARDS.map(card => {
                const selected = selectedCategoryNames.includes(card.name);
                return (
                  <button
                    key={card.key}
                    type="button"
                    data-testid={`sales-category-card-${card.key}`}
                    aria-pressed={selected}
                    onClick={() => handleCategoryClick(card.name)}
                    className={cn(
                      "group overflow-hidden rounded-xl border bg-white text-left transition-all",
                      selected ? "border-[#bef264] ring-2 ring-[#bef264]/30 shadow-sm" : "border-stone-200 hover:border-stone-300 hover:shadow-sm",
                    )}
                  >
                    <div className="aspect-[202/112] overflow-hidden bg-stone-100">
                      <img src={card.image} alt={card.name} className="h-full w-full object-cover object-top transition-transform duration-500 group-hover:scale-[1.03]" />
                    </div>
                    <div className="px-3 py-2.5 flex items-center justify-between gap-2">
                       <span className="text-[11px] font-black text-stone-800 leading-tight">{card.name}</span>
                       <span className={cn("w-2.5 h-2.5 rounded-full border shrink-0", selected ? "bg-[#bef264] border-[#bef264]" : "bg-white border-stone-300")} />
                    </div>
                  </button>
                )
             })}
          </div>
        </div>

        {/* Top Summary Metrics */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
           <MetricCard
             title="Hot accounts"
             value={dashboard?.summary.hotAccounts?.toLocaleString()}
             icon={<Flame className="w-4 h-4" strokeWidth={2.5} />}
              subtitle="Accounts with validated category demand"
             isLoading={isLoading}
           />
           <MetricCard
             title="New signals"
             value={dashboard?.summary.newSignals?.toLocaleString()}
             icon={<Activity className="w-4 h-4" strokeWidth={2.5} />}
             subtitle="Across the last 30 days"
             isLoading={isLoading}
           />
           <MetricCard
             title="Category opportunities"
             value={dashboard?.summary.categoryOpportunities?.toLocaleString()}
             icon={<Target className="w-4 h-4" strokeWidth={2.5} />}
              subtitle="Account and category combinations"
             isLoading={isLoading}
           />
           <MetricCard
             title="Potential pipeline"
             value={formatIndianCurrency(dashboard?.summary.potentialPipeline)}
             icon={<TrendingUp className="w-4 h-4" strokeWidth={2.5} />}
              subtitle={`${dashboard?.summary.units ?? 0} units from ${dashboard?.summary.leadForms ?? 0} matched lead forms`}
             isLoading={isLoading}
           />
        </div>

         <OpportunityQueue
           categoryNames={selectedCategoryNames}
           legacyCategoryIds={legacyCategoryIds}
         />

         {/* Main Content Layout */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">

           {/* Product-Category Heat (Left 2/3) */}
           <div className="lg:col-span-2 bg-white rounded-[16px] border border-stone-200 shadow-sm p-6 flex flex-col">
              <div className="flex items-start justify-between mb-8">
                 <div>
                   <h3 className="text-base font-bold text-stone-900 mb-1">Product-category heat</h3>
                   <p className="text-[11px] font-medium text-stone-500">Aggregate demand across your account list.</p>
                 </div>
                 <div className="px-3 py-1.5 rounded-md border border-stone-200 text-[11px] font-bold text-stone-600 bg-white flex items-center gap-1.5 shadow-sm">
                    <Calendar className="w-3.5 h-3.5 opacity-50" /> Last 30 days
                 </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-12 gap-y-8">
                 {isLoading ? (
                    Array.from({length: 6}).map((_, i) => (
                      <div key={i} className="space-y-2">
                        <Skeleton className="h-4 w-full" />
                        <Skeleton className="h-2 w-full" />
                        <Skeleton className="h-3 w-3/4" />
                      </div>
                    ))
                 ) : dashboard?.categories && dashboard.categories.length > 0 ? (
                    dashboard.categories.map((cat, i) => (
                      <Link
                        key={cat.categoryName}
                        href={`/intent/accounts?categoryName=${encodeURIComponent(cat.categoryName)}`}
                        className="block group"
                        data-testid={`heat-category-${cat.categoryName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`}
                      >
                         <div className="flex justify-between items-end mb-1">
                           <span className="text-[13px] font-extrabold text-stone-900 group-hover:text-emerald-700 transition-colors">{cat.name}</span>
                         </div>
                         <div className="w-full h-1.5 bg-stone-100 rounded-full overflow-hidden mb-1.5">
                            <div
                              className={cn(
                                "h-full rounded-full transition-all duration-1000",
                                HEAT_COLORS[i % HEAT_COLORS.length]
                              )}
                              style={{ width: `${Math.max(10, cat.score)}%` }}
                            />
                         </div>
                         <div className="flex justify-between items-center">
                           <span className="text-[10px] font-medium text-stone-500">
                             <span className="text-stone-800 font-bold">{cat.hotAccounts} hot</span> · {cat.warmAccounts} warm
                           </span>
                           <span className="text-[10px] font-bold text-stone-900">{cat.score}/100</span>
                         </div>
                      </Link>
                    ))
                 ) : (
                    <div className="col-span-1 sm:col-span-2 text-sm text-stone-500 text-center py-8">
                      No category heat data available for the current scope.
                    </div>
                 )}
              </div>
           </div>

           {/* Why Now / Top Accounts Insight (Right 1/3) */}
           <div className="bg-[#122b20] rounded-[16px] shadow-md p-6 flex flex-col text-white relative overflow-hidden">
              <div className="absolute top-0 right-0 w-32 h-32 bg-[#bef264]/10 rounded-full blur-3xl -translate-y-1/2 translate-x-1/3" />

              <div className="flex items-center gap-2 mb-6 relative z-10">
                 <div className="w-6 h-6 rounded bg-[#1f4233] flex items-center justify-center border border-[#2d5c47]">
                    <Sparkles className="w-3 h-3 text-[#bef264]" />
                 </div>
                 <span className="text-[10px] font-bold tracking-wide uppercase text-stone-300">Highest change</span>
              </div>

              {isLoading ? (
                 <div className="space-y-4 relative z-10 mt-4">
                   <Skeleton className="h-6 w-3/4 bg-white/10" />
                   <Skeleton className="h-4 w-full bg-white/10" />
                   <Skeleton className="h-24 w-full bg-white/10 mt-4" />
                 </div>
              ) : dashboard?.topAccounts && dashboard.topAccounts.length > 0 ? (
                 <div className="relative z-10 flex flex-col flex-1 gap-6">
                    {dashboard.topAccounts.slice(0, 3).map(acc => (
                      <div key={acc.id} className="flex flex-col flex-1 bg-[#1a382a]/50 p-4 rounded-xl border border-[#2a5441]">
                        <div className="text-[11px] font-bold text-stone-300 mb-1.5">Why now</div>
                        <h3 className="text-[20px] font-bold leading-tight tracking-tight mb-2">
                           <span
                             className="text-white cursor-help underline decoration-dotted underline-offset-4"
                             title={(acc as any).lastMonitoredAt || acc.lastResearchedAt ? `Last monitored ${formatReportDateTime((acc as any).lastMonitoredAt || acc.lastResearchedAt!)}` : "This account has not been monitored yet"}
                           >{acc.name}</span> is <span className="text-white">{acc.tier}</span>
                        </h3>
                        <div className="mb-3" data-testid={`text-last-monitored-${acc.id}`}>
                          {(acc as any).lastMonitoredAt || acc.lastResearchedAt ? (
                            <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-[#bef264]/20 text-[#bef264] border border-[#bef264]/30" title={`Last monitored ${formatReportDateTime((acc as any).lastMonitoredAt || acc.lastResearchedAt!)}`}>
                              Monitored {formatReportDate((acc as any).lastMonitoredAt || acc.lastResearchedAt!)}
                            </span>
                          ) : <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-white/10 text-stone-300 border border-white/20">Not monitored yet</span>}
                        </div>
                        <p className="text-[12px] text-stone-300 leading-relaxed mb-6 font-medium">
                          {acc.whyNow || `Independent signals align around ${acc.categoryName}, lifting the score and confirming active demand.`}
                        </p>

                        <div className="bg-[#1a382a] border border-[#2a5441] rounded-lg p-4 flex flex-col gap-3 mb-8">
                           <div className="flex justify-between items-center">
                             <span className="text-[11px] font-bold text-stone-300">Total Score</span>
                             <span className="text-lg font-black text-white">{acc.score}</span>
                           </div>
                           <div className="h-px w-full bg-[#2a5441]" />
                           <div className="flex justify-between items-center">
                             <span className="text-[11px] font-bold text-stone-300">Category Fit</span>
                             <span className="text-[11px] font-bold text-[#bef264]">{acc.categoryName}</span>
                           </div>
                        </div>

                        <Link
                          href={`/intent/accounts/${acc.id}?categoryName=${encodeURIComponent(acc.categoryName)}`}
                          data-testid={`link-account-evidence-${acc.id}`}
                          className="mt-auto w-full bg-[#bef264] hover:bg-[#a3e635] text-[#0B2118] font-bold text-xs py-2.5 rounded-lg flex items-center justify-center gap-2 transition-colors shadow-sm"
                        >
                          Inspect evidence <ArrowRight className="w-3.5 h-3.5" />
                        </Link>
                      </div>
                    ))}
                 </div>
              ) : (
                 <div className="text-sm text-[#8BAA9D] text-center py-8 relative z-10">No recent surging accounts.</div>
              )}
           </div>

        </div>
      </div>
    </div>
  );
}

function MetricCard({ title, value, icon, subtitle, isLoading }: { title: string; value?: string; icon: React.ReactNode; subtitle: string; isLoading: boolean }) {
  return (
    <div className="bg-white rounded-[16px] border border-stone-200 p-5 flex flex-col shadow-sm">
       <div className="flex items-start justify-between mb-4">
          <div className="w-8 h-8 rounded-lg bg-stone-100 flex items-center justify-center text-stone-700">
             {icon}
          </div>
       </div>
       <div className="text-[11px] font-semibold text-stone-500 mb-1">{title}</div>
       {isLoading ? (
          <Skeleton className="h-8 w-16 mb-1" />
       ) : (
          <div className="text-[28px] font-black tracking-tight text-stone-900 leading-none mb-2">
            {value || "0"}
          </div>
       )}
       <div className="text-[10px] font-medium text-stone-400 mt-auto">{subtitle}</div>
    </div>
  );
}
