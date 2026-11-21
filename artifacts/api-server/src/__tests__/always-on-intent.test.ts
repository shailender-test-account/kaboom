import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, beforeEach, vi } from "vitest";

vi.mock("@workspace/db", () => ({
  pool: {
    query: vi.fn(),
  },
}));

vi.mock("../lib/intent-recommendations", () => ({
  createIntentRecommendation: vi.fn(),
}));

import { pool } from "@workspace/db";
import {
  base2Decay,
  eventFingerprint,
  matchEntities,
  normalizedDomain,
  normalizedEmail,
  normalizedPhone,
  enqueueIntent,
  processIntentQueue,
  saturateRepeatedSignals,
  selectIntentTier,
  isPurchaseStageSignal,
  purchaseGateScore,
  questionnaireAgingSummary,
  recomputeIntent,
  signalDecay,
  questionnaireSignalAudit,
} from "../lib/alwaysOnIntent";
import { discoverUnscoredIntentEntities } from "../intentRunner";
import { canonicalCategoryIntent, declaredQuestionnaireIntentTier, effectiveDetailIntent, hasCompanyScope, qualifyImplicitProductIntent } from "../routes/intent";

const query = vi.mocked(pool.query);

describe("always-on intent scoring helpers", () => {
  it("does not promote an unauditable stored research conclusion", () => {
    const intent = canonicalCategoryIntent(undefined, {
      opportunityBrief: {
        bestSelectedConclusion: {
          categoryName: "Software & Services",
          score: 62,
          tier: "warm",
          rationale: "Generic context",
          recommendedProducts: [],
        },
      },
    }, true);
    expect(intent).toBeNull();
  });

  it("accepts a research conclusion only when its scored evidence is auditable", () => {
    const intent = canonicalCategoryIntent(undefined, {
      opportunityBrief: {
        bestSelectedConclusion: {
          categoryName: "Software & Services",
          score: 62,
          tier: "warm",
          rationale: "Confirmed operational need",
          recommendedProducts: [{ name: "HP Managed Device Services" }],
          propensity: { evidence: [{ id: "source-1" }], dataConfidence: 80, hasRecentPurchaseSignal: true },
        },
      },
    }, true);
    expect(intent).toMatchObject({ categoryName: "Business Services", score: 62, tier: "warm" });
  });

  it("does not classify evidence as Hot without an explicit buying signal", () => {
    const intent = canonicalCategoryIntent(undefined, {
      opportunityBrief: {
        bestSelectedConclusion: {
          categoryName: "Software & Services",
          score: 82,
          tier: "hot",
          rationale: "Strong inferred fit",
          recommendedProducts: [{ name: "HP Managed Device Services" }],
          propensity: { evidence: [{ id: "source-1" }, { id: "source-2" }], hasRecentPurchaseSignal: false },
        },
      },
    }, true);
    expect(intent).toMatchObject({ score: 69, tier: "warm", hasRecentPurchaseSignal: false });
  });

  it("permits Hot only when auditable evidence contains an explicit buying signal", () => {
    const intent = canonicalCategoryIntent(undefined, {
      opportunityBrief: {
        bestSelectedConclusion: {
          categoryName: "Software & Services",
          score: 82,
          tier: "hot",
          rationale: "Active RFP",
          recommendedProducts: [{ name: "HP Managed Device Services" }],
          propensity: { evidence: [{ id: "source-1" }], hasRecentPurchaseSignal: true },
        },
      },
    }, true);
    expect(intent).toMatchObject({ score: 82, tier: "hot", hasRecentPurchaseSignal: true });
  });

  it("does not label an account Hot from an unscoped legacy score", () => {
    expect(effectiveDetailIntent(true, null, null, { score: 100, tier: "hot" })).toEqual({ score: 0, tier: "cold" });
  });

  it("keeps a validated category result ahead of the legacy score", () => {
    expect(effectiveDetailIntent(true, { score: 58, tier: "warm" }, null, { score: 100, tier: "hot" })).toEqual({ score: 58, tier: "warm" });
  });

  it("preserves stored scoring for contact details", () => {
    expect(effectiveDetailIntent(false, null, null, { score: 100, tier: "hot" })).toEqual({ score: 100, tier: "hot" });
  });

  it("keeps explicit product interest Warm when the respondent has no purchase plans", () => {
    expect(declaredQuestionnaireIntentTier(true, 5)).toBe("warm");
  });

  it("keeps explicit product interest Warm when the purchase horizon exceeds six months", () => {
    expect(declaredQuestionnaireIntentTier(true, 45)).toBe("warm");
  });

  it("lets explicit product interest become Cold after the 60-day nurture window", () => {
    expect(declaredQuestionnaireIntentTier(true, 5, 59.9)).toBe("warm");
    expect(declaredQuestionnaireIntentTier(true, 5, 60)).toBeNull();
  });

  it("does not let a scoped legacy score override missing validated account intent", () => {
    expect(effectiveDetailIntent(true, null, { score: 100, tier: "hot" }, { score: 100, tier: "hot" })).toEqual({ score: 0, tier: "cold" });
  });

  it("requires multiple implicit signals to qualify without purchase-stage evidence", () => {
    const tiers = [{ key: "cold", label: "Cold", min_score: 0 }, { key: "warm", label: "Warm", min_score: 40 }, { key: "hot", label: "Hot", min_score: 70 }];
    expect(qualifyImplicitProductIntent(65, tiers, false, 1)).toEqual({ score: 0, tier: "cold" });
    expect(qualifyImplicitProductIntent(65, tiers, false, 2)).toEqual({ score: 65, tier: "warm" });
  });

  it("does not accept a single implicit research signal as validated category intent", () => {
    const intent = canonicalCategoryIntent(undefined, {
      opportunityBrief: {
        bestSelectedConclusion: {
          categoryName: "Data Science",
          score: 62,
          tier: "warm",
          rationale: "Hiring data scientists",
          recommendedProducts: [],
          propensity: { evidence: [{ id: "source-1" }], hasRecentPurchaseSignal: false },
        },
      },
    }, true);
    expect(intent).toBeNull();
  });

  it("uses a stable event fingerprint while preserving event type boundaries", () => {
    const event = { eventType: "funding", accountId: 9, occurredAt: "2026-01-15T12:00:00.000Z", sourceUrl: "https://news.example/funding", excerpt: "Series A announced" };
    expect(eventFingerprint(event)).toBe(eventFingerprint({ ...event, occurredAt: "2026-01-15T23:59:00.000Z" }));
    expect(eventFingerprint(event)).not.toBe(eventFingerprint({ ...event, eventType: "layoffs" }));
  });

  it("keeps distinct same-day source articles as separate evidence", () => {
    const event = { eventType: "partnership", accountId: 9, occurredAt: "2026-09-03T12:00:00.000Z", context: { sourceIdentity: "https://news.example/bayer-a" } };
    expect(eventFingerprint(event)).not.toBe(eventFingerprint({
      ...event,
      context: { sourceIdentity: "https://news.example/bayer-b" },
    }));
  });

  it("uses a true base-2 half-life", () => {
    expect(base2Decay(0, 30)).toBe(1);
    expect(base2Decay(30, 30)).toBeCloseTo(0.5, 8);
    expect(base2Decay(60, 30)).toBeCloseTo(0.25, 8);
  });

  it("degrades explicit questionnaire product interest by 15 percent per month", () => {
    expect(signalDecay("questionnaire_product_interest", 0, 90)).toBe(1);
    expect(signalDecay("questionnaire_product_interest", 30, 90)).toBeCloseTo(0.85, 8);
    expect(signalDecay("questionnaire_product_interest", 60, 90)).toBeCloseTo(0.85 ** 2, 8);
    expect(signalDecay("questionnaire_timeframe", 60, 60)).toBeCloseTo(0.5, 8);
  });

  it("audits questionnaire product-interest values at monthly boundaries", () => {
    const occurredAt = "2026-01-01T00:00:00.000Z";
    const signal = { key: "questionnaire_product_interest", maxPoints: 40, strength: 50, occurredAt, halfLifeDays: 90 };
    expect(questionnaireSignalAudit(signal, "2026-01-31T00:00:00.000Z").currentPoints).toBe(17);
    expect(questionnaireSignalAudit(signal, "2026-03-02T00:00:00.000Z").currentPoints).toBe(14.45);
    expect(questionnaireSignalAudit(signal, "2026-04-01T00:00:00.000Z").currentPoints).toBe(12.28);
    const timeframe = questionnaireSignalAudit(
      { key: "questionnaire_timeframe", maxPoints: 40, strength: 50, occurredAt, halfLifeDays: 60 },
      "2026-03-02T00:00:00.000Z",
    );
    expect(timeframe.currentPoints).toBe(10);
    expect(timeframe.decayRule).toBe("Configured 60-day half-life");
    expect(timeframe.nextDecayAt).toBeNull();
  });

  it("saturates repeated signals instead of adding them linearly", () => {
    expect(saturateRepeatedSignals([10])).toBe(10);
    const repeated = saturateRepeatedSignals([10, 10, 10]);
    expect(repeated).toBeGreaterThan(10);
    expect(repeated).toBeLessThan(30);
  });

  it("selects configured tier keys without hardcoded labels", () => {
    const tiers = [
      { key: "cold", label: "Cold", min_score: 0 },
      { key: "warm", label: "Warm", min_score: 35 },
      { key: "hot", label: "Hot", min_score: 70 },
    ];
    expect(selectIntentTier(34, tiers).key).toBe("cold");
    expect(selectIntentTier(35, tiers).key).toBe("warm");
    expect(selectIntentTier(92, tiers).key).toBe("hot");
  });

  it("caps a high product score below Hot when no purchase-stage evidence exists",()=>{
    const tiers=[{key:"cold",label:"Cold",min_score:0},{key:"warm",label:"Warm",min_score:40},{key:"hot",label:"Hot",min_score:70}];
    expect(purchaseGateScore(100,tiers,false)).toEqual({score:69,tier:"warm"});
    expect(purchaseGateScore(100,tiers,true)).toEqual({score:100,tier:"hot"});
  });

  it("recognizes purchase-stage evidence without treating ordinary hiring as purchase intent",()=>{
    expect(isPurchaseStageSignal({key:"technology_integration",summary:"Issued an RFP for 500 laptops with delivery required this quarter",strength:90,payload:{fitmentLevel:"direct_intent"}})).toBe(true);
    expect(isPurchaseStageSignal({key:"technology_integration",summary:"Issued an RFP for 500 laptops",strength:90,payload:{fitmentLevel:"direct_intent"}})).toBe(false);
    expect(isPurchaseStageSignal({key:"hiring",summary:"Hiring 2,500 customer support employees",strength:95,payload:{fitmentLevel:"confirmed_need"}})).toBe(false);
  });
});

