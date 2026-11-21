import { describe, expect, it } from "vitest";
import { groupQuestionnaireRecords, linkQuestionnaireRecords } from "./hpSourceEvidence";

const base = { accountId: 10, contactId: 20, occurredAt: "2026-09-23T10:00:00Z" };
const lead = { ...base, id: "hp:1", kind: "lead", externalEventId: "inbound:33" };
const response = { ...base, id: "hp:2", kind: "other", externalEventId: "inbound:33:response" };
describe("questionnaire source presentation", () => {
  it("links a journey form's response and lead without counting them as two displayed interactions",()=>{
    const records=linkQuestionnaireRecords([
      {...base,id:"form:9",kind:"lead"},
      {...base,id:"form:9:response",kind:"other",externalEventId:"form_submission:9"},
    ]);
    expect(records[0].responseRecordId).toBe("form:9:response");
    expect(groupQuestionnaireRecords(records)).toHaveLength(1);
  });
  it("links and groups the exact response projections without changing canonical records", () => {
    const original = [lead, response];
    const linked = linkQuestionnaireRecords(original);
    expect(original).toEqual([lead, response]);
    expect(linked).toHaveLength(2);
    expect(linked[0].responseRecordId).toBe("hp:2");
    expect(linked[1].qualificationRecordId).toBe("hp:1");
    const grouped = groupQuestionnaireRecords(linked);
    expect(grouped).toHaveLength(1);
    expect(grouped[0].relatedRecords?.[0].id).toBe("hp:2");
  });
  it.each([
    { accountId: 11 }, { contactId: 21 }, { occurredAt: "2026-09-24T10:00:00Z" },
    { externalEventId: "inbound:34:response" }, { kind: "attendance" },
  ])("never groups unrelated identity or event context %j", changed => {
    expect(groupQuestionnaireRecords(linkQuestionnaireRecords([lead, { ...response, ...changed }]))).toHaveLength(2);
  });
  it("keeps activity-only and lead-only metric selections", () => {
    const linked = linkQuestionnaireRecords([lead, response]);
    expect(groupQuestionnaireRecords(linked.filter(r => r.kind === "lead"))).toHaveLength(1);
    expect(groupQuestionnaireRecords(linked.filter(r => r.kind === "other"))).toHaveLength(1);
  });
  it("supports non-mirrored inbound references", () => {
    expect(groupQuestionnaireRecords(linkQuestionnaireRecords([
      { ...lead, id: "inbound:33", externalEventId: undefined },
      { ...response, id: "inbound:33:response", externalEventId: undefined },
    ]))).toHaveLength(1);
  });
});
