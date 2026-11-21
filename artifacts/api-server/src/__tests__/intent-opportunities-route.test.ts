import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  clientQuery: vi.fn(),
  release: vi.fn(),
  proxy: vi.fn(),
  listConnections: vi.fn(),
  tenantId: 70,
}));
vi.mock("@workspace/db", () => ({
  pool: { query: mocks.query, connect: vi.fn(async () => ({ query: mocks.clientQuery, release: mocks.release })) },
  db: {},
}));
vi.mock("../utils/segmentFilter", () => ({ buildContactsWhereClause: vi.fn() }));
vi.mock("../lib/alwaysOnIntent", () => ({
  ensureIntentDefaults: vi.fn(), enqueueIntent: vi.fn(), matchEntities: vi.fn(),
  normalizedDomain: vi.fn(), recomputeIntent: vi.fn(), PUBLIC_EVENT_TYPES: ["funding"],
  eventFingerprint: vi.fn(), readProductIntentScore: vi.fn(), readProductIntentScores: vi.fn(),
  saturateRepeatedSignals: vi.fn(), selectIntentTier: vi.fn(),
}));
vi.mock("@replit/connectors-sdk", () => ({
  ReplitConnectors: class {
    proxy = mocks.proxy;
    listConnections = mocks.listConnections;
  },
}));
vi.mock("../middlewares/requireAuth", async importOriginal => ({
  ...await importOriginal<typeof import("../middlewares/requireAuth")>(),
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { id: 3, tenantId: mocks.tenantId, role: "admin" };
    next();
  },
}));
// There is currently no accountTrigger in the shipped rules matrix. Model an
// inherited-open result explicitly to verify the route does not promote it.
vi.mock("../lib/twoLevelIntentStatus", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/twoLevelIntentStatus")>();
  return {
    ...actual,
    evaluateTwoLevelIntentStatus: (
      rows: any[],
      now?: Date,
      categoryConfig?: Parameters<typeof actual.evaluateTwoLevelIntentStatus>[2],
    ) => {
      const evaluated = actual.evaluateTwoLevelIntentStatus(rows, now, categoryConfig);
      if (!rows.some(row => row.excerpt.includes("INHERITED_OPEN_FIXTURE"))) return evaluated;
      return {
        ...evaluated,
        categories: evaluated.categories.map(category => category.name === "IT Hardware"
          ? { ...category, status: "warm" as const, attribution: "INHERITED_OPEN" as const }
          : category),
      };
    },
  };
});

import router from "../routes/intentOpportunities";
import intentRouter from "../routes/intent";

