import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@workspace/db";
import { applyResearchCorrection, proposeResearchCorrection, refreshCorrectedResearch } from "../lib/researchFindingCorrection";
import { isUnattributedProcurement } from "../lib/publicResearchAttribution";

let tenantId: number, accountId: number, productId: number, hiringTypeId: number, layoffsTypeId: number;
const companyName = "Correction Integration India";
const actor = () => ({ id: 791, tenantId, role: "admin" });

beforeAll(async () => {
  tenantId = (await pool.query(`INSERT INTO tenants(name,slug) VALUES($1,$2) RETURNING id`,
    ["Research correction integration", `correction-${randomUUID()}`])).rows[0].id;
  const clientId = (await pool.query(`INSERT INTO clients(tenant_id,name) VALUES($1,$2) RETURNING id`,
    [tenantId, "Isolated correction client"])).rows[0].id;
  accountId = (await pool.query(`INSERT INTO companies(tenant_id,client_id,name,domain) VALUES($1,$2,$3,$4) RETURNING id`,
    [tenantId, clientId, companyName, "correction-fixture.example"])).rows[0].id;
  const categoryId = (await pool.query(`INSERT INTO intent_product_categories(tenant_id,name) VALUES($1,'IT Hardware') RETURNING id`,
    [tenantId])).rows[0].id;
  productId = (await pool.query(`INSERT INTO intent_products(tenant_id,category_id,name) VALUES($1,$2,'Business Laptops') RETURNING id`,
    [tenantId, categoryId])).rows[0].id;
  for (const key of ["hiring", "layoffs", "procurement"]) {
    const id = (await pool.query(`INSERT INTO intent_signal_types(tenant_id,key,label,max_points,half_life_days)
      VALUES($1,$2,$2,50,90) RETURNING id`, [tenantId, key])).rows[0].id;
    if (key === "hiring") hiringTypeId = id;
    if (key === "layoffs") layoffsTypeId = id;
  }
});
afterEach(async () => {
  await pool.query("DELETE FROM intent_research_corrections WHERE tenant_id=$1", [tenantId]);
  await pool.query("DELETE FROM intent_evidence WHERE tenant_id=$1", [tenantId]);
  await pool.query("DELETE FROM intent_signals WHERE tenant_id=$1", [tenantId]);
});
afterAll(async () => {
  if (tenantId) {
    for (const table of ["intent_research_corrections", "intent_evidence", "intent_signals", "intent_signal_types",
      "intent_products", "intent_product_categories", "companies", "clients"]) {
      await pool.query(`DELETE FROM ${table} WHERE tenant_id=$1`, [tenantId]);
    }
    await pool.query("DELETE FROM tenants WHERE id=$1", [tenantId]);
  }
  await pool.end();
});
async function seed(eventType: string, sourceFact: string, reviewedBy: number | null = null) {
  const context = { country: "India", searchKind: eventType === "procurement" ? "tenders" : "news",
    aiReview: { signalType: eventType, catalogProductIds: [productId],
      fitments: [{ productId, productName: "Business Laptops", category: "IT Hardware", points: 90, level: "direct_intent" }] } };
  const evidenceId = (await pool.query(`INSERT INTO intent_evidence
    (tenant_id,account_id,product_id,evidence_kind,event_type,source_url,excerpt,provider,confidence,context,raw_evidence,review_status,reviewed_by,reviewed_at)
    VALUES($1,$2,$3,'public_event',$4,'https://unrelated-source.example/india', $5,'fixture',90,$6::jsonb,$7::jsonb,'approved',$8,
      CASE WHEN $8::int IS NULL THEN NULL ELSE NOW()-interval '1 day' END) RETURNING id`, [
    tenantId, accountId, productId, eventType, `${companyName} needs new laptops.`,
    JSON.stringify(context), JSON.stringify({ excerpt: sourceFact }), reviewedBy,
  ])).rows[0].id;
  const signalId = (await pool.query(`INSERT INTO intent_signals(tenant_id,account_id,product_id,signal_type_id,source,payload)
    VALUES($1,$2,$3,$4,'public_event',$5::jsonb) RETURNING id`,
  [tenantId, accountId, productId, hiringTypeId, JSON.stringify({ evidenceId })])).rows[0].id;
  await pool.query("UPDATE intent_evidence SET signal_id=$1 WHERE tenant_id=$2 AND id=$3", [signalId, tenantId, evidenceId]);
  return evidenceId;
}
async function correct(evidenceId: number) {
  const proposal = await proposeResearchCorrection(actor(), accountId, evidenceId);
  const result = await applyResearchCorrection(actor(), accountId, {
    evidenceId, proposalId: proposal.proposalId, sourceVersion: proposal.sourceVersion,
    approved: true, reason: "Reviewed original source and exact changes",
  });
  return { proposal, result };
}
async function evidence(evidenceId: number) {
  return (await pool.query("SELECT * FROM intent_evidence WHERE tenant_id=$1 AND id=$2", [tenantId, evidenceId])).rows[0];
}

describe("real database research correction permissions and classification", () => {
  it("does not turn fitment approval into attribution approval for an unrelated tender", async () => {
    const fact = "Government of India requests quotations for 500 business laptops within 30 days.";
    const evidenceId = await seed("procurement", fact);
    const before = await evidence(evidenceId);
    await correct(evidenceId);
    await refreshCorrectedResearch(tenantId, accountId);
    const after = await evidence(evidenceId);
    expect(after.reviewed_by).toBe(before.reviewed_by);
    expect(after.reviewed_at).toBe(before.reviewed_at);
    expect(after.raw_evidence).toEqual(before.raw_evidence);
    expect(isUnattributedProcurement({
      eventType: after.event_type, searchKind: after.context.searchKind, excerpt: after.excerpt,
      originalExcerpt: after.raw_evidence.excerpt, sourceUrl: after.source_url,
      companyName, companyDomain: "correction-fixture.example", manuallyReviewed: after.reviewed_by != null,
    })).toBe(true);
    expect(after.context.opportunityBrief).toBeUndefined();
    const audit = (await pool.query("SELECT * FROM intent_research_corrections WHERE tenant_id=$1", [tenantId])).rows[0];
    expect(audit.status).toBe("applied");
    expect(audit.approved_by).toBe(actor().id);
  });
  it("aligns evidence, replacement signal type and aiReview for layoffs with a retained source-backed fitment", async () => {
    const evidenceId = await seed("hiring", `${companyName} will cut 2,000 jobs. ${companyName} needs to replace 500 employee laptops and requests quotations within 30 days.`, 412);
    const before = await evidence(evidenceId);
    const { proposal } = await correct(evidenceId);
    expect(proposal.proposed.fitments.map(fit => fit.productId)).toContain(productId);
    const after = await evidence(evidenceId);
    const signal = (await pool.query(`SELECT s.*,st.key FROM intent_signals s JOIN intent_signal_types st
      ON st.tenant_id=s.tenant_id AND st.id=s.signal_type_id WHERE s.tenant_id=$1 AND s.id=$2`,
    [tenantId, after.signal_id])).rows[0];
    expect(after.event_type).toBe("layoffs");
    expect(after.context.aiReview.signalType).toBe("layoffs");
    expect(signal.signal_type_id).toBe(layoffsTypeId);
    expect(signal.key).toBe("layoffs");
    expect(signal.product_id).toBe(productId);
    expect(after.reviewed_by).toBe(412);
    expect(after.reviewed_at).toEqual(before.reviewed_at);
    expect(after.raw_evidence).toEqual(before.raw_evidence);
  });
});
