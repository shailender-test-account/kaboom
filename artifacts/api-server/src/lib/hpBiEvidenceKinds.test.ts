import { expect, it } from "vitest";
import { hpEvidenceKindMatches } from "./hpBiEvidenceKinds";
const record = { kind: "digital", contactId: 7, status: null, orderValue: null, currency: null };
it("returns identified touchpoint evidence for engaged contacts, never leads or anonymous events", () => {
  expect(hpEvidenceKindMatches(record, "engaged_contacts")).toBe(true);
  expect(hpEvidenceKindMatches({ ...record, kind: "lead" }, "engaged_contacts")).toBe(false);
  expect(hpEvidenceKindMatches({ ...record, contactId: null }, "engaged_contacts")).toBe(false);
  expect(hpEvidenceKindMatches({ ...record, contactId: null }, "touchpoint")).toBe(true);
});
it("shows only actual Hot leads, not Hot status on other record types", () => {
  expect(hpEvidenceKindMatches({ ...record, kind: "lead", status: "hot" }, "hot")).toBe(true);
  expect(hpEvidenceKindMatches({ ...record, kind: "lead", status: "warm" }, "hot")).toBe(false);
  expect(hpEvidenceKindMatches({ ...record, status: "hot" }, "hot")).toBe(false);
});
it("keeps each other funnel stage scoped to its record type", () => {
  expect(hpEvidenceKindMatches({ ...record, kind: "lead" }, "lead")).toBe(true);
  expect(hpEvidenceKindMatches(record, "lead")).toBe(false);
  expect(hpEvidenceKindMatches({ ...record, kind: "opportunity" }, "opportunity")).toBe(true);
  expect(hpEvidenceKindMatches(record, "opportunity")).toBe(false);
});
