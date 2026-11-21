import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("@workspace/db", () => ({ pool: { query: mocks.query } }));

import {
  apolloTitlesForFunctions,
  classifyArticleTypes,
  fetchApolloContacts,
  fetchExploriumEvents,
  fetchTavilyEvents,
  providerConfigured,
} from "../lib/intentProviders";
import { ResearchRequestAccountingError } from "../lib/researchRequestAccounting";
import { fetchTavilyWithPerplexityFallback } from "../lib/providerFallback";

describe("Apollo intent provider adapter", () => {
  beforeEach(() => {
    mocks.query.mockReset();
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("maps UI functions to documented title filters and scopes by organization domain", async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [{ config: { apiKey: "secret", enabled: true, maxRequestsPerRun: 2 } }] })
      .mockResolvedValueOnce({ rows: [{ id: 42, name: "Acme", domain: "https://www.acme.test/about" }] });
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({
      people: [{
        id: "person-1",
        first_name: "Ada",
        last_name: "Lovelace",
        title: "VP of Growth",
        email: "ada@acme.test",
        city: "London",
        country: "United Kingdom",
        organization: { name: "Acme", primary_domain: "acme.test" },
      }],
      pagination: { total_pages: 1 },
    }), { status: 200, headers: { "Content-Type": "application/json" } }));

    const result = await fetchApolloContacts(7, {
      accountIds: [42], seniorities: ["vp"], functions: ["marketing"], locations: ["London"],
    });

    const [url, init] = vi.mocked(fetch).mock.calls[0];
    const requestUrl = new URL(String(url));
    expect(requestUrl.pathname).toBe("/api/v1/mixed_people/api_search");
    expect(requestUrl.searchParams.getAll("q_organization_domains_list[]")).toEqual(["acme.test"]);
    expect(requestUrl.searchParams.getAll("person_titles[]")).toEqual(["marketing", "growth", "demand generation"]);
    expect(requestUrl.searchParams.getAll("person_seniorities[]")).toEqual(["vp"]);
    expect(requestUrl.searchParams.getAll("person_locations[]")).toEqual(["London"]);
    expect(init).toMatchObject({ method: "POST", headers: { "X-Api-Key": "secret" } });
    expect(result.rows).toEqual([expect.objectContaining({
      companyId: 42, firstName: "Ada", lastName: "Lovelace", email: "ada@acme.test", title: "VP of Growth",
    })]);
    expect(result.stats).toMatchObject({ requests: 1, pages: 1, recordsFetched: 1, recordsNormalized: 1 });
  });

  it("expands supported function groups without duplicates", () => {
    expect(apolloTitlesForFunctions(["sales", "sales"])).toEqual(["sales", "business development", "revenue"]);
  });
});