describe("always-on intent identity matching", () => {
  beforeEach(() => {
    query.mockReset();
  });

  it("normalizes supported identifiers", () => {
    expect(normalizedEmail("  Person@Example.COM ")).toBe("person@example.com");
    expect(normalizedPhone("+91 (987) 654-3210")).toBe("919876543210");
    expect(normalizedDomain("https://www.Example.com/path")).toBe("example.com");
  });

  it("does not fall back to phone when a valid supplied email misses", async () => {
    query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    const result = await matchEntities(12, {
      email: "missing@example.com",
      phone: "9876543210",
    });

    expect(result.contactId).toBeNull();
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]?.[0]).toContain("lower(btrim(email))");
    expect(query.mock.calls[0]?.[1]).toEqual([12, "missing@example.com"]);
  });

  it("accepts phone fallback only when exactly one tenant contact matches", async () => {
    query.mockResolvedValueOnce({
      rows: [{ id: 41, company_id: 9 }],
      rowCount: 1,
    } as never);

    const result = await matchEntities(7, { phone: "98765 43210" });
    expect(result).toMatchObject({ contactId: 41, accountId: 9 });
    expect(query.mock.calls[0]?.[1]).toEqual([7, "9876543210"]);
  });

  it("rejects ambiguous phone matches", async () => {
    query.mockResolvedValueOnce({
      rows: [{ id: 41, company_id: 9 }, { id: 42, company_id: 10 }],
      rowCount: 2,
    } as never);

    const result = await matchEntities(7, { phone: "9876543210" });
    expect(result.contactId).toBeNull();
  });
});

