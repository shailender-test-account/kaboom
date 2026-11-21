import { describe, expect, it } from "vitest";
import { initialPivotDraft, pivotViewConfig, reopenPivotView, resolvePivotDates } from "./pivot-views";

describe("saved comparison date policy", () => {
  it("resolves fiscal and calendar rollovers explicitly in India", () => {
    expect(resolvePivotDates("fy", new Date("2026-10-31T18:29:59Z"))).toMatchObject({ cs: "2025-11-01", ce: "2026-10-31" });
    expect(resolvePivotDates("fy", new Date("2026-10-31T18:30:00Z"))).toMatchObject({ cs: "2026-11-01", ce: "2027-10-31", ps: "2025-11-01" });
    expect(resolvePivotDates("cal", new Date("2026-12-31T18:30:00Z"))).toMatchObject({ cs: "2027-01-01", ce: "2027-12-31", pe: "2026-12-31" });
  });
  it("preserves custom dates forever and saves no dates for a relative policy", () => {
    const config = pivotViewConfig(initialPivotDraft());
    const custom = { ...config, datePolicy: "custom" as const, currentStart: "2024-01-01", currentEnd: "2024-12-31", previousStart: "2023-01-01", previousEnd: "2023-12-31" };
    const restored = reopenPivotView(custom, new Date("2030-01-01T00:00:00Z"));
    expect(restored.cs).toBe("2024-01-01");
    expect(pivotViewConfig(restored)).toEqual(custom);
    const relative = reopenPivotView(config, new Date("2030-01-01T00:00:00Z"));
    expect(relative.ce).toBe("2030-10-31");
    expect(pivotViewConfig(relative)).not.toHaveProperty("currentEnd");
  });
  it("canonicalizes filter sets and never includes evidence or result state", () => {
    const draft = { ...initialPivotDraft(), parents: ["b", "a"], segments: ["GCC"], page: 9, evidencePage: 7, totals: {} };
    const config = pivotViewConfig(draft);
    expect(config.parents).toEqual(["a", "b"]);
    expect(config).not.toHaveProperty("page");
    expect(config).not.toHaveProperty("evidencePage");
    expect(config).not.toHaveProperty("totals");
    expect(pivotViewConfig(reopenPivotView(config))).toEqual(config);
  });
});
