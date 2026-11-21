import { describe, expect, it } from "vitest";
import { deriveProductFitments } from "../lib/signalProductFit";
import { newContactCenterCapacity, workforceFacts, workforcePassageFacts } from "../lib/researchSourceFacts";
import { addGrowthOpportunityFit } from "../lib/researchEvidenceAutoReview";
import { reassessResearchFinding } from "../lib/researchFindingReassessment";
import { classifyResearchEvidence } from "../lib/researchIntentEvidence";

const catalog = [
  { id: 1, name: "Business Laptops", category: "IT Hardware", subcategory: null },
  { id: 2, name: "Poly Headsets", category: "Business Collaboration", subcategory: null },
  { id: 3, name: "Office Printers", category: "Printing", subcategory: null },
  { id: 4, name: "Engineering Workstations", category: "IT Hardware", subcategory: null },
  { id: 5, name: "Video Bars", category: "Business Collaboration", subcategory: null },
  { id: 6, name: "Earbuds", category: "Business Collaboration", subcategory: null },
];
const launch = "The company is launching a new contact center with 200 people in Bengaluru";
const cuts = "its retail division is cutting 2,000 jobs in Mumbai";
const mixed = `${launch}, while ${cuts}.`;
const fits = (text: string) => deriveProductFitments({ text, eventType: "layoffs" }, catalog);

