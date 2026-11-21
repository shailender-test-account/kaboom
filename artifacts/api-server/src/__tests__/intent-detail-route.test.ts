import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { queuedQuery } = vi.hoisted(() => ({ queuedQuery: vi.fn() }));
vi.mock("@workspace/db", () => ({
  pool: {
    query: (sql: string, params: any[]) => (sql.includes("FROM intent_inbound_submissions")
      && sql.includes("classification IN ('hot','warm')"))
      || (sql.startsWith("SELECT e.id,e.account_id,e.event_type")
        && sql.includes("e.review_status='approved'"))
      ? { rows: [], rowCount: 0 } : queuedQuery(sql, params),
    connect: vi.fn(),
  },
  db: {},
}));
vi.mock("../middlewares/requireAuth", async importOriginal => ({
  ...await importOriginal<typeof import("../middlewares/requireAuth")>(),
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { id: 1, tenantId: 7, role: "admin" };
    next();
  },
}));
vi.mock("../utils/segmentFilter", () => ({ buildContactsWhereClause: vi.fn() }));
vi.mock("../lib/alwaysOnIntent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/alwaysOnIntent")>();
  return {
    ...actual,
    ensureIntentDefaults: vi.fn(), enqueueIntent: vi.fn(), matchEntities: vi.fn(),
    normalizedDomain: vi.fn(), recomputeIntent: vi.fn(),
    base2Decay: vi.fn(() => 1),
    saturateRepeatedSignals: vi.fn((values: number[]) => values.reduce((sum, value) => sum + value, 0)),
    PUBLIC_EVENT_TYPES: ["funding", "layoffs", "hiring", "branch_opening", "merger_acquisition", "cxo_appointment", "partnership", "quarterly_financial", "technology_integration", "capital_investment"],
    eventFingerprint: vi.fn(),
    selectIntentTier: vi.fn((score: number) => ({ key: score >= 70 ? "hot" : score >= 40 ? "warm" : "cold" })),
    readProductIntentScore: vi.fn().mockResolvedValue({
      score: 61, tier: "warm", contributions: [{ key: "event", points: 61 }],
      lastSignalAt: "2026-01-01T00:00:00.000Z",
    }),
  };
});

import router, { applyFirstPartyStatus } from "../routes/intent";
import { RESEARCH_FITMENT_POLICY_VERSION } from "../lib/researchOpportunityInterpreter";
import { readProductIntentScore } from "../lib/alwaysOnIntent";

const app = express().use(express.json()).use(router);
app.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  res.status(500).json({ error: error.message });
});
const result = (rows: any[]) => ({ rows, rowCount: rows.length });

