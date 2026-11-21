import { WORKFORCE_CONTRACTION, workforcePassageFacts, sourceRequirementPassages, hasOperationalSupport } from "./researchSourceFacts";

export type FitmentLevel = "direct_intent" | "confirmed_need" | "business_trigger" | "context";

export type SignalProduct = {
  id: number;
  name: string;
  category: string;
  subcategory: string | null;
};

export type ProductFitment = {
  productId: number;
  productName: string;
  category: string;
  relevance: number;
  points: number;
  level: FitmentLevel;
  reason: string;
};

const PRODUCT_FAMILY_RULES: Array<{ family: RegExp; product: RegExp }> = [
  { family: /\b(headsets?|headphones?|earbuds?|earphones?|audio|speakerphones?|telephony|voice|telecom|call routing|unified communications?|contact cent(?:er|re))\b/i, product: /\b(headsets?|headphones?|earbuds?|earphones?|audio|speakerphones?|telephony|voice|telecom|phones?|unified communications?|contact cent(?:er|re))\b/i },
  { family: /\b(laptops?|desktops?|workstations?|computers?|endpoints?|devices?|employee pcs?|device fleet|device as a service|daas)\b/i, product: /\b(laptops?|desktops?|workstations?|computers?|endpoints?|devices?|employee pcs?|device fleet|device as a service|daas)\b/i },
  { family: /\b(video conferencing|video bars?|meeting rooms?|teams rooms?|zoom rooms?|webex|ucaas)\b/i, product: /\b(video conferencing|video bars?|meeting rooms?|teams rooms?|zoom rooms?|webex|ucaas)\b/i },
  { family: /\b(network|networking|router|switch|wireless|wi-?fi|connectivity)\b/i, product: /\b(network|router|switch|wireless|wi-?fi|connectivity)\b/i },
  { family: /\b(printers?|printing|managed print|mfp|multifunction|document workflow|scanning)\b/i, product: /\b(printers?|printing|managed print|mfp|multifunction|document|scanning)\b/i },
  { family: /\b(crm|sales automation|revops|customer relationship)\b/i, product: /\b(crm|sales automation|revops|customer relationship)\b/i },
  { family: /\b(cybersecurity|security|ransomware|soc|siem|edr|mfa|compliance)\b/i, product: /\b(cybersecurity|security|soc|siem|edr|mfa|compliance|firewall)\b/i },
  { family: /\b(cloud|data cent(?:er|re)|virtuali[sz]ation|backup|disaster recovery|storage|server)\b/i, product: /\b(cloud|data cent(?:er|re)|virtuali[sz]ation|backup|disaster recovery|storage|server|nas)\b/i },
  { family: /\b(office|workplace|facilit(?:y|ies)|furniture|stationery|supplies)\b/i, product: /\b(office|workplace|furniture|stationery|supplies)\b/i },
  { family: /\b(automotive|automobile|vehicle|mobility|fleet|car|transport)\b/i, product: /\b(automotive|automobile|vehicle|mobility|fleet|car|transport)\b/i },
];

const DIRECT_TERMS = /\b(rfp|rfq|tender|procurement (?:notice|request|process)|pricing (?:request|enquiry|inquiry)|request(?:ed)? (?:a )?(?:quote|quotation|demo)|purchase order|buy|purchase|vendor evaluation|contract expiry|renewal)\b/i;
const NEAR_TERM_TIMEFRAME_TERMS = /\b(this (?:month|quarter)|next (?:30|60|90) days?|within (?:30|60|90) days?|within (?:one|two|three|1|2|3) months?|0\s*[-–]\s*3 months?|by (?:january|february|march|april|may|june|july|august|september|october|november|december|q[1-4])(?:\s+20\d{2})?|deadline|closing date|delivery (?:required )?by|deploy(?:ment)? by|rollout by|implementation by)\b/i;
const NEGATIVE_TERMS = /\b(no requirement|not interested|no plans?|unrelated|not applicable|closed|cancelled)\b/i;
const CONTACT_CENTER_TERMS = /\b(contact cent(?:er|re)|call cent(?:er|re)|customer service agents?|support agents?|inside sales agents?|call[- ]center operations?)\b/i;
const SITE_TERMS = /\b(new|opening|opened|launch(?:ing|ed)?)\s+(?:three|3|four|4|five|5|several|\d+)?\s*(?:new\s+)?(?:offices?|branches?|sites?|locations?|facilities?)\b/i;

function textFor(product: SignalProduct) {
  return `${product.name} ${product.category} ${product.subcategory ?? ""}`;
}

