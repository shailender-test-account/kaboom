import type { Deal } from "@workspace/db";

export const opportunityStages = new Set(["proposal", "negotiation", "closed_won", "closed_lost"]);
export const outcomeStages = new Set(["closed_won", "closed_lost"]);
export const validCurrency = (v: unknown): v is string =>
  typeof v === "string" && Intl.supportedValuesOf("currency").includes(v.toUpperCase());
export const validDay = (v: unknown): v is string =>
  typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)
  && Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v;

const invalid = (message: string) => { throw Object.assign(new Error(message), { status: 422 }); };
// Only user-supplied facts are validated as required. Legacy gaps are not guessed or
// made mandatory by a harmless title/notes correction.
export function dealChanges(body: Record<string, any>, existing?: Deal): Record<string, any> {
  const changes = { ...body };
  if ("title" in changes) {
    changes.title = changes.title.trim();
    if (!changes.title || changes.title.length > 500) invalid("Deal name must contain 1–500 characters.");
  }
  for (const field of ["value", "bookedValue"]) {
    if (changes[field] != null && (!Number.isFinite(changes[field]) || changes[field] < 0
      || changes[field] > 9999999999.99 || Math.abs(changes[field] * 100 - Math.round(changes[field] * 100)) > 0.0001))
      invalid(`${field === "value" ? "Order value" : "Booked amount"} must be a nonnegative amount with at most two decimal places.`);
    if (changes[field] != null) changes[field] = String(changes[field]);
  }
  if (changes.currency != null) {
    if (!validCurrency(changes.currency)) invalid("Use an explicit valid currency code, for example INR or USD.");
    changes.currency = changes.currency.toUpperCase();
  }
  for (const field of ["actualOpportunityDate", "actualOutcomeDate"]) {
    if (changes[field] != null && !validDay(changes[field])) invalid("Actual dates must be valid calendar days (YYYY-MM-DD).");
  }
  if ("expectedCloseDate" in changes && changes.expectedCloseDate != null) {
    if (!Number.isFinite(Date.parse(changes.expectedCloseDate))) invalid("Expected close date must be a valid date.");
    changes.expectedCloseDate = new Date(changes.expectedCloseDate);
  }
  const stage = changes.stage ?? existing?.stage ?? "prospect";
  if (existing && changes.stage && changes.stage !== existing.stage) {
    if (!opportunityStages.has(stage)) {
      changes.opportunityConfirmed = false;
      changes.actualOpportunityDate = null;
    }
    // Changing an outcome or reopening requires a new explicit date and booked fact.
    if (!outcomeStages.has(stage) || outcomeStages.has(existing.stage)) {
      if (!("actualOutcomeDate" in body) || !outcomeStages.has(stage)) changes.actualOutcomeDate = null;
      if (!("bookedValue" in body) || stage !== "closed_won") changes.bookedValue = null;
    }
  }
  const merged = { ...existing, ...changes };
  if (body.opportunityConfirmed === true && (!opportunityStages.has(stage) || !merged.actualOpportunityDate))
    invalid("Confirm an opportunity only at Proposal or later and supply its actual opportunity date.");
  if (body.actualOutcomeDate != null && !outcomeStages.has(stage))
    invalid("An actual outcome date requires a Won or Lost stage.");
  if (body.bookedValue != null && stage !== "closed_won")
    invalid("Booked business requires the Won stage. Order value is not automatically booked revenue.");
  return changes;
}

export const dealJson = (deal: Deal) => ({
  ...deal, value: deal.value === null ? null : Number(deal.value),
  bookedValue: deal.bookedValue === null ? null : Number(deal.bookedValue),
});
