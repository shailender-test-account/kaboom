import { useQuery, useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { getIntentAccountDetail, type GetIntentAccountDetailParams, getIntentContactDetail, type GetIntentContactDetailParams, type HpMonitoringContext } from "@workspace/api-client-react";

const api = (path: string, init?: RequestInit) => fetch(`/api${path}`, { credentials: "include", ...init }).then(async r => {
  if (!r.ok) {
    const text = await r.text();
    try {
      const parsed = JSON.parse(text);
      throw new Error(parsed.error || text || r.statusText);
    } catch (error) {
      if (error instanceof Error && error.message !== text) throw error;
      throw new Error(text || r.statusText);
    }
  }
  if (r.status === 204) return null;
  return r.json();
});

export interface IntentOverview {
  surgingAccounts: number;
  hotAccounts: number;
  hotContacts: number;
  activeSignals30d: number;
  pendingRecommendations: number;
  totalAccounts: number;
  totalContacts: number;
  tierBreakdown: Array<{ tierKey: string; count: number }>;
  tierThresholds?: Array<{ key: string; label: string; minScore: number }>;
}

export type IntentCategoryScope = {
  /** Shared inbound-derived category for Intent Engine scopes. */
  categoryName?: string;
  /** Legacy catalog-ID scope retained for bookmarked links. */
  categoryIds?: string;
};

export interface SalesDashboardResponse {
  scope: {
    categoryIds: number[];
    requestedCategoryIds: number[];
    categoryName: string | null;
    categoryNames: string[];
    label: string;
  };
  summary: { hotAccounts: number; newSignals: number; categoryOpportunities: number; potentialPipeline: number; leadForms: number; units: number };
  categories: Array<{ id: string; name: string; categoryName: string; legacyCategoryIds: number[]; imageKey: string; score: number; hotAccounts: number; warmAccounts: number; coldAccounts: number; signals: number; pipeline: number; units: number; accountCount: number }>;
  topAccounts: Array<{ id: number; name: string; score: number; tier: string; categoryId: number | null; categoryIds: number[]; categoryName: string; productName?: string; whyNow?: string; lastSignalAt?: string; lastResearchedAt?: string | null }>;
  pipelineCoverage: { matchedSubmissions: number; unmatchedSubmissions: number; pricedProducts: number; totalProducts: number };
}

export interface PipelinePricingResponse {
  currency: string;
  categories: Array<{ id: number; name: string; products: Array<{ id: number; name: string; averageUnitPrice: number }> }>;
}

export interface IntentDrivingSignal {
  evidenceId: number; signalType: string; quote: string; sourceUrl?: string | null; occurredAt: string; strength: string;
  firstPartySource?: { kind: "inbound_submission" | "intent_evidence"; id: number; formType?: string };
}

export interface IntentAccount {
  id: number;
  name: string;
  domain?: string;
  industry?: string;
  score: number;
  tierKey: string;
  tierLabel: string;
  tierColor: string;
  trendDelta: number;
  lastSignalAt?: string;
  lastResearchedAt?: string | null;
  contributions: any[];
  contacts: any[];
  scoreHistory: any[];
  signals: any[];
  recentSignals: any[];
  recommendations: IntentRecommendation[];
  latestRecommendation?: IntentRecommendation | null;
  evidence?: IntentEvidenceGroups;
  excludedHistoricalSignals?: { count: number; latestAt?: string | null };
  analysisScope?: { selectedProductIds: number[]; selectedCategoryIds?: number[] };
  intentStatus?: {
    accountStatus: "hot" | "warm" | "cold";
    accountFlag: "category_open" | null;
    accountExplanation: string;
    accountDrivingSignals: IntentDrivingSignal[];
    negativeConflict: boolean;
    evaluatedAt: string;
    rulesVersion: number;
    categories: Array<{
      key: "SOFTWARE_SERVICES" | "IT_HARDWARE" | "POLY_COLLAB" | "PRINTERS_PRINT";
      name: string;
      status: "hot" | "warm" | "cold";
      attribution: "CONFIRMED" | "PROBABLE" | "POSSIBLE" | "INHERITED_OPEN" | "NONE";
      drivingSignals: IntentDrivingSignal[];
      lastTriggerDate?: string | null;
      expiresAt?: string | null;
      statusReason: string;
      nextPlay: string;
    }>;
  };
  canonicalCategoryIntent?: {
    categoryName: string;
    score: number;
    tier: string;
    rationale: string;
    strongestProduct?: string | null;
    signalCount?: number;
    confidence?: number;
    hasRecentPurchaseSignal?: boolean;
    source: "questionnaire" | "lead_form" | "approved_signals" | "research_propensity";
    inSelectedScope?: boolean;
  } | null;
  hpSolutionFit?: {
    clientName: string;
    sources: string[];
    recommendations: Array<{
      name: string;
      family: "Workforce Solutions" | "Business PCs" | "Commercial Printing" | "HP Poly";
      score: number;
      fit: "strong" | "moderate" | "exploratory";
      rationale: string;
      sourceUrl: string;
      evidence: Array<{ id: string | number; summary: string; source?: string | null; occurredAt?: string | null }>;
    }>;
  };
  productAnalysis?: {
    bestProduct?: { productId: number; productName: string; category: string; subcategory?: string | null; score: number; tier: string; inSelectedScope?: boolean; explanation?: string; supportingEvidence?: Array<{ signalType: string; summary: string; source: string; occurredAt: string }> } | null;
    hotProducts?: Array<{ productId: number; productName: string; score: number; tier: string; inSelectedScope?: boolean }>;
    topProducts?: Array<{ productId: number; productName: string; category: string; subcategory?: string | null; score: number; tier: string; inSelectedScope?: boolean }>;
    hotCategories?: Array<{ category: string; score: number; tier: string; signalHeads?: string[]; signalCount?: number; strongestProduct?: string | null; explanation?: string }>;
    topCategories?: Array<{ category: string; score: number; tier: string; inSelectedScope?: boolean; signalHeads?: string[]; signalCount?: number; strongestProduct?: string | null; explanation?: string; questionnaireDriven?: boolean; explicitSource?: "questionnaire" | "lead_form" | null }>;
    inboundIntent?: {
      classification: "hot" | "warm";
      reason: string;
      occurredAt: string;
      affinities: string[];
    } | null;
    signalTracking?: "complete" | "no_signals";
    signalCount?: number;
    questionnaireAnalysis?: {
      answerCount: number;
      assignedCount: number;
      unassignedCount: number;
      declaredTier?: "hot" | "warm" | "cold" | null;
      latestAt?: string | null;
      inferredCategories: string[];
      interpretation: string;
      answers: Array<{
        field: string; value: unknown; strength: number; reason: string; productId?: number | null; occurredAt: string;
        audit: { ageDays: number; originalPoints: number; currentPoints: number; decayFactor: number; nextDecayAt?: string | null; decayRule: string };
      }>;
    };
  };
  parentMonitoringContext?: HpMonitoringContext[];
  memberMonitoringContext?: HpMonitoringContext[];
  researchIntent?: {
    signalCount: number;
    pendingCount: number;
    approvedCount: number;
    latestAt?: string | null;
    opportunityBrief?: {
      fitmentPolicyVersion?: number;
      strongestOpportunity: string;
      whyNow: string;
      solutions: Array<{ priority: number; name: string; rationale: string }>;
      entryOffer: string;
      buyers: string[];
      outreachAngle: string;
      caution?: string | null;
      sourceUrls: string[];
      categoryConclusions: Array<{
        categoryId: number;
        categoryName: string;
        score: number;
        tier: "hot" | "warm" | "cold";
        accountFit: number;
        gaps: string[];
        opportunities: string[];
        rationale: string;
        evidenceStrength: "direct_intent" | "confirmed_need" | "business_trigger" | "context";
        recommendedProducts: Array<{ productId: number; name: string; rationale: string }>;
        buyers: string[];
        sourceUrls: string[];
        propensityBand?: "hot" | "warm" | "emerging" | "low";
        propensity?: {
          score: number;
          band: "hot" | "warm" | "emerging" | "low";
          components: {
            accountFit: number;
            need: number;
            refresh: number;
            purchaseReadiness: number;
            externalPressure: number;
          };
          momentum: number;
          negativeDeduction: number;
          dataConfidence: number;
          hasRecentPurchaseSignal: boolean;
          evidence: CategoryPropensityFact[];
        };
      }>;
      bestSelectedConclusion?: {
        categoryId: number;
        categoryName: string;
        score: number;
        tier: "hot" | "warm" | "cold";
        accountFit: number;
        gaps: string[];
        opportunities: string[];
        rationale: string;
        evidenceStrength: "direct_intent" | "confirmed_need" | "business_trigger" | "context";
        recommendedProducts: Array<{ productId: number; name: string; rationale: string }>;
        buyers: string[];
        sourceUrls: string[];
      } | null;
    };
    topics: Array<{
      label: string;
      score: number;
      tier: "hot" | "warm" | "cold";
      evidenceCount: number;
      pendingCount: number;
      approvedCount: number;
      latestAt?: string | null;
      solutions: string[];
      explanation: string;
    }>;
  };
}

export type CategoryPropensityFactKind = "account_fit" | "need" | "refresh" | "purchase" | "external_pressure" | "negative";

export interface CategoryPropensityFact {
  id: string;
  kind: CategoryPropensityFactKind;
  strength: number;
  occurredAt: string;
  halfLifeDays: number;
  sourceUrl?: string | null;
  sourceReliability: number;
  underlyingEventKey: string;
  explanation: string;
}

export interface IntentEvidence {
  id: string | number;
  evidenceKind?: string;
  title?: string;
  summary?: string;
  excerpt?: string;
  source?: string;
  provider?: string;
  sourceUrl?: string;
  capturedAt?: string;
  eventDate?: string;
  confidence?: number;
  contribution?: number;
  productName?: string;
  provenance?: string;
  accountId?: number;
  accountName?: string;
  productId?: number;
  reviewStatus?: "pending_review" | "approved" | "rejected" | string;
  eventType?: string;
  occurredAt?: string;
  rawEvidence?: Record<string, unknown>;
  context?: {
    sourceTitle?: string | null;
    country?: string | null;
    originalExcerpt?: string;
    aiReview?: {
      relevant?: boolean;
      confidence?: number;
      rationale?: string;
      inferredCategories?: string[];
      catalogProductIds?: number[];
      catalogMatched?: boolean;
      reviewedBy?: string;
    };
    answer?: {
      field?: string;
      value?: unknown;
      strength?: number;
      reason?: string;
    };
    formName?: string | null;
    campaign?: string | null;
    leadSource?: string | null;
    [key: string]: unknown;
  };
}

export interface IntentEvidenceGroups {
  public?: IntentEvidence[];
  uploaded?: IntentEvidence[];
  companyKaboom?: IntentEvidence[];
  contactKaboom?: IntentEvidence[];
}

export interface ResearchRunSummary {
  request?: {
    country?: string;
    eventTypes?: string[];
    accountIds?: number[];
  };
  requests?: number;
  requestAttempts?: number;
  pages?: number;
  retries?: number;
  rateLimited?: number;
  recordsFetched?: number;
  recordsNormalized?: number;
  inserted?: number;
  usageLimit?: number;
  failures?: string[];
  received?: number;
  duplicates?: number;
  pendingReview?: number;
  accountsTotal?: number;
  accountsCompleted?: number;
  accountsRemaining?: number;
  accountsFailed?: number;
  accountsInterpreted?: number;
  cost?: {
    provider?: string;
    confirmedBillableRequests?: number;
    maximumBillableRequests?: number;
    unit?: string;
  };
}
export interface ResearchRun {
  id: string | number;
  provider?: string;
  status: "queued" | "running" | "completed" | "failed" | "not_configured" | string;
  startedAt?: string;
  completedAt?: string;
  reviewedCount?: number;
  discoveredCount?: number;
  error?: string;
  summary?: ResearchRunSummary;
}

export interface IntentResearchSummary {
  providerConfigured: boolean;
  availableProviders?: Array<"perplexity" | "newsapi" | "tavily" | "explorium">;
  analysisProvider?: "openai" | "replit_openai" | "unavailable";
  analysisConfigured?: boolean;
  contactProviderConfigured?: boolean;
  provider?: string;
  contactProvider?: string;
  status?: string;
  eventTaxonomy?: Array<{ key: string; label: string }>;
  reviewCounts?: { pending?: number; approved?: number; rejected?: number };
  latestRun?: ProviderRun | null;
  activeRunCount?: number;
  runs?: ResearchRun[];
}

export interface ContactDiscoveryCandidate {
  id: number;
  name: string;
  title?: string;
  companyName?: string;
  location?: string;
  seniority?: string;
  function?: string;
  email?: string;
  confidence?: number;
  source?: string;
}

export interface ContactDiscoveryRequest {
  audienceId?: number;
  clientId?: number;
  accountIds?: number[];
  seniorities: string[];
  functions: string[];
  locations: string[];
}

export interface ContactDiscoveryResponse {
  runId?: number;
  candidates: ContactDiscoveryCandidate[];
  providerConfigured?: boolean;
  providerUsed?: "database" | "apollo";
  databaseCount?: number;
  message?: string;
}

export interface ProviderRun extends ResearchRun {
  summary?: ResearchRunSummary;
}

export interface ProductMatrixCell {
  productId: number;
  productName: string;
  status: "hot" | "warm" | "cold" | string;
  score: number;
  trendDelta?: number;
  lastSignalAt?: string;
  matchedContacts?: number;
  explanation?: string;
  questionnaireAging?: {
    currentPoints: number;
    originalPoints: number;
    retainedPercent: number;
  };
}

export interface ProductMatrixAccount {
  accountId: number;
  accountName: string;
  lastResearchedAt?: string | null;
  cells: ProductMatrixCell[];
}

export interface ProductMatrixResponse {
  products: { id: number; name: string }[];
  accounts: ProductMatrixAccount[];
}

export interface IntentEvidenceResponse {
  evidence: IntentEvidence[];
  page: number;
  pageSize: number;
}

export interface AdditiveContactScoreBreakdown {
  id: number;
  name: string;
  journeyPoints: number;
  affinityPoints: number;
  total: number;
  affinities: string[];
}

export interface AdditiveSignalScoreBreakdown {
  evidenceId: number;
  eventType: string;
  occurredAt: string;
  sourceUrl: string | null;
  category: string | null;
  productName: string | null;
  reason: string;
  points: 5;
}

export interface AccountScoreBreakdown {
  accountId: number;
  total: number;
  contactPoints: number;
  accountSignalPoints: number;
  contacts: AdditiveContactScoreBreakdown[];
  signals: AdditiveSignalScoreBreakdown[];
}

export interface ContactScoreBreakdown {
  id: number;
  name: string;
  journeyPoints: number;
  affinityPoints: number;
  total: number;
  affinities: string[];
}

export interface IntentContact {
  id: number;
  name: string;
  email?: string;
  phone?: string;
  title?: string;
  companyName?: string;
  companyId?: number;
  score: number;
  tierKey: string;
  tierLabel: string;
  tierColor: string;
  signals: any[];
  scoreHistory: any[];
  contributions: any[];
  existingBehavior?: any;
  activityEvidence?: any[];
  evidence?: IntentEvidenceGroups;
  recommendations?: IntentRecommendation[];
  latestRecommendation?: IntentRecommendation | null;
}

export interface ContactEngagement {
  gtmStatus: string;
  gtmEvidence: { items: Array<{
    id: string; sourceType: string; sourceName: string; occurredAt: string | null;
    qualification: string; product: string | null; horizonMonths: number | null; journey: string | null;
    answers: Record<string, unknown>; feedback: Record<string, unknown>; reason?: string | null;
    provenance?: import("@workspace/api-client-react").InboundProvenance;
  }>; total: number; page: number; pageSize: number; hasMore: boolean };
  timeline: { items: Array<{
    id: string; occurredAt: string | null; kind: string; source: string; description: string | null;
    journey: string | null; page: string | null; stage: string | null; product: string | null;
    scoreDelta: number | null; oldScore: number | null; newScore: number | null;
    qualification: string | null; isBot: boolean;
  }>; total: number; page: number; pageSize: number; hasMore: boolean };
}

export function useIntentContactEngagement(id: string, params: Record<string, any>, gtmPage: number, timelinePage: number, enabled: boolean) {
  return useQuery({
    queryKey: ["intent", "contacts", id, params, "engagement", gtmPage, timelinePage],
    enabled, staleTime: 30_000, retry: 1,
    queryFn: ({ signal }): Promise<ContactEngagement> =>
      getIntentContactDetail(Number(id), { ...params, section: "engagement", gtmPage, timelinePage },
        { signal, credentials: "include" }) as unknown as Promise<ContactEngagement>,
  });
}

export interface IntentRecommendation {
  id: number;
  title: string;
  summary: string;
  targetIdentity?: string;
  targetType: string;
  targetId: number;
  tierKey: string;
  playType: string;
  generatedAt: string;
  status: string;
  options: any[];
  generationStatus?: string;
}

export interface ImportPreview {
  headers: string[];
  mappingFields: { key: string, label: string, requiredForKinds: string[] }[];
  rows: { rowNumber: number, status: string, normalized: any, match: any, errors: string[] }[];
  summary: { valid: number; invalid: number; total: number };
}

export interface IntentImportRun {
  id: number;
  clientId?: number;
  productId?: number;
  audienceId?: number;
  kind: string;
  fileName?: string;
  status: string;
  totalRows: number;
  insertedRows: number;
  skippedRows: number;
  failedRows: number;
  unmatchedRows: number;
  createdAt: string;
  completedAt?: string;
}

export interface IntentImportsResponse {
  imports: IntentImportRun[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface ScopeOptions {
  rosters?: { clientId: number; name: string; memberCount: number }[];
  clients: { id: number; name: string }[];
  segments: { id: number; name: string; memberCount?: number }[];
  categories: { id: number; name: string }[];
  categoryNames: string[];
  subcategories: { id: number; categoryId: number; name: string }[];
  products: { id: number; categoryId: number; subcategoryId?: number | null; name: string; active: boolean; inboundCategoryName: string }[];
  audiences: { id: number; name: string; clientId?: number; description?: string }[];
  accounts: { id:number; name:string; domain?:string; clientId?:number }[];
  accountCount: number;
}

export const useIntentScopeOptions = (clientId?: number, enabled = true, includeAccounts = true) => useQuery<ScopeOptions>({
  queryKey: ["intent", "scope-options", clientId, includeAccounts],
  queryFn: () => {
    const params = new URLSearchParams();
    if (clientId) params.set("clientId", String(clientId));
    if (!includeAccounts) params.set("includeAccounts", "false");
    return api(`/intent/scope-options?${params}`);
  },
  enabled,
});

export const useIntentCompanies = (params: { clientId?: number; search?: string }) => useQuery<{ id: number; name: string; domain?: string }[]>({
  queryKey: ["intent", "companies", params],
  queryFn: () => {
    const q = new URLSearchParams();
    if (params.clientId) q.append("clientId", String(params.clientId));
    if (params.search) q.append("search", params.search);
    return api(`/intent/companies?${q.toString()}`);
  }
});

export const useCreateAudience = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: any) => api("/intent/audiences", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data)
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["intent", "scope-options"] });
    }
  });
};

