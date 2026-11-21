import { useState } from "react";
import { Link } from "wouter";
import { useProductIntentMatrix } from "@/hooks/use-intent";
import { IntentPageHeader, TierBadge } from "@/components/intent/ui";
import { Skeleton } from "@/components/ui/skeleton";
import { LayoutGrid, Activity } from "lucide-react";
import { getScopeParams, buildScopeQs } from "@/lib/intent-scope";
import { formatReportDate } from "@/lib/reportTime";

export default function IntentCategoriesPage() {
  const searchParams = new URLSearchParams(window.location.search);
  const scopeParams = getScopeParams(searchParams);
  const qs = buildScopeQs(scopeParams);
  
  const { data: matrix, isLoading, isError } = useProductIntentMatrix(scopeParams);
  
  return (
    <div className="flex flex-col min-h-full font-sans text-stone-900">
      <IntentPageHeader 
        title="Product category heat"
        breadcrumbs="CATEGORY-SPECIFIC INTENT"
      />
      
      <div className="p-6 max-w-[1600px] mx-auto w-full space-y-6">
        <div className="bg-white rounded-xl border border-stone-200 shadow-sm overflow-hidden flex flex-col">
          <div className="p-5 border-b border-stone-100 bg-stone-50/50">
            <h2 className="font-bold text-sm text-stone-900 flex items-center gap-2">
              <LayoutGrid className="w-4 h-4 text-emerald-600" /> Account-by-Product Matrix
            </h2>
            <p className="text-[11px] font-medium text-stone-500 mt-1">
              Product-scoped scores are explainable and do not change overall CRM routing.
            </p>
          </div>
          
          <div className="overflow-x-auto min-h-[400px]">
            {isError ? (
              <div className="p-16 text-center text-sm font-medium text-stone-500">
                <Activity className="w-8 h-8 text-rose-300 mx-auto mb-3" />
                Unable to load product-category intent for this scope.
              </div>
            ) : isLoading ? (
              <div className="p-8"><Skeleton className="h-64 w-full" /></div>
            ) : (matrix?.accounts || []).length === 0 ? (
              <div className="p-16 text-center text-sm font-medium text-stone-500">
                <Activity className="w-8 h-8 text-stone-300 mx-auto mb-3" />
                No product heat is available for this scope yet.<br/>Run research or import product intent to begin.
              </div>
            ) : (
              <table className="w-full min-w-[800px] text-left">
                <thead className="bg-white text-[9px] font-black uppercase tracking-widest text-stone-400 border-b border-stone-100">
                  <tr>
                    <th className="p-4 border-r border-stone-100 sticky left-0 bg-white z-10 w-[240px]">Account</th>
                    {(matrix?.products || []).map(product => (
                      <th key={product.id} className="p-4">{product.name}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-stone-100">
                  {(matrix?.accounts || []).map(account => (
                    <tr key={account.accountId} className="hover:bg-stone-50/50 group">
                      <td className="p-4 font-bold text-[13px] text-stone-900 border-r border-stone-100 sticky left-0 bg-white group-hover:bg-stone-50/50 z-10 transition-colors">
                        <Link href={`/intent/accounts/${account.accountId}${qs ? `?${qs}` : ''}`} className="hover:text-emerald-700 transition-colors block truncate">
                          {account.accountName}
                        </Link>
                      </td>
                      {account.cells.map(cell => {
                        const cellScope = { ...scopeParams, productId: cell.productId };
                        const cellQs = buildScopeQs(cellScope);
                        return (
                          <td key={cell.productId} className="p-0 border-r border-stone-100 last:border-r-0 align-top">
                            <Link href={`/intent/accounts/${account.accountId}?${cellQs}`} className="block p-4 h-full hover:bg-stone-50 transition-colors">
                              <TierBadge tier={cell.status} />
                              <div className="mt-2.5 flex items-center gap-2">
                                <span className="text-sm font-black text-stone-900 tabular-nums">{cell.score}</span>
                              </div>
                              <p className="mt-1.5 text-[9px] font-bold uppercase tracking-widest text-stone-400">
                                {cell.matchedContacts || 0} contacts • {cell.lastSignalAt ? formatReportDate(cell.lastSignalAt) : "No signal"}
                              </p>
                               {cell.questionnaireAging ? (
                                 <p className="mt-2 rounded-md border border-violet-200 bg-violet-50 px-2 py-1.5 text-[10px] font-bold leading-snug text-violet-800">
                                   Questionnaire · {cell.questionnaireAging.currentPoints} of {cell.questionnaireAging.originalPoints} pts retained ({cell.questionnaireAging.retainedPercent}%)
                                 </p>
                               ) : null}
                              <p className="mt-2 text-[11px] text-stone-600 line-clamp-2 leading-relaxed font-medium">
                                {cell.explanation || "No explanation available."}
                              </p>
                            </Link>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}