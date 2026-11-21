import { pool } from "@workspace/db";

export type InboundCategoryRule = { categoryName: string; terms: string[] };
export type InboundCategoryConfig = { rules: InboundCategoryRule[]; useBuiltin: boolean };

export async function loadInboundCategoryRules(tenantId: number): Promise<InboundCategoryConfig> {
  const result = await pool.query<{ rules: InboundCategoryRule[]; useBuiltin: boolean }>(
    'SELECT rules,use_builtin AS "useBuiltin" FROM intent_inbound_category_rules WHERE tenant_id=$1', [tenantId]);
  return result.rows[0] ?? {rules:[],useBuiltin:true};
}

export function validateInboundCategoryRules(rules: InboundCategoryRule[]): string | null {
  const seen = new Map<string, string>();
  for (const rule of rules) {
    if (!inboundCategories.includes(rule.categoryName)) return `Unknown category: ${rule.categoryName}`;
    for (const term of rule.terms) {
      const key = term.trim().toLocaleLowerCase().replace(/\s+/g, " ");
      if (!key || key.length < 2) return "Matching terms must contain at least two characters";
      for (const [existing, category] of seen) {
        if (category !== rule.categoryName && (existing === key || existing.includes(key) || key.includes(existing)))
          return `"${term}" overlaps a term in ${category}; use distinct matching terms.`;
      }
      seen.set(key, rule.categoryName);
    }
  }
  return null;
}

/**
 * Inbound-only interpretation of the questionnaire's product choices.
 * It deliberately does not change the shared product catalog used by intent scoring.
 */
export const inboundTaxonomy = [
  { category: "IT Hardware", products: [
    { name: "AI laptops", pattern: /\b(ai laptops?|ai pcs?|laptops?|notebooks?|business laptops?)\b/i },
    { name: "Desktops", pattern: /\b(desktops?|desktop pcs?)\b/i },
    { name: "Workstations", pattern: /\b(workstations?|mobile workstations?)\b/i },
  ] },
  { category: "Business Collaboration", products: [
    { name: "Poly Video Conferencing Solutions", pattern: /\b(poly.*video|video conferenc|video bars?|room video|hybrid meeting|webcams?)\b/i },
    { name: "Poly Headsets", pattern: /\b(poly.*headsets?|headsets?|headphones?|earbuds?|noise.cancell|anc headsets?)\b/i },
    { name: "Poly Desk Phones", pattern: /\b(poly.*(?:desk|conference) phones?|desk phones?|conference phones?|speakerphones?)\b/i },
  ] },
  { category: "Security", products: [
    { name: "Endpoint Security", pattern: /\b(endpoint|end point|device).{0,20}securit|\bsecurit.{0,20}(endpoint|end point|device)\b|\bsecurity services?\b/i },
    { name: "HP Wolf Security", pattern: /\b(wolf|workforce security)\b/i },
    { name: "HP Sure Click", pattern: /\b(sure ?click)\b/i },
  ] },
  { category: "Business Services", products: [
    { name: "Document & Workflow Management", subcategory: "Business workflow service", pattern: /\b(document.*workflow|workflow.*document|workflow management)\b/i },
    { name: "Print Management Software", subcategory: "Business workflow service", pattern: /\b(print management|managed print|fleet management)\b/i },
    { name: "Printing Security Software", subcategory: "Business workflow service", pattern: /\b(print|printing).{0,20}securit/i },
    { name: "Configuration & Deployment Services", subcategory: "Computing service", pattern: /\b(configuration|deployment).{0,25}service/i },
    { name: "Managed Device Service / Device as a Service", subcategory: "Computing service", pattern: /\b(managed device|device.as.a.service|\bdaas\b|computing services?)\b/i },
    { name: "Endpoint Lifecycle Management", subcategory: "Computing service", pattern: /\b(endpoint|device).{0,20}lifecycle/i },
    { name: "Renew Services", subcategory: "Computing service", pattern: /\b(renew|refurbish)\b/i },
    { name: "HP Anyware", subcategory: "Computing service", pattern: /\b(anyware|digital workspaces?)\b/i },
  ] },
] as const;

export const inboundCategories: string[] = inboundTaxonomy.map(group => group.category);

/** A reviewer may classify a blank product answer without inventing a product selection. */
export function categoryForMissingInterest(reviews?: Record<string,unknown>|null):string|null {
  const category=reviews?.__missingCategory;
  return typeof category==="string"&&inboundCategories.includes(category)?category:null;
}
export const inboundProducts = inboundTaxonomy.flatMap(group =>
  group.products.map(product => ({ name: product.name, categoryName: group.category,
    subcategoryName: "subcategory" in product ? product.subcategory : null })));

