import { describe, expect, it } from "vitest";
import { buildDemoEngagement, DEMO_ENGAGEMENT_SCOPE, matchesDemoEngagement } from "./model";

describe("isolated demo engagement", () => {
  it("shows the same example only for the authorized account/contact scope", () => {
    const { tenantId, companyId, contactId } = DEMO_ENGAGEMENT_SCOPE;
    expect(matchesDemoEngagement(tenantId, { contactId })).toBe(true);
    expect(matchesDemoEngagement(tenantId, { companyId })).toBe(true);
    expect(matchesDemoEngagement(tenantId, { contactIds: [contactId] })).toBe(true);
    expect(matchesDemoEngagement(tenantId + 1, { contactId })).toBe(false);
    expect(matchesDemoEngagement(tenantId, { companyId: companyId + 1 })).toBe(false);
    expect(matchesDemoEngagement(tenantId, { contactId: contactId + 1, companyId })).toBe(false);
  });
  it("has 2–3 visits each month, cumulative per-action points and Advanced Engage", () => {
    const d = buildDemoEngagement(new Date("2026-10-15T12:00:00Z"));
    expect(d.months.map(m => m.count)).toEqual([2, 3, 2, 2]);
    expect(d.visits).toHaveLength(9);
    expect(d.total).toBe(495);
    expect(d.stage).toBe("Advanced Engage");
    expect(d.visits.flatMap(v => v.events).map(e => e.cumulative))
      .toEqual(d.visits.flatMap(v => v.events).map((_, i, all) => all.slice(0, i + 1).reduce((sum, e) => sum + e.points, 0)));
    expect(d.visits.every(v => v.points === 55 && v.events.length === 5)).toBe(true);
  });
  it("shows transparent recency and frequency weights with a reconciled weighted index", () => {
    const d = buildDemoEngagement(new Date("2026-10-15T12:00:00Z"));
    expect(d.frequencyWeight).toBeCloseTo(1 + 0.5 * Math.log(10));
    expect(d.visits[0].recencyWeight).toBeLessThan(d.lastVisit!.recencyWeight);
    expect(d.weightedIndex).toBe(Math.round(d.visits.reduce((s, v) => s + v.weighted, 0) * d.frequencyWeight));
    expect(d.lastVisit!.stageWeight).toBe(2.5);
  });
  it("does not fabricate future activity and handles year boundaries", () => {
    for (const current of ["2027-01-01T00:00:00Z", "2027-02-03T00:00:00Z"]) {
      const now = new Date(current);
      const d = buildDemoEngagement(now);
      expect(d.visits.every(v => v.events.every(e => e.at <= now))).toBe(true);
      expect(d.months.slice(0, 3).every(m => m.count >= 2 && m.count <= 3)).toBe(true);
    }
  });
});