export const useDeleteAudience = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api(`/intent/audiences/${id}`, {
      method: "DELETE"
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["intent", "scope-options"] });
    }
  });
};

export const useIntentCatalog = () => useQuery({
  queryKey: ["intent", "catalog"],
  queryFn: () => api("/intent/catalog")
});

export const useCreateCatalogItem = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ type, data }: { type: 'category' | 'subcategory' | 'product', data: any }) => api(`/intent/catalog/${type}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data)
    }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["intent"] })
  });
};

export const useUpdateCatalogItem = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ type, id, data }: { type: 'category' | 'subcategory' | 'product', id: number, data: any }) => api(`/intent/catalog/${type}/${id}`, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data)
    }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["intent"] })
  });
};

export const useDeleteCatalogItem = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ type, id }: { type: 'category' | 'subcategory' | 'product', id: number }) => api(`/intent/catalog/${type}/${id}`, {
      method: "DELETE"
    }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["intent"] })
  });
};

export const useIntentOverview = (params?: Record<string, any> & IntentCategoryScope) => useQuery<IntentOverview>({
  queryKey: ["intent", "overview", params],
  queryFn: ({ signal }) => {
    const q = new URLSearchParams();
    if (params) {
      Object.entries(params).forEach(([k, v]) => {
        if (v !== undefined && v !== null && v !== "") q.append(k, String(v));
      });
    }
    return api(`/intent/overview?${q.toString()}`, { signal });
  },
  staleTime: 15_000,
});

export const useIntentNavSummary = (params?: { clientId?: string | number; audienceId?: string | number }, enabled = true) => useQuery<{
  totalAccounts:number;activeSignals30d:number;hotAccounts:number|null;qualificationDeferred:boolean;
}>({
  queryKey: ["intent", "nav-summary", params?.clientId ?? null, params?.audienceId ?? null],
  enabled,
  queryFn: () => {
    const q = new URLSearchParams({ navOnly: "true" });
    if (params?.clientId) q.set("clientId", String(params.clientId));
    if (params?.audienceId) q.set("audienceId", String(params.audienceId));
    return api(`/intent/overview?${q.toString()}`);
  },
  staleTime: 60_000,
});

export type SalesDashboardFilters = { categoryName?: string; categoryIds?: string };

export const useSalesDashboard = (params?: SalesDashboardFilters) => useQuery<SalesDashboardResponse>({
  queryKey: ["intent", "sales-dashboard", params],
  queryFn: () => {
    const query = new URLSearchParams();
    if (params?.categoryName) query.set("categoryName", params.categoryName);
    else if (params?.categoryIds) query.set("categoryIds", params.categoryIds);
    return api(`/intent/sales-dashboard${query.size ? `?${query}` : ""}`);
  },
});

export const usePipelinePricing = () => useQuery<PipelinePricingResponse>({
  queryKey: ["intent", "pipeline-pricing"],
  queryFn: () => api("/intent/pipeline-pricing"),
});

export const useUpdatePipelinePricing = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { currency: string; prices: Array<{ productId: number; averageUnitPrice: number }> }) => api("/intent/pipeline-pricing", {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data),
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["intent", "pipeline-pricing"] });
      queryClient.invalidateQueries({ queryKey: ["intent", "sales-dashboard"] });
    },
  });
};

export const useIntentAccounts = (params: Record<string, any> & IntentCategoryScope) => useQuery<{ accounts: IntentAccount[], totalPages: number, total: number, coldCount?: number }>({
  queryKey: ["intent", "accounts", params],
  queryFn: ({ signal }) => {
    const q = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => {
      if (v !== undefined && v !== null && v !== "") q.append(k, String(v));
    });
    return api(`/intent/accounts?${q.toString()}`, { signal });
  },
  staleTime: 15_000,
});

type AccountBatch={accounts:IntentAccount[];hasMore:boolean;nextCursor:number|null;scanned:number};
export function useIntentAccountBatches(params:Record<string,any>&IntentCategoryScope){
  const {page:_page,...scope}=params;
  const query=useInfiniteQuery({
    queryKey:["intent","accounts","batches",scope],
    initialPageParam:0,
    queryFn:({pageParam,signal}):Promise<AccountBatch>=>{
      const qs=new URLSearchParams({bounded:"true",cursor:String(pageParam)});
      Object.entries(scope).forEach(([key,value])=>{
        if(value!==undefined&&value!==null&&value!=="")qs.set(key,String(value));
      });
      return api(`/intent/accounts?${qs}`,{signal});
    },
    getNextPageParam:last=>last.hasMore?last.nextCursor??undefined:undefined,
    staleTime:15_000,
    refetchOnWindowFocus:false,
  });
  const heat=(tier:string)=>tier==="hot"?2:tier==="warm"?1:0;
  const accounts=[...new Map((query.data?.pages.flatMap(batch=>batch.accounts)??[]).map(account=>[account.id,account])).values()]
    .sort((a,b)=>heat(b.tierKey)-heat(a.tierKey)||Number(b.score)-Number(a.score)||Number(a.id)-Number(b.id));
  const countTier=(tier:string)=>accounts.filter(account=>account.tierKey===tier).length;
  return {...query,data:query.data?{accounts,total:accounts.length,totalPages:1,
    scanned:query.data.pages.reduce((sum,batch)=>sum+batch.scanned,0),
    batchSummary:{totalAccounts:accounts.length,hotAccounts:countTier("hot"),
      tierBreakdown:["warm","cold"].map(tierKey=>({tierKey,count:countTier(tierKey)})),
      activeSignals30d:accounts.reduce((sum,account)=>sum+Number(account.productAnalysis?.signalCount??0),0),
      tierThresholds:[] as {key:string;minScore:number}[]},
  }:undefined};
}

export const useIntentAccount = (id: string | number, params?: Record<string, any>) => useQuery<IntentAccount>({
  queryKey: ["intent", "accounts", String(id), params],
  queryFn: () => {
    const q = new URLSearchParams();
    if (params) {
      Object.entries(params).forEach(([k, v]) => {
        if (v !== undefined && v !== null && v !== "" && v !== "all") q.append(k, String(v));
      });
    }
    const queryStr = q.toString();
    return api(`/intent/accounts/${id}${queryStr ? `?${queryStr}` : ''}`);
  },
  enabled: !!id,
  staleTime: 0,
  refetchOnMount: "always",
});

export type IntentAccountIdentity = Pick<IntentAccount, "id" | "name" | "domain" | "industry" | "lastResearchedAt" | "analysisScope">;
export type IntentAccountSection = "identity" | "evidence" | "research" | "analysis";
type CanonicalAccountIntent = IntentAccount["canonicalCategoryIntent"];
type AccountResearchPanel = Partial<IntentAccount> & { canonicalResearchIntent?: CanonicalAccountIntent };

/** Research candidates are never explicit first-party declarations. Preserve the
 * server's explicit-source > tier > score ordering, with product ties winning. */
export function mergeAccountCanonicalIntent(product: CanonicalAccountIntent, research: CanonicalAccountIntent) {
  if (!product) return research ?? null;
  if (!research || product.source === "questionnaire" || product.source === "lead_form") return product;
  const rank = (tier: string) => tier === "hot" ? 3 : tier === "warm" ? 2 : tier === "emerging" ? 1 : 0;
  const difference = rank(research.tier) - rank(product.tier);
  return difference > 0 || (difference === 0 && research.score > product.score) ? research : product;
}

/** Scope is part of every key and URL; never carry a previous account's panels forward. */
export function useProgressiveIntentAccount(id: string | number, params?: Record<string, any>) {
  const panel = <T,>(section: IntentAccountSection) => ({
    queryKey: ["intent", "accounts", String(id), params, section],
    queryFn: ({ signal }: { signal: AbortSignal }): Promise<T> => {
      const q = new URLSearchParams();
      Object.entries(params ?? {}).forEach(([key, value]) => {
        if (value !== undefined && value !== null && value !== "" && value !== "all") q.set(key, String(value));
      });
      q.set("section", section);
      return getIntentAccountDetail(Number(id), Object.fromEntries(q) as GetIntentAccountDetailParams, {
        signal, credentials: "include",
      }) as Promise<T>;
    },
    staleTime: 0,
    retry: 1,
    refetchOnMount: "always" as const,
  });
  const identity = useQuery({ ...panel<IntentAccountIdentity>("identity"), enabled: !!id });
  // Let identity paint before competing with evidence queries for the DB pool.
  const enabled = !!id && identity.isSuccess;
  const evidence = useQuery({ ...panel<Partial<IntentAccount>>("evidence"), enabled });
  const research = useQuery({ ...panel<AccountResearchPanel>("research"), enabled });
  const analysis = useQuery({ ...panel<Partial<IntentAccount>>("analysis"), enabled });
  const data = identity.data ? {
    ...identity.data, ...evidence.data, ...research.data, ...analysis.data,
    canonicalCategoryIntent: mergeAccountCanonicalIntent(analysis.data?.canonicalCategoryIntent, research.data?.canonicalResearchIntent),
  } : undefined;
  const refetch = useCallback(async () => Promise.all([identity.refetch(), evidence.refetch(), research.refetch(), analysis.refetch()]),
    [identity.refetch, evidence.refetch, research.refetch, analysis.refetch]);
  return { data, identity, evidence, research, analysis, refetch };
}

export function useProgressiveIntentContact(id: string | number, params?: Record<string, any>) {
  const panel = <T,>(section: "identity" | "evidence" | "analysis" | "recommendations") => ({
    queryKey: ["intent", "contacts", String(id), params, section],
    queryFn: ({ signal }: { signal: AbortSignal }): Promise<T> => {
      const q = new URLSearchParams();
      Object.entries(params ?? {}).forEach(([key, value]) => {
        if (value !== undefined && value !== null && value !== "" && value !== "all") q.set(key, String(value));
      });
      q.set("section", section);
      return getIntentContactDetail(Number(id), Object.fromEntries(q) as GetIntentContactDetailParams, {
        signal, credentials: "include",
      }) as Promise<T>;
    },
    staleTime: 0,
    retry: 1,
    refetchOnMount: "always" as const,
  });
  const identity = useQuery({ ...panel<Pick<IntentContact, "id" | "name" | "email" | "phone" | "title" | "companyId" | "companyName">>("identity"), enabled: !!id });
  const enabled = !!id && identity.isSuccess;
  const evidence = useQuery({ ...panel<Partial<IntentContact>>("evidence"), enabled });
  const analysis = useQuery({ ...panel<Partial<IntentContact>>("analysis"), enabled });
  const recommendations = useQuery({ ...panel<Partial<IntentContact>>("recommendations"), enabled });
  const data = identity.isSuccess ? { ...identity.data, ...evidence.data, ...analysis.data, ...recommendations.data } : undefined;
  return { data, identity, evidence, analysis, recommendations };
}

export const useIntentContact = (id: string | number, params?: Record<string, any>) => useQuery<IntentContact>({
  queryKey: ["intent", "contacts", String(id), params],
  queryFn: () => {
    const q = new URLSearchParams();
    if (params) {
      Object.entries(params).forEach(([k, v]) => {
        if (v !== undefined && v !== null && v !== "" && v !== "all") q.append(k, String(v));
      });
    }
    const queryStr = q.toString();
    return api(`/intent/contacts/${id}${queryStr ? `?${queryStr}` : ''}`);
  },
  enabled: !!id
});

export const useIntentAccountScoreBreakdown = (id: string | number) => useQuery<AccountScoreBreakdown>({
  queryKey: ["intent", "accounts", String(id), "score-breakdown"],
  queryFn: () => api(`/intent/accounts/${id}/score-breakdown`),
  enabled: !!id,
});

export const useIntentContactScoreBreakdown = (id: string | number, params?: Record<string, any>, enabled = true) => useQuery<ContactScoreBreakdown>({
  queryKey: ["intent", "contacts", String(id), "score-breakdown", params],
  queryFn: ({ signal }) => {
    const q = new URLSearchParams();
    Object.entries(params ?? {}).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== "" && value !== "all") q.set(key, String(value));
    });
    return api(`/intent/contacts/${id}/score-breakdown?${q}`, { signal });
  },
  enabled: !!id && enabled,
  staleTime: 0,
  retry: 1,
});

export const useIntentRecommendations = (params: Record<string, any>) => useQuery<{ recommendations: IntentRecommendation[], totalPages: number, total: number }>({
  queryKey: ["intent", "recommendations", params],
  queryFn: () => {
    const q = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => {
      if (v !== undefined && v !== null && v !== "") q.append(k, String(v));
    });
    return api(`/intent/recommendations?${q.toString()}`);
  }
});

export const useUpdateRecommendation = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: number; data: { status: string; note?: string } }) => api(`/intent/recommendations/${id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data)
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["intent"] });
    }
  });
};

