import type { HpParentViewConfig } from "./pivot-types";
import { currentFiscalYear } from "./format";

export interface PivotDraft {
  cs: string; ce: string; ps: string; pe: string;
  parents: HpParentViewConfig["parents"]; segments: HpParentViewConfig["segments"];
  portfolios: HpParentViewConfig["portfolios"]; rads: HpParentViewConfig["rads"];
  basis: HpParentViewConfig["basis"]; metric: HpParentViewConfig["metric"];
  breakdown: HpParentViewConfig["breakdown"]; datePolicy: HpParentViewConfig["datePolicy"];
}
export function resolvePivotDates(policy: "fy" | "cal", now = new Date()) {
  const year = policy === "fy" ? currentFiscalYear(now)
    : Number(new Intl.DateTimeFormat("en", { timeZone: "Asia/Kolkata", year: "numeric" }).format(now));
  return policy === "fy"
    ? { cs: `${year - 1}-11-01`, ce: `${year}-10-31`, ps: `${year - 2}-11-01`, pe: `${year - 1}-10-31` }
    : { cs: `${year}-01-01`, ce: `${year}-12-31`, ps: `${year - 1}-01-01`, pe: `${year - 1}-12-31` };
}
export const initialPivotDraft = (): PivotDraft => ({
  ...resolvePivotDates("fy"), datePolicy: "fy", parents: [], segments: [], portfolios: [], rads: [],
  basis: "PS", metric: "touchpoints", breakdown: "total",
});
export function pivotViewConfig(d: PivotDraft): HpParentViewConfig {
  return { parents: [...d.parents].sort(), segments: [...d.segments].sort(), portfolios: [...d.portfolios].sort(),
    rads: [...d.rads].sort(), basis: d.basis, metric: d.metric, breakdown: d.breakdown, datePolicy: d.datePolicy,
    ...(d.datePolicy === "custom" ? { currentStart: d.cs, currentEnd: d.ce, previousStart: d.ps, previousEnd: d.pe } : {}) };
}
export function reopenPivotView(config: HpParentViewConfig, now = new Date()): PivotDraft {
  const dates = config.datePolicy === "custom"
    ? { cs: config.currentStart!, ce: config.currentEnd!, ps: config.previousStart!, pe: config.previousEnd! }
    : resolvePivotDates(config.datePolicy, now);
  return { ...dates, parents: config.parents, segments: config.segments, portfolios: config.portfolios,
    rads: config.rads, basis: config.basis, metric: config.metric, breakdown: config.breakdown, datePolicy: config.datePolicy };
}
