import { expect, it } from "vitest";
import { getListSalesAccessHistoryUrl } from "@workspace/api-client-react";

it("serializes every tenant audit filter and cursor without changing their meaning", () => {
  const url = getListSalesAccessHistoryUrl({
    dateFrom: "2026-01-01", dateTo: "2026-01-31", actorId: 9, kind: "owners", beforeId: 26,
  });
  const parsed = new URL(url, "https://example.test");
  expect(parsed.pathname).toBe("/api/team-access/sales-history");
  expect(Object.fromEntries(parsed.searchParams)).toEqual({
    dateFrom: "2026-01-01", dateTo: "2026-01-31", actorId: "9", kind: "owners", beforeId: "26",
  });
  const unfiltered = new URL(getListSalesAccessHistoryUrl({ dateFrom: "2026-01-01", dateTo: "2026-01-31" }), "https://example.test");
  expect([...unfiltered.searchParams.keys()]).toEqual(["dateFrom", "dateTo"]);
});
