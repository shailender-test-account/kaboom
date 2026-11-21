import { expect, it } from "vitest";
import { researchAccountIsLive, RESEARCH_ACCOUNT_LEASE_MS } from "./researchAccountLease";
import { monitoringRunIsFresh } from "./monitoringRunProgress";

it("distinguishes fresh claims from expired and legacy orphaned claims", () => {
  const now = Date.now();
  expect(researchAccountIsLive("running", new Date(now), now)).toBe(true);
  expect(researchAccountIsLive("claimed", new Date(now), now)).toBe(true);
  expect(researchAccountIsLive("running", new Date(now - RESEARCH_ACCOUNT_LEASE_MS - 1), now)).toBe(false);
  expect(researchAccountIsLive("running", null, now)).toBe(false);
  expect(researchAccountIsLive("completed", new Date(now), now)).toBe(false);
});
it("does not label an old run failed if it is still making fresh progress", () => {
  const now = Date.now();
  expect(monitoringRunIsFresh({ status: "running", lastActivityAt: new Date(now) }, now)).toBe(true);
  expect(monitoringRunIsFresh({ status: "running", lastActivityAt: new Date(now - 16 * 60_000) }, now)).toBe(false);
  expect(monitoringRunIsFresh({ status: "failed", lastActivityAt: new Date(now) }, now)).toBe(false);
});
