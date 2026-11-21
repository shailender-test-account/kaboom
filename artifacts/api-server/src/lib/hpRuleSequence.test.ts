import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { pool } from "@workspace/db";
const delivery = vi.hoisted(() => ({ send: vi.fn(async () => true) }));
vi.mock("../services/email", async importOriginal => ({
  ...await importOriginal<typeof import("../services/email")>(),
  sendEmail: delivery.send,
}));
import { seedHpCrmAccounts, cleanHpCrmTenant } from "./testFixtures/hpCrm";
import { routePendingWarmSubmissions } from "./inboundAccounts";
import { loadHpWarmRouting, routeHpWarmBatch } from "./hpWarmRouting";
import { loadHpPriorityEvidence } from "./hpAccountPriorityData";
import { enrollHpRuleSequence, hpAuthorizedEnrollmentSql, hpRuleDeliveryAllowed } from "./hpRuleSequence";
import { resumeContactFromWait } from "../services/runEnrollmentService";

let tenantId:number,clientId:number,journeyId:number,sequenceId:number,ruleId:number,fallbackId:number;
let hp:Awaited<ReturnType<typeof seedHpCrmAccounts>>;
beforeAll(async()=>{
  vi.stubEnv("COPIED_DATA_SAFE_MODE","true");
  vi.stubEnv("HP_RULE_SEQUENCE_ROUTING_ENABLED","true");
  tenantId=Number((await pool.query("INSERT INTO tenants(name,slug) VALUES('Approved HP routing test',$1) RETURNING id",[randomUUID()])).rows[0].id);
  clientId=Number((await pool.query("INSERT INTO clients(tenant_id,name) VALUES($1,'HP') RETURNING id",[tenantId])).rows[0].id);
  hp=await seedHpCrmAccounts(tenantId,clientId);
  journeyId=Number((await pool.query(`INSERT INTO journeys(tenant_id,client_id,name,slug,status)
    VALUES($1,$2,'Approved routing journey',$3,'published') RETURNING id`,[tenantId,clientId,randomUUID()])).rows[0].id);
  sequenceId=Number((await pool.query(`INSERT INTO email_sequences(tenant_id,client_id,name,status)
    VALUES($1,$2,'No email: wait and tag fixture','active') RETURNING id`,[tenantId,clientId])).rows[0].id);
  await pool.query(`INSERT INTO sequence_steps(sequence_id,step_order,step_type,config,wait_duration,wait_unit)
    VALUES($1,1,'wait','{}',1,'minutes'),($1,2,'tag','{"tagName":"approved-routing-test"}',NULL,NULL)`,[sequenceId]);
  ruleId=Number((await pool.query(`INSERT INTO intent_inbound_routing_rules(tenant_id,client_id,name,match_type,classification,
    inbound_product_name,journey_id,sequence_id,enabled)
    VALUES($1,$2,'Device route','product','warm','Managed Device Service / Device as a Service',$3,$4,true) RETURNING id`,
  [tenantId,clientId,journeyId,sequenceId])).rows[0].id);
  fallbackId=Number((await pool.query(`INSERT INTO intent_inbound_routing_rules(tenant_id,client_id,name,match_type,classification,
    journey_id,sequence_id,enabled) VALUES($1,$2,'Generic fallback','fallback','all',$3,$4,true) RETURNING id`,
  [tenantId,clientId,journeyId,sequenceId])).rows[0].id);
  await pool.query(`INSERT INTO intent_inbound_submissions(tenant_id,client_id,account_id,contact_id,drive_file_id,row_key,file_name,
    form_type,classification,classification_reason,product_interest,purchase_timeframe_months,submitted_at,raw_fields)
    VALUES($1,$2,$3,$4,$5,$5,'fixture.xlsx','event_feedback','warm','test','HP Device as a Service',6,NOW(),'{}')`,
  [tenantId,clientId,hp.companyId,hp.contactId,randomUUID()]);
});
afterAll(async()=>{
  vi.unstubAllEnvs();
  if(!tenantId)return;
  await pool.query("DELETE FROM sequence_enrollments WHERE sequence_id=$1",[sequenceId]);
  await pool.query("DELETE FROM sequence_steps WHERE sequence_id=$1",[sequenceId]);
  await pool.query("DELETE FROM journey_contacts WHERE journey_id=$1",[journeyId]);
  await pool.query("DELETE FROM intent_inbound_routing_rules WHERE tenant_id=$1",[tenantId]);
  await pool.query("DELETE FROM email_sequences WHERE tenant_id=$1",[tenantId]);
  await pool.query("DELETE FROM email_templates WHERE tenant_id=$1",[tenantId]);
  await pool.query("DELETE FROM journeys WHERE tenant_id=$1",[tenantId]);
  await cleanHpCrmTenant(tenantId);
});

