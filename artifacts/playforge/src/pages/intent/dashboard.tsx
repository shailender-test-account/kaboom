import { formatReportDate, formatReportDateTime } from "@/lib/reportTime";
import { useState } from "react";
import { Link } from "wouter";
import {
  useProductIntentMatrix,
  useIntentProviderRuns,
  useIntentEvidenceReview,
  useReviewIntentEvidence,
  useIntentScopeOptions
} from "@/hooks/use-intent";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Target, Activity, CheckSquare, ShieldCheck, DatabaseZap, ChevronLeft, ExternalLink, RefreshCw, LayoutGrid, AlertCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { IntentPageHeader, LimeBadge, TierBadge } from "@/components/intent/ui";
import { useToast } from "@/hooks/use-toast";

function safeHttpUrl(value?: string) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

export default function IntentDashboardPage() {
  const searchParams = new URLSearchParams(window.location.search);
  const qs = searchParams.toString();

  const clientId = searchParams.get("clientId") || searchParams.get("client") || undefined;
  const audienceId = searchParams.get("audienceId") || searchParams.get("audience") || undefined;
  const categoryIds = searchParams.get("categoryIds") || searchParams.get("categories") || searchParams.get("category") || undefined;
  const subcategoryIds = searchParams.get("subcategoryIds") || searchParams.get("subcategories") || searchParams.get("subcategory") || undefined;
  const productId = searchParams.get("productId") || searchParams.get("product") || undefined;
  const reviewAccountId = Number(searchParams.get("reviewAccount")) || undefined;

  const apiParams = {
    clientId,
    audienceId,
    categoryIds,
    subcategoryIds,
    productId,
  };

  const matrix = useProductIntentMatrix(apiParams);
  const providerRuns = useIntentProviderRuns();

  const [evidenceStatus, setEvidenceStatus] = useState<"pending_review" | "approved" | "rejected">("pending_review");
  const evidenceReview = useIntentEvidenceReview(evidenceStatus, reviewAccountId);
  const reviewEvidence = useReviewIntentEvidence();
  const { data: scopeOptions } = useIntentScopeOptions();
  const [assignments, setAssignments] = useState<Record<string, { accountId?: number; productId?: number }>>({});
  const { toast } = useToast();
  const selectedAccount = matrix.data?.accounts.find(account => account.accountId === reviewAccountId);
  const selectedAccountName = selectedAccount?.accountName || evidenceReview.data?.evidence[0]?.accountName;
  const backUrl = reviewAccountId ? `/intent/accounts/${reviewAccountId}` : `/intent${qs ? `?${qs}` : ''}`;

  return (
    <div className="min-h-[100dvh] bg-stone-50 flex flex-col font-sans">
      <IntentPageHeader
        title="Product & Evidence Review"
        subtitle="Confirm signal provenance and analyze product-specific intent heat."
        breadcrumbs={
          <Link href={backUrl} className="hover:text-stone-900 flex items-center gap-1 transition-colors">
            <ChevronLeft className="w-3.5 h-3.5" /> {reviewAccountId ? "Back to account" : "Command Center"}
          </Link>
        }
        actions={
          <Button size="sm" asChild className="bg-stone-800 hover:bg-stone-700 text-white font-bold h-8 px-4">
            <Link href={`/intent/recommendations${qs ? `?${qs}` : ''}`}><CheckSquare className="w-3.5 h-3.5 mr-1.5" /> Generated Plays</Link>
          </Button>
        }
      />

      <div className="flex-1 max-w-[1600px] mx-auto w-full p-6 space-y-6">
        <div className={cn("grid grid-cols-1 gap-6", reviewAccountId ? "" : "xl:grid-cols-3")}>

          {/* Left Column: Matrix + History */}
          <div className={cn("xl:col-span-2 flex flex-col gap-6", reviewAccountId && "hidden")}>
            <div className="bg-white border border-stone-200 rounded-lg shadow-sm flex flex-col overflow-hidden">
              <div className="border-b border-stone-200 bg-stone-50/80 p-4">
                <h2 className="text-sm font-bold flex items-center gap-2 text-stone-900">
                  <LayoutGrid className="w-4 h-4 text-emerald-600" /> Account-by-Product Heat
                </h2>
                <p className="text-xs font-medium text-stone-500 mt-1">
                  Product-scoped scores are explainable and do not change overall CRM routing.
                </p>
              </div>
              <div className="p-0 overflow-x-auto bg-white min-h-[400px]">
                {!matrix.isLoading && (matrix.data?.accounts || []).length === 0 ? (
                  <div className="p-16 text-center text-sm text-stone-500 font-medium">
                    <Activity className="w-8 h-8 text-stone-300 mx-auto mb-3" />
                    No product heat is available for this scope yet.<br/>Run research or import product intent to begin.
                  </div>
                ) : (
                  <table className="w-full min-w-[800px] text-sm text-left">
                    <thead className="bg-stone-50/50 text-[10px] font-bold uppercase tracking-widest text-stone-500 border-b border-stone-200">
                      <tr>
                        <th className="p-4 border-r border-stone-100 bg-white sticky left-0 z-10 w-[240px]">Account</th>
                        {(matrix.data?.products || []).map(product => (
                          <th key={product.id} className="p-4">{product.name}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-stone-100">
                      {(matrix.data?.accounts || []).map(account => {
                        const accountProductId = productId || account.cells[0]?.productId;
                        return (
                          <tr key={account.accountId} className="hover:bg-stone-50/50 group">
                              <td className="p-4 font-bold border-r border-stone-100 bg-white sticky left-0 z-10" title={(account as any).lastResearchedAt ? `Last monitored ${formatReportDateTime((account as any).lastResearchedAt)}` : "This account has not been monitored yet"}>
                               <Link className="text-stone-900 hover:text-emerald-700 transition-colors underline decoration-dotted underline-offset-4" href={`/intent/accounts/${account.accountId}${accountProductId ? `?productId=${accountProductId}` : ""}`}>
                                {account.accountName}
                              </Link>
                              <div data-testid={`text-last-monitored-${account.accountId}`} className="mt-0.5 text-[10px] font-medium text-stone-500">{(account as any).lastResearchedAt ? `Monitored ${formatReportDate((account as any).lastResearchedAt)}` : "Not monitored yet"}</div>
                            </td>
                            {account.cells.map(cell => (
                              <td key={cell.productId} className="p-0 border-r border-stone-100 last:border-0 align-top">
                                <Link href={`/intent/accounts/${account.accountId}?productId=${cell.productId}`} className="block p-4 h-full hover:bg-stone-50 transition-colors">
                                  <TierBadge tier={cell.status} />
                                  <div className="mt-2.5 flex items-center gap-2">
                                    <span className="text-base font-black text-stone-900 tabular-nums">{cell.score} pts</span>
                                  </div>
                                  <p className="mt-1.5 text-[10px] font-bold uppercase tracking-wider text-stone-500">
                                    {cell.matchedContacts || 0} contacts · {cell.lastSignalAt ? formatReportDate(cell.lastSignalAt) : "No signal"}
                                  </p>
                                   {cell.questionnaireAging ? (
                                     <p className="mt-2 rounded-md border border-violet-200 bg-violet-50 px-2 py-1.5 text-[10px] font-bold leading-snug text-violet-800">
                                       Questionnaire · {cell.questionnaireAging.currentPoints} of {cell.questionnaireAging.originalPoints} pts retained ({cell.questionnaireAging.retainedPercent}%)
                                     </p>
                                   ) : null}
                                  <p className="mt-2.5 text-[11px] text-stone-600 line-clamp-2 leading-relaxed font-medium">
                                    {cell.explanation || "No explanation available."}
                                  </p>
                                </Link>
                              </td>
                            ))}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </div>
            </div>

            <div className="bg-white border border-stone-200 rounded-lg shadow-sm overflow-hidden mt-auto">
              <div className="border-b border-stone-200 bg-stone-50/80 p-4">
                <h2 className="text-sm font-bold flex items-center gap-2 text-stone-900">
                  <DatabaseZap className="w-4 h-4 text-emerald-600" /> Provider Run History
                </h2>
              </div>
              <div className="p-0 bg-white max-h-[300px] overflow-y-auto">
                {providerRuns.isLoading ? (
                  <div className="p-8 text-center text-xs font-semibold text-stone-500">Loading history…</div>
                ) : (() => {
                  const runs = [...(providerRuns.data?.research || []).map(run => ({ ...run, kind: "Research" })), ...(providerRuns.data?.discovery || []).map(run => ({ ...run, kind: "Contacts" }))]
                    .sort((a, b) => new Date(b.startedAt || 0).getTime() - new Date(a.startedAt || 0).getTime()).slice(0, 5);
                  if (!runs.length) return <div className="p-8 text-center text-xs font-semibold text-stone-500">No recent provider runs.</div>;
                  return (
                    <div className="divide-y divide-stone-100">
                      {runs.map(run => (
                        <div key={`${run.kind}-${run.id}`} className="p-4 hover:bg-stone-50 transition-colors">
                          <div className="flex items-center justify-between mb-1.5">
                            <span className="text-xs font-bold text-stone-900">{run.kind} · {run.provider || "Provider"}</span>
                            <LimeBadge className={run.status === "failed" ? "bg-rose-500 text-white" : ""}>
                              {run.status}
                            </LimeBadge>
                          </div>
                          <p className="text-[10px] font-bold tracking-widest uppercase text-stone-500">{run.startedAt ? formatReportDateTime(run.startedAt) : "Unknown start time"}</p>
                          <div className="mt-2.5 text-[11px] font-medium text-stone-600 bg-stone-50 p-2.5 rounded border border-stone-200">
                            Requests: {run.summary?.requests ?? 0}/{run.summary?.usageLimit ?? "—"} · Normalized: {run.summary?.recordsNormalized ?? 0} · Added: {run.summary?.inserted ?? 0} · Exact repeats: {run.summary?.duplicates ?? 0}
                            {run.summary?.failures?.length ? <p className="text-rose-600 mt-1.5 font-bold">{run.summary.failures[0]}</p> : null}
                          </div>
                        </div>
                      ))}
                    </div>
                  );
                })()}
              </div>
            </div>
          </div>

          {/* Right Column: Evidence Review */}
          <div className={cn(reviewAccountId ? "w-full" : "xl:col-span-1")}>
            <div className={cn("bg-white border border-stone-200 rounded-lg shadow-sm flex flex-col overflow-hidden", reviewAccountId ? "min-h-[calc(100vh-160px)]" : "h-[calc(100vh-140px)] sticky top-6")}>
              <div className="border-b border-stone-200 bg-stone-50/80 p-4 shrink-0">
                <h2 className="text-sm font-bold flex items-center gap-2 text-stone-900">
                  <ShieldCheck className="w-4 h-4 text-emerald-600" /> Evidence Review
                </h2>
                <p className="text-xs font-medium text-stone-500 mt-1">
                   {reviewAccountId
                     ? `${selectedAccountName || "Selected account"} · Only low-confidence AI exceptions remain here. Choose a product when the evidence supports one, then approve or reject.`
                     : "OpenAI approves confident evidence automatically. This queue contains only low-confidence exceptions."}
                </p>
                <div className="flex gap-1.5 mt-4">
                  {(["pending_review", "approved", "rejected"] as const).map(status => (
                    <Button
                      key={status}
                      size="sm"
                      variant={evidenceStatus === status ? "default" : "outline"}
                      className={cn("h-7 text-[10px] font-bold uppercase tracking-widest px-3", evidenceStatus === status ? "bg-[#0B2118] text-white hover:bg-stone-900" : "bg-white text-stone-600 border-stone-200")}
                      onClick={() => setEvidenceStatus(status)}
                    >
                      {status === "pending_review" ? "Pending" : status}
                    </Button>
                  ))}
                </div>
              </div>
              <div className="p-0 flex-1 overflow-y-auto bg-white">
                {evidenceReview.isLoading ? (
                  <div className="p-16 flex justify-center"><RefreshCw className="w-5 h-5 animate-spin text-stone-300" /></div>
                ) : evidenceReview.isError ? (
                  <div className="m-4 p-4 rounded bg-rose-50 border border-rose-200 text-xs font-bold text-rose-700 flex gap-2">
                    <AlertCircle className="w-4 h-4 shrink-0" />
                    {evidenceReview.error.message}
                  </div>
                ) : !(evidenceReview.data?.evidence || []).length ? (
                  <div className="p-16 text-center text-sm font-medium text-stone-500">
                    <ShieldCheck className="w-8 h-8 text-stone-300 mx-auto mb-3" />
                    No {evidenceStatus.replace("_", " ")} evidence.
                  </div>
                ) : (
                  <div className="divide-y divide-stone-100">
                    {evidenceReview.data?.evidence.map((item, index) => {
                      const assignment = assignments[String(item.id)] || {};
                      const accountId = assignment.accountId ?? item.accountId;
                      const assignedProductId = assignment.productId ?? item.productId;
                      const sourceUrl = safeHttpUrl(item.sourceUrl);
                      const accountName = item.accountName || "Unknown Account";
                      const productName = item.productName || scopeOptions?.products.find(p => p.id === assignedProductId)?.name;
                      const sourceTitle = typeof item.context?.sourceTitle === "string" ? item.context.sourceTitle : "";
                      const evidenceTitle = sourceTitle || item.summary || item.excerpt?.split(/[.!?]\s+/)[0] || "Research evidence";

                      return (
                        <div key={item.id} className="p-5 hover:bg-stone-50 transition-colors">
                          <div className="flex flex-col gap-3">
                            <div className="flex items-start justify-between gap-4">
                              <div>
                                <div className="flex flex-wrap items-center gap-2 mb-1.5">
                                  <span className="text-[9px] font-extrabold uppercase tracking-widest text-[#1A382A] bg-[#8BAA9D]/20 px-1.5 py-0.5 rounded-[3px]">
                                    {item.eventType?.replace(/_/g, " ") || "Evidence"}
                                  </span>
                                  <span className="text-[10px] font-bold tracking-widest uppercase text-stone-400">
                                    Public research · {item.occurredAt || item.eventDate || item.capturedAt ? formatReportDate(item.occurredAt || item.eventDate || item.capturedAt || "") : "Date unavailable"}
                                  </span>
                                </div>
                                <h3 className="text-sm font-bold text-stone-900">{evidenceTitle}</h3>
                              </div>
                              <span className="text-[10px] font-black tabular-nums text-stone-400 shrink-0">#{index + 1}</span>
                            </div>
                            <p className="text-[12px] text-stone-600 leading-relaxed font-medium line-clamp-4">{item.excerpt || item.summary || "No excerpt provided."}</p>

                            <div className="bg-white rounded border border-stone-200 p-3 mt-1 shadow-sm">
                              <p className="text-[11px] font-medium text-stone-500 mb-2">
                                Account: <span className="font-bold text-stone-900">{accountName}</span>
                                {productName && <span> · Product: <span className="font-bold text-stone-900">{productName}</span></span>}
                              </p>

                              {evidenceStatus === "pending_review" && (
                                <div className="mt-2.5">
                                  <p className="text-[10px] font-bold uppercase tracking-widest text-stone-500 mb-1.5">Product supported by this evidence</p>
                                  <Select
                                    value={assignedProductId ? String(assignedProductId) : "unassigned"}
                                    onValueChange={v => setAssignments(curr => ({ ...curr, [String(item.id)]: { ...curr[String(item.id)], productId: v === "unassigned" ? undefined : Number(v) } }))}
                                  >
                                    <SelectTrigger className="h-8 text-xs font-bold w-full bg-stone-50 border-stone-200">
                                      <SelectValue placeholder="Assign product..." />
                                    </SelectTrigger>
                                    <SelectContent>
                                      <SelectItem value="unassigned">Select product</SelectItem>
                                      {(scopeOptions?.products || []).map(p => <SelectItem key={p.id} value={String(p.id)}>{p.name}</SelectItem>)}
                                    </SelectContent>
                                  </Select>
                                </div>
                              )}

                              <div className="flex items-center justify-between gap-3 mt-3 pt-3 border-t border-stone-100">
                                {sourceUrl ? (
                                  <a href={sourceUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-widest text-emerald-700 hover:text-emerald-800 transition-colors">
                                    Source <ExternalLink className="w-3 h-3" />
                                  </a>
                                ) : (
                                  <span className="text-[10px] font-bold uppercase tracking-widest text-stone-400">Hidden</span>
                                )}

                                {evidenceStatus === "pending_review" && (
                                  <div className="flex gap-2">
                                    <Button size="sm" variant="outline" className="h-8 text-[10px] font-bold uppercase tracking-widest px-3 bg-white border-stone-200" disabled={reviewEvidence.isPending} onClick={() => reviewEvidence.mutate({ id: item.id, reviewStatus: "rejected" }, {
                                      onSuccess: () => toast({ title: "Evidence rejected", description: "It was removed from the pending queue." }),
                                      onError: error => toast({ title: "Review failed", description: error.message, variant: "destructive" }),
                                    })}>Reject</Button>
                                    <Button size="sm" className="h-8 text-[10px] font-bold uppercase tracking-widest px-3 bg-[#0B2118] hover:bg-stone-900 text-white" disabled={reviewEvidence.isPending || !accountId || !assignedProductId} onClick={() => reviewEvidence.mutate({ id: item.id, reviewStatus: "approved", accountId, productId: assignedProductId }, {
                                      onSuccess: async () => {
                                        setAssignments(current => {
                                          const next = { ...current };
                                          delete next[String(item.id)];
                                          return next;
                                        });
                                        await Promise.all([evidenceReview.refetch(), matrix.refetch()]);
                                        toast({ title: "Evidence approved", description: `${productName || "The selected product"} was added to ${accountName}'s product-fit calculation.` });
                                      },
                                      onError: error => toast({ title: "Approval failed", description: error.message, variant: "destructive" }),
                                    })}>Approve & recalculate</Button>
                                  </div>
                                )}
                              </div>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          </div>

        </div>
      </div>
    </div>
  );
}