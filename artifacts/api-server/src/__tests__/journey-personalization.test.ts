/**
 * Unit tests for journey page personalisation: resolveTokens and resolvePageContent.
 *
 * Key invariant: anonymous visitors (tokenMap = {}) must see fallback text, never raw {{…}} literals.
 */
import { describe, it, expect, vi } from "vitest";

// ── Module mocks required by publicJourneys.ts top-level imports ───────────────
vi.mock("@workspace/db", () => ({
  db: { execute: vi.fn(), select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(() => []) })) })) },
  pool: { query: vi.fn() },
  journeysTable: {},
  journeyPagesTable: {},
  clientsTable: {},
  contactsTable: {},
  playsTable: {},
}));
vi.mock("../lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../lib/intentScoring", () => ({ computeIntentScore: vi.fn() }));
vi.mock("../lib/advanceStage", () => ({ advanceStageInDB: vi.fn() }));
vi.mock("../lib/mergeAnonymousContact", () => ({ mergeAnonymousContact: vi.fn() }));
vi.mock("jsonwebtoken", () => ({
  default: { sign: vi.fn(() => "tok"), verify: vi.fn(() => null) },
}));

import { resolveTokens, resolvePageContent } from "../routes/publicJourneys";

// ── resolveTokens ────────────────────────────────────────────────────────────
describe("resolveTokens", () => {
  it("substitutes a known token from the map", () => {
    expect(resolveTokens("Hello {{firstName}}", { firstName: "Sarah" })).toBe("Hello Sarah");
  });

  it("returns the fallback when the token is missing from the map", () => {
    expect(resolveTokens("Hello {{firstName|there}}", {})).toBe("Hello there");
  });

  it("returns empty string for a token with no fallback when map is empty", () => {
    expect(resolveTokens("Hello {{firstName}}", {})).toBe("Hello ");
  });

  it("returns empty string for a token whose value is empty string", () => {
    expect(resolveTokens("Hi {{firstName|friend}}", { firstName: "" })).toBe("Hi friend");
  });

  it("substitutes multiple tokens in one string", () => {
    const map = { firstName: "Ali", companyName: "Acme" };
    expect(resolveTokens("Hi {{firstName}}, welcome from {{companyName}}!", map)).toBe(
      "Hi Ali, welcome from Acme!"
    );
  });

  it("handles null / undefined input gracefully", () => {
    expect(resolveTokens(null, {})).toBe("");
    expect(resolveTokens(undefined, {})).toBe("");
  });

  it("accepts snake_case aliases", () => {
    const map = { first_name: "Jo" };
    expect(resolveTokens("Hey {{first_name}}", map)).toBe("Hey Jo");
  });
});

