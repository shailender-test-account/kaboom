import { afterAll, beforeAll, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { pool } from "@workspace/db";
import { cleanHpCrmTenant, seedHpCrmAccounts } from "./testFixtures/hpCrm";
import { ensureHpAccountRegister } from "./hpBiImport";
import { associateHpRoster, loadHpRosterAnalysis, rosterCandidates } from "./hpRosterAnalysis";
import { loadHpBi } from "./hpBiMetrics";

let tenantId: number, clientId: number, sourceId: number, targetId: number, sourceParent: string;
beforeAll(async () => {
  tenantId = Number((await pool.query("INSERT INTO tenants(name,slug) VALUES('HP roster reconciliation',$1) RETURNING id", [randomUUID()])).rows[0].id);
  clientId = Number((await pool.query("INSERT INTO clients(tenant_id,name) VALUES($1,'HP') RETURNING id", [tenantId])).rows[0].id);
  const fixture = await seedHpCrmAccounts(tenantId, clientId);
  targetId = fixture.companyId;
  await pool.query(`UPDATE hp_account_profiles SET hp_id='ROSTER-ONE',gtm='GCC',ps_rad='R1',
    parent_key='roster:one',parent_name='Roster group',legal_name='Example Private Limited',
    variants='[{"UNIQUE ID":"ROSTER-ONE","EMP SIZE":0,"CITY":"-","_source":{"row":2}}]'::jsonb
    WHERE tenant_id=$1 AND company_id=$2`, [tenantId, targetId]);
  sourceId = Number((await pool.query("INSERT INTO companies(tenant_id,client_id,name) VALUES($1,$2,'Example Pvt Ltd') RETURNING id", [tenantId, clientId])).rows[0].id);
  await ensureHpAccountRegister(tenantId, clientId);
  sourceParent = `company:${sourceId}`;
  for (const classification of ["hot", "warm", "cold"]) {
    const key = randomUUID();
    await pool.query(`INSERT INTO intent_inbound_submissions(tenant_id,client_id,account_id,drive_file_id,row_key,
      file_name,form_type,classification,classification_reason,submitted_at,product_interest,purchase_timeframe_months)
      VALUES($1,$2,$3,$4,$4,'source.xlsx','event_feedback',$5,'fixture','2024-01-01','HP Poly',$6)`,
      [tenantId, clientId, sourceId, key, classification, classification==="hot"?3:classification==="warm"?6:12]);
  }
});
afterAll(async () => { if (tenantId) await cleanHpCrmTenant(tenantId); });

it("suggests corporate-name variants without treating them as approved identity", () => {
  const candidate: any = { company_id: 1, name: "Example Private Limited", hp_id: "HP1", parent_name: "Example Group", aliases: [] };
  expect(rosterCandidates("Example Pvt Ltd", [candidate])).toEqual([expect.objectContaining({ accountId: 1, reason: "Similar legal name — review required" })]);
  expect(rosterCandidates("Different Business", [candidate])).toEqual([]);
});
it("retains actual Hot/Warm/Cold source counts, all 41 coverage fields, and placeholders", async () => {
  const report = await loadHpRosterAnalysis(tenantId, clientId);
  expect(report.columns).toHaveLength(41);
  expect(report.columns.find(c => c.key === "emp_size")?.populatedRows).toBe(1); // Zero is data.
  expect(report.columns.find(c => c.key === "city")?.populatedRows).toBe(0); // Placeholder is not.
  expect(report.accounts.find(a => a.accountId === sourceId)).toMatchObject({
    mapping: "review", responses: 3, hot: 1, warm: 1, cold: 1, status: "Hot", targetAccountId: null,
  });
});
it("rejects foreign targets and stale reviews without moving identities", async () => {
  await expect(associateHpRoster(tenantId, clientId, sourceId, 2_000_000_000, null, null)).rejects.toMatchObject({ status: 404 });
  await expect(associateHpRoster(tenantId, clientId, sourceId, targetId, targetId, null)).rejects.toMatchObject({ status: 409 });
  const row = (await pool.query("SELECT parent_key FROM hp_account_profiles WHERE tenant_id=$1 AND company_id=$2", [tenantId, sourceId])).rows[0];
  expect(row.parent_key).toBe(sourceParent);
});
it("links only reporting context, includes all source classifications in the parent, and reverses cleanly", async () => {
  await associateHpRoster(tenantId, clientId, sourceId, targetId, null, null);
  const mapped = await loadHpRosterAnalysis(tenantId, clientId);
  expect(mapped.accounts.find(a => a.accountId === sourceId)).toMatchObject({ mapping: "linked", parentKey: "roster:one", targetAccountId: targetId });
  const detail: any = await loadHpBi(tenantId, { clientId, year: 2027, parentKey: "roster:one", page: 1, pageSize: 25 }, true);
  expect(detail.sourceGtmResponses.map((r: any) => r.classification).sort()).toEqual(["cold", "hot", "warm"]);
  expect(detail.account.gtm).toMatchObject({ inboundStatus: "Hot", inboundHotResponses: 1, inboundWarmResponses: 1, inboundColdResponses: 1 });
  expect(detail.account.leads).toBe(0);
  expect(detail.members.find((m: any) => m.id === sourceId)).toBeTruthy();
  expect((await pool.query("SELECT DISTINCT account_id FROM intent_inbound_submissions WHERE tenant_id=$1", [tenantId])).rows.map(r => Number(r.account_id))).toEqual([sourceId]);
  const source = (await pool.query("SELECT hp_id,gtm FROM hp_account_profiles WHERE tenant_id=$1 AND company_id=$2", [tenantId, sourceId])).rows[0];
  expect(source).toMatchObject({ hp_id: null, gtm: null }); // Inheritance is read-time only.
  const report: any = await loadHpBi(tenantId, { clientId, year: 2027, segment: "GCC", page: 1, pageSize: 25 });
  expect(report.summary.gtm.inboundResponses).toBe(3);
  // If the target stops being a roster identity, retain evidence and permit unlink.
  await pool.query("UPDATE hp_account_profiles SET hp_id=NULL WHERE tenant_id=$1 AND company_id=$2", [tenantId, targetId]);
  const dangling = await loadHpRosterAnalysis(tenantId, clientId);
  expect(dangling.accounts.find(a => a.accountId === sourceId)).toMatchObject({ mapping: "unmatched", parentKey: sourceParent, targetAccountId: targetId });
  const orphanDetail: any = await loadHpBi(tenantId, { clientId, year: 2027, parentKey: sourceParent, page: 1, pageSize: 25 }, true);
  expect(orphanDetail.sourceGtmResponses).toHaveLength(3);
  await associateHpRoster(tenantId, clientId, sourceId, null, targetId, null);
  const restored = (await pool.query("SELECT parent_key,dimensions FROM hp_account_profiles WHERE tenant_id=$1 AND company_id=$2", [tenantId, sourceId])).rows[0];
  expect(restored.parent_key).toBe(sourceParent);
  expect(restored.dimensions._rosterAssociation).toBeUndefined();
});
