import { describe, expect, it } from "vitest";
import { GetHpParentHeatmapResponse } from "@workspace/api-zod";
import { aggregateParentHeatmap } from "./hpParentHeatmap";
import type { BusinessRecord } from "./hpBiMetrics";

const profiles = [
  { company_id: 1, parent_key: "p1", parent_name: "Alpha" },
  { company_id: 2, parent_key: "p1", parent_name: "Alpha" },
  { company_id: 3, parent_key: "p2", parent_name: "Inactive" },
];
const filters = { year: 2026, page: 1, pageSize: 25 };
const record = (id: string, patch: Partial<BusinessRecord> = {}): BusinessRecord => ({
  id, accountId: 1, contactId: 10, kind: "digital", status: "email_click", occurredAt: "2026-07-08T07:05:00Z",
  category: null, product: null, horizonMonths: null, orderValue: null, currency: null, source: "activity_event", sourceName: null, ...patch,
});
const records = [
  record("click"), record("open", { status: "email_open" }), record("next-month", { occurredAt: "2026-08-08T07:05:00Z" }),
  record("hot-one", { accountId: 2, kind: "lead", product: "Laptop", horizonMonths: 3, status: "hot" }),
  record("hot-copy", { accountId: 2, kind: "lead", product: "Laptop", horizonMonths: 3, status: "hot" }),
  record("warm", { kind: "lead", status: "warm" }),
  record("foreign", { accountId: 999 }),
];
describe("HP parent × fiscal month heatmap", () => {
  it("groups owned legal accounts, preserves inactive parents and validates the generated response", () => {
    const data = aggregateParentHeatmap(profiles, records, filters, "touchpoints");
    expect(data.rows.map(r => [r.parentKey, r.memberCount, r.total])).toEqual([["p1", 2, 3], ["p2", 1, 0]]);
    expect(data.rows[0].cells[8]).toBe(2);
    expect(data.rows[0].cells[9]).toBe(1);
    expect(data.months.map(m => m.month)).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
    expect(data.months[0].label).toBe("Nov 2025");
    expect(data.months[11].label).toBe("Oct 2026");
    expect(GetHpParentHeatmapResponse.safeParse(data).success).toBe(true);
  });
  it("keeps clicks distinct from opens and Hot records distinct from people", () => {
    expect(aggregateParentHeatmap(profiles, records, filters, "emailClicks").rows[0].total).toBe(2);
    expect(aggregateParentHeatmap(profiles, records, filters, "emailOpens").rows[0].total).toBe(1);
    const hot = aggregateParentHeatmap(profiles, records, filters, "hot");
    expect(hot.rows[0].total).toBe(2);
    expect(hot.rows[0].cells[8]).toBe(2);
    const engaged = aggregateParentHeatmap(profiles, records, filters, "engagedContacts");
    expect(engaged.rows[0].cells[8]).toBe(1);
    expect(engaged.rows[0].cells[9]).toBe(1);
    expect(engaged.rows[0].total).toBe(1);
  });
  it("uses India midnight inclusive/exclusive boundaries, not UTC calendar dates", () => {
    const rr = [
      record("before", { occurredAt: "2025-10-31T18:29:59Z" }),
      record("start", { occurredAt: "2025-10-31T18:30:00Z" }),
      record("june", { occurredAt: "2026-06-30T18:29:59Z" }),
      record("july", { occurredAt: "2026-06-30T18:30:00Z" }),
      record("last", { occurredAt: "2026-10-31T18:29:59Z" }),
      record("after", { occurredAt: "2026-10-31T18:30:00Z" }),
      record("invalid", { occurredAt: "invalid" }),
    ];
    const data = aggregateParentHeatmap(profiles, rr, filters, "emailClicks");
    expect(data.rows[0].total).toBe(4);
    expect(data.rows[0].cells[0]).toBe(1);
    expect(data.rows[0].cells[7]).toBe(1);
    expect(data.rows[0].cells[8]).toBe(1);
    expect(data.rows[0].cells[11]).toBe(1);
  });
  it("keeps the scale across pages and marks future months without suppressing their evidence", () => {
    const rr = [record("future", { occurredAt: "2026-10-08T07:05:00Z" }), record("duplicate", { occurredAt: "2026-10-08T07:05:00Z" })];
    const now = Date.parse("2026-09-01T00:00:00Z");
    const first = aggregateParentHeatmap(profiles, rr, { ...filters, pageSize: 1 }, "emailClicks", now);
    const second = aggregateParentHeatmap(profiles, rr, { ...filters, pageSize: 1, page: 2 }, "emailClicks", now);
    expect(first.maxCell).toBe(2);
    expect(second.maxCell).toBe(2);
    expect(first.months[11].isFuture).toBe(true);
    expect(first.rows[0].cells[11]).toBe(2);
    expect(second.rows[0].total).toBe(0);
  });
  it("shows all metric choices and honors the selected profile intersection", () => {
    const rr = [...records, record("opp", { accountId: 2, kind: "opportunity" })];
    expect(aggregateParentHeatmap(profiles, rr, filters, "leads").rows[0].total).toBe(3);
    expect(aggregateParentHeatmap(profiles, rr, filters, "opportunities").rows[0].total).toBe(1);
    expect(aggregateParentHeatmap(profiles.slice(0, 1), rr, filters, "hot").rows[0].total).toBe(0);
    expect(aggregateParentHeatmap([], rr, filters, "touchpoints").rows).toEqual([]);
  });
});
