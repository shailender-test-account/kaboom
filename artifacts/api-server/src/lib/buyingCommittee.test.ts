import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import express from "express";
import supertest from "supertest";
import { randomUUID } from "node:crypto";
import { pool } from "@workspace/db";
import committeeRouter from "../routes/buyingCommittee";
import { seedHpCrmAccounts, cleanHpCrmTenant } from "./testFixtures/hpCrm";
import { approveCommitteePlan, committeeAccounts, committeeDomain, committeePlan, designationSuggestions, saveCommitteePlan, type CommitteeConfig } from "./buyingCommittee";
import { normalizeCommitteePeople, sourceCommitteeAccount } from "./buyingCommitteeApollo";
import { readCommitteeContacts } from "./buyingCommitteeContacts";
import { committeeCsvCell, exportCommitteeCsv } from "./buyingCommitteeExport";
import { committeeCountry, committeeCountries } from "./buyingCommitteeCountry";
import { parse as parseCsv } from "csv-parse/sync";

let tenantId:number,clientId:number,audienceId:number,foreignClient:number;
let hp:Awaited<ReturnType<typeof seedHpCrmAccounts>>;
const makeConfig=(overrides:Partial<CommitteeConfig>={}):CommitteeConfig=>({
  clientId,name:`Committee test ${randomUUID()}`,country:"India",includeRoster:true,audienceIds:[],
  accountIds:[hp.companyId],categories:["Security","Collaboration"],
  designations:["Chief Information Security Officer"],limitPerAccount:3,
  domains:{[hp.companyId]:"samplecorp.com"},...overrides,
});
beforeAll(async()=>{
  tenantId=Number((await pool.query("INSERT INTO tenants(name,slug) VALUES('Committee tests',$1) RETURNING id",[randomUUID()])).rows[0].id);
  clientId=Number((await pool.query("INSERT INTO clients(tenant_id,name) VALUES($1,'HP') RETURNING id",[tenantId])).rows[0].id);
  foreignClient=Number((await pool.query("INSERT INTO clients(tenant_id,name) VALUES($1,'Another client') RETURNING id",[tenantId])).rows[0].id);
  hp=await seedHpCrmAccounts(tenantId,clientId);
  audienceId=Number((await pool.query("INSERT INTO intent_audiences(tenant_id,client_id,name) VALUES($1,$2,$3) RETURNING id",[tenantId,clientId,randomUUID()])).rows[0].id);
  await pool.query(`INSERT INTO intent_audience_companies(tenant_id,audience_id,company_id) VALUES($1,$2,$3)`,[tenantId,audienceId,hp.companyId]);
  await pool.query(`INSERT INTO tenant_integrations(tenant_id,provider,config) VALUES($1,'apollo',$2::jsonb)`,
    [tenantId,JSON.stringify({apiKey:"test-only-key",enabled:true,maxRequestsPerRun:20})]);
});
afterEach(()=>vi.unstubAllGlobals());
afterAll(async()=>{
  if(!tenantId)return;
  await pool.query("DELETE FROM buying_committee_export_audits WHERE tenant_id=ANY($1::int[])",[[tenantId,tenantId+100000]]);
  await pool.query("DELETE FROM buying_committee_plans WHERE tenant_id=$1",[tenantId]);
  await pool.query("DELETE FROM intent_audience_companies WHERE tenant_id=$1",[tenantId]);
  await pool.query("DELETE FROM intent_audiences WHERE tenant_id=$1",[tenantId]);
  await pool.query("DELETE FROM tenant_integrations WHERE tenant_id=$1",[tenantId]);
  await cleanHpCrmTenant(tenantId);
});
function api(role="admin",tenant=tenantId){
  const app=express();app.use(express.json());
  app.use((req,_res,next)=>{req.isAuthenticated=(()=>role!=="anonymous") as any;req.user={id:1,tenantId:tenant,role} as any;next();});
  app.use(committeeRouter);return supertest(app);
}
async function approved(config=makeConfig()){
  const draft=await saveCommitteePlan(tenantId,1,config);
  return approveCommitteePlan(tenantId,1,draft.plan.id,draft.plan.revision);
}
function mockApollo(email="prospect@samplecorp.com",country:string|null="India"){
  const mock=vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({people:[{id:"apollo-test-person"}]}),{status:200}))
    .mockResolvedValueOnce(new Response(JSON.stringify({matches:[{id:"apollo-test-person",name:"Sourced Person",email,title:"Security Director",
      country,organization:{primary_domain:"samplecorp.com"},linkedin_url:"https://www.linkedin.com/in/example"}]}),{status:200}));
  vi.stubGlobal("fetch",mock);return mock;
}

async function savedProspect(email: string|null = `${randomUUID()}@samplecorp.com`) {
  return (await pool.query(`INSERT INTO buying_committee_contacts
    (tenant_id,client_id,company_id,apollo_id,name,email,title,phone,linkedin,location)
    VALUES($1,$2,$3,$4,'Database Test Person',$5,'Security Director','1234567890',$6,'Mumbai, India') RETURNING *`,
  [tenantId,clientId,hp.companyId,randomUUID(),email,`https://www.linkedin.com/in/${randomUUID()}`])).rows[0];
}