export const useIntentConfig = () => useQuery<any>({ queryKey: ["intent", "config"], queryFn: () => api("/intent/config") });

export const useUpdateIntentConfig = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: any) => api("/intent/config", {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data)
    }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["intent"] })
  });
};

export const useIntentImports = () => useQuery<IntentImportsResponse>({ queryKey: ["intent", "imports"], queryFn: () => api("/intent/imports") });

export const useIntentImportsPreview = () => useMutation<ImportPreview, Error, any>({
  mutationFn: (data: any) => api("/intent/imports/preview", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data)
  })
});

export const useIntentGoogleSheetRead = () => useMutation<{
  spreadsheetId: string;
  title: string;
  spreadsheetUrl: string;
  range: string;
  headers: string[];
  rows: Record<string, unknown>[];
}, Error, { spreadsheet: string; range?: string }>({
  mutationFn: data => api("/intent/imports/google-sheet/read", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  }),
});

export const useIntentImportsCommit = () => {
  const queryClient = useQueryClient();
  return useMutation<any, Error, any>({
    mutationFn: (data: any) => api("/intent/imports/commit", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data)
    }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["intent"] })
  });
};

export const useIntentRecompute = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { scope: 'all' | 'accounts' | 'contacts' }) => api("/intent/recompute", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data)
    }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["intent"] })
  });
};

