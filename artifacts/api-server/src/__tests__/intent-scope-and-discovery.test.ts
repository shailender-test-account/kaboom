import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  clientQuery: vi.fn(),
  dbExecute: vi.fn(),
  fetchApolloContacts: vi.fn(),
  providerConfigured: vi.fn(),
  providerRequestLimit: vi.fn(),
  kickIntentResearchRunner: vi.fn(),
  matchEntities: vi.fn(),
  readProductIntentScore: vi.fn(),
  readProductIntentScores: vi.fn(),
  readProductIntentActivity: vi.fn(async()=>new Map()),
}));

vi.mock("@workspace/db", () => ({
  pool: {
    query: mocks.query,
    connect: vi.fn(async () => ({ query: mocks.clientQuery, release: vi.fn() })),
  },
  db: { execute: mocks.dbExecute },
}));

vi.mock("../middlewares/requireAuth", async importOriginal => ({
  ...await importOriginal<typeof import("../middlewares/requireAuth")>(),
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { id: 1, tenantId: 7, role: "admin" };
    next();
  },
}));

vi.mock("../utils/segmentFilter", () => ({
  buildContactsWhereClause: vi.fn(),
}));

vi.mock("../lib/alwaysOnIntent", () => ({
  readProductIntentActivity: mocks.readProductIntentActivity,
  base2Decay: vi.fn(),
  ensureIntentDefaults: vi.fn(),
  enqueueIntent: vi.fn(),
  eventFingerprint: vi.fn(),
  matchEntities: mocks.matchEntities,
  normalizedDomain: vi.fn(),
  PUBLIC_EVENT_TYPES: [],
  readProductIntentScore: mocks.readProductIntentScore,
  readProductIntentScores: mocks.readProductIntentScores,
  recomputeIntent: vi.fn(),
  saturateRepeatedSignals: vi.fn(),
  selectIntentTier: vi.fn((score: number) => ({ key: score >= 70 ? "hot" : score >= 35 ? "warm" : "cold" })),
}));

vi.mock("../lib/intentProviders", () => ({
  fetchApolloContacts: mocks.fetchApolloContacts,
  fetchNewsEvents: vi.fn(),
  fetchPerplexityEvents: vi.fn(),
  IntentProviderError: class IntentProviderError extends Error {},
  PUBLIC_RESEARCH_WINDOW_SQL: "3 months",
  providerConfigured: mocks.providerConfigured,
  providerRequestLimit: mocks.providerRequestLimit,
}));

vi.mock("../intentResearchRunner", () => ({
  kickIntentResearchRunner: mocks.kickIntentResearchRunner,
}));

import router from "../routes/intent";

const app = express().use(express.json()).use(router).use((error: Error, _req: any, res: any, _next: any) => {
  res.status(500).json({ error: error.message });
});
const result = (rows: any[], rowCount = rows.length) => ({ rows, rowCount });

function wireCatalogAndAccountQueries() {
  mocks.query.mockImplementation(async (sql: string, params: any[] = []) => {
    if(sql.startsWith("SELECT c.id FROM companies c")&&sql.includes("LEFT JOIN intent_entity_scores"))
      return result((params[2]===9||params[6]?[{id:2}]:[{id:1},{id:2}]));
    if(sql.includes("SELECT DISTINCT ac.company_id AS id"))return result([]);
    if (sql.includes("FROM intent_inbound_category_rules")) return result([]);
    if (sql.includes("SELECT\n    (SELECT count(*)::int FROM intent_product_categories")) {
      return result([{ categories: 2, subcategories: 12, products: 36 }]);
    }
    if (sql.includes("SELECT id FROM intent_products WHERE tenant_id=$1 AND active=true")) {
      return result([{ id: 101 }]);
    }
    if (sql.includes("SELECT 1 FROM intent_audiences")) return result([{ id: 9 }], 1);
    if (sql.includes("SELECT 1 FROM clients")) return result([{ id: 3 }], 1);
    if (sql.includes("SELECT 1 FROM companies c")) return result([{ id: 22 }], 1);
    if (sql.includes("SELECT c.id FROM companies c") && sql.includes("c.id=ANY($2::int[])")) {
      return result((params[1] ?? []).map((id: number) => ({ id })));
    }
    if (sql.includes("FROM intent_tiers WHERE tenant_id=$1 AND active")) {
      return result([{ key: "cold", label: "Cold", color: "slate", min_score: 0 }]);
    }
    if (sql.includes("SELECT p.id,p.name,c.name AS category_name")) return result([]);
    if (sql.includes("SELECT s.id,s.account_id,s.product_id")) return result([]);
    if (sql.includes("FROM intent_inbound_submissions") && sql.includes("classification IN ('hot','warm')")) return result([]);
    if (sql.includes("FROM intent_evidence WHERE tenant_id=$1 AND account_id=ANY") || sql.includes("FROM intent_evidence e JOIN companies c ON c.tenant_id=e.tenant_id AND c.id=e.account_id")) return result([]);
    if (sql.includes('SELECT c.id,c.name,c.domain,c.industry,c.client_id AS "clientId"')) {
      const audienceId = params[2];
      const companyIds = params[6];
      if (audienceId === 9) return result([{ id: 2, name: "Audience account", total: 1 }]);
      if (Array.isArray(companyIds) && companyIds.includes(22)) return result([{ id: 2, name: "Segment account", total: 1 }]);
      return result([{ id: 1, name: "Unscoped account", total: 2 }, { id: 2, name: "Other account", total: 2 }]);
    }
    throw new Error(`Unexpected pool query: ${sql.slice(0, 120)}`);
  });
}

