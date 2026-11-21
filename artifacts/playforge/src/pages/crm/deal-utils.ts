import type { CreateDealBody, Deal, UpdateDealBody } from "@workspace/api-client-react";

export const STAGES = [
  { key: "prospect", label: "Prospect", color: "bg-gray-50 border-gray-200" },
  { key: "qualified", label: "Qualified", color: "bg-blue-50 border-blue-200" },
  { key: "proposal", label: "Proposal", color: "bg-yellow-50 border-yellow-200" },
  { key: "negotiation", label: "Negotiation", color: "bg-orange-50 border-orange-200" },
  { key: "closed_won", label: "Won", color: "bg-green-50 border-green-200" },
  { key: "closed_lost", label: "Lost", color: "bg-red-50 border-red-200" },
] as const;

export type StageKey = (typeof STAGES)[number]["key"];
export const OPPORTUNITY_STAGES: string[] = ["proposal", "negotiation", "closed_won", "closed_lost"];
export const CLOSED_STAGES: string[] = ["closed_won", "closed_lost"];
export const stageLabel = (k: string) => STAGES.find(s => s.key === k)?.label ?? k;

export const MEANING_LABEL: Record<string, string> = {
  unknown: "Meaning unknown",
  prospective: "Prospective value",
  total_order_value: "Total order value",
};

export interface DealForm {
  title: string; clientId: string; stage: string; priority: string;
  value: string; currency: string; valueMeaning: string; bookedValue: string;
  opportunityConfirmed: boolean; actualOpportunityDate: string; actualOutcomeDate: string;
  expectedCloseDate: string; notes: string;
  companyId: number | null; contactId: number | null;
}

export function formFromDeal(d: Deal): DealForm {
  return {
    title: d.title, clientId: String(d.clientId), stage: d.stage, priority: d.priority,
    value: d.value == null ? "" : String(d.value), currency: d.currency ?? "",
    valueMeaning: d.valueMeaning ?? "unknown",
    bookedValue: d.bookedValue == null ? "" : String(d.bookedValue),
    opportunityConfirmed: !!d.opportunityConfirmed,
    actualOpportunityDate: d.actualOpportunityDate ?? "", actualOutcomeDate: d.actualOutcomeDate ?? "",
    expectedCloseDate: d.expectedCloseDate ? d.expectedCloseDate.slice(0, 10) : "",
    notes: d.notes ?? "", companyId: d.companyId ?? null, contactId: d.contactId ?? null,
  };
}

export const emptyForm = (): DealForm => ({
  title: "", clientId: "", stage: "prospect", priority: "medium", value: "", currency: "",
  valueMeaning: "unknown", bookedValue: "", opportunityConfirmed: false,
  actualOpportunityDate: "", actualOutcomeDate: "", expectedCloseDate: "", notes: "",
  companyId: null, contactId: null,
});

/** True when moving between stages makes the server discard the previous outcome facts. */
export function clearsOutcome(from: string, to: string): boolean {
  if (from === to) return false;
  const fromClosed = CLOSED_STAGES.includes(from), toClosed = CLOSED_STAGES.includes(to);
  return (fromClosed && !toClosed) || (fromClosed && toClosed);
}

/** Apply a stage change to the form without leaking stale outcome facts or confirmation. */
export function applyStage(form: DealForm, original: DealForm | null, stage: string): DealForm {
  const next = { ...form, stage };
  const base = original ?? emptyForm();
  if (stage === base.stage) {
    // reverting to the saved stage restores saved facts
    return { ...next, actualOutcomeDate: base.actualOutcomeDate, bookedValue: base.bookedValue,
      opportunityConfirmed: base.opportunityConfirmed, actualOpportunityDate: base.actualOpportunityDate };
  }
  if (!CLOSED_STAGES.includes(stage) || CLOSED_STAGES.includes(base.stage)) {
    next.actualOutcomeDate = "";
    next.bookedValue = "";
  }
  if (!OPPORTUNITY_STAGES.includes(stage)) {
    next.opportunityConfirmed = false;
    next.actualOpportunityDate = "";
  }
  return next;
}

const isDay = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));

export function validateForm(f: DealForm, isNew: boolean): string[] {
  const e: string[] = [];
  if (!f.title.trim()) e.push("Deal name is required.");
  if (isNew && !f.clientId) e.push("Choose a client. It cannot be changed later.");
  if (f.value.trim() !== "" && (!Number.isFinite(Number(f.value)) || Number(f.value) < 0)) e.push("Value must be a number of 0 or more.");
  if (f.bookedValue.trim() !== "" && (!Number.isFinite(Number(f.bookedValue)) || Number(f.bookedValue) < 0)) e.push("Booked value must be a number of 0 or more.");
  if (f.currency.trim() !== "" && !/^[A-Za-z]{3}$/.test(f.currency.trim())) e.push("Currency must be a 3-letter code such as INR, EUR or USD.");
  if (f.actualOpportunityDate && !isDay(f.actualOpportunityDate)) e.push("Actual opportunity date must be a calendar day.");
  if (f.actualOutcomeDate && !isDay(f.actualOutcomeDate)) e.push("Actual outcome date must be a calendar day.");
  if (f.opportunityConfirmed) {
    if (!OPPORTUNITY_STAGES.includes(f.stage)) e.push("A confirmed opportunity needs stage Proposal, Negotiation, Won or Lost.");
    if (!f.actualOpportunityDate) e.push("A confirmed opportunity needs the actual opportunity date.");
  }
  if (f.actualOutcomeDate && !CLOSED_STAGES.includes(f.stage)) e.push("An outcome date only applies to Won or Lost deals.");
  if (f.bookedValue.trim() !== "" && f.stage !== "closed_won") e.push("Booked value only applies to Won deals.");
  return e;
}