// ── resolvePageContent — anonymous visitor (empty tokenMap) ───────────────────
describe("resolvePageContent — anonymous visitor (tokenMap = {})", () => {
  it("replaces {{token|fallback}} in page title with fallback", () => {
    const page = { pageType: "html", title: "Hi {{firstName|there}}", content: "<p>body</p>", ctaText: null };
    const result = resolvePageContent(page, {});
    expect(result.title).toBe("Hi there");
    expect(result.title).not.toContain("{{");
  });

  it("replaces {{token|fallback}} in HTML page content with fallback", () => {
    const page = {
      pageType: "html",
      title: "Page",
      content: "<h1>Welcome {{firstName|there}}, from {{companyName|your company}}</h1>",
      ctaText: null,
    };
    const result = resolvePageContent(page, {});
    expect(result.content).toBe("<h1>Welcome there, from your company</h1>");
    expect(result.content).not.toContain("{{");
  });

  it("removes tokens with no fallback from HTML content (no raw literals leaked)", () => {
    const page = {
      pageType: "html",
      title: "Page",
      content: "<p>Hello {{firstName}}</p>",
      ctaText: null,
    };
    const result = resolvePageContent(page, {});
    expect(result.content).not.toContain("{{");
    expect(result.content).toBe("<p>Hello </p>");
  });

  it("replaces tokens in blocks page — headline, text, list, button blocks", () => {
    const blocks = {
      blocks: [
        { id: "1", type: "headline", level: 1, text: "Welcome {{firstName|Visitor}}" },
        { id: "2", type: "text",     text: "You work at {{companyName|your organisation}}" },
        { id: "3", type: "list",     style: "bullet", items: ["Hello {{firstName|there}}", "From {{industry|your sector}}"] },
        { id: "4", type: "button",   text: "Click {{firstName|here}}", url: "https://example.com", style: "primary", align: "left" },
      ],
    };
    const page = { pageType: "blocks", title: "Page", content: JSON.stringify(blocks), ctaText: null };
    const result = resolvePageContent(page, {});
    const parsed = JSON.parse(result.content);
    expect(parsed.blocks[0].text).toBe("Welcome Visitor");
    expect(parsed.blocks[1].text).toBe("You work at your organisation");
    expect(parsed.blocks[2].items).toEqual(["Hello there", "From your sector"]);
    expect(parsed.blocks[3].text).toBe("Click here");
    // No raw token literals anywhere
    expect(result.content).not.toContain("{{");
  });

  it("replaces tokens in blocks header and footer", () => {
    const blocks = {
      header: { show: true, title: "Hello {{firstName|there}}", subtitle: "From {{companyName|your company}}" },
      footer: { show: true, text: "Regards, {{firstName|team}}" },
      blocks: [],
    };
    const page = { pageType: "blocks", title: "Page", content: JSON.stringify(blocks), ctaText: null };
    const result = resolvePageContent(page, {});
    const parsed = JSON.parse(result.content);
    expect(parsed.header.title).toBe("Hello there");
    expect(parsed.header.subtitle).toBe("From your company");
    expect(parsed.footer.text).toBe("Regards, team");
    expect(result.content).not.toContain("{{");
  });

  it("does not alter non-text page types (pdf, youtube, iframe)", () => {
    for (const pageType of ["pdf", "youtube", "iframe"] as const) {
      const page = { pageType, title: "{{firstName|Friend}}", content: "https://example.com/asset", ctaText: null };
      const result = resolvePageContent(page, {});
      // Title should still resolve
      expect(result.title).toBe("Friend");
      // Content should be left as-is (no substitution attempted on URLs)
      expect(result.content).toBe("https://example.com/asset");
    }
  });
});

// ── resolvePageContent — identified visitor ───────────────────────────────────
describe("resolvePageContent — identified visitor", () => {
  const tokenMap = {
    firstName: "Sarah", lastName: "Chen",
    companyName: "Acme Corp", industry: "SaaS",
    email: "sarah@acme.com", jobTitle: "VP Sales",
    first_name: "Sarah", last_name: "Chen",
    company_name: "Acme Corp", title: "VP Sales",
  };

  it("substitutes first name into HTML page content", () => {
    const page = {
      pageType: "html",
      title: "Page",
      content: "<h1>Hi {{firstName|there}}, welcome to the {{companyName|portal}}!</h1>",
      ctaText: null,
    };
    const result = resolvePageContent(page, tokenMap);
    expect(result.content).toBe("<h1>Hi Sarah, welcome to the Acme Corp!</h1>");
  });

  it("substitutes tokens in blocks page headline and text", () => {
    const blocks = {
      blocks: [
        { id: "1", type: "headline", level: 1, text: "Hello {{firstName|there}}" },
        { id: "2", type: "text", text: "Industry: {{industry|technology}}" },
      ],
    };
    const page = { pageType: "blocks", title: "{{firstName|Guest}} Overview", content: JSON.stringify(blocks), ctaText: null };
    const result = resolvePageContent(page, tokenMap);
    const parsed = JSON.parse(result.content);
    expect(result.title).toBe("Sarah Overview");
    expect(parsed.blocks[0].text).toBe("Hello Sarah");
    expect(parsed.blocks[1].text).toBe("Industry: SaaS");
  });
});
