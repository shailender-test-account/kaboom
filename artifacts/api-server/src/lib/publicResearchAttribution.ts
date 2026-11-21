/**
 * A search hit is not proof that the searched-for company issued a tender.
 * Check the original provider excerpt, not the AI-written summary, which can
 * introduce the company name while paraphrasing an unrelated page.
 */
export function isUnattributedProcurement(input: {
  eventType?: string | null;
  searchKind?: string | null;
  excerpt?: string | null;
  sourceUrl?: string | null;
  companyName: string;
  companyDomain?: string | null;
  originalExcerpt?: string | null;
  manuallyReviewed?: boolean;
}): boolean {
  if ((input.eventType !== "procurement" && input.searchKind !== "tenders") || input.manuallyReviewed) return false;
  const original = String(input.originalExcerpt ?? input.excerpt ?? "");
  const url = String(input.sourceUrl ?? "");
  const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const name = normalize(input.companyName)
    .replace(/\b(?:private|pvt|limited|ltd|incorporated|inc|corporation|corp|llc|plc)\b/g, " ")
    .replace(/\s+/g, " ").trim();
  const words = name.split(" ").filter(Boolean);
  const variants = [name];
  if (words.length > 1 && words[0].length >= 4 && !["india", "indian", "global", "group", "the"].includes(words[0])) variants.push(words[0]);
  const domain = String(input.companyDomain ?? "").replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0].toLowerCase();
  const host = (() => { try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ""); } catch { return ""; } })();
  if (domain && (host === domain || host.endsWith(`.${domain}`))) return false;
  const text = ` ${normalize(original)} `;
  return !variants.some(variant => variant.length >= 4 && text.includes(` ${variant} `));
}

type ResearchIdentityInput = Parameters<typeof isUnattributedProcurement>[0];

/** An account mention in a biography, related post or page footer is not the subject of the news. */
export function isUnattributedBusinessNews(input: ResearchIdentityInput): boolean {
  if (input.manuallyReviewed) return false;
  const source = String(input.originalExcerpt ?? input.excerpt ?? "").trim();
  const name = input.companyName.replace(/\b(?:private|pvt|limited|ltd|incorporated|inc|corporation|corp|llc|plc|group|india|ww)\b/gi, " ")
    .match(/[a-z0-9]+/gi)?.join(" ") ?? "";
  if (!name || !source) return true;
  const escaped = name.split(" ").map(word => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\W+");
  const identity = new RegExp(`\\b${escaped}\\b`, "i");
  const domain = (input.companyDomain ?? "").replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0].toLowerCase();
  let official = false;
  try { const host = new URL(input.sourceUrl || "").hostname.replace(/^www\./, "").toLowerCase(); official = !!domain && (host === domain || host.endsWith(`.${domain}`)); } catch {}
  // Search snippets from social pages concatenate unrelated posts and author biographies.
  const headline = source.split(/\s*\|\s*|\n|(?<=[.!?])\s+/)[0].trim();
  const social = /linkedin\.com|facebook\.com|twitter\.com|(?:^|\/)x\.com/i.test(input.sourceUrl || "") ||
    /\bposted (?:on|about)|\|\s*LinkedIn\b/i.test(source);
  if (social && !identity.test(headline)) return true;
  const passages = source.split(/(?<=[.!?])\s+|\n|\s*\|\s*/).filter(Boolean);
  const related = passages.filter(passage => identity.test(passage));
  if (!related.length) return !(official && /\b(?:we|our)\b/i.test(headline));
  const event = /\b(?:raises?|raised|secures?|secured|acquires?|acquired|announces?|announced|reports?|reported|opens?|opened|expands?|expanded|invests?|invested|cuts?|cutting|launches?|launched)\b/i;
  const firstEvent = headline.match(event);
  if (firstEvent?.index != null && !identity.test(headline.slice(0, firstEvent.index))) {
    // Retain a real relationship event, not a quoted employee or incidental comparison.
    const relation = new RegExp(`\\b(?:with|for|from|by|of|into)\\s+(?:the\\s+)?${escaped}\\b|\\b${escaped}\\b[^.!?]{0,60}\\b(?:acquir|merg|invest|contract|deploy|partner|purchas)`, "i");
    if (!relation.test(headline)) return true;
  }
  return related.every(passage => /\b(?:global vice president|vice president at|formerly at|ex[- ]|posted|commented|shared this|people also viewed|related posts?|recommended for you)\b/i.test(passage)
    && !new RegExp(`\\b${escaped}\\b\\s+(?:India\\s+)?(?:announced|reported|opened|plans|will|is investing|has acquired|signed|expanded)\\b`, "i").test(passage));
}

export function isUnattributedResearch(input: ResearchIdentityInput) {
  return isUnattributedProcurement(input) || isUnattributedBusinessNews(input);
}

/** A candidate for human review, not a verdict: third-party reporting can be genuine. */
export function publicResearchMismatchReason(input: {
  eventType?: string | null;
  searchKind?: string | null;
  originalExcerpt?: string | null;
  sourceUrl?: string | null;
  companyName: string;
  companyDomain?: string | null;
}): string | null {
  const original = String(input.originalExcerpt ?? "").trim();
  if (!original) return "Original provider excerpt is missing; account attribution cannot be checked.";
  if (isUnattributedResearch({ ...input, excerpt: original })) {
    const kind = input.eventType === "procurement" || input.searchKind === "tenders"
      ? "Tender or procurement" : `${(input.eventType ?? "Public event").replace(/_/g, " ")}`;
    return `${kind} source excerpt does not name ${input.companyName}, and the source host is not the account domain. A search hit alone does not establish attribution.`;
  }
  return null;
}