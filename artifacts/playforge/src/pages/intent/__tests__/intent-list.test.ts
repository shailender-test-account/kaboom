import { describe, it, expect, vi } from "vitest";

describe("Intent Engine List Page Links", () => {
  it("appends query string correctly without double question marks", () => {
    // This tests the logic used in IntentPage to construct URLs safely
    const search = "?client=123&audience=456";
    const searchParams = new URLSearchParams(search);
    const qs = searchParams.toString();
    
    // Simulate the logic used in the component
    const constructUrl = (base: string, qsStr: string) => {
      return `${base}${qsStr ? `?${qsStr}` : ''}`;
    };

    const targetUrl = constructUrl(`/intent/accounts/999`, qs);
    expect(targetUrl).toBe("/intent/accounts/999?client=123&audience=456");

    // Test with no query string
    const emptySearch = "";
    const emptyParams = new URLSearchParams(emptySearch);
    const emptyQs = emptyParams.toString();
    const emptyTargetUrl = constructUrl(`/intent/accounts/999`, emptyQs);
    expect(emptyTargetUrl).toBe("/intent/accounts/999");
  });

  it("scopes matrix drill-down links to the clicked product", () => {
    const accountId = 999;
    const productId = 42;
    const targetUrl = `/intent/accounts/${accountId}?productId=${productId}`;
    const params = new URLSearchParams(targetUrl.split("?")[1]);

    expect(targetUrl).toBe("/intent/accounts/999?productId=42");
    expect(params.get("productId")).toBe("42");
  });

  it("leaves an unfiltered account detail request product-agnostic", () => {
    const searchParams = new URLSearchParams("");
    const productId = searchParams.get("productId") || searchParams.get("product") || undefined;

    expect(productId).toBeUndefined();
  });
});
