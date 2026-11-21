// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { setPublicJourneySeo } from "./seo";

describe("setPublicJourneySeo", () => {
  beforeEach(() => {
    document.head.innerHTML = "";
    window.history.replaceState(null, "", "/j/security?cid=123#details");
  });

  it("sets canonical public metadata without visitor parameters", () => {
    setPublicJourneySeo({
      journeyName: "Security Services",
      pageTitle: "Protect your organization",
      description: "A practical guide to strengthening enterprise security.",
      canonicalPath: "/play/security/protect-your-organization",
    });

    expect(document.title).toBe("Protect your organization | Security Services");
    expect(document.querySelector('meta[name="robots"]')?.getAttribute("content")).toBe("index, follow");
    expect(document.querySelector('link[rel="canonical"]')?.getAttribute("href"))
      .toBe("http://localhost:3000/play/security/protect-your-organization");
    expect(document.querySelector('meta[property="og:title"]')?.getAttribute("content"))
      .toBe(document.title);
    expect(document.querySelector('script[type="application/ld+json"]')?.textContent)
      .toContain('"@type":"WebPage"');
  });

  it("keeps builder previews out of search results", () => {
    setPublicJourneySeo({
      journeyName: "Draft Journey",
      canonicalPath: "/j-preview/42",
      noIndex: true,
    });

    expect(document.querySelector('meta[name="robots"]')?.getAttribute("content"))
      .toBe("noindex, nofollow");
  });
});