import { describe, expect, it } from "vitest";
import { monitoringFindingAnalysis } from "../lib/monitoringFindingAnalysis";
import { monitoredAccountContext, type MonitoringFinding } from "../lib/monitoredAccountContext";

const now = new Date("2026-10-15T12:00:00Z");
const base: MonitoringFinding = {
  id: 1, excerpt: "Acme India announced a new Hyderabad office.",
  sourceUrl: "https://example.com/news", occurredAt: "2026-10-10",
  eventType: "branch_opening", reviewStatus: "approved", context: { publishedDate: "2026-10-10" },
};
const account = { name: "Acme", domain: "acme.example" };

describe("read-only monitoring quality", () => {
  it.each([
    [{ excerpt: "" }, "missing_source"],
    [{ excerpt: "Acme India customer stories Learn More" }, "source_furniture"],
    [{ excerpt: "OtherCo India announced a new Hyderabad office." }, "wrong_account"],
    [{ sourceUrl: "javascript:alert(1)" }, "invalid_source"],
    [{ reviewStatus: "pending" }, "not_approved"],
    [{ reviewStatus: "rejected" }, "not_approved"],
    [{ context: { publishedDate: "2025-01-01" } }, "stale_date"],
    [{ context: { publishedDate: "2027-01-01" } }, "invalid_date"],
    [{ excerpt: "Acme announced a new London office." }, "non_selected_country"],
    [{ excerpt: "Acme reported global growth. OtherCo India opened an office." }, "non_selected_country"],
    [{ excerpt: `Acme India announced ${"a ".repeat(650)}new operations.` }, "insufficient_source_evidence"],
  ] as const)("explains excluded evidence %j", (patch, reason) => {
    const result = monitoringFindingAnalysis([{ ...base, ...patch }], now, account);
    expect(result.findings).toEqual([]);
    expect(result.diagnostics).toMatchObject({
      assessedCount: 1, usableCount: 0, excludedCount: 1,
      exclusions: [{ reason, count: 1 }],
    });
  });

  it("keeps limitations separate from exclusions and preserves non-qualifying context", () => {
    const financial = { ...base, excerpt: "Acme India reported quarterly financial results.", context: {} };
    const copy = structuredClone(financial);
    const result = monitoredAccountContext([financial], now, account);
    expect(result).toMatchObject({
      kind: "business_context", possibleNeeds: [],
      diagnostics: { usableCount: 1, excludedCount: 0,
        unverifiedPublicationDateCount: 1, insufficientOperationalEvidenceCount: 1 },
    });
    expect(financial).toEqual(copy);
  });

  it("counts duplicates once and discloses a bounded sample", () => {
    const result = monitoredAccountContext([base, { ...base, id: 2 }], now, account, 150);
    expect(result.diagnostics).toMatchObject({
      assessedCount: 2, storedFindingCount: 150, truncated: true,
      usableCount: 1, excludedCount: 1, exclusions: [{ reason: "duplicate", count: 1 }],
    });
    expect(monitoredAccountContext([], now, account).diagnostics).toMatchObject({
      assessedCount: 0, usableCount: 0, excludedCount: 0, truncated: false, exclusions: [],
    });
  });

  it("uses original evidence rather than rewritten attribution or publication dates", () => {
    const result = monitoringFindingAnalysis([{ ...base,
      raw_evidence: { excerpt: "OtherCo India opened an office.", context: { publishedDate: "2025-01-01" } },
    }], now, account);
    expect(result.diagnostics.exclusions[0].reason).toBe("wrong_account");
    const dated = monitoringFindingAnalysis([{ ...base,
      raw_evidence: { excerpt: base.excerpt, context: { publishedDate: "2025-01-01" } },
    }], now, account);
    expect(dated.diagnostics.exclusions[0].reason).toBe("stale_date");
  });
});
