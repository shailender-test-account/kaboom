import { describe, expect, it } from "vitest";
import { classifyResearchEvidence, normalizedResearchEvidenceKey, researchEvidenceHeat } from "../lib/researchIntentEvidence";

describe("research intent evidence gates", () => {
  it("keeps revenue growth and financial results as low business context", () => {
    const evidence = classifyResearchEvidence({
      eventType: "quarterly_financial",
      excerpt: "Revenue increased 16.35% and net profit rose during the quarter.",
    });
    expect(evidence).toMatchObject({ level: "business_trigger", points: 10, hotEligible: false });
    expect(researchEvidenceHeat({ rawScore: 100, directCount: 0, confirmedCount: 0, hotEligible: false }))
      .toEqual({ score: 20, tier: "cold" });
  });

  it("requires corroborated confirmed needs for Warm", () => {
    expect(researchEvidenceHeat({ rawScore: 80, directCount: 0, confirmedCount: 1, hotEligible: false }))
      .toEqual({ score: 39, tier: "cold" });
    expect(researchEvidenceHeat({ rawScore: 70, directCount: 0, confirmedCount: 2, hotEligible: false }))
      .toEqual({ score: 70, tier: "warm" });
  });

  it("allows explicit procurement evidence to become Hot", () => {
    const evidence = classifyResearchEvidence({
      eventType: "technology_integration",
      excerpt: "The company issued an RFP for a 500-device laptop refresh with delivery required this quarter.",
    });
    expect(evidence).toMatchObject({ level: "direct_intent", points: 70, hotEligible: true });
    expect(researchEvidenceHeat({ rawScore: evidence.points, directCount: 1, confirmedCount: 0, hotEligible: true }))
      .toEqual({ score: 70, tier: "hot" });
  });

  it("deduplicates tracking variants of the same source URL", () => {
    expect(normalizedResearchEvidenceKey({ sourceUrl: "https://example.com/news?id=1#top" }))
      .toBe(normalizedResearchEvidenceKey({ sourceUrl: "https://example.com/news?utm_source=x" }));
  });
});