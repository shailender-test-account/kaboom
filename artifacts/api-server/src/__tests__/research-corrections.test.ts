import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(), release: vi.fn(), rebuild: vi.fn(),
  actor: { id: 5, tenantId: 9, role: "admin" },
}));
vi.mock("@workspace/db", () => ({ pool: {
  connect: async () => ({ query: mocks.query, release: mocks.release }), query: mocks.query,
} }));
vi.mock("../lib/researchOpportunityInterpreter", () => ({
  RESEARCH_FITMENT_POLICY_VERSION: 10, rebuildStoredResearchOpportunityLocally: mocks.rebuild,
}));
vi.mock("../middlewares/requireAuth", () => ({ requireAuth: (req: any, _res: any, next: any) => { req.user = mocks.actor; next(); } }));
import { applyResearchCorrection, proposeResearchCorrection, refreshCorrectedResearch } from "../lib/researchFindingCorrection";
import router from "../routes/researchCorrections";

const actor = { id: 5, tenantId: 9, role: "admin" };
let finding: any, signals: any[], catalog: any[], saved: any, belongs: boolean;
const source = "Acme India will cut 2,000 jobs.";
function statements() { return mocks.query.mock.calls.map(call => String(call[0])); }
async function proposal() { return proposeResearchCorrection(actor, 12, 2); }
function approval(value: Awaited<ReturnType<typeof proposal>>) {
  return { proposalId: value.proposalId, evidenceId: 2, sourceVersion: value.sourceVersion, approved: true as const, reason: "Confirmed against original source." };
}
function app() {
  const app = express(); app.use(express.json()); app.use(router);
  app.use((err: any, _req: any, res: any, _next: any) => res.status(500).json({ error: err.message }));
  return app;
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.actor.role = "admin"; belongs = true; saved = null;
  finding = { id: 2, accountId: 12, signalId: 21, productId: 1, eventType: "hiring", excerpt: "Acme hired 2,000 staff",
    sourceUrl: "https://acme.example/news", reviewStatus: "approved", confidence: 90,
    occurredAt: new Date("2026-10-01"), rawEvidence: { excerpt: source }, reviewedBy: null, reviewedAt: null,
    context: { aiReview: { fitments: [{ productId: 1, productName: "Business Laptops", category: "IT Hardware", points: 80 }],
      catalogProductIds: [1], signalType: "hiring" }, opportunityBrief: { old: true } } };
  signals = [
    { id: 21, productId: 1, signalTypeId: 4, source: "public_event", shared: false, payload: { evidenceId: 2, fitmentPoints: 80 } },
    { id: 22, productId: 99, signalTypeId: 4, source: "public_event", shared: false, payload: { evidenceId: 2 } },
    { id: 23, productId: 1, signalTypeId: 4, source: "lead_form", shared: false, payload: { evidenceId: 2 } },
    { id: 24, productId: 1, signalTypeId: 4, source: "public_event", shared: true, payload: { evidenceId: 2 } },
  ];
  catalog = [{ id: 1, name: "Business Laptops", category: "IT Hardware", subcategory: null }];
  mocks.rebuild.mockResolvedValue("rebuilt");
  mocks.query.mockImplementation(async (sql: string, params: any[] = []) => {
    if (sql.startsWith("SELECT id FROM companies")) { expect(params).toEqual([9, 12]); return { rows: belongs ? [{ id: 12 }] : [] }; }
    if (sql.startsWith("SELECT id,account_id")) { expect(params).toEqual([9, 12, 2]); return { rows: finding ? [structuredClone(finding)] : [] }; }
    if (sql.startsWith("SELECT s.*")) { expect(params).toEqual([9, 12, 2, finding.signalId]); return { rows: structuredClone(signals) }; }
    if (sql.startsWith("SELECT p.id")) return { rows: structuredClone(catalog) };
    if (sql.startsWith("SELECT id FROM intent_signal_types")) return { rows: [{ id: params[1] === "layoffs" ? 6 : 4 }] };
    if (sql.startsWith("INSERT INTO intent_research_corrections")) {
      saved = { evidence_id: params[3], source_version: params[4], proposal: JSON.parse(params[5]), status: "proposed", expires_at: params[7] };
      return { rows: [] };
    }
    if (sql.startsWith("SELECT evidence_id")) return { rows: saved ? [structuredClone(saved)] : [] };
    if (sql.startsWith("INSERT INTO intent_signals")) return { rows: [{ id: 88 }] };
    if (sql.startsWith("UPDATE intent_research_corrections")) { saved.status = "applied"; return { rows: [] }; }
    return { rows: [] };
  });
});

