import { describe, expect, it } from "vitest";
import { monitoredAccountContext, type MonitoringFinding } from "../lib/monitoredAccountContext";

const now = new Date("2026-10-15T12:00:00Z");
const office: MonitoringFinding = {
  id: 1, excerpt: "D. E. Shaw India announced a new Hyderabad office expected to open in 2027, adding more than 600,000 square feet of workspace.",
  sourceUrl: "https://example.com/announcement", occurredAt: "2026-10-08T19:00:00Z",
  eventType: "branch_opening", reviewStatus: "approved", context: {},
};
describe("non-scoring monitored account context", () => {
  it("preserves the source fact and describes an expansion without declaring products or buying intent", () => {
    const result = monitoredAccountContext([office], now);
    expect(result.kind).toBe("expansion");
    expect(result.summary).toBe(office.excerpt);
    expect(result.nextAction).toContain("procurement owners");
    expect(result.evidence[0].sourceUrl).toBe(office.sourceUrl);
    expect(result.caution).toContain("Qualification scores and BI results are unchanged");
    expect(JSON.stringify(result)).not.toMatch(/3D|digital press|Hot|Warm/);
  });
  it("does not treat pending, rejected, stale, future or non-India findings as relevant", () => {
    for (const patch of [
      { reviewStatus: "pending" }, { reviewStatus: "rejected" },
      { occurredAt: "2026-01-01" }, { occurredAt: "2027-01-01" },
      { excerpt: "New London office announced." },
      { excerpt: "India growth", context: { aiReview: {}, originalExcerpt: "Global revenue increased." } },
    ]) {
      expect(monitoredAccountContext([{ ...office, ...patch }], now)).toMatchObject({
        kind: "no_recent_findings", evidence: [], possibleNeeds: [],
      });
    }
  });
  it("keeps ordinary relevant context distinct from expansion", () => {
    expect(monitoredAccountContext([{ ...office, excerpt: "Hyderabad operations published financial results." }], now))
      .toMatchObject({ kind: "business_context", possibleNeeds: [] });
  });
  it("rejects the repeated Concentrix case-study menu and unrelated customer news", () => {
    const menu = "Concentrix India: Building the Foundation for a Scalable Technology Center — Learn More | Case Study #### Achieving a $2M Boost — Learn More | Case Study #### MotoNovo shifts customers — Learn More";
    const other = "MotoNovo India announced a new Hyderabad office in 2026.";
    const identity = { name: "Concentrix", domain: "concentrix.com" };
    expect(monitoredAccountContext([{ ...office, excerpt: menu }], now, identity).evidence).toEqual([]);
    expect(monitoredAccountContext([{ ...office, excerpt: other }], now, identity).evidence).toEqual([]);
    expect(monitoredAccountContext([{ ...office, sourceUrl: "https://concentrix.com/case-studies/customer",
      excerpt: other }], now, identity).evidence).toEqual([]);
    expect(monitoredAccountContext([{ ...office, excerpt: "Concentrix revenue increased globally. An unrelated India company expanded." }], now, identity).evidence).toEqual([]);
  });
  it("deduplicates syndicated events, retains source publication dates and prioritizes latest publications", () => {
    const old = { ...office, context: { publishedDate: "2026-09-01" } };
    const recent = { ...office, id: 2, sourceUrl: "https://example.com/results",
      excerpt: "Concentrix India reported its quarterly financial results and increased revenue.",
      context: { publishedDate: "2026-10-10" } };
    const syndicated = { ...recent, id: 3, sourceUrl: "https://syndication.example/results?utm_source=x" };
    const result = monitoredAccountContext([old, recent, syndicated], now);
    expect(result.evidence).toHaveLength(2);
    expect(result.evidence[0]).toMatchObject({ id: 2, publishedAt: "2026-10-10T00:00:00.000Z" });
    expect(result.summary).toBe(recent.excerpt);
    expect(result.analysisPoints[1]).toContain("not established");
    expect(result.analysisPoints[2]).toContain("Owner: not confirmed");
  });
  it("does not relabel old articles as fresh on retrieval or trust rewritten company attribution", () => {
    expect(monitoredAccountContext([{ ...office, context: { publishedDate: "2025-01-01" } }], now).evidence).toEqual([]);
    expect(monitoredAccountContext([{ ...office, excerpt: "Concentrix India expanded.",
      raw_evidence: { excerpt: "Another company in India expanded.", context: {} } }], now, { name: "Concentrix" }).evidence).toEqual([]);
    const result = monitoredAccountContext([office], now);
    expect(result.evidence[0].publishedAt).toBeNull();
    expect(result.analysisPoints[2]).toContain("Publication date unverified");
    expect(result.analysisPoints[2]).toContain("600,000 square feet");
    expect(result.analysisPoints[2]).toContain("2027");
  });
  it("respects an explicitly selected non-India geography rather than imposing India", () => {
    const result = monitoredAccountContext([{ ...office, excerpt: "Concentrix announced a new London office in 2027.",
      context: { scope: { country: "United Kingdom" } } }], now, { name: "Concentrix" });
    expect(result.evidence).toHaveLength(1);
    expect(result.analysisPoints[0]).toContain("United Kingdom");
  });
});
