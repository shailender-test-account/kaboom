import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Account = { id:number; clientId:number; name:string; domain:string|null; industry:string|null };
type Contact = { id:number; accountId:number; email:string; name:string; phone:string|null; title:string|null; city:string|null };
type Submission = {
  id:number; accountId:number; contactId:number; formType:string; classification:string;
  reason:string; product:string; submittedAt:Date; raw:Record<string,unknown>;
  feedback:Record<string,unknown>; reviews:Record<string,unknown>; months:number|null;
  sourceId:number|null;
};
const data=vi.hoisted(()=>({
  query:vi.fn(),connect:vi.fn(),release:vi.fn(),
}));
vi.mock("@workspace/db",()=>({pool:{query:data.query,connect:data.connect},db:{}}));
vi.mock("../middlewares/requireAuth",async importOriginal=>({
  ...await importOriginal<typeof import("../middlewares/requireAuth")>(),
  requireAuth:(req:any,res:any,next:any)=>{
    if(req.get("authorization")!=="Bearer test-admin"){res.status(401).json({error:"Unauthorized"});return;}
    req.user={id:1,tenantId:7,role:"admin"};next();
  },
}));
vi.mock("../utils/segmentFilter",()=>({buildContactsWhereClause:vi.fn()}));

import router from "../routes/intent";

const app=express().use(express.json()).use(router).use((error:Error,_req:any,res:any,_next:any)=>
  res.status(500).json({error:error.message}));
const result=(rows:any[])=>({rows,rowCount:rows.length});
const api=()=>request(app);
const auth=<T extends {set:(key:string,value:string)=>T}>(call:T)=>call.set("Authorization","Bearer test-admin");

