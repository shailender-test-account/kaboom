import { describe, expect, it } from "vitest";
import { isRelevantCatalystText, isRelevantOpportunityBrief } from "../lib/researchOpportunityInterpreter";

describe("research opportunity catalyst relevance", () => {
  it("rejects careers and no-vacancy boilerplate", () => {
    expect(isRelevantCatalystText("Search Jobs — Apply Online. There are currently no vacancies; submit your resume for future opportunities.")).toBe(false);
    expect(isRelevantOpportunityBrief({ whyNow: "Search jobs and apply online; there are no vacancies." })).toBe(false);
  });

  it("keeps concrete business catalysts", () => {
    expect(isRelevantCatalystText("The company issued an RFP for 500 business laptops with delivery required this quarter.")).toBe(true);
  });
  it("rejects scraped case-study menus from both new and stored interpretations", () => {
    const text = "Building the Foundation for a Scalable India Technology Center — Learn More | Case Study #### MotoNovo shifts customers to Digital Payments — Learn More";
    expect(isRelevantCatalystText(text)).toBe(false);
    expect(isRelevantOpportunityBrief({ whyNow: text })).toBe(false);
  });
});