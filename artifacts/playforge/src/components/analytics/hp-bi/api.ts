import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import type { HpBiDashboard, HpBiDetail, HpBiFilters } from "./types";
import type { HpParentPivot, HpPivotInput } from "./pivot-types";
import type { HpMappingPreset, HpMappingPresetInput, HpMappingPresetUpdate,
  HpParentView, HpParentViewInput, HpParentViewUpdate } from "@workspace/api-client-react";
import { getListHpAccountRegisterQueryKey, useListHpAccountRegister } from "@workspace/api-client-react";

export function useHpAccountRegister(clientId: number, search: string, page: number) {
  const params = { clientId, search: search || undefined, page, pageSize: 25 };
  return useListHpAccountRegister(params,
    { query: { queryKey: getListHpAccountRegisterQueryKey(params), staleTime: 0, refetchOnMount: "always", refetchInterval: 60000 } });
}

export type HpImportPreview = { rows: number; uniqueAccounts: number; headers: string[]; samples: Record<string, unknown>[];
  warnings: string[]; errors: string[]; importKind: string;
  impact?: { sourceRows: number; legalAccounts: number; duplicateRows: number; sourceParentGroups: number;
    existingMatches: number; newAccounts: number; conflicts: number; resultingLegalAccounts: number; resultingParentGroups: number;
    hierarchyReviews: number; conflictExamples: { hpId: string; name: string; reason: string }[]; note: string } };

export function hpBiQuery(filters: HpBiFilters) {
  const q = new URLSearchParams();
  Object.entries(filters).forEach(([key, value]) => {
    if (value !== undefined && value !== "" && value !== false) q.set(key, String(value));
  });
  return q.toString();
}
async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`/api/analytics/hp-bi${path}`, { ...options, credentials: "include" });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error || `HP BI request failed (${response.status})`);
  }
  return response.json();
}
export function useHpBiFilterOptions(clientId: number) {
  return useQuery({ queryKey: ["hp-bi-filter-options", clientId], staleTime: 60_000,
    queryFn: ({ signal }) => request<{ salesPeople: string[] }>(`/filter-options?clientId=${clientId}`, { signal }) });
}
export function useHpBiDashboard(filters: HpBiFilters, enabled = true, autoRefresh = true) {
  return useQuery({ queryKey: ["hp-bi", filters], queryFn: ({ signal }) =>
    request<HpBiDashboard>(`?${hpBiQuery(filters)}`, { signal }), enabled, staleTime: 60_000,
    refetchOnWindowFocus: false, refetchInterval: autoRefresh ? 60_000 : false,
    // Keep the current page visible while navigating, never data from another scope.
    placeholderData: (previous, previousQuery) => {
      const previousFilters = previousQuery?.queryKey[1] as HpBiFilters | undefined;
      return previousFilters && JSON.stringify({ ...previousFilters, page: 1 }) === JSON.stringify({ ...filters, page: 1 })
        ? previous : undefined;
    } });
}
export function useHpBiDetail(filters: HpBiFilters, enabled: boolean) {
  return useQuery({ queryKey: ["hp-bi-detail", filters], queryFn: ({ signal }) =>
    request<HpBiDetail>(`/account?${hpBiQuery(filters)}`, { signal }), enabled,
    staleTime: 15_000, refetchOnMount: "always", refetchInterval: 30_000 });
}
export function hpPivotQuery(input: HpPivotInput) {
  const query = new URLSearchParams();
  Object.entries(input).forEach(([key, value]) => {
    if (value !== undefined && value !== "" && value !== false && (!Array.isArray(value) || value.length)) {
      query.set(key, Array.isArray(value) ? JSON.stringify(value) : String(value));
    }
  });
  return query.toString();
}
export function useHpParentPivot(input: HpPivotInput, enabled = true) {
  return useQuery({ queryKey: ["hp-parent-pivot", input], enabled, staleTime: 15_000,
    queryFn: ({ signal }) => request<HpParentPivot>(`/pivot?${hpPivotQuery(input)}`, { signal }) });
}

