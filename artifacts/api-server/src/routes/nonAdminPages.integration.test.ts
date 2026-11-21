import express from "express";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@workspace/db";
import { sectionAccess } from "../middlewares/sectionAccess";
import { clientAccess } from "../middlewares/clientAccess";
import { requireRole } from "../middlewares/requireAuth";
import analytics from "./analytics";
import intent from "./intent";
import sequences from "./sequences";
import emailSequences from "./email-sequences";
import clients from "./clients";
import notifications from "./notifications";
import contactDatabases from "./contactDatabases";
import scoring from "./scoring";

let tenant: number, first: number, second: number, foreign: number, emptyClient: number;
const allView = Object.fromEntries(["dashboard","analytics","gtm","monitoring","sequences","templates","database"].map(k => [k,"view"]));
function api(role = "manager", permissions: object | null = allView, ids: number[] | null = [first, second]) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.isAuthenticated = (() => true) as any;
    req.user = { tenantId: tenant, role, sectionPermissions: permissions, clientIds: ids } as any;
    next();
  });
  app.use("/api", sectionAccess, clientAccess, analytics, intent, sequences, emailSequences, clients, notifications, contactDatabases, scoring);
  app.patch("/api/sequences/999999", requireRole("admin"), (_req,res) => { res.json({ok:true}); });
  app.use((error: any, _req: any, res: any, _next: any) => {
    res.status(500).json({error:error.message});
  });
  return request(app);
}
beforeAll(async () => {
  tenant = (await pool.query("INSERT INTO tenants(name,slug) VALUES('Page access regression',$1) RETURNING id",[randomUUID()])).rows[0].id;
  const c = (await pool.query(`INSERT INTO clients(tenant_id,name) VALUES($1,'Visible One'),($1,'Visible Two'),($1,'Hidden Client'),($1,'Empty Client') RETURNING id`,[tenant])).rows;
  [first,second,foreign,emptyClient] = c.map(row => Number(row.id));
  for (const [client,name] of [[first,"Visible One"],[second,"Visible Two"],[foreign,"Hidden Account"]] as const) {
    const account = (await pool.query(`INSERT INTO companies(tenant_id,client_id,name,inbound_manual) VALUES($1,$2,$3,true) RETURNING id`,[tenant,client,name])).rows[0].id;
    const contact=(await pool.query(`INSERT INTO contacts(tenant_id,client_id,company_id,first_name,last_name,email)
      VALUES($1,$2,$3,$4,'Fixture',$5) RETURNING id`,[tenant,client,account,name,`${randomUUID()}@example.invalid`])).rows[0].id;
    await pool.query(`INSERT INTO intent_inbound_submissions(tenant_id,client_id,account_id,contact_id,drive_file_id,row_key,
      file_name,form_type,classification,classification_reason,product_interest,purchase_timeframe_months,submitted_at)
      VALUES($1,$2,$3,$4,$5,$5,'Scope fixture','event_feedback','warm','Fixture','HP Poly',4,NOW())`,
      [tenant,client,account,contact,randomUUID()]);
    await pool.query(`INSERT INTO email_sequences(tenant_id,client_id,name) VALUES($1,$2,$3)`,[tenant,client,name]);
  }
});
afterAll(async () => {
  for(const table of ["intent_inbound_submissions","email_sequences","contacts","companies","clients",
    "intent_products","intent_product_subcategories","intent_product_categories","intent_inbound_category_rules"]){
    await pool.query(`DELETE FROM ${table} WHERE tenant_id=$1`,[tenant]);
  }
  await pool.query("DELETE FROM tenants WHERE id=$1",[tenant]);
});
describe("assigned non-admin page access", () => {
  for (const role of ["manager","editor","viewer"]) {
    it(`${role} can read assigned pages without disclosing other clients`, async () => {
      for (const path of ["/clients","/analytics/dashboard/summary","/analytics/dashboard/panels",
        "/analytics/traffic","/analytics/stage-distribution","/analytics/account-intelligence",
        "/intent/scope-options?includeAccounts=false","/intent/inbound/dashboard",
        "/intent/inbound/accounts","/intent/inbound/contacts","/intent/inbound/routing-rules","/intent/monitoring-configs",
        "/intent/monitoring-history","/sequences","/email-sequences","/templates","/segments","/notifications","/contact-databases","/score-thresholds"]) {
        const response = await api(role).get(`/api${path}`);
        expect(response.status, `${role} ${path}: ${JSON.stringify(response.body)}`).toBe(200);
        expect(JSON.stringify(response.body), path).not.toContain("Hidden Account");
        expect(JSON.stringify(response.body), path).not.toContain("Hidden Client");
      }
    });
    it(`${role} retains view-only, client and administrator boundaries`, async () => {
      await api(role).get(`/api/analytics/traffic?clientId=${foreign}`).expect(403);
      await api(role).get("/api/users").expect(403);
      await api(role).patch("/api/sequences/999999").send({}).expect(403);
      await api(role).post("/api/score-thresholds").send({}).expect(403);
      await api(role,{}).get("/api/analytics/dashboard").expect(403);
      await api(role,allView,[]).get("/api/analytics/dashboard").expect(403);
    });
  }
  it("counts both assigned clients rather than silently selecting the first", async () => {
    const summary = await api().get("/api/analytics/dashboard/summary").expect(200);
    expect(summary.body.totalClients).toBe(2);
    expect(summary.body.totalContacts).toBe(2);
    const dashboard = await api().get("/api/intent/inbound/dashboard").expect(200);
    expect(dashboard.body.summary.accounts).toBe(2);
    expect(dashboard.body.summary.contacts).toBe(2);
    const emailList=await api().get("/api/email-sequences").expect(200);
    expect(emailList.body.map((s:any)=>s.name).sort()).toEqual(["Visible One","Visible Two"]);
  });
  it("allows authorized client reference lists without granting Clients management", async () => {
    await api("manager",{analytics:"view"},null).get("/api/clients").expect(200);
    await api("manager",{analytics:"view"},null).post("/api/clients").send({name:"No"}).expect(403);
  });
  it("preserves legacy role reads without requiring a new explicit map", async () => {
    await api("manager",null,null).get("/api/intent/monitoring-configs").expect(200);
    await api("viewer",null,null).get("/api/intent/monitoring-history").expect(200);
  });
  it("rejects forged client and account selections in reporting",async()=>{
    const hidden=(await pool.query("SELECT id FROM companies WHERE tenant_id=$1 AND client_id=$2",[tenant,foreign])).rows[0].id;
    await api().get(`/api/analytics/traffic?companyId=${hidden}`).expect(400);
    await api().get(`/api/analytics/traffic?authorizedClients=${foreign}&clientId=${foreign}`).expect(403);
  });
  it("exposes labels only for cross-tab Analytics filter references",async()=>{
    const response=await api().get("/api/companies").expect(200);
    expect(response.body).toHaveLength(2);
    expect(Object.keys(response.body[0]).sort()).toEqual(["id","name"]);
  });
  it("allows view-only GTM/acquisition report lookups but rejects foreign IDs",async()=>{
    const records=(await pool.query("SELECT id,company_id,client_id FROM contacts WHERE tenant_id=$1 ORDER BY id",[tenant])).rows;
    const own=records.find(c=>c.client_id===first),hidden=records.find(c=>c.client_id===foreign);
    const status=await api().post("/api/analytics/gtm-status").send({contactIds:[own.id]}).expect(200);
    expect(status.body.contacts[String(own.id)].status).toBe("warm");
    await api().post("/api/analytics/acquisition").send({contactIds:[own.id],accountIds:[own.company_id]}).expect(200);
    await api().post("/api/analytics/gtm-status").send({contactIds:[hidden.id]}).expect(403);
    await api().post("/api/analytics/acquisition").send({contactIds:[],accountIds:[hidden.company_id]}).expect(403);
  });
  it("keeps an assigned client with no accounts empty instead of expanding to the tenant",async()=>{
    const calls=await api("manager",allView,[emptyClient]).get("/api/analytics/calls/top-opportunities").expect(200);
    expect(calls.body.opportunities).toEqual([]);
    const score=await api("manager",allView,[emptyClient]).get("/api/analytics/score-intelligence").expect(200);
    expect(score.body.distribution).toEqual([]);
    expect(score.body.byAccount).toEqual([]);
  });
});
