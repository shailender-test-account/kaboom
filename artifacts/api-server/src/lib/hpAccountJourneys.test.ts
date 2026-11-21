import { expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { pool } from "@workspace/db";
import { loadHpGtmQualification } from "./hpGtmQualification";
import { loadHpBi } from "./hpBiMetrics";
import { seedHpCrmAccounts, cleanHpCrmTenant } from "./testFixtures/hpCrm";

it("shows real all-date rule/manual destinations, rolls up legal accounts and never labels pending or invalid routes as completed", async () => {
  const tenant = Number((await pool.query("INSERT INTO tenants(name,slug) VALUES('Journey display isolated test',$1) RETURNING id", [randomUUID()])).rows[0].id);
  try {
    const client = Number((await pool.query("INSERT INTO clients(tenant_id,name) VALUES($1,'HP') RETURNING id", [tenant])).rows[0].id);
    const other = Number((await pool.query("INSERT INTO clients(tenant_id,name) VALUES($1,'Other client') RETURNING id", [tenant])).rows[0].id);
    const hp = await seedHpCrmAccounts(tenant, client);
    const journey = async (name: string, owner = client) => Number((await pool.query(
      "INSERT INTO journeys(tenant_id,client_id,name,slug) VALUES($1,$2,$3,$4) RETURNING id",
      [tenant, owner, name, randomUUID()])).rows[0].id);
    const security = await journey("Security nurture"), services = await journey("Services nurture"), foreign = await journey("Private other-client journey", other);
    const sequence = Number((await pool.query("INSERT INTO sequences(tenant_id,client_id,name,status) VALUES($1,$2,'Test route','draft') RETURNING id", [tenant, client])).rows[0].id);
    const rule = async (destination: number) => Number((await pool.query(`INSERT INTO intent_inbound_routing_rules
      (tenant_id,client_id,name,match_type,journey_id,sequence_id,enabled) VALUES($1,$2,'Test route','fallback',$3,$4,false) RETURNING id`,
      [tenant, client, destination, sequence])).rows[0].id);
    const securityRule = await rule(security), invalidRule = await rule(foreign);
    const response = async (status: string, routedRule: number | null, sibling = false) => Number((await pool.query(
      `INSERT INTO intent_inbound_submissions(tenant_id,client_id,account_id,contact_id,drive_file_id,row_key,file_name,
        classification,classification_reason,product_interest,purchase_timeframe_months,submitted_at,routing_status,routed_rule_id)
       VALUES($1,$2,$3,$4,$5,$5,'Old questionnaire','warm','fixture','HP Poly',6,'2024-01-01',$6,$7) RETURNING id`,
      [tenant, client, sibling ? hp.siblingId : hp.companyId, sibling ? hp.siblingContact : hp.contactId, randomUUID(), status, routedRule])).rows[0].id);
    await response("routed", securityRule);
    await response("routed", securityRule); // Duplicate destination is shown only once.
    const manual = await response("routed", securityRule, true);
    await pool.query(`INSERT INTO intent_inbound_manual_routes(tenant_id,submission_id,contact_id,selection,journey_id,sequence_id)
      VALUES($1,$2,$3,'HP Poly',$4,$5)`, [tenant, manual, hp.siblingContact, services, sequence]);
    await response("pending", securityRule);
    await response("error", securityRule);
    await response("routed", invalidRule);
    const mismatched = await response("routed", securityRule);
    await pool.query(`INSERT INTO intent_inbound_manual_routes(tenant_id,submission_id,contact_id,selection,journey_id,sequence_id)
      VALUES($1,$2,$3,'HP Poly',$4,$5)`, [tenant, mismatched, hp.siblingContact, services, sequence]);
    const gtm = await loadHpGtmQualification(tenant, client);
    expect(gtm.routes(new Set([hp.companyId, hp.siblingId]))).toEqual({
      journeys: [{ id: security, name: "Security nurture" }, { id: services, name: "Services nurture" }],
      pendingJourneyRoutes: 1, failedJourneyRoutes: 1, unavailableJourneyRoutes: 2,
    });
    expect((await loadHpGtmQualification(tenant, other)).routes(new Set([hp.companyId])).journeys).toEqual([]);
    expect((await loadHpGtmQualification(tenant + 1000000, client)).routes(new Set([hp.companyId])).journeys).toEqual([]);
    const report: any = await loadHpBi(tenant, { clientId: client, year: 2027, page: 1, pageSize: 25, sortBy: "journey", sortDir: "asc" });
    expect(report.accounts[0].journeys).toEqual(gtm.routes(new Set([hp.companyId, hp.siblingId])).journeys);
    // Historical destinations remain visible, but the expired 2024 declaration
    // cannot establish current Warm priority or trigger Warm routing.
    expect(report.accounts[0].status).toBe("Cold");
    expect(report.accounts[0].priority).toMatchObject({ needsReconfirmation: true, warmForm: false });
    expect(report.summary.leads).toBe(0); // Current FY does not hide earlier routing context.
  } finally {
    for (const table of ["intent_inbound_manual_routes", "intent_inbound_submissions", "intent_inbound_routing_rules", "journeys", "sequences"])
      await pool.query(`DELETE FROM ${table} WHERE tenant_id=$1`, [tenant]);
    await cleanHpCrmTenant(tenant);
  }
});