describe("public research provider adapters", () => {
  beforeEach(() => {
    mocks.query.mockReset();
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it.each(["before", "after"])("does not retry or fall back when %s-request accounting fails", async phase => {
    vi.stubEnv("TAVILY_API_KEY", "test-tavily-key");
    mocks.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 42, name: "Acme", domain: "acme.test" }] });
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ results: [] }), { status: 200 }));
    const accountingError = new Error("database connection lost");
    const beforeRequest = vi.fn(async () => { if (phase === "before") throw accountingError; });
    const afterRequest = vi.fn(async () => { if (phase === "after") throw accountingError; });
    const fallback = vi.fn();
    await expect(fetchTavilyWithPerplexityFallback(7, {
      accountIds: [42], eventTypes: ["layoffs"], beforeRequest, afterRequest,
    }, { fetchTavilyEvents, fetchPerplexityEvents: fallback })).rejects.toBeInstanceOf(ResearchRequestAccountingError);
    expect(beforeRequest).toHaveBeenCalledTimes(1);
    expect(afterRequest).toHaveBeenCalledTimes(phase === "after" ? 1 : 0);
    expect(fetch).toHaveBeenCalledTimes(phase === "after" ? 1 : 0);
    expect(fallback).not.toHaveBeenCalled();
  });

  it("detects user-managed Tavily and Explorium keys without querying tenant configuration", async () => {
    vi.stubEnv("TAVILY_API_KEY", "test-tavily-key");
    vi.stubEnv("EXPLORIUM_API_KEY", "test-explorium-key");

    await expect(providerConfigured(7, "tavily")).resolves.toBe(true);
    await expect(providerConfigured(7, "explorium")).resolves.toBe(true);
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("classifies product launches as product-relevant technology evidence", () => {
    expect(classifyArticleTypes("Acme launched a new product for enterprise customers")).toContain("technology_integration");
  });

  it("classifies current tender language separately from generic technology news", () => {
    expect(classifyArticleTypes("Acme issued an RFQ and invitation to bid for 500 managed printers")).toContain("procurement");
  });

  it.each([undefined,"India"])("normalizes fresh Tavily news with India as the default market (%s)", async (country) => {
    vi.stubEnv("TAVILY_API_KEY", "test-tavily-key");
    mocks.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 42, name: "Acme", domain: "acme.test" }] });
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({
      results: [{
        title: "Acme announces workforce layoffs",
        content: "The company announced job cuts as part of a workforce reduction.",
        url: "https://news.example/acme-layoffs",
        published_date: new Date().toISOString(),
      }],
    }), { status: 200, headers: { "Content-Type": "application/json" } }));

    const result = await fetchTavilyEvents(7, { accountIds: [42], eventTypes: ["layoffs"], country });

    expect(result.rows).toEqual([expect.objectContaining({
      accountId: 42,
      eventType: "layoffs",
      sourceUrl: "https://news.example/acme-layoffs",
      context: expect.objectContaining({ searchProvider: "tavily", researchWindow: "3_months", country: "India", sourceIdentity: "https://news.example/acme-layoffs" }),
    })]);
    expect(result.stats).toMatchObject({ requests: 1, pages: 1, recordsFetched: 1, recordsNormalized: 1 });
    expect(vi.mocked(fetch).mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      headers: expect.objectContaining({ Authorization: "Bearer test-tavily-key" }),
    });
    expect(String((vi.mocked(fetch).mock.calls[0]?.[1] as RequestInit).body)).toContain("India");
  });

  it("searches and reads tender pages with procurement provenance", async () => {
    vi.stubEnv("TAVILY_API_KEY", "test-tavily-key");
    mocks.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 42, name: "Acme", domain: "acme.example" }] });
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({
      results: [{
        title: "Acme invitation to bid",
        content: "Acme issued an invitation to bid for managed printers.",
        raw_content: "Bid submission closes this month. Vendors must quote for 500 managed printers.",
        url: "https://acme.example/procurement/printers",
        published_date: new Date().toISOString(),
      }],
    }), { status: 200, headers: { "Content-Type": "application/json" } }));

    const result = await fetchTavilyEvents(7, { accountIds: [42], eventTypes: ["procurement"], country: "India" });
    const request = JSON.parse(String(vi.mocked(fetch).mock.calls[0]?.[1]?.body));

    expect(request).toMatchObject({ topic: "general", search_depth: "advanced", include_raw_content: "markdown", chunks_per_source: 3 });
    expect(request.query).toContain("RFP");
    expect(result.rows).toEqual([expect.objectContaining({
      eventType: "procurement",
      excerpt: expect.stringContaining("Bid submission closes"),
      context: expect.objectContaining({ searchKind: "tenders", contentRead: true, officialOrganizationDomain: true }),
    })]);
  });

  it("searches official and indexed job pages outside the news index", async () => {
    vi.stubEnv("TAVILY_API_KEY", "test-tavily-key");
    mocks.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 42, name: "Acme", domain: "acme.example" }] });
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({
      results: [{
        title: "Acme careers",
        content: "Acme is hiring 200 customer service agents in India.",
        raw_content: "The official careers page lists 200 open customer service roles.",
        url: "https://careers.acme.example/jobs/customer-service",
        published_date: new Date().toISOString(),
      }],
    }), { status: 200, headers: { "Content-Type": "application/json" } }));

    const result = await fetchTavilyEvents(7, { accountIds: [42], eventTypes: ["hiring"], country: "India" });
    const request = JSON.parse(String(vi.mocked(fetch).mock.calls[0]?.[1]?.body));

    expect(request).toMatchObject({ topic: "general", include_raw_content: "markdown" });
    expect(request.query).toContain("official careers site");
    expect(result.rows[0]).toEqual(expect.objectContaining({
      eventType: "hiring",
      context: expect.objectContaining({ searchKind: "jobs", contentRead: true, officialOrganizationDomain: true }),
    }));
  });

  it("matches an Explorium business and flattens nested event results", async () => {
    vi.stubEnv("EXPLORIUM_API_KEY", "test-explorium-key");
    mocks.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 42, name: "Acme", domain: "acme.test" }] });
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response(JSON.stringify({
        matched_businesses: [{ business_id: "explorium-acme" }],
      }), { status: 200, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        output_events: [{
          business_id: "explorium-acme",
          event_name: "new_office",
          event_time: new Date().toISOString(),
          data: {
            description: "Acme opens a new office in India.",
            link: "https://news.example/acme-office",
            country_name: "India",
          },
        }],
      }), { status: 200, headers: { "Content-Type": "application/json" } }));

    const result = await fetchExploriumEvents(7, { accountIds: [42], eventTypes: ["branch_opening"], country: "India" });

    expect(result.rows).toEqual([expect.objectContaining({
      accountId: 42,
      eventType: "branch_opening",
      sourceUrl: "https://news.example/acme-office",
      context: expect.objectContaining({ searchProvider: "explorium", researchWindow: "3_months", sourceIdentity: "https://news.example/acme-office" }),
    })]);
    expect(result.stats).toMatchObject({ requests: 2, pages: 1, recordsFetched: 1, recordsNormalized: 1 });
    expect(vi.mocked(fetch).mock.calls.map((call) => String(call[0]))).toEqual([
      "https://api.explorium.ai/v1/businesses/match",
      "https://api.explorium.ai/v1/businesses/events",
    ]);
    const eventRequest = JSON.parse(String(vi.mocked(fetch).mock.calls[1]?.[1]?.body));
    expect(eventRequest.event_types).toEqual(["new_office"]);
  });
});