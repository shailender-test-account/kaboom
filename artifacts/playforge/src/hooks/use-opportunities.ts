import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

export type Opportunity = {
  accountId: number; accountName: string; clientId: number; productId: number; productName: string;
  categoryId: number; categoryName: string; status: string; source: string; reason: string;
  journeyName: string | null; sequenceName: string | null;
  contact: { id: number; name: string; email?: string | null } | null;
  score: { people: number; monitoring: number; total: number };
  latestActionAt: string | null; nextStep: string | null; handoffStatus: string | null;
};
export type OpportunityEvent = {
  id: string | number; type: string; source: string; contactId: number | null; contactName: string | null;
  points: number; tags: string[]; evidence: string | null; url: string | null;
  occurredAt: string | null; importedAt: string | null; productId: number | null; categoryId: number | null;
};
export type OpportunityTimeline = {
  accountName: string; score: Opportunity["score"];
  people: Array<{ id: number; name: string; email?: string | null; score: number; tags: string[] }>;
  events: OpportunityEvent[];
};
export type OpportunityFilters = {
  page?: number; pageSize?: number; cursor?: number; status?: string; search?: string;
  clientId?: number; productId?: number; categoryName?: string; categoryId?: number;
};
export type TimelineFilters = { productId?: number; contactId?: number; dateFrom?: string; dateTo?: string };

const paramsOf = (values: Record<string, string | number | undefined>) => {
  const p = new URLSearchParams();
  Object.entries(values).forEach(([key, value]) => {
    if (value !== undefined && value !== "") p.set(key, String(value));
  });
  return p.toString();
};
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/intent/opportunities${path}`, { credentials: "include", ...init });
  if (!response.ok) {
    const text = await response.text();
    let message = text || `Request failed (${response.status})`;
    try { const body = JSON.parse(text); message = body.error || body.message || message; } catch { /* plain text error */ }
    throw new Error(message);
  }
  return response.json() as Promise<T>;
}
export const useOpportunities = (filters: OpportunityFilters) => useQuery<{ items: Opportunity[]; hasMore: boolean; nextCursor: number | null; page: number; pageSize: number }>({
  queryKey: ["intent", "opportunities", filters],
  queryFn: () => request(`?${paramsOf(filters)}`),
  staleTime: 30_000,
});
export const usePriorityOpportunities = (status?: "hot" | "warm" | "review") => useQuery<{ items: Opportunity[]; limited: boolean }>({
  queryKey: ["intent", "opportunities", "priority", status ?? "all"],
  queryFn: () => request(`/priority${status ? `?status=${status}` : ""}`, { signal: AbortSignal.timeout(30_000) }),
  staleTime: 30_000,
  retry: false,
});
export const useOpportunityTimeline = (accountId: number | undefined, filters: TimelineFilters) => useQuery<OpportunityTimeline>({
  queryKey: ["intent", "opportunities", accountId, "timeline", filters],
  queryFn: () => request(`/${accountId}/timeline?${paramsOf(filters)}`),
  enabled: !!accountId,
  staleTime: 30_000,
});
export const useOpportunityHandoffs = (accountId: number | undefined) => useQuery<unknown>({
  queryKey: ["intent", "opportunities", "handoffs", accountId],
  queryFn: () => request(`/handoffs?accountId=${accountId}`),
  enabled: !!accountId,
});
export const useOpportunityHandoff = () => {
  const cache = useQueryClient();
  return useMutation<unknown, Error, { accountId: number; productId: number; spreadsheetId: string; range?: string }>({
    mutationFn: data => request("/handoff", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) }),
    onSuccess: (_, values) => {
      cache.invalidateQueries({ queryKey: ["intent", "opportunities", "handoffs", values.accountId] });
      cache.invalidateQueries({ queryKey: ["intent", "opportunities"] });
    },
  });
};
export async function downloadHotOpportunities(filters: Pick<OpportunityFilters, "clientId" | "productId" | "categoryName" | "categoryId">) {
  const response = await fetch(`/api/intent/opportunities/handoff.csv?${paramsOf({ status: "hot", ...filters })}`, { credentials: "include" });
  if (!response.ok) {
    const text = await response.text();
    let message = text || `Export failed (${response.status})`;
    try { const body = JSON.parse(text); message = body.error || body.message || message; } catch { /* plain text */ }
    throw new Error(message);
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "hot-opportunities.csv";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}