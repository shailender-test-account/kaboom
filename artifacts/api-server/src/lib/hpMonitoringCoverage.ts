export type HpMonitoringFilter = "never" | "overdue";
const FRESHNESS_MS = 7 * 24 * 60 * 60 * 1000;

/** Completion timestamps only: evidence dates and intent status are irrelevant. */
export function hpMonitoringCoverage(members: { last_researched_at?: string | Date | null }[], now: number) {
  const dates = members.map(m => m.last_researched_at == null ? NaN : new Date(m.last_researched_at).getTime());
  const checked = dates.filter(Number.isFinite);
  const never = dates.length - checked.length;
  const stale = checked.filter(date => date < now - FRESHNESS_MS).length;
  return {
    lastMonitoredAt: checked.length ? new Date(Math.max(...checked)).toISOString() : null,
    monitoringCheckedMembers: checked.length,
    monitoringTotalMembers: dates.length,
    monitoringNeverMembers: never,
    monitoringOverdueMembers: never + stale,
  };
}

export function matchesHpMonitoring(
  coverage: ReturnType<typeof hpMonitoringCoverage>, filter?: HpMonitoringFilter,
) {
  return !filter || (filter === "never" ? coverage.monitoringNeverMembers > 0 : coverage.monitoringOverdueMembers > 0);
}
