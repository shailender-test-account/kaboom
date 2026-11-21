import { beforeAll, afterAll, afterEach, describe, it, expect, vi } from "vitest";
import express from "express";
import supertest from "supertest";
import { randomUUID } from "node:crypto";
import { pool } from "@workspace/db";
import databases from "./contactDatabases";
import importer from "./contactsImport";
import verification from "./contactVerification";

vi.mock("../lib/buyingCommittee", () => ({
  apolloCommitteeConfig: vi.fn(async () => ({ configured:true, apiKey:"test-only-key" })),
}));

let tenant: number, other: number, contact: number, client: number;
function api(scope = tenant) {
  const app = express();
  app.use(express.json());
  app.use((req,_res,next) => { req.user = {tenantId:scope,role:"admin"} as any; req.isAuthenticated=(() => true) as any; next(); });
  app.use("/api", databases, importer, verification);
  app.use((err:any,_req:any,res:any,_next:any) => res.status(err.status ?? 500).json({error:err.message}));
  return supertest(app);
}
beforeAll(async () => {
  tenant = (await pool.query("INSERT INTO tenants(name,slug) VALUES('Database tests',$1) RETURNING id",[randomUUID()])).rows[0].id;
  other = (await pool.query("INSERT INTO tenants(name,slug) VALUES('Other DB tests',$1) RETURNING id",[randomUUID()])).rows[0].id;
  client = (await pool.query("INSERT INTO clients(tenant_id,name) VALUES($1,'Test customer') RETURNING id",[tenant])).rows[0].id;
  contact = (await pool.query(`INSERT INTO contacts(tenant_id,client_id,first_name,email,title)
    VALUES($1,$2,'Original',$3,'Original title') RETURNING id`,[tenant,client,`database-${randomUUID()}@example.com`])).rows[0].id;
});
afterEach(() => vi.unstubAllGlobals());
afterAll(async () => {
  await pool.query("DELETE FROM contact_verification_usage WHERE tenant_id=ANY($1::int[])",[[tenant,other]]);
  await pool.query("DELETE FROM sequence_runs WHERE tenant_id=ANY($1::int[])",[[tenant,other]]);
  await pool.query("DELETE FROM sequences WHERE tenant_id=ANY($1::int[])",[[tenant,other]]);
  await pool.query("DELETE FROM contact_verifications WHERE tenant_id=ANY($1::int[])",[[tenant,other]]);
  await pool.query(`DELETE FROM contact_dataset_members WHERE dataset_id IN (SELECT id FROM contact_datasets WHERE tenant_id=ANY($1::int[]))`,[[tenant,other]]);
  await pool.query("DELETE FROM contact_datasets WHERE tenant_id=ANY($1::int[])",[[tenant,other]]);
  await pool.query("DELETE FROM contact_databases WHERE tenant_id=ANY($1::int[])",[[tenant,other]]);
  await pool.query("DELETE FROM segments WHERE tenant_id=ANY($1::int[])",[[tenant,other]]);
  await pool.query("DELETE FROM contacts WHERE tenant_id=ANY($1::int[])",[[tenant,other]]);
  await pool.query("DELETE FROM clients WHERE tenant_id=ANY($1::int[])",[[tenant,other]]);
  await pool.query("DELETE FROM tenants WHERE id=ANY($1::int[])",[[tenant,other]]);
});

