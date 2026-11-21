/** Presentation-only activity. Never write these events into CRM or analytics. */
export const DEMO_ENGAGEMENT_SCOPE = { tenantId: 1, contactId: 10646, companyId: 266742 };

export function matchesDemoEngagement(tenantId: number | undefined, target: {
  contactId?: number; companyId?: number; contactIds?: number[];
}) {
  if (tenantId !== DEMO_ENGAGEMENT_SCOPE.tenantId) return false;
  if (target.contactId !== undefined) return target.contactId === DEMO_ENGAGEMENT_SCOPE.contactId;
  if (target.companyId !== undefined) return target.companyId === DEMO_ENGAGEMENT_SCOPE.companyId;
  return target.contactIds?.includes(DEMO_ENGAGEMENT_SCOPE.contactId) ?? false;
}

const steps = [
  { kind: "Email click", detail: "HDFC insights email → Explore the AI readiness gap", points: 5 },
  { kind: "Journey landing", detail: "HDFC · Whitepaper-Banking Disruption-Overview", points: 10 },
  { kind: "Journey page view", detail: "HDFC · 8 Strategic Shifts for HDFC", points: 15 },
  { kind: "Solution page view", detail: "HDFC · How to solve the AI Readiness Gap-See Solutions", points: 20 },
  { kind: "Scroll depth", detail: "Scrolled 90% · How to solve the AI Readiness Gap-See Solutions · 2m 10s reading time", points: 5 },
];
export function buildDemoEngagement(now = new Date()) {
  const dates: Date[] = [];
  for (let offset = 3; offset >= 0; offset--) {
    const days = offset === 2 ? [4, 14, 24] : [2, 12];
    for (const day of days) {
      const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - offset, day, 4, 30));
      if (date.getTime() + (steps.length - 1) * 60_000 <= now.getTime()) dates.push(date);
    }
  }
  let cumulative = 0;
  const visits = dates.map((date, index) => {
    const stage = index === 0 ? "Aware" : index < 3 ? "Pre-Engage" : index < 5 ? "Engage" : "Advanced Engage";
    const stageWeight = index === 0 ? 1 : index < 3 ? 1.5 : index < 5 ? 2 : 2.5;
    const recencyDays = Math.max(0, (now.getTime() - date.getTime()) / 86_400_000);
    const recencyWeight = Math.exp(-0.033 * recencyDays);
    const events = steps.map((step, eventIndex) => {
      cumulative += step.points;
      return { ...step, cumulative, at: new Date(date.getTime() + eventIndex * 60_000) };
    });
    const points = events.reduce((sum, e) => sum + e.points, 0);
    return { date, stage, stageWeight, recencyDays, recencyWeight, events, points,
      cumulative, weighted: points * stageWeight * recencyWeight };
  });
  const frequencyWeight = 1 + 0.5 * Math.log(1 + dates.length);
  const months = new Map<string, number>();
  visits.forEach(v => {
    const month = v.date.toLocaleDateString("en-IN", { month: "short", year: "numeric", timeZone: "Asia/Kolkata" });
    months.set(month, (months.get(month) ?? 0) + 1);
  });
  return { visits, total: cumulative, stage: visits.at(-1)?.stage ?? "Aware",
    lastVisit: visits.at(-1), activeDays: dates.length, frequencyWeight,
    weightedIndex: Math.round(visits.reduce((sum, v) => sum + v.weighted, 0) * frequencyWeight),
    months: [...months].map(([month, count]) => ({ month, count })) };
}