function wireDiscoveryTransaction(runId = 701, candidateId = 801) {
  mocks.clientQuery.mockImplementation(async (sql: string) => {
    if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return result([]);
    if (sql.includes("SELECT id FROM intent_contact_discovery_runs")) return result([]);
    if (sql.includes("INSERT INTO intent_contact_discovery_runs")) return result([{ id: runId }]);
    if (sql.includes("INSERT INTO intent_contact_discovery_candidates")) return result([{ id: candidateId }]);
    throw new Error(`Unexpected transaction query: ${sql.slice(0, 120)}`);
  });
}

function wireTaxonomyScopeQueries(scopedProductIds: number[]) {
  mocks.query.mockImplementation(async (sql: string, params: any[] = []) => {
    if(sql.startsWith("SELECT c.id FROM companies c")&&sql.includes("LEFT JOIN intent_entity_scores"))return result([{id:1}]);
    if(sql.includes("SELECT DISTINCT ac.company_id AS id"))return result([]);
    if (sql.includes("FROM intent_inbound_category_rules")) return result([]);
    if (sql.includes("SELECT\n    (SELECT count(*)::int FROM intent_product_categories")) {
      return result([{ categories: 2, subcategories: 12, products: 36 }]);
    }
    if (sql.includes("SELECT p.id FROM intent_products p") && sql.includes("p.category_id=ANY")) {
      return result(scopedProductIds.map(id => ({ id })));
    }
    if (sql.includes("SELECT c.id FROM companies c") && sql.includes("c.id=ANY($2::int[])")) {
      return result((params[1] ?? []).map((id: number) => ({ id })));
    }
    if (sql.includes('SELECT c.id,c.name,c.domain,c.industry,c.client_id AS "clientId"')) {
      return result([{ id: 1, name: "Scoped account", domain: "scoped.example", total: 1 }]);
    }
    if (sql.includes("SELECT p.id,p.name,c.name AS category_name")) return result([]);
    if (sql.includes("SELECT s.id,s.account_id,s.product_id")) return result([]);
    if (sql.includes("FROM intent_inbound_submissions") && sql.includes("classification IN ('hot','warm')")) return result([]);
    if (sql.includes("FROM intent_evidence WHERE tenant_id=$1 AND account_id=ANY") || sql.includes("FROM intent_evidence e JOIN companies c ON c.tenant_id=e.tenant_id AND c.id=e.account_id")) return result([]);
    if (sql.includes("FROM intent_tiers WHERE tenant_id=$1 AND active")) {
      return result([{ key: "cold", label: "Cold", color: "slate", min_score: 0 }]);
    }
    throw new Error(`Unexpected taxonomy query: ${sql.slice(0, 120)} (${JSON.stringify(params)})`);
  });
}

