import { expect, it } from "vitest";
import { calculateAccountPriority as score, freshness, purchaseWindowEnd, type PriorityForm } from "./hpAccountPriority";
const now = new Date("2026-11-01T12:00:00Z");
const daysAgo = (n: number) => new Date(+now - n * 86400000).toISOString();
const form = (months = 3, days = 0): PriorityForm => ({
  accountId: 1, contactId: 1, product: "HP Device as a Service", months, at: daysAgo(days), reference: "inbound:1",
});
it("uses 65/25/10, strongest form, not an average of contacts", () => {
  const result = score([form(), form(6), { ...form(), product: "" }], [
    { accountId: 1, contactId: 1, stage: "action", at: daysAgo(0) },
  ], [{ accountId: 1, heat: "Hot", at: daysAgo(0), url: "https://news.test/1", products: [] }], now);
  expect(result).toMatchObject({ score: 100, forms: 65, journey: 25, monitoring: 10, status: "Hot", declaredQualification: "Hot" });
});
it("keeps a new Warm form Warm and eligible", () => {
  expect(score([form(6)], [], [], now)).toMatchObject({ score: 45.5, status: "Warm", warmForm: true });
});
it("does not add duplicate forms or repeated news", () => {
  const signal = { accountId: 1, heat: "Warm" as const, at: daysAgo(0), url: "https://news.test/1", products: [] };
  expect(score([form(), form()], [], [signal, signal], now).score).toBe(score([form()], [], [signal], now).score);
});
it("does not make browsing or monitoring alone Warm or Hot", () => {
  const activity = { accountId: 1, contactId: 1, stage: "action", at: daysAgo(0) };
  const signal = { accountId: 1, heat: "Hot" as const, at: daysAgo(0), url: "https://news.test", products: [] };
  expect(score([], [activity], [], now).status).toBe("Cold");
  expect(score([], [], [signal], now).status).toBe("Cold");
  expect(score([], [activity], [signal], now)).toMatchObject({ score: 35, status: "Warm", declaredQualification: "Cold" });
});
it("requires fresh explicit evidence for Hot, even above 65", () => {
  const result = score([form(6)], [{ accountId: 1, contactId: 1, stage: "action", at: daysAgo(0) }],
    [{ accountId: 1, heat: "Hot", at: daysAgo(0), url: "https://news.test", products: [] }], now);
  expect(result).toMatchObject({ score: 80.5, status: "Warm" });
});
it("applies the exact grace and half-life boundaries", () => {
  expect(freshness(daysAgo(30), 30, 60, now)).toBe(1);
  expect(freshness(daysAgo(90), 30, 60, now)).toBe(.5);
  expect(freshness(daysAgo(44), 14, 30, now)).toBe(.5);
  expect(freshness(daysAgo(30), 0, 30, now)).toBe(.5);
  expect(score([form(3, 31)], [], [], now).status).toBe("Warm");
  expect(score([form(6, 100)], [], [], now).status).toBe("Cold");
});
it("marks elapsed purchase windows for reconfirmation without deleting history", () => {
  const original = form(1, 45);
  expect(score([original], [], [], now)).toMatchObject({ needsReconfirmation: true, declaredQualification: "Cold", warmForm: false });
  expect(original.months).toBe(1);
  expect(score([original, form(6)], [], [], now).needsReconfirmation).toBe(false);
});
it("handles month ends, immediate requests and invalid/future dates explicitly", () => {
  expect(purchaseWindowEnd({ ...form(1), at: "2026-01-31T12:00:00Z" })?.toISOString()).toBe("2026-02-28T12:00:00.000Z");
  expect(purchaseWindowEnd(form(0))?.getTime()).toBe(+now + 30 * 86400000);
  expect(score([{ ...form(), at: "invalid" }], [], [], now).score).toBe(0);
  expect(score([{ ...form(), at: daysAgo(-1) }], [], [], now).score).toBe(0);
});
it("decays breadth as well as depth and caps journey contributions", () => {
  const activities = [1, 2, 3, 4, 5].map(contactId => ({ accountId: 1, contactId, stage: "action", at: daysAgo(0) }));
  expect(score([], activities, [], now).journey).toBe(25);
  expect(score([], activities.map(a => ({ ...a, at: daysAgo(104) })), [], now).journey).toBeLessThan(5);
});
it("does not award points for unrecognised stages", () => {
  expect(score([], [{ accountId: 1, contactId: 1, stage: "email_open", at: daysAgo(0) }], [], now).journey).toBe(0);
});