describe("research scope and product import safeguards", () => {
  beforeEach(() => query.mockReset());

  it("treats cross-client and out-of-audience accounts as out of scope", async () => {
    query.mockResolvedValue({ rows: [], rowCount: 0 } as never);
    await expect(hasCompanyScope(7, 42, 11, 99)).resolves.toBe(false);
    expect(query.mock.calls[0]?.[0]).toContain("c.client_id=$3");
    expect(query.mock.calls[0]?.[0]).toContain("ac.audience_id=$4");
    expect(query.mock.calls[0]?.[1]).toEqual([7, 42, 11, 99]);
  });

  it("requires product scope only for legacy product-buy imports and infers questionnaire products", () => {
    const routes = readFileSync(new URL("../routes/intent.ts", import.meta.url), "utf8");
    expect(routes).toContain('const productScopedImport = (kind: ImportKind) => kind === "product_buy_intent"');
    expect(routes).toContain("inferProductsFromInterest");
    expect(routes).toContain("responseImport(p.data.kind)");
    expect(routes).toContain("intent-response:");
    const commit = routes.slice(routes.indexOf('router.post("/intent/imports/commit"'), routes.indexOf('router.post("/intent/recompute"'));
    expect(commit).toContain("for (const entity of affected.values())");
  });

  it("batches heat-matrix queries instead of querying every account/product cell", () => {
    const routes = readFileSync(new URL("../routes/intent.ts", import.meta.url), "utf8");
    const matrix = routes.slice(routes.indexOf('router.get(["/intent/heat-matrix","/intent/product-matrix"]'), routes.indexOf("export default router"));
    expect(matrix).not.toContain("readProductIntentScore");
    expect(matrix).toContain("s.account_id=ANY($2::int[])");
    expect(matrix).toContain("GROUP BY account_id,product_id");
    expect(matrix).toContain("pageSize=Math.min(50");
  });

  it("keeps aged questionnaire value in product-matrix summaries while stale research stays filtered", () => {
    const routes = readFileSync(new URL("../routes/intent.ts", import.meta.url), "utf8");
    const matrix = routes.slice(routes.indexOf('router.get(["/intent/heat-matrix","/intent/product-matrix"]'), routes.indexOf("export default router"));
    expect(matrix).toContain("(st.category='questionnaire' OR s.occurred_at>=NOW()-interval");
    expect(matrix).toContain('key.startsWith("questionnaire_")');
    expect(matrix).toContain("questionnaireAging");

    const originalPoints = 40;
    const currentPoints = originalPoints * signalDecay("questionnaire_product_interest", 120, 180);
    expect(questionnaireAgingSummary([{ currentValues: [currentPoints], originalValues: [originalPoints] }])).toEqual({
      currentPoints: Number(currentPoints.toFixed(2)),
      originalPoints,
      retainedPercent: Math.round((currentPoints / originalPoints) * 100),
    });
    expect(questionnaireAgingSummary([])).toBeUndefined();
  });

  it("passes audience scope through import preview and rechecks it in commit", () => {
    const routes = readFileSync(new URL("../routes/intent.ts", import.meta.url), "utf8");
    expect(routes).toContain("p.data.mapping, p.data.clientId, p.data.audienceId");
    const commit = routes.slice(routes.indexOf('router.post("/intent/imports/commit"'), routes.indexOf('router.post("/intent/recompute"'));
    expect(commit).toContain("hasCompanyScope(u.tenantId,accountId,p.data.clientId,p.data.audienceId)");
  });

  it("creates scoped questionnaire companies and respondents instead of dropping out-of-scope matches", () => {
    const routes = readFileSync(new URL("../routes/intent.ts", import.meta.url), "utf8");
    const preview = routes.slice(routes.indexOf("async function previewRows"), routes.indexOf("function importResponse"));
    const commit = routes.slice(routes.indexOf('router.post("/intent/imports/commit"'), routes.indexOf('router.post("/intent/recompute"'));
    expect(preview).toContain("replacingOutOfScopeAccount");
    expect(preview).toContain("replacingOutOfScopeContact");
    expect(commit).toContain("item.match.accountInScope");
    expect(commit).toContain("item.match.contactInScope");
    expect(commit).toContain("ac.audience_id=$6");
    expect(commit).toContain("INSERT INTO contacts");
    expect(commit).toContain("INSERT INTO intent_audience_companies");
  });

  it("makes evidence review authoritative for product score, matrix, and details", () => {
    const engine = readFileSync(new URL("../lib/alwaysOnIntent.ts", import.meta.url), "utf8");
    const routes = readFileSync(new URL("../routes/intent.ts", import.meta.url), "utf8");
    expect(engine).toContain("ie.review_status='approved'");
    const detail = routes.slice(routes.indexOf("async function detail"), routes.indexOf('router.get("/intent/accounts/:id"'));
    expect(detail).toContain("ie.review_status='approved'");
    const matrix = routes.slice(routes.indexOf('router.get(["/intent/heat-matrix","/intent/product-matrix"]'), routes.indexOf("export default router"));
    expect(matrix).toContain("ie.review_status='approved'");
    const review = routes.slice(routes.indexOf('router.patch("/intent/evidence/:id/review"'), routes.indexOf('router.get("/intent/research/summary"'));
    expect(review).toContain('pending_review:["approved","rejected"]');
    expect(review).toContain('approved:["pending_review","rejected"]');
    expect(review).toContain('rejected:["pending_review","approved"]');
    expect(review).toContain('product_id AS "productId"');
  });

  it("keeps zero-credential research and discovery unavailable without fabrication", () => {
    const routes = readFileSync(new URL("../routes/intent.ts", import.meta.url), "utf8");
    expect(routes).toContain('providerConfigured(u.tenantId,"newsapi")');
    expect(routes).toContain('providerConfigured(u.tenantId,"perplexity")');
    expect(routes).toContain('providerConfigured(u.tenantId,"apollo")');
    const researchRunner = readFileSync(path.resolve(process.cwd(), "src/intentResearchRunner.ts"), "utf8");
    expect(researchRunner).toContain("fetchPerplexityEvents");
    expect(routes).toContain('["/intent/research-runs","/intent/research/runs"]');
    expect(routes).toContain('error:"provider_not_configured"');
  });

  it("does not enqueue a full decay sweep on every server restart", () => {
    const runner = readFileSync(new URL("../intentRunner.ts", import.meta.url), "utf8");
    const startup = runner.slice(runner.indexOf("void tickQueue();"), runner.indexOf("setInterval(() => { void tickQueue();"));
    expect(startup).toContain("void bootstrapMissingEntities();");
    expect(startup).not.toContain("void maintenanceSweep();");
  });
});

