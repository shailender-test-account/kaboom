import type { z } from "zod";
import { GetHpParentHeatmapQueryParams, GetHpParentHeatmapResponse } from "@workspace/api-zod";
import { loadHpBiFacts, type BusinessRecord, type HpFilters } from "./hpBiMetrics";

export type HeatmapMetric = z.infer<typeof GetHpParentHeatmapQueryParams>["metric"];
type Heatmap = z.infer<typeof GetHpParentHeatmapResponse>;
type Profile = { company_id: number | string; parent_key: string; parent_name: string };
const touches = new Set(["invitation", "attendance", "digital", "content", "other", "interest"]);

export function isHeatmapRecord(record: BusinessRecord, metric: HeatmapMetric) {
  switch (metric) {
    case "touchpoints": return touches.has(record.kind);
    case "engagedContacts": return touches.has(record.kind) && record.contactId !== null;
    case "emailClicks": return record.kind === "digital" && record.status === "email_click";
    case "emailOpens": return record.kind === "digital" && record.status === "email_open";
    case "leads": return record.kind === "lead";
    case "hot": return record.kind === "lead" && record.status === "hot";
    case "opportunities": return record.kind === "opportunity";
  }
}

/** One pass over canonical facts; no per-parent or per-month database queries. */
export function aggregateParentHeatmap(
  profiles: Profile[], records: BusinessRecord[], filters: Pick<HpFilters, "year" | "page" | "pageSize">,
  metric: HeatmapMetric, now = Date.now(),
): Heatmap {
  const monthDate = (i: number) => new Date(Date.UTC(filters.year - 1, 10 + i, 1) - 330 * 60_000);
  const starts = Array.from({ length: 13 }, (_, i) => monthDate(i).getTime());
  const months = starts.slice(0, 12).map((start, i) => ({
    month: i + 1,
    label: new Intl.DateTimeFormat("en-IN", { month: "short", year: "numeric", timeZone: "Asia/Kolkata" }).format(start),
    start: new Date(start), end: new Date(starts[i + 1]), isFuture: start > now,
  }));
  const rows = new Map<string, Heatmap["rows"][number]>();
  const accountParent = new Map<number, string>();
  for (const profile of profiles) {
    accountParent.set(Number(profile.company_id), profile.parent_key);
    const row = rows.get(profile.parent_key);
    if (row) row.memberCount++;
    else rows.set(profile.parent_key, { parentKey: profile.parent_key, parentName: profile.parent_name,
      memberCount: 1, cells: Array(12).fill(0), total: 0 });
  }
  const peopleByMonth = new Map<string, Set<number>>();
  const peopleByYear = new Map<string, Set<number>>();
  for (const record of records) {
    const key = accountParent.get(record.accountId);
    if (key === undefined || !isHeatmapRecord(record, metric)) continue;
    const time = Date.parse(record.occurredAt);
    if (!Number.isFinite(time) || time < starts[0] || time >= starts[12]) continue;
    const month = starts.findIndex((start, i) => i < 12 && time >= start && time < starts[i + 1]);
    const row = rows.get(key)!;
    if (metric === "engagedContacts") {
      const cellKey = `${key}:${month}`;
      let people = peopleByMonth.get(cellKey);
      if (!people) peopleByMonth.set(cellKey, people = new Set());
      people.add(record.contactId!);
      row.cells[month] = people.size;
      let annualPeople = peopleByYear.get(key);
      if (!annualPeople) peopleByYear.set(key, annualPeople = new Set());
      annualPeople.add(record.contactId!);
      row.total = annualPeople.size;
    } else {
      row.cells[month]++;
      row.total++;
    }
  }
  const ranked = [...rows.values()].sort((a, b) => b.total - a.total
    || a.parentName.localeCompare(b.parentName, "en-IN") || a.parentKey.localeCompare(b.parentKey));
  let maxCell = 0;
  for (const row of ranked) for (const value of row.cells) maxCell = Math.max(maxCell, value);
  return { year: filters.year, metric, months, total: ranked.length, page: filters.page, pageSize: filters.pageSize,
    maxCell, rows: ranked.slice((filters.page - 1) * filters.pageSize, filters.page * filters.pageSize) };
}

export async function loadParentHeatmap(tenantId: number, filters: HpFilters, metric: HeatmapMetric) {
  const { selected, records, safeContactIds } = await loadHpBiFacts(tenantId, filters);
  const attributable = metric === "engagedContacts" ? records.filter(r => r.contactId !== null && safeContactIds.has(r.contactId)) : records;
  return aggregateParentHeatmap(selected, attributable, filters, metric);
}