describe("passage-scoped mixed workforce evidence", () => {
  it.each([
    mixed,
    `${launch}. Separately, ${cuts}.`,
    `${cuts}; ${launch}.`,
    `${launch}, whereas ${cuts}.`,
    `${launch}, but ${cuts}.`,
  ])("keeps a separately staffed launch despite cuts: %s", text => {
    const result = fits(text);
    expect(result.map(fit => fit.productId).sort()).toEqual([1, 2]);
    expect(result.every(fit => fit.level === "confirmed_need")).toBe(true);
    expect(result.find(fit => fit.productId === 2)?.points).toBe(70);
    expect(result[0].reason).toContain("200-person");
    expect(result[0].reason).toContain("Bengaluru");
    expect(result[0].reason).not.toContain("2,000");
    expect(classifyResearchEvidence({ eventType: "layoffs", excerpt: text,
      context: { aiReview: { fitments: result } } }).hotEligible).toBe(false);
  });

  it("retains the source passage, operation and location without claiming net growth", () => {
    expect(workforcePassageFacts(mixed)).toEqual([
      expect.objectContaining({ passage: launch, operation: "contact center", location: "Bengaluru",
        contraction: false, staffedCapacity: 200, growthHeadcount: 0 }),
      expect.objectContaining({ contraction: true, location: "Mumbai", staffedCapacity: 0, growthHeadcount: 0 }),
    ]);
    expect(workforceFacts(mixed)).toEqual({ contraction: true, growthHeadcount: 0 });
    expect(newContactCenterCapacity(mixed)).toBe(200);
  });

  it("recognizes local hiring even when another operation contracts", () => {
    const text = "The company is hiring 200 agents for its contact center in Bengaluru, while " + cuts;
    expect(workforceFacts(text)).toEqual({ contraction: true, growthHeadcount: 200 });
    expect(fits(text).map(fit => fit.productId).sort()).toEqual([1, 2]);
  });

  it.each([
    `${launch}. Its call center in Mumbai is cutting 100 jobs.`,
    `${launch}. Its retail division in Bengaluru is cutting 100 jobs.`,
  ])("requires independent location or operation, not both: %s", text => {
    expect(fits(text).map(fit => fit.productId).sort()).toEqual([1, 2]);
  });

  it("does not borrow scale, specialist product mentions or workforce growth from another site", () => {
    const text = "The company is hiring 5,000 office employees in Pune for engineering workstations. "
      + "The company is launching a new contact center with 20 people in Bengaluru. " + cuts;
    const result = fits(text);
    expect(result.find(fit => fit.productId === 2)?.points).toBe(32);
    expect(result.find(fit => fit.productId === 2)?.reason).toContain("20-person");
    // Workstations remain justified by their own hiring passage, not the center.
    expect(result.find(fit => fit.productId === 4)?.reason).toContain("Pune");
    expect(result.find(fit => fit.productId === 4)?.reason).not.toContain("Bengaluru");
    expect(fits("The company is hiring 500 office employees in Pune. A contact center operates in Bengaluru.")
      .map(fit => fit.productId)).toEqual([1]);
    expect(fits("The company is hiring 500 employees in Pune. A contact center operates in Bengaluru.")).toEqual([]);
  });

  it.each([true, false])("retains independent center and specialist needs regardless of passage order: %s", centerFirst => {
    const specialist = "The company is hiring 200 employees for engineering workstations in Pune.";
    const text = [centerFirst ? launch : specialist, centerFirst ? specialist : launch, cuts].join(". ");
    const result = fits(text);
    expect(result.map(fit => fit.productId).sort()).toEqual([1, 2, 4]);
    expect(result.find(fit => fit.productId === 2)?.reason).toContain("Bengaluru");
    expect(result.find(fit => fit.productId === 4)?.reason).toContain(specialist.slice(0, -1));
    expect(result.find(fit => fit.productId === 4)?.reason).not.toContain("Bengaluru");
    expect(result.find(fit => fit.productId === 4)?.points).toBe(fits(specialist)[0]?.points);
  });

  it("skips ineligible early growth passages without dropping later specialist evidence", () => {
    const text = "The company is hiring 500 office employees in Delhi. "
      + "The company is hiring 200 employees for engineering workstations in Pune. " + cuts;
    const fit = fits(text).find(fit => fit.productId === 4);
    expect(fit?.reason).toContain("200 people");
    expect(fit?.reason).toContain("Pune");
    expect(fit?.reason).not.toContain("Delhi");
  });

  it.each([
    "The company is launching a new contact center with 200 employees transferred from Mumbai to Bengaluru.",
    "The company is launching a new contact center with 200 people already employed in Bengaluru.",
    "The company is launching a new contact center with 200 existing staff in Bengaluru.",
    "The company is launching a new contact center with 200 people, cutting 100 jobs in Bengaluru.",
    "The company may launch a new contact center with 200 people in Bengaluru.",
    "The company is not launching a new contact center with 200 people in Bengaluru.",
    "The company is launching a new contact center with up to 200 people in Bengaluru.",
    "The company is launching a new contact center with $200 million in Bengaluru.",
    "The company is launching a new contact center with 200,000 square feet in Bengaluru.",
    "The company is launching a new contact center with 200% growth in Bengaluru.",
    "The company is launching a new contact center with 200 users in Bengaluru.",
    "The company is launching a new contact center in Bengaluru with 200 employees for Pune.",
    "The company is launching a new contact center in Bengaluru with an office hiring 200 employees.",
    "The company is launching a new contact center with 200 people in Bengaluru, while cutting 100 staff.",
    "The company is launching a new contact center with 200 people in Bengaluru. Its call center in Bengaluru is cutting 100 jobs.",
    "The company is launching a new contact center with 200 people in Bengaluru, while staff are transferred from another site.",
  ])("does not turn stock, transfers, ambiguity or invalid units into demand: %s", text => {
    expect(workforceFacts(text).growthHeadcount).toBe(0);
    expect(newContactCenterCapacity(text)).toBe(0);
    expect(fits(text)).toEqual([]);
  });

  it("keeps seats as staffed capacity rather than net hiring", () => {
    const text = "The company is opening a new contact center with 200 seats in Bengaluru. " + cuts;
    expect(newContactCenterCapacity(text)).toBe(200);
    expect(workforceFacts(text).growthHeadcount).toBe(0);
    expect(fits(text).map(fit => fit.productId).sort()).toEqual([1, 2]);
  });

  it("preserves supported fits through auto-review and reviewable reassessment", () => {
    const review = addGrowthOpportunityFit({
      evidenceId: 1, relevant: true, confidence: 90, signalType: "hiring", extractedSignal: mixed,
      rationale: "", inferredCategories: [], catalogProductIds: [],
    }, { id: 1, event_type: "hiring", excerpt: mixed, context: {} } as any, catalog);
    expect(review.signalType).toBe("layoffs");
    expect(review.catalogProductIds.sort()).toEqual([1, 2]);
    const proposal = reassessResearchFinding({
      id: 1, eventType: "hiring", excerpt: "An invented AI summary claims industrial printing demand",
      sourceUrl: "https://example.com/article", reviewStatus: "approved", productId: 3,
      context: { originalExcerpt: mixed, aiReview: { catalogProductIds: [3] } },
    }, catalog);
    expect(proposal.proposed).toMatchObject({
      eventType: "layoffs", disposition: "validate_category_need", requiresHumanReview: true, removedProductIds: [3],
    });
    expect(proposal.proposed.fitments.map(fit => fit.productId).sort()).toEqual([1, 2]);
  });
});