describe("Intent scope and contact discovery regressions", () => {
  beforeEach(() => {
    mocks.query.mockReset();
    mocks.clientQuery.mockReset();
    mocks.dbExecute.mockReset();
    mocks.fetchApolloContacts.mockReset();
    mocks.providerConfigured.mockReset();
    mocks.providerRequestLimit.mockReset();
    mocks.providerRequestLimit.mockResolvedValue(1000);
    mocks.readProductIntentScore.mockReset().mockResolvedValue({
      score: 0,
      tier: "cold",
      lastSignalAt: null,
      contributions: [],
    });
    mocks.readProductIntentScores.mockReset().mockImplementation(async (_tenantId: number, _productIds: number[], accountIds: number[]) =>
      new Map(accountIds.map(accountId => [accountId, { score: 0, tier: "cold", lastSignalAt: null, contributions: [] }])),
    );
    mocks.matchEntities.mockReset().mockResolvedValue({
      contactId: null,
      accountId: null,
      conflict: false,
    });
    wireCatalogAndAccountQueries();
  });

  it("restricts account results to a saved audience", async () => {
    const response = await request(app).get("/intent/accounts?audienceId=9");

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.total).toBe(1);
    expect(response.body.accounts.map((account: any) => account.id)).toEqual([2]);
    const accountQuery = mocks.query.mock.calls.find(([sql]) => String(sql).includes('SELECT c.id,c.name,c.domain,c.industry,c.client_id AS "clientId"'));
    expect(accountQuery?.[1]?.slice(0,8)).toEqual([7, null, 9, null, null, null, null, null]);
    expect(accountQuery?.[1]?.slice(-2)).toEqual([25,0]);
    expect(accountQuery?.[0]).toContain("jsonb_to_recordset($9::jsonb)");
    expect(accountQuery?.[0]).toContain("LIMIT $12 OFFSET $13");
  });

  it("restricts account results to companies represented by a CRM segment", async () => {
    mocks.query.mockImplementation(async (sql: string, params: any[] = []) => {
      if(sql.startsWith("SELECT c.id FROM companies c")&&sql.includes("LEFT JOIN intent_entity_scores"))return result([{id:2}]);
      if(sql.includes("SELECT DISTINCT ac.company_id AS id"))return result([]);
      if (sql.includes("FROM intent_inbound_category_rules")) return result([]);
      if (sql.includes("SELECT\n    (SELECT count(*)::int FROM intent_product_categories")) return result([{ categories: 2, subcategories: 12, products: 36 }]);
      if (sql.includes("SELECT id FROM intent_products WHERE tenant_id=$1 AND active=true")) return result([{ id: 101 }]);
      if (sql.includes("SELECT segment_type,static_contact_ids")) return result([{ segment_type: "static", static_contact_ids: [501], filter_criteria: null, logic_operator: "AND" }]);
      if (sql.includes("SELECT DISTINCT company_id FROM contacts")) return result([{ company_id: 22 }]);
      if (sql.includes("SELECT c.id FROM companies c") && sql.includes("c.id=ANY($2::int[])")) {
        return result((params[1] ?? []).map((id: number) => ({ id })));
      }
      if (sql.includes("FROM intent_tiers WHERE tenant_id=$1 AND active")) return result([{ key: "cold", label: "Cold", color: "slate", min_score: 0 }]);
      if (sql.includes("SELECT p.id,p.name,c.name AS category_name")) return result([]);
      if (sql.includes("SELECT s.id,s.account_id,s.product_id")) return result([]);
        if (sql.includes("FROM intent_inbound_submissions") && sql.includes("classification IN ('hot','warm')")) return result([]);
       if (sql.includes("FROM intent_evidence WHERE tenant_id=$1 AND account_id=ANY") || sql.includes("FROM intent_evidence e JOIN companies c ON c.tenant_id=e.tenant_id AND c.id=e.account_id")) return result([]);
      if (sql.includes('SELECT c.id,c.name,c.domain,c.industry,c.client_id AS "clientId"')) return result([{ id: 2, name: "Segment account", total: 1 }]);
      throw new Error(`Unexpected pool query: ${sql.slice(0, 120)}`);
    });

    const response = await request(app).get("/intent/accounts?segmentId=14");

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.total).toBe(1);
    expect(response.body.accounts.map((account: any) => account.id)).toEqual([2]);
    const accountQuery = mocks.query.mock.calls.find(([sql]) => String(sql).includes('SELECT c.id,c.name,c.domain,c.industry,c.client_id AS "clientId"'));
    expect(accountQuery?.[1]?.[6]).toEqual([22]);
  });

  it.each([
    {
      name: "category",
      query: "categoryIds=10",
      scopedProductIds: [101, 102],
      expectedParams: [7, null, [10], null],
    },
    {
      name: "subcategory",
      query: "subcategoryIds=11",
      scopedProductIds: [101],
      expectedParams: [7, null, null, [11]],
    },
    {
      name: "product",
      query: "productId=101",
      scopedProductIds: [101],
      expectedParams: [7, 101, null, null],
    },
  ])("restricts account results to the selected $name taxonomy scope", async ({ query, scopedProductIds, expectedParams }) => {
    wireTaxonomyScopeQueries(scopedProductIds);
    const response = await request(app).get(`/intent/accounts?${query}`);

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.total).toBe(1);
    expect(response.body.accounts.map((account: any) => account.id)).toEqual([1]);

    const scopeQuery = mocks.query.mock.calls.find(([sql]) =>
      String(sql).includes("SELECT p.id FROM intent_products p") && String(sql).includes("p.category_id=ANY"),
    );
    expect(scopeQuery?.[1]?.slice(0, 4)).toEqual(expectedParams);
    expect(mocks.readProductIntentActivity).toHaveBeenCalledWith(7, scopedProductIds, [1]);
  });

  it("queues live account research and responds before calling the provider", async () => {
    mocks.providerConfigured.mockResolvedValue(true);
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM intent_research_runs WHERE tenant_id=$1 AND idempotency_key=$2")) return result([]);
      if (sql.includes("SELECT c.id FROM companies c")) return result([{ id: 22 }, { id: 23 }]);
      throw new Error(`Unexpected pool query: ${sql.slice(0, 120)}`);
    });
    mocks.clientQuery.mockImplementation(async (sql: string) => {
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return result([]);
      if (sql.includes("INSERT INTO intent_research_runs")) return result([{ id: 901 }]);
      if (sql.includes("INSERT INTO intent_research_run_accounts")) return result([]);
      throw new Error(`Unexpected transaction query: ${sql.slice(0, 120)}`);
    });

    const response = await request(app).post("/intent/research/runs").send({
      provider: "perplexity",
      accountIds: [23, 22],
      country: "India",
      idempotencyKey: "background-research-1",
    });

    expect(response.status, JSON.stringify(response.body)).toBe(202);
    expect(response.body).toMatchObject({
      id: 901,
      runId: 901,
      status: "queued",
      summary: { accountsTotal: 2, accountsRemaining: 2, requests: 0, request: { country: "India" } },
    });
    expect(mocks.kickIntentResearchRunner).toHaveBeenCalled();
  });

  it("returns matching database contacts without calling Apollo", async () => {
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT ct.id,ct.company_id")) {
        return result([{ id: 501, companyId: 22, firstName: "Ada", lastName: "Lovelace", email: "ada@example.test", title: "Director of Growth" }]);
      }
      if (sql.includes("SELECT 1 FROM companies c")) return result([{ id: 22 }], 1);
      if (sql.includes("SELECT 1 FROM tenant_integrations")) return result([]);
      return result([]);
    });
    wireDiscoveryTransaction();

    const response = await request(app).post("/intent/discovery/preview").send({
      idempotencyKey: "database-match-1",
      criteria: { seniorities: ["director"], functions: [], locations: [] },
    }).expect(201);

    expect(response.body.providerUsed).toBe("database");
    expect(response.body.databaseCount).toBe(1);
    expect(response.body.candidates[0]).toMatchObject({ email: "ada@example.test", source: "database" });
    expect(mocks.fetchApolloContacts).not.toHaveBeenCalled();
  });

  it("calls Apollo only after the database returns no matches", async () => {
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT ct.id,ct.company_id")) return result([]);
      if (sql.includes("SELECT 1 FROM companies c")) return result([{ id: 22 }], 1);
      if (sql.includes("SELECT config FROM tenant_integrations")) return result([{ config: { apiKey: "apollo-key", enabled: true } }]);
      return result([]);
    });
    mocks.providerConfigured.mockResolvedValue(true);
    mocks.fetchApolloContacts.mockResolvedValue({
      rows: [{ companyId: 22, firstName: "Grace", lastName: "Hopper", email: "grace@example.test", confidence: 90, rawEvidence: {} }],
      stats: { requests: 1, pages: 1, retries: 0, rateLimited: 0, recordsFetched: 1, recordsNormalized: 1, failures: [] },
    });
    wireDiscoveryTransaction(702, 802);

    const response = await request(app).post("/intent/discovery/preview").send({
      idempotencyKey: "apollo-fallback-1",
      criteria: { seniorities: [], functions: ["engineering"], locations: [] },
    }).expect(201);

    expect(mocks.fetchApolloContacts).toHaveBeenCalledWith(7, expect.objectContaining({
      functions: ["engineering"],
    }));
    expect(response.body.providerUsed).toBe("apollo");
    expect(response.body.candidates[0]).toMatchObject({ email: "grace@example.test", source: "apollo" });
  });
});