import { beforeEach, describe, expect, it, vi } from "vitest";

const mockQuery = vi.hoisted(() => vi.fn());
vi.mock("@workspace/db", () => ({pool:{query:mockQuery}}));
vi.mock("../lib/inboundTaxonomy", async importOriginal => ({
  ...await importOriginal<typeof import("../lib/inboundTaxonomy")>(),
  loadInboundCategoryRules: vi.fn(async () => ({rules:[],useBuiltin:true})),
}));

import { readAccountAdditiveScore, readContactAdditiveScore } from "../lib/additiveIntentScore";

const rows = (items: unknown[]) => ({rows:items,rowCount:items.length});

describe("additive account and contact read model", () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.startsWith("SELECT id FROM companies")) return rows([{id:9}]);
      if (sql.includes("FROM contacts")) return rows([
        {id:21,first_name:"Alex",last_name:"Lee",lead_score:24,company_id:9},
        {id:22,first_name:"Sam",last_name:"Kim",lead_score:6,company_id:9},
      ]);
      if (sql.includes("FROM intent_inbound_submissions")) return rows([
        {contact_id:21,product_interest:"Business Laptops",affinity_reviews:{}},
        {contact_id:21,product_interest:"Business Laptops",affinity_reviews:{}},
        {contact_id:22,product_interest:null,affinity_reviews:{}},
      ]);
      if (sql.includes("FROM intent_signals")) return rows([]);
      if (sql.includes("FROM intent_products")) return rows([{id:11,name:"Business Laptops",category:"IT Hardware"}]);
      if (sql.includes("FROM intent_evidence")) return rows([{
        id:55,event_type:"hiring",occurred_at:new Date(),source_url:"https://example.test/500-hires",
        excerpt:"The company is hiring 500 sales staff who need laptops for work.",confidence:89,
        context:{aiReview:{relevant:true,confidence:89,rationale:"The rollout needs workplace devices.",
          fitments:[{productId:11,level:"confirmed_need",points:65,
            reason:"The expanded sales team needs laptops to equip its 500 new staff members."}]}},
      }]);
      throw new Error(`Unexpected query: ${sql}`);
    });
  });

  it("sums journey scores and one affinity award per contact, plus a distinct account signal", async () => {
    const result = await readAccountAdditiveScore(7,9);
    expect(result).toMatchObject({
      accountId:9,contactPoints:40,accountSignalPoints:5,total:45,
      contacts:[
        {id:21,journeyPoints:24,affinityPoints:10,total:34},
        {id:22,journeyPoints:6,affinityPoints:0,total:6},
      ],
      signals:[{evidenceId:55,points:5,category:"IT Hardware"}],
    });
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("WHERE tenant_id=$1 AND account_id=$2 AND contact_id IS NULL"),
      [7,9],
    );
  });
  it("returns a contact's score without adding the account's news points", async () => {
    const result = await readContactAdditiveScore(7,21);
    expect(result).toMatchObject({id:21,journeyPoints:24,affinityPoints:10,total:34});
    expect(mockQuery.mock.calls.some(([sql]) => sql.includes("FROM intent_evidence"))).toBe(false);
  });
});