function categoryMatch(text: string, product: SignalProduct) {
  const productText = textFor(product);
  if (/\b(3d|industrial|additive|wide[- ]format|large[- ]format)\b/i.test(text)
    && /\b(print|printer|printing|mfp)\b/i.test(productText)
    && !/\b(3d|industrial|additive|wide[- ]format|large[- ]format)\b/i.test(productText)) return undefined;
  // A shared category word must not turn office/document printing into industrial printing,
  // or generic computers into specialist workstations.
  if (/\b(3d|industrial|additive|wide[- ]format|large[- ]format)\b/i.test(productText)
    && !/\b(3d print(?:ing|ers?)?|additive manufacturing|industrial print(?:ing|ers?)?|wide[- ]format|large[- ]format)\b/i.test(text)) return undefined;
  if (/\bworkstations?\b/i.test(product.name) && !/\b(workstations?|cad|rendering|engineering compute)\b/i.test(text)) return undefined;
  // Choose the product's actual capability first. Incidental descriptors such
  // as "Office" in "Office Printers" must not match an office-chair tender.
  const securityRule=/\b(security|cybersecurity|firewall|siem|edr)\b/i.test(product.name)
    ? PRODUCT_FAMILY_RULES.find(rule=>rule.product.test("cybersecurity")) : undefined;
  const rule=securityRule ?? PRODUCT_FAMILY_RULES.find(rule=>rule.product.test(product.name))
    ?? PRODUCT_FAMILY_RULES.find(rule=>rule.product.test(productText));
  return rule?.family.test(text) ? rule : undefined;
}

function nearbyBuyingPassages(text: string) {
  return sourceRequirementPassages(text);
}

/** Owned by one analysis, never retained across requests or source corrections. */
export function prepareProductFitmentSource(value: string | null | undefined) {
  const text=String(value??"").trim();
  return {text,passages:sourceRequirementPassages(text),workforcePassages:workforcePassageFacts(text),
    contraction:WORKFORCE_CONTRACTION.test(text)};
}

export function hasExplicitNearTermBuyingContext(text: string) {
  return nearbyBuyingPassages(text).some(passage => DIRECT_TERMS.test(passage) && NEAR_TERM_TIMEFRAME_TERMS.test(passage));
}

function uniquelyNamesProduct(text: string, product: SignalProduct) {
  const productText = textFor(product);
  if (/\bearbuds?|earphones?\b/i.test(productText)) return /\bearbuds?|earphones?\b/i.test(text);
  if (/\bheadsets?|headphones?\b/i.test(productText)) return /\bheadsets?|headphones?\b/i.test(text) || CONTACT_CENTER_TERMS.test(text);
  if (/\bvideo (?:conferenc(?:e|ing)|bars?)|room video|meeting rooms?\b/i.test(productText)) {
    return /\bvideo (?:conferenc(?:e|ing)|bars?)|room video|meeting rooms?\b/i.test(text);
  }
  return true;
}

/**
 * Converts one account signal into product-specific evidence. A product is
 * returned only when the fact -> operational need -> product capability chain
 * is explicit enough to support a buying hypothesis.
 */