describe("central databases and verification", () => {
  it("imports without a client into a named database, reuses it and tracks fixed-list segment membership", async () => {
    const address = `new-${randomUUID()}@example.com`;
    const csv = `First Name,Email\nA,${address}\n`;
    const first = await api().post("/api/contacts/import").field("newDatabaseName","Shared contacts")
      .attach("file",Buffer.from(csv),"contacts.csv").expect(200);
    expect(first.body.imported).toBe(1);
    const list = await api().get("/api/contact-databases").expect(200);
    const d = list.body.databases.find((v:any)=>v.name==="Shared contacts");
    expect(d).toMatchObject({contactCount:1,datasetCount:1});
    expect(list.body.unassignedCount).toBeGreaterThanOrEqual(1);
    const segment = await pool.query("SELECT static_contact_ids FROM segments WHERE id=$1",[d.segmentId]);
    expect(segment.rows[0].static_contact_ids).toHaveLength(1);
    const fixed = (await pool.query(`INSERT INTO segments(tenant_id,name,segment_type,static_contact_ids)
      VALUES($1,'Extra segment','static',ARRAY[]::int[]) RETURNING id`,[tenant])).rows[0].id;
    const next = await api().post("/api/contacts/import").field("databaseId",String(d.id))
      .field("segmentId",String(fixed)).attach("file",Buffer.from(csv),"second.csv").expect(200);
    expect(next.body.imported).toBe(0);
    const after = await api().get("/api/contact-databases").expect(200);
    expect(after.body.databases.find((v:any)=>v.id===d.id)).toMatchObject({contactCount:1,datasetCount:2});
    const page = await api().get(`/api/contact-databases/${d.id}/datasets?page=1`).expect(200);
    expect(page.body.total).toBe(2);
    expect(page.body.datasets[0]).toMatchObject({name:"second.csv",contactCount:1,segmentName:"Extra segment"});
    expect((await pool.query("SELECT static_contact_ids FROM segments WHERE id=$1",[fixed])).rows[0].static_contact_ids).toHaveLength(1);
    const usedId=(await pool.query("SELECT contact_id FROM contact_dataset_members WHERE dataset_id=$1 LIMIT 1",[page.body.datasets[0].id])).rows[0].contact_id;
    const sequence=(await pool.query(`INSERT INTO sequences(tenant_id,client_id,name) VALUES($1,$2,'Recorded sequence') RETURNING id`,
      [tenant,client])).rows[0].id;
    await pool.query(`INSERT INTO sequence_runs(tenant_id,sequence_id,contact_list_ids,segment_id,total_contacts,started_at)
      VALUES($1,$2,ARRAY[$3::int],$4,1,NOW())`,[tenant,sequence,usedId,fixed]);
    const usage=await api().get("/api/contact-databases").expect(200);
    expect(usage.body.databases.find((v:any)=>v.id===d.id).sequences).toContainEqual({id:sequence,name:"Recorded sequence"});
    expect(usage.body.databases.find((v:any)=>v.id===d.id).lastUsedAt).toBeTruthy();
    await api(other).get(`/api/contact-databases/${d.id}/datasets`).expect(404);
  });

  it("requires an exact-email provider identity and review before replacing details", async () => {
    await api().patch("/api/contact-verification-usage").send({ requestLimit: 10 }).expect(200);
    const email=(await pool.query("SELECT email FROM contacts WHERE id=$1",[contact])).rows[0].email;
    const fetch = vi.fn(async () => ({ok:true,json:async()=>({person:{
      email,first_name:"New name",title:"New title",city:"Pune",
    }})}));
    vi.stubGlobal("fetch",fetch);
    expect((await api().get(`/api/contacts/${contact}/verification`).expect(200)).body.status).toBe("not_checked");
    expect(fetch).not.toHaveBeenCalled();
    const result = await api().post(`/api/contacts/${contact}/verification`).expect(200);
    expect(result.body).toMatchObject({status:"review",proposed:{first_name:"New name",title:"New title"}});
    expect(result.body.filledFields).toContain("city");
    const before=(await pool.query("SELECT first_name,title,city FROM contacts WHERE id=$1",[contact])).rows[0];
    expect(before).toMatchObject({first_name:"Original",title:"Original title",city:"Pune"});
    expect(fetch).toHaveBeenCalledTimes(1);
    const reviewed=await api().patch(`/api/contacts/${contact}/verification/${result.body.id}`)
      .send({fields:["title"]}).expect(200);
    expect(reviewed.body.status).toBe("verified");
    const after=(await pool.query("SELECT first_name,title FROM contacts WHERE id=$1",[contact])).rows[0];
    expect(after).toMatchObject({first_name:"Original",title:"New title"});
    await api().patch(`/api/contacts/${contact}/verification/${result.body.id}`).send({fields:["first_name"]}).expect(409);
  });
  it("stops cross-client imports before creating databases or company records", async () => {
    const email=(await pool.query("SELECT email FROM contacts WHERE id=$1",[contact])).rows[0].email;
    const conflictingClient=(await pool.query("INSERT INTO clients(tenant_id,name) VALUES($1,'Other customer') RETURNING id",[tenant])).rows[0].id;
    const response=await api().post("/api/contacts/import")
      .field("clientId",String(conflictingClient)).field("newDatabaseName","Should not exist")
      .attach("file",Buffer.from(`First Name,Email,Company\nOther,${email},Never Created\n`),"conflict.csv").expect(409);
    expect(response.body.errors[0]).toMatch(/another client/);
    expect((await pool.query("SELECT 1 FROM contact_databases WHERE tenant_id=$1 AND name='Should not exist'",[tenant])).rowCount).toBe(0);
    expect((await pool.query("SELECT 1 FROM companies WHERE tenant_id=$1 AND name='Never Created'",[tenant])).rowCount).toBe(0);
  });
});