describe("separately approved public-research corrections", () => {
  it("shows original facts, false old fitments, exact owned removals and protected signals", async () => {
    const value = await proposal();
    expect(value.sourceFact).toBe(source);
    expect(value.proposed.fitments).toEqual([]);
    expect(value.exactRemovals.productIds).toEqual([1, 99]);
    expect(value.exactRemovals.signals.map(signal => signal.id)).toEqual([21, 22]);
    expect(value.protectedSignals.map(signal => signal.id)).toEqual([23, 24]);
    expect(statements().some(sql => /^(DELETE|UPDATE|INSERT INTO intent_signals)/.test(sql))).toBe(false);
  });
  it("applies only owned public signals, preserves raw facts, and atomically audits before/after", async () => {
    const value = await proposal(), result = await applyResearchCorrection(actor, 12, approval(value));
    expect(result.delta).toEqual({ removedSignalIds: [21, 22], addedSignals: [], removedProductIds: [1, 99] });
    const deletion = mocks.query.mock.calls.find(call => String(call[0]).startsWith("DELETE"));
    expect(deletion?.[0]).toContain("source='public_event'");
    expect(deletion?.[1]).toEqual([9, 12, [21, 22]]);
    const update = mocks.query.mock.calls.find(call => String(call[0]).startsWith("UPDATE intent_evidence"));
    expect(update?.[1].slice(0, 3)).toEqual([null, null, "layoffs"]);
    expect(update?.[0]).not.toMatch(/SET excerpt|raw_evidence\s*=/);
    expect(update?.[0]).not.toMatch(/reviewed_by\s*=|reviewed_at\s*=/);
    const audit = mocks.query.mock.calls.find(call => String(call[0]).startsWith("UPDATE intent_research_corrections"));
    expect(audit?.[1].slice(0, 2)).toEqual([5, "Confirmed against original source."]);
    expect(saved.proposal.before.fitments[0].points).toBe(80);
    expect(saved.status).toBe("applied");
    expect(statements().at(-1)).toBe("COMMIT");
    expect(statements().some(sql => /inbound|form_submissions|hp_bi|order_value|fiscal|intent_entity_scores|intent_recompute_queue|recommendations/i.test(sql))).toBe(false);
    expect(mocks.rebuild).not.toHaveBeenCalled();
  });
  it("replaces retained supported products with newly derived fitment points", async () => {
    finding.rawEvidence.excerpt = "Acme India needs to replace 500 employee laptops and requests a quotation within 30 days.";
    const value = await proposal();
    expect(value.proposed.fitments[0].productId).toBe(1);
    const result = await applyResearchCorrection(actor, 12, approval(value));
    expect(result.delta.addedSignals).toEqual([{ id: 88, productId: 1 }]);
    const insert = mocks.query.mock.calls.find(call => String(call[0]).startsWith("INSERT INTO intent_signals"));
    const payload = JSON.parse(insert?.[1][8]);
    expect(payload.evidenceId).toBe(2);
    expect(payload.fitmentPoints).toBe(value.proposed.fitments[0].points);
    expect(payload.correctionId).toBe(value.proposalId);
  });
  it("uses the corrected signal type and aiReview metadata when layoffs retain a supported fitment", async () => {
    finding.rawEvidence.excerpt = "Acme India will cut 2,000 jobs. Acme India needs to replace 500 employee laptops and requests a quotation within 30 days.";
    const value = await proposal();
    expect(value.proposed.eventType).toBe("layoffs");
    expect(value.proposed.fitments[0].productId).toBe(1);
    await applyResearchCorrection(actor, 12, approval(value));
    const type = mocks.query.mock.calls.find(call => String(call[0]).startsWith("SELECT id FROM intent_signal_types"));
    expect(type?.[1]).toEqual([9, "layoffs"]);
    const insert = mocks.query.mock.calls.find(call => String(call[0]).startsWith("INSERT INTO intent_signals"));
    expect(insert?.[1][3]).toBe(6);
    const update = mocks.query.mock.calls.find(call => String(call[0]).startsWith("UPDATE intent_evidence"));
    expect(JSON.parse(update?.[1][3]).signalType).toBe("layoffs");
  });
  it.each(["source", "signals", "catalog", "review"])("rejects a stale %s snapshot without evidence writes", async kind => {
    const value = await proposal();
    if (kind === "source") finding.rawEvidence.excerpt += " Updated facts.";
    if (kind === "signals") signals[0].payload.fitmentPoints++;
    if (kind === "catalog") catalog[0].name += " revised";
    if (kind === "review") finding.reviewedBy = 91;
    await expect(applyResearchCorrection(actor, 12, approval(value))).rejects.toThrow("changed");
    expect(statements().some(sql => /^(DELETE|UPDATE|INSERT INTO intent_signals)/.test(sql))).toBe(false);
    expect(statements().at(-1)).toBe("ROLLBACK");
  });
  it("refuses replay, expiry and a mismatched finding/version", async () => {
    const value = await proposal();
    saved.status = "applied";
    await expect(applyResearchCorrection(actor, 12, approval(value))).rejects.toThrow("already applied");
    saved.status = "proposed"; saved.expires_at = new Date(0);
    await expect(applyResearchCorrection(actor, 12, approval(value))).rejects.toThrow("expired");
    saved.expires_at = new Date(Date.now() + 60_000);
    await expect(applyResearchCorrection(actor, 12, { ...approval(value), evidenceId: 3 })).rejects.toThrow("does not match");
    await expect(applyResearchCorrection(actor, 12, { ...approval(value), sourceVersion: "a".repeat(64) })).rejects.toThrow("does not match");
  });
  it("rejects shared primary signals and conflicting ownership", async () => {
    signals[0].shared = true;
    const value = await proposal();
    await expect(applyResearchCorrection(actor, 12, approval(value))).rejects.toThrow("primary signal");
    signals[0].shared = false; signals[0].payload.evidenceId = 300;
    const other = await proposal();
    await expect(applyResearchCorrection(actor, 12, approval(other))).rejects.toThrow("primary signal");
  });
  it("refuses non-admin, out-of-tenant account, non-public finding and missing original facts", async () => {
    await expect(proposeResearchCorrection({ ...actor, role: "member" }, 12, 2)).rejects.toThrow("Admins only");
    expect(mocks.query).not.toHaveBeenCalled();
    belongs = false; await expect(proposal()).rejects.toThrow("tenant");
    belongs = true; finding.rawEvidence = {}; await expect(proposal()).rejects.toThrow("Original provider");
    finding = null; await expect(proposal()).rejects.toThrow("Public research finding");
  });
  it("requires a durable server proposal rather than a command JSON export", async () => {
    await expect(applyResearchCorrection(actor, 12, { proposalId: "old-json-report", sourceVersion: "a".repeat(64), evidenceId: 2, approved: true, reason: "I reviewed the export" })).rejects.toThrow("Server-issued");
    expect(statements().some(sql => /^(DELETE|UPDATE)/.test(sql))).toBe(false);
  });
  it("rolls back if writing the audit fails; no commit is emitted", async () => {
    const value = await proposal();
    const base = mocks.query.getMockImplementation()!;
    mocks.query.mockImplementation(async (sql: string, params?: any[]) => {
      if (sql.startsWith("UPDATE intent_research_corrections")) throw new Error("Audit unavailable");
      return base(sql, params);
    });
    mocks.query.mockClear();
    await expect(applyResearchCorrection(actor, 12, approval(value))).rejects.toThrow("Audit unavailable");
    expect(statements().at(-1)).toBe("ROLLBACK");
    expect(statements()).not.toContain("COMMIT");
    expect(mocks.release).toHaveBeenCalled();
  });
  it("refreshes only research views, without CRM recomputation or automation", async () => {
    await refreshCorrectedResearch(9, 12);
    expect(mocks.rebuild).toHaveBeenCalledExactlyOnceWith(9, 12, true);
    expect(mocks.query).not.toHaveBeenCalled();
  });
});

