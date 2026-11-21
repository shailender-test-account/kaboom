import { describe, expect, it } from "vitest";
import { aggregateParentPivot, businessRange, pivotCsv, portfolioFor, type PivotInput } from "./hpParentPivot";
import { pivotQuerySchema } from "../routes/hpParentPivot";
import type { BusinessRecord } from "./hpBiMetrics";

const input = (overrides: Partial<PivotInput> = {}): PivotInput => ({
  clientId: 9, currentStart: "2026-09-01", currentEnd: "2026-09-30", previousStart: "2025-09-01", previousEnd: "2025-09-30",
  breakdown: "total", basis: "PS", page: 1, pageSize: 25, sortBy: "touchpoints", sortOrder: "desc", evidencePage: 1, ...overrides,
});
const profiles = [
  { company_id: 1, name: "GCC Child", parent_key: "a", parent_name: "Parent Alpha", gtm: "GCC", ps_rad: "R1", prt_rad: "A1", ps_tam_k: "100", prt_tam_k: null },
  { company_id: 2, name: "Government Child", parent_key: "a", parent_name: "Parent Alpha", gtm: "Gov/Edu", ps_rad: "A1", prt_rad: "D1", ps_tam_k: "0", prt_tam_k: "$20" },
  { company_id: 3, name: "No activity", parent_key: "b", parent_name: "Parent Beta", gtm: "GCC", ps_rad: null, prt_rad: null, ps_tam_k: "10–20", prt_tam_k: "0" },
];
const record = (id: string, accountId: number, product: string | null, kind = "other", amount: number | null = null, currency: string | null = null): BusinessRecord => ({
  id, accountId, contactId: accountId === 1 ? 10 : 11, product, category: null, kind,
  occurredAt: "2026-09-15T08:00:00Z", horizonMonths: 3, orderValue: amount, currency, source: "recorded", sourceName: null, status: null,
});
const currentRecords = [
  record("1", 1, "HP laptop"), record("2", 1, "HP laptop"), record("3", 2, "HP printer", "attendance"),
  record("4", 1, null), record("5", 2, "HP printer", "lead"), record("6", 2, "HP printer", "opportunity", 100, "INR"),
  record("7", 2, "HP printer", "opportunity", 40, "USD"), record("8", 2, "HP printer", "closed_won", 20, "USD"),
  record("foreign", 999, "HP laptop"),
];
const facts = (records: BusinessRecord[]) => ({ selected: profiles, records, contacts: [
  { id: 10, company_id: 1 }, { id: 11, company_id: 2 }, { id: 12, company_id: 3 },
] }) as any;

