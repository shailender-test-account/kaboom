import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("@workspace/db", () => ({ pool: { query: mocks.query }, db: {} }));
import { readProductIntentScore, readProductIntentScores } from "../lib/alwaysOnIntent";

describe("saved monitoring product-score geography", () => {
  beforeEach(() => vi.clearAllMocks());
  it.each([
    ["India", "ExxonMobil issued an RFP for 500 business laptops in Texas, United States, for deployment next month.", false],
    ["India", "BBC issued an RFP for 500 business laptops at its UK London offices for deployment next month.", false],
    ["India", "The company issued an RFP for 500 business laptops at its Hyderabad office for deployment next month.", true],
    ["Global", "ExxonMobil issued an RFP for 500 business laptops in Texas, United States, for deployment next month.", true],
  ])("gates single and bulk %s scores using the original source: %s", async (country, excerpt, contributes) => {
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM intent_tiers")) return { rows: [
        { key: "hot", label: "Hot", min_score: 80 }, { key: "warm", label: "Warm", min_score: 40 },
        { key: "cold", label: "Cold", min_score: 0 },
      ] };
      return { rows: [{
        key: "procurement", label: "Procurement", max_points: 70, half_life_days: 90, strength: 90,
        occurred_at: new Date(), account_id: 8, contact_id: null, source: "public_event",
        summary: "The company issued an RFP for 500 business laptops in Hyderabad for deployment next month.",
        product_id: 1, product_name: "Business laptop", category_name: "IT Hardware", subcategory_name: null,
        evidence_id: 99, evidence_excerpt: excerpt, raw_evidence: { excerpt, context: {} },
        evidence_context: { scope: { country }, opportunityBrief: { whyNow: "Hyderabad opportunity" } },
        payload: { evidenceId: 99 },
      }] };
    });
    const single = await readProductIntentScore(7, 1, { accountId: 8 });
    const bulk = (await readProductIntentScores(7, [1], [8])).get(8);
    expect(single.score > 0).toBe(contributes);
    expect(bulk?.score).toBe(single.score);
    if (!contributes) expect(single.lastSignalAt).toBeNull();
    const sql = String(mocks.query.mock.calls[0][0]);
    expect(sql).toContain("evidence.raw_evidence");
    expect(sql).toContain("s.payload->>'evidenceId'");
  });
});