const app = express().use(express.json()).use(router).use(intentRouter).use((error: Error, _req: any, res: any, _next: any) => {
  res.status(500).json({ error: error.message });
});
const result = (rows: any[]) => ({ rows, rowCount: rows.length });
const at = (date: string) => new Date(`${date}T12:00:00.000Z`);
const products = [
  { id: 101, name: "HP Endpoint Devices", category_id: 1, category_name: "IT Hardware", subcategory_name: null },
  { id: 202, name: "HP Laser Printer", category_id: 2, category_name: "Commercial Printing", subcategory_name: null },
  { id: 303, name: "HP Security Services", category_id: 3, category_name: "Security", subcategory_name: null },
  { id: 304, name: "Technology Consulting", category_id: 4, category_name: "Services", subcategory_name: null },
  { id: 305, name: "Strategy Consulting", category_id: 4, category_name: "Services", subcategory_name: null },
  { id: 306, name: "Systems Implementation", category_id: 4, category_name: "Services", subcategory_name: null },
  { id: 307, name: "Data Migration Services", category_id: 4, category_name: "Services", subcategory_name: null },
];
type Fixture = {
  accountId: number; accountName: string; productId: number;
  submission?: any; evidence?: any[];
};
const direct = (id: number, accountId: number, productId: number | null, excerpt: string, context: any = {}) => ({
  id, account_id: accountId, product_id: productId, evidence_kind: "public_event",
  event_type: "technology_integration", excerpt, source_url: `https://example.org/${id}`,
  occurred_at: at("2026-09-20"), confidence: 80, review_status: "approved", context,
  provider: "research", points: 80, created_at: at("2026-09-21"), contact_id: null, contact_name: null,
  category_id: productId === 101 ? 1 : null,
});
const fixtures: Fixture[] = [
  { accountId: 11, accountName: "Fresh buyer", productId: 101, submission: {
    id: 1, classification: "hot", product_interest: "HP Endpoint Devices",
    classification_reason: "Quote requested for 200 endpoints within 3 months.",
    form_type: "lead_form", action_at: at("2026-09-22"), contact_id: 5,
    first_name: "Jane", last_name: "Buyer", email: "jane@example.org",
    journey_name: "Endpoint journey", sequence_name: "Endpoint follow-up",
  } },
  { accountId: 12, accountName: "Old buyer", productId: 101, submission: {
    id: 2, classification: "hot", product_interest: "HP Endpoint Devices",
    classification_reason: "Old quote requested.", form_type: "lead_form",
    action_at: at("2026-04-01"), contact_id: null,
  } },
  { accountId: 13, accountName: "Direct rollout", productId: 101, evidence: [
    direct(31, 13, 101, "The company announced a funded rollout to replace 2,000 endpoint devices and deploy Windows 11 across its India offices."),
  ] },
  { accountId: 14, accountName: "Category only", productId: 101, evidence: [
    direct(41, 14, null, "The company announced a funded rollout to replace 2,000 endpoint devices and deploy Windows 11 across its India offices.", { category: "IT Hardware" }),
  ] },
  { accountId: 15, accountName: "Inherited open", productId: 101, evidence: [
    direct(51, 15, 101, "INHERITED_OPEN_FIXTURE The India office is reviewing its technology roadmap."),
  ] },
  { accountId: 16, accountName: "Mixed sources", productId: 101, submission: {
    id: 6, classification: "warm", product_interest: "HP Endpoint Devices",
    classification_reason: "Exploring devices.", form_type: "event_feedback",
    action_at: at("2026-09-23"), contact_id: null,
    journey_name: "Other journey", sequence_name: "Other sequence",
  }, evidence: [
    direct(61, 16, 101, "The company announced a funded rollout to replace 2,000 endpoint devices and deploy Windows 11 across its India offices."),
  ] },
  { accountId: 17, accountName: "=1+1,\n\"quoted\"", productId: 101, submission: {
    id: 7, classification: "hot", product_interest: "HP Endpoint Devices",
    classification_reason: "+SUM(A1) asks for \"a quote\"\nnow", form_type: "lead_form",
    action_at: at("2026-09-22"), contact_id: null,
  } },
];

let data: Fixture[];
let savedCategoryRules: { rules: Array<{ categoryName: string; terms: string[] }>; useBuiltin: boolean };
const sheetId = "abcdefghijklmnopqrstuvwx";
const sheetBody = { accountId: 13, productId: 101, spreadsheetId: sheetId };
const ok = (value: any) => ({ ok: true, json: async () => value });