export function analyzeProductFitment(
  input: { eventType?: string | null; text?: string | null; confidence?: number },
  product: SignalProduct,
  prepared?: ReturnType<typeof prepareProductFitmentSource>,
): ProductFitment | null {
  const text = String(input.text ?? "").trim();
  if (!text || NEGATIVE_TERMS.test(text)) return null;
  const source=prepared?.text===text?prepared:prepareProductFitmentSource(text);
  const direct = categoryMatch(text, product);
  const buyingPassages = source.passages.filter(passage => {
    const action = DIRECT_TERMS.exec(passage);
    if(!action)return false;
    // The category must be in the action's requirement, not just in the
    // subject ("the printing division issued an RFP for office chairs").
    const requirement=passage.slice(action.index);
    return categoryMatch(requirement,product) && uniquelyNamesProduct(requirement,product);
  });
  const buyingPassage = buyingPassages[0];
  const nearTermBuyingPassage = buyingPassages.find(passage=>NEAR_TERM_TIMEFRAME_TERMS.test(passage));
  const workforcePassages = source.workforcePassages;
  const productText = textFor(product);
  const device = /\b(laptops?|desktops?|workstations?|computers?|endpoints?|devices?|daas)\b/i.test(productText);
  const specialist = /\bworkstations?\b/i.test(product.name);
  const audioFor = (passage: string) => /\b(headsets?|headphones?|earbuds?|earphones?|audio|telephony|voice|telecom|phones?|unified communications?|contact cent(?:er|re))\b/i.test(productText)
    && uniquelyNamesProduct(passage, product);
  const contactCenter = workforcePassages.filter(fact => fact.operation && CONTACT_CENTER_TERMS.test(fact.operation)
    && Math.max(fact.growthHeadcount, fact.staffedCapacity) > 0)
    .sort((a, b) => Math.max(b.growthHeadcount, b.staffedCapacity) - Math.max(a.growthHeadcount, a.staffedCapacity))
    .find(fact => (audioFor(fact.passage) || device)
      && (!specialist || categoryMatch(fact.passage, product)));
  const productSpecific = uniquelyNamesProduct(text, product);

  if (nearTermBuyingPassage && productSpecific) {
    const relevance = 95;
    return { productId: product.id, productName: product.name, category: product.category, relevance, points: 70, level: "direct_intent", reason: "The evidence directly names this product category, an explicit buying action, and a near-term timeframe." };
  }

  if (contactCenter) {
    const scale = Math.max(contactCenter.growthHeadcount, contactCenter.staffedCapacity);
    const audio = audioFor(contactCenter.passage);
    const relevance = audio && scale >= 100 ? 96 : audio ? 88 : device && scale >= 100 ? 76 : 58;
    const points = audio && scale >= 100 ? 70 : device && scale >= 100 ? 48 : 32;
    return { productId: product.id, productName: product.name, category: product.category, relevance, points, level: "confirmed_need", reason: `${scale}-person customer-service operation${contactCenter.location ? ` in ${contactCenter.location}` : ""} implies a relevant ${product.category} requirement; this is a possible fit, not confirmation of a purchase. Source passage: "${contactCenter.passage}"` };
  }

  const growth = workforcePassages.filter(fact => fact.growthHeadcount >= 50
    && (categoryMatch(fact.passage, product) || /\b(software developers?|it staff|office employees|office staff)\b/i.test(fact.passage)))
    .sort((a, b) => b.growthHeadcount - a.growthHeadcount)
    .find(fact => {
      const crm = /\b(crm|sales automation|revops|customer relationship)\b/i.test(productText)
        && /\b(sales|revenue|business development)\b/i.test(fact.passage);
      return (device || crm) && (!specialist || categoryMatch(fact.passage, product));
    });
  if (growth) {
    const relevance = device ? 84 : 70;
    const points = device ? 42 : 32;
    return { productId: product.id, productName: product.name, category: product.category, relevance, points, level: "confirmed_need", reason: `A workforce increase of about ${growth.growthHeadcount} people creates a plausible ${product.category} capacity need; validate the deployment and buying timeline. Source passage: "${growth.passage}"` };
  }

  if (!source.contraction && SITE_TERMS.test(text) && direct
    && source.passages.some(passage => categoryMatch(passage, product) && hasOperationalSupport(passage)
      && (!DIRECT_TERMS.test(passage)||buyingPassages.includes(passage)))) {
    const relevance = 76;
    return { productId: product.id, productName: product.name, category: product.category, relevance, points: relevance >= 70 ? 34 : 18, level: "business_trigger", reason: "A new office, branch, or site creates a plausible deployment need for this category; no purchase is confirmed." };
  }

  if (buyingPassage && direct) {
    return { productId: product.id, productName: product.name, category: product.category, relevance: 82, points: 55, level: "confirmed_need", reason: "The evidence connects a relevant category to a named project, lifecycle, procurement, or operational requirement." };
  }

  if (direct && productSpecific && source.passages.some(passage => categoryMatch(passage, product) && hasOperationalSupport(passage)
    && !DIRECT_TERMS.test(passage))) {
    return { productId: product.id, productName: product.name, category: product.category, relevance: 55, points: 20, level: "context", reason: "The category is explicitly mentioned, but no buying action, operational project, or deployment scale is established." };
  }

  // Funding, generic hiring, a single specialist hire, and vague growth are
  // account context. They must not manufacture a product-buy signal.
  return null;
}

export function deriveProductFitments(
  input: { eventType?: string | null; text?: string | null; confidence?: number; aiProductIds?: number[] },
  products: SignalProduct[],
) {
  const prepared=prepareProductFitmentSource(input.text);
  const fitments = products
    .map(product => analyzeProductFitment(input, product, prepared))
    .filter((fitment): fitment is ProductFitment => Boolean(fitment));
  const allowedAiIds = new Set(input.aiProductIds ?? []);
  return fitments
    .filter(fitment => fitment.relevance >= 45 || allowedAiIds.has(fitment.productId))
    .sort((a, b) => b.points - a.points || b.relevance - a.relevance || a.productName.localeCompare(b.productName));
}