it("saves a reviewed prospect once into its owned roster account without creating engagement or outreach",async()=>{
  const p=await savedProspect(), fetch=vi.fn(); vi.stubGlobal("fetch",fetch);
  const input={clientId,companyId:hp.companyId,prospectId:p.id,confirm:true};
  const results=await Promise.all([api().post("/buying-committee/contacts/save").send(input).expect(200),
    api().post("/buying-committee/contacts/save").send(input).expect(200)]);
  expect(results[0].body.contactId).toBe(results[1].body.contactId);
  expect(results.map(r=>r.body.created).sort()).toEqual([false,true]);
  const c=(await pool.query("SELECT * FROM contacts WHERE tenant_id=$1 AND id=$2",[tenantId,results[0].body.contactId])).rows[0];
  expect(c).toMatchObject({client_id:clientId,company_id:hp.companyId,email:p.email,phone:p.phone,
    title:p.title,linkedin_url:p.linkedin,country:"India",source:"buying_committee",lead_score:0,stage:"pre-aware"});
  expect(Number(c.intent_score)).toBe(0);
  expect((await pool.query("SELECT count(*)::int n FROM activity_events WHERE tenant_id=$1 AND contact_id=$2",[tenantId,c.id])).rows[0].n).toBe(0);
  expect(fetch).not.toHaveBeenCalled();
  const visible=await readCommitteeContacts(tenantId,clientId,[hp.companyId],1,100);
  expect(visible.items.find(row=>row.id===`apollo:${p.id}`)).toMatchObject({crmContactId:c.id,engaged:false});
});

it("reuses matching contacts, preserves corrections and DNC, and keeps prior verified interactions bold-eligible",async()=>{
  const p=await savedProspect();
  const c=(await pool.query(`INSERT INTO contacts(tenant_id,client_id,company_id,email,first_name,title,dnc,status,lead_score)
    VALUES($1,$2,$3,$4,'Corrected Name','Corrected Title',true,'inactive',17) RETURNING id`,
  [tenantId,clientId,hp.companyId,p.email.toUpperCase()])).rows[0];
  await pool.query(`INSERT INTO activity_events(tenant_id,client_id,company_id,contact_id,event_type,is_bot,description)
    VALUES($1,$2,$3,$4,'call_completed',false,'Test completed call')`,[tenantId,clientId,hp.companyId,c.id]);
  const result=await api().post("/buying-committee/contacts/save").send({clientId,companyId:hp.companyId,prospectId:p.id,confirm:true}).expect(200);
  expect(result.body).toEqual({contactId:c.id,created:false});
  expect((await pool.query("SELECT * FROM contacts WHERE id=$1",[c.id])).rows[0]).toMatchObject({
    first_name:"Corrected Name",title:"Corrected Title",dnc:true,status:"inactive",lead_score:17,phone:p.phone});
  const visible=await readCommitteeContacts(tenantId,clientId,[hp.companyId],1,100);
  expect(visible.items.find(row=>row.id===`apollo:${p.id}`)).toMatchObject({engaged:true,engagementSources:["Completed call"]});
});

it("requires admin confirmation and exact ownership, and rejects conflicting or ambiguous identities",async()=>{
  const p=await savedProspect();
  const input={clientId,companyId:hp.companyId,prospectId:p.id,confirm:true};
  await api("sales").post("/buying-committee/contacts/save").send(input).expect(403);
  await api("anonymous").post("/buying-committee/contacts/save").send(input).expect(401);
  await api().post("/buying-committee/contacts/save").send({...input,confirm:false}).expect(400);
  await api().post("/buying-committee/contacts/save").send({...input,companyId:hp.siblingId}).expect(404);
  await api("admin",tenantId+100000).post("/buying-committee/contacts/save").send(input).expect(404);
  const other=(await pool.query(`INSERT INTO contacts(tenant_id,client_id,company_id,email)
    VALUES($1,$2,$3,$4) RETURNING id`,[tenantId,clientId,hp.siblingId,p.email])).rows[0];
  await api().post("/buying-committee/contacts/save").send(input).expect(409);
  expect((await pool.query("SELECT company_id FROM contacts WHERE id=$1",[other.id])).rows[0].company_id).toBe(hp.siblingId);
  await pool.query(`INSERT INTO contacts(tenant_id,client_id,company_id,email) VALUES($1,$2,$3,$4)`,[tenantId,clientId,hp.companyId,p.email]);
  await api().post("/buying-committee/contacts/save").send(input).expect(409);
});

