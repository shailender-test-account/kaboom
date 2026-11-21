import { afterAll, beforeAll, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { pool } from "@workspace/db";
import { loadHpMonitoringContext } from "./hpMonitoringContext";
import { RESEARCH_FITMENT_POLICY_VERSION } from "./researchOpportunityInterpreter";

let tenant: number, client: number, warm: number, cold: number;
beforeAll(async () => {
  tenant = (await pool.query("INSERT INTO tenants(name,slug) VALUES('Isolated monitoring projection',$1) RETURNING id", [randomUUID()])).rows[0].id;
  client = (await pool.query("INSERT INTO clients(tenant_id,name) VALUES($1,'HP') RETURNING id", [tenant])).rows[0].id;
  warm = (await pool.query("INSERT INTO companies(tenant_id,client_id,name) VALUES($1,$2,'Fixture Labs') RETURNING id", [tenant, client])).rows[0].id;
  cold = (await pool.query("INSERT INTO companies(tenant_id,client_id,name) VALUES($1,$2,'Context Labs') RETURNING id", [tenant, client])).rows[0].id;
  const now = Date.now();
  const insert = async (id: number, n: number, positive: boolean) => {
    const url = `https://example.invalid/article-${n}`;
    const context = {
      country: "India", aiReview: { retainedForAudit: true },
      opportunityBrief: {
        fitmentPolicyVersion: RESEARCH_FITMENT_POLICY_VERSION,
        whyNow: "Fixture Labs confirmed an office expansion in Bengaluru, India.",
        entryOffer: "Validate the local project.",
        categoryConclusions: [{
          categoryName: "IT Hardware", tier: positive ? "warm" : "cold",
          rationale: "Reviewed local expansion.", sourceUrls: ["https://example.invalid/article-0", "https://example.invalid/article-31"],
          recommendedProducts: [{ productId: 1, name: "Workstations", rationale: "Validate local design requirements." }],
        }],
      },
      savedNewsInterpretation: { auditText: "unused narrative ".repeat(1000) },
    };
    await pool.query(`INSERT INTO intent_evidence(tenant_id,account_id,evidence_kind,provider,excerpt,source_url,context,raw_evidence,occurred_at)
      VALUES($1,$2,'public_event','manual',$3,$4,$5::jsonb,$6::jsonb,$7)`,
    [tenant, id, "AI summary: Fixture Labs expanded in India.", url, JSON.stringify(context),
      JSON.stringify({ excerpt: `${positive ? "Fixture" : "Context"} Labs opened a new Bengaluru office in India.`,
        context: { publishedDate: new Date(now - (32 - n) * 60_000).toISOString() },
        unusedArticleBody: "unused provider payload ".repeat(1000) }), new Date(now - (32 - n) * 60_000)]);
  };
  for (let i = 0; i < 32; i++) await insert(warm, i, true);
  await insert(cold, 31, false);
});
afterAll(async () => {
  await pool.query("DELETE FROM intent_evidence WHERE tenant_id=$1", [tenant]);
  await pool.query("DELETE FROM companies WHERE tenant_id=$1", [tenant]);
  await pool.query("DELETE FROM clients WHERE tenant_id=$1", [tenant]);
  await pool.query("DELETE FROM tenants WHERE id=$1", [tenant]);
});

it("preserves contributing findings and the newest-30 boundary without transporting narratives", async () => {
  const full = await loadHpMonitoringContext(tenant, client, [warm, cold], true);
  const narrow = await loadHpMonitoringContext(tenant, client, [warm, cold], false);
  const priority = await loadHpMonitoringContext(tenant, client, [warm, cold], "priority");
  const contributions = (contexts: typeof full) => contexts.flatMap(account => account.findings
    .filter(finding => finding.heat !== "Cold").map(finding => ({ id: account.accountId, ...finding })));
  expect(contributions(narrow)).toEqual(contributions(full));
  expect(contributions(priority)).toEqual(contributions(full));
  expect(contributions(priority)).toHaveLength(1);
  expect(contributions(priority)[0].sourceUrl).toBe("https://example.invalid/article-31");
  expect(contributions(priority).some(finding => finding.sourceUrl.endsWith("article-0"))).toBe(false);
  expect(priority.some(account => account.accountId === cold)).toBe(false);
});
