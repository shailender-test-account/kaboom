import { useQuery } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import { formatReportDateTime } from "@/lib/reportTime";

export type GtmStatus = {
  status: "hot" | "warm" | "cold";
  updatedAt: string | null;
};
export type GtmStatuses = Record<string, GtmStatus>;

/** Fetch only the contacts displayed by a report; status comes from each contact's own inbound submissions. */
export function useGtmStatuses(contactIds: Array<number | null | undefined>, enabled = true) {
  const ids = [...new Set(contactIds.filter((id): id is number =>
    typeof id === "number" && Number.isSafeInteger(id) && id > 0,
  ))].sort((a, b) => a - b);
  return useQuery({
    queryKey: ["analytics", "gtm-status", ids],
    enabled: enabled && ids.length > 0,
    staleTime: 60_000,
    queryFn: async (): Promise<GtmStatuses> => {
      const chunks: number[][] = [];
      for (let i = 0; i < ids.length; i += 200) chunks.push(ids.slice(i, i + 200));
      const responses = await Promise.all(chunks.map(async (contactIds) => {
        const response = await fetch("/api/analytics/gtm-status", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ contactIds }),
        });
        if (!response.ok) throw new Error(`GTM OS status request failed (${response.status})`);
        return response.json() as Promise<{ contacts: GtmStatuses }>;
      }));
      return Object.assign({}, ...responses.map(response => response.contacts)) as GtmStatuses;
    },
  });
}

const colors: Record<GtmStatus["status"], string> = {
  hot: "bg-rose-100 text-rose-800",
  warm: "bg-amber-100 text-amber-800",
  cold: "bg-slate-100 text-slate-700",
};

export function GtmStatusBadge({
  status, loading = false, error = false, scope = "account",
}: {
  status?: GtmStatus;
  loading?: boolean;
  error?: boolean;
  scope?: "account" | "contact";
}) {
  const label = status
    ? status.status.charAt(0).toUpperCase() + status.status.slice(1)
    : error ? "Unavailable" : loading ? "Loading…" : "Not classified";
  const title = status
    ? `GTM OS ${scope} qualification${status.updatedAt ? ` · Updated ${formatReportDateTime(status.updatedAt)}` : ""}`
    : error ? "GTM OS qualification could not be loaded"
    : loading ? "Loading GTM OS qualification"
    : `No inbound ${scope} qualification recorded`;
  return (
    <span
      title={title}
      className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold whitespace-nowrap",
        status ? colors[status.status] : "bg-zinc-100 text-zinc-600")}
    >
      GTM OS {scope === "account" ? "Account" : "Contact"} qualification · {label}
    </span>
  );
}