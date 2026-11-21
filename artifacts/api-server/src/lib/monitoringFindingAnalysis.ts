import { isResearchGeographyEligible, researchCountry } from "./researchGeography";
import type { MonitoringFinding } from "./monitoredAccountContext";
import { hasOperationalSupport, isResearchPageFurniture } from "./researchSourceFacts";
import { isUnattributedResearch } from "./publicResearchAttribution";

type Identity = { name: string; domain?: string | null };
const object = (value: any): Record<string, any> => value && typeof value === "object" && !Array.isArray(value) ? value : {};
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Conservative source-only read model; no provider calls and no score mutations. */
export function analyzeMonitoringFindings(findings: MonitoringFinding[], now: Date, account?: Identity) {
  return monitoringFindingAnalysis(findings, now, account).findings;
}

export const monitoringExclusionLabels = {
  missing_source: "Original source text unavailable",
  source_furniture: "Navigation, customer-story index or case study—not account news",
  wrong_account: "Source does not establish this account",
  invalid_source: "Missing or invalid source link",
  not_approved: "Not approved for analytical use",
  stale_date: "Publication or event date is older than 90 days",
  invalid_date: "Publication or event date is invalid or in the future",
  non_selected_country: "Source does not establish the selected country for this account",
  insufficient_source_evidence: "No concise account-specific source passage available for analysis",
  duplicate: "Duplicate source or syndicated event",
} as const;

