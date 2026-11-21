import { pool } from "@workspace/db";
import { ReplitConnectors } from "@replit/connectors-sdk";
import { isFreshPublicResearchEvidence, publicResearchCutoff } from "./researchFreshness";
import { ResearchRequestAccountingError, researchRequestHook } from "./researchRequestAccounting";

export type ProviderStats = {
  requests: number;
  pages: number;
  retries: number;
  rateLimited: number;
  recordsFetched: number;
  recordsNormalized: number;
  failures: string[];
  usageLimit?: number;
  fallbackProvider?: ResearchProvider;
  primaryProviderFailed?: boolean;
  primaryFailures?: string[];
};

export type ProviderEvent = {
  accountId?: number;
  companyName?: string;
  domain?: string;
  eventType: "funding" | "layoffs" | "hiring" | "procurement" | "branch_opening" | "merger_acquisition" | "cxo_appointment" | "partnership" | "quarterly_financial" | "technology_integration" | "capital_investment" | "regulatory_action" | "operational_risk";
  occurredAt: string;
  sourceUrl?: string;
  excerpt: string;
  confidence: number;
  context: Record<string, unknown>;
};

export type ProviderContact = {
  companyId: number;
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  title?: string;
  function?: string;
  location?: string;
  sourceUrl?: string;
  confidence: number;
  rawEvidence: Record<string, unknown>;
};

export type ProviderResult<T> = { rows: T[]; stats: ProviderStats };
export const PUBLIC_RESEARCH_WINDOW_SQL = "3 months";
export type ResearchProvider = "perplexity" | "newsapi" | "tavily" | "explorium";

export class IntentProviderError extends Error {
  constructor(message: string, public readonly stats: ProviderStats, public readonly status?: number, public readonly partialRows: ProviderEvent[] = []) {
    super(message);
    this.name = "IntentProviderError";
  }
}

type Company = { id: number; name: string; domain: string | null };

import { getIntegrationConfig as configFor } from "./integrationCredentials";

export async function providerConfigured(tenantId: number, provider: ResearchProvider | "apollo"): Promise<boolean> {
  if (provider === "perplexity") return Boolean(process.env.REPLIT_CONNECTORS_HOSTNAME || process.env.CONNECTORS_HOSTNAME);
  if (provider === "tavily") return Boolean(process.env.TAVILY_API_KEY);
  if (provider === "explorium") return Boolean(process.env.EXPLORIUM_API_KEY);
  const config = await configFor(tenantId, provider);
  return config?.enabled !== false && typeof config?.apiKey === "string" && config.apiKey.length > 0;
}

export async function providerRequestLimit(tenantId: number, provider: ResearchProvider): Promise<number> {
  const defaults: Record<ResearchProvider, number> = { perplexity: 1000, newsapi: 100, tavily: 1000, explorium: 2000 };
  if (provider === "perplexity") return defaults.perplexity;
  const config = await configFor(tenantId, provider);
  return Math.max(1, Number(config?.maxRequestsPerRun) || defaults[provider]);
}
async function scopedCompanies(tenantId: number, clientId?: number, audienceId?: number, accountIds?: number[]): Promise<Company[]> {
  const result = await pool.query<Company>(
    `SELECT c.id,c.name,c.domain
       FROM companies c
      WHERE c.tenant_id=$1
        AND ($2::int IS NULL OR c.client_id=$2)
        AND ($3::int IS NULL OR EXISTS (
          SELECT 1 FROM intent_audience_companies ac
           WHERE ac.tenant_id=c.tenant_id AND ac.audience_id=$3 AND ac.company_id=c.id
        ))
        AND ($4::int[] IS NULL OR c.id=ANY($4::int[]))
        AND (NULLIF(btrim(c.name),'') IS NOT NULL OR NULLIF(btrim(c.domain),'') IS NOT NULL)
      ORDER BY c.id
      LIMIT 1000`,
    [tenantId, clientId ?? null, audienceId ?? null, accountIds?.length ? accountIds : null],
  );
  return result.rows;
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

async function requestJson<T>(
  url: string,
  init: RequestInit,
  stats: ProviderStats,
  label: string,
  maxRetries = 3,
  beforeRequest?: () => Promise<void>,
  afterRequest?: () => Promise<void>,
): Promise<T> {
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    if (stats.requests >= (stats.usageLimit ?? Number.MAX_SAFE_INTEGER)) {
      throw new IntentProviderError(`${label} usage limit reached`, stats);
    }
    await researchRequestHook(beforeRequest);
    stats.requests += 1;
    let response: Response;
    try {
      response = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
    } catch (error) {
      if (attempt === maxRetries) throw new IntentProviderError(`${label} request failed`, stats);
      stats.retries += 1;
      await sleep(250 * 2 ** attempt);
      continue;
    }
    // Confirmation failures are not network failures: the request already ran.
    await researchRequestHook(afterRequest);
    if (response.ok) return await response.json() as T;
    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable || attempt === maxRetries) {
      // Providers can echo credentials in error bodies. Persist status, never raw text.
      throw new IntentProviderError(`${label} returned HTTP ${response.status}`, stats, response.status);
    }
    if (response.status === 429) stats.rateLimited += 1;
    stats.retries += 1;
    const retryAfter = Number(response.headers.get("retry-after"));
    await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 10_000) : 250 * 2 ** attempt);
  }
  throw new IntentProviderError(`${label} request failed`, stats);
}

