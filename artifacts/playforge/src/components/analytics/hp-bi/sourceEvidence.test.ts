import { describe, expect, it } from "vitest";
import { combineSourceRecords } from "./sourceEvidence";
import type { HpBiRecord } from "./types";
const a: HpBiRecord = { id: "a", accountId: 1, contactId: 2, kind: "lead", occurredAt: "2026-09-23",
  category: null, product: "HP Laptop", horizonMonths: 3, orderValue: null, currency: null,
  source: "questionnaire", sourceName: null, status: "hot", responseRecordId: "b" };
const b: HpBiRecord = { ...a, id: "b", kind: "other", responseRecordId: undefined, qualificationRecordId: "a" };
describe("combined source records", () => {
  it("shows the lead and retains the companion activity for inspection", () => {
    expect(combineSourceRecords([a, b])).toEqual([{ ...a, relatedRecords: [b] }]);
    expect([a, b]).toHaveLength(2);
  });
  it("does not hide activity when the selected metric excludes the lead", () => {
    expect(combineSourceRecords([b])).toEqual([b]);
    expect(combineSourceRecords([a])).toEqual([a]);
  });
  it("never combines separate submissions by account name or product", () => {
    expect(combineSourceRecords([a, { ...b, id: "different", qualificationRecordId: undefined }])).toHaveLength(2);
  });
});
