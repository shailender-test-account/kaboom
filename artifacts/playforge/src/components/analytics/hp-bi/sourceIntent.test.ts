import { expect, it } from "vitest";
import type { HpBiDetail } from "./types";
import { sourceIntent } from "./sourceIntent";

it("keeps source and category qualification independent and rolls up the strongest display status", () => {
  const d = {
    intentSources: {
      gtm: [{ product: "Services", category: "Software & Services", status: "Warm" }],
      journey: [{ product: "Poly", category: "Virtual Collaboration", status: "Hot" }],
    },
    monitoringContext: [{ findings: [{ categories: [{ name: "IT Hardware", heat: "Warm" }] }] }],
  } as unknown as HpBiDetail;
  const result = sourceIntent(d);
  expect(result.statuses).toEqual({ gtm: "Warm", journey: "Hot", monitoring: "Warm" });
  expect(result.overall).toBe("Hot");
  expect(result.categories.find(c => c.category === "IT Hardware")).toEqual({
    category: "IT Hardware", gtm: "Not available", monitoring: "Warm", journey: "Not available",
  });
  expect(result.categories.find(c => c.category === "Virtual Collaboration")?.gtm).toBe("Not available");
});

it("does not borrow account status, browsing score or roster categories when source evidence is missing", () => {
  const d = { account: { status: "Hot", score: 999, categories: ["Hardware"] },
    intentSources: { gtm: [], journey: [] }, monitoringContext: [] } as unknown as HpBiDetail;
  expect(sourceIntent(d)).toMatchObject({ overall: "Not available", categories: [],
    statuses: { gtm: "Not available", monitoring: "Not available", journey: "Not available" } });
});

it("retains unknown-category source heat without fabricating a category, and deduplicates by strongest heat", () => {
  const d = { intentSources: {
    gtm: [{ product: "Unmapped", category: null, status: "Hot" },
      { category: "Services", product: "A", status: "Warm" }, { category: "Services", product: "B", status: "Hot" }],
    journey: [{ category: "Hardware", product: "PC", status: "Cold" }],
  } } as unknown as HpBiDetail;
  expect(sourceIntent(d)).toMatchObject({ overall: "Hot", categories: [
    { category: "Services", gtm: "Hot", journey: "Not available" },
  ] });
});