it("does nothing without the scoped approval switch and rejects another client",async()=>{
  vi.stubEnv("HP_RULE_SEQUENCE_ROUTING_ENABLED","false");
  expect(await routePendingWarmSubmissions(tenantId,undefined,undefined,clientId)).toEqual({routed:0,pending:0,failed:0});
  vi.stubEnv("HP_RULE_SEQUENCE_ROUTING_ENABLED","true");
  await expect(routePendingWarmSubmissions(tenantId,undefined,undefined,clientId+100000)).rejects.toThrow("owned HP");
});

it("holds a disabled/draft specific route instead of falling through to generic",async()=>{
  await pool.query("UPDATE intent_inbound_routing_rules SET enabled=false WHERE id=$1",[ruleId]);
  const result=await routePendingWarmSubmissions(tenantId,undefined,undefined,clientId);
  expect(result).toMatchObject({routed:0,pending:1});
  expect((await pool.query("SELECT id FROM sequence_enrollments WHERE sequence_id=$1",[sequenceId])).rowCount).toBe(0);
  const data=await loadHpPriorityEvidence(tenantId,clientId,[hp.companyId]);
  const routing=await loadHpWarmRouting(tenantId,clientId,[hp.companyId]);
  expect(routing.matches(data,new Set([hp.companyId]),new Date())).toHaveLength(0);
  await pool.query("UPDATE intent_inbound_routing_rules SET enabled=true WHERE id=$1",[ruleId]);
  await pool.query("UPDATE journeys SET status='draft' WHERE id=$1",[journeyId]);
  expect(await routePendingWarmSubmissions(tenantId,undefined,undefined,clientId)).toMatchObject({routed:0,pending:1});
  await pool.query("UPDATE journeys SET status='published' WHERE id=$1",[journeyId]);
});

