import { describe, expect, it } from "vitest";
import { isIndiaCentricEvidence } from "../lib/researchOpportunityInterpreter";
import type { ProviderEvent } from "../lib/intentProviders";

function evidence(excerpt: string, context: Record<string, unknown> = {}): ProviderEvent {
  return {
    eventType: "capital_investment",
    occurredAt: "2026-09-21T00:00:00.000Z",
    excerpt,
    confidence: 80,
    context,
  };
}

describe("India-centric research evidence", () => {
  it("accepts news with an explicit India business implication", () => {
    expect(isIndiaCentricEvidence(evidence("The company opened a new manufacturing facility in Pune, Maharashtra."))).toBe(true);
  });

  it("rejects global news merely fetched by an India-scoped query", () => {
    expect(isIndiaCentricEvidence(evidence(
      "The company expanded its California headquarters.",
      { country: "India", query: "company expansion in India" },
    ))).toBe(false);
  });

  it("uses structured event geography when the excerpt omits the location", () => {
    expect(isIndiaCentricEvidence(evidence(
      "The company announced a major new investment.",
      { rawEvent: { affected_market: "India", city: "Bengaluru" } },
    ))).toBe(true);
  });
});