describe("HP parent pivot measurement", () => {
  it("classifies only explicit portfolio terms, leaving ambiguous and untagged evidence unassigned", () => {
    expect(portfolioFor(record("x", 1, "Workstation"))).toBe("PS");
    expect(portfolioFor(record("x", 1, "Managed Print services"))).toBe("Print");
    expect(portfolioFor(record("x", 1, "Printer and laptop"))).toBe("Unassigned");
    expect(portfolioFor(record("x", 1, "Business Services"))).toBe("Unassigned");
  });
  it("counts each touchpoint once, deduplicates people across columns and preserves separate currencies", () => {
    const { result } = aggregateParentPivot(input({ breakdown: "portfolio" }), facts(currentRecords), facts([record("prior", 1, "HP laptop")]));
    expect(result.totals.current).toMatchObject({ touchpoints: 4, engagedContacts: 2, leads: 1, hot: 1, opportunities: 2, opportunityValue: { INR: 100, USD: 40 }, bookedValue: { USD: 20 } });
    expect(result.totals.previous.touchpoints).toBe(1);
    expect(result.rows[0].cells.PS.current.touchpoints).toBe(2);
    expect(result.rows[0].cells.Print.current.touchpoints).toBe(1);
    expect(result.rows[0].cells.Unassigned.current.touchpoints).toBe(1);
    expect(Object.values(result.rows[0].cells).reduce((n, c) => n + c.current.engagedContacts, 0)).toBe(3);
  });
  it("intersects parent, segment, portfolio and RAD filters without leaking other groups", () => {
    const { result } = aggregateParentPivot(input({ parents: ["a"], segments: ["GCC"], portfolios: ["Print"], rads: ["Retention"] }), facts(currentRecords), facts([]));
    expect(result.population.accounts).toBe(1);
    expect(result.totals.current.touchpoints).toBe(0);
    const both = aggregateParentPivot(input({ parents: ["a"], segments: ["GCC", "Gov/Edu"], portfolios: ["PS", "Print"], breakdown: "segment_portfolio" }), facts(currentRecords), facts([])).result;
    expect(both.columns).toHaveLength(4);
    expect(both.totals.current.touchpoints).toBe(3);
    expect(both.population.accounts).toBe(2);
    const printRad = aggregateParentPivot(input({ basis: "Print", rads: ["Development"] }), facts(currentRecords), facts([])).result;
    expect(printRad.population.accounts).toBe(1);
    expect(printRad.totals.current.touchpoints).toBe(1);
  });
  it("retains inactive parents, current planning zeroes and explicitly missing TAM", () => {
    const { result } = aggregateParentPivot(input(), facts(currentRecords), facts([]));
    expect(result.total).toBe(2);
    expect(result.rows[0].planning).toMatchObject({ psTamK: 100, printTamK: 20, missingPsTam: 0, missingPrintTam: 1 });
    expect(result.rows[1].planning).toMatchObject({ psTamK: null, printTamK: 0, missingPsTam: 1 });
    expect(result.rows[1].cells.total.current.touchpoints).toBe(0);
  });
  it("pages rows without altering full totals and exports every matching parent safely", () => {
    const data = aggregateParentPivot(input({ pageSize: 1 }), facts(currentRecords), facts([]));
    expect(data.result.rows).toHaveLength(1);
    expect(data.result.total).toBe(2);
    expect(data.result.totals.current.touchpoints).toBe(4);
    expect(pivotCsv(data)).toContain("Parent Beta");
    data.allRows[0].parentName = "\t=CMD()";
    expect(pivotCsv(data)).toContain("'\t=CMD()");
  });
  it("scopes metric evidence to the selected parent, bucket, period and source kind", () => {
    const { result } = aggregateParentPivot(input({ breakdown: "portfolio", focusParent: "a", focusColumn: "Print", focusPeriod: "current", focusMetric: "opportunityValue" }), facts(currentRecords), facts([]));
    expect(result.evidence?.total).toBe(2);
    expect(result.evidence?.records.map(r => r.orderValue)).toEqual([100, 40]);
    const hidden = aggregateParentPivot(input({ parents: ["b"], focusParent: "a" }), facts(currentRecords), facts([])).result;
    expect(hidden.evidence?.total).toBe(0);
  });
  it("treats inclusive range endpoints as India calendar days", () => {
    expect(businessRange("2026-09-01", "2026-09-30")).toEqual({ start: "2026-09-01T00:00:00+05:30", end: "2026-09-30T18:30:00.000Z" });
  });
  it("validates real calendar days before coercion, bounds ranges and deduplicates filter arrays", () => {
    const base = { clientId: 9, currentStart: "2026-09-01", currentEnd: "2026-09-30", previousStart: "2025-09-01", previousEnd: "2025-09-30" };
    expect(pivotQuerySchema.safeParse({ ...base, currentStart: "2026-02-30" }).success).toBe(false);
    expect(pivotQuerySchema.safeParse({ ...base, currentEnd: "2026-08-31" }).success).toBe(false);
    expect(pivotQuerySchema.safeParse({ ...base, currentEnd: "2030-09-30" }).success).toBe(false);
    expect(pivotQuerySchema.safeParse({ ...base, portfolios: '["Bogus"]' }).success).toBe(false);
    expect(pivotQuerySchema.parse({ ...base, segments: '["GCC","GCC"]' }).segments).toEqual(["GCC"]);
  });
});
