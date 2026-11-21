import { deriveProductFitments, type SignalProduct } from "./signalProductFit";
import { classifyResearchEvidence } from "./researchIntentEvidence";
import { researchSourceText, workforceFacts } from "./researchSourceFacts";

export type StoredResearchFinding = {
  id: number;
  eventType: string | null;
  excerpt: string;
  sourceUrl: string | null;
  reviewStatus: string;
  productId: number | null;
  context: Record<string, any>;
  rawEvidence?: { excerpt?: string } | null;
  linkedSignalProductIds?: number[];
};

/** Pure, reviewable proposal: no persistence, providers, BI qualification or valuation. */
export function reassessResearchFinding(row: StoredResearchFinding, catalog: SignalProduct[]) {
  const originalExcerpt = row.rawEvidence?.excerpt || row.context?.originalExcerpt;
  const sourceFact = researchSourceText(row.excerpt, { ...row.context, originalExcerpt });
  const workforce = workforceFacts(sourceFact);
  const eventType = workforce.contraction ? "layoffs" : row.eventType;
  const fitments = deriveProductFitments({ text: sourceFact, eventType }, catalog);
  const classification = classifyResearchEvidence({eventType, excerpt: sourceFact,
    context: {aiReview:{fitments}}});
  const oldFitments = Array.isArray(row.context?.aiReview?.fitments) ? row.context.aiReview.fitments : [];
  const supportedIds = new Set(fitments.map(fit => fit.productId));
  const oldIds = new Set<number>([
    ...(row.productId ? [row.productId] : []),
    ...(row.linkedSignalProductIds ?? []),
    ...oldFitments.map((fit: any) => Number(fit.productId)).filter(Number.isInteger),
    ...(Array.isArray(row.context?.aiReview?.catalogProductIds) ? row.context.aiReview.catalogProductIds.map(Number).filter(Number.isInteger) : []),
  ]);
  return {
    evidenceId: row.id, sourceUrl: row.sourceUrl, sourceFact, workforce,
    sourceFactAvailable: typeof originalExcerpt === "string" && Boolean(originalExcerpt.trim()),
    authorizationRequired: "explicit_per_finding_admin_approval",
    before: {eventType:row.eventType, excerpt:row.excerpt, reviewStatus:row.reviewStatus,
      productId:row.productId, fitments:oldFitments},
    proposed: {eventType, fitments, classification,
      disposition: fitments.length ? "validate_category_need" : "business_context_only",
      removedProductIds: [...oldIds].filter(id => !supportedIds.has(id)),
      requiresHumanReview: true},
    reason: workforce.contraction
      ? "Workforce contraction is not growth. Preserve the business fact; product demand needs separate category-specific support."
      : fitments.length
        ? "Only source-supported category mechanisms survive; inferred catalog IDs and old heat labels are not proof."
        : "No source-backed category deployment or operational need. Preserve business context without a purchase claim.",
  };
}
