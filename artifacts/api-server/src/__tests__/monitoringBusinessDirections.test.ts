import { describe, expect, it } from "vitest";
import { monitoredAccountContext } from "../lib/monitoredAccountContext";

const now = new Date("2026-10-29");
const event = (id: number, excerpt: string) => ({
  id, excerpt, sourceUrl: `https://example.com/${id}`, occurredAt: "2026-10-28",
  eventType: "company_news", reviewStatus: "approved", context: { publishedDate: "2026-10-27" },
});
const analyze = (...texts: string[]) => monitoredAccountContext(texts.map((text, index) => event(index + 1, text)), now, { name: "Acme", clientName: "HP" });
describe("business direction organization", () => {
  it("removes the screenshot's unrelated ZeroRisk article from news, directions and HP pitches", () => {
    const result=monitoredAccountContext([{...event(7,
      "ZeroRisk Raises $4M from Elkstone for US Expansion | Startup.eu posted on the topic | LinkedIn — Global Vice President at Concentrix India & Southeast Asia"),
      sourceUrl:"https://www.linkedin.com/posts/zerorisk"}],now,{name:"Concentrix",domain:"concentrix.com",clientName:"HP"});
    expect(result.evidence).toEqual([]);
    expect(result.businessDirections).toEqual([]);
    expect(result.takeaways).toEqual([]);
  });
  it("interprets financial pressure and gives a conditional, cited services entry pitch without changing qualification", () => {
    const result=analyze("Acme India reported revenue down 5% and margin pressure in its quarterly earnings.");
    expect(result.businessDirections[0].direction).toContain("margin protection");
    expect(result.takeaways?.[0]).toMatchObject({category:"Business Services",evidenceIds:[1]});
    expect(result.takeaways?.[0].pitch).toContain("baseline assessment");
    expect(result.takeaways?.[0].takeaway).toContain("has not been established");
    expect(result.caution).toContain("Qualification scores and BI results are unchanged");
  });
  it("retains all four HP categories when each has a supporting operational fact", () => {
    const result=analyze("Acme India announced a new Pune office with new laptops and meeting rooms. Acme India also reported an endpoint security incident and plans a device lifecycle review.");
    expect(result.takeaways?.map(point=>point.category).sort()).toEqual(["Business Collaboration","Business Services","IT Hardware","Security"]);
    expect(result.takeaways?.every(point=>point.pitch&&point.evidenceIds.includes(1))).toBe(true);
  });
  it("uses cited saved analytical directions only when their factual quote survives attribution", () => {
    const excerpt="Acme India announced a consolidation of three local support teams under one operating model.";
    const result=monitoredAccountContext([{...event(1,excerpt),context:{opportunityBrief:{
      fitmentPolicyVersion:7,whyNow:excerpt,categoryConclusions:[],
      businessDirections:[
        {theme:"Operating-model integration",signal:"Three support teams will be consolidated.",direction:"Local service standards and supplier ownership may need harmonization; purchasing scope is unknown.",sourceQuote:excerpt,sourceUrls:["https://example.com/1"]},
        {theme:"Unverified hiring",signal:"Hiring 5,000 employees.",direction:"Buy 5,000 laptops.",sourceQuote:"Hiring 5,000 employees.",sourceUrls:["https://example.com/1"]},
      ],
    }}}],now,{name:"Acme",clientName:"HP"});
    expect(result.businessDirections.map(point=>point.theme)).toEqual(["Operating-model integration"]);
    expect(result.businessDirections[0].evidenceIds).toEqual([1]);
  });
  it("reports financial trajectory even without a product-fit conclusion", () => {
    const result = analyze("Acme India reported revenue growth in its financial results.");
    expect(result.businessDirections[0]).toMatchObject({ theme: "Financial trajectory", evidenceIds: [1] });
    expect(result.businessDirections[0].direction).toContain("investment flexibility");
    expect(result.takeaways).toEqual([]);
  });
  it("organizes concrete operational signals, deduplicates themes and retains supporting citations", () => {
    const result = analyze(
      "Acme India announced cost cutting and a new Pune office.",
      "Acme India announced a Hyderabad recruitment drive to expand local capacity.",
      "Acme India confirmed restructuring measures for operational efficiency.",
    );
    expect(result.businessDirections.map(point => point.theme)).toEqual(["Cost discipline", "Infrastructure & footprint", "Workforce scaling"]);
    expect(result.businessDirections[0].evidenceIds).toEqual([1, 3]);
    expect(result.businessDirections.every(point => point.evidenceIds.every(id => result.evidence.some(source => source.id === id)))).toBe(true);
  });
  it("does not turn contraction, denied M&A or hiring freezes into expansion predictions", () => {
    const result = analyze("Acme India denied acquisition plans and announced a hiring freeze.");
    expect(result.businessDirections).toEqual([]);
    expect(result.takeaways).toEqual([]);
  });
  it("preserves different financial directions within the same theme", () => {
    const result = analyze(
      "Acme India reported revenue growth in its financial results.",
      "Acme India reported revenue down 5% and margin pressure in its quarterly earnings.",
    );
    const financial = result.businessDirections.filter(point => point.theme === "Financial trajectory");
    expect(financial).toHaveLength(2);
    expect(financial[0]).toMatchObject({ evidenceIds: [1] });
    expect(financial[0].direction).toContain("investment flexibility");
    expect(financial[1]).toMatchObject({ evidenceIds: [2] });
    expect(financial[1].direction).toContain("margin protection");
  });
  it("keeps deduplicated directions attached to each contributing source", () => {
    const result = analyze(
      "Acme India announced cost cutting.",
      "Acme India confirmed restructuring measures for operational efficiency.",
    );
    expect(result.businessDirections).toHaveLength(1);
    expect(result.businessDirections[0].evidenceIds).toEqual([1, 2]);
    for (const source of result.evidence) {
      expect(source.businessDirections).toEqual(result.businessDirections);
    }
  });
  it("preserves distinct saved interpretations under the same theme", () => {
    const excerpts = [
      "Acme India announced consolidation of three support teams under one operating model.",
      "Acme India announced separation of its regional service operations into independent teams.",
    ];
    const result = monitoredAccountContext(excerpts.map((excerpt, index) => ({
      ...event(index + 1, excerpt), context: { opportunityBrief: {
        fitmentPolicyVersion: 7, whyNow: excerpt, categoryConclusions: [],
        businessDirections: [{
          theme: "Operating-model change",
          signal: index === 0 ? "Support teams will consolidate." : "Regional teams will separate.",
          direction: index === 0 ? "Validate shared service standards." : "Validate independent service ownership.",
          sourceQuote: excerpt, sourceUrls: [`https://example.com/${index + 1}`],
        }],
      } },
    })), now, { name: "Acme", clientName: "HP" });
    expect(result.businessDirections).toHaveLength(2);
    expect(result.businessDirections.map(point => point.evidenceIds)).toEqual([[1], [2]]);
  });
  it("keeps foreign and stale articles out of business direction and product pitches", () => {
    expect(analyze("Acme announced a new London office.").businessDirections).toEqual([]);
    const result = monitoredAccountContext([{ ...event(1, "Acme India announced cost cutting."),
      context: { publishedDate: "2025-01-01" } }], now, { name: "Acme", clientName: "HP" });
    expect(result.businessDirections).toEqual([]);
    expect(result.takeaways).toEqual([]);
  });
});
