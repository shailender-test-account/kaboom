import { afterAll, beforeAll, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import express from "express";
import { pool } from "@workspace/db";
import { seedHpCrmAccounts, cleanHpCrmTenant } from "./testFixtures/hpCrm";
import { evidenceQualification, readEngagementHistory, strongestQualification } from "./engagementHistory";
import { loadHpBi } from "./hpBiMetrics";
import historyRouter from "../routes/engagementHistory";
import { readContactEngagementEvidence } from "./contactEngagementEvidence";
import { readFirstPartySignalSource } from "./firstPartySignalSource";

let tenantId: number, clientId: number, journeyId: number, parentKey: string;
let hp: Awaited<ReturnType<typeof seedHpCrmAccounts>>;
beforeAll(async () => {
  tenantId = Number((await pool.query("INSERT INTO tenants(name,slug) VALUES('Engagement history test',$1) RETURNING id", [randomUUID()])).rows[0].id);
  clientId = Number((await pool.query("INSERT INTO clients(tenant_id,name) VALUES($1,'HP') RETURNING id", [tenantId])).rows[0].id);
  hp = await seedHpCrmAccounts(tenantId, clientId);
  parentKey = (await pool.query("SELECT parent_key FROM hp_account_profiles WHERE tenant_id=$1 LIMIT 1", [tenantId])).rows[0].parent_key;
  await pool.query(`UPDATE contacts SET lead_score=CASE WHEN id=$2 THEN 150 ELSE 78 END,
    intent_score=CASE WHEN id=$2 THEN 4 ELSE 99 END,tags=ARRAY['engage','hp-poly']::text[],stage='engage'
    WHERE tenant_id=$1`, [tenantId, hp.contactId]);
  await pool.query(`INSERT INTO contacts(tenant_id,client_id,company_id,first_name,email,is_anonymous,lead_score)
    VALUES($1,$2,$3,'Anonymous','anonymous@example.invalid',true,900)`, [tenantId, clientId, hp.companyId]);
  for (const [contact, account, months] of [[hp.contactId, hp.companyId, 3], [hp.siblingContact, hp.siblingId, 12]]) {
    await pool.query(`INSERT INTO intent_inbound_submissions(tenant_id,client_id,account_id,contact_id,drive_file_id,row_key,
      file_name,form_type,classification,classification_reason,product_interest,purchase_timeframe_months,submitted_at)
      VALUES($1,$2,$3,$4,$5,$5,'Questionnaire fixture','questionnaire','warm','fixture','HP Poly',$6,'2024-03-01')`,
    [tenantId, clientId, account, contact, randomUUID(), months]);
  }
  journeyId = Number((await pool.query(`INSERT INTO journeys(tenant_id,client_id,name,slug)
    VALUES($1,$2,'History test journey',$3) RETURNING id`, [tenantId, clientId, randomUUID()])).rows[0].id);
  await pool.query(`INSERT INTO visitor_tokens(tenant_id,contact_id,token) VALUES($1,$2,$3)`, [tenantId, hp.contactId, `history-${tenantId}`]);
  await pool.query(`INSERT INTO journey_events(tenant_id,journey_id,event_type,visitor_token,created_at,props)
    VALUES($1,$2,'page_view',$3,'2023-02-01','{}')`, [tenantId, journeyId, `history-${tenantId}`]);
  await pool.query(`INSERT INTO activity_events(tenant_id,client_id,company_id,contact_id,event_type,description,score_delta,metadata,created_at)
    SELECT $1,$2,$3,$4,'page_view','Recorded browsing',1,'{"tagsAdded":["engage"]}', '2025-01-01'::timestamptz+i*interval '1 day'
    FROM generate_series(1,55) i`, [tenantId, clientId, hp.companyId, hp.contactId]);
  await pool.query(`INSERT INTO email_events(tenant_id,contact_id,event_type,metadata,occurred_at,is_bot)
    VALUES($1,$2,'open','{}','2025-03-01',true)`, [tenantId, hp.contactId]);
  await pool.query(`INSERT INTO score_history(tenant_id,contact_id,old_score,new_score,delta,source)
    VALUES($1,$2,3,4,1,'formula recompute')`, [tenantId, hp.contactId]);
  await pool.query(`INSERT INTO contact_stage_history(tenant_id,contact_id,from_stage,to_stage,score_at_transition)
    VALUES($1,$2,'aware','engage',4)`, [tenantId, hp.contactId]);
  const formId = Number((await pool.query(`INSERT INTO journey_forms(tenant_id,name,config)
    VALUES($1,'History lead form',$2::jsonb) RETURNING id`,
  [tenantId, JSON.stringify({ title: "Lead form", fields: [{ id: "p", mapToBiField: "product" }, { id: "h", mapToBiField: "horizonMonths" }] })])).rows[0].id);
  await pool.query(`INSERT INTO form_submissions(tenant_id,form_id,contact_id,journey_id,field_values,action_type,submitted_at)
    VALUES($1,$2,$3,$4,'{"p":"HP Poly","h":"3"}','lead','2025-02-01')`, [tenantId, formId, hp.contactId, journeyId]);
  for (const value of ["Product interest: HP Poly", "Purchase timeframe: 3 months"]) {
    await pool.query(`INSERT INTO intent_evidence(tenant_id,account_id,contact_id,evidence_kind,provider,review_status,
      excerpt,raw_evidence,context,occurred_at)
      VALUES($1,$2,$3,'event_questionnaire','import','approved',$4,
        '{"Product":"HP Poly","Purchase timeframe":"3 months","__internal":"hidden"}',
        jsonb_build_object('formName','Older questionnaire','answer',jsonb_build_object('value',$4::text)),
        '2024-02-01')`, [tenantId, hp.companyId, hp.contactId, value]);
  }
});
afterAll(async () => {
  if (!tenantId) return;
  for (const table of ["intent_evidence", "contact_stage_history", "score_history", "email_events", "journey_events", "visitor_tokens", "form_submissions", "journey_forms", "journeys"])
    await pool.query(`DELETE FROM ${table} WHERE tenant_id=$1`, [tenantId]);
  await cleanHpCrmTenant(tenantId);
});
it("preserves purchase qualification separately from points", () => {
  expect(evidenceQualification("HP Poly", 3)).toBe("Hot");
  expect(evidenceQualification("HP Poly", 6)).toBe("Warm");
  expect(evidenceQualification("HP Poly", 7)).toBe("Cold");
  expect(evidenceQualification("None", 3, "hot")).toBe("Cold");
  expect(strongestQualification(["Warm", "Hot", "Warm"])).toBe("Hot");
});
it("returns the person's own GTM source responses and paginated all-date journey evidence", async () => {
  const result = await readContactEngagementEvidence(tenantId, hp.contactId, clientId, 1, 1);
  expect(result.gtmStatus).toBe("Hot");
  expect(result.gtmEvidence.items).toContainEqual(expect.objectContaining({
    sourceType: "questionnaire", product: "HP Poly", horizonMonths: 3, qualification: "Hot",
  }));
  expect(result.gtmEvidence.items).toContainEqual(expect.objectContaining({
    sourceType: "lead_form", product: "HP Poly", horizonMonths: 3, qualification: "Hot",
    answers: { product: "HP Poly", horizonMonths: "3" }, journey: "History test journey",
  }));
  expect(result.gtmEvidence.items.some((row: any) => Number(row.horizonMonths) === 12)).toBe(false);
  const older = result.gtmEvidence.items.filter((row: any) => row.sourceName === "Older questionnaire");
  expect(older).toHaveLength(1);
  expect(older[0]).toMatchObject({ product: "HP Poly", horizonMonths: 3, qualification: "Hot" });
  expect(older[0].answers).not.toHaveProperty("__internal");
  expect(result.timeline.items).toHaveLength(25);
  expect(result.timeline.hasMore).toBe(true);
  const next = await readContactEngagementEvidence(tenantId, hp.contactId, clientId, 1, 2);
  expect(next.timeline.items).toHaveLength(25);
  expect(new Set([...result.timeline.items, ...next.timeline.items].map((item: any) => item.id)).size).toBe(50);
  const wrongTenant = await readContactEngagementEvidence(tenantId + 10000000, hp.contactId, clientId, 1, 1);
  expect(wrongTenant.gtmEvidence.total).toBe(0);
  expect(wrongTenant.timeline.total).toBe(0);
});
it("rolls up the sum, never the intent-score average or a capped score", async () => {
  const h = await readEngagementHistory(tenantId, { clientId, companyIds: [hp.companyId, hp.siblingId] }, 1, 100);
  expect(h.summary).toMatchObject({ score: 228, status: "Hot", contactsCount: 2, hotContacts: 1, warmContacts: 0 });
  expect(h.contacts.find(c => c.id === hp.contactId)).toMatchObject({ score: 150, intentScore: 4, status: "Hot", tags: ["engage", "hp-poly"] });
  const d: any = await loadHpBi(tenantId, { clientId, year: 2027, parentKey, page: 1, pageSize: 25 }, true);
  expect(d.account).toMatchObject({ score: 228, status: "Cold" });
  expect(d.account.priority).toMatchObject({ declaredQualification: "Cold", needsReconfirmation: true });
  expect(d.account.hot).toBe(0); // Historical qualification must not invent this FY's leads.
});
it("opens the exact original questionnaire only within its owning account and tenant", async () => {
  const rows=await readContactEngagementEvidence(tenantId,hp.contactId,clientId,1,1);
  const inbound=rows.gtmEvidence.items.find((row:any)=>row.id.startsWith("inbound:"));
  const ref={kind:"inbound_submission" as const,id:Number(inbound.id.split(":")[1])};
  const source=await readFirstPartySignalSource(tenantId,hp.companyId,ref);
  expect(source).toMatchObject({formType:"questionnaire",contactId:hp.contactId,product:"HP Poly",horizonMonths:3});
  expect(await readFirstPartySignalSource(tenantId,hp.siblingId,ref)).toBeNull();
  expect(await readFirstPartySignalSource(tenantId+10000000,hp.companyId,ref)).toBeNull();
  const older=rows.gtmEvidence.items.find((row:any)=>row.id.startsWith("intent-response:"));
  const imported=await readFirstPartySignalSource(tenantId,hp.companyId,{kind:"intent_evidence",id:Number(older.id.split(":")[1])});
  expect(imported).toMatchObject({formType:"event_questionnaire",sourceName:"Older questionnaire"});
  expect(imported.answers).not.toHaveProperty("__internal");
});
it("retains every source and all dates, including the raw browsing fallback", async () => {
  const h = await readEngagementHistory(tenantId, { clientId, companyIds: [hp.companyId, hp.siblingId] }, 1, 100);
  expect(h.items.map((i: any) => i.source)).toEqual(expect.arrayContaining([
    "Questionnaire / event feedback", "Journey form", "Journey browsing", "Email", "Intent score history", "Journey stage history",
  ]));
  expect(h.items.find((i: any) => i.source === "Journey form")).toMatchObject({ product: "HP Poly", qualification: "Hot" });
  expect(h.items.find((i: any) => i.source === "Email")).toMatchObject({ isBot: true });
  expect(h.items.find((i: any) => i.source === "Activity")).toMatchObject({ tagsAdded: ["engage"], scoreDelta: 1 });
  expect(h.items.some((i: any) => i.occurredAt.startsWith("2023"))).toBe(true);
});
it("pages beyond fifty records without leaking another contact or tenant", async () => {
  const scope = { clientId, companyIds: null, contactId: hp.contactId };
  const first = await readEngagementHistory(tenantId, scope, 1, 50);
  const second = await readEngagementHistory(tenantId, scope, 2, 50);
  expect(first.hasMore).toBe(true); expect(second.hasMore).toBe(false);
  expect(first.items.length + second.items.length).toBe(first.total);
  expect(new Set([...first.items, ...second.items].map((i: any) => i.id)).size).toBe(first.total);
  expect([...first.items, ...second.items].every((i: any) => i.contactId === hp.contactId)).toBe(true);
  const foreign = await readEngagementHistory(tenantId + 10000000, scope, 1, 50);
  expect(foreign.total).toBe(0); expect(foreign.summary.score).toBe(0);
});
it("keeps legitimate account-level evidence visible without inventing a contact or score", async () => {
  const accountId = Number((await pool.query("INSERT INTO companies(tenant_id,client_id,name) VALUES($1,$2,'Account-level fixture') RETURNING id",
    [tenantId, clientId])).rows[0].id);
  await pool.query(`INSERT INTO hp_bi_records(tenant_id,client_id,account_id,kind,occurred_at,product,horizon_months,source,source_key)
    VALUES($1,$2,$3,'lead','2024-01-01','HP Poly',3,'manual',$4)`, [tenantId, clientId, accountId, randomUUID()]);
  const h = await readEngagementHistory(tenantId, { clientId, companyIds: [accountId] }, 1, 50);
  expect(h.summary).toMatchObject({ status: "Hot", score: 0, contactsCount: 0, hotContacts: 0 });
  expect(h.items).toHaveLength(1);
  expect(h.items[0]).toMatchObject({ contactId: null, source: "Recorded engagement" });
});
it("does not borrow a client journey to qualify an unassigned CRM contact", async () => {
  const contactId = Number((await pool.query(`INSERT INTO contacts(tenant_id,first_name,email,lead_score)
    VALUES($1,'Unassigned client fixture',$2,12) RETURNING id`, [tenantId, `${randomUUID()}@example.invalid`])).rows[0].id);
  const formId = (await pool.query("SELECT id FROM journey_forms WHERE tenant_id=$1 LIMIT 1", [tenantId])).rows[0].id;
  await pool.query(`INSERT INTO form_submissions(tenant_id,form_id,contact_id,journey_id,field_values,action_type)
    VALUES($1,$2,$3,$4,'{"p":"HP Poly","h":"3"}','lead')`, [tenantId, formId, contactId, journeyId]);
  const h = await readEngagementHistory(tenantId, { clientId: null, companyIds: null, contactId }, 1, 50);
  expect(h.summary).toMatchObject({ status: "Cold", score: 12, contactsCount: 1 });
  expect(h.items).toEqual([]);
});
it("validates target ownership before returning history", async () => {
  const app = express();
  app.use((req: any, _res, next) => { req.isAuthenticated = () => true; req.user = { tenantId }; next(); });
  app.use(historyRouter);
  const server = app.listen(0);
  try {
    const address = server.address() as { port: number }, root = `http://127.0.0.1:${address.port}/engagement-history`;
    expect((await fetch(root)).status).toBe(400);
    expect((await fetch(`${root}?parentKey=${encodeURIComponent(parentKey)}`)).status).toBe(400);
    expect((await fetch(`${root}?contactId=${hp.contactId}&clientId=${clientId + 100000}`)).status).toBe(404);
    const response = await fetch(`${root}?companyId=${hp.companyId}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ summary: { status: "Hot", score: 150 } });
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