describe("always-on intent isolation boundary", () => {
  it("does not call or mutate legacy scoring, routing, stage, or enrollment systems", () => {
    const sources = [
      "../lib/alwaysOnIntent.ts",
      "../lib/intent-recommendations.ts",
      "../routes/intent.ts",
      "../intentRunner.ts",
      "../../../../lib/db/drizzle/0014_intent_activity_outbox.sql",
      "../../../../lib/db/drizzle/0015_harden_intent_activity_outbox.sql",
    ].map((path) => {
      const source = readFileSync(new URL(path, import.meta.url), "utf8");
      // Manual inbound CRM maintenance is independent of always-on intent processing.
      return path === "../routes/intent.ts"
        ? source.replace(/class ManualInboundEmailConflictError[\s\S]*?(?=router\.get\("\/intent\/inbound\/category-rules")/, "")
        : source;
    });
    const implementation = sources.join("\n");

    expect(implementation).not.toMatch(/\bcomputeIntentScore\b/);
    expect(implementation).not.toMatch(/\bevaluateRoutingRules\b/);
    expect(implementation).not.toMatch(/\bscoringEngine\b/);
    expect(implementation).not.toMatch(/UPDATE\s+contacts\b/i);
    expect(implementation).not.toMatch(/UPDATE\s+companies\b/i);
    expect(implementation).not.toMatch(/INSERT\s+INTO\s+(activity_events|score_history|sequence_enrollments)\b/i);
    expect(implementation).toContain("pg_advisory_lock(hashtextextended($1,0))");
    expect(implementation).toContain("pg_advisory_xact_lock(hashtextextended($1,0))");
  });
});

describe("always-on intent queue", () => {
  beforeEach(() => {
    query.mockReset();
  });

  it("prioritizes fresh activity over nightly decay backlog", () => {
    const engine = readFileSync(new URL("../lib/alwaysOnIntent.ts", import.meta.url), "utf8");
    const queue = engine.slice(engine.indexOf("export async function processIntentQueue"));
    expect(queue).toContain("CASE WHEN source='nightly_decay' THEN 1 ELSE 0 END");
  });

  it("uses database-enforced active-work deduplication", async () => {
    query.mockResolvedValue({ rows: [], rowCount: 0 } as never);

    await enqueueIntent(1, { accountId: 42 }, "test");
    expect(query.mock.calls[0]?.[0]).toContain("ON CONFLICT (tenant_id,account_id)");

    await enqueueIntent(1, { contactId: 84 }, "test");
    expect(query.mock.calls[1]?.[0]).toContain("ON CONFLICT (tenant_id,contact_id)");
  });

  it("finalizes only the lease attempt it claimed", async () => {
    query
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
      .mockResolvedValueOnce({
        rows: [{ id: 7, tenant_id: 1, account_id: 42, contact_id: null, source: "test", attempts: 3, max_attempts: 5, claimed_at: new Date() }],
        rowCount: 1,
      } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);
    const processor = vi.fn().mockResolvedValue({ score: 1, tier: "cold" });

    expect(await processIntentQueue(1, processor as never)).toBe(1);
    expect(query.mock.calls[2]?.[0]).toContain("status='claimed' AND attempts=$2");
    expect(query.mock.calls[2]?.[1]).toEqual([7, 3]);
  });

  it("backs off only the lease attempt that failed", async () => {
    query
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
      .mockResolvedValueOnce({
        rows: [{ id: 8, tenant_id: 1, account_id: 43, contact_id: null, source: "test", attempts: 2, max_attempts: 5, claimed_at: new Date() }],
        rowCount: 1,
      } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);
    const processor = vi.fn().mockRejectedValue(new Error("boom"));

    expect(await processIntentQueue(1, processor as never)).toBe(1);
    expect(query.mock.calls[2]?.[0]).toContain("status='claimed' AND attempts=$5");
    expect(query.mock.calls[2]?.[1]).toEqual([8, "pending", "boom", 2, 2]);
  });
});

describe("product intent isolation", () => {
  it("keeps product-tagged signals out of global recompute SQL", () => {
    const source = readFileSync(new URL("../lib/alwaysOnIntent.ts", import.meta.url), "utf8");
    const recompute = source.slice(source.indexOf("export async function recomputeIntent"), source.indexOf("export async function processIntentQueue"));
    expect(recompute).toContain("s.product_id IS NULL");
  });

  it("uses product-tagged signals for the read-only product score", () => {
    const source = readFileSync(new URL("../lib/alwaysOnIntent.ts", import.meta.url), "utf8");
    const scoped = source.slice(source.indexOf("export async function readProductIntentScore"), source.indexOf("export async function enqueueIntent"));
    expect(scoped).toContain("s.product_id=ANY($2::int[])");
    expect(scoped).not.toContain("INSERT INTO intent_entity_scores");
  });

  it("keeps client-scoped consulting signals within the matching client", () => {
    const engine = readFileSync(new URL("../lib/alwaysOnIntent.ts", import.meta.url), "utf8");
    const routes = readFileSync(new URL("../routes/intent.ts", import.meta.url), "utf8");
    expect(engine).toContain("s.client_id IS NULL OR s.client_id=co.client_id");
    expect(routes).toContain("lower(btrim(industry))=lower(btrim($2)) AND ($3::int IS NULL OR client_id=$3)");
  });

  it("applies client and audience membership to detail identity resolution", () => {
    const routes = readFileSync(new URL("../routes/intent.ts", import.meta.url), "utf8");
    expect(routes).toContain("co.client_id=$3");
    expect(routes).toContain("ac.audience_id=$4 AND ac.company_id=co.id");
    expect(routes).toContain("c.id=coalesce(s.account_id,ct.company_id)");
  });

  it("isolates persisted recommendations by client and audience and empties product scopes", () => {
    const routes = readFileSync(new URL("../routes/intent.ts", import.meta.url), "utf8");
    const recommendations = routes.slice(routes.indexOf('router.get("/intent/recommendations"'), routes.indexOf('router.patch("/intent/recommendations'));
    expect(recommendations).toContain("coalesce(a.client_id,co.client_id)=$4");
    expect(recommendations).toContain("ac.audience_id=$5");
    expect(recommendations).toContain("ac.company_id=coalesce(a.id,co.id)");
    expect(recommendations).toContain("recommendations:[],page,pageSize,total:0,totalPages:0");
  });
});

describe("always-on intent bootstrap discovery", () => {
  beforeEach(() => {
    query.mockReset();
  });

  it("discovers unscored contacts and accounts in bounded tenant-safe pages", async () => {
    query
      .mockResolvedValueOnce({ rows: [{ next_cursor: 0, candidate_count: 0 }], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [{ next_cursor: 0, candidate_count: 0 }], rowCount: 1 } as never);

    await expect(discoverUnscoredIntentEntities(1)).resolves.toEqual({ contacts: 0, accounts: 0 });
    expect(query.mock.calls).toHaveLength(2);
    expect(query.mock.calls[0]?.[0]).toContain("NOT EXISTS");
    expect(query.mock.calls[0]?.[0]).toContain("coalesce(a.is_bot,false)=false");
    expect(query.mock.calls[0]?.[0]).toContain("interval '90 days'");
    expect(query.mock.calls[0]?.[1]).toEqual([0, 1_000]);
    expect(query.mock.calls[1]?.[0]).toContain("GROUP BY c.tenant_id,c.company_id");
    expect(query.mock.calls[1]?.[1]).toEqual([0, 1_000]);
  });
});