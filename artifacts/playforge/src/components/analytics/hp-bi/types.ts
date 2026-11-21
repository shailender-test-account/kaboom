import type { HpSalesAssignment, HpMonitoringContext, HpAccountPriority } from "@workspace/api-client-react";

export interface HpCrmDealIssue { dealId: number; title: string; accountId: number | null; accountName: string | null;
  reasons: string[]; opportunityReference?: string | null; outcomeReference?: string | null }
export interface HpCrmDeals { total: number; includedOpportunities: number; includedOutcomes: number; incompleteDeals: number;
  excludedDeals: number; issues: HpCrmDealIssue[]; suppressedMirrors: number; issueLimit?: number; issuesTruncated?: boolean }
export interface HpGtmQualification {
  formTypes?: ("lead_form" | "event_feedback")[];
  status: "Hot" | "Warm" | "Cold" | "Unqualified"; hotAccounts: number; warmAccounts: number; coldAccounts?: number;
  qualifiedAccounts: number; responses: number; undatedResponses: number; uploadDateResponses?: number;
  inboundStatus?: "Hot" | "Warm" | "Cold" | "Unclassified" | null;
  inboundHotResponses?: number; inboundWarmResponses?: number; inboundColdResponses?: number; inboundUnclassifiedResponses?: number;
  inboundAccounts?: number; inboundResponses?: number; inboundHotAccounts?: number; inboundWarmAccounts?: number; inboundColdAccounts?: number;
}
export interface HpBiAccount {
  priority?: HpAccountPriority;
  salesPeople?: HpSalesAssignment[];
  journeys?: { id: number; name: string }[];
  pendingJourneyRoutes?: number; failedJourneyRoutes?: number; unavailableJourneyRoutes?: number;
  gtm?: HpGtmQualification;
  missingFields?: string[]; incompleteMembers?: number;
  id: number; name: string; hpId: string | null; parentKey: string; parentName: string;
  segment: string; rad: string; industry: string | null; employeeSize: number | null;
  status?: "Hot" | "Warm" | "Cold" | "Unqualified";
  isNew: boolean; contacts: number; engagedContacts: number; touchpoints: number; touchpointsAllDates?:number;
  hot: number; warm: number; leads: number; opportunities: number;
  closedWon?: number; closedLost?: number; prospectiveValues?: Record<string, number>; bookedValues?: Record<string, number>;
  values: Record<string, number>; score: number | null; memberCount: number;
  categories: string[]; lastActivity: string | null;
  /** Latest completed monitoring among members; null if never monitored. */
  lastMonitoredAt?: string | null; monitoringCheckedMembers?: number; monitoringTotalMembers?: number;
  monitoringNeverMembers?: number; monitoringOverdueMembers?: number;
}
export interface HpBiPeriod {
  label: string; start: string; touchpoints: number; contacts: number;
  invitations: number; attendance: number; digital: number; content: number;
  other: number; leads: number; hot: number; warm: number; opportunities: number;
  values: Record<string, number>; categories: string[]; isFuture: boolean;
  closedWon?: number; closedLost?: number; prospectiveValues?: Record<string, number>; bookedValues?: Record<string, number>;
}
export interface HpBiRecord {
  provenance?: import("@workspace/api-client-react").InboundProvenance;
  responseRecordId?: string; qualificationRecordId?: string; relatedRecords?: HpBiRecord[];
  lineage?: { fileName?: string; sheet?: string; row?: number; fileId?: string; sourceId?: number; rowKey?: string;
    dealId?: number; valueMeaning?: string | null; currency?: string | null; opportunityConfirmed?: boolean;
    actualOpportunityDate?: string | null; actualOutcomeDate?: string | null };
  exclusionReasons?: string[]; externalEventId?: string;
  id: string; accountId: number; contactId: number | null; kind: string;
  occurredAt: string; category: string | null; product: string | null;
  horizonMonths: number | null; orderValue: number | null; currency: string | null;
  source: string; sourceName: string | null; status: string | null;
}
export interface HpBiDashboard {
  matchingLegalAccounts?: number;
  sortCurrencies?: string[];
  clientId: number; clientName: string; year: number; start: string; end: string;
  summary: { gtm?: HpGtmQualification; accounts: number; parentAccounts: number; newAccounts: number;
    contacts: number; newContacts: number; engagedContacts: number; engagedAccounts: number; touchpoints: number; touchpointsAllDates?:number;
    leads: number; hot: number; warm: number; opportunities: number;
    values: Record<string, number>; prospectiveValues: Record<string, number>;
    bookedValues: Record<string, number>; closedWon?: number; closedLost?: number; score: number | null;
    dealLifecycle?: { asOfDate: string | null; openDeals: number | null; avgOpenDealAge: number | null;
      avgDaysToClose: number | null; closedDurationSamples: number; winRate: number | null; closedOutcomes: number } };
  segments: { name: string; accounts: number; contacts: number; leads: number; hot: number; touchpoints: number }[];
  rads: { name: string; accounts: number; leads: number; touchpoints: number }[];
  quarters: HpBiPeriod[]; months: HpBiPeriod[];
  categories: { name: string; contacts: number; leads: number; hot: number; opportunities: number;
    touchpoints: number; values: Record<string, number>; buyers: number; whitespace: number;
    closedWon?: number; closedLost?: number; prospectiveValues?: Record<string, number>; bookedValues?: Record<string, number> }[];
  accounts: HpBiAccount[]; total: number; page: number; pageSize: number;
  quality: { rosterImported?: boolean; rosterLegalAccounts?: number; rosterParentGroups?: number; lastRosterImport?: string | null;
    incompleteAccounts?: number;
    baselineAccounts: number; baselineRows: number; lastImport: string | null;
    missingSegment: number; missingRad: number; unlinkedContacts: number;
    missingHorizon: number; unpricedOpportunities: number; missingCurrency: number;
    unresolvedMatches: number; crmDeals?: HpCrmDeals; scoreDescription: string; note: string };
  scoring: { formula: string; components: { name: string; description: string }[];
    hotRule: string; warmRule: string; orderValueRule: string; thresholds: Record<string, number> };
}
export interface HpBiDetail {
  intentSources?: { gtm: HpSourceIntent[]; journey: HpSourceIntent[] };
  clientId?: number;
  monitoringContext?: HpMonitoringContext[];
  /** Actual form evidence; deduplicate against its counted response projection. */
  formEvidence?: HpBiRecord[];
  gtmResponses?: { reference: string; accountId: number; product: string; horizonMonths: number | null;
    status: string; submittedAt: string | null; source: string; submissionDateOrigin?: string }[];
  sourceGtmResponses?: { reference: string; accountId: number; contactId: number | null; classification: string | null; product: string | null;
    horizonMonths: number | null; submittedAt: string | null; source: string; routingStatus: string | null }[];
  sourceGtmTruncated?: boolean;
  recordedInterests?: { accountId: number; contactId: number | null; product: string; source: string; occurredAt: string | null }[];
  interestsTruncated?: boolean;
  account: HpBiAccount; members: { id: number; name: string; dimensions: Record<string, unknown>;
    missingFields?: string[];
    variants: Record<string, unknown>[]; buyerCategories: string[]; whitespaceCategories: string[];
    abmClassification: string | null; buyingBehavior: string | null; globalAccount: boolean | null;
    profiled: boolean | null; propensity: string | null }[];
  contacts: { id: number; name: string; email: string | null; title: string | null;
    isNew: boolean; score: number; companyId: number;
    status?: "Hot" | "Warm" | "Cold" | "Unqualified"; intentScore?: number | null; tags?: string[]; stage?: string | null }[];
  records: HpBiRecord[]; months: HpBiPeriod[]; crmDeals?: HpCrmDeals;
}
export interface HpSourceIntent { product: string | null; category: string | null; status: string }
export interface HpBiFilters {
  gtmSource?: "lead_form" | "event_feedback";
  monitoring?: "never" | "overdue";
  qualification?: "Hot"|"Warm"|"Cold";
  salesPerson?: string; opportunity?: "Business Services" | "Business Collaboration" | "IT Hardware" | "Security";
  sortBy?: HpBiSortField; sortDir?: "asc" | "desc"; sortCurrency?: string;
  groupResponses?: boolean;
  incompleteOnly?: boolean;
  clientId: number; year?: number; segment?: string; rad?: string; basis?: string;
  search?: string; newOnly?: boolean; abmOnly?: boolean; page?: number; pageSize?: number; parentKey?: string;
  dimension?: string; dimensionValue?: string; month?: number; quarter?: number; kind?: string; category?: string;
}
export type HpBiSortField = "name" | "journey" | "segment" | "rad" | "contacts" | "engagedContacts" | "touchpoints" | "leads" | "hot"
  | "opportunities" | "closedWon" | "closedLost" | "values" | "bookedValues" | "score" | "lastActivity" | "status" | "gtmStatus";
export interface HpBiEvidence { records: (HpBiRecord & { accountName: string })[]; total: number; sourceRecordTotal?: number; page: number; pageSize: number }
