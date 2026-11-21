import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import { pool } from "@workspace/db";
import { hpWorkbook as workbook, seedHpCrmAccounts, cleanHpCrmTenant } from "./testFixtures/hpCrm";
import dealsRouter from "../routes/deals";
import hpRouter from "../routes/hpBi";
import { importHpWorkbook } from "./hpBiImport";
import { loadHpBi } from "./hpBiMetrics";
import { deleteContactAndHistory } from "./deleteCrmEntity";

describe("CRM facts and live HP reconciliation (isolated tenant)", () => {
  let tenantId: number, otherTenant: number, clientId: number, otherClient: number, companyId: number, siblingId: number,
    otherCompany: number, foreignCompany: number, contactId: number, siblingContact: number, dealId: number;
  let server: ReturnType<express.Application["listen"]>, url: string;
  const headers = { "Content-Type": "application/json", "x-test-auth": "yes" };
  const filters = () => ({ clientId, year: 2027, page: 1, pageSize: 25 });
  const request = (path: string, method = "GET", body?: unknown, tenant = tenantId) =>
    fetch(`${url}${path}`, { method, headers: { ...headers, "x-test-tenant": String(tenant) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const crm = (extra: Record<string, unknown> = {}) => ({ clientId, companyId, contactId, title: "Explicit fixture deal",
    stage: "proposal", priority: "medium", value: 100, currency: "inr", valueMeaning: "total_order_value",
    opportunityConfirmed: true, actualOpportunityDate: "2027-01-31", ...extra });
  const dashboard = async (extra = {}) => loadHpBi(tenantId, { ...filters(), ...extra }) as Promise<any>;
  beforeAll(async () => {
    tenantId = (await pool.query("INSERT INTO tenants(name,slug) VALUES('CRM HP fixture',$1) RETURNING id", [`hp-crm-${Date.now()}`])).rows[0].id;
    otherTenant = (await pool.query("INSERT INTO tenants(name,slug) VALUES('Foreign CRM fixture',$1) RETURNING id", [`hp-crm-foreign-${Date.now()}`])).rows[0].id;
    clientId = (await pool.query("INSERT INTO clients(tenant_id,name) VALUES($1,'HP') RETURNING id", [tenantId])).rows[0].id;
    otherClient = (await pool.query("INSERT INTO clients(tenant_id,name) VALUES($1,'Other') RETURNING id", [tenantId])).rows[0].id;
    ({ companyId, siblingId, contactId, siblingContact } = await seedHpCrmAccounts(tenantId, clientId));
    otherCompany = (await pool.query("INSERT INTO companies(tenant_id,client_id,name) VALUES($1,$2,'Other client company') RETURNING id", [tenantId, otherClient])).rows[0].id;
    foreignCompany = (await pool.query("INSERT INTO companies(tenant_id,client_id,name) VALUES($1,$2,'Foreign tenant company') RETURNING id", [otherTenant, otherClient])).rows[0].id;
    const app = express(); app.use(express.json());
    app.use((req: any, _res, next) => {
      req.isAuthenticated = () => !!req.headers["x-test-auth"];
      req.user = { tenantId: Number(req.headers["x-test-tenant"]), id: null, role: "admin" };
      req.log = { warn() {} }; next();
    });
    app.use(dealsRouter); app.use(hpRouter);
    app.use((err: any, _req: any, res: any, _next: any) => res.status(500).json({ error: err.message }));
    server = app.listen(0); url = `http://127.0.0.1:${(server.address() as any).port}`;
  });
  afterAll(async () => {
    if (server) await new Promise<void>(resolve => server.close(() => resolve()));
    for (const tid of [tenantId, otherTenant]) {
      if (!tid) continue;
      await cleanHpCrmTenant(tid);
    }
  });
  it("requires auth and rejects cross-tenant/client accounts and mismatched contacts", async () => {
    expect((await fetch(`${url}/deals`)).status).toBe(401);
    for (const patch of [{ companyId: otherCompany }, { companyId: foreignCompany }, { contactId: siblingContact },
      { clientId: otherClient }, { companyId: null, contactId }]) {
      expect((await request("/deals", "POST", crm(patch))).status).toBe(422);
    }
    expect((await request(`/deals/link-options?clientId=${clientId}`, "GET", undefined, otherTenant)).status).toBe(404);
  });
  it("rejects malformed actual dates, amounts, and invented currencies", async () => {
    for (const patch of [{ actualOpportunityDate: "2027-02-30" }, { actualOpportunityDate: "2027-01-31T12:00:00Z" },
      { value: -1 }, { value: 0.001 }, { currency: "ABC" }, { actualOutcomeDate: "2027-02-01" },
      { bookedValue: 12 }, { opportunityConfirmed: true, actualOpportunityDate: null }, { stage: "qualified" }]) {
      const response = await request("/deals", "POST", crm(patch));
      expect([400, 422], JSON.stringify(patch)).toContain(response.status);
    }
  });
  it("creates and edits an incomplete legacy deal without any guessed backfill", async () => {
    const r = await request("/deals", "POST", { clientId, title: "Legacy incomplete", value: 789, stage: "qualified", priority: "low",
      expectedCloseDate: "2027-02-04T00:00:00Z" });
    expect(r.status).toBe(201);
    const d: any = await r.json();
    expect(d).toMatchObject({ currency: null, valueMeaning: "unknown", actualOpportunityDate: null, actualOutcomeDate: null, opportunityConfirmed: false });
    expect((await request(`/deals/${d.id}`, "PATCH", { title: "Corrected legacy", notes: "No new facts" })).status).toBe(200);
    const bi = await dashboard();
    expect(bi.summary.opportunities).toBe(0); expect(bi.summary.bookedValues).toEqual({});
    expect(bi.quality.crmDeals.issues.find((i: any) => i.dealId === d.id).reasons.join(" ")).toMatch(/Missing canonical account/);
    expect((await request(`/deals/${d.id}/history`)).status).toBe(200);
  });
  it("counts explicitly confirmed opportunities by actual date, not expected/created date", async () => {
    const response = await request("/deals", "POST", crm({ expectedCloseDate: "2027-11-01T00:00:00Z" }));
    expect(response.status).toBe(201);
    const d: any = await response.json(); dealId = d.id;
    expect(d).toMatchObject({ value: 100, currency: "INR", actualOpportunityDate: "2027-01-31" });
    const b = await dashboard();
    expect(b.summary).toMatchObject({ opportunities: 1, values: { INR: 100 }, leads: 0, hot: 0, closedWon: 0, bookedValues: {} });
    expect(b.months[2].opportunities).toBe(1); expect(b.quarters[0].values).toEqual({ INR: 100 });
    expect(b.accounts[0].values).toEqual({ INR: 100 });
    expect((await dashboard({ year: 2028 })).summary.opportunities).toBe(0);
    const evidence: any = await loadHpBi(tenantId, { ...filters(), month: 3, kind: "opportunity" }, "evidence");
    expect(evidence.records).toHaveLength(1);
    expect(evidence.records[0]).toMatchObject({ id: `crm:deal:${dealId}:opportunity`, accountId: companyId, source: "crm", exclusionReasons: [] });
    const detail: any = await loadHpBi(tenantId, { ...filters(), parentKey: b.accounts[0].parentKey }, true);
    expect(detail.account.opportunities).toBe(1); expect(detail.records[0].lineage.dealId).toBe(dealId);
  });
  it("keeps zero money valid, separates currencies, and excludes unconfirmed meaning/missing currency from money only", async () => {
    for (const patch of [{ title: "Zero USD", value: 0, currency: "USD", companyId: siblingId, contactId: siblingContact },
      { title: "Unknown meaning", value: 555, valueMeaning: "unknown" }, { title: "Missing currency", value: 666, currency: null }]) {
      expect((await request("/deals", "POST", crm(patch))).status).toBe(201);
    }
    const b = await dashboard();
    expect(b.summary.opportunities).toBe(4); expect(b.summary.values).toEqual({ INR: 100, USD: 0 });
    expect(b.quality.crmDeals.issues.some((i: any) => i.reasons.join().includes("value meaning"))).toBe(true);
    expect(b.quality.crmDeals.issues.some((i: any) => i.reasons.join().includes("currency"))).toBe(true);
    expect((await dashboard({ segment: "GCC" })).summary.values).toEqual({ INR: 100 });
    const exported = await request(`/analytics/hp-bi/export?clientId=${clientId}&year=2027`);
    expect(exported.status).toBe(200); const csv = await exported.text();
    expect(csv).toContain('"closedWon"'); expect(csv).toContain('"bookedValues"');
    expect(csv).toContain('""INR"":100'); expect(csv).toContain('""USD"":0');
    expect(csv).toContain(`crm:deal:${dealId}:opportunity`);
  });
  it("does not assume won ToV is booked and uses the independent outcome date (Jan/Feb boundary)", async () => {
    let r = await request(`/deals/${dealId}`, "PATCH", { stage: "closed_won" }); expect(r.status).toBe(200);
    let b = await dashboard(); expect(b.summary.closedWon).toBe(0); expect(b.summary.bookedValues).toEqual({});
    r = await request(`/deals/${dealId}`, "PATCH", { actualOutcomeDate: "2027-02-01", bookedValue: 75 });
    expect(r.status).toBe(200); b = await dashboard();
    expect(b.summary).toMatchObject({ opportunities: 4, closedWon: 1, closedLost: 0, values: { INR: 100, USD: 0 }, bookedValues: { INR: 75 } });
    expect(b.quarters[0].bookedValues).toEqual({}); expect(b.quarters[1].bookedValues).toEqual({ INR: 75 });
    expect(b.months[2].closedWon).toBe(0); expect(b.months[3].closedWon).toBe(1);
    const ev: any = await loadHpBi(tenantId, { ...filters(), kind: "closed_won" }, "evidence");
    expect(ev.records[0]).toMatchObject({ externalEventId: `crm:deal:${dealId}:outcome`, orderValue: 75 });
  });
  it("suppresses repeat Excel mirrors across fiscal/account corrections without rewriting import IDs", async () => {
    const bytes = workbook(["recordId", "hpId", "kind", "occurredAt", "orderValue", "currency", "externalEventId"],
      [["MIRROR-OPP", "CRM-A", "opportunity", "2027-01-31", 100, "INR", `crm:deal:${dealId}:opportunity`],
        ["MIRROR-WON", "CRM-A", "closed_won", "2027-02-01", 75, "INR", `crm:deal:${dealId}:outcome`]]);
    await importHpWorkbook(tenantId, clientId, bytes, "crm-mirrors.xlsx", "activities", {}, null);
    await importHpWorkbook(tenantId, clientId, bytes, "crm-mirrors.xlsx", "activities", {}, null);
    let b = await dashboard();
    expect(b.summary.opportunities).toBe(4); expect(b.summary.closedWon).toBe(1); expect(b.quality.crmDeals.suppressedMirrors).toBe(2);
    const importedIds = (await pool.query("SELECT id FROM hp_bi_records WHERE tenant_id=$1 ORDER BY id", [tenantId])).rows;
    expect((await request(`/deals/${dealId}`, "PATCH", { companyId: siblingId, contactId: siblingContact,
      actualOpportunityDate: "2027-11-01", actualOutcomeDate: "2027-11-02", value: 200 })).status).toBe(200);
    b = await dashboard(); expect(b.summary.opportunities).toBe(3); expect(b.summary.closedWon).toBe(0);
    const next = await dashboard({ year: 2028 });
    expect(next.summary).toMatchObject({ opportunities: 1, closedWon: 1, values: { INR: 200 }, bookedValues: { INR: 75 } });
    expect((await dashboard({ segment: "GCC" })).summary.opportunities).toBe(2);
    expect((await pool.query("SELECT id FROM hp_bi_records WHERE tenant_id=$1 ORDER BY id", [tenantId])).rows).toEqual(importedIds);
    expect((await request(`/deals/${dealId}`, "GET", undefined, otherTenant)).status).toBe(404);
    expect((await request(`/deals/${dealId}/history`, "GET", undefined, otherTenant)).status).toBe(404);
    expect((await request(`/deals/${dealId}`, "PATCH", { title: "Intrusion" }, otherTenant)).status).toBe(404);
  });
  it("reopening and reversing outcomes remove stale bookings and require a new actual outcome", async () => {
    const r = await request(`/deals/${dealId}`, "PATCH", { stage: "negotiation" }); expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ actualOutcomeDate: null, bookedValue: null, opportunityConfirmed: true });
    expect((await dashboard({ year: 2028 })).summary.closedWon).toBe(0);
    expect((await dashboard()).summary.closedWon).toBe(0);
    expect((await request(`/deals/${dealId}`, "PATCH", { stage: "closed_lost", actualOutcomeDate: "2027-10-31" })).status).toBe(200);
    let b = await dashboard(); expect(b.months[11].closedLost).toBe(1); expect(b.quarters[3].closedLost).toBe(1);
    expect(b.summary.bookedValues).toEqual({});
    const won = await request(`/deals/${dealId}`, "PATCH", { stage: "closed_won" });
    expect(await won.json()).toMatchObject({ actualOutcomeDate: null, bookedValue: null });
    b = await dashboard(); expect(b.summary.closedLost).toBe(0); expect(b.summary.closedWon).toBe(0);
    expect((await request(`/deals/${dealId}`, "PATCH", { stage: "qualified" })).status).toBe(200);
    expect((await request(`/deals/${dealId}`)).status).toBe(200);
    expect((await dashboard({ year: 2028 })).summary.opportunities).toBe(0);
  });
  it("deleting a CRM identity retains audit and cannot resurrect linked Excel mirrors", async () => {
    expect((await request(`/deals/${dealId}`, "DELETE")).status).toBe(204);
    expect((await request(`/deals/${dealId}`)).status).toBe(404);
    const history: any = await (await request(`/deals/${dealId}/history`)).json();
    expect(history[0].action).toBe("deleted"); expect(history[0].after).toBeNull();
    expect(history.some((h: any) => h.before?.companyId === companyId && h.after?.companyId === siblingId)).toBe(true);
    const b = await dashboard();
    expect(b.summary.opportunities).toBe(3); expect(b.summary.closedWon).toBe(0);
    expect(b.quality.crmDeals.suppressedMirrors).toBe(2);
    expect((await request(`/deals/${dealId}`, "DELETE", undefined, otherTenant)).status).toBe(404);
  });
  it("preserves ordinary non-HP stage workflows without forcing HP facts", async () => {
    const response = await request("/deals", "POST", { clientId: otherClient, companyId: otherCompany,
      title: "Non HP", value: 10, currency: "USD", stage: "prospect", priority: "medium" });
    expect(response.status).toBe(201); const d: any = await response.json();
    expect((await request(`/deals/${d.id}`, "PATCH", { stage: "closed_won" })).status).toBe(200);
    expect((await dashboard()).summary.opportunities).toBe(3);
    const links: any = await (await request(`/deals/link-options?clientId=${clientId}&search=CRM&companyId=${companyId}`)).json();
    expect(links.accounts.map((a: any) => a.id)).toContain(companyId);
    expect(links.accounts.map((a: any) => a.id)).not.toContain(otherCompany);
    const contacts: any = await (await request(`/deals/link-options?clientId=${clientId}&companyId=${companyId}`)).json();
    expect(contacts.contacts.map((c: any) => c.id)).toEqual([contactId]);
  });
  it("keeps prospective value distinct and does not invent its fiscal date", async () => {
    const before = await dashboard();
    const response = await request("/deals", "POST", crm({ valueMeaning: "prospective", value: 250, currency: "EUR", opportunityConfirmed: false }));
    const d: any = await response.json(); expect(response.status).toBe(201);
    let b = await dashboard();
    expect(b.summary.prospectiveValues).toEqual({ EUR: 250 });
    expect(b.summary.opportunities).toBe(before.summary.opportunities);
    expect(b.summary.values).toEqual(before.summary.values); expect(b.summary.bookedValues).toEqual({});
    expect(b.quarters[0].prospectiveValues).toEqual({ EUR: 250 });
    expect((await request(`/deals/${d.id}`, "PATCH", { actualOpportunityDate: null, expectedCloseDate: "2027-01-31T00:00:00Z" })).status).toBe(200);
    b = await dashboard(); expect(b.summary.prospectiveValues).toEqual({});
    expect((await request(`/deals/${d.id}`, "DELETE")).status).toBe(204);
  });
  it("retains selected contact names outside the bounded first search page", async () => {
    const added = await pool.query(`INSERT INTO contacts(tenant_id,client_id,company_id,email)
      SELECT $1::int,$2::int,$3::int,'bounded-crm-'||s||'@example.invalid' FROM generate_series(1,52) s RETURNING id`, [tenantId, clientId, siblingId]);
    const selectedId = added.rows.at(-1).id;
    const choices: any = await (await request(`/deals/link-options?clientId=${clientId}&companyId=${siblingId}&contactId=${selectedId}&search=no-match`)).json();
    expect(choices.contacts).toHaveLength(1); expect(choices.contacts[0]).toMatchObject({ id: selectedId });
    expect(choices.contacts[0].name).toContain("bounded-crm-52");
    const linked: any = await (await request(`/deals?contactId=${siblingContact}`)).json();
    expect(linked).toHaveLength(1); expect(linked[0].contactId).toBe(siblingContact);
  });
  it("contact cascade deletion keeps a CRM tombstone for mirrors", async () => {
    const response = await request("/deals", "POST", crm({ actualOpportunityDate: "2027-05-01" }));
    const d: any = await response.json(); expect(response.status).toBe(201);
    await importHpWorkbook(tenantId, clientId, workbook(["recordId", "hpId", "kind", "occurredAt", "externalEventId"],
      [["CONTACT-MIRROR", "CRM-A", "opportunity", "2027-05-01", `crm:deal:${d.id}:opportunity`]]), "contact-mirror.xlsx", "activities", {}, null);
    const before = await dashboard();
    expect(await deleteContactAndHistory(tenantId, contactId)).toBe(true);
    const after = await dashboard();
    expect(after.summary.opportunities).toBeLessThan(before.summary.opportunities);
    expect(after.quality.crmDeals.suppressedMirrors).toBe(3);
    expect((await pool.query("SELECT action FROM deal_audit WHERE tenant_id=$1 AND deal_id=$2 ORDER BY id DESC LIMIT 1", [tenantId, d.id])).rows[0].action).toBe("contact_deleted");
  });
});