export function classifyArticle(text: string): ProviderEvent["eventType"] | null {
  return classifyArticleTypes(text)[0] ?? null;
}

export function classifyArticleTypes(text: string): ProviderEvent["eventType"][] {
  const value = text.toLowerCase();
  const matches: Array<[ProviderEvent["eventType"], RegExp]> = [
    ["procurement", /\b(rfp|rfq|request for (?:proposal|quotation|quote|bid)|invitation to (?:bid|tender)|expression of interest|eoi|tender(?:ing)?|procurement notice|purchase order|vendor registration|bid submission|pre-qualification)\b/],
    ["merger_acquisition", /\b(merger|acqui(?:res|red|sition)|bought|takeover)\b/],
    ["layoffs", /\b(layoff|laid off|job cuts|workforce reduction|redundan(?:cy|cies))\b/],
    ["funding", /\b(funding|fundraise|raises?|raised|series [a-f]|venture capital|financing)\b/],
    ["capital_investment", /\b(capital investment|invests? in|investment|spending plan)\b/],
    ["branch_opening", /\b(new (?:office|branch|facility)|opens? (?:a )?(?:new )?(?:office|branch)|expansion)\b/],
    ["cxo_appointment", /\b(appoints?|appointed|names?)\b.*\b(ceo|cfo|coo|cto|chief|president)\b/],
    ["partnership", /\b(partner(ship)?|strategic alliance|collaborat(?:es|ion))\b/],
    ["technology_integration", /\b(integrat(?:e|es|ed|ion)|api launch|technology partnership|new product|product launch|launches?|launched|unveils?|introduced|innovation)\b/],
    ["quarterly_financial", /\b(quarterly results?|earnings|revenue|profit|financial results?)\b/],
    ["hiring", /\b(hir(?:e|es|ed|ing)|recruit(?:s|ing)|jobs?|workforce growth)\b/],
    ["regulatory_action", /\b(customs?|regulator(?:y)?|penalt(?:y|ies)|fine[ds]?|compliance|sanction|notice|enforcement|misclassification|appeal(?:ed|ing)?|tribunal|sebi|fda|warning letter)\b/],
    ["operational_risk", /\b(disruption|recall|shortage|outage|incident|plant closure|supply risk|quality issue|administrative oversight|control failure)\b/],
  ];
  return matches.filter(([, pattern]) => pattern.test(value)).map(([type]) => type);
}

const DEFAULT_EVENT_TYPES: ProviderEvent["eventType"][] = ["funding", "layoffs", "hiring", "procurement", "branch_opening", "merger_acquisition", "cxo_appointment", "partnership", "quarterly_financial", "technology_integration", "capital_investment"];
const EVENT_SEARCH_TERMS: Record<string, string> = {
  funding: "funding", layoffs: "layoffs", hiring: "hiring", procurement: "RFP RFQ tender procurement bid vendor", branch_opening: "branch opening expansion", merger_acquisition: "merger acquisition",
  cxo_appointment: "executive CXO appointment", partnership: "partnership", quarterly_financial: "quarterly financial earnings",
  technology_integration: "technology integration", capital_investment: "capital investment", regulatory_action: "regulatory action compliance customs penalty fine investigation appeal",
  operational_risk: "operational risk disruption recall outage control failure",
};
function selectedTypes(types?: string[]) {
  return new Set<ProviderEvent["eventType"]>((types?.length ? types : DEFAULT_EVENT_TYPES).filter((type): type is ProviderEvent["eventType"] => type in EVENT_SEARCH_TERMS));
}
function publicSourceUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || !url.hostname || url.hostname === "localhost" || url.hostname.endsWith(".local")) return null;
    return url.toString();
  } catch { return null; }
}
function dateWindow() {
  const end = new Date();
  const start = publicResearchCutoff(end);
  return { startDate: start.toISOString().slice(0, 10), endDate: end.toISOString().slice(0, 10), timestampFrom: start.toISOString(), timestampTo: end.toISOString() };
}