it("saves a no-email prospect idempotently without making a lead or faking prior engagement",async()=>{
  const p=await savedProspect(null),input={clientId,companyId:hp.companyId,prospectId:p.id,confirm:true};
  const first=await api().post("/buying-committee/contacts/save").send(input).expect(200);
  const second=await api().post("/buying-committee/contacts/save").send(input).expect(200);
  expect(second.body).toEqual({contactId:first.body.contactId,created:false});
  const c=(await pool.query("SELECT email,identifier,lead_score FROM contacts WHERE id=$1",[first.body.contactId])).rows[0];
  expect(c).toEqual({email:null,identifier:`buying-committee:${p.id}`,lead_score:0});
});
it("copies approved zero-result targeting without writes or provider calls, then saves a separately approvable draft",async()=>{
  const original=await approved(makeConfig({audienceIds:[audienceId]}));
  vi.stubGlobal("fetch",vi.fn().mockResolvedValue(new Response(JSON.stringify({people:[]}),{status:200})));
  await sourceCommitteeAccount(tenantId,original.plan.id,hp.companyId,false);
  const before=await committeePlan(tenantId,original.plan.id);
  expect(before.targets[0]).toMatchObject({status:"completed",found:0});
  const plansBefore=await pool.query("SELECT * FROM buying_committee_plans WHERE tenant_id=$1 ORDER BY id",[tenantId]);
  const contactsBefore=await pool.query("SELECT * FROM buying_committee_contacts WHERE tenant_id=$1 ORDER BY id",[tenantId]);
  const noProvider=vi.fn();vi.stubGlobal("fetch",noProvider);
  const copied=await api().post(`/buying-committee/plans/${original.plan.id}/copy`).send({}).expect(200);
  expect(copied.body.config).toEqual(expect.objectContaining({
    ...makeConfig(),name:expect.stringContaining("(revised)"),audienceIds:[audienceId],
  }));
  expect(copied.body.config.requestBudget).toBeUndefined();
  expect(copied.body.accounts).toContainEqual({id:hp.companyId,name:before.targets[0].name});
  expect((await pool.query("SELECT * FROM buying_committee_plans WHERE tenant_id=$1 ORDER BY id",[tenantId])).rows).toEqual(plansBefore.rows);
  const saved=await api().post("/buying-committee/plans").send({...copied.body.config,designations:["IT Director"],country:"United Kingdom"}).expect(201);
  expect(saved.body.plan.id).not.toBe(original.plan.id);
  expect(saved.body.plan).toMatchObject({status:"draft",approved_at:null,approved_by:null,revision:1});
  expect(saved.body.targets[0]).toMatchObject({status:"pending",requests:0,responses:0,found:0});
  await api().post(`/buying-committee/plans/${saved.body.plan.id}/source`).send({accountId:hp.companyId,confirm:true}).expect(409);
  await api().put(`/buying-committee/plans/${original.plan.id}`).send(copied.body.config).expect(409);
  expect(await committeePlan(tenantId,original.plan.id)).toEqual(before);
  expect((await pool.query("SELECT * FROM buying_committee_contacts WHERE tenant_id=$1 ORDER BY id",[tenantId])).rows).toEqual(contactsBefore.rows);
  expect(noProvider).not.toHaveBeenCalled();
});
it("enforces admin, tenant and HP client ownership when preparing copies",async()=>{
  const original=await approved();
  const path=`/buying-committee/plans/${original.plan.id}/copy`;
  for(const role of ["member","viewer"]) await api(role).post(path).send({}).expect(403);
  await api("anonymous").post(path).send({}).expect(401);
  await api("admin",tenantId+100000).post(path).send({}).expect(404);
  const draft=await saveCommitteePlan(tenantId,1,makeConfig());
  await api().post(`/buying-committee/plans/${draft.plan.id}/copy`).send({}).expect(409);
  await pool.query("UPDATE buying_committee_plans SET client_id=$2 WHERE id=$1",[original.plan.id,foreignClient]);
  await api().post(path).send({}).expect(404);
});
it("copies incomplete global approvals without guessing country or domains; saving stays non-spending",async()=>{
  const legacy=await saveCommitteePlan(tenantId,1,makeConfig({country:undefined,domains:{[hp.companyId]:""}}));
  await pool.query("UPDATE buying_committee_plans SET status='approved' WHERE id=$1",[legacy.plan.id]);
  const noProvider=vi.fn();vi.stubGlobal("fetch",noProvider);
  const response=await api().post(`/buying-committee/plans/${legacy.plan.id}/copy`).send({}).expect(200);
  expect(response.body.config.country).toBeUndefined();
  expect(response.body.config.domains[String(hp.companyId)]).toBe("");
  const saved=await api().post("/buying-committee/plans").send(response.body.config).expect(201);
  expect(saved.body.targets[0].domain).toBe("");
  await api().post(`/buying-committee/plans/${saved.body.plan.id}/approve`).send({revision:1,confirm:true}).expect(400);
  await api().put(`/buying-committee/plans/${saved.body.plan.id}`).send({...response.body.config,country:"India"}).expect(200);
  await api().post(`/buying-committee/plans/${saved.body.plan.id}/approve`).send({revision:2,confirm:true}).expect(400);
  expect((await committeePlan(tenantId,legacy.plan.id)).plan.status).toBe("approved");
  expect(noProvider).not.toHaveBeenCalled();
});
it("suggests category-specific roles, deduplicates overlap and rejects unsafe domains",()=>{
  const suggestions=designationSuggestions(["Security","IT Hardware","Collaboration","Business Services"]);
  expect(suggestions).toContain("Chief Information Security Officer");
  expect(suggestions).toContain("Unified Communications Manager");
  expect(suggestions).toContain("IT Infrastructure Manager");
  expect(suggestions).toContain("Service Delivery Manager");
  expect(suggestions.filter(x=>x==="IT Procurement Manager")).toHaveLength(1);
  expect(committeeDomain("https://www.SampleCorp.com/about")).toBe("samplecorp.com");
  for(const value of ["localhost","127.0.0.1","user@example.com","https://user:pass@samplecorp.com","bad domain"])expect(committeeDomain(value)).toBe("");
});
it("requires authentication, admin writes and tenant-owned HP scope",async()=>{
  expect((await api("anonymous").get("/buying-committee/options")).status).toBe(401);
  expect((await api("sales").post("/buying-committee/plans").send(makeConfig())).status).toBe(403);
  expect((await api().get(`/buying-committee/accounts?clientId=${foreignClient}`)).status).toBe(404);
  const draft=await saveCommitteePlan(tenantId,1,makeConfig());
  expect((await api("admin",tenantId+1000000).get(`/buying-committee/plans/${draft.plan.id}`)).status).toBe(404);
  expect((await api("sales").get(`/buying-committee/plans/${draft.plan.id}`)).status).toBe(200);
  const options=await api().get("/buying-committee/options");
  expect(options.status).toBe(200);
  expect(options.body.configured).toBe(true);
  expect(JSON.stringify(options.body)).not.toContain("test-only-key");
});
it("approves the saved revision only and never calls a provider for drafts or approval",async()=>{
  const fetchMock=vi.fn();vi.stubGlobal("fetch",fetchMock);
  const first=await saveCommitteePlan(tenantId,1,makeConfig());
  const edited=await saveCommitteePlan(tenantId,1,makeConfig({designations:["Head of Digital Workplace"]}),first.plan.id);
  await expect(approveCommitteePlan(tenantId,1,first.plan.id,first.plan.revision)).rejects.toMatchObject({status:409});
  await expect(sourceCommitteeAccount(tenantId,first.plan.id,hp.companyId,false)).rejects.toMatchObject({status:409});
  const result=await approveCommitteePlan(tenantId,1,edited.plan.id,edited.plan.revision);
  expect(result.plan.config.designations).toEqual(["Head of Digital Workplace"]);
  expect(result.plan.approved_by).toBe(1);
  await expect(saveCommitteePlan(tenantId,1,makeConfig(),result.plan.id)).rejects.toMatchObject({status:409});
  expect(fetchMock).not.toHaveBeenCalled();
});
it("requires company identity, validates source membership and respects request bounds",async()=>{
  const missing=await saveCommitteePlan(tenantId,1,makeConfig({domains:{[hp.companyId]:""}}));
  await expect(approveCommitteePlan(tenantId,1,missing.plan.id,missing.plan.revision)).rejects.toThrow(/domain/);
  await expect(saveCommitteePlan(tenantId,1,makeConfig({includeRoster:false,audienceIds:[audienceId],accountIds:[hp.siblingId]}))).rejects.toThrow(/selected HP/);
  await pool.query(`UPDATE tenant_integrations SET config=jsonb_set(config,'{maxRequestsPerRun}','1') WHERE tenant_id=$1 AND provider='apollo'`,[tenantId]);
  const over=await saveCommitteePlan(tenantId,1,makeConfig());
  await expect(approveCommitteePlan(tenantId,1,over.plan.id,over.plan.revision)).rejects.toThrow(/limit is 1/);
  await pool.query(`UPDATE tenant_integrations SET config=jsonb_set(config,'{maxRequestsPerRun}','20') WHERE tenant_id=$1 AND provider='apollo'`,[tenantId]);
});
it("uses Apollo search plus enrichment, guards company domain and completed idempotency",async()=>{
  const plan=await approved(),mock=mockApollo();
  await sourceCommitteeAccount(tenantId,plan.plan.id,hp.companyId,false);
  expect(mock).toHaveBeenCalledTimes(2);
  expect(mock.mock.calls[0][0]).toContain("q_organization_domains_list%5B%5D=samplecorp.com");
  expect(mock.mock.calls[0][0]).toContain("person_locations%5B%5D=India");
  const body=JSON.parse(mock.mock.calls[1][1].body);
  expect(body).toEqual({details:[{id:"apollo-test-person"}],reveal_personal_emails:false,reveal_phone_number:false});
  expect((await committeePlan(tenantId,plan.plan.id)).targets[0]).toMatchObject({status:"completed",requests:2,responses:2,found:1});
  await sourceCommitteeAccount(tenantId,plan.plan.id,hp.companyId,true);
  expect(mock).toHaveBeenCalledTimes(2);
  const normalized=normalizeCommitteePeople([{id:"p",name:"Wrong Employer",organization:{primary_domain:"unrelated.com"}}],new Set(["p"]),"samplecorp.com");
  expect(normalized).toEqual([]);
  const contacts=await readCommitteeContacts(tenantId,clientId,[hp.companyId],1,25);
  expect(contacts.items.find(p=>p.email==="prospect@samplecorp.com")).toMatchObject({source:"Apollo",engaged:false});
});
it("retains failed attempts, requires explicit retry, blocks active double claims and keeps partial results",async()=>{
  const plan=await approved(makeConfig({accountIds:[hp.companyId,hp.siblingId],domains:{[hp.companyId]:"samplecorp.com",[hp.siblingId]:"secondcorp.com"}}));
  vi.stubGlobal("fetch",vi.fn().mockResolvedValue(new Response("Forbidden",{status:403})));
  await expect(sourceCommitteeAccount(tenantId,plan.plan.id,hp.companyId,false)).rejects.toThrow(/403/);
  expect((await committeePlan(tenantId,plan.plan.id)).targets[0]).toMatchObject({requests:1,responses:1,status:"failed"});
  await expect(sourceCommitteeAccount(tenantId,plan.plan.id,hp.companyId,false)).rejects.toMatchObject({status:409});
  mockApollo();
  await sourceCommitteeAccount(tenantId,plan.plan.id,hp.companyId,true);
  const targets=(await committeePlan(tenantId,plan.plan.id)).targets;
  expect(targets[0]).toMatchObject({requests:3,responses:3,status:"completed"});
  expect(targets[1].status).toBe("pending");
  await pool.query("UPDATE buying_committee_targets SET status='processing',started_at=NOW() WHERE plan_id=$1 AND company_id=$2",[plan.plan.id,hp.siblingId]);
  await expect(sourceCommitteeAccount(tenantId,plan.plan.id,hp.siblingId,true)).rejects.toMatchObject({status:409});
});
it("attributes only exact-account first-party engagement, excludes bots/tags and includes unsourced engaged contacts",async()=>{
  const journeyId=Number((await pool.query(`INSERT INTO journeys(tenant_id,client_id,name,slug) VALUES($1,$2,'Committee journey',$3) RETURNING id`,[tenantId,clientId,randomUUID()])).rows[0].id);
  const makeContact=async(name:string,email:string,company=hp.companyId)=>Number((await pool.query(`INSERT INTO contacts(tenant_id,client_id,company_id,first_name,email,lead_score,tags)
    VALUES($1,$2,$3,$4,$5,999,ARRAY['engaged']) RETURNING id`,[tenantId,clientId,company,name,email])).rows[0].id);
  const alice=await makeContact("Verified", "PROSPECT@samplecorp.com");
  const formPerson=await makeContact("Form Contact","form@samplecorp.com");
  const bot=await makeContact("Bot Contact","bot@samplecorp.com");
  const noEvidence=await makeContact("Not Really Engaged","no@samplecorp.com");
  const wrongAccount=await makeContact("Different Account","other@samplecorp.com",hp.siblingId);
  await pool.query(`INSERT INTO visitor_tokens(tenant_id,contact_id,token) VALUES($1,$2,$3),($1,$4,$5)`,
    [tenantId,alice,`committee-alice-${tenantId}`,bot,`committee-bot-${tenantId}`]);
  await pool.query(`INSERT INTO journey_events(tenant_id,journey_id,event_type,visitor_token,is_bot,props)
    VALUES($1,$2,'page_view',$3,false,'{}'),($1,$2,'page_view',$4,true,'{}')`,[tenantId,journeyId,`committee-alice-${tenantId}`,`committee-bot-${tenantId}`]);
  await pool.query(`INSERT INTO form_submissions(tenant_id,journey_id,contact_id,field_values) VALUES($1,$2,$3,'{}')`,[tenantId,journeyId,formPerson]);
  const sourceId=Number((await pool.query(`INSERT INTO intent_inbound_sources(tenant_id,client_id,name,folder_url,folder_id,form_type)
    VALUES($1,$2,'Test questionnaires','test-only',$3,'event_feedback') RETURNING id`,[tenantId,clientId,randomUUID()])).rows[0].id);
  await pool.query(`INSERT INTO intent_inbound_submissions(tenant_id,client_id,account_id,contact_id,source_id,drive_file_id,file_name,row_key,classification,classification_reason,form_type)
    VALUES($1,$2,$3,$4,$5,'test-only','test.csv','row-a','cold','test','event_feedback'),
    ($1,$2,$3,$6,$5,'test-only','test.csv','row-b','cold','test','event_feedback')`,[tenantId,clientId,hp.companyId,hp.contactId,sourceId,wrongAccount]);
  const result=await readCommitteeContacts(tenantId,clientId,[hp.companyId],1,25);
  const apollo=result.items.find(p=>p.email==="prospect@samplecorp.com");
  expect(apollo).toMatchObject({engaged:true,engagementSources:["Journey engagement"]});
  expect(result.items.some(p=>p.id===`contact:${alice}`)).toBe(false);
  expect(result.items.find(p=>p.id===`contact:${formPerson}`)).toMatchObject({engaged:true,engagementSources:["Lead form"]});
  expect(result.items.find(p=>p.id===`contact:${hp.contactId}`)?.engagementSources).toContain("Event questionnaire");
  const download = await api().get("/buying-committee/contacts/export").query({clientId,accountIds:String(hp.companyId)});
  expect(download.status).toBe(200);
  const exported = parseCsv(download.text, {bom:true,columns:true});
  expect(exported).toHaveLength(result.total);
  expect(exported.find((p:any)=>p["Business email"]==="prospect@samplecorp.com")).toMatchObject({
    "Verified engagement":"Yes","Verified engagement sources":"Journey engagement","Provenance":"Apollo",
  });
  for(const email of ["bot@samplecorp.com","no@samplecorp.com","other@samplecorp.com"])
    expect(exported.some((p:any)=>p["Business email"]===email)).toBe(false);
  for(const id of [bot,noEvidence,wrongAccount])expect(result.items.some(p=>p.id===`contact:${id}`)).toBe(false);
  const secondPage=await readCommitteeContacts(tenantId,clientId,[hp.companyId],2,1);
  expect(secondPage.items).toHaveLength(1);expect(secondPage.total).toBe(result.total);
  const foreign=Number((await pool.query("INSERT INTO companies(tenant_id,client_id,name) VALUES($1,$2,'Wrong Client') RETURNING id",[tenantId,foreignClient])).rows[0].id);
  await expect(readCommitteeContacts(tenantId,clientId,[foreign],1,25)).rejects.toMatchObject({status:404});
});
it("fences late responses after an explicit stale retry while retaining all request accounting",async()=>{
  const plan=await approved();
  let finish!:(response:Response)=>void;
  const mock=vi.fn().mockImplementationOnce(()=>new Promise<Response>(resolve=>{finish=resolve;}))
    .mockResolvedValueOnce(new Response(JSON.stringify({people:[]}),{status:200}));
  vi.stubGlobal("fetch",mock);
  const first=sourceCommitteeAccount(tenantId,plan.plan.id,hp.companyId,false).catch(error=>error);
  await vi.waitFor(()=>expect(mock).toHaveBeenCalledTimes(1));
  await expect(sourceCommitteeAccount(tenantId,plan.plan.id,hp.companyId,true)).rejects.toMatchObject({status:409});
  await pool.query("UPDATE buying_committee_targets SET started_at=NOW()-interval '6 minutes' WHERE plan_id=$1",[plan.plan.id]);
  await sourceCommitteeAccount(tenantId,plan.plan.id,hp.companyId,true);
  finish(new Response(JSON.stringify({people:[]}),{status:200}));
  expect(await first).toMatchObject({status:409});
  expect((await committeePlan(tenantId,plan.plan.id)).targets[0]).toMatchObject({status:"completed",found:0,requests:2,responses:2});
});
it("never resets spent request bounds or makes a second provider request beyond the plan budget",async()=>{
  const plan=await approved();
  await pool.query(`UPDATE buying_committee_plans SET config=jsonb_set(config,'{requestBudget}','1') WHERE id=$1 AND tenant_id=$2`,[plan.plan.id,tenantId]);
  const mock=mockApollo();
  await expect(sourceCommitteeAccount(tenantId,plan.plan.id,hp.companyId,false)).rejects.toThrow(/request limit/);
  expect(mock).toHaveBeenCalledTimes(1);
  await expect(sourceCommitteeAccount(tenantId,plan.plan.id,hp.companyId,true)).rejects.toThrow(/request limit/);
  expect(mock).toHaveBeenCalledTimes(1);
  expect((await committeePlan(tenantId,plan.plan.id)).targets[0]).toMatchObject({status:"failed",requests:1,responses:1});
});
it("pages database-selected accounts before returning them and searches the full source",async()=>{
  for(let i=0;i<25;i++){
    const id=Number((await pool.query("INSERT INTO companies(tenant_id,client_id,name) VALUES($1,$2,$3) RETURNING id",[tenantId,clientId,`Pagination Company ${String(i).padStart(2,"0")}`])).rows[0].id);
    await pool.query("INSERT INTO intent_audience_companies(tenant_id,audience_id,company_id) VALUES($1,$2,$3)",[tenantId,audienceId,id]);
  }
  const first=await committeeAccounts(tenantId,clientId,false,[audienceId],"",1),second=await committeeAccounts(tenantId,clientId,false,[audienceId],"",2);
  expect(first.items).toHaveLength(20);expect(first.total).toBe(26);expect(second.items).toHaveLength(6);
  expect(new Set([...first.items,...second.items].map(p=>p.id)).size).toBe(26);
  const search=await committeeAccounts(tenantId,clientId,false,[audienceId],"Pagination Company 24",1);
  expect(search.total).toBe(1);expect(search.items[0].name).toBe("Pagination Company 24");
});

