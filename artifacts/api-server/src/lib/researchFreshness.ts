export const PUBLIC_RESEARCH_WINDOW_MONTHS = 3;

export function publicResearchCutoff(now = new Date()) {
  const cutoff = new Date(now);
  cutoff.setMonth(cutoff.getMonth() - PUBLIC_RESEARCH_WINDOW_MONTHS);
  return cutoff;
}

export function isFreshPublicResearchEvidence(
  text: string | null | undefined,
  occurredAt: Date | string,
  now = new Date(),
) {
  const occurred = new Date(occurredAt);
  const cutoff = publicResearchCutoff(now);
  if (Number.isNaN(occurred.getTime()) || occurred < cutoff) return false;

  const explicitYears = [...String(text ?? "").matchAll(/\b(?:FY\s*)?(20\d{2})\b/gi)]
    .map(match => Number(match[1]))
    .filter(Number.isFinite);

  // Search providers sometimes return a recently refreshed profile page whose
  // actual facts are years old. If every explicit year predates the rolling
  // research window, the page is provenance, not current buying-intent news.
  return explicitYears.length === 0 || Math.max(...explicitYears) >= cutoff.getFullYear();
}