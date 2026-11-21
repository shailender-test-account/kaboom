import { describe, expect, it, vi } from "vitest";
vi.mock("@workspace/db", () => ({ pool: { query: vi.fn() } }));
import { pool } from "@workspace/db";
import { loadHpMonitoringContext, monitoringContextFromRows, type MonitoringRow } from "./hpMonitoringContext";
import { RESEARCH_FITMENT_POLICY_VERSION } from "./researchOpportunityInterpreter";

const row = (override: Partial<MonitoringRow> = {}): MonitoringRow => ({
  account_id: 1, account_name: "India account", last_checked_at: "2026-10-15T10:00:00Z",
  run_status: "completed", evidence_id: 1, occurred_at: "2026-10-10T10:00:00Z",
  excerpt: "India account announced a new Hyderabad office.", source_url: "https://example.com/project",
  context: {}, brief: null, ...override,
});
const brief = (tier: string, url = "https://example.com/project") => ({
  fitmentPolicyVersion: RESEARCH_FITMENT_POLICY_VERSION, whyNow: "A specific new office in Hyderabad is announced.",
  entryOffer: "Validate project owner and timing.",
  categoryConclusions: [{ categoryName: "IT Hardware", tier, rationale: "Saved project assessment.", sourceUrls: [url] }],
});
describe("HP monitoring account context", () => {
  it("keeps identical validated findings in scoring-only mode without building research cards", () => {
    const now = new Date("2026-10-15");
    const rows = [
      row({ brief: brief("warm") }),
      row({ evidence_id: 2, source_url: "https://example.com/second", brief: brief("hot", "https://example.com/second") }),
      row({ evidence_id: 3, source_url: "https://example.com/unrelated", raw_evidence: { excerpt: "Other business expanded in London." } }),
    ];
    const full = monitoringContextFromRows(rows, now);
    const scoring = monitoringContextFromRows(rows, now, false);
    expect(scoring.map(account => account.findings)).toEqual(full.map(account => account.findings));
    expect(scoring[0].takeaways).toBeUndefined();
    expect(scoring[0].sourceEvidence).toBeUndefined();
    expect(full[0].sourceEvidence).toBeDefined();
  });
  it("uses the shared source validation and exposes solution takeaways with original excerpts", () => {
    const result = monitoringContextFromRows([row({
      excerpt: "AI-rewritten company India expansion.",
      raw_evidence: { excerpt: "India account announced a new Hyderabad office.", context: { publishedDate: "2026-10-09" } },
    })], new Date("2026-10-15"));
    expect(result[0].takeaways?.map(point => point.category)).toEqual(["IT Hardware", "Business Collaboration", "Business Services"]);
    expect(result[0].sourceEvidence?.[0].summary).toBe("India account announced a new Hyderabad office.");
    expect(result[0].sourceEvidence?.[0].publishedAt).toBe("2026-10-09T00:00:00.000Z");
    expect(result[0].takeaways?.[0].evidenceIds).toEqual([1]);
    const rejected = monitoringContextFromRows([row({
      excerpt: "India account new Hyderabad office.",
      raw_evidence: { excerpt: "Another company India new Hyderabad office.", context: {} },
    })], new Date("2026-10-15"));
    expect(rejected[0].takeaways).toEqual([]);
    expect(rejected[0].findings).toEqual([]);
  });
  it("prioritizes Hot then Warm ahead of newer contextual findings without rescoring", () => {
    const result = monitoringContextFromRows([
      row({ evidence_id: 3, occurred_at: "2026-10-14T10:00:00Z", source_url: "https://example.com/context" }),
      row({ evidence_id: 2, source_url: "https://example.com/warm", brief: brief("warm", "https://example.com/warm") }),
      row({ brief: brief("hot") }),
    ]);
    expect(result[0].findings.map(f => f.heat)).toEqual(["Hot", "Warm", "Cold"]);
    expect(result[0].findings[0].nextAction).toBe("Validate project owner and timing.");
  });
  it("does not promote unrelated citations or old-policy product recommendations", () => {
    expect(monitoringContextFromRows([row({ brief: brief("hot", "https://example.com/unrelated") })])[0].findings[0].heat).toBe("Cold");
    expect(monitoringContextFromRows([row({ brief: { ...brief("hot"), fitmentPolicyVersion: 5 } })])[0].findings[0].categories).toEqual([]);
  });
  it("retains a completed zero-result check without fabricating a category or heat", () => {
    const result = monitoringContextFromRows([row({
      evidence_id: null, occurred_at: null, excerpt: null, source_url: null, brief: null,
    })]);
    expect(result[0]).toMatchObject({
      accountId: 1, runStatus: "completed", lastCheckedAt: "2026-10-15T10:00:00.000Z", findings: [],
    });
  });
  it("projects specific saved products only for supported Hot/Warm conclusions", () => {
    const product = { productId: 31, name: "Device as a Service", rationale: "Managed device need for the new Hyderabad office." };
    const withProduct = (tier: string, url = "https://example.com/project") => {
      const value = brief(tier, url);
      return { ...value, categoryConclusions: value.categoryConclusions.map(c => ({
        ...c, categoryName: "Business Services", recommendedProducts: [product],
      })) };
    };
    expect(monitoringContextFromRows([row({ brief: withProduct("warm") })])[0].findings[0].categories[0])
      .toMatchObject({ name: "Business Services", heat: "Warm", products: [product] });
    expect(monitoringContextFromRows([row({ brief: withProduct("cold") })])[0].findings[0].categories[0].products).toEqual([]);
    expect(monitoringContextFromRows([row({ brief: withProduct("warm", "https://example.com/other") })])[0].findings[0].categories).toEqual([]);
    expect(monitoringContextFromRows([row({ brief: brief("warm") })])[0].findings[0].categories[0].products).toEqual([]);
  });
  it("bounds critical findings to three distinct supporting sources", () => {
    const rows = Array.from({ length: 6 }, (_, index) => row({
      evidence_id: index + 1, source_url: `https://example.com/${index}`,
      brief: brief(index === 5 ? "hot" : "warm", `https://example.com/${index}`),
    }));
    const findings = monitoringContextFromRows(rows)[0].findings;
    expect(findings).toHaveLength(3);
    expect(findings[0].heat).toBe("Hot");
  });
  it("rejects global context even when account name, query and derived brief mention India", () => {
    const result = monitoringContextFromRows([row({
      excerpt: "The company is restructuring its UK operation.",
      context: { country: "India", query: "India expansion", opportunityBrief: { whyNow: "India opportunity" } },
      brief: brief("hot"),
    })]);
    expect(result[0].findings).toEqual([]);
    expect(result[0].lastCheckedAt).toBe("2026-10-15T10:00:00.000Z");
  });
  it("keeps legal accounts separate, deduplicates sources and rejects unsafe URLs", () => {
    const result = monitoringContextFromRows([row(), row({ evidence_id: 2 }), row({ account_id: 2, account_name: "Other", source_url: "javascript:alert(1)" })]);
    expect(result).toHaveLength(2);
    expect(result.find(a => a.accountId === 1)?.findings).toHaveLength(1);
    expect(result.find(a => a.accountId === 2)?.findings).toEqual([]);
  });
  it("bounds reads to owned members and approved fresh research without rescoring tagged evidence", async () => {
    vi.mocked(pool.query).mockResolvedValue({ rows: [] } as never);
    await loadHpMonitoringContext(7, 9, [101, 102]);
    const [sql, params] = vi.mocked(pool.query).mock.calls.at(-1)!;
    expect(params).toEqual([7, 9, [101, 102]]);
    expect(sql).toContain("co.tenant_id=$1 AND co.client_id=$2");
    expect(sql).toContain("ev.review_status='approved'");
    // Product matching on an evidence row is not a restriction on viewing its
    // account context. The read-only BI projection never recomputes global scores.
    expect(sql).not.toContain("ev.product_id IS NULL");
    expect(sql).toContain("interval '3 months'");
    expect(sql).toContain("LIMIT 30");
    expect(sql).toContain("COALESCE(run.last_completed_at,co.last_researched_at)");
    expect(sql).toContain("FILTER (WHERE a.status='completed')");
    expect(sql).not.toContain("hp_bi_records");
  });
  it("omits heavyweight discovery payloads and run-history scans for scoring-only reads", async () => {
    vi.mocked(pool.query).mockResolvedValue({ rows: [] } as never);
    await loadHpMonitoringContext(7, 9, [101, 102], false);
    const [sql, params] = vi.mocked(pool.query).mock.calls.at(-1)!;
    expect(params).toEqual([7, 9, [101, 102]]);
    expect(sql).toContain("WHERE false AND a.tenant_id=co.tenant_id");
    expect(sql).not.toContain("ev.context AS context");
    expect(sql).toContain("'scope',ev.context->'scope'");
    expect(sql).toContain("'sourceTitle',ev.context->'sourceTitle'");
    expect(sql).toContain("'excerpt',ev.raw_evidence->'excerpt'");
    const briefSql = vi.mocked(pool.query).mock.calls.map(call => String(call[0])).find(query => query.includes("AS value") && query.includes("categoryConclusions"));
    expect(briefSql).toContain("'fitmentPolicyVersion',ev.context->'opportunityBrief'->'fitmentPolicyVersion'");
    expect(briefSql).toContain("'whyNow',ev.context->'opportunityBrief'->'whyNow'");
    expect(briefSql).toContain("'categoryConclusions',ev.context->'opportunityBrief'->'categoryConclusions'");
    expect(sql).toContain("ev.review_status='approved'");
    expect(sql).toContain("ev.raw_evidence");
  });
  it("does not fetch articles to calculate zero points from Cold or obsolete briefs", async () => {
    vi.mocked(pool.query).mockClear();
    vi.mocked(pool.query)
      .mockResolvedValueOnce({ rows: [] } as never)
      .mockResolvedValueOnce({ rows: [] } as never)
      .mockResolvedValueOnce({ rows: [
        { account_id: 101, brief: brief("cold") },
        { account_id: 102, brief: { ...brief("hot"), fitmentPolicyVersion: 0 } },
      ] } as never);
    expect(await loadHpMonitoringContext(7, 9, [101, 102], "priority")).toEqual([]);
    expect(vi.mocked(pool.query).mock.calls).toHaveLength(3);
    expect(vi.mocked(pool.query).mock.calls.some(call => String(call[0]).includes("AS evidence_id"))).toBe(false);
  });
  it("recognizes a directly opened research identity as the parent, without a fake pending parent panel", async () => {
    vi.mocked(pool.query)
      .mockResolvedValueOnce({rows:[{company_id:99,parent_key:"company:99",parent_name:"Genpact"}]} as never)
      .mockResolvedValueOnce({rows:[{account_id:99,parent_key:"hp-top:10",parent_name:"GENPACT - WW"}]} as never)
      .mockResolvedValueOnce({rows:[]} as never)
      .mockResolvedValueOnce({rows:[row({account_id:99,account_name:"GENPACT",evidence_id:null})]} as never);
    const result = await loadHpMonitoringContext(7,9,[99]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({accountId:99,researchScope:"parent",runStatus:"completed"});
    expect(result[0].lastCheckedAt).not.toBeNull();
    expect(vi.mocked(pool.query).mock.calls.at(-3)?.[1]).toEqual([7,9,["company:99"],[99]]);
  });
  it("loads retained member sources when a parent identity is opened, preserving each account's attribution",async()=>{
    vi.mocked(pool.query)
      .mockResolvedValueOnce({rows:[{company_id:99,parent_key:"company:99",parent_name:"Parent"}]} as never)
      .mockResolvedValueOnce({rows:[{account_id:99,parent_key:"hp-top:10",parent_name:"Parent"}]} as never)
      .mockResolvedValueOnce({rows:[{company_id:1}]} as never)
      .mockResolvedValueOnce({rows:[{company_id:1,parent_key:"hp-top:10",parent_name:"Parent"}]} as never)
      .mockResolvedValueOnce({rows:[row({account_id:99,account_name:"Parent",evidence_id:null}),row()]} as never);
    const result=await loadHpMonitoringContext(7,9,[99]);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({accountId:99,researchScope:"parent",memberAccountIds:[1]});
    expect(result[0].findings).toHaveLength(0);
    expect(result[1]).toMatchObject({accountId:1,researchScope:"member"});
    expect(result[1].findings).toHaveLength(1);
    expect(vi.mocked(pool.query).mock.calls.at(-1)?.[1]).toEqual([7,9,[99,1]]);
  });
});