/** Reporting gaps shown as non-blocking guidance: saving incomplete deals stays allowed. */
export function reportingGaps(f: DealForm): string[] {
  const g: string[] = [];
  if (f.value.trim() !== "" && !f.currency.trim()) g.push("Amount has no currency, so it stays unlabelled and is excluded from HP money totals.");
  if (f.value.trim() !== "" && f.valueMeaning === "unknown") g.push("Value meaning is unknown, so it will not count as prospective value or Total Order Value.");
  if (!f.companyId) g.push("No linked account, so HP reports cannot attribute this deal.");
  if (OPPORTUNITY_STAGES.includes(f.stage) && !(f.opportunityConfirmed && f.actualOpportunityDate)) g.push("Opportunity is not confirmed with an actual opportunity date; stage alone does not count.");
  if (CLOSED_STAGES.includes(f.stage) && !f.actualOutcomeDate) g.push("Outcome has no actual outcome date, so the result is incomplete in reports.");
  if (f.stage === "closed_won" && f.bookedValue.trim() === "") g.push("No booked value entered; booked business stays empty.");
  return g;
}

const num = (s: string) => (s.trim() === "" ? null : Number(s));
const iso = (day: string) => (day ? `${day}T00:00:00.000Z` : null);

export function buildCreate(f: DealForm): CreateDealBody {
  return {
    clientId: Number(f.clientId), title: f.title.trim(), stage: f.stage as CreateDealBody["stage"],
    priority: f.priority as CreateDealBody["priority"],
    companyId: f.companyId, contactId: f.contactId,
    value: num(f.value), currency: f.currency.trim() ? f.currency.trim().toUpperCase() : null,
    valueMeaning: f.valueMeaning as CreateDealBody["valueMeaning"], bookedValue: num(f.bookedValue),
    opportunityConfirmed: f.opportunityConfirmed,
    actualOpportunityDate: f.actualOpportunityDate || null, actualOutcomeDate: f.actualOutcomeDate || null,
    expectedCloseDate: iso(f.expectedCloseDate), notes: f.notes.trim() || null,
  };
}

/** Sends only fields the user changed so legacy incomplete deals are never rewritten and old outcome facts are never resent. */
export function buildUpdate(f: DealForm, o: DealForm): UpdateDealBody {
  const b: UpdateDealBody = {};
  if (f.title.trim() !== o.title) b.title = f.title.trim();
  if (f.stage !== o.stage) b.stage = f.stage as UpdateDealBody["stage"];
  if (f.priority !== o.priority) b.priority = f.priority as UpdateDealBody["priority"];
  if (f.companyId !== o.companyId) b.companyId = f.companyId;
  if (f.contactId !== o.contactId) b.contactId = f.contactId;
  if (f.value.trim() !== o.value.trim()) b.value = num(f.value);
  if (f.currency.trim().toUpperCase() !== o.currency.trim().toUpperCase()) b.currency = f.currency.trim() ? f.currency.trim().toUpperCase() : null;
  if (f.valueMeaning !== o.valueMeaning) b.valueMeaning = f.valueMeaning as UpdateDealBody["valueMeaning"];
  if (f.bookedValue.trim() !== o.bookedValue.trim()) b.bookedValue = num(f.bookedValue);
  if (f.opportunityConfirmed !== o.opportunityConfirmed) b.opportunityConfirmed = f.opportunityConfirmed;
  if (f.actualOpportunityDate !== o.actualOpportunityDate) b.actualOpportunityDate = f.actualOpportunityDate || null;
  if (f.actualOutcomeDate !== o.actualOutcomeDate) b.actualOutcomeDate = f.actualOutcomeDate || null;
  if (f.expectedCloseDate !== o.expectedCloseDate) b.expectedCloseDate = iso(f.expectedCloseDate);
  if (f.notes.trim() !== o.notes.trim()) b.notes = f.notes.trim() || null;
  return b;
}

const nf = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 });
export function formatAmount(value: number | null | undefined, currency: string | null | undefined): string {
  if (value == null) return "No amount";
  return `${currency ? currency.toUpperCase() : "Currency unknown"} ${nf.format(value)}`;
}

export interface Subtotal { key: string; label: string; amount: number; count: number; kind: "unknown" | "prospective" | "total_order_value" | "booked" }

/** Group by currency and meaning; never mixes either. Zero amounts are kept. */
export function subtotals(deals: Deal[]): Subtotal[] {
  const m = new Map<string, Subtotal>();
  const add = (kind: Subtotal["kind"], cur: string | null | undefined, amt: number) => {
    const c = cur ? cur.toUpperCase() : "unknown currency";
    const key = `${kind}|${c}`;
    const lab = { unknown: "meaning unknown", prospective: "prospective", total_order_value: "total order value", booked: "booked" }[kind];
    const s = m.get(key) ?? { key, label: `${c} ${lab}`, amount: 0, count: 0, kind };
    s.amount += amt; s.count += 1; m.set(key, s);
  };
  for (const d of deals) {
    if (d.value != null) add((d.valueMeaning ?? "unknown") as Subtotal["kind"], d.currency, d.value);
    if (d.bookedValue != null) add("booked", d.currency, d.bookedValue);
  }
  return [...m.values()].sort((a, b) => a.key.localeCompare(b.key));
}

export function dealErrorMessage(err: unknown, fallback: string): string {
  const m = err instanceof Error ? err.message : "";
  return m ? `${m}. Check the highlighted fields and try again.` : fallback;
}
