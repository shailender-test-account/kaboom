/** HP priority is separate from historical BI leads and stored engagement points. */
export type Heat = "Hot" | "Warm" | "Cold";
export interface PriorityForm {
  accountId: number; contactId: number | null; product: string; months: number | null;
  at: string; reference: string;
  overrides?: Record<string, unknown> | null;
}
export interface PriorityActivity {
  accountId: number; contactId: number; stage: string; at: string;
}
export interface PrioritySignal {
  accountId: number; heat: Heat; at: string; url: string; products: string[];
}
export interface AccountPriority {
  score: number; status: Heat; declaredQualification: Heat; needsReconfirmation: boolean;
  forms: number; journey: number; monitoring: number; calculatedAt: string; nextReviewAt: string | null;
  warmForm: boolean;
  routing: { status: "Not eligible" | "Needs attention" | "Ready" | "Active"; reason: string; journeys: string[] };
}
const DAY = 86400000;
export function freshness(at: string, graceDays: number, halfLifeDays: number, now: Date) {
  const age = (now.getTime() - Date.parse(at)) / DAY;
  return !Number.isFinite(age) || age < 0 ? 0 : 2 ** (-Math.max(0, age - graceDays) / halfLifeDays);
}
export function purchaseWindowEnd(form: PriorityForm) {
  const date = new Date(form.at);
  if (!Number.isFinite(date.getTime()) || form.months === null || !Number.isFinite(form.months) || form.months < 0) return null;
  if (form.months === 0) return new Date(date.getTime() + 30 * DAY);
  const day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + Math.ceil(form.months));
  const last = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, last));
  return date;
}
export function formState(form: PriorityForm, now: Date) {
  const expiry = purchaseWindowEnd(form);
  const base = form.product.trim() && form.months !== null && form.months >= 0
    ? form.months <= 3 ? 100 : form.months <= 6 ? 70 : 0 : 0;
  const factor = freshness(form.at, 30, 60, now);
  const expired = Boolean(base && expiry && now > expiry);
  // Expired declarations remain historical context, not current purchase evidence.
  return { value: base * factor, explicit: Boolean(base === 100 && !expired && factor === 1),
    expired, current: !expired && factor > 0, expiry };
}
export function calculateAccountPriority(forms: PriorityForm[], activities: PriorityActivity[], signals: PrioritySignal[], now = new Date()): AccountPriority {
  const states = forms.map(form => formState(form, now));
  const rawForm = Math.max(0, ...states.map(s => s.value));
  const currentForm = Math.max(0, ...states.filter(s => s.current).map(s => s.value)) * .65;
  const declaredQualification: Heat = states.some(s => s.explicit) ? "Hot" : currentForm >= 35 ? "Warm" : "Cold";
  const stages: Record<string, number> = { aware: 20, "pre-engage": 40, engage: 60, "advance-engage": 85, action: 100 };
  const people = new Map<number, number>();
  for (const activity of activities) people.set(activity.contactId, Math.max(people.get(activity.contactId) ?? 0,
    (stages[activity.stage] ?? 0) * freshness(activity.at, 14, 30, now)));
  const values = [...people.values()].filter(v => v > 0).sort((a, b) => b - a);
  // Breadth bonus also decays; inactive historical contacts cannot inflate it.
  const rawJourney = Math.min(100, (values[0] ?? 0) + values.slice(1, 4).reduce((sum, v) => sum + v * .1, 0));
  const rawMonitoring = Math.max(0, ...signals.map(s =>
    (s.heat === "Hot" ? 100 : s.heat === "Warm" ? 70 : 0) * freshness(s.at, 0, 30, now)));
  const formsPart = rawForm * .65, journeyPart = rawJourney * .25, monitoringPart = rawMonitoring * .1;
  const exact = formsPart + journeyPart + monitoringPart;
  const status: Heat = exact >= 65 && states.some(s => s.explicit) ? "Hot" : exact >= 35 ? "Warm" : "Cold";
  const next = forms.flatMap((form, i) => {
    if (!states[i].value) return [];
    return [new Date(Date.parse(form.at) + 30 * DAY), states[i].expiry].filter((d): d is Date => !!d && d > now);
  }).sort((a, b) => a.getTime() - b.getTime())[0];
  // Never display a threshold-crossing rounded score while retaining a colder band.
  const round = (n: number) => Math.floor((n + 1e-9) * 10) / 10;
  const warmForm = declaredQualification === "Warm";
  return { score: round(exact), status, declaredQualification,
    needsReconfirmation: states.some(s => s.expired) && !states.some(s => s.current && s.value > 0),
    forms: round(formsPart), journey: round(journeyPart), monitoring: round(monitoringPart),
    calculatedAt: now.toISOString(), nextReviewAt: new Date(Math.min(next?.getTime() ?? Infinity, now.getTime() + DAY)).toISOString(), warmForm,
    routing: { status: warmForm || status === "Warm" ? "Needs attention" : "Not eligible",
      reason: warmForm || status === "Warm" ? "No approved matching journey or eligible contact." : "Neither current form qualification nor overall status is Warm.",
      journeys: [] } };
}
