import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { pool } from "@workspace/db";
import { attachHpContact, fiscalBounds, hpLeadStatus, importHpWorkbook, normalizeRad, occurrence, previewHpImport, resolveHpAccount } from "./hpBiImport";
import { captureHpJourneyForm, linkHpJourneyIdentity } from "./hpBiLeads";
import { loadHpBi } from "./hpBiMetrics";
import express from "express";
import hpBiRouter from "../routes/hpBi";
import { readFileSync } from "node:fs";
import { groupHpAccountRows, readHpWorkbook } from "./hpBiImport";
import { claimHpWorkbookSlot } from "./hpWorkbookAsync";

function workbook(headers: string[], rows: unknown[][], styled = false) {
  const book = XLSX.utils.book_new(), sheet = XLSX.utils.aoa_to_sheet([[], headers, ...rows]);
  if (styled) sheet["!ref"] = "A1:XEY4";
  XLSX.utils.book_append_sheet(book, sheet, "Final");
  return XLSX.write(book, { type: "buffer", bookType: "xlsx" }) as Buffer;
}
describe("HP measurement contract", () => {
  it("reconciles the supplied source workbook without importing any data", () => {
    const bytes = readFileSync(new URL("../../../../attached_assets/1H25_Enduser_NAL_-_NEW_GTM_JAN25_1791205352447.xlsx", import.meta.url));
    const rows = readHpWorkbook(bytes, "accounts").rows;
    const groups = groupHpAccountRows(rows, "source reconciliation");
    expect(rows).toHaveLength(16348); expect(groups.size).toBe(9478);
    expect(new Set([...groups.values()].map(g => g.parent_key)).size).toBe(1629);
  }, 20000);
  it("requires product and uses three/six-month bands without seniority or score", () => {
    for (const months of [0, 3]) expect(hpLeadStatus("AI laptops", months)).toBe("hot");
    for (const months of [3.1, 4, 6]) expect(hpLeadStatus("AI laptops", months)).toBe("warm");
    for (const months of [null, "", undefined, -1, 6.1, 7, "unknown"]) expect(hpLeadStatus("AI laptops", months)).toBe("cold");
    for (const product of ["", "-", "None", "Not interested", null]) expect(hpLeadStatus(product, 3)).toBe("cold");
  });
  it("keeps missing RAD unknown and normalizes detailed PS/Print values", () => {
    expect(["R", "R1", "R2", "R3"].map(normalizeRad)).toEqual(Array(4).fill("Retention"));
    expect(normalizeRad("A2")).toBe("Acquisition"); expect(normalizeRad("D3")).toBe("Development");
    expect(normalizeRad("-")).toBe("Unknown");
  });
  it("uses India-time November boundaries and occurrence dates", () => {
    expect(fiscalBounds(2027)).toEqual({ start: "2026-11-01T00:00:00+05:30", end: "2027-11-01T00:00:00+05:30" });
    expect(occurrence("2026-11-01")).toBe("2026-10-31T18:30:00.000Z");
    expect(occurrence("2027-01-31T23:00:00")).toBe("2027-01-31T17:30:00.000Z");
    expect(occurrence("2027-01-31T23:00:00+05:30")).toBe("2027-01-31T17:30:00.000Z");
    expect(occurrence("2027-01-31T23:00:00Z")).toBe("2027-01-31T23:00:00.000Z");
    expect(occurrence("not a date")).toBeNull();
  });
  it("ignores styled empty columns rather than allocating the reported Excel range", () => {
    const p = previewHpImport(workbook(["UNIQUE ID", "SUBSIDIARY_LEGAL_NAME"], [["T-1", "Test Ltd"]], true), "accounts", {});
    expect(p.rows).toBe(1); expect(p.errors).toEqual([]);
  });
  it("rejects overlapping file work and releases its slot afterwards", () => {
    const release = claimHpWorkbookSlot();
    try { expect(() => claimHpWorkbookSlot()).toThrow("Another HP file"); }
    finally { release(); }
    claimHpWorkbookSlot()();
  });
  it("rejects invalid values and missing repeatable IDs but does not invent currency", () => {
    const p = previewHpImport(workbook(["hpId", "kind", "occurredAt", "orderValue"], [["T-1", "lead", "2026-11-05", 0]]), "activity", {});
    expect(p.errors.join()).toContain("recordId"); expect(p.warnings.join()).toContain("no currency");
  });
});