export const useIntentResearchSummary = (params?: Record<string, string | number | undefined>) => useQuery<IntentResearchSummary>({
  queryKey: ["intent", "research-summary", params],
  queryFn: () => {
    const query = new URLSearchParams();
    Object.entries(params || {}).forEach(([key, value]) => {
      if (value !== undefined && value !== "") query.set(key, String(value));
    });
    return api(`/intent/research/summary${query.size ? `?${query}` : ""}`);
  },
  refetchInterval: query => (query.state.data?.activeRunCount ?? 0) > 0 ? 3_000 : false,
});

export const useRunIntentResearch = () => {
  const queryClient = useQueryClient();
  return useMutation<ResearchRun & { summary?: ProviderRun["summary"] }, Error, { provider: "perplexity" | "newsapi" | "tavily" | "explorium"; audienceId?: number; clientId?: number; accountIds?: number[]; eventTypes: string[]; country: string; idempotencyKey: string }>({
    mutationFn: data => api("/intent/research/runs", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data)
    }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["intent"] })
  });
};

export const useRunMultiIntentResearch = () => {
  const queryClient = useQueryClient();
  return useMutation<
    { runs: Array<ResearchRun & { summary?: ProviderRun["summary"] }>; failures: Array<{ provider: string; message: string }> },
    Error,
    { providers: Array<"perplexity" | "newsapi" | "tavily" | "explorium">; audienceId?: number; clientId?: number; accountIds?: number[]; eventTypes: string[]; country: string }
  >({
    mutationFn: async ({ providers, ...scope }) => {
      const batchId = crypto.randomUUID();
      const results = await Promise.allSettled(providers.map(provider => api("/intent/research/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...scope, provider, idempotencyKey: `${batchId}:${provider}` }),
      })));
      const runs = results.flatMap(result => result.status === "fulfilled" ? [result.value] : []);
      const failures = results.flatMap((result, index) => result.status === "rejected" ? [{ provider: providers[index], message: result.reason instanceof Error ? result.reason.message : "Could not start research" }] : []);
      if (!runs.length) throw new Error(failures.map(failure => `${failure.provider}: ${failure.message}`).join(" · "));
      return { runs, failures };
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["intent"] }),
  });
};