function normalizedCompanyName(name: string) {
  return String(name ?? "").replace(/\b(ag|incorporated|inc|corp(?:oration)?|limited|ltd|plc|llc|group|holdings?)\.?$/i, "").trim();
}

function companySearchExpression(company: Company) {
  const variants = [company.name, normalizedCompanyName(company.name), company.domain]
    .map(value => String(value ?? "").trim())
    .filter(Boolean);
  return [...new Set(variants)].map(value => `"${value}"`).join(" OR ");
}

function eventQueryGroups(types: Set<ProviderEvent["eventType"]>) {
  const selected = [...types];
  const groups: ProviderEvent["eventType"][][] = [];
  for (let index = 0; index < selected.length; index += 4) groups.push(selected.slice(index, index + 4));
  return groups.slice(0, 3);
}

function researchMarket(country?: string) {
  const value = String(country ?? "India").trim() || "India";
  return value && value.toLowerCase() !== "global" ? value : "global";
}

const COUNTRY_CONTEXT_ALIASES: Record<string, string[]> = {
  Australia: ["Australia", "Australian"],
  Brazil: ["Brazil", "Brazilian"],
  Canada: ["Canada", "Canadian"],
  China: ["China", "Chinese"],
  France: ["France", "French"],
  Germany: ["Germany", "German"],
  India: ["India", "Indian"],
  Indonesia: ["Indonesia", "Indonesian"],
  Ireland: ["Ireland", "Irish"],
  Italy: ["Italy", "Italian"],
  Japan: ["Japan", "Japanese"],
  Mexico: ["Mexico", "Mexican"],
  Netherlands: ["Netherlands", "Dutch"],
  Singapore: ["Singapore", "Singaporean"],
  "South Africa": ["South Africa", "South African"],
  "South Korea": ["South Korea", "South Korean", "Korea"],
  Spain: ["Spain", "Spanish"],
  Switzerland: ["Switzerland", "Swiss"],
  "United Arab Emirates": ["United Arab Emirates", "UAE", "Emirati"],
  "United Kingdom": ["United Kingdom", "UK", "British", "Britain"],
  "United States": ["United States", "USA", "U.S.", "American"],
};

