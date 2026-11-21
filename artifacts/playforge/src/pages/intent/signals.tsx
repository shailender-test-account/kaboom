import { IntentPageHeader, LimeBadge } from "@/components/intent/ui";
import { Activity, ExternalLink, FileText, User } from "lucide-react";
import { useIntentAccounts, useIntentEvidenceReview } from "@/hooks/use-intent";
import { Skeleton } from "@/components/ui/skeleton";
import { getScopeParams } from "@/lib/intent-scope";
import { formatReportDate } from "@/lib/reportTime";

function neutralProviderText(value: string): string {
  return value
    .replace(/\bPerplexity\b/gi, "web search")
    .replace(/\bApollo\b/gi, "contact discovery provider");
}

export default function IntentSignalStreamPage() {
  const searchParams = new URLSearchParams(window.location.search);
  const scopeParams = getScopeParams(searchParams);
  
  const hasScope = Object.keys(scopeParams).some(key => !["page", "pageSize"].includes(key));
  const { data, isLoading, isError } = useIntentEvidenceReview("approved");
  const {
    data: scopedAccounts,
    isLoading: scopedAccountsLoading,
    isError: scopedAccountsError,
  } = useIntentAccounts({ ...scopeParams, page: 1, pageSize: 50 });

  const scopedAccountIds = new Set((scopedAccounts?.accounts || []).map(account => account.id));
  const evidence = (data?.evidence || []).filter(e => {
    if (!hasScope) return true;
    if (e.accountId == null || !scopedAccountIds.has(e.accountId)) return false;
    if (scopeParams.productId && String(e.productId) !== String(scopeParams.productId)) return false;
    return true;
  });
  const loading = isLoading || (hasScope && scopedAccountsLoading);
  const failed = isError || (hasScope && scopedAccountsError);
  
  // Calculate dynamic source health from loaded evidence
  const total = evidence.length;
  const webMentions = evidence.filter((e) => e.provider === "newsapi" || e.eventType === "news" || e.source?.toLowerCase().includes("news")).length;
  const peopleMentions = evidence.filter((e) => e.eventType === "person" || e.provider === "apollo").length;
  const uploadMentions = evidence.filter((e) => e.provider === "import" || e.source?.toLowerCase().includes("upload")).length;

  const rawMentionsCount = total > 0 ? total : 0;
  // A naive unique check:
  const uniqueEventsCount = total > 0 ? new Set(evidence.map(e => e.sourceUrl || e.summary)).size : 0;

  return (
    <div className="flex flex-col min-h-full font-sans text-stone-900">
      <IntentPageHeader 
        title="Unified signal stream"
        breadcrumbs="WEB + FIRST-PARTY EVIDENCE"
      />
      
      <div className="p-6 max-w-[1200px] mx-auto w-full grid grid-cols-1 xl:grid-cols-3 gap-6">
        
        {/* Left Column: Evidence Stream */}
        <div className="xl:col-span-2 space-y-4">
          <div className="bg-white rounded-xl border border-stone-200 shadow-sm overflow-hidden flex flex-col">
            <div className="p-5 border-b border-stone-100 flex items-center justify-between">
              <div>
                <h2 className="font-bold text-sm text-stone-900">Evidence stream</h2>
                <p className="text-[11px] font-medium text-stone-500 mt-0.5">Every score change remains traceable to source.</p>
              </div>
              <LimeBadge className="px-2 py-1 text-[10px] rounded-full">{total > 0 ? total : 0} loaded</LimeBadge>
            </div>
            
            <div className="divide-y divide-stone-100">
              {failed ? (
                <div className="p-10 text-center">
                  <Activity className="w-8 h-8 text-rose-300 mx-auto mb-3" />
                  <p className="text-sm font-bold text-stone-900">Unable to load signals</p>
                  <p className="text-xs text-stone-500 mt-1">Refresh the page or adjust the current scope.</p>
                </div>
              ) : loading ? (
                Array.from({length: 4}).map((_, i) => (
                  <div key={i} className="p-5 flex gap-4">
                    <Skeleton className="w-10 h-10 rounded-lg shrink-0" />
                    <div className="space-y-2 flex-1"><Skeleton className="h-3 w-32" /><Skeleton className="h-4 w-64" /><Skeleton className="h-3 w-40" /></div>
                  </div>
                ))
              ) : evidence.length === 0 ? (
                <div className="p-10 text-center">
                  <Activity className="w-8 h-8 text-stone-300 mx-auto mb-3" />
                  <p className="text-sm font-bold text-stone-900">No signals found</p>
                  <p className="text-xs text-stone-500 mt-1">Check back later or adjust filters.</p>
                </div>
              ) : (
                evidence.map((item, i) => {
                  const Icon = item.eventType === 'news' ? FileText : item.eventType === 'person' ? User : Activity;
                  return (
                    <div key={item.id || i} className="p-5 flex items-start gap-4 hover:bg-stone-50 transition-colors cursor-pointer group">
                      <div className="w-10 h-10 rounded-lg bg-stone-100 border border-stone-200 flex items-center justify-center shrink-0">
                        <Icon className="w-4 h-4 text-stone-500" />
                      </div>
                      
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5 mb-1.5">
                          <span className="text-[9px] font-black uppercase tracking-widest text-stone-400 truncate">
                            {item.accountName || "UNKNOWN ACCOUNT"} • {neutralProviderText(item.provider || item.source || "WEB NEWS")}
                          </span>
                        </div>
                        <h3 className="text-[13px] font-bold text-stone-900 leading-snug group-hover:text-emerald-700 transition-colors">
                          {item.title || item.summary || item.excerpt || "Signal"}
                        </h3>
                        <div className="flex items-center gap-2 mt-2">
                          <span className="text-[10px] font-semibold text-stone-400">
                            {item.capturedAt ? formatReportDate(item.capturedAt) : 'Unknown date'}
                          </span>
                          <span className="text-[10px] font-medium text-stone-300">•</span>
                          <span className="text-[10px] font-medium text-stone-500 truncate">
                            {item.productName || "General evidence"}
                          </span>
                        </div>
                      </div>
                      
                      <div className="shrink-0 flex items-center">
                        <span className="text-xs font-bold text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded border border-emerald-100">
                          +{item.contribution || 0}
                        </span>
                        <ExternalLink className="w-3.5 h-3.5 ml-3 text-stone-300 group-hover:text-stone-500 transition-colors" />
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>
        
        {/* Right Column: Clustering & Health */}
        <div className="xl:col-span-1 space-y-6">
          
          <div className="bg-[#0F2B20] text-stone-300 rounded-xl p-5 shadow-lg relative overflow-hidden">
            <div className="w-8 h-8 rounded bg-[#1A382A] flex items-center justify-center mb-5">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" className="w-4 h-4 text-[#bef264]" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path>
                <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path>
              </svg>
            </div>
            
            <h2 className="text-sm font-bold text-white mb-2 relative z-10">Signal clustering</h2>
            <p className="text-[11px] font-medium text-[#8BAA9D] leading-relaxed mb-6 relative z-10">
              Multiple raw mentions of the same topic are clustered into one event. Independent evidence can strengthen it; repeated coverage cannot.
            </p>
            
            <div className="space-y-4 relative z-10">
              <div className="flex items-center justify-between border-b border-[#1A382A] pb-3">
                <span className="text-xs font-medium text-[#8BAA9D]">Loaded mentions</span>
                <span className="text-sm font-black text-[#bef264]">{loading ? "-" : rawMentionsCount}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-[#8BAA9D]">Unique events</span>
                <span className="text-sm font-black text-[#bef264]">{loading ? "-" : uniqueEventsCount}</span>
              </div>
            </div>
          </div>
          
          <div className="bg-white rounded-xl border border-stone-200 shadow-sm p-5">
            <h2 className="text-sm font-bold text-stone-900 mb-5">Source health (Loaded)</h2>
            
            <div className="space-y-5">
              {[
                { label: "Company + regulatory", percent: total ? Math.round((webMentions / total) * 100) : 0 },
                { label: "Careers + people", percent: total ? Math.round((peopleMentions / total) * 100) : 0 },
                { label: "First-party uploads", percent: total ? Math.round((uploadMentions / total) * 100) : 0 },
              ].map((src, i) => (
                <div key={i} className="space-y-2">
                  <div className="flex items-center justify-between text-[11px] font-bold text-stone-700">
                    <span>{src.label}</span>
                    <span>{src.percent}%</span>
                  </div>
                  <div className="w-full h-1.5 bg-stone-100 rounded-full overflow-hidden">
                    <div className="h-full bg-[#0F2B20] rounded-full" style={{ width: `${src.percent}%` }} />
                  </div>
                </div>
              ))}
            </div>
          </div>
          
        </div>
      </div>
    </div>
  );
}