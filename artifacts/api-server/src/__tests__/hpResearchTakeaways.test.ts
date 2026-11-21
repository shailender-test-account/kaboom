import { describe, expect, it } from "vitest";
import { monitoredAccountContext } from "../lib/monitoredAccountContext";
import { RESEARCH_FITMENT_POLICY_VERSION } from "../lib/researchOpportunityInterpreter";

const now = new Date("2026-10-29");
const finding = (excerpt: string, id = 1, country = "India") => ({
  id, excerpt, sourceUrl: `https://example.com/news/${id}`, occurredAt: "2026-10-28",
  reviewStatus: "approved", eventType: "company_news",
  context: { scope: { country }, publishedDate: "2026-10-27" },
});
const context = (text: string, country = "India") => monitoredAccountContext([finding(text, 1, country)], now, { name: "Concentrix", clientName: "HP" });
describe("HP source-backed solution takeaways", () => {
  it("provides actionable product-specific hypotheses instead of repeating news, with validated citations", () => {
    const result = context("Concentrix India announced a new Hyderabad office for 600 employees in 2027.");
    expect(result.takeaways!.map(item => item.category)).toEqual(["IT Hardware", "Business Collaboration", "Business Services"]);
    expect(result.takeaways!.map(item => item.product).join(" ")).toContain("HP Device as a Service");
    expect(result.takeaways![0].takeaway).not.toContain("Concentrix India announced");
    expect(result.validationSummary).toContain("600 employees");
    expect(result.validationSummary).toContain("2027");
    expect(result.validationSummary).toContain("not an order quantity");
    expect(result.takeaways!.every(item => item.evidenceIds[0] === result.evidence[0].id)).toBe(true);
    expect(result.takeaways!.some(item => item.category === "Security")).toBe(false);
  });
  it("does not infer solution demand from revenue, foreign events or customer-story indexes", () => {
    for (const text of [
      "Concentrix India reported revenue growth.",
      "Concentrix announced a new US office.",
      "Concentrix India Case Study #### Learn More about new office upgrades.",
    ]) expect(context(text).takeaways).toEqual([]);
  });
  it("separates business direction from a conditional HP pitch without treating it as intent", () => {
    const result = context("Concentrix India announced cost reduction and an acquisition of a local operation.");
    expect(result.businessDirections.map(point => point.theme)).toEqual(["Cost discipline", "Mergers & acquisitions"]);
    expect(result.takeaways).toHaveLength(1);
    expect(result.takeaways![0].takeaway).toContain("if device support or fragmented fleets");
    expect(result.takeaways![0].pitch).toContain("baseline-cost assessment");
    expect(result.caution).toContain("not confirmed buying intent");
  });
  it("separates security and explicit device lifecycle signals without inventing adjacent categories", () => {
    expect(context("Concentrix India reported a ransomware attack affecting local operations.").takeaways!.map(item => item.category)).toEqual(["Security"]);
    expect(context("Concentrix India is evaluating device as a service for managed endpoints.").takeaways!.map(item => item.category)).toEqual(["Business Services"]);
  });
  it("uses the latest published attributable event, deduplicates product angles, honors another monitored country", () => {
    const result = monitoredAccountContext([
      { ...finding("Concentrix India announced a new Hyderabad office.", 1), context: { publishedDate: "2026-10-01" } },
      finding("Concentrix India announced a new Pune office for 200 employees in 2027.", 2),
    ], now, { name: "Concentrix", clientName: "HP" });
    expect(result.takeaways).toHaveLength(3);
    expect(result.takeaways![0].evidenceIds).toEqual([2]);
    expect(context("Concentrix announced a new London office in 2027.", "United Kingdom").takeaways![0].takeaway).toContain("United Kingdom");
  });
  it("does not impose HP's portfolio on accounts belonging to another client", () => {
    expect(monitoredAccountContext([finding("Concentrix India announced a new Hyderabad office.")], now,
      { name: "Concentrix", clientName: "Another vendor" }).takeaways).toBeUndefined();
  });
  it("prefers specific saved catalog analysis only when its source survives validation and matches the citation", () => {
    const event = finding("Concentrix India is evaluating device lifecycle support for its local operations.");
    const brief = {
      fitmentPolicyVersion: RESEARCH_FITMENT_POLICY_VERSION,
      whyNow: "A specific India device lifecycle requirement needs validation.",
      categoryConclusions: [{ categoryName: "Business Services", tier: "warm",
        recommendedProducts: [{ productId: 31, name: "Device as a Service", rationale: "A managed lifecycle could address the reported local support gap." }],
        sourceUrls: [event.sourceUrl], gaps: ["the current support contract expiry"] }],
    };
    const run = (sourceUrl: string) => monitoredAccountContext([{ ...event,
      context: { ...event.context, opportunityBrief: { ...brief,
        categoryConclusions: brief.categoryConclusions.map(item => ({ ...item, sourceUrls: [sourceUrl] })) } },
    }], now, { name: "Concentrix", clientName: "HP" });
    expect(run(event.sourceUrl).takeaways![0]).toMatchObject({
      product: "Device as a Service", evidenceIds: [1],
      recommendation: "Validate the current support contract expiry before proposing Device as a Service.",
    });
    expect(run("https://another.example/news").takeaways![0].product).toBe("HP Device as a Service / lifecycle services");
  });
});
