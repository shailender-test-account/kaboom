import { describe, expect, it } from "vitest";
import { contactAffinityLabels, scoredAccountSignals } from "../lib/additiveIntentScore";

const catalog = [
  { id: 11, name: "Business Laptops", category: "IT Hardware" },
  { id: 12, name: "Endpoint Security", category: "Security" },
];
const categoryRules = { rules: [], useBuiltin: true };

describe("additive contact affinity", () => {
  it("awards one affinity to a contact with a selected category or catalog product, not to blank answers", () => {
    const labels = contactAffinityLabels([
      {contact_id:1,product_interest:"Business Laptops; IT Hardware",affinity_reviews:{}},
      {contact_id:1,product_interest:"Business Laptops",affinity_reviews:{}},
      {contact_id:2,product_interest:"N/A",affinity_reviews:{}},
      {contact_id:3,product_interest:"Endpoint Security",affinity_reviews:{"Endpoint Security":"rejected"}},
      {contact_id:4,product_interest:"Some unknown phrase",affinity_reviews:{}},
    ], [], catalog, categoryRules);
    expect(labels.get(1)).toEqual(["Business Laptops", "IT Hardware"]);
    expect(labels.has(2)).toBe(false);
    expect(labels.has(3)).toBe(false);
    expect(labels.has(4)).toBe(false);
  });
  it("recognizes a cited product in a questionnaire signal without awarding twice", () => {
    const labels = contactAffinityLabels([
      {contact_id:1,product_interest:"Business Laptops",affinity_reviews:{}},
    ], [
      {contact_id:1,product_name:"Business Laptops",category_name:"IT Hardware",answer:"Business Laptops"},
      {contact_id:2,product_name:"Endpoint Security",category_name:"Security",answer:null},
    ], catalog, categoryRules);
    expect(labels.get(1)).toEqual(["Business Laptops"]);
    expect(labels.get(2)).toEqual(["Endpoint Security"]);
  });
});

describe("additive account research signals", () => {
  const now = new Date("2026-09-27T12:00:00Z");
  const evidence = (overrides: Record<string, unknown> = {}) => ({
    id: 1, event_type:"hiring", occurred_at:new Date("2026-09-20T12:00:00Z"),
    source_url:"https://example.test/news/hiring", confidence:88,
    excerpt:"The company is adding 500 sales agents and will equip new offices with devices.",
    context:{aiReview:{
      relevant:true,confidence:88,rationale:"New sales agents require endpoint devices across the planned offices.",
      fitments:[{level:"confirmed_need",points:52,productId:11,reason:"A 500-person sales expansion creates a concrete need to equip those staff with laptops."}],
    }}, ...overrides,
  });
  it("scores a supported, recent event once and explains the product need", () => {
    const rows = scoredAccountSignals([
      evidence(),
      evidence({id:2,source_url:"https://example.test/news/hiring?campaign=email"}),
      evidence({id:3,source_url:"https://syndication.test/news/hiring"}),
    ], catalog, now);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({points:5,category:"IT Hardware",productName:"Business Laptops"});
    expect(rows[0].reason).toContain("500-person sales expansion");
    expect(rows[0].reason).toContain("500 sales agents");
  });
  it("excludes stale, generic, or unreviewed fallback context", () => {
    const rows = scoredAccountSignals([
      evidence({id:1,occurred_at:new Date("2025-09-20T12:00:00Z")}),
      evidence({id:2,context:{aiReview:{relevant:true,confidence:88,rationale:"Growth context",
        fitments:[{level:"context",points:20,productId:11,reason:"Laptops are mentioned but no need is established."}]}}}),
      evidence({id:3,context:{aiReview:{relevant:true,confidence:72,
        rationale:"Automatic AI review was unavailable for this batch",
        fitments:[{level:"confirmed_need",points:52,productId:11,reason:"A 500-person expansion could require laptops for those staff."}]}}}),
      evidence({id:4,context:{aiReview:{relevant:true,confidence:88,rationale:"New sales agents need devices",
        fitments:[{level:"confirmed_need",points:52,productId:999,reason:"A 500-person expansion could require laptops for those staff."}]}}}),
    ], catalog, now);
    expect(rows).toEqual([]);
  });
  it("counts two distinct supported events separately", () => {
    const rows = scoredAccountSignals([evidence(), evidence({
      id:4,event_type:"branch_opening",source_url:"https://example.test/news/office",
      excerpt:"The company is hiring 200 office staff and needs workplace computers.",
    })], catalog, now);
    expect(rows.map(row => row.points)).toEqual([5,5]);
  });
});