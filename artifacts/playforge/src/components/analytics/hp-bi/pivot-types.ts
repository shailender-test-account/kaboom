import type { HpBiFilters, HpBiRecord } from "./types";
export type { HpParentView, HpParentViewConfig } from "@workspace/api-client-react";

export type PivotPortfolio = "PS" | "Print" | "Unassigned";
export type PivotBreakdown = "total" | "segment" | "portfolio" | "segment_portfolio" | "rad";
export type PivotMetric = "touchpoints" | "engagedContacts" | "leads" | "hot" | "warm" | "opportunities" | "closedWon" | "closedLost" | "opportunityValue" | "prospectiveValue" | "bookedValue";
export interface HpPivotInput extends HpBiFilters {
  currentStart: string; currentEnd: string; previousStart: string; previousEnd: string;
  parents?: string[]; segments?: string[]; portfolios?: PivotPortfolio[]; rads?: string[];
  breakdown?: PivotBreakdown; sortBy?: "touchpoints" | "leads" | "hot" | "opportunities";
  sortOrder?: "asc" | "desc";
  focusParent?: string; focusColumn?: string; focusPeriod?: "current" | "previous";
  focusMetric?: PivotMetric; evidencePage?: number;
}
export interface PivotMetrics {
  touchpoints: number; engagedContacts: number; leads: number; hot: number; warm: number;
  opportunities: number; closedWon: number; closedLost: number;
  opportunityValue: Record<string, number>; prospectiveValue: Record<string, number>; bookedValue: Record<string, number>;
}
export interface PivotPlanning {
  psTamK: number | null; printTamK: number | null; missingPsTam: number; missingPrintTam: number;
  psRad: Record<string, number>; printRad: Record<string, number>;
}
export interface HpParentPivot {
  periods: { current: { start: string; end: string }; previous: { start: string; end: string } };
  options: { parents: { key: string; name: string; accounts: number }[]; segments: string[] };
  columns: { key: string; label: string }[];
  rows: { parentKey: string; parentName: string; segments: string[]; accounts: number;
    planning: PivotPlanning; cells: Record<string, { current: PivotMetrics; previous: PivotMetrics }> }[];
  totals: { current: PivotMetrics; previous: PivotMetrics };
  population: { parents: number; accounts: number; contacts: number };
  page: number; pageSize: number; total: number;
  unassigned: { currentRecords: number; previousRecords: number };
  notes: string[];
  evidence?: { parentKey: string; columnKey: string; period: string; total: number; page: number; pageSize: number;
    records: (HpBiRecord & { accountName: string })[] };
}