it("creates both memberships once, authorizes only the new enrollment and preserves waits",async()=>{
  // UI save/retry uses this default entry point rather than the worker scope.
  expect(await routePendingWarmSubmissions(tenantId)).toMatchObject({routed:1,failed:0});
  await routePendingWarmSubmissions(tenantId,undefined,undefined,clientId);
  await routeHpWarmBatch(tenantId,clientId);
  const enrollments=await pool.query("SELECT id FROM sequence_enrollments WHERE sequence_id=$1 AND contact_id=$2",[sequenceId,hp.contactId]);
  expect(enrollments.rowCount).toBe(1);
  const enrollmentId=Number(enrollments.rows[0].id);
  expect((await pool.query("SELECT 1 FROM journey_contacts WHERE journey_id=$1 AND contact_id=$2",[journeyId,hp.contactId])).rowCount).toBe(1);
  expect(await hpRuleDeliveryAllowed(enrollmentId,tenantId)).toBe(true);
  expect(await hpRuleDeliveryAllowed(enrollmentId,tenantId+100000)).toBe(false);
  expect((await pool.query(`SELECT se.id FROM sequence_enrollments se JOIN email_sequences es ON es.id=se.sequence_id
    WHERE es.tenant_id=$1 AND ${hpAuthorizedEnrollmentSql}`,[tenantId])).rowCount).toBe(1);
  expect(await resumeContactFromWait(enrollmentId,hp.contactId,tenantId,sequenceId)).toMatchObject({claimed:true,failures:0});
  const paused=(await pool.query("SELECT resume_at,status FROM sequence_enrollments WHERE id=$1",[enrollmentId])).rows[0];
  expect(paused.status).toBe("active");
  expect(paused.resume_at.getTime()).toBeGreaterThan(Date.now());
  await pool.query("UPDATE contacts SET dnc=true WHERE id=$1",[hp.contactId]);
  expect(await hpRuleDeliveryAllowed(enrollmentId,tenantId)).toBe(false);
  await pool.query("UPDATE contacts SET dnc=false WHERE id=$1",[hp.contactId]);
  await pool.query("UPDATE email_sequences SET status='draft' WHERE id=$1",[sequenceId]);
  expect(await hpRuleDeliveryAllowed(enrollmentId,tenantId)).toBe(false);
  await pool.query("UPDATE email_sequences SET status='active' WHERE id=$1",[sequenceId]);
  await pool.query("UPDATE intent_inbound_routing_rules SET enabled=false WHERE id=$1",[ruleId]);
  expect(await hpRuleDeliveryAllowed(enrollmentId,tenantId)).toBe(false);
  await pool.query("UPDATE intent_inbound_routing_rules SET enabled=true WHERE id=$1",[ruleId]);
  // Complete without sending any email and ensure the next sweep cannot replay it.
  await pool.query("UPDATE sequence_enrollments SET resume_at=NOW()-interval '1 second' WHERE id=$1",[enrollmentId]);
  await resumeContactFromWait(enrollmentId,hp.contactId,tenantId,sequenceId);
  await routeHpWarmBatch(tenantId,clientId);
  expect((await pool.query("SELECT status FROM sequence_enrollments WHERE id=$1",[enrollmentId])).rows[0].status).toBe("completed");
  expect((await pool.query("SELECT id FROM sequence_enrollments WHERE sequence_id=$1",[sequenceId])).rowCount).toBe(1);
});

it("does not authorize historical active enrollments or release unrelated copied jobs",async()=>{
  const old=(await pool.query(`INSERT INTO sequence_enrollments(sequence_id,contact_id,status,resume_at)
    VALUES($1,$2,'active',NOW()) RETURNING id`,[sequenceId,hp.contactId])).rows[0].id;
  expect(await hpRuleDeliveryAllowed(old,tenantId)).toBe(false);
  expect((await pool.query(`SELECT se.id FROM sequence_enrollments se JOIN email_sequences es ON es.id=se.sequence_id
    WHERE se.id=$1 AND ${hpAuthorizedEnrollmentSql}`,[old])).rowCount).toBe(0);
});