it("exports every cursor batch, only selected accounts, with an explicit safe column allowlist",async()=>{
  await pool.query(`INSERT INTO buying_committee_contacts(tenant_id,client_id,company_id,apollo_id,name,title,email,phone,categories)
    SELECT $1,$2,$3,'export-'||n,'CSV Person '||n,'=HYPERLINK("bad")','csv'||n||'@samplecorp.com','+911234','["Security"]'::jsonb
    FROM generate_series(1,405) n`,[tenantId,clientId,hp.companyId]);
  await pool.query(`INSERT INTO buying_committee_contacts(tenant_id,client_id,company_id,apollo_id,name)
    VALUES($1,$2,$3,'not-selected','UNSELECTED PERSON')`,[tenantId,clientId,hp.siblingId]);
  const screen=await readCommitteeContacts(tenantId,clientId,[hp.companyId],1,25);
  expect(screen.total).toBeGreaterThan(405);
  expect(screen.items).toHaveLength(25);
  const response=await api().get("/buying-committee/contacts/export").query({clientId,accountIds:String(hp.companyId)});
  expect(response.status).toBe(200);
  expect(response.headers["cache-control"]).toBe("private, no-store");
  expect(response.headers["content-disposition"]).toContain("attachment");
  const people=parseCsv(response.text,{bom:true,columns:true}) as Record<string,string>[];
  expect(people).toHaveLength(screen.total);
  const csvPeople=people.filter((p:any)=>p.Name.startsWith("CSV Person "));
  expect(new Set(csvPeople.map((p:any)=>p["Business email"])).size).toBe(405);
  expect(csvPeople[0]).toMatchObject({"Designation":'\'=HYPERLINK("bad")',"Available phone":"'+911234",
    "Requested categories (not intent)":"Security","Provenance":"Apollo","Verified engagement":"No"});
  expect(csvPeople[0]["Sourced date"]).toMatch(/^\d{4}-\d\d-\d\dT/);
  expect(people.every((p:any)=>p["Account ID"]===String(hp.companyId))).toBe(true);
  expect(Object.keys(people[0])).toHaveLength(13);
  expect(response.text).not.toMatch(/test-only-key|lead_score|requestBudget|UNSELECTED PERSON/);
  const emptyId=Number((await pool.query("INSERT INTO companies(tenant_id,client_id,name) VALUES($1,$2,'Empty export account') RETURNING id",[tenantId,clientId])).rows[0].id);
  const empty=await api().get("/buying-committee/contacts/export").query({clientId,accountIds:String(emptyId)});
  expect(empty.status).toBe(200);
  expect(parseCsv(empty.text,{bom:true,columns:true})).toEqual([]);
});

