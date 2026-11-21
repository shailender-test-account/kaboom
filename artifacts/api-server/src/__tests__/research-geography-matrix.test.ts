import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("@workspace/db", () => ({ pool: { query: mocks.query }, db: {} }));
vi.mock("../middlewares/requireAuth", async importOriginal => ({
  ...await importOriginal<typeof import("../middlewares/requireAuth")>(),
  requireAuth: (req: any, _res: any, next: any) => { req.user = { id: 1, tenantId: 7, role: "admin" }; next(); },
}));
vi.mock("../utils/segmentFilter", () => ({ buildContactsWhereClause: vi.fn() }));
vi.mock("../lib/alwaysOnIntent", async importOriginal => ({
  ...await importOriginal<typeof import("../lib/alwaysOnIntent")>(), ensureIntentDefaults: vi.fn(),
}));
import router from "../routes/intent";
const app = express().use(router).use((error: Error, _req: any, res: any, _next: any) => res.status(500).json({ error: error.message }));

describe.each(["heat-matrix", "product-matrix"])("%s original-source geography", route => {
  it.each([
    ["India", "BBC issued an RFP for 500 laptops for a Windows 11 fleet refresh in London, UK.", false],
    ["India", "ExxonMobil issued an RFP for 500 laptops for a Windows 11 fleet refresh in Texas, US.", false],
    ["India", "The company issued an RFP for 500 laptops for a Windows 11 fleet refresh in Hyderabad.", true],
    ["Global", "ExxonMobil issued an RFP for 500 laptops for a Windows 11 fleet refresh in Texas, US.", true],
  ])("uses saved %s evidence, not the AI signal summary: %s", async (country, excerpt, contributes) => {
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM intent_inbound_category_rules")) return { rows: [] };
      if (sql.startsWith("SELECT p.id,p.name")) return { rows: [{ id: 1, name: "HP Business Laptop", subcategoryName: null }] };
      if (sql.startsWith("SELECT count(*) FROM companies")) return { rows: [{ count: "1" }] };
      if (sql.startsWith("SELECT c.id,c.name")) return { rows: [{ id: 8, name: "Example", lastResearchedAt: null }] };
      if (sql.includes("FROM intent_signals s")) return { rows: [{
        account_id: 8, product_id: 1, key: "procurement", label: "Procurement", max_points: 70,
        half_life_days: 90, strength: 90, occurred_at: new Date(), source: "public_event",
        summary: "The India business issued an RFP for a Windows 11 fleet refresh within 90 days.",
        payload: { evidenceId: 99 }, evidence_excerpt: "AI suggests a Hyderabad purchase",
        evidence_context: { scope: { country }, aiReview: { rationale: "India opportunity" } },
        raw_evidence: { excerpt, context: {} },
      }] };
      if (sql.includes("FROM intent_tiers")) return { rows: [
        { key: "hot", label: "Hot", min_score: 80 }, { key: "warm", label: "Warm", min_score: 40 },
        { key: "cold", label: "Cold", min_score: 0 },
      ] };
      if (sql.startsWith("SELECT account_id,product_id,count")) return { rows: [] };
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    const response = await request(app).get(`/intent/${route}?productId=1`).expect(200);
    const cell = response.body.accounts[0].cells[0];
    expect(cell.score > 0).toBe(contributes);
    expect(cell.hasRecentPurchaseSignal).toBe(contributes);
    expect(Boolean(cell.lastSignalAt)).toBe(contributes);
    if (!contributes) expect(cell).toMatchObject({ status: "cold", contributions: [] });
    const sql = String(mocks.query.mock.calls.find(([sql]) => String(sql).includes("FROM intent_signals s"))?.[0]);
    expect(sql).toContain("evidence.raw_evidence");
    expect(sql).toContain("signal_id=s.id OR id=CASE");
  });
});