describe("admin approval API boundaries", () => {
  it("blocks every correction endpoint for non-admins", async () => {
    mocks.actor.role = "member";
    for (const suffix of ["preview", "apply", "refresh"]) {
      expect((await request(app()).post(`/intent/accounts/12/research-corrections/${suffix}`).send({})).status).toBe(403);
    }
    expect((await request(app()).get("/intent/accounts/12/research-corrections")).status).toBe(403);
    expect(mocks.query).not.toHaveBeenCalled();
  });
  it("requires approved=true and rejects unrecognized proposal JSON fields", async () => {
    const value = await proposal();
    for (const body of [{ ...approval(value), approved: false }, { ...approval(value), proposed: value.proposed }, { ...approval(value), reason: "" }]) {
      expect((await request(app()).post("/intent/accounts/12/research-corrections/apply").send(body)).status).toBe(400);
    }
    expect(saved.status).toBe("proposed");
  });
  it("reports a committed correction separately from a failed research refresh", async () => {
    const value = await proposal();
    // pino is installed by the application; attach a silent logger for this isolated router.
    const server = express(); server.use(express.json());
    server.use((req: any, _res, next) => { req.log = { error: vi.fn() }; next(); }); server.use(router);
    mocks.rebuild.mockRejectedValue(new Error("Research view unavailable"));
    const response = await request(server).post("/intent/accounts/12/research-corrections/apply").send(approval(value));
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ applied: true, refreshPending: true, evidenceId: 2 });
    expect(saved.status).toBe("applied");
  });
});
