import { Link } from "wouter";
import { useGetMonitoringAccountOptions } from "@workspace/api-client-react";
import { buildScopeQs } from "@/lib/intent-scope";

export default function MonitoringAnalysisLinks({ accountIds, clientId, categoryIds }: {
  accountIds: number[]; clientId: number | null; categoryIds: number[];
}) {
  const ids = accountIds.slice(0, 5);
  const query = useGetMonitoringAccountOptions({ clientId: clientId ?? undefined, ids: ids.join(",") || undefined },
    { query: { enabled: ids.length > 0, staleTime: 60_000 } });
  if (!ids.length) return null;
  const names = new Map(query.data?.items.map(a => [a.id, a.name]));
  const qs = buildScopeQs({ clientId, categoryIds: categoryIds.join(",") });
  return <div className="mt-3 space-y-1 border-t pt-3 text-xs">
    <p className="font-semibold text-stone-700">Open account analysis in Intent Engine</p>
    <p className="text-[11px] text-stone-500">Research findings appear as each account completes. No findings is a valid result, not a buying signal.</p>
    <div className="flex flex-wrap gap-2">{ids.map(id => <Link key={id} href={`/intent/accounts/${id}${qs ? `?${qs}` : ""}`}
      className="rounded border px-2 py-1 font-semibold text-emerald-800 hover:bg-emerald-50">{names.get(id) ?? `Account #${id}`} →</Link>)}</div>
    {accountIds.length > 5 && <p className="text-stone-500">{accountIds.length - 5} more selected accounts; use Edit to review the full selection.</p>}
  </div>;
}
