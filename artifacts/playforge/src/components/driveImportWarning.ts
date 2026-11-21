import type { IntentInboundSource } from "@/hooks/use-intent";

export type DriveImportWarning = {
  title: string;
  summary: string;
  recommendations: string[];
  errors: string[];
};

export function driveImportWarning(source: IntentInboundSource | null | undefined): DriveImportWarning | null {
  if (!source) return null;
  const { imported = 0, skipped = 0, failed = 0, errors = [] } = source.lastSyncSummary ?? {};
  const paused = !source.enabled;
  const unsuccessful = source.lastSyncStatus === "failed" || source.lastSyncStatus === "partial" || failed > 0;
  if (!paused && !unsuccessful && skipped === 0) return null;

  const recommendations: string[] = [];
  if (paused) recommendations.push("Turn on automatic sync in Drive source settings, save, then run a sync.");
  if (unsuccessful) {
    const errorText = errors.join(" ").toLowerCase();
    if (/company.{0,25}(?:column|field|mapping)|map.{0,25}company/.test(errorText))
      recommendations.push("Map the Company Name column in Drive source settings, then retry the sync.");
    else if (/access|permission|not found|folder|forbidden/.test(errorText))
      recommendations.push("Check the Drive folder URL and access permissions, then retry the sync.");
    else
      recommendations.push("Review the failed files below, correct them in Drive, then retry the sync.");
  }
  if (skipped > 0)
    recommendations.push("Check skipped rows for a missing company name or Company Name mapping, then sync again.");

  return {
    title: "Drive import needs attention",
    summary: paused && !source.lastSyncedAt
      ? "Automatic sync is paused. No completed import is available yet."
      : `${paused ? "Automatic sync is paused. " : ""}Last run: ${imported} imported · ${skipped} skipped · ${failed} files failed.`,
    recommendations,
    errors,
  };
}