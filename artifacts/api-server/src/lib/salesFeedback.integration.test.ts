import {beforeAll,afterAll,describe,it,expect,vi} from "vitest";
import express from "express";
import {randomUUID} from "node:crypto";
import * as XLSX from "xlsx";
import {pool} from "@workspace/db";
const drive=vi.hoisted(()=>({buffer:Buffer.alloc(0) as Buffer,version:"1"}));
vi.mock("./inboundAccounts",()=>({
  googleDriveConnectionAvailable:async()=>false,
  listDriveFiles:async()=>[{id:"fake-file",name:"feedback.xlsx",modifiedTime:drive.version,mimeType:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"}],
  driveBuffer:async()=>drive.buffer,
  parsePurchaseTimeframeMonths:(v:unknown)=>Number(v),
}));
import router from "../routes/salesFeedback";
import {syncFeedbackSource} from "./salesFeedback";
import {loadHpPriorityEvidence} from "./hpAccountPriorityData";

describe("sales feedback real database boundaries",()=>{
  let tenantId:number,clientId:number,accountId:number,contactId:number,otherAccount:number,foreignTenant:number,foreignAccount:number;
  let server:ReturnType<express.Application["listen"]>,url:string;
  let role="admin";
  let authorId:number,requestActor:number|null;
  let authenticated=true;
  const product="Fixture Device Service";
  const at=new Date(Date.now()-86400000).toISOString();
  const request=async(path="",body?:object,method=body?"POST":"GET")=>{
    const response=await fetch(`${url}/api/sales-feedback${path}`,{method,headers:{"Content-Type":"application/json"},...(body?{body:JSON.stringify(body)}:{})});
    return {status:response.status,body:await response.json() as any};
  };
  beforeAll(async()=>{
    tenantId=Number((await pool.query("INSERT INTO tenants(name,slug) VALUES('Feedback fixture',$1) RETURNING id",[`feedback-${randomUUID()}`])).rows[0].id);
    foreignTenant=Number((await pool.query("INSERT INTO tenants(name,slug) VALUES('Other feedback fixture',$1) RETURNING id",[`feedback-${randomUUID()}`])).rows[0].id);
    authorId=Number((await pool.query(`INSERT INTO users(tenant_id,email,password_hash,first_name,last_name,role)
      VALUES($1,$2,'not-a-login-hash','Signed In','Fixture','admin') RETURNING id`,
      [tenantId,`${randomUUID()}@example.invalid`])).rows[0].id);
    requestActor=authorId;
    clientId=Number((await pool.query("INSERT INTO clients(tenant_id,name) VALUES($1,'HP') RETURNING id",[tenantId])).rows[0].id);
    accountId=Number((await pool.query("INSERT INTO companies(tenant_id,client_id,name) VALUES($1,$2,'Feedback Account') RETURNING id",[tenantId,clientId])).rows[0].id);
    otherAccount=Number((await pool.query("INSERT INTO companies(tenant_id,client_id,name) VALUES($1,$2,'Other Account') RETURNING id",[tenantId,clientId])).rows[0].id);
    const foreignClient=Number((await pool.query("INSERT INTO clients(tenant_id,name) VALUES($1,'Other Client') RETURNING id",[foreignTenant])).rows[0].id);
    foreignAccount=Number((await pool.query("INSERT INTO companies(tenant_id,client_id,name) VALUES($1,$2,'Foreign Account') RETURNING id",[foreignTenant,foreignClient])).rows[0].id);
    contactId=Number((await pool.query("INSERT INTO contacts(tenant_id,client_id,company_id,first_name,last_name,email) VALUES($1,$2,$3,'Alice','Fixture','sales-feedback@example.invalid') RETURNING id",[tenantId,clientId,accountId])).rows[0].id);
    const category=(await pool.query("INSERT INTO intent_product_categories(tenant_id,name) VALUES($1,'Business Services') RETURNING id",[tenantId])).rows[0].id;
    await pool.query("INSERT INTO intent_products(tenant_id,category_id,name) VALUES($1,$2,$3)",[tenantId,category,product]);
    const app=express();app.use(express.json());
    app.use((req:any,_res,next)=>{req.isAuthenticated=()=>authenticated;req.user={id:requestActor,tenantId,role};next();});
    app.use("/api",router);
    app.use((error:any,_req:any,res:any,_next:any)=>res.status(500).json({error:error.message}));
    server=app.listen(0,"127.0.0.1");await new Promise<void>(resolve=>server.once("listening",resolve));
    url=`http://127.0.0.1:${(server.address() as any).port}`;
  });
  afterAll(async()=>{
    if(server)await new Promise<void>(resolve=>server.close(()=>resolve()));
    for(const tid of [tenantId,foreignTenant].filter(Boolean)){
      for(const table of ["sales_feedback","sales_feedback_sources","contacts","companies","intent_products","intent_product_categories","clients","users"])
        await pool.query(`DELETE FROM ${table} WHERE tenant_id=$1`,[tid]);
      await pool.query("DELETE FROM tenants WHERE id=$1",[tid]);
    }
  });
  it("stamps the authenticated author and server submission time, ignoring supplied attribution",async()=>{
    const started=Date.now();
    const created=await request("",{clientId,accountId,contactId,type:"sales_rep",repName:"Someone else",
      feedback:"Authenticated feedback",occurredAt:at,createdBy:999999,createdByName:"Impersonated user",createdAt:"2000-01-01T00:00:00Z"});
    expect(created.status,JSON.stringify(created.body)).toBe(201);
    expect(created.body).toMatchObject({createdBy:authorId,createdByName:"Signed In Fixture",repName:"Signed In Fixture"});
    expect(Date.parse(created.body.createdAt)).toBeGreaterThanOrEqual(started-1000);
    expect(Date.parse(created.body.createdAt)).toBeLessThanOrEqual(Date.now()+1000);
    expect(Date.parse(created.body.occurredAt)).toBe(Date.parse(at));
    expect(created.body.rawFields).not.toHaveProperty("createdBy");
    expect(created.body.rawFields).not.toHaveProperty("createdAt");
    expect(created.body.rawFields.repName).toBe("Signed In Fixture");
    const saved=(await request(`?accountId=${accountId}`)).body.items.find((r:any)=>r.id===created.body.id);
    expect(saved).toMatchObject({createdBy:authorId,createdByName:"Signed In Fixture",createdAt:created.body.createdAt});
    const noName=await request("",{clientId,accountId,type:"telesales",feedback:"No user-entered rep name required"});
    expect(noName.status,JSON.stringify(noName.body)).toBe(201);
    expect(noName.body.createdBy).toBe(authorId);
  });
  it("requires a real signed-in tenant user to author manual feedback",async()=>{
    const body={clientId,accountId,type:"sales_rep",feedback:"Must not be accepted"};
    try {
      authenticated=false;
      expect((await request("",body)).status).toBe(401);
      authenticated=true;requestActor=null;
      expect((await request("",body)).status).toBe(401);
      requestActor=2147483647;
      expect((await request("",body)).status).toBe(401);
    } finally {authenticated=true;requestActor=authorId;}
  });
  it("pages beyond A accounts and fetches only the selected account's contacts, independent of global limits",async()=>{
    const addedAccounts=(await pool.query(`INSERT INTO companies(tenant_id,client_id,name)
      SELECT $1,$2,'AA Browse '||lpad(i::text,3,'0') FROM generate_series(1,51) i RETURNING id`,[tenantId,clientId])).rows.map(r=>r.id);
    const addedContacts=(await pool.query(`INSERT INTO contacts(tenant_id,client_id,company_id,first_name,last_name)
      SELECT $1,$2,$3,'Target '||lpad(i::text,3,'0'),'Fixture' FROM generate_series(1,51) i RETURNING id`,
      [tenantId,clientId,accountId])).rows.map(r=>r.id);
    try {
      await pool.query(`INSERT INTO contacts(tenant_id,client_id,company_id,first_name,last_name)
        SELECT $1,$2,id,'AAAA Distractor','Fixture' FROM companies WHERE tenant_id=$1 AND id=ANY($3::int[])`,
        [tenantId,clientId,addedAccounts]);
      const first=await request(`/options?clientId=${clientId}`);
      expect(first.status).toBe(200);
      expect(first.body.accounts).toHaveLength(50);
      expect(first.body.accountsHasMore).toBe(true);
      const next=await request(`/options?clientId=${clientId}&accountPage=2`);
      expect(next.body.accountsHasMore).toBe(false);
      expect(next.body.accounts.some((a:any)=>a.id===otherAccount)).toBe(true);
      expect(new Set([...first.body.accounts,...next.body.accounts].map((a:any)=>a.id)).size).toBe(53);
      const selected=await request(`/options?clientId=${clientId}&accountId=${accountId}`);
      expect(selected.body.contacts).toHaveLength(50);
      expect(selected.body.contactsHasMore).toBe(true);
      expect(selected.body.contacts.every((c:any)=>c.companyId===accountId)).toBe(true);
      expect(selected.body.contacts.some((c:any)=>c.id===contactId)).toBe(true);
      const nextContacts=await request(`/options?clientId=${clientId}&accountId=${accountId}&contactPage=2`);
      expect(nextContacts.body.contacts).toHaveLength(2);
      expect(nextContacts.body.contactsHasMore).toBe(false);
      expect(nextContacts.body.contacts.every((c:any)=>c.companyId===accountId)).toBe(true);
      const byEmail=await request(`/options?clientId=${clientId}&search=sales-feedback%40example.invalid`);
      expect(byEmail.body.accounts.map((a:any)=>a.id)).toEqual([accountId]);
      expect((await request(`/options?clientId=${clientId}&accountPage=0`)).status).toBe(400);
      expect((await request(`/options?clientId=${clientId}&accountId=${foreignAccount}`)).status).toBe(404);
    } finally {
      await pool.query("DELETE FROM contacts WHERE tenant_id=$1 AND (id=ANY($2::int[]) OR company_id=ANY($3::int[]))",[tenantId,addedContacts,addedAccounts]);
      await pool.query("DELETE FROM companies WHERE tenant_id=$1 AND id=ANY($2::int[])",[tenantId,addedAccounts]);
    }
  });
  it("keeps notes pending, applies only explicit reviewed product/timeline, and can revoke",async()=>{
    const created=await request("",{clientId,accountId,contactId,type:"telesales",repName:"Fixture caller",feedback:"Confirmed product discussion",occurredAt:at,product,timingMonths:4,proposedTemperature:"Warm"});
    expect(created.status,JSON.stringify(created.body)).toBe(201);
    const entry=created.body;
    expect(entry.reviewStatus).toBe("pending");expect(entry.approvedQualification).toBe(false);
    expect((await loadHpPriorityEvidence(tenantId,clientId,[accountId])).forms).toHaveLength(0);
    const history=await request(`/${entry.id}/review`,{decision:"approve",note:"History verified only",applyQualification:false});
    expect(history.status,JSON.stringify(history.body)).toBe(200);
    expect((await loadHpPriorityEvidence(tenantId,clientId,[accountId])).forms).toHaveLength(0);
    const approved=await request(`/${entry.id}/review`,{decision:"approve",note:"Buyer timing verified",applyQualification:true,product,timingMonths:4});
    expect(approved.status,JSON.stringify(approved.body)).toBe(200);
    expect((await loadHpPriorityEvidence(tenantId,clientId,[accountId])).forms).toEqual([expect.objectContaining({contactId,product,months:4,reference:`sales-feedback:${entry.id}`})]);
    const rejected=await request(`/${entry.id}/review`,{decision:"reject",note:"Timing no longer confirmed",applyQualification:false});
    expect(rejected.body.reviewHistory).toHaveLength(3);
    expect((await loadHpPriorityEvidence(tenantId,clientId,[accountId])).forms).toHaveLength(0);
  });
  it("denies foreign identities, contact/account conflicts and non-admin reviews",async()=>{
    const base={clientId,type:"sales_rep",repName:"Rep",feedback:"Note"};
    expect((await request("",{...base,accountId:foreignAccount})).status).toBe(404);
    expect((await request("",{...base,accountId:otherAccount,contactId})).status).toBe(400);
    const e=await request("",{...base,accountId,contactId});
    role="member";
    try{expect((await request(`/${e.body.id}/review`,{decision:"approve",note:"Forbidden",applyQualification:false})).status).toBe(403);}
    finally{role="admin";}
  });
  it("requires actual dates and exact catalog products for qualification",async()=>{
    const e=await request("",{clientId,accountId,contactId,type:"sales_rep",repName:"Rep",feedback:"No date"});
    expect((await request(`/${e.body.id}/review`,{decision:"approve",note:"Cannot infer date",applyQualification:true,product,timingMonths:2})).status).toBe(400);
    expect((await request(`/${e.body.id}/review`,{decision:"approve",note:"Invalid product",applyQualification:true,product:"Unknown product",timingMonths:2,occurredAt:at})).status).toBe(400);
    expect((await request(`/${e.body.id}/review`,{decision:"approve",note:"Explicit date and product",applyQualification:true,product,timingMonths:2,occurredAt:at})).status).toBe(200);
  });
  it("deduplicates syncs, revokes superseded qualification and preserves source identity",async()=>{
    const book=(notes:string)=>{
      const w=XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(w,XLSX.utils.aoa_to_sheet([
        ["Opportunity ID","Company / account","Contact name","Email","Last contact date","Telecaller feedback","Telecaller"],
        ["OP-TEST","Feedback Account","Alice Fixture","sales-feedback@example.invalid",at,notes,"Caller"],
      ]),"Lead Tracker");
      return XLSX.write(w,{type:"buffer",bookType:"xlsx"}) as Buffer;
    };
    const sourceInput={clientId,name:"Fixture folder",folderUrl:"https://drive.google.com/drive/folders/fixture-folder",type:"telesales",enabled:true};
    const created=await request("/sources",sourceInput);
    expect(created.status,JSON.stringify(created.body)).toBe(201);
    const sourceId=created.body.id;
    drive.buffer=book("First note");
    expect(await syncFeedbackSource(tenantId,sourceId)).toMatchObject({imported:1,files:1,errors:[]});
    expect(await syncFeedbackSource(tenantId,sourceId)).toMatchObject({imported:0,files:0,errors:[]});
    drive.version="2";
    expect(await syncFeedbackSource(tenantId,sourceId)).toMatchObject({imported:0,duplicates:1,errors:[]});
    const first=(await request(`?accountId=${accountId}`)).body.items.find((r:any)=>r.sourceId===sourceId);
    expect(first.contactId).toBe(contactId);
    expect((await request(`/${first.id}/review`,{decision:"approve",note:"Verified call",applyQualification:true,product,timingMonths:4})).status).toBe(200);
    drive.buffer=book("Changed note");drive.version="3";
    expect(await syncFeedbackSource(tenantId,sourceId)).toMatchObject({imported:1,errors:[]});
    const rows=(await request(`?accountId=${accountId}`)).body.items.filter((r:any)=>r.sourceId===sourceId);
    expect(rows.every((r:any)=>r.createdBy===null&&r.createdByName===null)).toBe(true);
    expect(rows).toHaveLength(2);
    expect(rows.find((r:any)=>r.id===first.id)).toMatchObject({superseded:true,approvedQualification:false});
    expect(rows.find((r:any)=>r.id!==first.id)).toMatchObject({reviewStatus:"pending",approvedQualification:false});
    expect((await request(`/${first.id}/review`,{decision:"approve",note:"Cannot restore old revision",applyQualification:true,product,timingMonths:4})).status).toBe(400);
    expect((await request(`/sources/${sourceId}`,{...sourceInput,type:"sales_rep"},"PUT")).status).toBe(400);
    expect((await request(`/sources/${sourceId}`,{...sourceInput,enabled:false},"PUT")).status).toBe(200);
    await expect(syncFeedbackSource(tenantId,sourceId)).rejects.toThrow(/Enable/);
  });
});
