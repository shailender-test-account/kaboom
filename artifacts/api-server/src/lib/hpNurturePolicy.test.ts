import { describe, expect, it } from "vitest";
import { isWarmNurtureContact } from "./hpNurturePolicy";
import type { PriorityForm } from "./hpAccountPriority";

const now = new Date("2026-11-03T08:00:00Z");
const form = (contactId: number, months: number): PriorityForm => ({
  contactId, accountId: 10, product: "HP Security Services", months,
  at: now.toISOString(), reference: `test:${contactId}:${months}`,
});
const evidence = (forms: PriorityForm[]) => ({ forms, activities: [], signals: [] });

describe("Warm-only contact nurture", () => {
  it("routes a current Warm person but never a Hot or Cold person", () => {
    expect(isWarmNurtureContact(1,10,evidence([form(1,6)]),now)).toBe(true);
    expect(isWarmNurtureContact(1,10,evidence([form(1,3)]),now)).toBe(false);
    expect(isWarmNurtureContact(1,10,evidence([form(1,12)]),now)).toBe(false);
  });
  it("never uses a Warm response to bypass the same person's Hot declaration", () => {
    expect(isWarmNurtureContact(1,10,evidence([form(1,6),form(1,3)]),now)).toBe(false);
  });
  it("does not disqualify a Warm colleague merely because another person is Hot", () => {
    const data=evidence([form(1,3),form(2,6)]);
    expect(isWarmNurtureContact(1,10,data,now)).toBe(false);
    expect(isWarmNurtureContact(2,10,data,now)).toBe(true);
    expect(isWarmNurtureContact(3,10,data,now)).toBe(false);
  });
  it("rechecks heat when a Warm person becomes Hot", () => {
    const data=evidence([form(1,6)]);
    expect(isWarmNurtureContact(1,10,data,now)).toBe(true);
    data.forms.push(form(1,1));
    expect(isWarmNurtureContact(1,10,data,now)).toBe(false);
  });
  it("does not qualify monitoring alone or expired declared interest", () => {
    expect(isWarmNurtureContact(1,10,{...evidence([]),signals:[
      {accountId:10,heat:"Hot",at:now.toISOString(),url:"https://example.com",products:["HP Security Services"]},
    ]},now)).toBe(false);
    expect(isWarmNurtureContact(1,10,evidence([{...form(1,6),at:"2025-01-01T08:00:00Z"}]),now)).toBe(false);
  });
});
