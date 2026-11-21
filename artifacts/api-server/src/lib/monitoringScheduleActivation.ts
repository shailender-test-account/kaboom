type MonitoringScope = {
  enabled: boolean;
  clientId: number | null;
  dailyLimit: number;
  audienceIds: number[];
  segmentIds: number[];
  categoryIds: number[];
  accountIds: number[];
};

const sameIds = (left: number[], right: number[]) => {
  const values = new Set(left);
  return values.size === new Set(right).size && right.every(id => values.has(id));
};

/** Name-only saves and reordered selections must not spend another research batch. */
export function monitoringNeedsActivation(next: MonitoringScope, previous?: MonitoringScope): boolean {
  if (!next.enabled) return false;
  if (!previous?.enabled) return true;
  return next.clientId !== previous.clientId
    || next.dailyLimit > previous.dailyLimit
    || (["audienceIds", "segmentIds", "categoryIds", "accountIds"] as const)
      .some(key => !sameIds(next[key], previous[key]));
}
