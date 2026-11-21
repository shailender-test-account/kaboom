export const INTENT_CATEGORY_NAMES = [
  "IT Hardware",
  "Business Collaboration",
  "Security",
  "Business Services",
] as const;

export type IntentCategoryName = typeof INTENT_CATEGORY_NAMES[number];

export function getScopeParams(searchParams: URLSearchParams) {
  const params: Record<string, any> = {
    page: 1,
    pageSize: 50,
  };

  const client = searchParams.get("client");
  if (client && client !== "all") params.clientId = client;

  const audience = searchParams.get("audience");
  if (audience && audience !== "all") params.audienceId = audience;

  const segment = searchParams.get("segment");
  if (segment && segment !== "all") params.segmentId = segment;

  const account = searchParams.get("account");
  if (account && account !== "all") params.accountId = account;

  const categoryName = searchParams.get("categoryName");
  if (categoryName && categoryName !== "all") params.categoryName = categoryName;

  // Keep existing catalog-ID deep links working while new category controls
  // use the shared four-category taxonomy by name.
  const category = searchParams.get("category") || searchParams.get("categories");
  if (!categoryName && category && category !== "all") params.categoryIds = category;

  const subcategory = searchParams.get("subcategory") || searchParams.get("subcategories");
  if (subcategory && subcategory !== "all") params.subcategoryIds = subcategory;

  const product = searchParams.get("product") || searchParams.get("productId");
  if (product && product !== "all") params.productId = product;

  const search = searchParams.get("search");
  if (search) params.search = search;
  const page = Number(searchParams.get("page"));
  if (Number.isSafeInteger(page) && page > 1) params.page = page;

  return params;
}

export function buildScopeQs(params: Record<string, any>): string {
  const qs = new URLSearchParams();
  if (params.clientId) qs.set("client", String(params.clientId));
  if (params.audienceId) qs.set("audience", String(params.audienceId));
  if (params.segmentId) qs.set("segment", String(params.segmentId));
  if (params.accountId) qs.set("account", String(params.accountId));
  if (params.categoryName) qs.set("categoryName", String(params.categoryName));
  else if (params.categoryIds) qs.set("categories", String(params.categoryIds));
  if (params.subcategoryIds) qs.set("subcategories", String(params.subcategoryIds));
  if (params.productId) qs.set("product", String(params.productId));
  if (params.search) qs.set("search", params.search);
  if (Number(params.page) > 1) qs.set("page", String(params.page));
  return qs.toString();
}
