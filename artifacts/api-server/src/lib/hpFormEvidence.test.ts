import { describe, expect, it } from "vitest";
import { hpFormEvidence } from "./hpBiMetrics";

describe("HP form contributor evidence", () => {
  it("retains generic submissions as evidence, not leads or inferred qualification", () => {
    const record = hpFormEvidence({ id: 10, company_id: 20, contact_id: 30, submitted_at: "2026-07-08T06:00:00Z" }, {});
    expect(record).toMatchObject({ id: "form:10", accountId: 20, contactId: 30, kind: "other", product: null,
      horizonMonths: null, orderValue: null, source: "journey form", status: "form_submitted" });
  });
  it("preserves supplied purchase context and source program without becoming a lead", () => {
    const record = hpFormEvidence({ id: 10, company_id: 20, contact_id: 30, submitted_at: "2026-07-08T06:00:00Z", config: { title: "HP response" } },
      { product: "Laptop", horizonMonths: 3, totalOrderValue: 0, currency: "inr" });
    expect(record).toMatchObject({ kind: "other", product: "Laptop", horizonMonths: 3, orderValue: 0, currency: "INR", sourceName: "HP response" });
  });
});
