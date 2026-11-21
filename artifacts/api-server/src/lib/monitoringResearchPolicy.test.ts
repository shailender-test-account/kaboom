import { afterEach, expect, it, vi } from "vitest";
import { copiedDataSafetyEnabled, monitoringResearchAllowed } from "./monitoringResearchPolicy";

afterEach(() => vi.unstubAllEnvs());
it("keeps research paused when copied-data safety has no explicit monitoring exception", () => {
  vi.stubEnv("COPIED_DATA_SAFE_MODE", "true");
  vi.stubEnv("MONITORING_RESEARCH_ENABLED", "");
  expect(monitoringResearchAllowed()).toBe(false);
  vi.stubEnv("MONITORING_RESEARCH_ENABLED", "false");
  expect(monitoringResearchAllowed()).toBe(false);
});
it("allows explicitly approved monitoring without disabling the copied-data protection", () => {
  vi.stubEnv("COPIED_DATA_SAFE_MODE", "true");
  vi.stubEnv("MONITORING_RESEARCH_ENABLED", "true");
  expect(monitoringResearchAllowed()).toBe(true);
  expect(copiedDataSafetyEnabled()).toBe(true);
});
it("preserves normal research behavior outside copied-data safety mode", () => {
  vi.stubEnv("COPIED_DATA_SAFE_MODE", "false");
  vi.stubEnv("MONITORING_RESEARCH_ENABLED", "false");
  expect(monitoringResearchAllowed()).toBe(true);
});