describe("HP isolated database reconciliation", () => {
  let tenantId: number, clientId: number, otherClientId: number, accountId: number, contactId: number;
  const roster = workbook(["UNIQUE ID", "SUBSIDIARY_LEGAL_NAME", "TOP_ID", "TOP_NAME", "FY25 GTM", "PS RAD", "PRT RAD", "EAM email-ID", "top200", "buyerCategories"],
    [["T-1", "Test One Ltd", "P-1", "Test Parent", "GCC", "R1", "A2", "manager@example.invalid", true, "IT Hardware"],
      ["T-1", "Test One Ltd", "P-1", "Test Parent", "GCC", "R1", "A2", "manager@example.invalid", true, "IT Hardware"],
      ["T-2", "Test Two Ltd", "P-1", "Test Parent", "Gov/Edu", "D3", "-", "", "", ""]]);
  const filters = () => ({ clientId, year: 2027, page: 1, pageSize: 25 });
  beforeAll(async () => {
    tenantId = (await pool.query("INSERT INTO tenants(name,slug) VALUES('HP BI isolated test',$1) RETURNING id", [`hp-bi-test-${Date.now()}`])).rows[0].id;
    clientId = (await pool.query("INSERT INTO clients(tenant_id,name) VALUES($1,'HP') RETURNING id", [tenantId])).rows[0].id;
    otherClientId = (await pool.query("INSERT INTO clients(tenant_id,name) VALUES($1,'Other test client') RETURNING id", [tenantId])).rows[0].id;
  });
  afterAll(async () => {
    if (!tenantId) return;
    for (const table of ["activity_events", "hp_bi_matches", "hp_bi_records", "hp_bi_contacts", "hp_bi_imports", "hp_account_profiles", "contacts", "companies", "clients", "intent_inbound_category_rules"])
      await pool.query(`DELETE FROM ${table} WHERE tenant_id=$1`, [tenantId]);
    await pool.query("DELETE FROM tenants WHERE id=$1", [tenantId]);
  });
  it("consolidates source IDs and parents without creating manager-email prospects", async () => {
    const result = await importHpWorkbook(tenantId, clientId, roster, "fixture.xlsx", "accounts", {}, null);
    expect(result).toMatchObject({ rows: 3, imported: 2, created: 2, linkedContacts: 0 });
    expect((await pool.query("SELECT count(*) n FROM contacts WHERE tenant_id=$1", [tenantId])).rows[0].n).toBe("0");
    const d = await loadHpBi(tenantId, filters()) as any;
    expect(d.summary).toMatchObject({ accounts: 2, parentAccounts: 1, newAccounts: 0, contacts: 0, leads: 0, hot: 0, warm: 0 });
    expect(d.accounts[0].salesPeople).toEqual([{ role: "EAM", email: "manager@example.invalid",
      accounts: [expect.objectContaining({ name: "Test One Ltd", hpId: "T-1" })] }]);
    expect(d.segments.map((s: any) => s.name).sort()).toEqual(["GCC", "Gov/Edu"]);
    const p = (await pool.query("SELECT * FROM hp_account_profiles WHERE tenant_id=$1 AND hp_id='T-1'", [tenantId])).rows[0];
    expect(p.variants).toHaveLength(2); expect(p.buyer_categories).toEqual(["IT Hardware"]); expect(p.top_200).toBe(true);
    accountId = p.company_id;
    expect(d.accounts[0]).toMatchObject({lastMonitoredAt:null,monitoringCheckedMembers:0,monitoringTotalMembers:2});
    await pool.query("UPDATE companies SET last_researched_at='2026-10-27T20:30:00Z' WHERE tenant_id=$1 AND id=$2",[tenantId,accountId]);
    const monitored = await loadHpBi(tenantId,filters()) as any;
    expect(monitored.accounts[0]).toMatchObject({
      lastMonitoredAt:"2026-10-27T20:30:00.000Z",monitoringCheckedMembers:1,monitoringTotalMembers:2,
    });
    await pool.query("UPDATE companies SET last_researched_at=NULL WHERE tenant_id=$1 AND id=$2",[tenantId,accountId]);
  });
  it("reimports stable IDs without duplicate accounts and preserves optional supplied facts", async () => {
    const r = await importHpWorkbook(tenantId, clientId, roster, "fixture.xlsx", "accounts", {}, null);
    expect(r.created).toBe(0);
    await importHpWorkbook(tenantId, clientId, workbook(["UNIQUE ID", "SUBSIDIARY_LEGAL_NAME"], [["T-1", "Test One Ltd"]]), "context-correction.xlsx", "accounts", {}, null);
    const p = (await pool.query("SELECT * FROM hp_account_profiles WHERE tenant_id=$1 AND hp_id='T-1'", [tenantId])).rows[0];
    expect(p.buyer_categories).toEqual(["IT Hardware"]); expect(p.top_200).toBe(true); expect(p.edits.length).toBeGreaterThan(0);
  });
  it("never moves a contact already owned by another client and will not override an unknown stable ID by name", async () => {
    const foreign = (await pool.query("INSERT INTO contacts(tenant_id,client_id,email) VALUES($1,$2,'foreign@example.invalid') RETURNING id", [tenantId, otherClientId])).rows[0].id;
    expect(await attachHpContact(pool, tenantId, clientId, accountId, foreign, "test", false)).toBe(false);
    expect((await resolveHpAccount(pool, tenantId, clientId, "unknown", "Test One Ltd")).id).toBeNull();
    expect((await resolveHpAccount(pool, tenantId + 10000, clientId, "T-1", "Test One Ltd")).id).toBeNull();
    const otherAccount = (await pool.query("SELECT company_id FROM hp_account_profiles WHERE tenant_id=$1 AND hp_id='T-2'", [tenantId])).rows[0].company_id;
    await pool.query(`INSERT INTO hp_bi_matches(tenant_id,client_id,source_key,reason,payload,resolved_account_id)
      VALUES($1,$2,'test-reviewed-collision','old alias review',$3::jsonb,$4)`,
    [tenantId, clientId, JSON.stringify({ hpId: "T-1" }), otherAccount]);
    expect((await resolveHpAccount(pool, tenantId, clientId, "T-1", "Test One Ltd")).id).toBe(accountId);
  });
  it("adds genuine identified journeys without classifying them as leads; anonymous identities stay unattributed", async () => {
    contactId = (await pool.query("INSERT INTO contacts(tenant_id,client_id,company_name,email) VALUES($1,$2,'New Identified Ltd','new@example.invalid') RETURNING id", [tenantId, clientId])).rows[0].id;
    await linkHpJourneyIdentity(tenantId, clientId, contactId);
    const c = (await pool.query("SELECT company_id FROM contacts WHERE id=$1", [contactId])).rows[0];
    expect(c.company_id).toBeTruthy();
    const d = await loadHpBi(tenantId, filters()) as any;
    expect(d.summary).toMatchObject({ accounts: 3, newAccounts: 1, leads: 0 });
    const anonymous = (await pool.query("INSERT INTO contacts(tenant_id,client_id,is_anonymous,company_name) VALUES($1,$2,true,'Anonymous Ltd') RETURNING id", [tenantId, clientId])).rows[0].id;
    await linkHpJourneyIdentity(tenantId, clientId, anonymous);
    expect((await pool.query("SELECT company_id FROM contacts WHERE id=$1", [anonymous])).rows[0].company_id).toBeNull();
  });
  it("counts actual inquiries but not generic feedback; ToV remains prospective", async () => {
    const base = { tenantId, clientId, contactId, newContact: false, fields: [], occurredAt: new Date("2026-11-15T08:00:00Z") };
    await captureHpJourneyForm({ ...base, submissionId: 901, data: { companyName: "New Identified Ltd", feedback: "Good session" } });
    await captureHpJourneyForm({ ...base, submissionId: 902, data: { companyName: "New Identified Ltd", product: "AI laptops", horizonMonths: 6, orderValue: 100, currency: "INR" } });
    await captureHpJourneyForm({ ...base, submissionId: 903, configuredLead: true, data: { companyName: "New Identified Ltd" } });
    const d = await loadHpBi(tenantId, filters()) as any;
    expect(d.summary).toMatchObject({ leads: 2, hot: 0, warm: 1, opportunities: 0, prospectiveValues: { INR: 100 }, values: {}, bookedValues: {} });
  });
  it("keeps currencies separate, honors quarter boundaries, deduplicates reimports and retains corrections", async () => {
    const headers = ["recordId", "hpId", "kind", "occurredAt", "orderValue", "currency", "sourceName"];
    const records = workbook(headers, [
      ["O-1", "T-1", "opportunity", "2027-01-31T18:29:59Z", 200, "INR", "CRM"],
      ["O-2", "T-1", "opportunity", "2027-01-31T18:30:00Z", 5, "USD", "CRM"],
      ["W-1", "T-1", "closed_won", "2027-04-15", 150, "INR", "CRM"],
      ["N-1", "T-1", "opportunity", "2027-05-15", 99, "", "CRM"],
    ]);
    await importHpWorkbook(tenantId, clientId, records, "outcomes.xlsx", "activity", {}, null);
    await importHpWorkbook(tenantId, clientId, records, "outcomes.xlsx", "activity", {}, null);
    let d = await loadHpBi(tenantId, filters()) as any;
    expect(d.summary).toMatchObject({ opportunities: 3, values: { INR: 200, USD: 5 }, bookedValues: { INR: 150 } });
    expect(d.quarters.map((q: any) => q.opportunities)).toEqual([1, 1, 1, 0]);
    const evidence = await loadHpBi(tenantId, { ...filters(), quarter: 2, kind: "opportunity" }, "evidence") as any;
    expect(evidence.total).toBe(1); expect(evidence.records[0].currency).toBe("USD");
    await importHpWorkbook(tenantId, clientId, workbook(headers, [["O-1", "T-1", "opportunity", "2027-01-31T18:29:59Z", 250, "INR", "CRM"]]), "correction.xlsx", "activity", {}, null);
    d = await loadHpBi(tenantId, filters()) as any;
    expect(d.summary.values.INR).toBe(250);
    expect((await pool.query("SELECT history FROM hp_bi_records WHERE tenant_id=$1 AND source_key='excel:CRM:O-1'", [tenantId])).rows[0].history).toHaveLength(1);
  });
  it("holds unknown categories for review rather than assigning them silently", async () => {
    const r = await importHpWorkbook(tenantId, clientId, workbook(["recordId", "hpId", "kind", "occurredAt", "category"], [["X", "T-1", "interest", "2026-12-01", "Unmapped bucket"]]), "unknown.xlsx", "activity", {}, null);
    expect(r).toMatchObject({ imported: 0, unresolved: 1 });
  });
  it("deduplicates stable references across imported and attributed first-party interactions", async () => {
    const c = (await pool.query("SELECT company_id FROM contacts WHERE id=$1", [contactId])).rows[0].company_id;
    const e = (await pool.query(`INSERT INTO activity_events(tenant_id,contact_id,client_id,event_type,description,source,created_at)
      VALUES($1,$2,$3,'cta_click','HP test','journey','2026-12-10T08:00:00Z') RETURNING id`, [tenantId, contactId, clientId])).rows[0].id;
    const p = (await pool.query("SELECT hp_id FROM hp_account_profiles WHERE company_id=$1", [c])).rows[0].hp_id;
    // This newly identified account lacks a stable HP ID; match by exact owned name.
    const data = workbook(["recordId", "accountName", "kind", "occurredAt", "externalEventId"],
      [["mirror", "New Identified Ltd", "digital", "2026-12-10T08:00:00Z", `activity_event:${e}`]]);
    expect(p).toBeNull();
    await importHpWorkbook(tenantId, clientId, data, "mirror.xlsx", "activity", {}, null);
    const d = await loadHpBi(tenantId, filters()) as any;
    expect(d.summary.touchpoints).toBe(1);
    const rows = await loadHpBi(tenantId, { ...filters(), kind: "touchpoint" }, "evidence") as any;
    expect(rows.total).toBe(1);
  });
  it("counts forms, journey, email, calls and sales feedback once while preserving fiscal dates",async()=>{
    const scope={...filters(),segment:"GCC"};
    const before=await loadHpBi(tenantId,scope) as any;
    const owned=(await pool.query("SELECT company_id FROM hp_account_profiles WHERE tenant_id=$1 AND hp_id='T-1'",[tenantId])).rows[0].company_id;
    const person=Number((await pool.query(`INSERT INTO contacts(tenant_id,client_id,company_id,first_name,email)
      VALUES($1,$2,$3,'Touchpoint fixture','touchpoint@example.invalid') RETURNING id`,[tenantId,clientId,owned])).rows[0].id);
    const journey=Number((await pool.query(`INSERT INTO journeys(tenant_id,client_id,name,slug)
      VALUES($1,$2,'Touchpoint test',$3) RETURNING id`,[tenantId,clientId,`touchpoint-test-${tenantId}`])).rows[0].id);
    const form=Number((await pool.query(`INSERT INTO journey_forms(tenant_id,name,config)
      VALUES($1,'Generic feedback','{}') RETURNING id`,[tenantId])).rows[0].id);
    try{
      await pool.query(`INSERT INTO form_submissions(tenant_id,form_id,contact_id,journey_id,field_values,action_type,submitted_at)
        VALUES($1,$2,$3,$4,'{"feedback":"Useful session"}','just_submit','2026-12-10T08:00:01Z')`,[tenantId,form,person,journey]);
      await pool.query(`INSERT INTO activity_events(tenant_id,contact_id,client_id,journey_id,event_type,source,created_at,description,is_bot)
        VALUES($1,$2,$3,$4,'form_submitted',$5,'2026-12-10T08:00:00Z','Touchpoint fixture',false),
        ($1,$2,$3,$4,'page_view','journey','2026-12-11T08:00:00Z','Touchpoint fixture',false),
        ($1,$2,$3,$4,'email_open','email','2026-12-12T08:00:00Z','Touchpoint fixture',false),
        ($1,$2,$3,$4,'email_click','email','2026-12-13T08:00:00Z','Touchpoint fixture',false),
        ($1,$2,$3,$4,'call_completed','call','2026-12-14T08:00:00Z','Touchpoint fixture',false),
        ($1,$2,$3,$4,'email_open','email','2026-12-14T09:00:00Z','Touchpoint fixture',true)`,
      [tenantId,person,clientId,journey,`form:${form}`]);
      await pool.query(`INSERT INTO sales_feedback(tenant_id,client_id,account_id,contact_id,type,occurred_at,rep_name,feedback,record_key,content_hash)
        VALUES($1,$2,$3,$4,'telesales','2026-12-15T08:00:00Z','Test rep','Old revision','touchpoint-call','one'),
        ($1,$2,$3,$4,'telesales','2026-12-15T08:00:00Z','Test rep','Contact completed','touchpoint-call','two'),
        ($1,$2,$3,$4,'sales_rep','2026-12-16T08:00:00Z','Test rep','Meeting held','touchpoint-sales','one'),
        ($1,$2,$3,$4,'sales_rep',NULL,'Test rep','Undated meeting','touchpoint-undated','one')`,
      [tenantId,clientId,owned,person]);
      await pool.query(`INSERT INTO hp_bi_records(tenant_id,client_id,account_id,contact_id,source_key,kind,occurred_at,source)
        VALUES($1,$2,$3,$4,'touchpoint-earlier','other','2026-09-23T08:00:00Z','recorded interaction')`,
      [tenantId,clientId,owned,person]);
      const after=await loadHpBi(tenantId,scope) as any;
      expect(after.summary.touchpoints-before.summary.touchpoints).toBe(7);
      expect(after.summary.touchpointsAllDates-before.summary.touchpointsAllDates).toBe(9);
      expect(after.summary.leads).toBe(before.summary.leads);
      const evidence=await loadHpBi(tenantId,{...scope,kind:"touchpoint",pageSize:1000},"evidence") as any;
      const interactions=evidence.records.filter((record:any)=>record.contactId===person);
      expect(interactions).toHaveLength(7);
      expect(interactions.map((record:any)=>record.status)).toEqual(expect.arrayContaining([
        "form_submitted","page_view","email_open","email_click","call_completed","telesales_contact","sales_rep_contact",
      ]));
      expect(interactions.every((record:any)=>record.occurredAt>="2026-11-01")).toBe(true);
    }finally{
      for(const table of ["sales_feedback","activity_events","form_submissions","hp_bi_records"])
        await pool.query(`DELETE FROM ${table} WHERE tenant_id=$1 AND contact_id=$2`,[tenantId,person]);
      await pool.query("DELETE FROM journey_forms WHERE tenant_id=$1 AND id=$2",[tenantId,form]);
      await pool.query("DELETE FROM journeys WHERE tenant_id=$1 AND id=$2",[tenantId,journey]);
      await pool.query("DELETE FROM contacts WHERE tenant_id=$1 AND id=$2",[tenantId,person]);
    }
  });
  it("protects every HP route, rejects non-admin writes, foreign scopes and invalid filters", async () => {
    const app = express(); app.use(express.json());
    app.use((req: any, _res, next) => {
      req.isAuthenticated = () => Boolean(req.headers["x-test-role"]);
      req.log = { warn() {} };
      req.user = { tenantId, role: req.headers["x-test-role"], id: null }; next();
    });
    app.use(hpBiRouter);
    const server = app.listen(0), address = server.address() as { port: number };
    const url = `http://127.0.0.1:${address.port}/analytics/hp-bi`;
    try {
      expect((await fetch(`${url}?clientId=${clientId}`)).status).toBe(401);
      expect((await fetch(`${url}/import/preview?clientId=${clientId}`, { method: "POST", headers: { "x-test-role": "user" } })).status).toBe(403);
      expect((await fetch(`${url}?clientId=${otherClientId}`, { headers: { "x-test-role": "admin" } })).status).toBe(404);
      expect((await fetch(`${url}?clientId=${clientId}&year=3000`, { headers: { "x-test-role": "admin" } })).status).toBe(400);
      const response = await fetch(`${url}?clientId=${clientId}`, { headers: { "x-test-role": "admin" } });
      expect(response.status).toBe(200);
      expect(((await response.json()) as any).summary.accounts).toBe(3);
      const headers = { "x-test-role": "admin" };
      const bytes = workbook(["Custom ID", "Custom company", "STATE/UT"],
        [["T-HTTP", "HTTP Imported Ltd", "Test state"]]);
      const multipart = (confirm = true) => {
        const form = new FormData();
        form.set("file", new Blob([new Uint8Array(bytes)]), "http-fixture.xlsx");
        form.set("kind", "accounts");
        form.set("mappings", JSON.stringify({ "Custom ID": "hp_id", "Custom company": "legal_name" }));
        if (confirm) form.set("confirmAccounts", "true");
        return form;
      };
      const preview = await fetch(`${url}/import/preview?clientId=${clientId}`, { method: "POST", headers, body: multipart() });
      expect(preview.status).toBe(200);
      expect(await preview.json()).toMatchObject({ rows: 1, errors: [], impact: { newAccounts: 1, existingMatches: 0, conflicts: 0 } });
      const unapproved = await fetch(`${url}/import?clientId=${clientId}`, { method: "POST", headers, body: multipart(false) });
      expect(unapproved.status).toBe(422);
      const imported = await fetch(`${url}/import?clientId=${clientId}`, { method: "POST", headers, body: multipart() });
      expect(imported.status).toBe(200);
      expect(await imported.json()).toMatchObject({ created: 1, imported: 1 });
      const repeated = await fetch(`${url}/import?clientId=${clientId}`, { method: "POST", headers, body: multipart() });
      expect(repeated.status).toBe(200);
      expect(await repeated.json()).toMatchObject({ created: 0 });
      const importedProfile = (await pool.query("SELECT company_id FROM hp_account_profiles WHERE tenant_id=$1 AND hp_id='T-HTTP'", [tenantId])).rows[0];
      const jsonHeaders = { ...headers, "Content-Type": "application/json" };
      const edited = await fetch(`${url}/profiles/${importedProfile.company_id}?clientId=${clientId}`, {
        method: "PATCH", headers: jsonHeaders,
        body: JSON.stringify({ top200: true, profiled: true, buyingBehavior: "Supplied fixture evidence",
          buyerCategories: ["IT Hardware"], whitespaceCategories: ["Software & Security"], dimensions: { zone: "Fixture zone" } }),
      });
      expect(edited.status).toBe(200);
      const register = await fetch(`${url}/account-register?clientId=${clientId}&search=T-HTTP`, { headers });
      expect(register.status).toBe(200);
      const registerData = await register.json() as { items: { companyId: number }[] };
      expect(registerData).toMatchObject({ total: 1, page: 1, pageSize: 25,
        items: [{ companyId: Number(importedProfile.company_id), hpId: "T-HTTP", top200: true }] });
      expect(new Set(registerData.items.map(r => r.companyId)).size).toBe(registerData.items.length);
      const isolatedRegister = await fetch(`${url}/account-register?clientId=${otherClientId}`, { headers });
      expect(isolatedRegister.status).toBe(404);
      const filtered = await fetch(`${url}?clientId=${clientId}&year=2027&dimension=state_ut&dimensionValue=Test%20state&abmOnly=true`, { headers });
      expect(filtered.status).toBe(200);
      expect(((await filtered.json()) as any).summary.accounts).toBe(1);
      const opportunity = { accountId: importedProfile.company_id, kind: "opportunity", occurredAt: "2026-12-12", product: "AI laptops", orderValue: 123, currency: "INR" };
      const saved = await fetch(`${url}/records?clientId=${clientId}`, { method: "POST", headers: jsonHeaders, body: JSON.stringify(opportunity) });
      expect(saved.status).toBe(201);
      expect((await pool.query("SELECT order_value,currency FROM hp_bi_records WHERE tenant_id=$1 AND account_id=$2 AND source='manual'",
        [tenantId, importedProfile.company_id])).rows[0]).toMatchObject({ order_value: "123", currency: "INR" });
      const history = await fetch(`${url}/imports?clientId=${clientId}`, { headers });
      expect(history.status).toBe(200);
      expect((await history.json() as any[]).filter(i => i.fileName === "http-fixture.xlsx")).toHaveLength(2);
      const aggregate = await fetch(`${url}?clientId=${clientId}&year=2027`, { headers });
      expect((await aggregate.json() as any).quality.baselineRows).toBe(3);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });
  it("keeps formatted Excel wall-clock dates in their correct HP quarter and fiscal year", async () => {
    const before = await loadHpBi(tenantId, filters()) as any;
    const beforeNext = await loadHpBi(tenantId, { ...filters(), year: 2028 }) as any;
    const dates = [new Date("2027-01-31T23:00:00Z"), new Date("2027-02-01T00:00:00Z"),
      new Date("2027-10-31T23:00:00Z"), new Date("2027-11-01T00:00:00Z")];
    // XLSX stores the dates as timezone-less serial cells with a date format.
    const book = XLSX.utils.book_new();
    const sheet = XLSX.utils.aoa_to_sheet([["recordId", "hpId", "kind", "occurredAt", "sourceName"],
      ...dates.map((date, i) => [`DATE-${i}`, "T-1", "opportunity", date, "Excel date boundaries"])]);
    for (let i = 2; i <= 5; i++) sheet[`D${i}`].z = "yyyy-mm-dd hh:mm:ss";
    XLSX.utils.book_append_sheet(book, sheet, "Dates");
    const bytes = XLSX.write(book, { type: "buffer", bookType: "xlsx" }) as Buffer;
    await importHpWorkbook(tenantId, clientId, bytes, "formatted-dates.xlsx", "activity", {}, null);
    const timestamps = (await pool.query("SELECT source_key,occurred_at FROM hp_bi_records WHERE tenant_id=$1 AND source_name=$2 ORDER BY source_key",
      [tenantId, "Excel date boundaries"])).rows;
    expect(timestamps.map(r => r.occurred_at.toISOString())).toEqual([
      "2027-01-31T17:30:00.000Z", "2027-01-31T18:30:00.000Z",
      "2027-10-31T17:30:00.000Z", "2027-10-31T18:30:00.000Z",
    ]);
    const after = await loadHpBi(tenantId, filters()) as any;
    expect(after.quarters.map((q: any, i: number) => q.opportunities - before.quarters[i].opportunities)).toEqual([1, 1, 0, 1]);
    expect(after.summary.opportunities - before.summary.opportunities).toBe(3);
    const next = await loadHpBi(tenantId, { ...filters(), year: 2028 }) as any;
    expect(next.summary.opportunities - beforeNext.summary.opportunities).toBe(1);
    expect(next.quarters[0].opportunities - beforeNext.quarters[0].opportunities).toBe(1);
  });
  it("adopts an HP-ID-less CRM profile and preserves contacts and edited context across reimports", async () => {
    const owned = Number((await pool.query("INSERT INTO companies(tenant_id,client_id,name) VALUES($1,$2,'Existing Owned Legal Ltd') RETURNING id", [tenantId, clientId])).rows[0].id);
    await pool.query(`INSERT INTO hp_account_profiles(tenant_id,client_id,company_id,parent_key,parent_name,aliases,
      buying_behavior,dimensions,edits,provenance) VALUES($1,$2,$3,$4,'Existing Owned Legal Ltd',ARRAY['Existing Owned Legal Ltd'],
      'Keep this reviewed context','{}'::jsonb,$5::jsonb,'existing CRM baseline')`,
    [tenantId, clientId, owned, `company:${owned}`, JSON.stringify([{ values: { buyingBehavior: "Keep this reviewed context" } }])]);
    const person = Number((await pool.query(`INSERT INTO contacts(tenant_id,client_id,company_id,first_name,email,intent_score)
      VALUES($1,$2,$3,'Existing','roster-preservation@example.invalid',44) RETURNING id`, [tenantId, clientId, owned])).rows[0].id);
    const source = workbook(["UNIQUE ID", "SUBSIDIARY_LEGAL_NAME", "TOP_ID", "TOP_NAME", "buyingBehavior"],
      [["PRESERVE-1", "Existing Owned Legal Ltd", "OWNED-P", "Owned parent", "New source context"]]);
    const first = await importHpWorkbook(tenantId, clientId, source, "identity-preservation.xlsx", "accounts", {}, null);
    const second = await importHpWorkbook(tenantId, clientId, source, "identity-preservation.xlsx", "accounts", {}, null);
    expect(first.created).toBe(0); expect(second.created).toBe(0);
    const p = (await pool.query("SELECT company_id,buying_behavior FROM hp_account_profiles WHERE tenant_id=$1 AND hp_id='PRESERVE-1'", [tenantId])).rows[0];
    expect(Number(p.company_id)).toBe(owned); expect(p.buying_behavior).toBe("Keep this reviewed context");
    const c = (await pool.query("SELECT company_id,intent_score FROM contacts WHERE tenant_id=$1 AND id=$2", [tenantId, person])).rows[0];
    expect(Number(c.company_id)).toBe(owned); expect(Number(c.intent_score)).toBe(44);
  });
  it("reconciles interest-only Other totals with the same source evidence", async () => {
    await importHpWorkbook(tenantId, clientId, workbook(["recordId", "hpId", "kind", "occurredAt", "product", "sourceName"],
      [["OTHER-INTEREST", "T-1", "interest", "2027-08-15", "Fixture interest", "Other evidence"]]), "interest.xlsx", "activity", {}, null);
    const d = await loadHpBi(tenantId, filters()) as any;
    const evidence = await loadHpBi(tenantId, { ...filters(), quarter: 4, kind: "other" }, "evidence") as any;
    expect(d.quarters[3].other).toBe(1);
    expect(evidence.total).toBe(d.quarters[3].other);
    expect(evidence.records[0]).toMatchObject({ kind: "interest", product: "Fixture interest" });
  });
  it("keeps other requests responsive through the original full-roster preview and import", async () => {
    const bytes = readFileSync(new URL("../../../../attached_assets/1H25_Enduser_NAL_-_NEW_GTM_JAN25_1791205352447.xlsx", import.meta.url));
    const app = express();
    app.use((req: any, _res, next) => {
      req.isAuthenticated = () => true; req.user = { tenantId, role: "admin", id: null };
      req.log = { warn() {} }; next();
    });
    app.get("/probe", (_req, res) => res.json({ alive: true }));
    app.use(hpBiRouter);
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>(resolve => server.once("listening", resolve));
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const url = `${origin}/analytics/hp-bi/import`;
    const durations: number[] = [], gaps: number[] = [];
    let finished = false, last = performance.now();
    const timer = setInterval(() => { const now = performance.now(); gaps.push(now - last); last = now; }, 50);
    const probe = (async () => {
      while (!finished) {
        const started = performance.now();
        expect((await fetch(`${origin}/probe`)).status).toBe(200);
        durations.push(performance.now() - started);
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    })();
    const body = (small = false) => {
      const form = new FormData();
      form.set("file", new Blob([new Uint8Array(small ? workbook(["UNIQUE ID", "SUBSIDIARY_LEGAL_NAME"], [["SMALL", "Small Test Ltd"]]) : bytes)]), "original-roster.xlsx");
      form.set("kind", "accounts"); form.set("confirmAccounts", "true"); return form;
    };
    try {
      const started = performance.now();
      const pending = fetch(`${url}/preview?clientId=${clientId}`, { method: "POST", body: body() });
      await new Promise(resolve => setTimeout(resolve, 250));
      const concurrent = await fetch(`${url}/preview?clientId=${clientId}`, { method: "POST", body: body(true) });
      expect(concurrent.status).toBe(429);
      const previewResponse = await pending;
      expect(previewResponse.status).toBe(200);
      expect(await previewResponse.json()).toMatchObject({ rows: 16348, uniqueAccounts: 9478,
        impact: { legalAccounts: 9478, sourceParentGroups: 1629, conflicts: 0 } });
      const previewMs = performance.now() - started;
      const importStarted = performance.now();
      const committed = await fetch(`${url}?clientId=${clientId}`, { method: "POST", body: body() });
      expect(committed.status).toBe(200);
      expect(await committed.json()).toMatchObject({ rows: 16348, imported: 9478, created: 9478, linkedContacts: 0 });
      const importMs = performance.now() - importStarted;
      const reportStarted = performance.now();
      const timings: { ms: number; sql: string }[] = [];
      const originalQuery = pool.query;
      let dashboard: any;
      (pool as any).query = async (...args: any[]) => {
        const start = performance.now();
        try { return await (originalQuery as any).apply(pool, args); }
        finally { timings.push({ ms: Math.round(performance.now() - start), sql: String(args[0]?.text ?? args[0]).replace(/\s+/g, " ").slice(0, 180) }); }
      };
      try { dashboard = await loadHpBi(tenantId, filters()); }
      finally { pool.query = originalQuery; }
      const reportMs = performance.now() - reportStarted;
      console.info("HP full-roster responsiveness", { previewMs: Math.round(previewMs), importMs: Math.round(importMs),
        reportMs: Math.round(reportMs), slowestProbeMs: Math.round(Math.max(...durations)), maxEventLoopGapMs: Math.round(Math.max(...gaps)),
        queries: timings.sort((a, b) => b.ms - a.ms).slice(0, 3) });
      expect(dashboard.summary.accounts).toBeGreaterThanOrEqual(9478);
      expect(dashboard.accounts.length).toBeLessThanOrEqual(25);
      expect(JSON.stringify(dashboard).length).toBeLessThan(300_000);
      expect((await pool.query("SELECT count(*)::int n FROM hp_account_profiles WHERE tenant_id=$1 AND client_id=$2 AND hp_id NOT LIKE 'T-%' AND hp_id<>'PRESERVE-1'", [tenantId, clientId])).rows[0].n).toBe(9478);
      expect(previewMs).toBeLessThan(20_000); expect(importMs).toBeLessThan(35_000); expect(reportMs).toBeLessThan(10_000);
      // Catch a main-thread parse or oversized profile JSON returning to the report.
      expect(Math.max(...gaps)).toBeLessThan(1500);
      expect(Math.max(...durations)).toBeLessThan(1500);
    } finally {
      finished = true; clearInterval(timer); await probe;
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  }, 70_000);
});