describe("account-product opportunity routes", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(at("2026-09-27"));
    mocks.tenantId++;
    data = structuredClone(fixtures);
    savedCategoryRules = { rules: [], useBuiltin: true };
    mocks.query.mockReset();
    mocks.clientQuery.mockReset();
    mocks.release.mockReset();
    mocks.proxy.mockReset();
    mocks.listConnections.mockReset();
    mocks.listConnections.mockResolvedValue([{ connector_name: "google-sheet", status: "connected" }]);
    mocks.query.mockImplementation(async (sql: string, params: any[] = []) => {
      expect(params[0]).toBe(mocks.tenantId);
      if (sql.includes("FROM intent_inbound_category_rules")) {
        return result([{ rules: savedCategoryRules.rules, useBuiltin: savedCategoryRules.useBuiltin }]);
      }
      if (sql.includes("WITH candidate_pairs AS")) {
         const rows = data.filter(f => (f.submission && ["hot", "warm"].includes(f.submission.classification) ||
           f.evidence?.some(e => e.review_status !== "rejected")) &&
           (!params[1] || params[1] === 8) &&
          (!params[2] || f.productId === params[2]) &&
          (!params[3] || params[3] === 1) &&
          (!params[5] || f.accountId === params[5]) &&
          (!params[4] || f.accountName.toLowerCase().includes(String(params[4]).toLowerCase())))
          .map(f => ({
            account_id: f.accountId, account_name: f.accountName, client_id: 8,
            product_id: f.productId, latest_at: f.submission?.action_at ?? f.evidence?.[0]?.occurred_at,
            first_status: f.submission?.classification ?? null,
          }));
        return result(rows.slice(params[7], params[7] + params[6]));
      }
      if (sql.includes("FROM intent_products p")) {
        return result(products.filter(p => !sql.includes("p.id=$2") || p.id === params[1]));
      }
      if (sql.includes("FROM intent_inbound_submissions s")) {
        return result(data.filter(f => Array.isArray(params[1]) ? params[1].includes(f.accountId) : f.accountId === params[1])
           .flatMap(f => f.submission && ["hot", "warm"].includes(f.submission.classification) ? [{
            ...f.submission, account_id: f.accountId, occurred_at: f.submission.action_at,
            imported_at: f.submission.action_at, contact_name: "Jane Buyer", raw_fields: {},
          }] : []));
      }
      if (sql.includes("FROM intent_evidence e") && !sql.includes("DISTINCT ON")) {
        return result(data.filter(f => Array.isArray(params[1]) ? params[1].includes(f.accountId) : f.accountId === params[1])
           .flatMap(f => f.evidence ?? []).filter(e => e.review_status !== "rejected" &&
             (!sql.includes("e.product_id=$3 OR e.product_id IS NULL") ||
               e.product_id === params[2] || e.product_id === null)));
      }
      if (sql.includes("DISTINCT ON")) {
        const ids: number[] = params[3];
        return result(data.flatMap(f => f.evidence ?? []).filter(e => ids.includes(e.id) &&
          e.account_id === params[1] && (e.product_id === params[2] || e.context.category === params[4])));
      }
      if (sql.includes("FROM intent_signals s")) {
        if (sql.includes("st.max_points")) return result(params[1] === 13 ? [{
          id: 301, contact_id: 5, name: "Jane Buyer", email: "jane@example.org", tags: [],
          key: "questionnaire", max_points: 30, strength: 50, occurred_at: at("2026-09-22"),
          product_id: 101, source: "questionnaire", summary: "Endpoint interest",
          imported_at: at("2026-09-22"),
        }] : []);
        return result([]);
      }
      if (sql.includes("FROM activity_events ae")) {
        return result(params[1] === 13 ? [{
          id: 302, contact_id: 5, contact_name: "Jane Buyer", name: "Jane Buyer",
          email: "jane@example.org", tags: [], event_type: "email_click", description: "Product link",
          points_earned: 7, points: 7, created_at: at("2026-09-22"),
          occurred_at: at("2026-09-22"), imported_at: at("2026-09-22"),
          source: "activity", product_id: "101",
        }] : []);
      }
      if (sql.includes("FROM intent_opportunity_handoffs")) return result([]);
      if (sql.includes("SELECT c.id,c.name,c.client_id FROM companies c")) {
        return result(data.filter(f => f.accountId === params[1])
          .map(f => ({ id: f.accountId, name: f.accountName, client_id: 8 })));
      }
      if (sql.includes("SELECT 1 FROM contacts")) return result(params[1] === 5 && params[2] === 13 ? [{ "?column?": 1 }] : []);
      if (sql.includes("INSERT INTO intent_opportunity_handoffs")) return result(sql.includes("RETURNING") ? [{ id: 900, handoff_status: "pending" }] : []);
      if (sql.includes("UPDATE intent_opportunity_handoffs")) return result([]);
      throw new Error(`Unexpected SQL: ${sql.slice(0, 160)}`);
    });
  });
  afterEach(() => vi.useRealTimers());

  it("qualifies each account-product separately and never hands off stale or category-only Hot", async () => {
    const response = await request(app).get("/intent/opportunities?pageSize=100").expect(200);
    expect(response.body).toMatchObject({ hasMore: false, page: 1 });
    const byAccount = new Map<number, any>(response.body.items.map((item: any) => [item.accountId, item]));
    expect(byAccount.get(11)).toMatchObject({ productId: 101, status: "hot", source: "lead_form",
      contact: { id: 5, name: "Jane Buyer" }, categoryName: "IT Hardware",
      journeyName: "Endpoint journey", sequenceName: "Endpoint follow-up" });
    expect(byAccount.get(12)).toMatchObject({ status: "warm", reason: expect.stringContaining("fresh confirmation") });
    expect(byAccount.get(13)).toMatchObject({ status: "hot", source: "monitoring", evidenceLink: "https://example.org/31" });
    expect(byAccount.get(14)).toMatchObject({ status: "warm", reason: expect.stringContaining("product-specific purchase proof") });
    expect(byAccount.get(15)).toMatchObject({ status: "review", source: "monitoring_review" });
    expect(byAccount.get(16)).toMatchObject({ status: "hot", source: "monitoring", evidenceLink: "https://example.org/61",
      journeyName: null, sequenceName: null });
    expect(byAccount.get(13).score).toEqual({ people: 22, monitoring: 80, total: 102 });
    expect(byAccount.get(14).score.monitoring).toBe(80);
    expect(byAccount.get(15).score.monitoring).toBe(0);
    expect(byAccount.get(11).score).toEqual({ people: 0, monitoring: 0, total: 0 });
    const blocked = await request(app).post("/intent/opportunities/handoff")
      .send({ accountId: 14, productId: 101, spreadsheetId: sheetId }).expect(409);
    expect(blocked.body.error).toContain("currently qualified Hot");
    expect(mocks.proxy).not.toHaveBeenCalled();
  });

  it("bounds the dashboard priority scan while still returning Warm opportunities", async () => {
    const response = await request(app).get("/intent/opportunities/priority?status=warm").expect(200);
    expect(response.body.items.length).toBeGreaterThan(0);
    expect(response.body.items.every((item: { status: string }) => item.status === "warm")).toBe(true);
    const candidateRead = mocks.query.mock.calls.find(([sql]) => String(sql).includes("WITH candidate_pairs AS"));
    expect(String(candidateRead?.[0])).toContain("ORDER BY occurred_at DESC,id DESC LIMIT 300");
    expect(candidateRead?.[1]?.[6]).toBe(50);
  });

  it("retains explicit Global monitoring points for foreign purchase-stage evidence",async()=>{
    data.push({accountId:25,accountName:"ExxonMobil global buyer",productId:101,evidence:[
      direct(250,25,101,"ExxonMobil issued an RFP and approved a purchase order to replace 500 endpoint devices during a Windows 11 fleet refresh in Texas next month.",
        {scope:{country:"Global"}}),
    ]});
    const response=await request(app).get("/intent/opportunities").expect(200);
    expect(response.body.items.find((item:any)=>item.accountId===25)).toMatchObject({
      status:"hot",score:{monitoring:80,total:80},
    });
  });

  it("returns the matching feedback route in the priority card, not another source's route", async () => {
    data.push({ accountId: 20, accountName: "Feedback respondent", productId: 202, submission: {
      id: 20, classification: "warm", product_interest: "HP Laser Printer",
      classification_reason: "Exploring printing.", form_type: "event_feedback",
      action_at: at("2026-09-24"), contact_id: null,
      journey_name: "Print journey", sequence_name: "Print follow-up",
    } });
    const response = await request(app).get("/intent/opportunities/priority?status=warm").expect(200);
    expect(response.body.items.find((item: any) => item.accountId === 20)).toMatchObject({
      source: "event_feedback", categoryName: "Business Services",
      journeyName: "Print journey", sequenceName: "Print follow-up",
    });
    const submissionQuery = mocks.query.mock.calls.find(([sql]) =>
      String(sql).includes("s.classification,s.classification_reason"));
    expect(String(submissionQuery?.[0])).toContain("intent_inbound_manual_routes");
    expect(String(submissionQuery?.[0])).toContain("email_sequences");
  });

  it("does not turn one selected security service into unrelated Services opportunities", async () => {
    for (const productId of [303, 304, 305, 306, 307]) {
      data.push({ accountId: 21, accountName: "Service respondent", productId, submission: {
        id: 21, classification: "warm", product_interest: "HP Security Services",
        classification_reason: "Warm because no clear purchase timeline was given.",
        form_type: "event_feedback", action_at: at("2026-09-25"), contact_id: null,
      } });
    }
    const response = await request(app).get("/intent/opportunities?pageSize=100").expect(200);
    expect(response.body.items.filter((item: any) => item.accountId === 21)
      .map((item: any) => item.productId)).toEqual([303]);
    const candidateSql = String(mocks.query.mock.calls.find(([sql]) =>
      String(sql).includes("WITH candidate_pairs AS"))?.[0]);
    expect(candidateSql).not.toContain("regexp_replace(lower(pc.name)");
    expect(candidateSql).not.toContain("concat_ws(' ',p.name,psc.name,pc.name)");
    expect(candidateSql.match(/LEFT JOIN intent_product_subcategories psc ON/g)).toHaveLength(2);
  });

  it("does not invent a catalog opportunity when the selected service is not in the catalog", async () => {
    savedCategoryRules = {
      rules: [{ categoryName: "Security", terms: ["HP Security Services"] }],
      useBuiltin: true,
    };
    for (const productId of [304, 305, 306, 307]) {
      data.push({ accountId: 22, accountName: "Unlisted service respondent", productId, submission: {
        id: 22, classification: "warm", product_interest: "HP Security Services",
        classification_reason: "Warm because no clear purchase timeline was given.",
        form_type: "event_feedback", action_at: at("2026-09-25"), contact_id: null,
      } });
    }
    const response = await request(app).get("/intent/opportunities/priority?status=warm").expect(200);
    expect(response.body.items.some((item: any) => item.accountId === 22)).toBe(false);
  });

  it("uses saved category rules on priority opportunities while preserving catalog IDs", async () => {
    savedCategoryRules = {
      rules: [{ categoryName: "Security", terms: ["HP Endpoint Devices"] }],
      useBuiltin: true,
    };
    const response = await request(app).get("/intent/opportunities/priority?status=hot&categoryName=Security").expect(200);
    expect(response.body.items).toContainEqual(expect.objectContaining({
      accountId: 11, productId: 101, categoryId: 1, categoryName: "Security",
    }));
    expect(response.body.items.some((item: any) => item.categoryName !== "Security")).toBe(false);
  });

  it("classifies specific monitoring evidence with saved phrases without changing product IDs", async () => {
    savedCategoryRules = {
      rules: [{ categoryName: "Business Services", terms: ["endpoint devices"] }],
      useBuiltin: true,
    };
    const response = await request(app).get("/intent/opportunities?categoryName=Business%20Services&pageSize=100").expect(200);
    expect(response.body.items).toContainEqual(expect.objectContaining({
      accountId: 13, productId: 101, categoryId: 1, categoryName: "Business Services",
      status: "hot", source: "monitoring",
    }));
  });

  it("rejects an unknown saved-category filter", async () => {
    await request(app).get("/intent/opportunities/priority?categoryName=Commercial%20Printing").expect(400);
    await request(app).get("/intent/opportunities?categoryName=Commercial%20Printing").expect(400);
  });

  it("filters before paginating and does not score off-page candidates", async () => {
    const first = await request(app).get("/intent/opportunities?status=hot&pageSize=1&page=1").expect(200);
    const second = await request(app).get("/intent/opportunities?status=hot&pageSize=1&page=2").expect(200);
    expect(first.body).toMatchObject({ hasMore: true, page: 1, pageSize: 1, items: [{ accountId: 11 }] });
    expect(second.body).toMatchObject({ hasMore: true, page: 2, items: [{ accountId: 13 }] });
    const scoreQueries = mocks.query.mock.calls.filter(([sql]) => String(sql).includes("DISTINCT ON"));
    expect(scoreQueries).toHaveLength(2);
    const scoped = await request(app).get("/intent/opportunities?productId=202").expect(200);
    expect(scoped.body).toMatchObject({ hasMore: false, items: [] });
    await request(app).get("/intent/opportunities?status=invalid").expect(400);
    await request(app).get("/intent/opportunities?productId=-1").expect(400);
  });

  it("refreshes the paginated Hot list immediately after an evidence review write", async () => {
    const before = await request(app).get("/intent/opportunities?status=hot&pageSize=1&page=2").expect(200);
    expect(before.body).toMatchObject({ hasMore: true, page: 2, items: [{ accountId: 13 }] });

    mocks.clientQuery.mockImplementation(async (sql: string, params: any[] = []) => {
      if (sql === "BEGIN" || sql === "COMMIT") return result([]);
      if (sql.includes("SELECT e.*")) {
        expect(params).toEqual([mocks.tenantId, 31]);
        return result([{ ...data.find(f => f.accountId === 13)!.evidence![0],
          signal_id: 33, event_fingerprint: "rollout:31", client_id: 8, audience_id: null }]);
      }
      if (sql.includes("UPDATE intent_evidence SET")) {
        expect(params[7]).toBe(mocks.tenantId);
        expect(params[8]).toBe(31);
        data.find(f => f.accountId === 13)!.evidence![0].review_status = params[5];
        return result([{ id: 31, accountId: 13, productId: 101, reviewStatus: params[5] }]);
      }
      throw new Error(`Unexpected review SQL: ${sql}`);
    });
    await request(app).patch("/intent/evidence/31/review")
      .send({ reviewStatus: "rejected" }).expect(200);

    const after = await request(app).get("/intent/opportunities?status=hot&pageSize=1&page=2").expect(200);
    expect(after.body).toMatchObject({ hasMore: true, page: 2, items: [{ accountId: 16 }] });
    expect(after.body.items).not.toEqual(expect.arrayContaining([expect.objectContaining({ accountId: 13 })]));
    const candidateQueries = mocks.query.mock.calls.filter(([sql]) => String(sql).includes("WITH candidate_pairs AS"));
    expect(candidateQueries).toHaveLength(2); // Each request requalifies, but stops after its page.
    expect(candidateQueries.every(([, params]) => params[0] === mocks.tenantId)).toBe(true);
  });

  it("does not borrow Hot qualification from another product or unapproved evidence", async () => {
    data.push({
      accountId: 11, accountName: "Fresh buyer", productId: 202, submission: {
        id: 81, classification: "warm", product_interest: "HP Laser Printer",
        classification_reason: "Exploring print options.", form_type: "lead_form",
        action_at: at("2026-09-22"), contact_id: null,
      },
    });
    data.push({ accountId: 18, accountName: "Unapproved rollout", productId: 101, evidence: [
      { ...direct(82, 18, 101, "The company will replace 2,000 endpoint devices across its India offices."), review_status: "pending_review" },
    ] });
    const response = await request(app).get("/intent/opportunities?pageSize=100").expect(200);
    expect(response.body.items.filter((item: any) => item.accountId === 11)).toEqual([
      expect.objectContaining({ productId: 101, status: "hot" }),
      expect.objectContaining({ productId: 202, status: "warm", score: { people: 0, monitoring: 0, total: 0 } }),
    ]);
    expect(response.body.items.find((item: any) => item.accountId === 18))
      .toMatchObject({ status: "review", score: { people: 0, monitoring: 0, total: 0 } });
  });

  it("scans past the first raw candidate batch before applying status and page offsets", async () => {
    data = Array.from({ length: 101 }, (_, index) => ({
      accountId: 1000 + index, accountName: `Older interest ${index}`, productId: 101,
      submission: {
        id: 1000 + index, classification: "hot", product_interest: "HP Endpoint Devices",
        classification_reason: "Historical quote.", form_type: "lead_form",
        action_at: at("2026-01-01"), contact_id: null,
      },
    }));
    data.push(fixtures[0], fixtures[2]);
    const response = await request(app).get("/intent/opportunities?status=hot&page=2&pageSize=1").expect(200);
    expect(response.body).toMatchObject({ hasMore: false, page: 2, items: [{ accountId: 13, status: "hot" }] });
    const batches = mocks.query.mock.calls.filter(([sql]) => String(sql).includes("WITH candidate_pairs AS"));
    expect(batches.map(([, params]) => params[7])).toEqual([0, 25, 50, 75, 100]);
    expect(mocks.query.mock.calls.filter(([sql]) => String(sql).includes("DISTINCT ON"))).toHaveLength(1);
  });

  it("returns a responsive first page without qualifying every account in a large queue", async () => {
    data = Array.from({ length: 1200 }, (_, index) => ({
      accountId: 1000 + index, accountName: `Buyer ${index}`, productId: 101,
      submission: {
        id: 1000 + index, classification: "warm", product_interest: "HP Endpoint Devices",
        classification_reason: "Exploring devices.", form_type: "lead_form",
        action_at: at("2026-09-22"), contact_id: null,
      },
    }));
    const started = performance.now();
    const first = await request(app).get("/intent/opportunities?pageSize=10&cursor=0").expect(200);
    expect(first.body).toMatchObject({ hasMore: true, page: 1, pageSize: 10 });
    expect(first.body.items).toHaveLength(10);
    expect(performance.now() - started).toBeLessThan(2000);
    const reads = mocks.query.mock.calls.filter(([sql]) => String(sql).includes("WITH candidate_pairs AS"));
    expect(reads).toHaveLength(1);
    expect(reads[0][1][6]).toBe(50);
    expect(mocks.query.mock.calls.filter(([sql]) => String(sql).includes("DISTINCT ON"))).toHaveLength(10);
  });

  it("continues sparse status scans in bounded cursor pages without losing a later Hot result", async () => {
    data = Array.from({ length: 450 }, (_, index) => ({
      accountId: 1000 + index, accountName: `Older interest ${index}`, productId: 101,
      submission: {
        id: 1000 + index, classification: "hot", product_interest: "HP Endpoint Devices",
        classification_reason: "Historical quote.", form_type: "lead_form",
        action_at: at("2026-01-01"), contact_id: null,
      },
    }));
    data.push(fixtures[0]);
    const first = await request(app).get("/intent/opportunities?status=hot&pageSize=10&cursor=0").expect(200);
    expect(first.body).toMatchObject({ items: [], hasMore: true, nextCursor: 200 });
    const second = await request(app).get(`/intent/opportunities?status=hot&pageSize=10&cursor=${first.body.nextCursor}`).expect(200);
    expect(second.body).toMatchObject({ items: [], hasMore: true, nextCursor: 400 });
    const third = await request(app).get(`/intent/opportunities?status=hot&pageSize=10&cursor=${second.body.nextCursor}`).expect(200);
    expect(third.body).toMatchObject({ items: [{ accountId: 11, status: "hot" }], hasMore: false, nextCursor: null });
    await request(app).get("/intent/opportunities?cursor=-1").expect(400);
    const candidateReads = mocks.query.mock.calls.filter(([sql]) => String(sql).includes("WITH candidate_pairs AS"));
    expect(candidateReads.filter(([, params]) => params[7] < 200)).toHaveLength(4);
  });

  it("keeps timeline event points, contributing people, and totals attributable to this product", async () => {
    const timeline = await request(app).get("/intent/opportunities/13/timeline?productId=101").expect(200);
    expect(timeline.body.score).toEqual({ people: 22, monitoring: 80, total: 102 });
    expect(timeline.body.people).toEqual([expect.objectContaining({ id: 5, score: 22 })]);
    expect(timeline.body.events.map((e: any) => [e.id, e.points])).toEqual(expect.arrayContaining([
      ["evidence-31", 80], ["signal-301", 15], ["activity-302", 7],
    ]));
    const category = await request(app).get("/intent/opportunities/14/timeline?productId=101").expect(200);
    expect(category.body.events.find((e: any) => e.id === "evidence-41").points).toBe(80);
    await request(app).get("/intent/opportunities/13/timeline?dateFrom=2026-02-30").expect(400);
    await request(app).get("/intent/opportunities/13/timeline?contactId=6").expect(404);
  });

  it("exports only Hot rows with quoted, formula-safe CSV fields", async () => {
    const response = await request(app).get("/intent/opportunities/handoff.csv?status=hot").expect(200);
    expect(response.headers["content-disposition"]).toContain("hot-opportunities.csv");
    const lines = response.text.split("\r\n");
    expect(lines).toHaveLength(5);
    expect(response.text).toContain('"\'=1+1, ""quoted"""');
    expect(response.text).toContain('"\'+SUM(A1) asks for ""a quote"" now"');
    expect(response.text).not.toContain("Old buyer");
    expect(response.text).not.toContain("Category only");
    const inserts = mocks.query.mock.calls.filter(([sql]) => String(sql).includes("INSERT INTO intent_opportunity_handoffs"));
    expect(inserts).toHaveLength(4);
    expect(inserts.every(([sql]) => String(sql).includes("'csv'"))).toBe(true);
    await request(app).get("/intent/opportunities/handoff.csv?status=warm").expect(400);
  });

  it("honors the selected four-category filter when exporting Hot opportunities", async () => {
    savedCategoryRules = {
      rules: [{ categoryName: "Security", terms: ["HP Endpoint Devices"] }],
      useBuiltin: true,
    };
    const response = await request(app).get("/intent/opportunities/handoff.csv?status=hot&categoryName=Security").expect(200);
    expect(response.text).toContain("Fresh buyer");
    expect(response.text).toContain(',"Security","hot",');
    expect(response.text).not.toContain("HP Laser Printer");
    await request(app).get("/intent/opportunities/handoff.csv?status=hot&categoryName=Commercial%20Printing").expect(400);
  });

  it("does not export or record Hot opportunities revoked after a cached list", async () => {
    await request(app).get("/intent/opportunities?status=hot&pageSize=100").expect(200);
    data.find(f => f.accountId === 11)!.submission.classification = "review";
    data.find(f => f.accountId === 13)!.evidence![0].review_status = "rejected";

    const response = await request(app).get("/intent/opportunities/handoff.csv?status=hot").expect(200);
    expect(response.text).not.toContain("Fresh buyer");
    expect(response.text).not.toContain("Direct rollout");
    const inserts = mocks.query.mock.calls.filter(([sql]) => String(sql).includes("INSERT INTO intent_opportunity_handoffs"));
    expect(inserts).toHaveLength(2);
    expect(inserts.map(([, params]) => params[1])).toEqual([16, 17]);

    const rejected = await request(app).post("/intent/opportunities/handoff").send(sheetBody).expect(409);
    expect(rejected.body.error).toContain("currently qualified Hot");
    expect(mocks.proxy).not.toHaveBeenCalled();
    expect(mocks.query.mock.calls.filter(([sql]) => String(sql).includes("INSERT INTO intent_opportunity_handoffs"))).toHaveLength(2);
  });

  it("stops a Sheets append if qualification is revoked while reading the destination", async () => {
    mocks.proxy
      .mockResolvedValueOnce(ok({ sheets: [{ properties: { title: "Leads" } }] }))
      .mockResolvedValueOnce({ ok: true, json: async () => {
        data.find(f => f.accountId === 13)!.evidence![0].review_status = "rejected";
        return { values: [] };
      } });
    const response = await request(app).post("/intent/opportunities/handoff").send(sheetBody).expect(409);
    expect(response.body.error).toContain("currently qualified Hot");
    expect(mocks.proxy.mock.calls.filter(([, path]) => String(path).includes(":append"))).toHaveLength(0);
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes("handoff_status='failed'"))).toBe(true);
  });

  it("retries a failed Sheets write, then avoids a duplicate append on repeated or recovered requests", async () => {
    mocks.proxy
      .mockResolvedValueOnce(ok({ sheets: [{ properties: { title: "Leads" } }] }))
      .mockResolvedValueOnce(ok({ values: [] }))
      .mockResolvedValueOnce({ ok: false, status: 503, text: async () => "temporary outage" })
      .mockResolvedValueOnce(ok({ sheets: [{ properties: { title: "Leads" } }] }))
      .mockResolvedValueOnce(ok({ values: [] }))
      .mockResolvedValueOnce(ok({}))
      .mockResolvedValueOnce(ok({ sheets: [{ properties: { title: "Leads" } }] }))
      .mockResolvedValueOnce(ok({ values: [["Account"], ["Direct rollout", "opportunity:13:101"]] }));
    const original = mocks.query.getMockImplementation()!;
    let state: "new" | "failed" | "completed" | "recover" = "new";
    mocks.query.mockImplementation((sql: string, params: any[]) => {
      if (sql.includes("INSERT INTO intent_opportunity_handoffs") && sql.includes("RETURNING")) {
        return Promise.resolve(result(state === "new" ? [{ id: 900, handoff_status: "pending" }] : []));
      }
      if (sql.includes("SELECT id,handoff_status,completed_at,created_at")) {
        return Promise.resolve(result([{ id: 900, handoff_status: state === "recover" ? "failed" : state,
          completed_at: state === "completed" ? at("2026-09-27") : null, created_at: at("2026-09-26") }]));
      }
      if (sql.includes("UPDATE intent_opportunity_handoffs SET handoff_status='pending'")) {
        return Promise.resolve(result([{ id: 900, handoff_status: "pending" }]));
      }
      return original(sql, params);
    });
    const first = await request(app).post("/intent/opportunities/handoff").send(sheetBody).expect(502);
    expect(first.body).toMatchObject({ status: "failed", id: 900 });
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes("handoff_status='failed'"))).toBe(true);
    state = "failed";
    const retry = await request(app).post("/intent/opportunities/handoff").send(sheetBody).expect(200);
    expect(retry.body).toMatchObject({ status: "completed", id: 900, duplicate: false });
    const appends = () => mocks.proxy.mock.calls.filter(([, path]) => String(path).includes(":append"));
    expect(appends()).toHaveLength(2);
    expect(appends()[1][2].body.values[1]).toContain("opportunity:13:101");
    state = "completed";
    const repeated = await request(app).post("/intent/opportunities/handoff").send(sheetBody).expect(200);
    expect(repeated.body.duplicate).toBe(true);
    expect(mocks.proxy).toHaveBeenCalledTimes(6);
    state = "recover";
    const recovered = await request(app).post("/intent/opportunities/handoff").send(sheetBody).expect(200);
    expect(recovered.body.duplicate).toBe(true);
    expect(appends()).toHaveLength(2);
  });
});