export type ImportCatalogProduct = {
  id: number;
  name: string;
  category: string;
  subcategory: string | null;
};

export type InferredImportProduct = ImportCatalogProduct & {
  confidence: number;
  matchedOn: "product" | "subcategory" | "category" | "keywords";
};

const STOP_WORDS = new Set([
  "and", "for", "the", "with", "service", "services", "solution", "solutions",
  "product", "products", "about", "know", "more", "following", "interested",
]);

function normalized(value: string) {
  return value.toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim();
}

function tokens(value: string) {
  return new Set(normalized(value).split(/\s+/).filter(token => token.length > 2 && !STOP_WORDS.has(token)));
}

function overlap(left: Set<string>, right: Set<string>) {
  if (!left.size || right.size < 2) return 0;
  let matches = 0;
  for (const token of left) if (right.has(token)) matches += 1;
  return matches >= 2 ? matches / Math.min(left.size, right.size) : 0;
}

const CATALOG_SYNONYMS: Array<{ answer: RegExp; catalog: RegExp }> = [
  { answer: /\b(laptops?|notebooks?|employee pcs?|end[- ]user comput|device[- ]as[- ]a[- ]service|daas)\b/i, catalog: /\b(laptops?|workstations?|end[- ]user comput|device[- ]as[- ]a[- ]service|daas)\b/i },
  { answer: /\b(headset|headphone|earbud|noise cancell|anc)\b/i, catalog: /\b(headphone|headset|active noise cancellation|anc)\b/i },
  { answer: /\b(video conferenc|hybrid meeting|meeting room|video bar|webcam)\b/i, catalog: /\bvideo conferencing\b/i },
  { answer: /\b(audio conferenc|speakerphone|conference phone)\b/i, catalog: /\baudio conferencing\b/i },
  { answer: /\b(teleconferenc|meeting bridge|conference service)\b/i, catalog: /\bteleconferencing\b/i },
  { answer: /\b(printer|printing|managed print|multifunction)\b/i, catalog: /\blaser printer\b/i },
  { answer: /\b(monitor|display|digital signage)\b/i, catalog: /\bmonitor|display\b/i },
  { answer: /\b(server|storage|backup|nas)\b/i, catalog: /\bserver|storage\b/i },
  { answer: /\b(network|switch|router|wireless|wi-?fi)\b/i, catalog: /\bnetwork\b/i },
  { answer: /\b(dock|keyboard|mouse|peripheral|accessor)\b/i, catalog: /\bperipheral|accessor\b/i },
];

function managedDeviceServiceAlias(answer: string, productText: string) {
  return /\b(device[- ]as[- ]a[- ]service|daas)\b/i.test(answer)
    && /\bmanaged device(?: and computing)? services?\b/i.test(productText);
}

export function inferCategoriesFromInterest(value: unknown, catalog: ImportCatalogProduct[]) {
  const answer = Array.isArray(value) ? value.map(item => String(item ?? "")).join("; ") : String(value ?? "");
  const normalizedAnswer = normalized(answer);
  if (!normalizedAnswer) return [];
  const byCategory = new Map<string, { category: string; confidence: number; matchedOn: "product" | "subcategory" | "category" | "keywords" }>();
  for (const product of catalog) {
    const productText = `${product.name} ${product.subcategory ?? ""} ${product.category}`;
    const productName = normalized(product.name);
    const subcategory = normalized(product.subcategory ?? "");
    const category = normalized(product.category);
    const match =
      productName && normalizedAnswer.includes(productName) ? { confidence: 100, matchedOn: "product" as const } :
      subcategory && normalizedAnswer.includes(subcategory) ? { confidence: 90, matchedOn: "subcategory" as const } :
      managedDeviceServiceAlias(answer, productText) ? { confidence: 95, matchedOn: "keywords" as const } :
      category && normalizedAnswer.includes(category) ? { confidence: 80, matchedOn: "category" as const } :
      CATALOG_SYNONYMS.some(rule => rule.answer.test(answer) && rule.catalog.test(productText)) ? { confidence: 82, matchedOn: "keywords" as const } :
      null;
    if (!match) continue;
    const existing = byCategory.get(product.category);
    if (!existing || match.confidence > existing.confidence) byCategory.set(product.category, { category: product.category, ...match });
  }
  const matches = [...byCategory.values()].sort((a, b) => b.confidence - a.confidence || a.category.localeCompare(b.category));
  const best = matches[0]?.confidence;
  return matches.filter(match => match.confidence === best);
}

export function inferProductsFromInterest(
  value: unknown,
  catalog: ImportCatalogProduct[],
  options: { includeCategoryMatches?: boolean } = {},
): InferredImportProduct[] {
  const answer = Array.isArray(value)
    ? value.map(item => String(item ?? "")).join("; ")
    : String(value ?? "");
  const normalizedAnswer = normalized(answer);
  if (!normalizedAnswer) return [];
  const answerTokens = tokens(answer);

  const matches = catalog
    .map(product => {
      const productName = normalized(product.name);
      const subcategory = normalized(product.subcategory ?? "");
      const category = normalized(product.category);
      const synonymMatch = CATALOG_SYNONYMS.some(rule =>
        rule.answer.test(answer) && rule.catalog.test(`${product.name} ${product.subcategory ?? ""}`),
      );
      if (productName && normalizedAnswer.includes(productName)) {
        return { ...product, confidence: 100, matchedOn: "product" as const };
      }
      if (subcategory && normalizedAnswer.includes(subcategory)) {
        return { ...product, confidence: 90, matchedOn: "subcategory" as const };
      }
      if (managedDeviceServiceAlias(answer, `${product.name} ${product.subcategory ?? ""}`)) {
        return { ...product, confidence: 95, matchedOn: "keywords" as const };
      }
      if (options.includeCategoryMatches !== false && category && normalizedAnswer.includes(category)) {
        return { ...product, confidence: 80, matchedOn: "category" as const };
      }
      if (synonymMatch) {
        return { ...product, confidence: 82, matchedOn: "keywords" as const };
      }
      const keywordScore = Math.max(
        overlap(answerTokens, tokens(product.name)),
        overlap(answerTokens, tokens(product.subcategory ?? "")),
        options.includeCategoryMatches !== false ? overlap(answerTokens, tokens(product.category)) : 0,
      );
      return keywordScore >= 0.6
        ? { ...product, confidence: Math.round(keywordScore * 75), matchedOn: "keywords" as const }
        : null;
    })
    .filter((product): product is InferredImportProduct => product !== null)
    .sort((a, b) => b.confidence - a.confidence || a.name.localeCompare(b.name));

  const explicitMatches = matches.filter(match => match.matchedOn !== "keywords");
  if (explicitMatches.length) return explicitMatches;

  const bestConfidence = matches[0]?.confidence;
  const bestKeywordMatches = matches.filter(match => match.confidence === bestConfidence);
  return bestKeywordMatches.length === 1 ? bestKeywordMatches : [];
}