import { describe, expect, it } from "vitest";
import { parentViewInputSchema, parentViewUpdateSchema } from "../routes/hpParentViews";

const config = () => ({ parents: [], segments: [], portfolios: [], rads: [], basis: "PS", metric: "touchpoints", breakdown: "total", datePolicy: "fy" });
describe("saved parent comparison configuration", () => {
  it("trims names and preserves all selected dimensions, metric and relative policy", () => {
    const c = { ...config(), parents: ["alpha", "beta"], segments: ["GCC", "Gov/Edu"],
      portfolios: ["PS", "Print", "Unassigned"], rads: ["Retention", "Unknown"], basis: "Print", metric: "bookedValue", breakdown: "segment_portfolio" };
    expect(parentViewInputSchema.parse({ name: "  Quarterly review  ", config: c })).toEqual({ name: "Quarterly review", config: c });
  });
  it("rejects empty/overlong names, unknown settings and transient report state", () => {
    for (const name of [" ", "x".repeat(101)])
      expect(parentViewInputSchema.safeParse({ name, config: config() }).success).toBe(false);
    for (const extra of [{ evidencePage: 3 }, { page: 2 }, { totals: {} }, { tenantId: 99 }])
      expect(parentViewInputSchema.safeParse({ name: "review", config: { ...config(), ...extra } }).success).toBe(false);
    expect(parentViewInputSchema.safeParse({ name: "review", clientId: 3, config: config() }).success).toBe(false);
    expect(parentViewInputSchema.safeParse({ name: "review", config: { ...config(), metric: "invented" } }).success).toBe(false);
    expect(parentViewInputSchema.safeParse({ name: "review", config: { ...config(), parents: ["a", "a"] } }).success).toBe(false);
    expect(parentViewInputSchema.safeParse({ name: "review", config: { ...config(), parents: Array.from({ length: 101 }, (_, i) => String(i)) } }).success).toBe(false);
  });
  it("requires real, bounded custom dates and rejects frozen dates on relative presets", () => {
    const dates = { currentStart: "2024-02-29", currentEnd: "2024-03-31", previousStart: "2023-02-28", previousEnd: "2023-03-31" };
    const c = { ...config(), datePolicy: "custom", ...dates };
    expect(parentViewInputSchema.safeParse({ name: "review", config: c }).success).toBe(true);
    for (const change of [{ currentStart: "2025-02-29" }, { currentEnd: "2024-02-01" }, { currentEnd: "2028-02-01" }, { previousStart: undefined }])
      expect(parentViewInputSchema.safeParse({ name: "review", config: { ...c, ...change } }).success).toBe(false);
    expect(parentViewInputSchema.safeParse({ name: "review", config: { ...c, datePolicy: "fy" } }).success).toBe(false);
  });
  it("supports rename-only and settings-only updates but no empty update", () => {
    expect(parentViewUpdateSchema.parse({ name: " New name " })).toEqual({ name: "New name" });
    expect(parentViewUpdateSchema.parse({ config: config() })).toEqual({ config: config() });
    expect(parentViewUpdateSchema.safeParse({}).success).toBe(false);
  });
});
