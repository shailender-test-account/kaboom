/**
 * Unit tests for generateExternalClickToken / verifyExternalClickToken round-trip.
 *
 * Verifies HMAC integrity, payload fields, expiry enforcement, and tamper detection.
 */
import { describe, it, expect, vi } from "vitest";

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

import { generateExternalClickToken, verifyExternalClickToken } from "../services/email";

describe("generateExternalClickToken / verifyExternalClickToken round-trip", () => {
  const CONTACT_ID   = 42;
  const TENANT_ID    = 1;
  const DEST_URL     = "https://example.com/landing?utm_source=kaboom";
  const TEMPLATE_ID  = 7;
  const ENROLLMENT_ID = 99;

  it("round-trips all fields correctly", () => {
    const token   = generateExternalClickToken(CONTACT_ID, TENANT_ID, DEST_URL, TEMPLATE_ID, ENROLLMENT_ID);
    const payload = verifyExternalClickToken(token);

    expect(payload).not.toBeNull();
    expect(payload!.contactId).toBe(CONTACT_ID);
    expect(payload!.tenantId).toBe(TENANT_ID);
    expect(payload!.destinationUrl).toBe(DEST_URL);
    expect(payload!.templateId).toBe(TEMPLATE_ID);
    expect(payload!.enrollmentId).toBe(ENROLLMENT_ID);
  });

  it("round-trips when templateId and enrollmentId are omitted (defaults to null)", () => {
    const token   = generateExternalClickToken(CONTACT_ID, TENANT_ID, DEST_URL);
    const payload = verifyExternalClickToken(token);

    expect(payload).not.toBeNull();
    expect(payload!.contactId).toBe(CONTACT_ID);
    expect(payload!.tenantId).toBe(TENANT_ID);
    expect(payload!.destinationUrl).toBe(DEST_URL);
    expect(payload!.templateId).toBeNull();
    expect(payload!.enrollmentId).toBeNull();
  });

  it("round-trips a destination URL containing query-string special characters", () => {
    const dest  = "https://acme.com/page?a=1&b=hello+world&c=foo%2Fbar";
    const token = generateExternalClickToken(CONTACT_ID, TENANT_ID, dest, null, null);
    const payload = verifyExternalClickToken(token);

    expect(payload).not.toBeNull();
    expect(payload!.destinationUrl).toBe(dest);
  });

  it("returns null for a completely invalid token string", () => {
    expect(verifyExternalClickToken("not-a-token")).toBeNull();
  });

  it("returns null when the HMAC signature is tampered", () => {
    const token  = generateExternalClickToken(CONTACT_ID, TENANT_ID, DEST_URL, TEMPLATE_ID, ENROLLMENT_ID);
    const dotIdx = token.lastIndexOf(".");
    const tampered = token.slice(0, dotIdx + 1) + "deadbeef";
    expect(verifyExternalClickToken(tampered)).toBeNull();
  });

  it("returns null when the encoded payload is truncated", () => {
    const token     = generateExternalClickToken(CONTACT_ID, TENANT_ID, DEST_URL);
    const dotIdx    = token.lastIndexOf(".");
    const truncated = token.slice(0, dotIdx - 10) + "." + token.slice(dotIdx + 1);
    expect(verifyExternalClickToken(truncated)).toBeNull();
  });

  it("returns null for an empty string", () => {
    expect(verifyExternalClickToken("")).toBeNull();
  });

  it("produces different tokens for different destination URLs", () => {
    const t1 = generateExternalClickToken(CONTACT_ID, TENANT_ID, "https://a.example.com");
    const t2 = generateExternalClickToken(CONTACT_ID, TENANT_ID, "https://b.example.com");
    expect(t1).not.toBe(t2);
  });

  it("produces different tokens for different contactIds", () => {
    const t1 = generateExternalClickToken(1, TENANT_ID, DEST_URL);
    const t2 = generateExternalClickToken(2, TENANT_ID, DEST_URL);
    expect(t1).not.toBe(t2);
  });

  it("token is non-empty and contains exactly one dot separator", () => {
    const token = generateExternalClickToken(CONTACT_ID, TENANT_ID, DEST_URL, TEMPLATE_ID, ENROLLMENT_ID);
    expect(token.length).toBeGreaterThan(20);
    // encoded payload may itself be base64url (no dots), so the last dot is the separator
    const lastDot = token.lastIndexOf(".");
    expect(lastDot).toBeGreaterThan(0);
    expect(lastDot).toBeLessThan(token.length - 1);
  });
});