function hasCountryContext(value: unknown, country?: string) {
  const market = researchMarket(country);
  if (market === "global") return true;
  const text = typeof value === "string" ? value : JSON.stringify(value ?? {});
  return (COUNTRY_CONTEXT_ALIASES[market] ?? [market]).some(alias => new RegExp(`\\b${alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text));
}

function focusedCompanyQueries(company: Company, types: Set<ProviderEvent["eventType"]>, dateAfter: string, country?: string) {
  const companyExpression = companySearchExpression(company);
  const market = researchMarket(country);
  const locationClause = market === "global" ? "global coverage" : `focused on ${market}`;
  const selectedTerms = [...types].map(type => EVENT_SEARCH_TERMS[type]).filter(Boolean).join(" OR ");
  return [
    `(${companyExpression}) latest published financial business news quarterly results cost cutting infrastructure investment hiring branches mergers acquisitions after:${dateAfter} ${locationClause} company filings established business news -site:linkedin.com -site:facebook.com -site:twitter.com -site:x.com`,
    `(${companyExpression}) latest company news after:${dateAfter} ${locationClause} ${selectedTerms}`,
    ...(types.has("procurement") ? [`(${companyExpression}) RFP RFQ tender procurement notice invitation to bid vendor registration purchase order after:${dateAfter} ${locationClause} official organization website or indexed tender portal`] : []),
    ...(types.has("hiring") ? [`(${companyExpression}) careers jobs vacancies recruitment hiring after:${dateAfter} ${locationClause} official organization careers website or indexed job posting`] : []),
  ].slice(0, 4);
}

type TavilySearchPlan = {
  query: string;
  topic: "news" | "general";
  expectedTypes: Set<ProviderEvent["eventType"]>;
  searchKind: "news" | "tenders" | "jobs";
};

function tavilySearchPlans(company: Company, types: Set<ProviderEvent["eventType"]>, dateAfter: string, country?: string): TavilySearchPlan[] {
  const companyExpression = companySearchExpression(company);
  const market = researchMarket(country);
  const location = market === "global" ? "global" : market;
  const plans: TavilySearchPlan[] = [];
  if (types.has("procurement")) plans.push({
    query: `(${companyExpression}) (RFP OR RFQ OR tender OR "procurement notice" OR "invitation to bid" OR "vendor registration" OR "purchase order") after:${dateAfter} ${location}`,
    topic: "general",
    expectedTypes: new Set(["procurement"]),
    searchKind: "tenders",
  });
  if (types.has("hiring")) plans.push({
    query: `(${companyExpression}) (careers OR jobs OR vacancies OR recruitment OR hiring) after:${dateAfter} ${location} official careers site`,
    topic: "general",
    expectedTypes: new Set(["hiring"]),
    searchKind: "jobs",
  });
  const remaining = new Set([...types].filter(type => type !== "procurement" && type !== "hiring"));
  for (const group of eventQueryGroups(remaining)) plans.push({
    query: `(${companyExpression}) latest news ${group.map(type => EVENT_SEARCH_TERMS[type]).join(" OR ")} ${market === "global" ? "global coverage" : `in ${market}`}`,
    topic: "news",
    expectedTypes: new Set(group),
    searchKind: "news",
  });
  return plans.slice(0, 4);
}

function canonicalSourceIdentity(sourceUrl: string | null, title: unknown, providerId?: unknown) {
  if (sourceUrl) {
    const url = new URL(sourceUrl);
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|gclid|fbclid|ref$|source$)/i.test(key)) url.searchParams.delete(key);
    }
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, "");
    url.pathname = url.pathname.replace(/\/+$/, "") || "/";
    return url.toString();
  }
  if (providerId !== undefined && providerId !== null) return `provider-item:${String(providerId)}`;
  const normalizedTitle = String(title ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  return normalizedTitle ? `title:${normalizedTitle.slice(0, 240)}` : null;
}

function isOrganizationSource(sourceUrl: string, companyDomain?: string | null) {
  const organizationHost = domainKey(companyDomain);
  if (!organizationHost) return false;
  const sourceHost = new URL(sourceUrl).hostname.toLowerCase().replace(/^www\./, "");
  return sourceHost === organizationHost || sourceHost.endsWith(`.${organizationHost}`);
}

function firstArray(payload: any, keys: string[]): any[] {
  for (const key of keys) {
    if (Array.isArray(payload?.[key])) return payload[key];
  }
  return Array.isArray(payload) ? payload : [];
}

function exploriumEvents(payload: any): any[] {
  return firstArray(payload, ["output_events", "events", "business_events", "businesses_events", "results", "data"])
    .flatMap(row => Array.isArray(row?.events) ? row.events : [row]);
}

const EXPLORIUM_EVENT_TYPES: Record<ProviderEvent["eventType"], string[]> = {
  funding: ["ipo_announcement", "new_funding_round", "new_investment"],
  layoffs: ["cost_cutting", "decrease_in_engineering_department", "decrease_in_sales_department", "decrease_in_marketing_department", "decrease_in_operations_department", "decrease_in_customer_service_department", "decrease_in_all_departments"],
  hiring: ["increase_in_engineering_department", "increase_in_sales_department", "increase_in_marketing_department", "increase_in_operations_department", "increase_in_customer_service_department", "increase_in_all_departments", "hiring_in_creative_department", "hiring_in_education_department", "hiring_in_engineering_department", "hiring_in_finance_department", "hiring_in_health_department", "hiring_in_human_resources_department", "hiring_in_legal_department", "hiring_in_marketing_department", "hiring_in_operations_department", "hiring_in_professional_service_department", "hiring_in_sales_department", "hiring_in_support_department", "hiring_in_trade_department", "hiring_in_unknown_department"],
  procurement: [],
  branch_opening: ["new_office"],
  merger_acquisition: ["merger_and_acquisitions"],
  cxo_appointment: ["employee_joined_company"],
  partnership: ["new_partnership"],
  quarterly_financial: ["ipo_announcement", "new_funding_round", "new_investment"],
  technology_integration: ["new_product"],
  capital_investment: ["new_investment"],
  regulatory_action: ["lawsuits_and_legal_issues"],
  operational_risk: ["outages_and_security_breaches", "cost_cutting"],
};

export async function fetchTavilyEvents(tenantId: number, scope: { clientId?: number; audienceId?: number; accountIds?: number[]; eventTypes?: string[]; country?: string; beforeRequest?: () => Promise<void>; afterRequest?: () => Promise<void> }): Promise<ProviderResult<ProviderEvent>> {
  const stats: ProviderStats = { requests: 0, pages: 0, retries: 0, rateLimited: 0, recordsFetched: 0, recordsNormalized: 0, failures: [], usageLimit: await providerRequestLimit(tenantId, "tavily") };
  if (!process.env.TAVILY_API_KEY) throw new IntentProviderError("Tavily is not configured", stats);
  const types = selectedTypes(scope.eventTypes), { startDate, endDate } = dateWindow(), rows: ProviderEvent[] = [];
  for (const company of await scopedCompanies(tenantId, scope.clientId, scope.audienceId, scope.accountIds)) {
    for (const plan of tavilySearchPlans(company, types, startDate, scope.country)) {
      const { query } = plan;
      try {
      const payload = await requestJson<{ results?: Array<{ title?: string; content?: string; raw_content?: string; url?: string; published_date?: string }> }>("https://api.tavily.com/search", { method: "POST", headers: { Authorization: `Bearer ${String(process.env.TAVILY_API_KEY)}`, "Content-Type": "application/json" }, body: JSON.stringify({ query, topic: plan.topic, max_results: 20, start_date: startDate, end_date: endDate, search_depth: "advanced", include_raw_content: "markdown", chunks_per_source: 3 }) }, stats, "Tavily", 3, scope.beforeRequest, scope.afterRequest);
      stats.pages++;
      for (const item of payload.results ?? []) {
        stats.recordsFetched++;
        const excerpt = [item.title, item.content, item.raw_content].filter((v): v is string => typeof v === "string").join(" — ").slice(0, 12_000);
        const occurredAt = new Date(item.published_date ?? ""), url = publicSourceUrl(item.url);
        if (!url || !isFreshPublicResearchEvidence(excerpt, occurredAt)) continue;
        for (const eventType of classifyArticleTypes(excerpt).filter(type => plan.expectedTypes.has(type))) {
          rows.push({ accountId: company.id, companyName: company.name, domain: company.domain ?? undefined, eventType, occurredAt: occurredAt.toISOString(), sourceUrl: url, excerpt, confidence: plan.searchKind === "news" ? 75 : 82, context: { query, searchKind: plan.searchKind, contentRead: Boolean(item.raw_content), officialOrganizationDomain: isOrganizationSource(url, company.domain), country: researchMarket(scope.country), sourceTitle: item.title ?? null, sourceIdentity: canonicalSourceIdentity(url, item.title), searchProvider: "tavily", researchWindow: "3_months", publishedDate: item.published_date ?? null } }); stats.recordsNormalized++;
        }
      }
      } catch (error) {
        if (error instanceof ResearchRequestAccountingError) throw error;
        stats.failures.push(`${company.name}: ${error instanceof Error ? error.message : "Tavily request failed"}`);
      }
    }
  }
  if (stats.failures.length && !rows.length) throw new IntentProviderError(stats.failures[0], stats);
  return { rows, stats };
}

export async function fetchExploriumEvents(tenantId: number, scope: { clientId?: number; audienceId?: number; accountIds?: number[]; eventTypes?: string[]; country?: string; beforeRequest?: () => Promise<void>; afterRequest?: () => Promise<void> }): Promise<ProviderResult<ProviderEvent>> {
  const stats: ProviderStats = { requests: 0, pages: 0, retries: 0, rateLimited: 0, recordsFetched: 0, recordsNormalized: 0, failures: [], usageLimit: await providerRequestLimit(tenantId, "explorium") };
  if (!process.env.EXPLORIUM_API_KEY) throw new IntentProviderError("Explorium is not configured", stats);
  const companies = await scopedCompanies(tenantId, scope.clientId, scope.audienceId, scope.accountIds), types = selectedTypes(scope.eventTypes), { timestampFrom, timestampTo } = dateWindow(), rows: ProviderEvent[] = [];
  const exploriumEventTypes = [...new Set([...types].flatMap(type => EXPLORIUM_EVENT_TYPES[type]))];
  for (const company of companies) try {
    const headers = { api_key: String(process.env.EXPLORIUM_API_KEY), "Content-Type": "application/json" };
    const matched = await requestJson<any>("https://api.explorium.ai/v1/businesses/match", { method: "POST", headers, body: JSON.stringify({ businesses_to_match: [{ name: company.name, domain: company.domain ?? undefined }] }) }, stats, "Explorium match", 3, scope.beforeRequest, scope.afterRequest);
    const matchRows = firstArray(matched, ["matched_businesses", "businesses", "results", "data"]);
    const businessIds = matchRows.map((row: any) => row?.business_id ?? row?.id).filter((id: unknown) => typeof id === "string" || typeof id === "number");
    if (!businessIds.length) continue;
    const payload = await requestJson<any>("https://api.explorium.ai/v1/businesses/events", { method: "POST", headers, body: JSON.stringify({ business_ids: businessIds, event_types: exploriumEventTypes, timestamp_from: timestampFrom, timestamp_to: timestampTo }) }, stats, "Explorium events", 3, scope.beforeRequest, scope.afterRequest);
    const events = exploriumEvents(payload);
    stats.pages++;
    for (const event of events) {
      stats.recordsFetched++;
      const data = event?.data && typeof event.data === "object" ? event.data : {};
      if (!hasCountryContext({ event, data }, scope.country)) continue;
      const excerpt = [event?.event_name, event?.headline, event?.title, event?.name, event?.description, event?.summary, event?.content, event?.text, ...Object.values(data)].filter((v: unknown): v is string => typeof v === "string" || typeof v === "number").join(" — ").slice(0, 12_000);
      const occurredAt = new Date(event?.event_time ?? event?.published_date ?? event?.occurred_at ?? event?.timestamp ?? event?.date ?? data?.event_time ?? data?.date ?? ""), url = publicSourceUrl(event?.url ?? event?.source_url ?? event?.link ?? data?.url ?? data?.source_url ?? data?.link);
      if (!excerpt || !isFreshPublicResearchEvidence(excerpt, occurredAt)) continue;
      for (const eventType of classifyArticleTypes(excerpt).filter(type => types.has(type))) {
        rows.push({ accountId: company.id, companyName: company.name, domain: company.domain ?? undefined, eventType, occurredAt: occurredAt.toISOString(), sourceUrl: url ?? undefined, excerpt, confidence: 75, context: { country: researchMarket(scope.country), sourceTitle: event?.headline ?? event?.title ?? event?.event_name ?? event?.name ?? null, sourceIdentity: canonicalSourceIdentity(url, event?.headline ?? event?.title ?? event?.event_name ?? event?.name, event?.event_id ?? event?.id), searchProvider: "explorium", researchWindow: "3_months", rawEvent: event } }); stats.recordsNormalized++;
      }
    }
  } catch (error) {
    if (error instanceof ResearchRequestAccountingError) throw error;
    stats.failures.push(`${company.name}: ${error instanceof Error ? error.message : "Explorium request failed"}`);
  }
  if (stats.failures.length && !rows.length) throw new IntentProviderError(stats.failures[0], stats);
  return { rows, stats };
}

export async function fetchNewsEvents(
  tenantId: number,
  scope: { clientId?: number; audienceId?: number; accountIds?: number[]; country?: string; beforeRequest?: () => Promise<void>; afterRequest?: () => Promise<void>; failOnPartial?: boolean },
): Promise<ProviderResult<ProviderEvent>> {
  const config = await configFor(tenantId, "newsapi");
  const stats: ProviderStats = { requests: 0, pages: 0, retries: 0, rateLimited: 0, recordsFetched: 0, recordsNormalized: 0, failures: [], usageLimit: Number(config?.maxRequestsPerRun) || 100 };
  if (!config?.apiKey || config.enabled === false) throw new IntentProviderError("NewsAPI is not configured", stats);
  const companies = (await scopedCompanies(tenantId, scope.clientId, scope.audienceId, scope.accountIds)).filter(company => company.name || company.domain);
  const rows: ProviderEvent[] = [];
  for (const company of companies.slice(0, 100)) {
    const market = researchMarket(scope.country);
    const query = `("${company.name}"${company.domain ? ` OR "${company.domain}"` : ""}) AND (${market === "global" ? "news OR hiring OR earnings OR product launch" : `"${market}" AND (news OR hiring OR earnings OR product launch)`})`;
    for (let page = 1; page <= 3; page += 1) {
      try {
        const params = new URLSearchParams({ q: query, language: "en", sortBy: "publishedAt", pageSize: "100", page: String(page) });
        const payload = await requestJson<{ status: string; articles?: Array<{ title?: string; description?: string; url?: string; publishedAt?: string; source?: { name?: string } }> }>(
          `https://newsapi.org/v2/everything?${params}`, { headers: { "X-Api-Key": String(config.apiKey) } }, stats, "NewsAPI", 3, scope.beforeRequest, scope.afterRequest,
        );
        stats.pages += 1;
        for (const article of payload.articles ?? []) {
          stats.recordsFetched += 1;
          const excerpt = [article.title, article.description].filter(Boolean).join(" — ").slice(0, 12_000);
          const eventType = classifyArticle(excerpt);
          if (!eventType || !article.publishedAt || !article.url) continue;
          rows.push({
            accountId: company.id, companyName: company.name, domain: company.domain ?? undefined,
            eventType, occurredAt: new Date(article.publishedAt).toISOString(), sourceUrl: article.url,
            excerpt: excerpt || `${eventType.replace(/_/g, " ")} reported by ${article.source?.name ?? "NewsAPI"}`,
            confidence: 70, context: { source: article.source?.name ?? null, country: market, sourceTitle: article.title ?? null, sourceIdentity: canonicalSourceIdentity(publicSourceUrl(article.url), article.title), query, researchWindow: "3_months" },
          });
          stats.recordsNormalized += 1;
        }
        if ((payload.articles?.length ?? 0) < 100) break;
      } catch (error) {
        if (error instanceof ResearchRequestAccountingError) throw error;
        const message = error instanceof Error ? error.message : "NewsAPI request failed";
        stats.failures.push(`${company.name}: ${message}`);
        break;
      }
    }
  }
  if (stats.failures.length && (rows.length === 0 || scope.failOnPartial)) throw new IntentProviderError(stats.failures[0], stats, undefined, rows);
  return { rows, stats };
}

