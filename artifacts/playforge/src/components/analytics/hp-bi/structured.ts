import type { HpBiDetail, HpBiPeriod, HpBiRecord } from "./types";

export type AccountLayout = "structured" | "original";
export const layoutKey = (clientId: number) => `hpbi-account-layout:${clientId}`;
export function readLayout(clientId: number): AccountLayout {
  try { return globalThis.localStorage?.getItem(layoutKey(clientId)) === "original" ? "original" : "structured"; } catch { return "structured"; }
}
export function writeLayout(clientId: number, l: AccountLayout) { try { globalThis.localStorage?.setItem(layoutKey(clientId), l); } catch { /* ignore */ } }

const IST = 330 * 60000;
const touchKinds = new Set(["attendance", "invitation", "digital", "content", "other", "interest"]);
export const monthEnd = (start: string) => { const i = new Date(Date.parse(start) + IST); return Date.UTC(i.getUTCFullYear(), i.getUTCMonth() + 1, 1) - IST; };
const within = (r: HpBiRecord, a: number, b: number) => { const t = Date.parse(r.occurredAt); return t >= a && t < b; };
export const mergeMoney = (list: (Record<string, number> | undefined)[]) => {
  const o: Record<string, number> = {};
  list.forEach(v => Object.entries(v ?? {}).forEach(([c, n]) => { o[c] = (o[c] ?? 0) + n; }));
  return o;
};
export interface Quarter { label: string; months: HpBiPeriod[]; touchpoints: number; invitations: number; attendance: number; digital: number; content: number; other: number;
  leads: number; hot: number; warm: number; opportunities: number; values: Record<string, number>; categories: string[]; contacts: number | null; started: boolean }
/** Four HP quarters from the existing months; contacts are deduplicated from attributable records, never summed from monthly distincts. */
export function quarters(d: HpBiDetail): Quarter[] {
  const out: Quarter[] = [];
  for (let i = 0; i < d.months.length; i += 3) {
    const ms = d.months.slice(i, i + 3); if (!ms.length) continue;
    const sum = (k: "touchpoints" | "invitations" | "attendance" | "digital" | "content" | "other" | "leads" | "hot" | "warm" | "opportunities") => ms.reduce((s, m) => s + (m[k] ?? 0), 0);
    const a = Date.parse(ms[0].start), b = monthEnd(ms[ms.length - 1].start);
     const ids = new Set<number>(); d.records.forEach(r => { if (r.contactId != null && touchKinds.has(r.kind) && within(r, a, b)) ids.add(r.contactId); });
    const touch = sum("touchpoints");
    out.push({ label: `Q${out.length + 1}`, months: ms, touchpoints: touch, invitations: sum("invitations"), attendance: sum("attendance"), digital: sum("digital"), content: sum("content"), other: sum("other"),
      leads: sum("leads"), hot: sum("hot"), warm: sum("warm"), opportunities: sum("opportunities"), values: mergeMoney(ms.map(m => m.values)),
      categories: [...new Set(ms.flatMap(m => m.categories))].sort(),
      contacts: ids.size > 0 ? ids.size : (touch === 0 ? 0 : null), started: ms.some(m => !m.isFuture) });
  }
  return out;
}
const moneyOk = (r: HpBiRecord) => r.kind === "opportunity" && r.orderValue != null && !!r.currency && !r.exclusionReasons?.length;
export type OpportunityMetric = "touchpoints" | "engagedContacts" | "leads" | "opportunities" | "value";
export function opportunityRecords(d: HpBiDetail, metric: OpportunityMetric, category?: string) {
  return d.records.filter(r => (category === undefined || r.category === category) && (
    metric === "touchpoints" ? touchKinds.has(r.kind) :
    metric === "engagedContacts" ? r.contactId != null && touchKinds.has(r.kind) :
    metric === "leads" ? r.kind === "lead" :
    metric === "opportunities" ? r.kind === "opportunity" : moneyOk(r)
  ));
}
export interface CategoryRow { category: string; buyer: boolean; whitespace: boolean; products: string[]; sources: string[]; contacts: number; touches: number; leads: number; opps: number; tov: Record<string, number> }
export function categoryRows(d: HpBiDetail): CategoryRow[] {
   // Questionnaire activity and qualification are separate metric projections.
   // Combine them only in evidence lists, never before counting touchpoints.
   const recs = d.records;
  const names = new Set<string>();
  d.members.forEach(m => { m.buyerCategories.forEach(c => names.add(c)); m.whitespaceCategories.forEach(c => names.add(c)); });
   recs.forEach(r => { if (r.category) names.add(r.category); });
   d.account.categories?.forEach(c => names.add(c));
  return [...names].sort().map(category => {
    const rs = recs.filter(r => r.category === category);
    const tov: Record<string, number> = {};
    rs.filter(moneyOk).forEach(r => { tov[r.currency!] = (tov[r.currency!] ?? 0) + r.orderValue!; });
    return { category, buyer: d.members.some(m => m.buyerCategories.includes(category)), whitespace: d.members.some(m => m.whitespaceCategories.includes(category)),
      products: [...new Set(rs.map(r => r.product).filter(Boolean) as string[])], sources: [...new Set(rs.map(r => r.sourceName || r.source).filter(Boolean))],
       contacts: new Set(rs.filter(r => r.contactId != null && touchKinds.has(r.kind)).map(r => r.contactId)).size,
       touches: rs.filter(r => touchKinds.has(r.kind)).length,
      leads: rs.filter(r => r.kind === "lead").length, opps: rs.filter(r => r.kind === "opportunity").length, tov };
  });
}
export const distinct = (vals: (string | boolean | null | undefined)[]) => [...new Set(vals.filter(v => v != null && v !== "").map(String))];
