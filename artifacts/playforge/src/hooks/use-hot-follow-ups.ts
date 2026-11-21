import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

const api = (path: string, init?: RequestInit) => fetch(`/api/sales-feedback/hot-follow-ups${path}`, {
  credentials: "include", ...init,
  headers: init?.body ? { "Content-Type": "application/json", ...(init?.headers ?? {}) } : init?.headers,
}).then(async r => {
  if (!r.ok) {
    const text = await r.text();
    let msg = text || r.statusText;
    try { const p = JSON.parse(text); msg = p.error || p.message || msg; } catch { /* plain text */ }
    throw new Error(msg);
  }
  return r.json();
});

export type FollowUpStatus = "open" | "completed";
export interface HotEvidence { product: string; months: number | null; at: string | null; reference: string | null }
export interface HotFollowUp {
  id: number; clientId: number; accountId: number | null; contactId: number; contactName: string | null; accountName: string | null;
  phone: string | null; email: string | null; status: FollowUpStatus; assigneeId: number | null; assigneeName: string | null;
  createdAt: string; completedAt: string | null; completionNote: string | null;
  evidence: HotEvidence[]; journeys: { id: number; name: string }[]; sequences: { id: number; name: string; status: string }[];
}
export interface HotFollowUpList { items: HotFollowUp[]; total: number; page: number; pageSize: number; assignees: { id: number; name: string }[] }
export interface HotFollowUpFilters { clientId?: number; accountId?: number; contactId?: number; parentKey?: string; status?: FollowUpStatus; page?: number }
export type HotFollowUpPatch = { assigneeId: number | null } | { complete: true; note: string };

const ROOT = ["sales-feedback", "hot-follow-ups"] as const;
const qs = (o: object) => {
  const p = new URLSearchParams();
  Object.entries(o).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== "") p.set(k, String(v)); });
  const s = p.toString();
  return s ? `?${s}` : "";
};

/** Finite polling: refresh every 60s for at most 30 cycles per mount. */
export function useHotFollowUps(filters: HotFollowUpFilters, enabled = true) {
  return useQuery<HotFollowUpList>({
    queryKey: [...ROOT, "list", filters],
    queryFn: () => api(qs(filters)),
    enabled, staleTime: 15_000,
    refetchInterval: q => (q.state.dataUpdateCount < 30 && !q.state.error ? 60_000 : false),
  });
}

export function useUpdateHotFollowUp() {
  const qc = useQueryClient();
  return useMutation<HotFollowUp, Error, { id: number; body: HotFollowUpPatch }>({
    mutationFn: ({ id, body }) => api(`/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [...ROOT] });
      qc.invalidateQueries({ predicate: q => /hot-follow-ups|HotFollowUp|engagement/i.test(JSON.stringify(q.queryKey)) });
    },
  });
}
