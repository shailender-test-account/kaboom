import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

export interface ManagedContact {
  id: number; firstName: string; lastName: string | null; email: string; phone: string | null;
  title: string | null; city: string | null; country: string | null; dnc: boolean; status: string; intentScore: number | string | null;
}
export interface ManageAccountData {
  contact: ManagedContact;
  journeys: { id: number; name: string; status: string; slug: string; removable: boolean; addedVia: string }[];
  enrollments: { id: number; sequenceId: number; sequenceName: string; status: string; enrolledAt: string }[];
  journeyOptions: { id: number; name: string; status: string }[];
  sequenceOptions: { id: number; name: string; status: string }[];
  opportunities: { id: number; title: string; stage: string; isPrimary: boolean }[];
  opportunityOptions: { id: number; title: string; stage: string }[];
}
export interface ManagementAction {
  clientId: number; accountId: number; contactId: number;
  action: "update-contact" | "add-journey" | "remove-journey" | "enroll-sequence" | "cancel-sequence" | "link-opportunity";
  values?: Partial<Pick<ManagedContact, "firstName" | "lastName" | "email" | "phone" | "title" | "city" | "country" | "dnc">>;
  journeyId?: number; sequenceId?: number; enrollmentId?: number; dealId?: number;
}
const endpoint = `${import.meta.env.BASE_URL}api/analytics/hp-bi/manage-account`;
async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const r = await fetch(url, { credentials: "include", ...options });
  if (r.status === 204 && r.ok) return null as T;
  const body = await r.json().catch(() => null);
  if (!r.ok) throw new Error(body?.error ?? "Account management request failed.");
  return body as T;
}
export function useHpAccountManagement(clientId: number, accountId: number | undefined, contactId: number | undefined) {
  return useQuery<ManageAccountData>({
    queryKey: ["hp-account-management", clientId, accountId, contactId],
    queryFn: () => request(`${endpoint}?${new URLSearchParams({ clientId: String(clientId), accountId: String(accountId), contactId: String(contactId) })}`),
    enabled: !!accountId && !!contactId, staleTime: 0, refetchInterval: 30_000,
  });
}
export function useManageHpAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (action: ManagementAction) => {
      const result = await request<any>(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(action) });
      if (action.action === "add-journey" && !result?.added)
        throw new Error(result?.dncSkipped ? "Contact is on the DNC list; no journey assignment was added." : "Contact is already assigned to this journey.");
      if (action.action === "enroll-sequence" && !result?.enrolled) {
        throw new Error(result?.skippedDnc ? "Contact is on the DNC list; enrollment was not started." :
          result?.alreadyActive ? "Contact is already active in this sequence." :
          result?.skippedCompleted ? "Contact already completed this sequence. Use the sequence editor for an intentional restart." :
          "No enrollment was created. Check contact eligibility and sequence configuration.");
      }
      return result;
    },
    onSuccess: () => {
      for (const key of ["hp-account-management", "hp-bi", "hp-bi-detail", "contact", "contacts", "contact-journeys",
        "contact-sequences", "company-analytics", "journey-contacts", "email-sequences", "sequence-enrollments", "deals", "deal-contacts"])
        qc.invalidateQueries({ queryKey: [key] });
      qc.invalidateQueries({ predicate: q => q.queryKey.some(k => typeof k === "string" && k.includes("/engagement-history")) });
    },
  });
}
