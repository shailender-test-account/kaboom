import { describe, expect, it } from "vitest";
import { isHpClientName, recommendHpSolutions } from "../lib/hpSolutionFit";

describe("HP solution fit", () => {
  it("only recognizes HP client names", () => {
    expect(isHpClientName("HP")).toBe(true);
    expect(isHpClientName("HP India")).toBe(true);
    expect(isHpClientName("Hewlett Packard Enterprise Solutions")).toBe(true);
    expect(isHpClientName("Acme")).toBe(false);
  });

  it("ranks contact-center collaboration products without inventing broad PC demand", () => {
    const recommendations = recommendHpSolutions([
      { id: 1, text: "Launching a 200 person contact center with noise-cancelling headsets and shared VDI stations.", source: "public_event" },
      { id: 2, text: "The new customer service operation needs unified communications and call routing.", source: "questionnaire" },
    ]);
    expect(recommendations[0]).toEqual(expect.objectContaining({ name: "HP Poly Headsets", fit: "strong" }));
    expect(recommendations.map(item => item.name)).toContain("HP Thin Clients");
    expect(recommendations.map(item => item.name)).not.toContain("HP EliteBook AI Laptops");
  });

  it("does not turn generic funding into an HP product recommendation", () => {
    expect(recommendHpSolutions([{ id: 1, text: "The company raised Series B funding to accelerate growth." }])).toEqual([]);
  });

  it("ignores careers-page and no-vacancy boilerplate", () => {
    expect(recommendHpSolutions([
      { id: 1, text: "Search Jobs at Aditya Birla Group — Apply Online. There are currently no vacancies in this sector; submit your resume for future opportunities. Hiring Virtual Collaboration Video Bars." },
    ])).toEqual([]);
  });

  it("deduplicates repeated evidence before calculating fit strength", () => {
    const text = "The company is evaluating video conferencing for meeting rooms.";
    const recommendations = recommendHpSolutions([{ id: 1, text }, { id: 2, text }, { id: 3, text }]);
    const video = recommendations.find(item => item.name === "HP Poly Video Conferencing");
    expect(video?.evidence).toHaveLength(1);
    expect(video?.fit).toBe("exploratory");
  });
});