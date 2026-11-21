import { describe, expect, it } from "vitest";
import type { Deal } from "@workspace/api-client-react";
import { applyStage, buildUpdate, formFromDeal, subtotals, validateForm } from "./deal-utils";

const deal = (o: Partial<Deal> = {}): Deal => ({
  id: 1, tenantId: 1, clientId: 2, title: "T", stage: "closed_won", priority: "medium", createdAt: "", updatedAt: "",
  value: 0, currency: "INR", valueMeaning: "total_order_value", bookedValue: 5, actualOutcomeDate: "2025-01-02",
  opportunityConfirmed: true, actualOpportunityDate: "2024-12-01", ...o,
});

describe("deal utils", () => {
  it("does not resend old outcome facts on won to lost", () => {
    const o = formFromDeal(deal());
    const f = applyStage(o, o, "closed_lost");
    const b = buildUpdate(f, o);
    expect(b.stage).toBe("closed_lost");
    expect(b.actualOutcomeDate).toBeNull();
    expect(b.bookedValue).toBeNull();
  });
  it("clears confirmation for prospect", () => {
    const o = formFromDeal(deal());
    const f = applyStage(o, o, "prospect");
    expect(f.opportunityConfirmed).toBe(false);
    expect(f.actualOpportunityDate).toBe("");
  });
  it("sends nothing for untouched legacy deal and keeps zero", () => {
    const o = formFromDeal(deal());
    expect(buildUpdate(o, o)).toEqual({});
    expect(buildUpdate({ ...o, value: "0.5" }, o).value).toBe(0.5);
  });
  it("requires explicit facts for confirmed opportunity", () => {
    const o = { ...formFromDeal(deal()), stage: "qualified", opportunityConfirmed: true, actualOpportunityDate: "" };
    expect(validateForm(o, false).length).toBeGreaterThan(1);
  });
  it("never mixes currencies or meanings", () => {
    const t = subtotals([deal({ value: 0 }), deal({ currency: "EUR", value: 3 }), deal({ currency: null, valueMeaning: "unknown", value: 1, bookedValue: null })]);
    expect(t.map(s => s.key)).toContain("unknown|unknown currency");
    expect(t.find(s => s.key === "total_order_value|INR")?.amount).toBe(0);
  });
});
