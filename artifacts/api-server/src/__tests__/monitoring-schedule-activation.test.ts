import { describe, expect, it } from "vitest";
import { monitoringNeedsActivation } from "../lib/monitoringScheduleActivation";

const previous = {
  enabled: true, clientId: 1, dailyLimit: 100,
  accountIds: [1, 2, 3, 4, 5], audienceIds: [], segmentIds: [], categoryIds: [10, 20],
};

describe("monitoring schedule edits", () => {
  it("activates a saved expansion from five accounts to the entire GCC list", () => {
    expect(monitoringNeedsActivation({ ...previous, audienceIds: [7] }, previous)).toBe(true);
  });
  it("activates new and resumed schedules but not paused changes", () => {
    expect(monitoringNeedsActivation(previous)).toBe(true);
    expect(monitoringNeedsActivation(previous, { ...previous, enabled: false })).toBe(true);
    expect(monitoringNeedsActivation({ ...previous, enabled: false, audienceIds: [7] }, previous)).toBe(false);
  });
  it("does not activate unchanged, name-only, reordered or duplicated selections", () => {
    expect(monitoringNeedsActivation({ ...previous }, previous)).toBe(false);
    expect(monitoringNeedsActivation({ ...previous, accountIds: [5, 4, 3, 2, 1, 1], categoryIds: [20, 10] }, previous)).toBe(false);
  });
  it("reactivates changed client, category, segment, individual account and increased limit", () => {
    for (const change of [
      { clientId: 2 }, { categoryIds: [30] }, { segmentIds: [8] },
      { accountIds: [1, 2, 3, 4, 5, 6] }, { dailyLimit: 200 },
    ]) expect(monitoringNeedsActivation({ ...previous, ...change }, previous)).toBe(true);
    expect(monitoringNeedsActivation({ ...previous, dailyLimit: 100 }, { ...previous, dailyLimit: 200 })).toBe(false);
  });
});
