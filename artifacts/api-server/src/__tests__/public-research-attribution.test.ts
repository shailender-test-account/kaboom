import { describe, expect, it } from "vitest";
import { isUnattributedProcurement, isUnattributedResearch, publicResearchMismatchReason } from "../lib/publicResearchAttribution";

describe("public procurement attribution", () => {
  it("rejects ZeroRisk funding news where Concentrix appears only in social-page biography text", () => {
    const source="ZeroRisk Raises $4M from Elkstone for US Expansion | Startup.eu posted on the topic | LinkedIn — Global Vice President at Concentrix India & Southeast Asia Global Vice President";
    expect(isUnattributedResearch({companyName:"Concentrix",companyDomain:"concentrix.com",
      sourceUrl:"https://www.linkedin.com/posts/startup-zerorisk",eventType:"funding",excerpt:source})).toBe(true);
    expect(isUnattributedResearch({companyName:"Concentrix",companyDomain:"concentrix.com",
      sourceUrl:"https://news.example/zerorisk",eventType:"funding",excerpt:source})).toBe(true);
  });
  it("retains actual account news and a genuine relationship to another company's event", () => {
    for(const excerpt of [
      "Concentrix India reported weaker earnings and announced a cost reduction plan.",
      "Vendor X announced a new endpoint-security contract with Concentrix India.",
    ])expect(isUnattributedResearch({companyName:"Concentrix",sourceUrl:"https://news.example/india",excerpt})).toBe(false);
  });
  it("does not accept an AI-added account name in place of original-source attribution", () => {
    expect(isUnattributedResearch({companyName:"Concentrix",sourceUrl:"https://news.example/funding",
      excerpt:"Concentrix India raised funding.",originalExcerpt:"ZeroRisk raised funding for a US expansion."})).toBe(true);
  });
  const generic = {
    eventType: "procurement",
    excerpt: "eProcurement System Government of India — Tenderers can download the tender schedule and submit bids online.",
    sourceUrl: "https://eprocure.gov.in/eprocure/app?component=$DirectLink&page=Published",
    companyName: "Oracle India",
    companyDomain: "oracle.com",
  };

  it("excludes a generic procurement portal even when its search query named the account", () => {
    expect(isUnattributedProcurement(generic)).toBe(true);
  });

  it("uses the original source rather than an AI summary that added the account name", () => {
    expect(isUnattributedProcurement({
      ...generic,
      excerpt: "Oracle India is procuring equipment",
      originalExcerpt: generic.excerpt,
    })).toBe(true);
  });

  it("retains named tenders, official sources, and explicitly reviewed evidence", () => {
    expect(isUnattributedProcurement({ ...generic, excerpt: "Oracle India invites bids for a network refresh." })).toBe(false);
    expect(isUnattributedProcurement({ ...generic, sourceUrl: "https://www.oracle.com/procurement/current-rfp" })).toBe(false);
    expect(isUnattributedProcurement({ ...generic, manuallyReviewed: true })).toBe(false);
  });

  it("does not reject unrelated non-procurement company news", () => {
    expect(isUnattributedProcurement({ ...generic, eventType: "partnership" })).toBe(false);
  });

  it("flags other event types using the original excerpt instead of an AI summary", () => {
    expect(publicResearchMismatchReason({
      ...generic, eventType: "hiring", originalExcerpt: "A different firm is hiring 500 engineers.",
    })).toContain("hiring");
    expect(publicResearchMismatchReason({
      ...generic, eventType: "hiring", originalExcerpt: "Oracle India hires 500 engineers.",
    })).toBeNull();
  });

  it("does not flag a company-owned source but flags a missing original excerpt", () => {
    expect(publicResearchMismatchReason({
      ...generic, eventType: "partnership", sourceUrl: "https://oracle.com/news/partnership", originalExcerpt: "Our new partner is ACME.",
    })).toBeNull();
    expect(publicResearchMismatchReason({ ...generic, originalExcerpt: "" })).toContain("missing");
  });
});