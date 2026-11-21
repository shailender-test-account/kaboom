/** Qualification is a parent-table filter, independent of fiscal-year totals. */
export function filterHpAccountQualification<T extends {status:string}>(accounts:T[],qualification?:"Hot"|"Warm"|"Cold"){
  return qualification?accounts.filter(account=>account.status===qualification):accounts;
}

export const HP_ACCOUNT_SORT_FIELDS = ["name", "journey", "segment", "rad", "contacts", "engagedContacts", "touchpoints", "leads", "hot",
  "opportunities", "closedWon", "closedLost", "values", "bookedValues", "score", "lastActivity", "status", "gtmStatus"] as const;
export type HpAccountSortField = typeof HP_ACCOUNT_SORT_FIELDS[number];
const heat = (status: string | undefined) => status === "Hot" ? 2 : status === "Warm" ? 1 : 0;
const textCompare = (a: string, b: string) => a.localeCompare(b, "en", { sensitivity: "base", numeric: true });
export function sortHpAccounts<T extends { name: string; parentKey: string; id: number }>(
  accounts: T[], field?: HpAccountSortField, direction: "asc" | "desc" = "desc", currency = "INR",
) {
  const value = (a: any): string | number | null => {
    if (!field) return null;
    if (field === "name") return a.parentName || a.name;
    if (field === "journey") return a.journeys?.length ? a.journeys.map((j: { name: string }) => j.name).join("; ") : null;
    if (field === "status" || field === "gtmStatus") return heat(field === "status" ? a.status : a.gtm?.status);
    if (field === "values" || field === "bookedValues") return a[field]?.[currency] ?? null;
    if (field === "lastActivity") {
      const date = a.lastActivity ? Date.parse(a.lastActivity) : NaN;
      return Number.isFinite(date) ? date : null;
    }
    if (field === "score" && !a.contacts) return null;
    return a[field] ?? null;
  };
  return accounts.sort((a: any, b: any) => {
    const tie = () => textCompare(a.parentName || a.name, b.parentName || b.name)
      || textCompare(a.parentKey, b.parentKey) || a.id - b.id;
    if (!field) return b.hot - a.hot || b.touchpoints - a.touchpoints || tie();
    const av = value(a), bv = value(b);
    // Missing dates, amounts and scores always go last, in both directions.
    if (av == null || bv == null) return av == null && bv == null ? tie() : av == null ? 1 : -1;
    const comparison = typeof av === "number" && typeof bv === "number" ? av - bv : textCompare(String(av), String(bv));
    return comparison * (direction === "asc" ? 1 : -1) || tie();
  });
}
