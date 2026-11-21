import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

const api = (path: string, init?: RequestInit) => fetch(`/api/sales-feedback${path}`, {
  credentials: "include", ...init,
  headers: init?.body ? { "Content-Type": "application/json", ...(init?.headers ?? {}) } : init?.headers,
}).then(async r => {
  if (!r.ok) {
    const text = await r.text();
    let msg = text || r.statusText;
    try { const p = JSON.parse(text); msg = p.error || p.message || msg; } catch { /* plain text */ }
    throw new Error(msg);
  }
  if (r.status === 204) return null;
  return r.json();
});

export type FeedbackType = "telesales" | "sales_rep";
export type ReviewStatus = "pending" | "approved" | "rejected";
export type Temperature = "Hot" | "Warm" | "Cold";

export interface FeedbackEntry {
  id: number; clientId: number; accountId: number | null; contactId: number | null; type: FeedbackType;
  occurredAt: string | null; repName: string; feedback: string; product: string | null; timingMonths: number | null;
  proposedTemperature: string | null; reviewStatus: ReviewStatus; reviewNote: string | null; approvedQualification: boolean;
  reviewedAt: string | null; reviewedBy: number | null; sourceId: number | null; fileName: string | null;
  sheetName: string | null; rowNumber: number | null; rawFields: Record<string, unknown>; createdAt: string;
  accountName: string | null; contactName: string | null; nextAction: string | null; sourceName: string | null;
  superseded?: boolean; reviewHistory?: Record<string, unknown>[];
  /** Authenticated submitter (server-derived). Null/absent for imported or legacy rows. */
  createdBy?: number | null; createdByName?: string | null;
}
export interface FeedbackList { items: FeedbackEntry[]; total: number; page: number; pageSize: number }
export interface FeedbackOptions {
  clients: { id: number; name: string }[];
  accounts: { id: number; name: string; clientId: number }[];
  contacts: { id: number; name: string; companyId: number; clientId: number; email: string | null }[];
  products: { id: number; name: string }[];
  googleDriveConnected: boolean;
  accountsHasMore?: boolean;
  contactsHasMore?: boolean;
}
export interface FeedbackSource {
  id: number; clientId: number; name: string; folderUrl: string; type: FeedbackType; enabled: boolean;
  fieldMappings: Record<string, string>; lastSyncedAt: string | null; lastError: string | null; hasImported: boolean;
}
export interface SourcePreview { files: { id: string; name: string }[]; sheets: { name: string; headers: string[]; rowCount: number }[]; errors: string[] }
export interface SyncResult { imported: number; duplicates: number; files: number; errors: string[]; remainingFiles: number }

export interface FeedbackFilters {
  clientId?: number; accountId?: number; contactId?: number; parentKey?: string;
  type?: FeedbackType; status?: ReviewStatus; page?: number; pageSize?: number;
}
export interface CreateFeedbackBody {
  clientId: number; accountId?: number; contactId?: number; type: FeedbackType; occurredAt?: string;
  /** Ignored server-side for manual entries; the signed-in user is recorded instead. Never sent by the UI. */
  repName?: string;
  feedback: string; product?: string; timingMonths?: number; proposedTemperature?: Temperature; nextAction?: string;
}
export interface ReviewBody {
  decision: "approve" | "reject"; accountId?: number; contactId?: number; note: string;
  applyQualification: boolean; product?: string; timingMonths?: number; occurredAt?: string;
}
export interface SourceBody { clientId: number; name: string; folderUrl: string; type: FeedbackType; enabled: boolean; fieldMappings?: Record<string, string> }

export const CANONICAL_KEYS = ["companyName", "contactName", "email", "phone", "occurredAt", "repName", "feedback", "product", "timingMonths", "proposedTemperature", "nextAction", "recordId"] as const;

/** Query keys touched by an approval: engagement history, intent, HP analytics and priority. */
export const REVIEW_AFFECTED = /engagement|intent|analytics|priority|hp[-_ ]?bi|"hp"|\/api\/hp|qualif/i;

const ROOT = ["sales-feedback"] as const;
const qs = (o: object) => {
  const p = new URLSearchParams();
  Object.entries(o).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== "") p.set(k, String(v)); });
  const s = p.toString();
  return s ? `?${s}` : "";
};

export function useFeedbackList(filters: FeedbackFilters, enabled = true) {
  return useQuery<FeedbackList>({
    queryKey: [...ROOT, "list", filters],
    queryFn: () => api(`/${qs(filters)}`),
    enabled, placeholderData: prev => prev,
  });
}
export function useFeedbackOptions(clientId?: number, search?: string, scope?: { accountId?: number; contactId?: number; accountPage?: number; contactPage?: number }, enabled = true) {
  const accountId = scope?.accountId, contactId = scope?.contactId;
  const accountPage = scope?.accountPage, contactPage = scope?.contactPage;
  return useQuery<FeedbackOptions>({
    queryKey: [...ROOT, "options", clientId ?? null, search ?? "", accountId ?? null, contactId ?? null, accountPage ?? 1, contactPage ?? 1],
    queryFn: () => api(`/options${qs({ clientId, search, accountId, contactId, accountPage, contactPage })}`),
    enabled,
  });
}
export function useFeedbackSources(enabled = true) {
  return useQuery<{ items: FeedbackSource[] }>({ queryKey: [...ROOT, "sources"], queryFn: () => api("/sources"), enabled });
}
export function useSourcePreview(id: number | null) {
  return useQuery<SourcePreview>({
    queryKey: [...ROOT, "sources", id, "preview"], queryFn: () => api(`/sources/${id}/preview`),
    enabled: id != null, staleTime: 0, retry: false,
  });
}

export function useCreateFeedback() {
  const qc = useQueryClient();
  return useMutation<FeedbackEntry, Error, CreateFeedbackBody>({
    mutationFn: body => api("/", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: [...ROOT, "list"] }),
  });
}
export function useReviewFeedback() {
  const qc = useQueryClient();
  return useMutation<FeedbackEntry, Error, { id: number; body: ReviewBody }>({
    mutationFn: ({ id, body }) => api(`/${id}/review`, { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [...ROOT, "list"] });
      // Approval may change HP qualification, priority, intent and engagement timelines.
      qc.invalidateQueries({ predicate: q => REVIEW_AFFECTED.test(JSON.stringify(q.queryKey)) });
    },
  });
}
export function useSaveSource() {
  const qc = useQueryClient();
  return useMutation<FeedbackSource, Error, { id?: number; body: SourceBody }>({
    mutationFn: ({ id, body }) => api(id ? `/sources/${id}` : "/sources", { method: id ? "PUT" : "POST", body: JSON.stringify(body) }),
    onSuccess: s => {
      qc.invalidateQueries({ queryKey: [...ROOT, "sources"], exact: true });
      qc.removeQueries({ queryKey: [...ROOT, "sources", s.id, "preview"] });
    },
  });
}
export function useSyncSource() {
  const qc = useQueryClient();
  return useMutation<SyncResult, Error, number>({
    mutationFn: id => api(`/sources/${id}/sync`, { method: "POST" }),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: [...ROOT, "sources"], exact: true });
      qc.invalidateQueries({ queryKey: [...ROOT, "list"] });
    },
  });
}
