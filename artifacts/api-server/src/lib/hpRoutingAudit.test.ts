import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { pool } from "@workspace/db";
import { seedHpCrmAccounts, cleanHpCrmTenant } from "./testFixtures/hpCrm";
import { loadHpWarmRoutingStatus } from "./hpWarmRoutingStatus";
import { loadHpRoutingAudit } from "./hpRoutingAudit";
import { loadHpPriorityEvidence } from "./hpAccountPriorityData";
import { hpRuleDeliveryAllowed } from "./hpRuleSequence";

let tenantId: number, clientId: number, journeyId: number, sequenceId: number, ruleId: number, submissionId: number;
let otherJourney: number, otherSequence: number, otherContact: number;
let hp: Awaited<ReturnType<typeof seedHpCrmAccounts>>;
const product = "HP Device as a Service";
beforeAll(async () => {
  vi.stubEnv("COPIED_DATA_SAFE_MODE", "true");
  vi.stubEnv("HP_RULE_SEQUENCE_ROUTING_ENABLED", "false");
  tenantId = Number((await pool.query("INSERT INTO tenants(name,slug) VALUES('Read-only routing audit',$1) RETURNING id", [randomUUID()])).rows[0].id);
  clientId = Number((await pool.query("INSERT INTO clients(tenant_id,name) VALUES($1,'HP') RETURNING id", [tenantId])).rows[0].id);
  hp = await seedHpCrmAccounts(tenantId, clientId);
  for (const name of ["Exact", "Unrelated"]) {
    const j = Number((await pool.query(`INSERT INTO journeys(tenant_id,client_id,name,slug,status)
      VALUES($1,$2,$3,$4,'published') RETURNING id`, [tenantId, clientId, name, randomUUID()])).rows[0].id);
    const s = Number((await pool.query(`INSERT INTO email_sequences(tenant_id,client_id,name,status)
      VALUES($1,$2,$3,'active') RETURNING id`, [tenantId, clientId, name])).rows[0].id);
    await pool.query("INSERT INTO sequence_steps(sequence_id,step_order,step_type,config) VALUES($1,1,'wait','{}')", [s]);
    if (name === "Exact") { journeyId = j; sequenceId = s; } else { otherJourney = j; otherSequence = s; }
  }
  otherContact = Number((await pool.query(`INSERT INTO contacts(tenant_id,client_id,company_id,first_name,email)
    VALUES($1,$2,$3,'Another respondent',$4) RETURNING id`, [tenantId, clientId, hp.companyId, `${randomUUID()}@example.invalid`])).rows[0].id);
  ruleId = Number((await pool.query(`INSERT INTO intent_inbound_routing_rules
    (tenant_id,client_id,name,match_type,classification,inbound_product_name,journey_id,sequence_id,enabled)
    VALUES($1,$2,'Exact product route','product','warm','Managed Device Service / Device as a Service',$3,$4,true) RETURNING id`,
  [tenantId, clientId, journeyId, sequenceId])).rows[0].id);
  submissionId = Number((await pool.query(`INSERT INTO intent_inbound_submissions
    (tenant_id,client_id,account_id,contact_id,drive_file_id,row_key,file_name,form_type,classification,
      classification_reason,product_interest,purchase_timeframe_months,submitted_at,raw_fields,routing_status,routed_rule_id)
    VALUES($1,$2,$3,$4,$5,$5,'legacy.xlsx','event_feedback','warm','test',$6,6,NOW(),'{}','routed',$7) RETURNING id`,
  [tenantId, clientId, hp.companyId, hp.contactId, randomUUID(), product, ruleId])).rows[0].id);
  await pool.query(`INSERT INTO hp_warm_checks(tenant_id,client_id,parent_key,status,reason,journeys,checked_at)
    SELECT tenant_id,client_id,parent_key,'routed','Legacy journey-only check','[]',NOW()
    FROM hp_account_profiles WHERE tenant_id=$1 AND company_id=$2`, [tenantId, hp.companyId]);
});
beforeEach(async () => {
  await pool.query("DELETE FROM activity_events WHERE tenant_id=$1 AND event_type='hp_rule_sequence_authorized'", [tenantId]);
  await pool.query("DELETE FROM sequence_enrollments WHERE sequence_id=ANY($1::int[])", [[sequenceId, otherSequence]]);
  await pool.query("DELETE FROM journey_contacts WHERE journey_id=ANY($1::int[])", [[journeyId, otherJourney]]);
  await pool.query("UPDATE contacts SET dnc=false WHERE id=$1", [hp.contactId]);
  await pool.query("UPDATE intent_inbound_routing_rules SET enabled=true,journey_id=$2,sequence_id=$3 WHERE id=$1", [ruleId, journeyId, sequenceId]);
  await pool.query("UPDATE intent_inbound_submissions SET identity_review=NULL,affinity_reviews='{}',submitted_at=NOW() WHERE id=$1", [submissionId]);
});
afterAll(async () => {
  vi.unstubAllEnvs();
  if (!tenantId) return;
  await pool.query("DELETE FROM sequence_enrollments WHERE sequence_id=ANY($1::int[])", [[sequenceId, otherSequence]]);
  await pool.query("DELETE FROM sequence_steps WHERE sequence_id=ANY($1::int[])", [[sequenceId, otherSequence]]);
  await pool.query("DELETE FROM journey_contacts WHERE journey_id=ANY($1::int[])", [[journeyId, otherJourney]]);
  await pool.query("DELETE FROM intent_inbound_routing_rules WHERE tenant_id=$1", [tenantId]);
  await pool.query("DELETE FROM email_sequences WHERE tenant_id=$1", [tenantId]);
  await pool.query("DELETE FROM journeys WHERE tenant_id=$1", [tenantId]);
  await cleanHpCrmTenant(tenantId);
});
async function audit() {
  const evidence = await loadHpPriorityEvidence(tenantId, clientId, [hp.companyId]);
  return (await loadHpRoutingAudit(tenantId, clientId, [hp.companyId], evidence)).find(d => d.submissionId === submissionId)!;
}
async function joinJourney(contact = hp.contactId, journey = journeyId) {
  await pool.query("INSERT INTO journey_contacts(journey_id,contact_id) VALUES($1,$2)", [journey, contact]);
}
async function enroll(status = "active", sequence = sequenceId, contact = hp.contactId, managed = false) {
  const id = Number((await pool.query(`INSERT INTO sequence_enrollments(sequence_id,contact_id,status,enrolled_at)
    VALUES($1,$2,$3,NOW()-interval '90 days') RETURNING id`, [sequence, contact, status])).rows[0].id);
  if (managed) await pool.query(`INSERT INTO activity_events
    (tenant_id,client_id,company_id,contact_id,journey_id,event_type,description,metadata,points_earned)
    VALUES($1,$2,$3,$4,$5,'hp_rule_sequence_authorized','Read-only audit fixture',$6,0)`,
  [tenantId, clientId, hp.companyId, contact, journeyId, JSON.stringify({ enrollmentId: id, ruleId, journeyId, sequenceId: sequence, products: [product] })]);
  return id;
}
it("reconciles legacy routed rows to journey-only live evidence without rewriting provenance or enrolling", async () => {
  await joinJourney();
  const status = await loadHpWarmRoutingStatus(tenantId, clientId, undefined, "");
  const row = status.items.find(r => r.routingDetails.some((d: { submissionId: number | null }) => d.submissionId === submissionId))!;
  expect(row.status).toBe("routed"); // explicitly the last worker check, not live proof
  expect(row.routingDetails).toContainEqual(expect.objectContaining({
    state: "journey_only", ruleId, journeyId, sequenceId, submissionId, contactId: hp.contactId,
  }));
  expect(row.routingDetails[0].nextAction).toContain("does not enroll");
  expect((await pool.query("SELECT routing_status,routed_rule_id,file_name FROM intent_inbound_submissions WHERE id=$1", [submissionId])).rows[0])
    .toEqual({ routing_status: "routed", routed_rule_id: ruleId, file_name: "legacy.xlsx" });
  expect((await pool.query("SELECT id FROM sequence_enrollments WHERE sequence_id=$1", [sequenceId])).rowCount).toBe(0);
});
it("does not count unrelated journeys, sequences or another respondent's memberships", async () => {
  await joinJourney(hp.contactId, otherJourney);
  await joinJourney(otherContact);
  await enroll("active", otherSequence);
  await enroll("active", sequenceId, otherContact);
  expect(await audit()).toMatchObject({ state: "pending", enrollmentStatus: null });
  await joinJourney();
  expect(await audit()).toMatchObject({ state: "journey_only", enrollmentStatus: null });
});
it("uses the current applicable saved destination, not stale routed_rule_id membership", async () => {
  await joinJourney();
  await enroll();
  await pool.query("UPDATE intent_inbound_routing_rules SET journey_id=$2,sequence_id=$3 WHERE id=$1", [ruleId, otherJourney, otherSequence]);
  expect(await audit()).toMatchObject({ state: "pending", journeyId: otherJourney, sequenceId: otherSequence, enrollmentStatus: null });
});
it.each(["active", "completed", "error"])("retains historical %s enrollments without authorizing or restarting", async status => {
  await joinJourney();
  const id = await enroll(status);
  expect(await audit()).toMatchObject({ state: "historical_enrollment", enrollmentStatus: status });
  expect((await audit()).nextAction).toContain("not adopted or restarted");
  expect(await hpRuleDeliveryAllowed(id, tenantId)).toBe(false);
  expect((await pool.query("SELECT id,status FROM sequence_enrollments WHERE sequence_id=$1", [sequenceId])).rows)
    .toEqual([{ id, status }]);
  expect((await pool.query("SELECT id FROM activity_events WHERE tenant_id=$1 AND event_type='hp_rule_sequence_authorized'", [tenantId])).rowCount).toBe(0);
});
it("distinguishes active rule-authorized routing from completed rule enrollment", async () => {
  await joinJourney();
  const id = await enroll("active", sequenceId, hp.contactId, true);
  expect(await audit()).toMatchObject({ state: "journey_and_sequence", enrollmentStatus: "active" });
  await pool.query("UPDATE sequence_enrollments SET status='completed' WHERE id=$1", [id]);
  expect(await audit()).toMatchObject({ state: "historical_enrollment", enrollmentStatus: "completed" });
});
it("keeps DNC, identity and product rejection restrictions visible despite existing routing", async () => {
  await joinJourney();
  await enroll("active", sequenceId, hp.contactId, true);
  await pool.query("UPDATE contacts SET dnc=true WHERE id=$1", [hp.contactId]);
  expect(await audit()).toMatchObject({ state: "blocked", nextAction: expect.stringContaining("suppression") });
  await pool.query("UPDATE contacts SET dnc=false WHERE id=$1", [hp.contactId]);
  await pool.query("UPDATE intent_inbound_submissions SET identity_review='keep' WHERE id=$1", [submissionId]);
  expect(await audit()).toMatchObject({ state: "blocked", nextAction: expect.stringContaining("identity") });
  await pool.query("UPDATE intent_inbound_submissions SET identity_review=NULL,affinity_reviews=$2::jsonb WHERE id=$1",
    [submissionId, JSON.stringify({ [product]: "rejected" })]);
  expect(await audit()).toMatchObject({ state: "blocked", nextAction: expect.stringContaining("rejected") });
});
it("reports disabled exact mappings as blocked rather than substituting another journey", async () => {
  await pool.query("UPDATE intent_inbound_routing_rules SET enabled=false WHERE id=$1", [ruleId]);
  expect(await audit()).toMatchObject({ state: "blocked", ruleId, journeyId, sequenceId });
});
it("does not treat authorization for another product or rule as managed routing", async () => {
  await joinJourney();
  await enroll("active", sequenceId, hp.contactId, true);
  await pool.query(`UPDATE activity_events SET metadata=(metadata::jsonb || $2::jsonb)::text
    WHERE tenant_id=$1 AND event_type='hp_rule_sequence_authorized'`,
  [tenantId, JSON.stringify({ products: ["Unrelated product"] })]);
  expect(await audit()).toMatchObject({ state: "historical_enrollment" });
  await pool.query(`UPDATE activity_events SET metadata=(metadata::jsonb || $2::jsonb)::text
    WHERE tenant_id=$1 AND event_type='hp_rule_sequence_authorized'`,
  [tenantId, JSON.stringify({ products: [product], ruleId: ruleId + 100000 })]);
  expect(await audit()).toMatchObject({ state: "historical_enrollment" });
});
it("fails closed for destinations outside the saved client scope", async () => {
  await joinJourney();
  await enroll();
  await pool.query("UPDATE email_sequences SET client_id=NULL WHERE id=$1", [sequenceId]);
  try {
    expect(await audit()).toMatchObject({ state: "blocked", enrollmentStatus: null,
      nextAction: expect.stringContaining("same-client") });
  } finally { await pool.query("UPDATE email_sequences SET client_id=$2 WHERE id=$1", [sequenceId, clientId]); }
});
it("preserves historical evidence without refreshing expired qualification", async () => {
  await joinJourney();
  await pool.query("UPDATE intent_inbound_submissions SET submitted_at=NOW()-interval '2 years' WHERE id=$1", [submissionId]);
  const status = await loadHpWarmRoutingStatus(tenantId, clientId, undefined, "");
  const row = status.items.find(r => r.routingDetails.some((d: { submissionId: number | null }) => d.submissionId === submissionId))!;
  expect(row.qualification).toBe("Cold");
  expect(row.routingDetails[0].state).toBe("journey_only");
  expect(row.routingDetails[0].submissionId).toBe(submissionId);
});