export const useResumeIntentResearch = () => {
  const queryClient = useQueryClient();
  return useMutation<{ id: number; runId: number; status: string }, Error, number>({
    mutationFn: runId => api(`/intent/research/runs/${runId}/resume`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["intent"] }),
  });
};

export const useGenerateResearchOpportunity = () => {
  const queryClient = useQueryClient();
  return useMutation<{ opportunityBrief: NonNullable<IntentAccount["researchIntent"]>["opportunityBrief"] }, Error, number>({
    mutationFn: accountId => api(`/intent/accounts/${accountId}/research-analysis`, { method: "POST" }),
    onSuccess: (_result, accountId) => {
      queryClient.invalidateQueries({ queryKey: ["intent", "account", String(accountId)] });
      queryClient.invalidateQueries({ queryKey: ["intent"] });
    },
  });
};

export const useContactDiscovery = () => {
  const queryClient = useQueryClient();
  return useMutation<ContactDiscoveryResponse, Error, ContactDiscoveryRequest>({
    mutationFn: data => api("/intent/discovery/preview", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
        clientId: data.clientId,
        audienceId: data.audienceId,
        accountIds: data.accountIds,
        idempotencyKey: crypto.randomUUID(),
        criteria: { seniorities: data.seniorities, functions: data.functions, locations: data.locations },
      })
    }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["intent"] }),
  });
};

export const useIntentProviderRuns = () => useQuery<{ research: ProviderRun[]; discovery: ProviderRun[] }>({
  queryKey: ["intent", "provider-runs"],
  queryFn: async () => {
    const [research, discovery] = await Promise.all([
      api("/intent/research/runs?pageSize=10"),
      api("/intent/discovery/runs?pageSize=10"),
    ]);
    return { research: research.runs || [], discovery: discovery.runs || [] };
  },
});

export const useApproveContactDiscovery = () => {
  const queryClient = useQueryClient();
  return useMutation<{ approved?: number; contacts?: IntentContact[] }, Error, { runId: number; candidateIds: number[] }>({
    mutationFn: data => api(`/intent/discovery/${data.runId}/approve`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ candidateIds: data.candidateIds })
    }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["intent"] })
  });
};

export const useProductIntentMatrix = (params?: Record<string, string | number | undefined>) => useQuery<ProductMatrixResponse>({
  queryKey: ["intent", "product-matrix", params],
  queryFn: () => {
    const query = new URLSearchParams();
    Object.entries(params || {}).forEach(([key, value]) => {
      if (value !== undefined && value !== "") query.set(key, String(value));
    });
    return api(`/intent/product-matrix${query.size ? `?${query}` : ""}`);
  }
});

export const useIntentEvidenceReview = (reviewStatus: "pending_review" | "approved" | "rejected", accountId?: number) => useQuery<IntentEvidenceResponse>({
  queryKey: ["intent", "evidence", reviewStatus, accountId],
  queryFn: () => api(`/intent/evidence?reviewStatus=${encodeURIComponent(reviewStatus)}${accountId ? `&accountId=${accountId}` : ""}`)
});

export interface ResearchAttributionItem {
  id: number;
  accountId: number;
  accountName: string;
  eventType: string | null;
  originalExcerpt: string;
  excerpt: string | null;
  sourceUrl: string | null;
  occurredAt: string;
  reason: string;
}

export const useResearchAttributionQueue = (accountId?: number, cursor?: number | null) =>
  useQuery<{ items: ResearchAttributionItem[]; nextCursor: number | null }>({
    queryKey: ["intent", "attribution-review", accountId, cursor],
    queryFn: () => api(`/intent/research/attribution-review?${new URLSearchParams({
      ...(accountId ? { accountId: String(accountId) } : {}),
      ...(cursor ? { cursor: String(cursor) } : {}),
    })}`),
  });

export const useResearchAttributionHistory = (accountId: number) =>
  useQuery<{ items: Array<{ id: number; accountId: number; accountName: string; eventType: string; originalExcerpt: string; sourceUrl: string | null; reviews: Array<{ decision: string; reason: string; flagReason: string; reviewerId: number; fromAccountId: number; toAccountId: number; at: string }> }> }>({
    queryKey: ["intent", "attribution-history", accountId],
    queryFn: () => api(`/intent/research/attribution-review/history?accountId=${accountId}`),
  });

export const useRefreshResearchAttribution = () => {
  const queryClient = useQueryClient();
  return useMutation<unknown, Error, number>({
    mutationFn: id => api(`/intent/research/attribution-review/${id}/refresh`, { method: "POST" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["intent"] }),
  });
};

