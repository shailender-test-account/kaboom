import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { classifyArticle } from "../lib/intentProviders";
import { isFreshPublicResearchEvidence } from "../lib/researchFreshness";

describe("public research event classification", () => {
  it("keeps customs enforcement and appeal news for opportunity interpretation", () => {
    expect(classifyArticle("Customs authority imposed a penalty and redemption fine over alleged API export misclassification; the company will appeal.")).toBe("regulatory_action");
  });

  it("keeps operational control failures as research evidence", () => {
    expect(classifyArticle("Disclosure was delayed because of an administrative oversight and control failure.")).toBe("operational_risk");
  });

  it("researches the complete selected account set in focused three-month queries", () => {
    const source = readFileSync(new URL("../lib/intentProviders.ts", import.meta.url), "utf8");
    expect(source).toContain("publicResearchCutoff()");
    expect(source).toContain("after:${dateAfter}");
    expect(source).toContain("eventQueryGroups");
    expect(source).toContain('researchWindow: "3_months"');
    expect(source).not.toContain("filter(company => company.name || company.domain).slice(");
    expect(source).toContain("companies.slice(offset, offset + 5)");
  });

  it("rejects recently refreshed pages whose facts are only from an old fiscal year", () => {
    const now = new Date("2026-09-02T00:00:00.000Z");
    expect(isFreshPublicResearchEvidence("Company profile based on FY2024 revenue and profit", "2026-08-28T00:00:00.000Z", now)).toBe(false);
    expect(isFreshPublicResearchEvidence("Q1 FY2027 earnings show current expansion", "2026-08-28T00:00:00.000Z", now)).toBe(true);
  });
});