describe("authenticated manual inbound response lifecycle",()=>{
  let accounts:Account[],contacts:Contact[],submissions:Submission[];
  let nextAccount:number,nextContact:number,nextSubmission:number;
  const product={id:81,name:"HP Security Services",category:"Security",subcategory:null};
  const body=(formType:"lead_form"|"event_feedback",months:number|null,date:string)=>({
    clientId:8,name:"Acme Labs",domain:"acme.example",industry:"Technology",
    contactName:"Alex Smith",contactEmail:"Alex@Acme.example",contactPhone:"555-0100",
    designation:"IT Director",city:"Pune",productId:81,categoryName:"Security",
    purchaseTimeframeMonths:months,formType,
    ...(formType==="lead_form"?{formFilledDate:date}:{eventName:"Tech Summit",eventDate:date}),
  });
  const contactRow=(contact:Contact)=>({
    id:contact.id,accountId:contact.accountId,clientId:8,name:contact.name,
    email:contact.email,phone:contact.phone,accountName:accounts.find(a=>a.id===contact.accountId)?.name,
  });
  const responseRow=(s:Submission)=>({
    id:s.id,formType:s.formType,fileName:"Manual entry",submittedAt:s.submittedAt,
    classification:s.classification,classificationReason:s.reason,productInterest:s.product,
    productAffinity:s.product,accountId:s.accountId,clientId:8,updatedAt:s.submittedAt,
    answers:s.raw,affinityReviews:s.reviews,contactId:s.contactId,
    identityReview:null,reviewedSourceAccountId:null,reviewedSourceContactId:null,fieldMappings:null,
  });
  const cardRow=(s:Submission)=>{
    const a=accounts.find(a=>a.id===s.accountId)!;
    const c=contacts.find(c=>c.id===s.contactId)!;
    return {account_id:a.id,client_id:8,name:a.name,domain:a.domain,industry:a.industry,
      classification:s.classification,submitted_at:s.submittedAt,imported_at:s.submittedAt,response_count:1,
      form_type:s.formType,classification_reason:s.reason,product_interest:s.product,
      event_feedback:s.feedback,purchase_timeframe_months:s.months,
      manual_details:{clientId:8,name:a.name,domain:a.domain,industry:a.industry,editable:s.sourceId===null,
        ...s.raw},contact:{id:c.id,name:c.name,email:c.email,phone:c.phone,title:c.title}};
  };
  beforeEach(()=>{
    vi.clearAllMocks();
    accounts=[];contacts=[];submissions=[];nextAccount=100;nextContact=200;nextSubmission=300;
    let snapshot:{accounts:Account[];contacts:Contact[];submissions:Submission[]}|null=null;
    const query=async(sql:string,params:any[]=[]):Promise<ReturnType<typeof result>>=>{
      sql=sql.trim().replace(/\s+/g," ");
      if(sql==="BEGIN"){
        snapshot=structuredClone({accounts,contacts,submissions});return result([]);
      }
      if(sql==="ROLLBACK"){
        if(snapshot)({accounts,contacts,submissions}=snapshot);
        snapshot=null;return result([]);
      }
      if(sql==="COMMIT"){snapshot=null;return result([]);}
      if(sql.startsWith("SELECT pg_advisory_xact_lock("))return result([]);
      if(sql.startsWith("SELECT s.id,s.purchase_timeframe_months,s.raw_fields,src.field_mappings"))
        return result(submissions.map(s=>({id:s.id,purchase_timeframe_months:s.months,raw_fields:s.raw,field_mappings:null})));
      // This suite exercises ordinary clients; HP roster identity has its own tests.
      if(sql==="SELECT id,name FROM clients WHERE tenant_id=$1 AND id=$2")
        return result(params[0]===7&&params[1]===8?[{id:8,name:"Acme client"}]:[]);
      if(sql.includes("SELECT s.client_id,s.contact_id,s.raw_fields,c.inbound_manual_at AS account_added_at FROM intent_inbound_submissions s")||
         sql.includes("SELECT s.id,s.client_id,s.contact_id,s.raw_fields FROM intent_inbound_submissions s"))
        return result(submissions.filter(s=>s.accountId===params[1]).map(s=>({
          id:s.id,client_id:8,contact_id:s.contactId,raw_fields:s.raw,
        })));
      if(sql.startsWith("SELECT ct.id,trim(concat_ws(")&&sql.includes('AS "accountName"'))
        return result(contacts.filter(c=>c.id!==params[1]&&c.name.toLowerCase()===String(params[2]).toLowerCase()).map(c=>({
          id:c.id,name:c.name,email:c.email,accountName:accounts.find(a=>a.id===c.accountId)?.name,
        })));
      if(sql.includes("SELECT id,name FROM journeys WHERE"))
        return result([{id:77,name:"Future of Work"}]);
      if(sql.includes("SELECT ct.id FROM contacts ct"))
        return result(contacts.filter(c=>c.id===params[1]&&c.id!==params[2]&&c.name.toLowerCase()===String(params[3]).toLowerCase()).map(c=>({id:c.id})));
      if(sql.includes("SELECT 1 FROM journeys WHERE"))
        return result(params[1]===77&&params[2]===8?[{one:1}]:[]);
      if(sql.includes("SELECT 1 FROM intent_inbound_submissions s WHERE s.tenant_id=$1 AND s.account_id<>$2"))
        return result(submissions.filter(s=>s.accountId!==params[1]&&(s.raw as any).trackedContact?.contactId===params[2]&&(s.raw as any).trackedContact?.journeyId===params[3]).map(()=>({one:1})));
      if(sql.includes("raw_fields=jsonb_set(raw_fields,'{trackedContact}'")){
        const s=submissions.find(s=>s.id===params[1])!;
        s.raw.trackedContact=JSON.parse(params[2]);return result([]);
      }
      if(sql.includes("raw_fields=raw_fields-'trackedContact'")){
        const s=submissions.find(s=>s.id===params[1])!;
        delete s.raw.trackedContact;return result([]);
      }
      if(sql.startsWith("UPDATE intent_inbound_submissions s SET purchase_timeframe_months=7")||
         sql.startsWith("UPDATE intent_inbound_submissions SET")&&!sql.includes("client_id=$3"))return result([]);
      if(sql.startsWith("SELECT 1 FROM clients"))return result(params[0]===7&&params[1]===8?[{one:1}]:[]);
      if(sql.includes("FROM intent_inbound_category_rules"))return result([]);
      if(sql.startsWith('SELECT p.name,s.name AS "subcategoryName" FROM intent_products p'))
        return result(params[0]===7&&params[1]===product.id?[{name:product.name,subcategoryName:null}]:[]);
      if(sql.includes("FROM intent_products p JOIN intent_product_categories"))return result([product]);
      if(sql.includes("FROM companies")&&sql.includes("lower(name)=lower($3)"))
        return result(accounts.filter(a=>a.name.toLowerCase()===String(params[2]).toLowerCase()||a.domain===params[3]).map(a=>({id:a.id,name:a.name})));
      if(sql.includes("FROM companies")&&sql.includes("inbound_manual=true FOR UPDATE"))
        return result(accounts.filter(a=>a.id===params[1]).map(a=>({id:a.id,client_id:a.clientId,name:a.name})));
      if(sql.includes("FROM companies")&&sql.includes("id<>$3"))
        return result(accounts.filter(a=>a.id!==params[2]&&(a.name===params[3]||a.domain===params[4])));
      if(sql.startsWith("INSERT INTO companies")){
        const a={id:nextAccount++,clientId:params[1],name:params[2],domain:params[3],industry:params[4]};
        accounts.push(a);return result([{id:a.id}]);
      }
      if(sql.startsWith("UPDATE companies")){
        const a=accounts.find(a=>a.id===params[1])!;
        if(sql.includes("name=$4"))Object.assign(a,{clientId:params[2],name:params[3],domain:params[4],industry:params[5]});
        return result([{id:a.id,name:a.name}]);
      }
      if(sql.startsWith("SELECT 1 FROM intent_inbound_submissions"))
        return result(submissions.filter(s=>s.accountId===params[1]).map(()=>({one:1})).slice(0,1));
      if(sql.includes("SELECT id,source_id,contact_id FROM intent_inbound_submissions"))
        return result(submissions.filter(s=>s.accountId===params[1]).map(s=>({id:s.id,source_id:s.sourceId,contact_id:s.contactId})));
      if(sql.startsWith("SELECT id,company_id FROM contacts WHERE tenant_id=$1 AND lower(btrim(email))=$2"))
        return result(contacts.filter(c=>c.email===params[1]).map(c=>({id:c.id,company_id:c.accountId})));
      if(sql==="SELECT id,company_id FROM contacts WHERE tenant_id=$1 AND id=$2 FOR UPDATE")
        return result(contacts.filter(c=>c.id===params[1]).map(c=>({id:c.id,company_id:c.accountId})));
      if(sql.startsWith("INSERT INTO contacts")){
        const c={id:nextContact++,accountId:params[2],name:[params[3],params[4]].filter(Boolean).join(" "),
          email:params[5],phone:params[6],title:params[7],city:params[8]};
        contacts.push(c);return result([{id:c.id}]);
      }
      if(sql.startsWith("UPDATE contacts")){
        const c=contacts.find(c=>c.id===params[1])!;
        Object.assign(c,{accountId:params[3],name:[params[4],params[5]].filter(Boolean).join(" "),
          email:params[6],phone:params[7],title:params[8],city:params[9]});
        return result([]);
      }
      if(sql.startsWith("INSERT INTO intent_inbound_submissions")||sql.startsWith("UPDATE intent_inbound_submissions SET client_id")){
        const editing=sql.startsWith("UPDATE");
        const raw=JSON.parse(params[16]);
        const s:Submission={id:editing?params[1]:nextSubmission++,accountId:editing?submissions.find(s=>s.id===params[1])!.accountId:Number(raw.accountId??accounts.at(-1)!.id),
          contactId:params[3],formType:params[5],classification:params[6],
          reason:params[7],product:params[12],submittedAt:params[13],
          reviews:JSON.parse(params[14]),feedback:JSON.parse(params[15]),
          raw,months:params[10],sourceId:null};
        if(editing)submissions.splice(submissions.findIndex(row=>row.id===s.id),1,s);
        else submissions.push(s);
        return result([{id:s.id}]);
      }
      if(sql.includes("SELECT name FROM companies WHERE tenant_id=$1 AND id=$2"))
        return result(accounts.filter(a=>a.id===params[1]).map(a=>({name:a.name})));
      if(sql.includes("SELECT id,name FROM companies WHERE tenant_id=$1"))
        return result(accounts.filter(a=>(params[1] as number[]).includes(a.id)).map(a=>({id:a.id,name:a.name})));
      if(sql.includes("FROM contacts ct LEFT JOIN companies"))
        return result(contacts.filter(c=>(params[1] as number[]).includes(c.id)||(params[2] as string[]).includes(c.email)).map(contactRow));
      if(sql.includes("FROM intent_inbound_submissions s")&&sql.includes('AS "answers"'))
        return result(submissions.filter(s=>s.accountId===params[1]).map(responseRow));
      if(sql.includes('SELECT s.id AS "submissionId"')&&sql.includes('c.name AS "accountName"'))
        return result(submissions.filter(s=>!params[1]||s.formType===params[1]).map(s=>({
          submissionId:s.id,clientId:8,accountId:s.accountId,accountName:accounts.find(a=>a.id===s.accountId)?.name,
          contactId:s.contactId,productAffinity:s.product,classification:s.classification,
          routingStatus:"pending",affinityReviews:s.reviews,updatedAt:s.submittedAt,
        })));
      if(sql.includes("GROUP BY account_id")&&sql.includes("bool_or(classification"))
        return result(submissions.filter(s=>(params[1] as number[]).includes(s.accountId)).map(s=>({account_id:s.accountId,classification:s.classification})));
      if(sql.includes("SELECT c.id FROM companies c")&&sql.includes("inbound_manual=true"))return result([]);
      if(sql.includes("SELECT count(*)")&&sql.includes(") inbound WHERE"))return result([{count:submissions.length}]);
      if(sql.includes("SELECT * FROM (")&&sql.includes(") inbound WHERE"))
        return result(submissions.filter(s=>!params[2]||s.formType===params[2]).map(cardRow));
      if(sql.includes("count(DISTINCT account_id) FILTER"))
        return result([{hot:submissions.filter(s=>s.classification==="hot"&&(!params[2]||s.formType===params[2])).length,
          warm:submissions.filter(s=>s.classification==="warm"&&(!params[2]||s.formType===params[2])).length,cold:0}]);
      if(sql.includes("SELECT event_feedback,product_interest FROM intent_inbound_submissions"))
        return result(submissions.filter(s=>s.formType==="event_feedback").map(s=>({event_feedback:s.feedback,product_interest:s.product})));
      if(sql.includes('s.account_id AS "accountId"')&&sql.includes('s.id AS "submissionId"'))
        return result(submissions.filter(s=>(params[1] as number[]).includes(s.accountId)).map(s=>{
          const c=contacts.find(c=>c.id===s.contactId)!;
          return {accountId:s.accountId,submissionId:s.id,contactId:c.id,clientId:8,contactName:c.name,
            contactTitle:c.title,contactEmail:c.email,productInterest:s.product,affinityReviews:s.reviews,
            rawFields:s.raw,fieldMappings:null,updatedAt:s.submittedAt,classification:s.classification,
            routingStatus:"pending",routingError:null,manualSelection:null};
        }));
      if(sql.includes("SELECT DISTINCT ON (s.account_id) s.account_id"))
        return result(submissions.filter(s=>(params[1] as number[]).includes(s.accountId)).map(s=>cardRow(s)));
      if(sql.includes("FROM intent_inbound_routing_rules"))return result([]);
      if(sql.includes("SELECT lower(btrim(email)) AS email,company_id FROM contacts"))
        return result(contacts.filter(c=>(params[1] as string[]).includes(c.email)).map(c=>({email:c.email,company_id:c.accountId})));
      throw new Error(`Unexpected SQL: ${sql}`);
    };
    data.query.mockImplementation(query);
    // Assertions must observe transaction mutations, not only pool-level reads.
    data.connect.mockResolvedValue({query:data.query,release:data.release});
  });

  it("requires authentication before the account mutation",async()=>{
    await api().post("/intent/inbound/accounts").send(body("lead_form",3,"2026-09-20")).expect(401);
    await api().patch("/intent/inbound/accounts/100/manual").send(body("lead_form",3,"2026-09-20")).expect(401);
    await api().post("/intent/inbound/accounts/100/tracked-contact")
      .send({contactId:999,journeyId:77,confirmSamePerson:true}).expect(401);
    await api().post("/intent/inbound/responses/300/identity-review")
      .send({action:"relink",ownerContactId:999,sourceAccountId:100,sourceContactId:200,email:"owner@example.test"}).expect(401);
    expect(data.query).not.toHaveBeenCalled();
    expect(data.connect).not.toHaveBeenCalled();
  });

  it("rejects an unknown client before opening a transaction",async()=>{
    await auth(api().post("/intent/inbound/accounts"))
      .send({...body("lead_form",3,"2026-09-20"),clientId:999}).expect(400);
    expect(data.connect).not.toHaveBeenCalled();
    expect(accounts).toEqual([]);
  });

  it("rejects products not returned by the tenant's active catalog on create and edit",async()=>{
    const invalid={...body("lead_form",3,"2026-09-20"),productId:999};
    const rejected=await auth(api().post("/intent/inbound/accounts")).send(invalid).expect(400);
    expect(rejected.body.error).toMatch(/active product from your tenant/);
    expect(accounts).toEqual([]);
    expect(contacts).toEqual([]);
    expect(submissions).toEqual([]);
    const created=await auth(api().post("/intent/inbound/accounts"))
      .send(body("lead_form",3,"2026-09-20")).expect(201);
    const saved=structuredClone({accounts,contacts,submissions});
    data.query.mockClear();
    await auth(api().patch(`/intent/inbound/accounts/${created.body.id}/manual`)).send(invalid).expect(400);
    expect({accounts,contacts,submissions}).toEqual(saved);
    expect(data.query.mock.calls.some(([sql])=>String(sql).trim().startsWith("UPDATE"))).toBe(false);
    expect(data.query).toHaveBeenCalledWith("ROLLBACK");
  });

  it("links a reviewed existing contact only to the chosen journey, without moving the CRM contact",async()=>{
    const created=await auth(api().post("/intent/inbound/accounts")).send(body("lead_form",3,"2026-09-20")).expect(201);
    const accountId=created.body.id;
    accounts.push({id:999,clientId:8,name:"Original company",domain:null,industry:null});
    contacts.push({id:999,accountId:999,name:"Alex Smith",email:"alex@other.example",phone:null,title:null,city:null});
    const path=`/intent/inbound/accounts/${accountId}/tracked-contact`;
    const options=await auth(api().get(path)).expect(200);
    expect(options.body.candidates).toMatchObject([{id:999,accountName:"Original company"}]);
    expect(options.body.journeys).toEqual([{id:77,name:"Future of Work"}]);
    await auth(api().post(path)).send({contactId:999,journeyId:77}).expect(400);
    await auth(api().post(path)).send({contactId:999,journeyId:88,confirmSamePerson:true}).expect(409);
    await auth(api().post(path)).send({contactId:999,journeyId:77,confirmSamePerson:true,startDate:"2020-09-20"}).expect(200);
    expect((await auth(api().get(path)).expect(200)).body.linked).toMatchObject({
      contactId:999,journeyId:77,effectiveFrom:"2020-09-20T00:00:00.000Z",
    });
    expect(contacts.find(c=>c.id===999)?.accountId).toBe(999);
    expect(data.query.mock.calls.some(([sql])=>/^\s*(UPDATE|DELETE FROM) contacts\b/.test(String(sql)))).toBe(false);
    await auth(api().post(path)).send({contactId:null,journeyId:null}).expect(200);
    expect((await auth(api().get(path)).expect(200)).body.linked).toBeNull();
  });

  it("rejects products outside the selected GTM OS category on create and edit",async()=>{
    const invalid={...body("lead_form",3,"2026-09-20"),categoryName:"IT Hardware"};
    const rejected=await auth(api().post("/intent/inbound/accounts")).send(invalid).expect(400);
    expect(rejected.body.error).toMatch(/does not belong/);
    expect(accounts).toHaveLength(0);
    expect(submissions).toHaveLength(0);

    const created=await auth(api().post("/intent/inbound/accounts"))
      .send(body("lead_form",3,"2026-09-20")).expect(201);
    const edit=await auth(api().patch(`/intent/inbound/accounts/${created.body.id}/manual`))
      .send(invalid).expect(400);
    expect(edit.body.error).toMatch(/does not belong/);
    expect(submissions).toMatchObject([{id:created.body.submissionId,raw:{categoryName:"Security"}}]);
  });

  it.each([
    ["lead_form",3,"2026-09-20","hot",6,"2026-09-21","warm"],
    ["event_feedback",6,"2026-09-19","warm",3,"2026-09-22","hot"],
  ] as const)("saves and edits %s with contact, date and status readback",
    async(formType,initialMonths,initialDate,initialStatus,editedMonths,editedDate,editedStatus)=>{
      const created=await auth(api().post("/intent/inbound/accounts")).send(body(formType,initialMonths,initialDate)).expect(201);
      const id=created.body.id,submissionId=created.body.submissionId;
      expect(contacts).toMatchObject([{accountId:id,email:"alex@acme.example",name:"Alex Smith",phone:"555-0100",title:"IT Director",city:"Pune"}]);
      const check=async(status:string,date:string,months:number,name:string,phone:string)=>{
        const list=await auth(api().get("/intent/inbound/accounts"));
        expect(list.status,JSON.stringify(list.body)).toBe(200);
        expect(list.body).toMatchObject({total:1,summary:{[status]:1},accounts:[{
          account_id:id,classification:status,response_count:1,form_type:formType,
          contact:{name,email:"alex@acme.example"},manual_details:{
            contactName:name,contactEmail:"alex@acme.example",contactPhone:phone,
            productId:81,categoryName:"Security",purchaseTimeframeMonths:months,
            ...(formType==="lead_form"?{formFilledDate:date}:{eventName:"Tech Summit",eventDate:date}),
          },
        }]});
        expect(list.body.accounts[0].submitted_at).toBe(`${date}T00:00:00.000Z`);
        const detail=await auth(api().get(`/intent/inbound/accounts/${id}/responses`)).expect(200);
        expect(detail.body).toMatchObject({accountName:"Acme Labs",responses:[{
          id:submissionId,classification:status,submittedAt:`${date}T00:00:00.000Z`,
          answers:{contactName:name,contactEmail:"alex@acme.example",contactPhone:phone,
            productId:81,categoryName:"Security",purchaseTimeframeMonths:months},
        }]});
        const dashboard=await auth(api().get(`/intent/inbound/dashboard?formType=${formType}`)).expect(200);
        expect(dashboard.body.summary).toMatchObject({accounts:1,[status]:1,contacts:1});
        expect(dashboard.body.submissionIds).toBeUndefined();
      };
      await check(initialStatus,initialDate,initialMonths,"Alex Smith","555-0100");
      const edited={...body(formType,editedMonths,editedDate),contactName:"Alex Rivera",contactPhone:"555-0200"};
      const updated=await auth(api().patch(`/intent/inbound/accounts/${id}/manual`)).send(edited);
      expect(updated.status,JSON.stringify(updated.body)).toBe(200);
      expect(submissions).toHaveLength(1);
      expect(submissions[0]).toMatchObject({id:submissionId,sourceId:null,classification:editedStatus,months:editedMonths});
      expect(contacts).toMatchObject([{id:200,name:"Alex Rivera",phone:"555-0200"}]);
      await check(editedStatus,editedDate,editedMonths,"Alex Rivera","555-0200");
    });

  it("rejects an email owned by another account without saving a response",async()=>{
    contacts.push({id:201,accountId:999,email:"alex@acme.example",name:"Other Owner",phone:null,title:null,city:null});
    const response=await auth(api().post("/intent/inbound/accounts")).send(body("lead_form",3,"2026-09-20")).expect(409);
    expect(response.body.error).toMatch(/different company/);
    expect(submissions).toHaveLength(0);
    expect(accounts).toHaveLength(0);
    expect(contacts).toEqual([{id:201,accountId:999,email:"alex@acme.example",name:"Other Owner",phone:null,title:null,city:null}]);
    expect(data.query.mock.calls.some(([sql])=>String(sql).startsWith("INSERT INTO intent_inbound_submissions"))).toBe(false);
    expect(data.query.mock.calls.some(([sql])=>String(sql).startsWith("UPDATE contacts"))).toBe(false);
    expect(data.query).toHaveBeenCalledWith("ROLLBACK");
  });

  it("rejects an edited email owned by another account without overwriting the saved response",async()=>{
    const created=await auth(api().post("/intent/inbound/accounts")).send(body("lead_form",3,"2026-09-20")).expect(201);
    contacts.push({id:201,accountId:999,email:"owner@other.example",name:"Other Owner",phone:null,title:null,city:null});
    const saved=structuredClone({accounts,contacts,submissions});
    data.query.mockClear();
    const response=await auth(api().patch(`/intent/inbound/accounts/${created.body.id}/manual`))
      .send({...body("lead_form",12,"2026-09-22"),name:"Changed name",domain:"changed.example",contactEmail:"owner@other.example"}).expect(409);
    expect(response.body.error).toMatch(/different company/);
    expect(submissions).toMatchObject([{id:created.body.submissionId,classification:"hot",raw:{email:"alex@acme.example"}}]);
    expect({accounts,contacts,submissions}).toEqual(saved);
    expect(data.query.mock.calls.some(([sql])=>String(sql).startsWith("UPDATE intent_inbound_submissions SET client_id"))).toBe(false);
    expect(data.query.mock.calls.some(([sql])=>String(sql).startsWith("UPDATE contacts"))).toBe(false);
    expect(data.query).toHaveBeenCalledWith("ROLLBACK");
  });

  it("rejects editing a response whose preferred contact now belongs to another account",async()=>{
    const created=await auth(api().post("/intent/inbound/accounts")).send(body("lead_form",3,"2026-09-20")).expect(201);
    contacts[0].accountId=999;
    const saved=structuredClone({accounts,contacts,submissions});
    data.query.mockClear();
    await auth(api().patch(`/intent/inbound/accounts/${created.body.id}/manual`))
      .send({...body("lead_form",12,"2026-09-22"),contactEmail:"new@acme.example"}).expect(409);
    expect({accounts,contacts,submissions}).toEqual(saved);
    expect(data.query).toHaveBeenCalledWith(
      "SELECT id,company_id FROM contacts WHERE tenant_id=$1 AND id=$2 FOR UPDATE",[7,200]);
    expect(data.query.mock.calls.some(([sql])=>/^\s*(INSERT INTO|UPDATE) contacts\b/.test(String(sql)))).toBe(false);
    expect(data.query).toHaveBeenCalledWith("ROLLBACK");
  });

  it("blocks an edit after an imported response is linked, before mutating CRM fields",async()=>{
    const created=await auth(api().post("/intent/inbound/accounts")).send(body("event_feedback",12,"2026-09-19")).expect(201);
    submissions.push({...submissions[0],id:301,sourceId:5});
    data.query.mockClear();
    const response=await auth(api().patch(`/intent/inbound/accounts/${created.body.id}/manual`))
      .send({...body("event_feedback",3,"2026-09-22"),name:"Changed name"}).expect(409);
    expect(response.body.error).toMatch(/Imported inbound responses/);
    expect(accounts[0].name).toBe("Acme Labs");
    expect(submissions).toHaveLength(2);
    expect(data.query.mock.calls.some(([sql])=>String(sql).startsWith("UPDATE companies"))).toBe(false);
  });
});