import { inboundCategoryForInterest, type InboundCategoryConfig } from "./inboundTaxonomy";

export const HP_OPPORTUNITIES = ["Business Services", "Business Collaboration", "IT Hardware", "Security"] as const;
export function opportunityCategory(category: unknown, product: unknown, config: InboundCategoryConfig) {
  const supplied = String(category ?? "").trim();
  if (supplied.toLowerCase() === "collaboration") return "Business Collaboration";
  const canonical = HP_OPPORTUNITIES.find(name => name.toLowerCase() === supplied.toLowerCase());
  return canonical ?? (product ? inboundCategoryForInterest(String(product), null, config).categoryName : null);
}