it("denies anonymous, non-admin, cross-tenant/client, missing and mixed unauthorized export scopes",async()=>{
  const url="/buying-committee/contacts/export";
  for(const role of ["member","viewer"]) expect((await api(role).get(url).query({clientId,accountIds:hp.companyId})).status).toBe(403);
  expect((await api("anonymous").get(url).query({clientId,accountIds:hp.companyId})).status).toBe(401);
  expect((await api("admin",tenantId+100000).get(url).query({clientId,accountIds:hp.companyId})).status).toBe(404);
  expect((await api().get(url).query({clientId:foreignClient,accountIds:hp.companyId})).status).toBe(404);
  for(const accountIds of [undefined,"","abc",`${hp.companyId},0`]) {
    expect((await api().get(url).query({clientId,...(accountIds===undefined?{}:{accountIds})})).status).toBe(400);
  }
  const foreign=Number((await pool.query("INSERT INTO companies(tenant_id,client_id,name) VALUES($1,$2,'Export wrong client') RETURNING id",[tenantId,foreignClient])).rows[0].id);
  const denied=await api().get(url).query({clientId,accountIds:`${hp.companyId},${foreign}`});
  expect(denied.status).toBe(404);
  expect(denied.headers["content-disposition"]).toBeUndefined();
  expect(denied.text).not.toContain("Business email");
});

