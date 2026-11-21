import { describe, expect, it } from "vitest";
import { driveImportWarning } from "./driveImportWarning";
import type { IntentInboundSource } from "@/hooks/use-intent";

const source = (overrides: Partial<IntentInboundSource> = {}): IntentInboundSource => ({
  id: 1, name: "Drive imports", clientId: 1, folderUrl: "https://drive.google.com/",
  formType: "lead_form", enabled: true, fieldMappings: {}, lastSyncedAt: "2026-09-27T10:00:00Z",
  lastSyncStatus: "completed", lastSyncSummary: {imported: 95, skipped: 0, failed: 0, errors: []},
  ...overrides,
});

describe("Drive import warning guidance", () => {
  it("disappears after a clean sync and does not appear without a source", () => {
    expect(driveImportWarning(null)).toBeNull();
    expect(driveImportWarning(source())).toBeNull();
  });
  it("explains how to address skipped rows and failed files together", () => {
    const warning = driveImportWarning(source({
      lastSyncStatus: "partial",
      lastSyncSummary: {imported: 95, skipped: 32, failed: 1, errors: ["Company Name mapping is missing"]},
    }));
    expect(warning?.summary).toContain("95 imported · 32 skipped · 1 files failed");
    expect(warning?.recommendations).toEqual([
      expect.stringContaining("Map the Company Name column"),
      expect.stringContaining("missing company name"),
    ]);
    expect(warning?.errors).toEqual(["Company Name mapping is missing"]);
  });
  it("recommends folder access fixes for permission errors", () => {
    expect(driveImportWarning(source({
      lastSyncStatus: "failed",
      lastSyncSummary: {imported: 0, skipped: 0, failed: 1, errors: ["Permission denied for folder"]},
    }))?.recommendations[0]).toContain("access permissions");
  });
  it("shows a next step when automatic sync is paused", () => {
    expect(driveImportWarning(source({enabled: false}))?.recommendations[0]).toContain("Turn on automatic sync");
  });
});