it("blocks the next email when a contact's attributed product is rejected after enrollment", async () => {
  const product = "HP Device as a Service";
  const contactId = Number((await pool.query(`INSERT INTO contacts(tenant_id,client_id,company_id,first_name,email)
    VALUES($1,$2,$3,'Revoked product',$4) RETURNING id`,
    [tenantId, clientId, hp.companyId, `${randomUUID()}@example.invalid`])).rows[0].id);
  await pool.query("INSERT INTO journey_contacts(journey_id,contact_id) VALUES($1,$2)", [journeyId, contactId]);
  await pool.query(`INSERT INTO intent_inbound_submissions(tenant_id,client_id,account_id,contact_id,drive_file_id,row_key,file_name,
    form_type,classification,classification_reason,product_interest,purchase_timeframe_months,submitted_at,raw_fields)
    VALUES($1,$2,$3,$4,$5,$5,'warm fixture','event_feedback','warm','Warm nurture evidence',$6,6,NOW(),'{}')`,
    [tenantId,clientId,hp.companyId,contactId,randomUUID(),product]);
  const templateId = Number((await pool.query(`INSERT INTO email_templates(tenant_id,name,subject,body_html)
    VALUES($1,'Never send fixture','Must stay blocked','Fixture only') RETURNING id`, [tenantId])).rows[0].id);
  const firstStep = Number((await pool.query("SELECT id FROM sequence_steps WHERE sequence_id=$1 ORDER BY step_order LIMIT 1", [sequenceId])).rows[0].id);
  await pool.query("UPDATE sequence_steps SET step_type='email',config=$2::jsonb WHERE id=$1",
    [firstStep, JSON.stringify({ templateId })]);
  let enrollmentId: number;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    enrollmentId = (await enrollHpRuleSequence(client, tenantId, clientId, contactId, ruleId, [product]))!;
    await client.query("COMMIT");
  } finally { client.release(); }
  expect(await hpRuleDeliveryAllowed(enrollmentId, tenantId)).toBe(true);
  await pool.query(`INSERT INTO intent_inbound_submissions(tenant_id,client_id,account_id,contact_id,drive_file_id,row_key,file_name,
    form_type,classification,classification_reason,product_interest,affinity_reviews,raw_fields)
    VALUES($1,$2,$3,$4,$5,$5,'rejection fixture','event_feedback','warm','Reviewed product rejected',$6,$7::jsonb,'{}')`,
    [tenantId, clientId, hp.companyId, contactId, randomUUID(), product, JSON.stringify({ [product]: "rejected" })]);
  expect(await hpRuleDeliveryAllowed(enrollmentId, tenantId)).toBe(false);
  expect((await pool.query(`SELECT se.id FROM sequence_enrollments se JOIN email_sequences es ON es.id=se.sequence_id
    WHERE se.id=$1 AND ${hpAuthorizedEnrollmentSql}`, [enrollmentId])).rowCount).toBe(0);
  delivery.send.mockClear();
  // Direct processing is also fenced, independently of the runner's selector.
  expect(await resumeContactFromWait(enrollmentId, contactId, tenantId, sequenceId)).toMatchObject({ claimed: true, failures: 1 });
  expect(delivery.send).not.toHaveBeenCalled();
});

it("blocks Hot admission and stops an authorized Warm cadence when the person becomes Hot",async()=>{
  const product="HP Device as a Service";
  const contactId=Number((await pool.query(`INSERT INTO contacts(tenant_id,client_id,company_id,first_name,email)
    VALUES($1,$2,$3,'Warm to Hot',$4) RETURNING id`,
    [tenantId,clientId,hp.companyId,`${randomUUID()}@example.invalid`])).rows[0].id);
  await pool.query("INSERT INTO journey_contacts(journey_id,contact_id) VALUES($1,$2)",[journeyId,contactId]);
  const submissionId=Number((await pool.query(`INSERT INTO intent_inbound_submissions
    (tenant_id,client_id,account_id,contact_id,drive_file_id,row_key,file_name,form_type,classification,
      classification_reason,product_interest,purchase_timeframe_months,submitted_at,raw_fields)
    VALUES($1,$2,$3,$4,$5,$5,'heat fixture','event_feedback','warm','Current Warm',$6,6,NOW(),'{}') RETURNING id`,
    [tenantId,clientId,hp.companyId,contactId,randomUUID(),product])).rows[0].id);
  const client=await pool.connect();
  try{
    await client.query("BEGIN");
    const enrollmentId=(await enrollHpRuleSequence(client,tenantId,clientId,contactId,ruleId,[product]))!;
    await client.query("COMMIT");
    expect(await hpRuleDeliveryAllowed(enrollmentId,tenantId)).toBe(true);
    await pool.query(`UPDATE intent_inbound_submissions SET classification='hot',purchase_timeframe_months=1
      WHERE id=$1`,[submissionId]);
    expect(await hpRuleDeliveryAllowed(enrollmentId,tenantId)).toBe(false);
    await expect(enrollHpRuleSequence(client,tenantId,clientId,contactId,ruleId,[product])).rejects.toThrow("Only currently Warm");
    // Membership/activity history is retained; no email or calling action runs.
    expect((await pool.query("SELECT 1 FROM journey_contacts WHERE journey_id=$1 AND contact_id=$2",[journeyId,contactId])).rowCount).toBe(1);
  }finally{client.release();}
});
