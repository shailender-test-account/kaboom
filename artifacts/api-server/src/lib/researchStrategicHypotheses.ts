import { z } from "zod/v4";

/** Sales-discovery context only. Never pass these hypotheses into intent scoring. */
export const strategicHypothesisSchema = z.object({
  category: z.enum(["IT Hardware", "Business Collaboration", "Security", "Business Services"]),
  productId: z.number().int().positive(),
  productName: z.string().min(1).max(180).optional(),
  signal: z.string().min(1).max(500),
  direction: z.string().min(1).max(700),
  rationale: z.string().min(1).max(800),
  entryPitch: z.string().min(1).max(700),
  validationQuestions: z.array(z.string().min(1).max(300)).min(1).max(4),
  sourceUrl: z.string().url(),
  sourceQuote: z.string().min(20).max(900),
  supportingSources: z.array(z.object({
    url: z.string().url(), quote: z.string().min(20).max(700),
  }).strict()).max(3),
}).strict();
export type StrategicHypothesis = z.infer<typeof strategicHypothesisSchema>;
const normalized = (text: string) => text.toLowerCase().replace(/\s+/g, " ").trim();
/** Display/discovery mapping only; never changes the catalog or scoring category. */
export function hpDiscoveryCategory(product: {category: string; name: string}): StrategicHypothesis["category"] | null {
  const category = product.category.toLowerCase().trim();
  if (category === "it hardware") return "IT Hardware";
  if (["collaboration", "virtual collaboration", "business collaboration"].includes(category) || /^HP Poly\b/i.test(product.name)) return "Business Collaboration";
  if (category === "security" || /^HP (?:Wolf Security|Workforce Security Solution)$/i.test(product.name)) return "Security";
  if (category === "business services" || /^HP (?:Managed Device Services|Fleet Management|Computing Services|Digital Workspaces|Renew Solutions|Workforce Experience Platform|Workforce Transformation Consulting)$/i.test(product.name)) return "Business Services";
  return null;
}
export function isCommercialPositioningOnly(text: string): boolean {
  return /\b(?:sponsor(?:s|ed|ship)?|silver partner|gold partner|speaking at|speaker at|participat(?:es|ing) in (?:the )?(?:summit|conference))\b/i.test(text)
    && !/\b(?:issued an? (?:rfp|tender)|seeking (?:bids|proposals)|purchas(?:e|ed|ing)|procur(?:e|ed|ing|ement)|deploy(?:ed|ing)|opened a new|opening a new|hiring \d|suffered a (?:data breach|cyberattack)|announced (?:layoffs|an acquisition))\b/i.test(text);
}
export function validatedStrategicHypotheses(
  value: unknown,
  evidence: Array<{ sourceUrl?: string; excerpt: string }>,
  catalog: Array<{ id: number; category: string; name: string }>,
): StrategicHypothesis[] {
  if (!Array.isArray(value)) return [];
  const result = new Map<string, StrategicHypothesis>();
  for (const candidate of value) {
    const parsed = strategicHypothesisSchema.safeParse(candidate);
    if (!parsed.success) continue;
    const item = parsed.data;
    const product = catalog.find(p => p.id === item.productId);
    if (!product || hpDiscoveryCategory(product) !== item.category) continue;
    if (!evidence.some(row => row.sourceUrl === item.sourceUrl &&
      normalized(row.excerpt).includes(normalized(item.sourceQuote)))) continue;
    if (!result.has(item.category)) result.set(item.category, { ...item, productName: product!.name });
  }
  return [...result.values()].slice(0, 4);
}

/** Only follow explicit context links, never arbitrary model-generated URLs. */
export function relatedResearchLinks(html: string, base: string): string[] {
  const links: string[] = [];
  for (const match of html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const label = match[2].replace(/<[^>]*>/g, " ");
    if (!/\b(?:agenda|programme|program|speakers?|summit|conference|event details|attendees?|sponsors?)\b/i.test(`${label} ${match[1]}`)) continue;
    try {
      const url = new URL(match[1].replace(/&amp;/g, "&"), base);
      if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) continue;
      if (/\.(?:pdf|zip|png|jpe?g|mp4)$/i.test(url.pathname)) continue;
      url.hash = "";
      if (url.href !== base && !links.includes(url.href)) links.push(url.href);
    } catch { /* Malformed source links are not evidence. */ }
  }
  return links.slice(0, 3);
}