export function useHpParentViews(clientId: number) {
  return useQuery({ queryKey: ["hp-parent-views", clientId], staleTime: 0,
    queryFn: ({ signal }) => request<HpParentView[]>(`/pivot/views?clientId=${clientId}`, { signal }) });
}
/** Refresh every HP BI list, detail and evidence query (used by CRM deal mutations too). */
export function invalidateHpBi(cache: QueryClient) {
  return Promise.all(["hp-bi", "hp-bi-detail", "hp-bi-evidence", "hp-parent-pivot", "/api/analytics/hp-bi/heatmap", "/api/analytics/hp-bi/account-register"].map(k => cache.invalidateQueries({ queryKey: [k] })));
}
function useHpMutation<T, R>(mutationFn: (input: T) => Promise<R>) {
  const cache = useQueryClient();
  return useMutation({ mutationFn, onSuccess: () => {
    cache.invalidateQueries({ queryKey: ["hp-bi"] });
    cache.invalidateQueries({ queryKey: ["hp-bi-detail"] });
    cache.invalidateQueries({ queryKey: ["hp-bi-evidence"] });
    cache.invalidateQueries({ queryKey: ["hp-parent-pivot"] });
    cache.invalidateQueries({ queryKey: ["/api/analytics/hp-bi/heatmap"] });
    cache.invalidateQueries({ queryKey: ["companies"] });
    cache.invalidateQueries({ queryKey: ["/api/analytics/hp-bi/account-register"] });
  } });
}
export function usePreviewHpImport(clientId: number) {
  return useMutation({ mutationFn: async (input: { file: File; kind: "accounts" | "activities"; mappings?: Record<string, string> }) => {
    const body = new FormData(); body.set("file", input.file);
    body.set("kind", input.kind); body.set("mappings", JSON.stringify(input.mappings ?? {}));
    return request<HpImportPreview>(
      `/import/preview?clientId=${clientId}`, { method: "POST", body });
  } });
}
export function useHpMappingPresets(clientId: number, kind: "accounts" | "activities") {
  return useQuery({ queryKey: ["hp-mapping-presets", clientId, kind], queryFn: () =>
    request<HpMappingPreset[]>(`/mapping-presets?clientId=${clientId}&kind=${kind}`), staleTime: 0 });
}
export function useSaveHpMappingPreset(clientId: number) {
  const cache = useQueryClient();
  return useMutation({ mutationFn: (input: { id?: number; data: HpMappingPresetInput | HpMappingPresetUpdate }) =>
    request<HpMappingPreset>(`/mapping-presets${input.id ? `/${input.id}` : ""}?clientId=${clientId}`, {
      method: input.id ? "PATCH" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input.data) }),
    onSuccess: () => cache.invalidateQueries({ queryKey: ["hp-mapping-presets", clientId] }) });
}
export function useDeleteHpMappingPreset(clientId: number) {
  const cache = useQueryClient();
  return useMutation({ mutationFn: async (id: number) => {
    const response = await fetch(`/api/analytics/hp-bi/mapping-presets/${id}?clientId=${clientId}`, { method: "DELETE", credentials: "include" });
    if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || "Could not delete preset.");
  }, onSuccess: () => cache.invalidateQueries({ queryKey: ["hp-mapping-presets", clientId] }) });
}
export function useImportHpAccounts(clientId: number) {
  return useHpMutation(async (input: { file: File; kind: "accounts" | "activities"; mappings?: Record<string, string>; confirmAccounts?: boolean }) => {
    const body = new FormData(); body.set("file", input.file);
    body.set("kind", input.kind); body.set("mappings", JSON.stringify(input.mappings ?? {}));
    if (input.confirmAccounts) body.set("confirmAccounts", "true");
    return request<{ imported: number; created: number; rows: number; linkedContacts: number; unresolved: number }>(
      `/import?clientId=${clientId}`, { method: "POST", body });
  });
}
export function useUpdateHpProfile(clientId: number) {
  return useHpMutation(async (input: { companyId: number; values: Record<string, unknown> }) =>
    request(`/profiles/${input.companyId}?clientId=${clientId}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input.values) }));
}
export function useAddHpRecord(clientId: number) {
  return useHpMutation(async (input: { accountId: number; contactId?: number | null; kind: string;
    occurredAt: string; category?: string; product?: string; horizonMonths?: number | null;
    orderValue?: number | null; currency?: string; sourceName?: string; status?: string }) =>
    request(`/records?clientId=${clientId}`, { method: "POST",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) }));
}

export function useSaveHpParentView(clientId: number) {
  const cache = useQueryClient();
  return useMutation({ mutationFn: (input: { id?: number; data: HpParentViewInput | HpParentViewUpdate }) =>
    request<HpParentView>(`/pivot/views${input.id ? `/${input.id}` : ""}?clientId=${clientId}`, {
      method: input.id ? "PATCH" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input.data) }),
    onSuccess: () => cache.invalidateQueries({ queryKey: ["hp-parent-views", clientId] }) });
}

export function useDeleteHpParentView(clientId: number) {
  const cache = useQueryClient();
  return useMutation({ mutationFn: async (id: number) => {
    const response = await fetch(`/api/analytics/hp-bi/pivot/views/${id}?clientId=${clientId}`, { method: "DELETE", credentials: "include" });
    if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || "Could not delete saved view.");
  }, onSuccess: () => cache.invalidateQueries({ queryKey: ["hp-parent-views", clientId] }) });
}
