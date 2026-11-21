/**
 * Geography is evidence, not a search setting or an AI conclusion.
 * Keep this allowlist narrow: never serialize arbitrary provider/context objects.
 */
const INDIA_LOCATION = /\b(india|indian|bharat|new delhi|delhi|mumbai|bombay|bengaluru|bangalore|hyderabad|chennai|kolkata|calcutta|pune|ahmedabad|gurugram|gurgaon|noida|jaipur|lucknow|kochi|cochin|thiruvananthapuram|chandigarh|gujarat|maharashtra|karnataka|tamil nadu|telangana|west bengal|uttar pradesh|madhya pradesh|rajasthan|kerala|odisha|punjab|haryana|assam|jharkhand|chhattisgarh|goa)\b/i;

type Evidence = {
  excerpt?: string | null;
  context?: Record<string, unknown> | null;
  raw_evidence?: unknown;
  companyName?: string | null;
  company_name?: string | null;
  account_name?: string | null;
};
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown) => typeof value === "string" ? value : "";

export function researchCountry(row: Evidence, requestedCountry?: string): string {
  const context = row.context ?? {};
  return requestedCountry?.trim() || text(object(context.scope).country) || text(context.country) || "India";
}

export function isIndiaCentricEvidence<T extends Evidence>(row: T): boolean {
  const context = row.context ?? {};
  const original = object(row.raw_evidence);
  const sourceContext = Object.keys(original).length ? object(original.context) : context;
  // Review rewrites excerpt; the preserved original must take precedence.
  const excerpt = text(original.excerpt) || text(context.originalExcerpt) ||
    (context.aiReview ? "" : text(row.excerpt));
  const event = object(sourceContext.rawEvent);
  const data = object(event.data);
  const sourceValues = [
    excerpt, text(sourceContext.sourceTitle),
    ...[event, data].flatMap(value =>
      ["description", "headline", "title", "affected_market", "event_location", "city", "location", "market"]
        .map(key => text(value[key]))),
  ];
  let sourceText = sourceValues.join(" ");
  const companyName = row.companyName || row.company_name || row.account_name || text(original.companyName);
  if (companyName && INDIA_LOCATION.test(companyName)) {
    sourceText = sourceText.replace(new RegExp(companyName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), "");
  }
  return INDIA_LOCATION.test(sourceText);
}

export function isResearchGeographyEligible<T extends Evidence>(row: T, requestedCountry?: string): boolean {
  const country = researchCountry(row, requestedCountry);
  // Global research retains its existing non-geographic eligibility rules.
  return country.toLowerCase() !== "india" || isIndiaCentricEvidence(row);
}

export function researchGeographyAssessment(row: Evidence, requestedCountry?: string) {
  const country = researchCountry(row, requestedCountry);
  const eligible = isResearchGeographyEligible(row, requestedCountry);
  return {
    country, eligible, basis: "original_source_only",
    reason: eligible ? "Source meets the selected research geography rules."
      : "No explicit India operation, market or location is established by the original source. Retained for audit; excluded from intent.",
  };
}