describe("intent detail route isolation", () => {
  beforeEach(() => { queuedQuery.mockReset(); });
  afterEach(() => vi.useRealTimers());

  const contact = { id: 8, name: "Test Buyer", companyId: 4, companyName: "Acme", email: "buyer@example.test" };
  const ownedContact = (sql: string) => /FROM contacts c\s+LEFT JOIN companies co/.test(sql);

  it.each([["questionnaire","event_questionnaire"],["event_feedback","event_questionnaire"],["lead_form","lead_form"],[undefined,"inbound_response"]])(
    "uses saved response type %s rather than hard-coded lead form", (formType,expected) => {
      const ref={kind:"inbound_submission",id:21,formType};
      const at="2026-09-23T10:00:00Z";
      const status=applyFirstPartyStatus({accountStatus:"cold",accountDrivingSignals:[],categories:[],accountExplanation:"No source"} as any,
        {inboundIntent:{classification:"warm",reason:"Selected product with a 4–6 month timeframe",occurredAt:at,firstPartySource:ref}});
      expect(status.accountStatus).toBe("warm");
      expect(status.accountDrivingSignals[0]).toMatchObject({signalType:expected,occurredAt:at,firstPartySource:ref});
    });

  it("loads one source after enforcing account, tenant, client and audience ownership", async () => {
    queuedQuery.mockImplementation(async (sql:string,params:unknown[]) => {
      if(sql.includes("FROM companies c WHERE")) {
        expect(params).toEqual([7,4,2,3]);
        return result([{id:4,name:"Acme"}]);
      }
      if(sql.includes("FROM intent_inbound_submissions s")) {
        expect(params).toEqual([7,4,21]);
        expect(sql).toContain("s.tenant_id=$1 AND s.account_id=$2 AND s.id=$3");
        return result([{id:21,formType:"event_feedback",answers:{Product:"HP Poly",__internal:"private"},submittedAt:"2026-09-23"}]);
      }
      if(sql.startsWith("SELECT 1 FROM"))return result([{exists:1}]);
      return result([]);
    });
    const response=await request(app).get("/intent/accounts/4?section=first-party-source&sourceKind=inbound_submission&sourceId=21&clientId=2&audienceId=3").expect(200);
    expect(response.body).toMatchObject({formType:"event_feedback",answers:{Product:"HP Poly"},dateOrigin:"source"});
    expect(response.body.answers).not.toHaveProperty("__internal");
    expect(queuedQuery.mock.calls.some(([sql])=>sql.includes("FROM intent_entity_scores"))).toBe(false);
  });

  it.each(["sourceKind=inbound_submission&sourceId=0","sourceKind=unknown&sourceId=21","sourceKind=intent_evidence&sourceId=-1"])(
    "rejects an invalid source reference: %s", async query => {
      queuedQuery.mockImplementation(async (sql:string)=>result(sql.includes("FROM companies c WHERE")?[{id:4}]:[]));
      await request(app).get(`/intent/accounts/4?section=first-party-source&${query}`).expect(400);
      expect(queuedQuery.mock.calls.some(([sql])=>sql.includes("FROM intent_inbound_submissions s"))).toBe(false);
    });

  it("returns contact identity with no score row or supporting reads", async () => {
    queuedQuery.mockImplementation(async (sql: string, params: unknown[]) => {
      if (ownedContact(sql)) {
        expect(sql).toContain("co.tenant_id=c.tenant_id");
        expect(sql).toContain("co.client_id=$3");
        expect(sql).toContain("ac.audience_id=$4");
        expect(params).toEqual([7, 8, 2, 3]);
        return result([contact]);
      }
      if (sql.startsWith("SELECT 1 FROM")) return result([{ exists: 1 }]);
      if (/FROM intent_(entity_scores|evidence|signals|recommendations)/.test(sql)) throw new Error("Identity must not wait");
      return result([]);
    });
    const response = await request(app).get("/intent/contacts/8?section=identity&clientId=2&audienceId=3");
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject(contact);
    expect(response.body).not.toHaveProperty("score");
  });

  it.each(["identity", "analysis", "evidence", "recommendations", "engagement"])("enforces tenant and company ownership on contact %s", async section => {
    queuedQuery.mockResolvedValue(result([]));
    const response = await request(app).get(`/intent/contacts/8?section=${section}`);
    expect(response.status).toBe(404);
    expect(response.body.error).toBe("Contact not found");
    expect(queuedQuery.mock.calls.every(([, params]) => params[0] === 7)).toBe(true);
    expect(queuedQuery.mock.calls.some(([sql]) => sql.includes("FROM intent_recommendations"))).toBe(false);
  });

  it.each(["gtmPage=0", "timelinePage=-1", "gtmPage=1.5", "timelinePage=oops"])("rejects invalid engagement pagination: %s", async query => {
    queuedQuery.mockImplementation(async (sql: string) => ownedContact(sql) ? result([contact]) : result([]));
    const response = await request(app).get(`/intent/contacts/8?section=engagement&${query}`);
    expect(response.status).toBe(400);
    expect(response.body.error).toBe("Invalid engagement pagination");
    expect(queuedQuery.mock.calls.some(([sql]) => sql.includes("WITH responses AS"))).toBe(false);
  });

  it.each(["clientId=oops", "audienceId=0", "productId=-1", "categoryIds=1,bad", "section=research"])("rejects invalid contact scope: %s", async query => {
    expect((await request(app).get(`/intent/contacts/8?${query}`)).status).toBe(400);
    expect(queuedQuery).not.toHaveBeenCalled();
  });

  it("loads contact recommendations without scoring or evidence", async () => {
    queuedQuery.mockImplementation(async (sql: string) => {
      if (ownedContact(sql)) return result([contact]);
      if (sql.includes("FROM intent_recommendations")) return result([{ id: 2, title: "Follow up", status: "pending" }]);
      if (/FROM intent_(entity_scores|evidence|signals)/.test(sql)) throw new Error("Evidence unavailable");
      return result([]);
    });
    const response = await request(app).get("/intent/contacts/8?section=recommendations").expect(200);
    expect(response.body.latestRecommendation.id).toBe(2);
  });

  it.each([false, true])("preserves full contact scoring in the analysis panel (product scope: %s)", async scoped => {
    queuedQuery.mockImplementation(async (sql: string) => {
      if (ownedContact(sql)) return result([contact]);
      if (sql.includes("FROM intent_entity_scores es")) return result([{ ...contact, score: 73, tierKey: "hot", tierLabel: "Hot", contributions: [{ key: "existing_behavior", points: 20, reason: "Visited journey" }] }]);
      if (sql.includes("FROM intent_products p")) return result([{ id: 9 }]);
      return result([]);
    });
    const query = scoped ? "?productId=9" : "";
    const full = await request(app).get(`/intent/contacts/8${query}`).expect(200);
    queuedQuery.mockClear();
    const panel = await request(app).get(`/intent/contacts/8${query}${scoped ? "&" : "?"}section=analysis`).expect(200);
    for (const key of ["score", "tierKey", "tierLabel", "tierColor", "contributions", "lastSignalAt"]) expect(panel.body[key]).toEqual(full.body[key]);
    expect(queuedQuery.mock.calls.some(([sql]) => /FROM intent_(evidence|recommendations|signals)/.test(sql))).toBe(false);
  });

  it("preserves contact and company evidence while recommendations fail", async () => {
    queuedQuery.mockImplementation(async (sql: string) => {
      if (ownedContact(sql)) return result([contact]);
      if (sql.includes("FROM intent_entity_scores es")) return result([{ ...contact, score: 42, contributions: [{ key: "existing_behavior", reason: "Visited journey", points: 20 }], updatedAt: "2026-10-20" }]);
      if (sql.startsWith('SELECT s.id,s.product_id')) {
        expect(sql).toContain("(s.contact_id=$2 OR s.account_id=(SELECT company_id FROM contacts WHERE tenant_id=$1 AND id=$2))");
        return result([{ id: 10, summary: "Company signal", source: "manual" }]);
      }
      if (sql.startsWith("SELECT e.id,e.product_id")) return result([{ id: 20, evidenceKind: "event_questionnaire", excerpt: "Original questionnaire" }]);
      if (sql.includes("FROM intent_recommendations")) throw new Error("Recommendations unavailable");
      return result([]);
    });
    const evidence = await request(app).get("/intent/contacts/8?section=evidence").expect(200);
    expect(evidence.body.evidence.contactKaboom[0].summary).toBe("Visited journey");
    expect(evidence.body.evidence.uploaded[0].excerpt).toBe("Original questionnaire");
    expect(evidence.body.signals[0].summary).toBe("Company signal");
    expect(evidence.body.activityEvidence[0].summary).toBe("Visited journey");
    await request(app).get("/intent/contacts/8?section=recommendations").expect(500);
  });

  it("returns a zero-score panel for a valid contact with no score row", async () => {
    queuedQuery.mockImplementation(async (sql: string) => result(ownedContact(sql) ? [contact] : []));
    const response = await request(app).get("/intent/contacts/8?section=analysis").expect(200);
    expect(response.body).toMatchObject({ score: 0, tierKey: "cold", contributions: [] });
  });

  it("returns identity without reading scores, evidence or fit analysis", async () => {
    queuedQuery.mockImplementation(async (sql: string, params: unknown[]) => {
      if (sql.includes("FROM companies c WHERE")) {
        expect(sql).toContain("c.tenant_id=$1 AND c.id=$2");
        expect(sql).toContain("c.client_id=$3");
        expect(sql).toContain("ac.audience_id=$4");
        expect(params).toEqual([7, 4, 2, 3]);
        return result([{ id: 4, name: "Acme", domain: "acme.example" }]);
      }
      return result(sql.startsWith("SELECT 1 FROM") ? [{ exists: 1 }] : []);
    });
    const response = await request(app).get("/intent/accounts/4?section=identity&clientId=2&audienceId=3");
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ id: 4, name: "Acme" });
    expect(response.body).not.toHaveProperty("score");
    const queries = queuedQuery.mock.calls.map(([sql]) => sql).join("\n");
    expect(queries).not.toContain("FROM intent_entity_scores");
    expect(queries).not.toContain("FROM intent_evidence");
    expect(queries).not.toContain("FROM intent_signals");
  });

  it.each(["identity", "research", "evidence", "analysis", "first-party-source"])("rejects an account outside ownership/scope for %s", async section => {
    queuedQuery.mockResolvedValue(result([]));
    const response = await request(app).get(`/intent/accounts/4?section=${section}`);
    expect(response.status).toBe(404);
    expect(response.body.error).toBe("Account not found");
    for (const [, params] of queuedQuery.mock.calls) expect(params[0]).toBe(7);
  });

  it("validates section and category before running panel work", async () => {
    expect((await request(app).get("/intent/accounts/4?section=unknown")).status).toBe(400);
    expect((await request(app).get("/intent/accounts/4?section=identity&categoryName=Unknown")).status).toBe(400);
    expect(queuedQuery).not.toHaveBeenCalled();
  });

  it("loads supporting evidence without invoking product-fit or research interpretation", async () => {
    queuedQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM intent_entity_scores es")) return result([{ id: 4, name: "Acme", score: 99, contributions: [] }]);
      if (sql.startsWith("SELECT e.id,e.product_id")) return result([{ id: 20, evidenceKind: "event_questionnaire", excerpt: "Original questionnaire answer", reviewStatus: "approved" }]);
      return result([]);
    });
    const response = await request(app).get("/intent/accounts/4?section=evidence");
    expect(response.status).toBe(200);
    expect(response.body.evidence.uploaded).toEqual([expect.objectContaining({ id: 20, excerpt: "Original questionnaire answer" })]);
    expect(response.body).not.toHaveProperty("score");
    expect(response.body).not.toHaveProperty("productAnalysis");
    const queries = queuedQuery.mock.calls.map(([sql]) => sql).join("\n");
    expect(queries).not.toContain("SELECT s.id,s.account_id");
    expect(queries).not.toContain("SELECT e.id,e.account_id");
  });

  it("keeps scoped canonical analysis identical to the full response without leaking global activity", async () => {
    queuedQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM intent_entity_scores es")) return result([{
        id: 4, name: "Acme", score: 99, tierKey: "hot", contributions: [],
        lastSignalAt: "2026-10-20T00:00:00Z",
      }]);
      if (sql.includes("FROM intent_products p")) return result([{ id: 9, name: "Analytics", category_name: "Security" }]);
      return result([]);
    });
    const scoped = { score: 0, tier: "cold", contributions: [], lastSignalAt: null };
    vi.mocked(readProductIntentScore).mockResolvedValueOnce(scoped as any).mockResolvedValueOnce(scoped as any);
    const full = await request(app).get("/intent/accounts/4?productId=9");
    const panel = await request(app).get("/intent/accounts/4?productId=9&section=analysis");
    expect(full.status).toBe(200);
    expect(panel.status).toBe(200);
    for (const key of ["score", "tierKey", "canonicalCategoryIntent", "productAnalysis", "intentStatus", "analysisScope", "contributions", "lastSignalAt"]) {
      // evaluatedAt can legitimately differ between two reads.
      if (key === "intentStatus") {
        const { evaluatedAt: _fullTime, ...fullStatus } = full.body[key];
        const { evaluatedAt: _panelTime, ...panelStatus } = panel.body[key];
        expect(panelStatus).toEqual(fullStatus);
      } else expect(panel.body[key]).toEqual(full.body[key]);
    }
    expect(panel.body.score).toBe(0);
    expect(panel.body.tierKey).toBe("cold");
    expect(panel.body.lastSignalAt).toBeNull();
  });

  it("returns qualification even when the independent research read fails", async () => {
    queuedQuery.mockImplementation(async (sql: string) => {
      if (sql.startsWith("SELECT e.id,e.account_id,e.event_type")) throw new Error("Research temporarily unavailable");
      if (sql.includes("FROM intent_entity_scores es")) return result([{ id: 4, name: "Acme", score: 99, tierKey: "hot", contributions: [] }]);
      if (sql.includes("FROM companies c WHERE")) return result([{ id: 4, name: "Acme" }]);
      return result([]);
    });
    const analysis = await request(app).get("/intent/accounts/4?section=analysis");
    expect(analysis.status).toBe(200);
    expect(analysis.body.intentStatus.accountStatus).toBe("cold");
    expect(queuedQuery.mock.calls.some(([sql]) => sql.startsWith("SELECT e.id,e.account_id,e.event_type"))).toBe(false);
    const research = await request(app).get("/intent/accounts/4?section=research");
    expect(research.status).toBe(500);
    expect(research.body.error).toBe("Research temporarily unavailable");
  });

  it.each(["signal listing", "historical count"])("returns qualification when the supporting %s fails", async kind => {
    const supportingRead = (sql: string) => kind === "signal listing"
      ? sql.startsWith('SELECT s.id,s.product_id AS "productId"')
      : sql.startsWith('SELECT count(*)::int AS count,max(s.occurred_at)');
    queuedQuery.mockImplementation(async (sql: string) => {
      if (supportingRead(sql)) throw new Error("Supporting evidence temporarily unavailable");
      if (sql.includes("FROM intent_entity_scores es")) return result([{ id: 4, name: "Acme", score: 99, tierKey: "hot", contributions: [] }]);
      return result([]);
    });
    const analysis = await request(app).get("/intent/accounts/4?section=analysis");
    expect(analysis.status).toBe(200);
    expect(analysis.body.intentStatus.accountStatus).toBe("cold");
    expect(queuedQuery.mock.calls.some(([sql]) => supportingRead(sql))).toBe(false);
    const evidence = await request(app).get("/intent/accounts/4?section=evidence");
    expect(evidence.status).toBe(500);
    expect(evidence.body.error).toBe("Supporting evidence temporarily unavailable");
  });

  it.each([
    { briefPolicy: RESEARCH_FITMENT_POLICY_VERSION, currentBrief: true },
    { briefPolicy: RESEARCH_FITMENT_POLICY_VERSION - 1, currentBrief: false },
  ])("shows product-tagged signals without an unvalidated CRM score (current brief: $currentBrief)", async ({ briefPolicy, currentBrief }) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-03-02T00:00:00.000Z"));
    queuedQuery
      .mockResolvedValueOnce(result([]))
      .mockResolvedValueOnce(result([{ id: 4, name: "Acme", score: 20, contributions: [] }]))
      .mockResolvedValueOnce(result([]))
      .mockImplementationOnce(async (sql: string) => {
        expect(sql).toContain("$3::int[] IS NULL OR s.product_id IS NULL OR s.product_id=ANY($3::int[])");
        expect(sql).toContain("s.occurred_at>=NOW()-interval '3 months'");
        return result([{ id: 10, productId: 9, typeKey: "event" }]);
      })
      .mockResolvedValueOnce(result([]))
      .mockResolvedValueOnce(result([]))
      .mockImplementationOnce(async (sql: string, params: any[]) => {
        expect(sql).toContain("$3::int[] IS NULL OR e.product_id IS NULL OR e.product_id=ANY($3::int[])");
        expect(sql).toContain('e.product_id AS "productId"');
        expect(sql).toContain('p.name AS "productName"');
        expect(sql).toContain("s.strength");
        expect(sql).not.toContain("AS contribution");
        expect(sql).toContain("e.occurred_at>=NOW()-interval '3 months'");
        expect(sql).toContain("e.review_status<>'rejected'");
        expect(params[2]).toBeNull();
        return result([
          { id: 22, productId: 9, productName: "Analytics", evidenceKind: "public_event", reviewStatus: "pending_review", strength: 80, excerpt: "Acme launches its FY2026 cloud program", eventDate: "2026-07-10T00:00:00.000Z", context: { country: "Global" } },
          { id: 23, productId: null, evidenceKind: "public_event", reviewStatus: "rejected", excerpt: "Unrelated rejected news", eventDate: "2026-07-11T00:00:00.000Z" },
        ]);
      })
      .mockResolvedValueOnce(result([{ count: 2, latestAt: "2024-12-01T00:00:00.000Z" }]))
      .mockResolvedValueOnce(result([]))
      .mockImplementationOnce(async (sql: string) => {
        expect(sql).toContain("(st.category='questionnaire' OR s.occurred_at>=NOW()-interval '3 months')");
        return result([
          {
            id: 30,
            account_id: 4,
            product_id: 9,
            key: "questionnaire_product_interest",
            max_points: 40,
            half_life_days: 90,
            strength: 50,
            occurred_at: "2026-01-01T00:00:00.000Z",
            source: "import:event_questionnaire",
            summary: "Product interest: Analytics",
            payload: { answer: { field: "product_interest", value: "Analytics", reason: "Selected product" } },
          },
          {
            id: 31,
            account_id: 4,
            product_id: null,
            key: "questionnaire_timeframe",
            max_points: 40,
            half_life_days: 60,
            strength: 50,
            occurred_at: "2026-01-01T00:00:00.000Z",
            source: "import:event_questionnaire",
            summary: "Buying timeframe: Exploring",
            payload: { answer: { field: "purchase_timeframe", value: "Exploring", reason: "Medium-term interest" } },
          },
        ]);
      })
      .mockResolvedValueOnce(result([]))
      .mockResolvedValueOnce(result([{
        id: 77,
        account_id: 4,
        company_name: "Acme",
        company_domain: "acme.example",
        event_type: "technology_integration",
        excerpt: "Acme launches a cloud cybersecurity platform modernization program in Hyderabad",
        occurred_at: "2026-07-10T00:00:00.000Z",
        confidence: 80,
        review_status: "pending_review",
        context: { country: "India",opportunityBrief:{fitmentPolicyVersion:briefPolicy,geographyPolicyVersion:1,
          whyNow:"A Hyderabad office has a supported modernization requirement.",sourceUrls:["https://example.com/india"],categoryConclusions:[]} },
      },{
        id:78,account_id:4,company_name:"Acme",company_domain:"acme.example",event_type:"layoffs",excerpt:"BBC announces restructuring in London and the UK.",
        occurred_at:"2026-07-11T00:00:00.000Z",confidence:80,review_status:"pending_review",context:{scope:{country:"India"}},
      }]));

    // This fixture supplies unscoped history, contacts and null product parameters.
    // The following test separately exercises the product-scoped query contract.
    const response = await request(app).get("/intent/accounts/4");
    expect(response.body).not.toHaveProperty("error");
    expect(response.status, response.body.error).toBe(200);
    expect(response.body.score).toBe(0);
    expect(response.body.tierKey).toBe("cold");
    expect(response.body.signals).toEqual([{ id: 10, productId: 9, typeKey: "event" }]);
    expect(response.body.recentSignals).toEqual(response.body.signals);
    expect(response.body.excludedHistoricalSignals).toEqual({ count: 2, latestAt: "2024-12-01T00:00:00.000Z" });
    expect(response.body.evidence.public).toEqual([
      { id: 22, productId: 9, productName: "Analytics", evidenceKind: "public_event", reviewStatus: "pending_review", strength: 80, excerpt: "Acme launches its FY2026 cloud program", eventDate: "2026-07-10T00:00:00.000Z", context: { country: "Global" } },
    ]);
    expect(response.body.researchIntent).toMatchObject({
      signalCount: 1,
      pendingCount: 1,
      approvedCount: 0,
    });
    if (currentBrief) {
      expect(response.body.researchIntent.opportunityBrief).toMatchObject({ geographyPolicyVersion: 1 });
    } else {
      // Product review must not promote a legacy research brief into current approval.
      expect(response.body.researchIntent.opportunityBrief).toBeUndefined();
    }
    expect(response.body.researchIntent.topics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        label: "Digital Transformation",
        tier: "cold",
        score: 0,
        approvedCount: 0,
        explanation: expect.stringContaining("does not affect intent status"),
      }),
    ]));
    // Broad keywords remain business context, not separate product-demand topics.
    expect(response.body.researchIntent.topics).toHaveLength(1);
    expect(response.body.productAnalysis.questionnaireAnalysis).toMatchObject({
      answerCount: 2,
      declaredTier: null,
    });
    const productInterest = response.body.productAnalysis.questionnaireAnalysis.answers.find(
      (answer: any) => answer.field === "product_interest",
    );
    expect(productInterest.audit).toMatchObject({
      originalPoints: 20,
      currentPoints: 14.45,
      ageDays: 60,
      nextDecayAt: "2026-04-01T00:00:00.000Z",
    });
    const timeframe = response.body.productAnalysis.questionnaireAnalysis.answers.find(
      (answer: any) => answer.field === "purchase_timeframe",
    );
    expect(timeframe.audit).toMatchObject({
      originalPoints: 20,
      currentPoints: 10,
      ageDays: 60,
      nextDecayAt: null,
      decayRule: "Configured 60-day half-life",
    });
    expect(response.body.productAnalysis.signalCount).toBe(0);
  });

  it("returns only ephemeral artifacts for a product-scoped detail", async () => {
    queuedQuery
      .mockResolvedValueOnce(result([]))
      .mockResolvedValueOnce(result([{ id: 9 }]))
      .mockResolvedValueOnce(result([{ id: 4, name: "Acme", score: 20, contributions: [{ key: "existing_behavior" }] }]))
      .mockImplementationOnce(async (sql: string, params: any[]) => {
        expect(sql).toContain("s.product_id IS NULL OR s.product_id=ANY($3::int[])");
        expect(sql).toContain("s.occurred_at>=NOW()-interval '3 months'");
        expect(params[2]).toEqual([9]);
        return result([{ id: 11, productId: 9, typeKey: "event" }]);
      })
      .mockImplementationOnce(async (sql: string, params: any[]) => {
        expect(sql).toContain("$3::int[] IS NULL OR e.product_id IS NULL OR e.product_id=ANY($3::int[])");
        expect(params[2]).toEqual([9]);
        return result([]);
      })
      .mockResolvedValueOnce(result([{ count: 0, latestAt: null }]))
      .mockResolvedValueOnce(result([]))
      .mockResolvedValueOnce(result([]))
      .mockResolvedValueOnce(result([]))
      .mockResolvedValueOnce(result([]));

    const response = await request(app).get("/intent/accounts/4?productId=9").expect(200);
    expect(response.body).toMatchObject({
      score: 0,
      scoreHistory: [],
      recommendations: [],
      latestRecommendation: null,
      contacts: [],
      signals: [{ id: 11, productId: 9, typeKey: "event" }],
    });
    expect(response.body.contributions).toEqual([{ key: "event", points: 61 }]);
  });
});