export const useDecideResearchAttribution = () => {
  const queryClient = useQueryClient();
  return useMutation<unknown, Error, { id: number; decision: "reject" | "retain" | "reassign"; reason: string; accountId?: number }>({
    mutationFn: ({ id, ...body }) => api(`/intent/research/attribution-review/${id}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["intent"] }),
  });
};

export const useReviewIntentEvidence = () => {
  const queryClient = useQueryClient();
  return useMutation<{ evidence: IntentEvidence }, Error, {
    id: string | number;
    reviewStatus: "approved" | "rejected";
    accountId?: number;
    productId?: number;
  }>({
    mutationFn: ({ id, ...data }) => api(`/intent/evidence/${id}/review`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data)
    }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["intent"] })
  });
};


export interface IntentMonitoringConfig {
  enabled: boolean;
  clientId?: number | null;
  audienceIds: number[];
  segmentIds: number[];
  categoryIds: number[];
  dailyLimit: number;
  lastScheduledAt?: string | null;
  lastScheduledCount?: number;
  lastLaneCounts?: IntentMonitoringLaneCounts;
  startedImmediately?: boolean;
  latestRun?: {
    status: "queued" | "running" | "completed" | "partial" | "failed";
    startedAt?: string | null;
    completedAt?: string | null;
    accountsTotal: number;
    accountsCompleted: number;
    accountsFailed: number;
    accountsRemaining: number;
    providers: Array<{ runId?: number; provider: string; status: string; accountsFailed: number }>;
    capacityWarning: boolean;
    laneCounts?: IntentMonitoringLaneCounts;
  } | null;
}

export interface IntentMonitoringLaneCounts {
  warm: { eligible:number;scheduled:number;completed:number;deferred:number;failed:number };
  prospect: { eligible:number;scheduled:number;completed:number;deferred:number;failed:number };
}

export interface IntentMonitoringSchedule extends IntentMonitoringConfig {
  id:number;
  name:string;
  accountIds:number[];
  createdAt?:string;
  updatedAt?:string;
}

export const useIntentMonitoringConfig = () => useQuery<IntentMonitoringConfig>({
  queryKey: ["intent", "monitoring-config"],
  queryFn: () => api("/intent/monitoring-config"),
  refetchInterval: query => {
    const status = query.state.data?.latestRun?.status;
    return status === "queued" || status === "running" ? 3_000 : false;
  },
});

export const useUpdateIntentMonitoringConfig = () => {
  const queryClient = useQueryClient();
  return useMutation<IntentMonitoringConfig,Error,Pick<IntentMonitoringConfig, "enabled" | "clientId" | "audienceIds" | "segmentIds" | "categoryIds" | "dailyLimit">>({
    mutationFn: (data: Pick<IntentMonitoringConfig, "enabled" | "clientId" | "audienceIds" | "segmentIds" | "categoryIds" | "dailyLimit">) => api("/intent/monitoring-config", {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data)
    }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["intent", "monitoring-config"] })
  });
};

export const useIntentMonitoringSchedules=()=>useQuery<{schedules:IntentMonitoringSchedule[]}>({
  queryKey:["intent","monitoring-configs"],
  queryFn:()=>api("/intent/monitoring-configs"),
  refetchInterval:query=>query.state.data?.schedules.some(schedule=>schedule.latestRun?.status==="queued"||schedule.latestRun?.status==="running")
    ?3_000:query.state.data?.schedules.some(schedule=>schedule.enabled)?15_000:false,
});

type MonitoringScheduleInput=Pick<IntentMonitoringSchedule,"name"|"enabled"|"clientId"|"audienceIds"|"segmentIds"|"accountIds"|"categoryIds"|"dailyLimit">;

export const useSaveIntentMonitoringSchedule=()=>{
  const queryClient=useQueryClient();
  return useMutation<IntentMonitoringSchedule,Error,{id?:number;data:MonitoringScheduleInput}>({
    mutationFn:({id,data})=>api(id?`/intent/monitoring-configs/${id}`:"/intent/monitoring-configs",{
      method:id?"PUT":"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(data),
    }),
    onSuccess:()=>queryClient.invalidateQueries({queryKey:["intent","monitoring-configs"]}),
  });
};

export const useSetIntentMonitoringScheduleStatus=()=>{
  const queryClient=useQueryClient();
  return useMutation<{ok:boolean},Error,{id:number;enabled:boolean}>({
    mutationFn:({id,enabled})=>api(`/intent/monitoring-configs/${id}/status`,{
      method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({enabled}),
    }),
    onSuccess:()=>queryClient.invalidateQueries({queryKey:["intent","monitoring-configs"]}),
  });
};

export interface IntentInboundSource {
  id:number; name:string; clientId:number; folderUrl:string; formType:"lead_form"|"event_feedback"; enabled:boolean;
  fieldMappings:Record<string,IntentInboundMappingTarget>;
  lastSyncedAt?:string|null; lastSyncStatus:string; lastSyncSummary?:{files?:number;imported?:number;skipped?:number;failed?:number;errors?:string[]};
}
export type IntentInboundMappingTarget="companyName"|"domain"|"firstName"|"lastName"|"name"|"email"|"phone"|"title"|"function"|"city"|"country"|"linkedinUrl"|"interest"|"demo"|"timeframe"|"productInterest"|"feedback"|"submittedAt"|"formType"|"overallExperience"|"clubSuggestions"|"hpSessionRating"|"workshopRating"|"demoRating"|"futureTopics"|"followUpDate"|"followUpTime"|"challenges"|"hpId"|"orderValue"|"currency";
export interface IntentInboundPreviewField {
  heading:string;automaticTarget:IntentInboundMappingTarget|null;savedTarget:IntentInboundMappingTarget|null;samples:string[];files:string[];
}
export interface IntentInboundPreview {
  files:number;scannedFiles:number;fields:IntentInboundPreviewField[];hasCompanyNameMapping:boolean;errors:string[];
}
export interface IntentInboundAccount {
  account_id:number; client_id:number; name:string; domain?:string|null; industry?:string|null; classification:"hot"|"warm"|"cold"|null; classification_reason:string;
  manual_details?:{editable?:boolean;contactName:string;contactEmail:string;contactPhone?:string;designation?:string;city?:string;productId:number;categoryName:string;purchaseTimeframeMonths:number|null;formType:"lead_form"|"event_feedback";eventName?:string;eventDate?:string;formFilledDate?:string}|null;
  form_type:"lead_form"|"event_feedback"|"manual";
  event_feedback?:Record<string,string>;
  submitted_at?:string|null; imported_at:string; response_count:number; product_interest?:string|null; feedback?:string|null;
  identityConflictCount:number;
  purchase_timeframe_months?:number|null; contact?:{id:number|null;name:string;email?:string|null;phone?:string|null;title?:string|null}|null;
  routes:Array<{journeyId:number|null;journeyName:string|null;sequenceId:number|null;sequenceName:string|null;
    status:"routed"|"configured"|"error"|"unknown";source:"rule"|"manual";responseCount:number}>;
  respondents:Array<{id:number|null;name:string;title:string;email:string|null;isPrimary:boolean;responseCount:number;
    interests:Array<{submissionId:number;selection:string;category:string|null;classification:"hot"|"warm";
      routingStatus:string;routingError:string|null;manualJourneyId:number|null;manualSequenceId:number|null;
      responseManuallyRouted:boolean}>}>;
}
export interface IntentEventFeedbackSummary {
  responseCount:number;
  ratings:Record<"overallExperience"|"hpSessionRating"|"workshopRating"|"demoRating",Array<{label:string;count:number}>>;
  requestedServices:Array<{label:string;count:number}>;
  futureTopics:Array<{label:string;count:number}>;
  followUpRequests:Array<{date:string|null;time:string|null;count:number}>;
  challenges:Array<{label:string;count:number}>;
}

export const useIntentInboundSource=(enabled=true)=>useQuery<{source:IntentInboundSource|null;googleDriveConnected:boolean}>({
  queryKey:["intent","inbound","source"],queryFn:()=>api("/intent/inbound/source"),
  enabled,refetchInterval:enabled?30_000:false,
});
export const useSaveIntentInboundSource=()=>{
  const queryClient=useQueryClient();
  return useMutation<{source:IntentInboundSource},Error,{name:string;clientId:number;folderUrl:string;formType:"lead_form"|"event_feedback";enabled:boolean;fieldMappings:Record<string,IntentInboundMappingTarget>}>({
    mutationFn:data=>api("/intent/inbound/source",{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify(data)}),
    onSuccess:()=>queryClient.invalidateQueries({queryKey:["intent","inbound"]}),
  });
};
export const useIntentInboundPreview=(enabled=true)=>useQuery<IntentInboundPreview>({
  queryKey:["intent","inbound","preview"],queryFn:()=>api("/intent/inbound/source/preview"),enabled,
});
export const useSyncIntentInboundSource=()=>{
  const queryClient=useQueryClient();
  return useMutation<{status:string;files:number;imported:number;skipped:number;failed:number},Error,void>({
    mutationFn:()=>api("/intent/inbound/source/sync",{method:"POST"}),
    onSuccess:()=>queryClient.invalidateQueries({queryKey:["intent","inbound"]}),
  });
};
export type IntentInboundSourceInput = Pick<IntentInboundSource,"name"|"clientId"|"folderUrl"|"formType"|"enabled"|"fieldMappings">;
const invalidateInboundSources=(queryClient:ReturnType<typeof useQueryClient>)=>{
  queryClient.invalidateQueries({queryKey:["intent","inbound","sources"]});
  queryClient.invalidateQueries({queryKey:["intent","inbound","dashboard"]});
  queryClient.invalidateQueries({queryKey:["intent","inbound","accounts"]});
  queryClient.invalidateQueries({queryKey:["intent","inbound","contacts"]});
  queryClient.invalidateQueries({queryKey:["intent","inbound","preview"]});
};
export const useIntentInboundSources=()=>useQuery<{sources:IntentInboundSource[];googleDriveConnected:boolean}>({
  queryKey:["intent","inbound","sources"],queryFn:()=>api("/intent/inbound/sources"),refetchInterval:30_000,
});
export const useCreateIntentInboundSource=()=>{
  const queryClient=useQueryClient();
  return useMutation<{source:IntentInboundSource},Error,IntentInboundSourceInput>({
    mutationFn:data=>api("/intent/inbound/sources",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(data)}),
    onSuccess:({source})=>{
      queryClient.setQueryData<{sources:IntentInboundSource[];googleDriveConnected:boolean}>(["intent","inbound","sources"],old=>old?{...old,sources:[...old.sources,source]}:old);
      invalidateInboundSources(queryClient);
    },
  });
};
export const useUpdateIntentInboundSource=()=>{
  const queryClient=useQueryClient();
  return useMutation<{source:IntentInboundSource},Error,{id:number;data:IntentInboundSourceInput}>({
    mutationFn:({id,data})=>api(`/intent/inbound/sources/${id}`,{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify(data)}),
    onSuccess:({source})=>{
      queryClient.setQueryData<{sources:IntentInboundSource[];googleDriveConnected:boolean}>(["intent","inbound","sources"],old=>old?{...old,sources:old.sources.map(item=>item.id===source.id?source:item)}:old);
      invalidateInboundSources(queryClient);
    },
  });
};
export const useIntentInboundSourcePreview=(id:number|undefined,enabled=true)=>useQuery<IntentInboundPreview>({
  queryKey:["intent","inbound","preview",id],queryFn:()=>api(`/intent/inbound/sources/${id}/preview`),enabled:enabled&&id!==undefined,
});
export const useSyncIntentInboundFolder=()=>{
  const queryClient=useQueryClient();
  return useMutation<{status:string;files:number;imported:number;skipped:number;failed:number},Error,number>({
    mutationFn:id=>api(`/intent/inbound/sources/${id}/sync`,{method:"POST"}),
    onSuccess:()=>invalidateInboundSources(queryClient),
  });
};
export type IntentInboundDashboardFilters={sourceId?:number;dateRange?:number;formType?:"lead_form"|"event_feedback";category?:string;product?:string};
export interface IntentInboundDashboard {
  summary:{accounts:number;hot:number;warm:number;cold:number;contacts:number};
  cohorts:Array<{clientId:number;categoryName:string;classification:"hot"|"warm"|"cold";
    accountCount:number;contactCount:number;alsoHotCount:number;accounts:{id:number;name:string;failed?:boolean;alsoHotOverall?:boolean}[];products:string[];
    routed:number;pending:number;failed:number}>;
  options:{categories:string[];products:Array<{name:string;categoryName:string;subcategoryName:string|null}>};
}
export const useIntentInboundDashboard=(params:IntentInboundDashboardFilters,enabled=true)=>useQuery<IntentInboundDashboard>({
  queryKey:["intent","inbound","dashboard",params],
  queryFn:()=>api(`/intent/inbound/dashboard?${new URLSearchParams(Object.entries(params).filter(([,v])=>v!==undefined&&v!=="").map(([k,v])=>[k,String(v)]))}`),
  enabled,
});
export interface IntentInboundContact {
  id:number;name:string;email:string|null;phone:string|null;title:string|null;
  accountId:number;accountName:string;
}
export const useIntentInboundContacts=(params:IntentInboundDashboardFilters & {page:number;pageSize:number},enabled=true)=>useQuery<{
  contacts:IntentInboundContact[];page:number;pageSize:number;total:number;totalPages:number;
}>({
  queryKey:["intent","inbound","contacts",params],
  queryFn:()=>api(`/intent/inbound/contacts?${new URLSearchParams(Object.entries(params).filter(([,v])=>v!==undefined&&v!=="").map(([k,v])=>[k,String(v)]))}`),
  enabled,
});
export type InboundCategoryRule = {categoryName:string;terms:string[]};
export type InboundCategoryConfig = {rules:InboundCategoryRule[];useBuiltin:boolean};
export const useInboundCategoryRules=()=>useQuery<InboundCategoryConfig & {categories:string[]}>({
  queryKey:["intent","inbound","category-rules"],
  queryFn:()=>api("/intent/inbound/category-rules"),
});
export const useSaveInboundCategoryRules=()=>{
  const queryClient=useQueryClient();
  return useMutation<InboundCategoryConfig,Error,InboundCategoryConfig>({
    mutationFn:config=>api("/intent/inbound/category-rules",{
      method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify(config),
    }),
    onSuccess:()=>queryClient.invalidateQueries({queryKey:["intent","inbound"]}),
  });
};
export const useIntentInboundAccounts=(params:{page?:number;pageSize?:number;search?:string;classification?:"hot"|"warm"|"cold"|"manual";sourceId?:number;formType?:"lead_form"|"event_feedback";dateRange?:number;category?:string;product?:string},enabled=true)=>useQuery<{
  accounts:IntentInboundAccount[];page:number;pageSize:number;total:number;totalPages:number;summary:{hot:number;warm:number;cold:number};eventFeedbackSummary:IntentEventFeedbackSummary|null;
}>({
  queryKey:["intent","inbound","accounts",params],
  queryFn:()=>api(`/intent/inbound/accounts?${new URLSearchParams(Object.entries(params).filter(([,v])=>v!==undefined&&v!=="").map(([k,v])=>[k,String(v)]))}`),
  enabled,
});
export interface InboundResponse {
  id:number;formType:string;fileName:string;submittedAt:string|null;submissionDateOrigin?:string;
  classification:"hot"|"warm"|"cold";classificationReason:string;productInterest:string|null;
  missingCategory:string|null;
  answers:Record<string,unknown>;
  identityConflict:null|{
    email:string;sourceAccountId:number;sourceAccountName:string|null;review:"keep"|"relink"|null;
    reviewedById:number|null;reviewedByName:string|null;reviewedAt:string|null;
    sourceContact:null|{id:number;name:string;email:string|null;phone:string|null;accountId:number;accountName:string|null};
    owner:{id:number;name:string;email:string|null;phone:string|null;accountId:number;accountName:string|null};
    canKeep:boolean;canRelink:boolean;ambiguousOwners:boolean;
  };
  affinities:Array<{selection:string;derivedProduct:string|null;categoryName:string;review:"confirmed"|"rejected"|"unreviewed"}>;
}
export const useInboundResponses=(accountId:number|null,sourceId?:number)=>useQuery<{
  accountName:string;responses:InboundResponse[];hasMore:boolean;
}>({
  queryKey:["intent","inbound","responses",accountId,sourceId],
  queryFn:()=>api(`/intent/inbound/accounts/${accountId}/responses${sourceId===undefined?"":`?sourceId=${encodeURIComponent(String(sourceId))}`}`),
  enabled:accountId!==null,
});
export const useUpdateInboundSubmissionDate=()=>{
  const queryClient=useQueryClient();
  return useMutation<{submittedAt:string},Error,{id:number;submittedDate:string}>({
    mutationFn:({id,...data})=>api(`/intent/inbound/responses/${id}/submission-date`,{
      method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify(data),
    }),
    onSuccess:()=>queryClient.invalidateQueries({queryKey:["intent"]}),
  });
};
export const useDeleteInboundResponse=()=>{
  const queryClient=useQueryClient();
  return useMutation<null,Error,number>({
    mutationFn:id=>api(`/intent/inbound/responses/${id}`,{method:"DELETE"}),
    onSuccess:()=>queryClient.invalidateQueries({queryKey:["intent","inbound"]}),
  });
};

export const useReviewInboundIdentity=()=>{
  const queryClient=useQueryClient();
  return useMutation<{review:"keep"|"relink"},Error,{
    id:number;action:"keep"|"relink";email:string;ownerContactId:number;sourceAccountId:number;sourceContactId:number|null;
  }>({
    mutationFn:({id,...data})=>api(`/intent/inbound/responses/${id}/identity-review`,{
      method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(data),
    }),
    onSuccess:()=>{
      queryClient.invalidateQueries({queryKey:["intent","inbound"]});
      queryClient.invalidateQueries({queryKey:["contacts"]});
    },
  });
};
export const useReviewInboundAffinity=()=>{
  const queryClient=useQueryClient();
  return useMutation<{review:string},Error,{id:number;selection:string;review:"confirmed"|"rejected"}>({
    mutationFn:({id,...data})=>api(`/intent/inbound/responses/${id}/affinity-review`,{
      method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify(data),
    }),
    onSuccess:()=>queryClient.invalidateQueries({queryKey:["intent","inbound"]}),
  });
};
export const useSetInboundCategory=()=>{
  const queryClient=useQueryClient();
  return useMutation<{category:string|null;updatedResponses:number},Error,{id:number;selection:string|null;category:string|null}>({
    mutationFn:({id,...data})=>api(`/intent/inbound/responses/${id}/category`,{
      method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify(data),
    }),
    onSuccess:()=>queryClient.invalidateQueries({queryKey:["intent","inbound"]}),
  });
};
export const useRouteInboundRespondent=()=>{
  const queryClient=useQueryClient();
  return useMutation<{routed:true;emailStarted?:boolean},Error,{submissionId:number;selection:string;journeyId:number;sequenceId:number;startSequence?:boolean}>({
    mutationFn:({submissionId,...data})=>api(`/intent/inbound/responses/${submissionId}/route`,{
      method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(data),
    }),
    onSuccess:()=>queryClient.invalidateQueries({queryKey:["intent","inbound"]}),
  });
};

export interface IntentInboundRoutingRule {
  id:number;name:string;clientId:number;matchType:"product"|"category"|"fallback";classification:"hot"|"warm"|"all";
  productId:number|null;productName?:string|null;inboundProductName?:string|null;
  categoryId:number|null;categoryName?:string|null;inboundCategoryName?:string|null;keywords:string[];
  journeyId:number|null;journeyName?:string|null;sequenceId:number;sequenceName:string;priority:number;enabled:boolean;
}
export interface IntentInboundRoutingRuleInput {
  name:string;clientId:number;matchType:"product"|"category"|"fallback";classification:"hot"|"warm"|"all";
  productId:number|null;productName:string|null;categoryId:number|null;categoryName:string|null;
  keywords:string[];journeyId:number|null;sequenceId:number;priority:number;enabled:boolean;
}
export interface IntentInboundRoutingRulesResponse {
  rules:IntentInboundRoutingRule[];
  categoryCohorts:Array<{clientId:number;categoryName:string;classification:"hot"|"warm"|"cold";
    accountCount:number;contactCount:number;accounts:{id:number;name:string}[];products:string[];
    routed:number;pending:number;failed:number}>;
  ruleCohorts:Array<{ruleId:number;name:string;classification:"hot"|"warm"|"all";matchType:"product"|"category"|"fallback";enabled:boolean;
    accountCount:number;accounts:Array<{id:number;name:string;responses:number;failures:string[]}>;
    routed:number;pending:number;failed:number}>;
  cohorts:Array<{clientId:number;productAffinity:string;categoryName:string;classification:"hot"|"warm"|"cold";accountCount:number;contactCount:number;accounts:{id:number;name:string}[];keywords:string[];routed:number;pending:number;failed:number}>;
  options:{
    clients:{id:number;name:string}[];categories:string[];
    products:{name:string;categoryName:string;subcategoryName:string|null}[];journeys:{id:number;name:string;clientId:number}[];
    sequences:{id:number;name:string;status?:string;clientId?:number|null}[];
  };
  summary:{routed:number;pending:number;failed:number};
}
export const useIntentInboundRoutingRules=(sourceId?:number,includeDraftSequences=false)=>useQuery<IntentInboundRoutingRulesResponse>({
  queryKey:["intent","inbound","routing-rules",sourceId,includeDraftSequences],
  queryFn:()=>{
    const params=new URLSearchParams();
    if(sourceId)params.set("sourceId",String(sourceId));
    if(includeDraftSequences)params.set("includeDraftSequences","true");
    return api(`/intent/inbound/routing-rules${params.size?`?${params}`:""}`);
  },
  staleTime:15_000,
  refetchOnMount:"always",
  refetchInterval:30_000,
});
export const useSaveIntentInboundRoutingRule=()=>{
  const queryClient=useQueryClient();
  return useMutation<{id:number;routing:{routed:number;pending:number;failed:number}},Error,{id?:number;data:IntentInboundRoutingRuleInput}>({
    mutationFn:({id,data})=>api(id?`/intent/inbound/routing-rules/${id}`:"/intent/inbound/routing-rules",{
      method:id?"PUT":"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(data),
    }),
    onSuccess:()=>{queryClient.invalidateQueries({queryKey:["intent","inbound"]});},
  });
};
export const useRetryIntentInboundRoutingRule=()=>{
  const queryClient=useQueryClient();
  return useMutation<{routing:{routed:number;pending:number;failed:number}},Error,{id:number;sourceId?:number}>({
    mutationFn:({id,sourceId})=>api(`/intent/inbound/routing-rules/${id}/retry${sourceId?`?sourceId=${sourceId}`:""}`,{method:"POST"}),
    onSuccess:()=>queryClient.invalidateQueries({queryKey:["intent","inbound"]}),
  });
};
export const useDeleteIntentInboundRoutingRule=()=>{
  const queryClient=useQueryClient();
  return useMutation<void,Error,number>({
    mutationFn:id=>api(`/intent/inbound/routing-rules/${id}`,{method:"DELETE"}),
    onSuccess:()=>queryClient.invalidateQueries({queryKey:["intent","inbound","routing-rules"]}),
  });
};

export const useConsolidateNoCategoryRoutes=()=>{
  const queryClient=useQueryClient();
  return useMutation<{keptId:number;removedIds:number[];retainedIds:number[]},Error,number>({
    mutationFn:clientId=>api("/intent/inbound/routing-rules/consolidate-no-category",{
      method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({clientId}),
    }),
    onSuccess:()=>queryClient.invalidateQueries({queryKey:["intent","inbound","routing-rules"]}),
  });
};
