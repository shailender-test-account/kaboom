import { describe, expect, it } from "vitest";
import { relatedResearchLinks, validatedStrategicHypotheses, isCommercialPositioningOnly, hpDiscoveryCategory } from "../lib/researchStrategicHypotheses";
import { rebuildResearchOpportunityLocally } from "../lib/researchOpportunityInterpreter";
import { monitoredAccountContext } from "../lib/monitoredAccountContext";
import type { ProviderEvent } from "../lib/intentProviders";

const excerpt = "Concentrix India joins Credit & Collections Summit India 2026 as Silver Partner, speaking on intelligent collections.";
const sourceUrl = "https://example.com/india-summit";
const catalog = [{id: 1, name: "HP Poly headsets", category: "Business Collaboration", categoryId: 10, subcategory: null}];
const hypothesis = {
  category: "Business Collaboration", productId: 1, signal: "Concentrix is a summit partner.",
  direction: "It may be positioning its collections expertise to financial-services buyers.",
  rationale: "If collections operations rely on voice, reliable agent audio may help customer conversations; the workflow is unverified.",
  entryPitch: "Would a joint voice-workflow demonstration help your collections team engage the summit audience?",
  validationQuestions: ["Confirm session, audience and current voice workflow before proposing a pilot."],
  sourceUrl, sourceQuote: excerpt,
  supportingSources: [],
};
const evidence: ProviderEvent[] = [{
  companyName: "Concentrix", eventType: "partnership", occurredAt: "2026-10-28", excerpt, sourceUrl, confidence: 80,
  context: {country: "India", publishedDate: "2026-10-27"},
}];

describe("indirect research discovery hypotheses", () => {
  it("maps legacy catalog capabilities to HP discovery categories without recategorising products or awarding intent", () => {
    expect(hpDiscoveryCategory({name:"Room Video Systems",category:"Virtual Collaboration"})).toBe("Business Collaboration");
    expect(hpDiscoveryCategory({name:"HP Wolf Security",category:"Software & Services"})).toBe("Security");
    expect(hpDiscoveryCategory({name:"HP Managed Device Services",category:"Software & Services"})).toBe("Business Services");
    expect(hpDiscoveryCategory({name:"Data Migration Services",category:"Services"})).toBeNull();
    expect(hpDiscoveryCategory({name:"Unrelated software",category:"Software & Services"})).toBeNull();
    const legacy = [{...catalog[0],name:"Room Video Systems",category:"Virtual Collaboration"}];
    expect(validatedStrategicHypotheses([hypothesis],evidence,legacy)).toHaveLength(1);
    expect(legacy[0].category).toBe("Virtual Collaboration");
    expect(validatedStrategicHypotheses([{...hypothesis,category:"Security"}],evidence,legacy)).toHaveLength(0);
  });
  it("validates source anchors and uses canonical catalog names, not invented products", () => {
    const result = validatedStrategicHypotheses([{...hypothesis, productName: "Invented product"}], evidence, catalog);
    expect(result[0].productName).toBe("HP Poly headsets");
    expect(validatedStrategicHypotheses([{...hypothesis, sourceQuote: "Concentrix will buy 500 devices."}], evidence, catalog)).toEqual([]);
    expect(validatedStrategicHypotheses([{...hypothesis, sourceUrl: "https://other.example"}], evidence, catalog)).toEqual([]);
    expect(validatedStrategicHypotheses([{...hypothesis, category: "Security"}], evidence, catalog)).toEqual([]);
    expect(validatedStrategicHypotheses([{...hypothesis, productId: 999}], evidence, catalog)).toEqual([]);
  });
  it("persists and displays a useful sponsorship pitch while leaving every category Cold", () => {
    const brief = rebuildResearchOpportunityLocally({company: {name: "Concentrix"}, evidence, catalog, firstParty: [],
      storedBrief: {strategicHypotheses: [hypothesis], categoryConclusions: [{
        categoryId: 10, categoryName: "Business Collaboration", score: 90, tier: "warm", accountFit: 90,
        gaps: ["Improve contact centre voice collaboration"], opportunities: ["Upgrade headsets"],
        rationale: "Sponsor may want a voice workflow demonstration.", evidenceStrength: "business_trigger",
        recommendedProducts: [{productId: 1, name: "HP Poly headsets", rationale: "Support voice workflows"}],
        buyers: ["Operations"], sourceUrls: [sourceUrl],
      }]}});
    expect(brief?.strategicHypotheses).toHaveLength(1);
    expect(brief?.categoryConclusions.every(category => category.tier === "cold")).toBe(true);
    const context = monitoredAccountContext([{
      id: 1, excerpt, sourceUrl, occurredAt: "2026-10-28", eventType: "partnership", reviewStatus: "approved",
      context: {...evidence[0].context, opportunityBrief: brief},
    }], new Date("2026-10-29"), {name: "Concentrix", clientName: "HP"});
    // The accepted saved pitch takes precedence over generic fallback angles
    // for the same story. Retain this specific product hypothesis exactly once.
    expect(context.takeaways).toHaveLength(1);
    const productHypotheses = context.takeaways!.filter(point => point.product === "HP Poly headsets");
    expect(productHypotheses).toHaveLength(1);
    expect(productHypotheses[0]).toMatchObject({category: "Business Collaboration", pitch: hypothesis.entryPitch, evidenceIds: [1]});
    expect(productHypotheses[0].takeaway).toContain("not evidence of buying intent");
    // Without a saved pitch, retain the incoming source-grounded discovery
    // check and its explicit warning that no purchase requirement is established.
    const sourceOnlyContext = monitoredAccountContext([{
      id: 1, excerpt, sourceUrl, occurredAt: "2026-10-28", eventType: "partnership", reviewStatus: "approved",
      context: evidence[0].context,
    }], new Date("2026-10-29"), {name: "Concentrix", clientName: "HP"});
    const security = sourceOnlyContext.takeaways!.find(item => item.category === "Security");
    expect(security).toMatchObject({product: "HP Wolf Security", evidenceIds: [1]});
    expect(security!.takeaway).toContain("no endpoint gap, local rollout or purchase is established");
  });
  it("does not treat conference topics as an account's operational need", () => {
    expect(isCommercialPositioningOnly(excerpt)).toBe(true);
    expect(isCommercialPositioningOnly("Concentrix India is a summit sponsor discussing endpoint security.")).toBe(true);
    expect(isCommercialPositioningOnly("Concentrix India opened a new office and sponsors a summit.")).toBe(false);
  });
  it("selects bounded explicit agenda links, not arbitrary model URLs or unsafe schemes", () => {
    const html = `<a href="/agenda">Agenda</a><a href="javascript:alert(1)">Speaker</a>
      <a href="https://events.example/speakers">Speakers</a><a href="/agenda">Agenda</a>
      <a href="/contact">Contact</a><a href="/program.pdf">Program</a>
      <a href="/sponsors">Sponsors</a><a href="/attendees">Attendees</a>`;
    expect(relatedResearchLinks(html, sourceUrl)).toEqual([
      "https://example.com/agenda", "https://events.example/speakers", "https://example.com/sponsors",
    ]);
  });
});