export async function fetchPerplexityEvents(
  tenantId: number,
  scope: { clientId?: number; audienceId?: number; accountIds?: number[]; eventTypes?: string[]; country?: string; beforeRequest?: () => Promise<void>; afterRequest?: () => Promise<void> },
): Promise<ProviderResult<ProviderEvent>> {
  const stats: ProviderStats = { requests: 0, pages: 0, retries: 0, rateLimited: 0, recordsFetched: 0, recordsNormalized: 0, failures: [], usageLimit: 1000 };
  if (!await providerConfigured(tenantId, "perplexity")) throw new IntentProviderError("Perplexity connector is not available", stats);
  const companies = (await scopedCompanies(tenantId, scope.clientId, scope.audienceId, scope.accountIds)).filter(company => company.name || company.domain);
  const selectedEventTypes = new Set(scope.eventTypes?.length ? scope.eventTypes : [
    "funding", "layoffs", "hiring", "procurement", "branch_opening", "merger_acquisition", "cxo_appointment",
    "partnership", "quarterly_financial", "technology_integration", "capital_investment",
  ]);
  const rows: ProviderEvent[] = [];
  const cutoff = publicResearchCutoff();
  const dateAfter = cutoff.toISOString().slice(0, 10);
  const searchCompany = async (company: Company) => {
    for (const query of focusedCompanyQueries(company, selectedEventTypes as Set<ProviderEvent["eventType"]>, dateAfter, scope.country)) {
    try {
      if (stats.requests >= (stats.usageLimit ?? Number.MAX_SAFE_INTEGER)) throw new IntentProviderError("Perplexity usage limit reached", stats);
      await researchRequestHook(scope.beforeRequest);
      stats.requests += 1;
      const response = await new ReplitConnectors().proxy("perplexity", "/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, max_results: 20, search_recency_filter: "year", search_language_filter: ["en"] }),
      });
      await researchRequestHook(scope.afterRequest);
      if (!response.ok) {
        if (response.status === 429) stats.rateLimited += 1;
        throw new Error(`Perplexity returned HTTP ${response.status}: ${(await response.text()).slice(0, 240)}`);
      }
      const payload = await response.json() as { results?: Array<{ title?: string; url?: string; snippet?: string; date?: string; last_updated?: string }> };
      stats.pages += 1;
      for (const result of payload.results ?? []) {
        stats.recordsFetched += 1;
        const excerpt = [result.title, result.snippet].filter(Boolean).join(" — ").slice(0, 12_000);
        const occurredAt = new Date(result.date || result.last_updated || "");
        const url = publicSourceUrl(result.url);
        if (!url || !excerpt || !isFreshPublicResearchEvidence(excerpt, occurredAt)) continue;
        for (const eventType of classifyArticleTypes(excerpt).filter(type => selectedEventTypes.has(type))) rows.push({
          accountId: company.id,
          companyName: company.name,
          domain: company.domain ?? undefined,
          eventType,
          occurredAt: occurredAt.toISOString(),
          sourceUrl: url,
          excerpt,
          confidence: 70,
          context: { query, country: researchMarket(scope.country), sourceTitle: result.title ?? null, sourceIdentity: canonicalSourceIdentity(url, result.title), publishedDate: result.date ?? null, lastUpdated: result.last_updated ?? null, searchProvider: "perplexity", researchWindow: "3_months" },
        });
        stats.recordsNormalized += classifyArticleTypes(excerpt).filter(type => selectedEventTypes.has(type)).length;
      }
    } catch (error) {
      if (error instanceof ResearchRequestAccountingError) throw error;
      stats.failures.push(`${company.name}: ${error instanceof Error ? error.message : "Perplexity request failed"}`);
    }
    }
  };
  for (let offset = 0; offset < companies.length; offset += 5) {
    await Promise.all(companies.slice(offset, offset + 5).map(searchCompany));
  }
  if (stats.failures.length && rows.length === 0) throw new IntentProviderError(stats.failures[0], stats);
  return { rows, stats };
}