/**
 * A review of the same selected interest should be reflected across an account's
 * duplicate submissions. Keep other interests (and their reviews) independent.
 */
export function applyAccountCategoryReviews<T extends {
  accountId:number; productAffinity:string|null; affinityReviews:Record<string,unknown>|null;
  updatedAt?:Date|string|null;
}>(rows:T[]):T[] {
  const selections=(value:string|null)=>value?.split(/\r?\n|;|\||,\s*(?=[A-Z0-9])/)
    .map(s=>s.replace(/^[\s•\-–—✓✔☑]+/,"").trim()).filter(Boolean)??[];
  const corrections=new Map<string,{category:string;time:number}>();
  for(const row of rows){
    const overrides=row.affinityReviews?.__categoryOverrides;
    if(!overrides||typeof overrides!=="object"||Array.isArray(overrides))continue;
    const selected=new Set(selections(row.productAffinity));
    const time=row.updatedAt?new Date(row.updatedAt).getTime():0;
    for(const [selection,category] of Object.entries(overrides as Record<string,unknown>)){
      if(!selected.has(selection)||typeof category!=="string"||!inboundCategories.includes(category))continue;
      const key=`${row.accountId}:${selection}`;
      if(!corrections.has(key)||time>=corrections.get(key)!.time)corrections.set(key,{category,time});
    }
  }
  return rows.map(row=>{
    const inherited:Record<string,string>={};
    for(const selection of selections(row.productAffinity)){
      const category=corrections.get(`${row.accountId}:${selection}`)?.category;
      if(category)inherited[selection]=category;
    }
    if(!Object.keys(inherited).length)return row;
    return {...row,affinityReviews:{...row.affinityReviews,__categoryOverrides:{
      ...(row.affinityReviews?.__categoryOverrides && typeof row.affinityReviews.__categoryOverrides==="object"
        ? row.affinityReviews.__categoryOverrides as Record<string,unknown> : {}),
      ...inherited,
    }}} as T;
  });
}

export function inboundCategoryForInterest(selection: string, overrides?: Record<string, unknown> | null, config: InboundCategoryConfig = {rules:[],useBuiltin:true}) {
  const chosen = overrides?.__categoryOverrides;
  const override = chosen && typeof chosen === "object" && !Array.isArray(chosen)
    ? (chosen as Record<string, unknown>)[selection] : undefined;
  if (typeof override === "string" && inboundCategories.includes(override)) {
    return { categoryName: override, productName: selection, subcategoryName: null };
  }
  const exactCategory=inboundCategories.find(category=>category.toLowerCase()===selection.trim().toLowerCase());
  if(exactCategory)return {categoryName:exactCategory,productName:selection,subcategoryName:null};
  if(/^(business workflow|computing) services?$/i.test(selection.trim())){
    return {categoryName:"Business Services",productName:selection,subcategoryName:selection};
  }
  const normalized = selection.toLocaleLowerCase().replace(/\s+/g, " ");
  const customMatches = config.rules.filter(rule => rule.terms.some(term => {
    const needle = term.toLocaleLowerCase().trim().replace(/\s+/g, " ");
    const index = normalized.indexOf(needle);
    return index >= 0 && (index === 0 || !/[\p{L}\p{N}]/u.test(normalized[index - 1]))
      && (index + needle.length === normalized.length || !/[\p{L}\p{N}]/u.test(normalized[index + needle.length]));
  }));
  if (customMatches.length) {
    const categories = new Set(customMatches.map(rule => rule.categoryName));
    if (categories.size > 1) return {categoryName:"Needs categorization",productName:selection,subcategoryName:null};
    return {categoryName:customMatches[0].categoryName,productName:selection,subcategoryName:null};
  }
  if (!config.useBuiltin) return {categoryName:"Needs categorization",productName:selection,subcategoryName:null};
  // Explicit product phrases take precedence over broad words such as "security".
  const matches = inboundTaxonomy.flatMap(group => group.products
    .filter(product => product.pattern.test(selection))
    .map(product => ({ categoryName: group.category, productName: product.name,
      subcategoryName: "subcategory" in product ? product.subcategory : null })));
  if (!matches.length) return { categoryName: "Needs categorization", productName: selection, subcategoryName: null };
  if (matches.length > 1 && new Set(matches.map(match => match.categoryName)).size > 1) {
    // "Printing security software" is a workflow service, not endpoint security.
    if (/\b(print|printing)\b/i.test(selection)) return matches.find(match => match.categoryName === "Business Services")!;
    return { categoryName: "Needs categorization", productName: selection, subcategoryName: null };
  }
  return matches[0];
}