/**
 * Unit tests for injectAllEmailTrackingLinks.
 *
 * Verifies that /j/<slug> links become journey click-redirect URLs,
 * external http(s) links become external click-redirect URLs,
 * and mailto: / unsubscribe / already-wrapped links are left untouched.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@workspace/db", () => ({
  db: {},
  pool: { query: vi.fn() },
  emailEventsTable: {},
  contactsTable: {},
  sequenceEnrollmentsTable: {},
}));

vi.mock("../lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { injectAllEmailTrackingLinks } from "../services/email";

const BASE_URL = "https://example.kaboom.app";
const CONTACT_ID = 7;
const TENANT_ID = 1;
const TEMPLATE_ID = 3;
const ENROLLMENT_ID = 5;

const opts = { tenantId: TENANT_ID, baseUrl: BASE_URL, templateId: TEMPLATE_ID, enrollmentId: ENROLLMENT_ID };

describe("injectAllEmailTrackingLinks", () => {
  it("wraps /j/<slug> journey links in /api/public/click/<token>", () => {
    const html = `<a href="${BASE_URL}/j/my-campaign-slug">Read more</a>`;
    const result = injectAllEmailTrackingLinks(html, CONTACT_ID, opts);
    expect(result).toMatch(/href="https:\/\/example\.kaboom\.app\/api\/public\/click\/[A-Za-z0-9_\-.]+"/);
    expect(result).not.toContain(`href="${BASE_URL}/j/my-campaign-slug"`);
  });

  it("wraps relative /j/<slug> journey links correctly", () => {
    const html = `<a href="/j/slug-relative">Click</a>`;
    const result = injectAllEmailTrackingLinks(html, CONTACT_ID, opts);
    expect(result).toMatch(/href="https:\/\/example\.kaboom\.app\/api\/public\/click\/[A-Za-z0-9_\-.]+"/);
  });

  it("wraps external https links in /api/public/click-ext/<token>", () => {
    const html = `<a href="https://external-site.com/landing-page">Visit us</a>`;
    const result = injectAllEmailTrackingLinks(html, CONTACT_ID, opts);
    expect(result).toMatch(/href="https:\/\/example\.kaboom\.app\/api\/public\/click-ext\/[A-Za-z0-9_\-.]+"/);
    expect(result).not.toContain("https://external-site.com/landing-page");
  });

  it("wraps external http links in /api/public/click-ext/<token>", () => {
    const html = `<a href="http://promo.example.com/offer">Promo</a>`;
    const result = injectAllEmailTrackingLinks(html, CONTACT_ID, opts);
    expect(result).toMatch(/href="https:\/\/example\.kaboom\.app\/api\/public\/click-ext\/[A-Za-z0-9_\-.]+"/);
  });

  it("wraps protocol-relative links as external click-ext", () => {
    const html = `<a href="//cdn.example.com/asset.pdf">Download</a>`;
    const result = injectAllEmailTrackingLinks(html, CONTACT_ID, opts);
    expect(result).toMatch(/href="https:\/\/example\.kaboom\.app\/api\/public\/click-ext\/[A-Za-z0-9_\-.]+"/);
  });

  it("leaves mailto: links untouched", () => {
    const html = `<a href="mailto:hello@acme.com">Email us</a>`;
    const result = injectAllEmailTrackingLinks(html, CONTACT_ID, opts);
    expect(result).toBe(html);
  });

  it("leaves unsubscribe links untouched", () => {
    const html = `<a href="https://example.kaboom.app/api/unsubscribe?email=x@y.com&token=abc">Unsubscribe</a>`;
    const result = injectAllEmailTrackingLinks(html, CONTACT_ID, opts);
    expect(result).toBe(html);
  });

  it("leaves already-wrapped /api/public/click links untouched", () => {
    const html = `<a href="https://example.kaboom.app/api/public/click/existingToken.sig">Click</a>`;
    const result = injectAllEmailTrackingLinks(html, CONTACT_ID, opts);
    expect(result).toBe(html);
  });

  it("leaves already-wrapped /api/public/click-ext links untouched", () => {
    const html = `<a href="https://example.kaboom.app/api/public/click-ext/existingToken.sig">Link</a>`;
    const result = injectAllEmailTrackingLinks(html, CONTACT_ID, opts);
    expect(result).toBe(html);
  });

  it("leaves anchor-only (#fragment) links untouched", () => {
    const html = `<a href="#section-2">Jump</a>`;
    const result = injectAllEmailTrackingLinks(html, CONTACT_ID, opts);
    expect(result).toBe(html);
  });

  it("leaves links that already carry cid= untouched", () => {
    const html = `<a href="https://external.com/page?cid=99">Already tracked</a>`;
    const result = injectAllEmailTrackingLinks(html, CONTACT_ID, opts);
    expect(result).toBe(html);
  });

  it("leaves honeypot links untouched", () => {
    const html = `<a href="https://example.kaboom.app/api/public/honeypot/someToken.sig" style="display:none"> </a>`;
    const result = injectAllEmailTrackingLinks(html, CONTACT_ID, opts);
    expect(result).toBe(html);
  });

  it("handles HTML with multiple link types correctly in a single pass", () => {
    const html = [
      `<a href="${BASE_URL}/j/slug-a">Journey</a>`,
      `<a href="https://promo.example.com/deal">Promo</a>`,
      `<a href="mailto:support@acme.com">Support</a>`,
      `<a href="${BASE_URL}/api/unsubscribe?email=x@y.com&token=tok">Unsub</a>`,
    ].join("\n");
    const result = injectAllEmailTrackingLinks(html, CONTACT_ID, opts);
    expect(result).toMatch(/\/api\/public\/click\//);
    expect(result).toMatch(/\/api\/public\/click-ext\//);
    expect(result).toContain("mailto:support@acme.com");
    expect(result).toContain("/api/unsubscribe");
  });

  it("returns empty string unchanged", () => {
    expect(injectAllEmailTrackingLinks("", CONTACT_ID, opts)).toBe("");
  });

  // ── knownSlugs guard ────────────────────────────────────────────────────────

  it("routes a known /j/<slug> link through the journey click token when knownSlugs is supplied", () => {
    const html = `<a href="/j/live-campaign">Read</a>`;
    const result = injectAllEmailTrackingLinks(html, CONTACT_ID, {
      ...opts,
      knownSlugs: new Set(["live-campaign"]),
    });
    // Must use the journey click token path, NOT the ext token path
    expect(result).toMatch(/href="https:\/\/example\.kaboom\.app\/api\/public\/click\/[A-Za-z0-9_\-.]+"/);
    expect(result).not.toContain("/api/public/click-ext/");
  });

  it("routes an unknown /j/<slug> link through the external click token when knownSlugs is supplied", () => {
    const html = `<a href="/j/deleted-journey">Read</a>`;
    const result = injectAllEmailTrackingLinks(html, CONTACT_ID, {
      ...opts,
      knownSlugs: new Set(["other-live-slug"]),
    });
    // Unknown slug must go through the external token so the original URL is preserved
    expect(result).toMatch(/href="https:\/\/example\.kaboom\.app\/api\/public\/click-ext\/[A-Za-z0-9_\-.]+"/);
    expect(result).not.toContain("/api/public/click/");
  });

  it("routes all /j/<slug> links through the journey click token when knownSlugs is omitted", () => {
    const html = `<a href="/j/any-slug">Click</a>`;
    const result = injectAllEmailTrackingLinks(html, CONTACT_ID, opts); // no knownSlugs
    expect(result).toMatch(/href="https:\/\/example\.kaboom\.app\/api\/public\/click\/[A-Za-z0-9_\-.]+"/);
    expect(result).not.toContain("/api/public/click-ext/");
  });

  it("routes an empty knownSlugs set as unknown — all /j/ links go through external token", () => {
    const html = `<a href="/j/some-slug">Click</a>`;
    const result = injectAllEmailTrackingLinks(html, CONTACT_ID, {
      ...opts,
      knownSlugs: new Set<string>(), // tenant has no published journeys
    });
    expect(result).toMatch(/href="https:\/\/example\.kaboom\.app\/api\/public\/click-ext\/[A-Za-z0-9_\-.]+"/);
  });

  it("correctly partitions a multi-link email with known and unknown slugs", () => {
    const html = [
      `<a href="/j/live-slug">Live</a>`,
      `<a href="/j/dead-slug">Dead</a>`,
      `<a href="https://external.com/promo">Promo</a>`,
    ].join("\n");
    const result = injectAllEmailTrackingLinks(html, CONTACT_ID, {
      ...opts,
      knownSlugs: new Set(["live-slug"]),
    });
    // live-slug → journey token, dead-slug → ext token, external.com → ext token
    const journeyMatches  = result.match(/\/api\/public\/click\//g) ?? [];
    const extMatches      = result.match(/\/api\/public\/click-ext\//g) ?? [];
    expect(journeyMatches.length).toBe(1);  // only live-slug
    expect(extMatches.length).toBe(2);      // dead-slug + external.com
  });
});