/** One primary exclusion per record; limitations on retained context are separate. */
export function monitoringFindingAnalysis(findings: MonitoringFinding[], now: Date, account?: Identity) {
  const counts = new Map<keyof typeof monitoringExclusionLabels, number>();
  const exclude = (reason: keyof typeof monitoringExclusionLabels) => {
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
    return [];
  };
  let unverifiedPublicationDate = 0;
  let insufficientOperationalEvidence = 0;
  const words = account?.name.replace(/\b(private|limited|pvt|ltd|inc|corporation|group|india|ww)\b/gi, " ")
    .match(/[a-z0-9]+/gi)?.filter(word => word.length > 2) ?? [];
  const identity = words.length ? new RegExp(`\\b${words.map(escape).join("\\W+")}\\b`, "i") : null;
  const domain = account?.domain?.replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0].toLowerCase();
  const seen = new Set<string>();
  const texts: Set<string>[] = [];
  const usable = findings.flatMap(finding => {
    const raw = object(finding.raw_evidence);
    const context = finding.context ?? {};
    const originalContext = Object.keys(raw).length ? object(raw.context) : context;
    const source = String(raw.excerpt || context.originalExcerpt || (context.aiReview ? "" : finding.excerpt)).trim();
    // Landing pages and concatenated customer stories are not an account news event.
    if (!source) return exclude("missing_source");
    if (isResearchPageFurniture(source)) return exclude("source_furniture");
    if (account && isUnattributedResearch({companyName:account.name,companyDomain:account.domain,
      originalExcerpt:source,sourceUrl:finding.sourceUrl,eventType:finding.eventType})) return exclude("wrong_account");
    let url: URL;
    try { url = new URL(finding.sourceUrl || ""); } catch { return exclude("invalid_source"); }
    if (!["http:", "https:"].includes(url.protocol)) return exclude("invalid_source");
    if(/\/(?:(?:symbols|company)\/[^/]+\/news|topic\/[^/]+(?:\/page\/\d+)?)(?:\/|$)/i.test(url.pathname))
      return exclude("source_furniture");
    // Generic vacancy directories are not dated business-news events. Otherwise
    // recently refreshed listings displace actual articles from the top-five read.
    const vacancyDirectory = /\b(?:jobs|careers|open roles|open vacancies|job openings)\b/i.test(source.slice(0, 600))
      && (/\/(?:jobs|careers)\/?$/i.test(url.pathname)
        || /\/(?:companies|company|at)\/[^/]+\/?$/i.test(url.pathname)
        || /\/[^/]*(?:-jobs|-careers)[^/]*\/?$/i.test(url.pathname));
    if (vacancyDirectory) return exclude("source_furniture");
    const official = !!domain && (url.hostname === domain || url.hostname.endsWith(`.${domain}`));
    const publishedDate = originalContext.publishedDate || originalContext.published_date;
    // Never pass a retrieval date off as a publication date.
    const publishedAt = typeof publishedDate === "string" && Number.isFinite(Date.parse(publishedDate))
      ? new Date(publishedDate).toISOString() : null;
    const occurred = Date.parse(finding.occurredAt);
    const date = publishedAt ? Date.parse(publishedAt) : occurred;
    if (finding.reviewStatus !== "approved") return exclude("not_approved");
    if (!Number.isFinite(date) || date > now.getTime()) return exclude("invalid_date");
    if (date < now.getTime() - 90 * 86400000) return exclude("stale_date");
    if (!isResearchGeographyEligible(finding)) return exclude("non_selected_country");
    if (/\/(?:case-studies|case-study|customer-stories)(?:\/|$)/i.test(url.pathname)) return exclude("source_furniture");
    const passages = source.split(/(?<!\b[A-Z]\.)(?<=[.!?])\s+|\n+/).map(text => text.trim()).filter(Boolean);
    const related = passages.filter(text => !identity || identity.test(text) ||
      (official && /\b(?:we|our company|our operations)\b/i.test(text)));
    // Country and account attribution must coexist in a local source passage.
    const relevant = related.filter(excerpt => excerpt.length <= 1200 && isResearchGeographyEligible({
      excerpt, context: { scope: { country: researchCountry(finding) } },
    }));
    if (!related.length) return exclude("wrong_account");
    if (!relevant.length) return exclude(related.some(excerpt => isResearchGeographyEligible({
      excerpt, context: { scope: { country: researchCountry(finding) } },
    })) ? "insufficient_source_evidence" : "non_selected_country");
    const summary = relevant.slice(0, 2).join(" ");
    const canonical = `${url.hostname.replace(/^www\./, "")}${url.pathname.replace(/\/$/, "")}`;
    const tokens = new Set(summary.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []);
    const duplicate = texts.some(previous => {
      const common = [...tokens].filter(token => previous.has(token)).length;
      return common / Math.max(1, Math.max(tokens.size, previous.size)) >= 0.8;
    });
    if (seen.has(canonical) || duplicate) return exclude("duplicate");
    seen.add(canonical); texts.push(tokens);
    if (!publishedAt) unverifiedPublicationDate++;
    // A limitation, not an exclusion: business context need not establish procurement.
    if (!hasOperationalSupport(summary) && !/\b(open(?:ed|ing)?|expand(?:ed|ing)?|expansion|hir(?:ed|ing)|layoffs?|restructur(?:e|ed|ing))\b/i.test(summary)) {
      insufficientOperationalEvidence++;
    }
    const scale = summary.match(/\b(?:\d[\d,.]*\s*(?:million|billion|lakh|crore|thousand)?\s*(?:square feet|sq\.?\s*ft|employees|people|staff|agents|seats|users|offices|sites|centres|centers))\b/i)?.[0];
    const timing = summary.match(/\b(?:by|in|during|from|expected (?:to open )?in|scheduled for)\s+(?:(?:Q[1-4]|January|February|March|April|May|June|July|August|September|October|November|December)\s+)?20\d{2}\b/i)?.[0];
    const ownerPassage = relevant.find(text => /\b(?:responsible for|appointed to lead|will lead|led by)\b/i.test(text));
    return [{ ...finding, excerpt: summary, publishedAt, country: researchCountry(finding), scale, timing, ownerPassage,
      sourcePassage: relevant.join(" "), attribution: identity ? "Account named in source or matching company domain" : "Account-linked research record" }];
  }).sort((a, b) => Number(!!b.publishedAt) - Number(!!a.publishedAt) ||
    Date.parse(b.publishedAt || b.occurredAt) - Date.parse(a.publishedAt || a.occurredAt));
  return {
    findings: usable,
    diagnostics: {
      assessedCount: findings.length,
      usableCount: usable.length,
      excludedCount: findings.length - usable.length,
      exclusions: [...counts].map(([reason, count]) => ({ reason, label: monitoringExclusionLabels[reason], count })),
      unverifiedPublicationDateCount: unverifiedPublicationDate,
      insufficientOperationalEvidenceCount: insufficientOperationalEvidence,
    },
  };
}
