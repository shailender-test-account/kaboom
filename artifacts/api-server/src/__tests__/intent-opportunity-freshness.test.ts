import { describe, expect, it } from "vitest";
import { isFreshInboundHot, INBOUND_HOT_WINDOW_MS } from "../lib/intentOpportunityFreshness";

describe("inbound Hot handoff freshness", () => {
  const now = new Date("2026-09-27T12:00:00.000Z");

  it("allows recent explicit buying signals and the inclusive 90-day boundary", () => {
    expect(isFreshInboundHot(new Date(now.getTime() - 1000), now)).toBe(true);
    expect(isFreshInboundHot(new Date(now.getTime() - INBOUND_HOT_WINDOW_MS), now)).toBe(true);
  });

  it("requires reconfirmation for stale, missing, invalid, or future signals", () => {
    expect(isFreshInboundHot(new Date(now.getTime() - INBOUND_HOT_WINDOW_MS - 1), now)).toBe(false);
    expect(isFreshInboundHot(null, now)).toBe(false);
    expect(isFreshInboundHot("not a date", now)).toBe(false);
    expect(isFreshInboundHot(new Date(now.getTime() + 1000), now)).toBe(false);
  });
});