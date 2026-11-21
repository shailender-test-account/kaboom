import type { ReactNode } from "react";
import { Skeleton } from "@/components/ui/skeleton";

type PanelQuery = { data: unknown; isError: boolean; error: Error | null; refetch: () => unknown };

export function IntentDetailPanel({ query, label, children }: { query: PanelQuery; label: string; children: ReactNode }) {
  if (query.isError) return <div role="alert" className="m-3 rounded border border-rose-200 bg-white p-4 text-sm text-rose-700">
    {label} could not be loaded{query.error?.message ? `: ${query.error.message}` : "."}{" "}
    <button className="font-bold underline" onClick={() => void query.refetch()}>Retry {label.toLowerCase()}</button>
  </div>;
  if (!query.data) return <div role="status" className="m-3 p-3 text-sm text-stone-500">
    Loading {label.toLowerCase()}…<Skeleton className="mt-3 h-12 w-full" />
  </div>;
  return <>{children}</>;
}