function domainKey(value?: string | null) {
  return value?.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0] ?? "";
}

const APOLLO_FUNCTION_TITLES: Record<string, string[]> = {
  marketing: ["marketing", "growth", "demand generation"],
  sales: ["sales", "business development", "revenue"],
  technology: ["engineering", "information technology", "software"],
  operations: ["operations", "business operations", "revenue operations"],
};

export function apolloTitlesForFunctions(functions: string[]): string[] {
  return [...new Set(functions.flatMap(value => APOLLO_FUNCTION_TITLES[value.toLowerCase()] ?? [value]))];
}

export async function fetchApolloContacts(
  tenantId: number,
  scope: { clientId?: number; audienceId?: number; accountIds?: number[]; seniorities: string[]; functions: string[]; locations: string[] },
): Promise<ProviderResult<ProviderContact>> {
  const config = await configFor(tenantId, "apollo");
  const stats: ProviderStats = { requests: 0, pages: 0, retries: 0, rateLimited: 0, recordsFetched: 0, recordsNormalized: 0, failures: [], usageLimit: Number(config?.maxRequestsPerRun) || 20 };
  if (!config?.apiKey || config.enabled === false) throw new IntentProviderError("Apollo is not configured", stats);
  const companies = (await scopedCompanies(tenantId, scope.clientId, scope.audienceId, scope.accountIds)).filter(company => company.domain);
  const byDomain = new Map(companies.map(company => [domainKey(company.domain), company]));
  const rows: ProviderContact[] = [];
  for (let page = 1; page <= 20; page += 1) {
    try {
      const params = new URLSearchParams({ page: String(page), per_page: "25" });
      for (const company of companies) params.append("q_organization_domains_list[]", domainKey(company.domain));
      for (const title of apolloTitlesForFunctions(scope.functions)) params.append("person_titles[]", title);
      for (const seniority of scope.seniorities) params.append("person_seniorities[]", seniority);
      for (const location of scope.locations) params.append("person_locations[]", location);
      const payload = await requestJson<{ people?: Array<any>; contacts?: Array<any>; pagination?: { total_pages?: number } }>(
        `https://api.apollo.io/api/v1/mixed_people/api_search?${params}`,
        {
          method: "POST", headers: { "Content-Type": "application/json", "X-Api-Key": String(config.apiKey) },
        }, stats, "Apollo",
      );
      stats.pages += 1;
      const people = payload.people ?? payload.contacts ?? [];
      stats.recordsFetched += people.length;
      for (const person of people) {
        const domain = domainKey(person.organization?.primary_domain ?? person.organization?.domain ?? person.organization_domain);
        const company = byDomain.get(domain);
        if (!company) continue;
        const phone = person.phone_numbers?.[0]?.sanitized_number ?? person.phone_numbers?.[0]?.raw_number ?? person.phone;
        const location = [person.city, person.state, person.country].filter(Boolean).join(", ") || person.location;
        rows.push({
          companyId: company.id, firstName: person.first_name, lastName: person.last_name,
          email: person.email, phone, title: person.title, function: person.functions?.[0] ?? person.function,
          location, sourceUrl: person.linkedin_url, confidence: person.email ? 85 : 65,
          rawEvidence: { provider: "apollo", personId: person.id ?? null, organization: person.organization?.name ?? company.name },
        });
        stats.recordsNormalized += 1;
      }
      const totalPages = payload.pagination?.total_pages ?? page;
      if (page >= Math.min(totalPages, 20) || people.length < 25) break;
    } catch (error) {
      stats.failures.push(error instanceof Error ? error.message : "Apollo request failed");
      break;
    }
  }
  if (stats.failures.length && rows.length === 0) throw new IntentProviderError(stats.failures[0], stats);
  return { rows, stats };
}