it("neutralizes spreadsheet formulas and preserves CSV quotes, newlines and commas",()=>{
  for(const input of ["=1+1","+cmd","-1","@SUM(1)"," \t=1","\rplain","\nplain","\tplain"])
    expect(committeeCsvCell(input).startsWith('"\'')).toBe(true);
  expect(parseCsv(committeeCsvCell('Name, "quoted"\nnext'))[0][0]).toBe('Name, "quoted"\nnext');
  expect(committeeCsvCell(null)).toBe('""');
});

it("reports latest sourcing status independently of historical contacts, with owned-account and country scope",async()=>{
  const baseline=await readCommitteeContacts(tenantId,clientId,[hp.companyId],1,5,"India");
  const saved=await saveCommitteePlan(tenantId,1,makeConfig());
  const draftOnly=await readCommitteeContacts(tenantId,clientId,[hp.companyId],1,5,"India");
  expect(draftOnly.sourcing).toEqual(baseline.sourcing);
  await approveCommitteePlan(tenantId,1,saved.plan.id,saved.plan.revision);
  const before=await readCommitteeContacts(tenantId,clientId,[hp.companyId],1,5,"India");
  expect(before.sourcing).toMatchObject({accounts:1,pendingAccounts:1,completedAccounts:0});
  await pool.query(`UPDATE buying_committee_targets SET status='completed',found=0,completed_at=NOW()
    WHERE tenant_id=$1 AND plan_id=$2`,[tenantId,saved.plan.id]);
  const after=await api().get("/buying-committee/contacts").query({clientId,accountIds:String(hp.companyId),pageSize:5,country:"India"}).expect(200);
  expect(after.body.sourcing).toMatchObject({accounts:1,completedAccounts:1,returnedContacts:0,pendingAccounts:0});
  expect(after.body.sourcing.lastCompletedAt).toBeTruthy();
  expect(after.body.total).toBe(before.total);
  const otherCountry=await readCommitteeContacts(tenantId,clientId,[hp.companyId],1,5,"United Kingdom");
  expect(otherCountry.sourcing.accounts).toBe(0);
  await expect(readCommitteeContacts(tenantId+100000,clientId,[hp.companyId],1,5)).rejects.toThrow();
  const next=await saveCommitteePlan(tenantId,1,makeConfig());
  await approveCommitteePlan(tenantId,1,next.plan.id,next.plan.revision);
  await pool.query(`UPDATE buying_committee_targets SET status='processing',started_at=NOW()-interval '6 minutes'
    WHERE tenant_id=$1 AND plan_id=$2`,[tenantId,next.plan.id]);
  const stale=await readCommitteeContacts(tenantId,clientId,[hp.companyId],1,5,"India");
  expect(stale.sourcing).toMatchObject({accounts:1,failedAccounts:1,processingAccounts:0,completedAccounts:0});
});
it("reads exact saved plan references per member and country, including older pages, without paid or admin actions",async()=>{
  const provider=vi.fn();vi.stubGlobal("fetch",provider);
  const older=await saveCommitteePlan(tenantId,1,makeConfig({name:"Older two-account plan",accountIds:[hp.companyId,hp.siblingId]}));
  const uk=await saveCommitteePlan(tenantId,1,makeConfig({name:"Separate UK plan",country:"United Kingdom"}));
  for(let i=0;i<26;i++) await saveCommitteePlan(tenantId,1,makeConfig({name:`Newer ${i}`}));
  const first=await api("sales").get("/buying-committee/contacts").query({clientId,accountIds:`${hp.companyId},${hp.siblingId}`,pageSize:5}).expect(200);
  expect(first.body.savedPlans.items).toHaveLength(25);
  expect(first.body.savedPlans.hasMore).toBe(true);
  expect(first.body.canExport).toBe(false);
  const second=await api("sales").get("/buying-committee/contacts").query({clientId,accountIds:`${hp.companyId},${hp.siblingId}`,pageSize:5,planPage:2}).expect(200);
  expect(second.body.savedPlans.items.filter((p:any)=>p.planId===older.plan.id).map((p:any)=>p.companyId).sort()).toEqual([hp.companyId,hp.siblingId].sort());
  expect(second.body.savedPlans.items.find((p:any)=>p.planId===uk.plan.id)).toMatchObject({country:"United Kingdom",clientId});
  const country=await api("sales").get("/buying-committee/contacts").query({clientId,accountIds:String(hp.companyId),country:"United Kingdom"}).expect(200);
  expect(country.body.savedPlans.items.every((p:any)=>p.country==="United Kingdom")).toBe(true);
  const detail=await api("sales").get(`/buying-committee/plans/${older.plan.id}`).expect(200);
  expect(detail.body.plan.client_id).toBe(clientId);
  expect(detail.body.targets).toHaveLength(2);
  await api("sales",tenantId+1000000).get(`/buying-committee/plans/${older.plan.id}`).expect(404);
  await api("sales").get("/buying-committee/plans/not-a-number").expect(400);
  await api("sales").get("/buying-committee/plans/2147483648").expect(400);
  await api("sales").get("/buying-committee/plans/2147483647").expect(404);
  await api("sales").get("/buying-committee/contacts").query({clientId:foreignClient,accountIds:String(hp.companyId)}).expect(404);
  await api("sales").get("/buying-committee/contacts").query({clientId,accountIds:String(hp.companyId),planPage:0}).expect(400);
  expect(provider).not.toHaveBeenCalled();
});
it("saves canonical country selection and rejects invalid countries without provider calls",async()=>{
  const mock=vi.fn();vi.stubGlobal("fetch",mock);
  expect(committeeCountries).toContain("India");
  expect(committeeCountry("IN")).toBe("India");
  expect(committeeCountry("USA")).toBe("United States");
  expect(committeeCountry("UK")).toBe("United Kingdom");
  const saved=await api().post("/buying-committee/plans").send(makeConfig({country:"IN"})).expect(201);
  expect(saved.body.plan.config.country).toBe("India");
  const edited=await api().put(`/buying-committee/plans/${saved.body.plan.id}`).send(makeConfig({country:"UK"})).expect(200);
  expect(edited.body.plan.config.country).toBe("United Kingdom");
  await api().post("/buying-committee/plans").send(makeConfig({country:"Not a country"})).expect(400);
  expect(mock).not.toHaveBeenCalled();
});
it("requires a reviewed country before approval and blocks unscoped legacy sourcing without charging",async()=>{
  const legacy=await saveCommitteePlan(tenantId,1,makeConfig({country:undefined}));
  await expect(approveCommitteePlan(tenantId,1,legacy.plan.id,legacy.plan.revision)).rejects.toThrow(/contact country/);
  await pool.query("UPDATE buying_committee_plans SET status='approved' WHERE tenant_id=$1 AND id=$2",[tenantId,legacy.plan.id]);
  const mock=vi.fn();vi.stubGlobal("fetch",mock);
  await expect(sourceCommitteeAccount(tenantId,legacy.plan.id,hp.companyId,false)).rejects.toThrow(/no contact country/);
  expect(mock).not.toHaveBeenCalled();
  expect((await committeePlan(tenantId,legacy.plan.id)).targets[0]).toMatchObject({status:"pending",requests:0});
});
it("does not save out-of-country or unknown-country Apollo enrichment results",async()=>{
  for(const country of ["United States",null]) {
    const plan=await approved();
    const email=`wrong-country-${randomUUID()}@samplecorp.com`;
    mockApollo(email,country);
    await expect(sourceCommitteeAccount(tenantId,plan.plan.id,hp.companyId,false)).rejects.toThrow(/contact country/);
    expect((await committeePlan(tenantId,plan.plan.id)).targets[0]).toMatchObject({status:"failed",requests:2,found:0});
    expect((await pool.query("SELECT id FROM buying_committee_contacts WHERE tenant_id=$1 AND email=$2",[tenantId,email])).rowCount).toBe(0);
  }
});
it("filters Apollo countries consistently before pagination and CSV export while retaining first-party history",async()=>{
  const prefix=`country-${randomUUID()}`;
  const ids:number[]=[];
  try {
    for(const [suffix,location] of [["india","Mumbai, India"],["usa","Seattle, United States"],["unknown",null]] as const) {
      const r=await pool.query(`INSERT INTO buying_committee_contacts(tenant_id,client_id,company_id,apollo_id,name,location)
        VALUES($1,$2,$3,$4,$4,$5) RETURNING id`,[tenantId,clientId,hp.siblingId,`${prefix}-${suffix}`,location]);
      ids.push(r.rows[0].id);
    }
    const filtered=await readCommitteeContacts(tenantId,clientId,[hp.siblingId],1,100,"India");
    const prospects=filtered.items.filter(p=>p.source==="Apollo");
    expect(prospects.map(p=>p.name)).toContain(`${prefix}-india`);
    expect(prospects.map(p=>p.name)).not.toContain(`${prefix}-usa`);
    expect(prospects.map(p=>p.name)).not.toContain(`${prefix}-unknown`);
    const all=await readCommitteeContacts(tenantId,clientId,[hp.siblingId],1,100);
    expect(filtered.items.filter(p=>p.engaged).map(p=>p.email).sort()).toEqual(all.items.filter(p=>p.engaged).map(p=>p.email).sort());
    const beyond=await readCommitteeContacts(tenantId,clientId,[hp.siblingId],100,1,"India");
    expect(beyond.total).toBe(filtered.total);expect(beyond.items).toEqual([]);
    let csv="";
    for await(const chunk of exportCommitteeCsv(tenantId,clientId,[hp.siblingId],undefined,undefined,"India")) csv+=chunk;
    expect(csv).toContain(`${prefix}-india`);expect(csv).not.toContain(`${prefix}-usa`);expect(csv).not.toContain(`${prefix}-unknown`);
    await api().get("/buying-committee/contacts").query({clientId,accountIds:String(hp.siblingId),country:"Invalid country"}).expect(400);
  } finally { await pool.query("DELETE FROM buying_committee_contacts WHERE tenant_id=$1 AND id=ANY($2::int[])",[tenantId,ids]); }
});
it("uses HP Analytics GTM segments for labels and filters across scoped sources before pagination",async()=>{
  const created:number[]=[];
  const previous=(await pool.query("SELECT gtm FROM hp_account_profiles WHERE tenant_id=$1 AND company_id=$2",[tenantId,hp.companyId])).rows[0].gtm;
  try {
    await pool.query("UPDATE hp_account_profiles SET gtm='GCC' WHERE tenant_id=$1 AND company_id=$2",[tenantId,hp.companyId]);
    for(const segment of ["MNC","Gov/Edu","India Inc/PSU",""]) {
      const id=Number((await pool.query("INSERT INTO companies(tenant_id,client_id,name) VALUES($1,$2,$3) RETURNING id",[tenantId,clientId,`Segment scope ${segment||"unclassified"}`])).rows[0].id);
      created.push(id);
      if(segment) await pool.query("INSERT INTO hp_account_profiles(tenant_id,client_id,company_id,gtm,parent_key,parent_name,provenance) VALUES($1,$2,$3,$4,$5,$5,'manual')",[tenantId,clientId,id,segment,`segment-scope-${id}`]);
      await pool.query("INSERT INTO intent_audience_companies(tenant_id,audience_id,company_id) VALUES($1,$2,$3)",[tenantId,audienceId,id]);
    }
    const gcc=await committeeAccounts(tenantId,clientId,true,[audienceId],"",1,"GCC");
    expect(gcc.items.some(a=>a.id===hp.companyId)).toBe(true);
    expect(gcc.items.every(a=>a.segment==="GCC")).toBe(true);
    expect(gcc.segments).toEqual(expect.arrayContaining(["GCC","MNC","Gov/Edu","India Inc/PSU","Unclassified"]));
    const gov=await committeeAccounts(tenantId,clientId,false,[audienceId],"Segment scope",1,"Gov/Edu");
    expect(gov.total).toBe(1);expect(gov.items[0].segment).toBe("Gov/Edu");
    const unknown=await committeeAccounts(tenantId,clientId,false,[audienceId],"Segment scope",1,"Unclassified");
    expect(unknown.total).toBe(1);expect(unknown.items[0].id).toBe(created[3]);
    const second=await committeeAccounts(tenantId,clientId,false,[audienceId],"Segment scope",2,"MNC");
    expect(second.total).toBe(1);expect(second.items).toEqual([]);
  } finally {
    await pool.query("UPDATE hp_account_profiles SET gtm=$3 WHERE tenant_id=$1 AND company_id=$2",[tenantId,hp.companyId,previous]);
    await pool.query("DELETE FROM intent_audience_companies WHERE tenant_id=$1 AND company_id=ANY($2::int[])",[tenantId,created]);
    await pool.query("DELETE FROM companies WHERE tenant_id=$1 AND id=ANY($2::int[])",[tenantId,created]);
  }
});
it("releases its snapshot when a download is cancelled",async()=>{
  const release=vi.spyOn(pool,"connect");
  const stream=exportCommitteeCsv(tenantId,clientId,[hp.companyId]);
  await stream.next();
  const connection=await release.mock.results[0].value;
  const query=vi.spyOn(connection,"query");
  const released=vi.spyOn(connection,"release");
  await stream.return(undefined);
  expect(query).toHaveBeenCalledWith("ROLLBACK");
  expect(released).toHaveBeenCalledOnce();
  query.mockRestore(); released.mockRestore(); release.mockRestore();
});
