import { deriveProductFitments, type SignalProduct } from "./signalProductFit";
import { researchSourceText } from "./researchSourceFacts";

export type ResearchEvidenceLevel = "direct_intent" | "confirmed_need" | "business_trigger" | "context";

type StoredFitment = {
  level?: unknown;
  points?: unknown;
  productId?: unknown;
  productName?: unknown;
  category?: unknown;
};

/** Broad capability detectors for unscoped research; never used as catalog recommendations. */
export const RESEARCH_CAPABILITIES: SignalProduct[] = [
  { id: 1, name: "Laptops desktops endpoint devices", category: "IT Hardware", subcategory: null },
  { id: 2, name: "Headsets telephony", category: "Collaboration", subcategory: null },
  { id: 3, name: "Printers document workflow", category: "Printing", subcategory: null },
  { id: 4, name: "Cybersecurity", category: "Security", subcategory: null },
  { id: 5, name: "Cloud software", category: "Services", subcategory: null },
  { id: 6, name: "Network connectivity", category: "Networking", subcategory: null },
  { id: 7, name: "Video conferencing", category: "Collaboration", subcategory: null },
  { id: 8, name: "CRM software", category: "Services", subcategory: null },
];
const BUSINESS_TRIGGER_TYPES = new Set([
  "funding", "capital_investment", "branch_opening", "merger_acquisition",
  "partnership", "quarterly_financial", "hiring", "cxo_appointment", "layoffs",
]);

export function validatedResearchFitments(input: {
  eventType?: string | null;
  excerpt?: string | null;
  context?: Record<string, any>;
}) {
  const text = researchSourceText(input.excerpt, input.context);
  const fitments = Array.isArray(input.context?.aiReview?.fitments)
    ? input.context.aiReview.fitments as StoredFitment[]
    : [];
  const products = fitments.filter(item => typeof item.productName === "string" && typeof item.category === "string")
    .map(item => ({ id: Number(item.productId), name: String(item.productName), category: String(item.category), subcategory: null }));
  // Re-derive from source facts. Stored AI levels/points cannot establish product demand.
  return deriveProductFitments({ text, eventType: input.eventType }, products.length ? products : RESEARCH_CAPABILITIES);
}

export function classifyResearchEvidence(input: {
  eventType?: string | null;
  excerpt?: string | null;
  context?: Record<string, any>;
}, validated = validatedResearchFitments(input)) {
  const directFit = validated.find(item => item.level === "direct_intent");
  const confirmedFits = validated.filter(item => item.level === "confirmed_need");
  const confirmedPoints = confirmedFits.reduce((max, item) => Math.max(max, Number(item.points) || 0), 0);

  if (directFit) {
    return { level: "direct_intent" as const, points: Math.max(70, Number(directFit?.points) || 0), hotEligible: true };
  }
  if (confirmedFits.length) {
    return { level: "confirmed_need" as const, points: Math.max(35, confirmedPoints), hotEligible: false };
  }
  if (BUSINESS_TRIGGER_TYPES.has(String(input.eventType ?? ""))) {
    return { level: "business_trigger" as const, points: 10, hotEligible: false };
  }
  return { level: "context" as const, points: 0, hotEligible: false };
}

export function normalizedResearchEvidenceKey(input: { sourceUrl?: string | null; excerpt?: string | null }) {
  const sourceUrl = String(input.sourceUrl ?? "").trim().toLowerCase();
  if (sourceUrl) return `url:${sourceUrl.replace(/[?#].*$/, "")}`;
  return `text:${String(input.excerpt ?? "").toLowerCase().replace(/\s+/g, " ").trim().slice(0, 500)}`;
}

export function researchEvidenceHeat(input: {
  rawScore: number;
  directCount: number;
  confirmedCount: number;
  hotEligible: boolean;
}) {
  const score = input.directCount === 0 && input.confirmedCount === 0
    ? Math.min(20, input.rawScore)
    : input.directCount === 0 && input.confirmedCount < 2 && !input.hotEligible
      ? Math.min(39, input.rawScore)
      : Math.min(100, input.rawScore);
  const tier: "hot" | "warm" | "cold" = score >= 70 && input.hotEligible
    ? "hot"
    : score >= 40 && input.confirmedCount >= 2
      ? "warm"
      : "cold";
  return { score, tier };
}