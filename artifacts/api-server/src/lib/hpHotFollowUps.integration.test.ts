import { beforeAll, afterAll, describe, it, expect } from "vitest";
import express from "express";
import { randomUUID } from "node:crypto";
import { pool } from "@workspace/db";
import router from "../routes/hotFollowUps";
import { sectionAccess } from "../middlewares/sectionAccess";
import { hotContactEvidence, syncHotFollowUps } from "./hpHotFollowUps";
import type { PriorityForm } from "./hpAccountPriority";

describe("individual HP Hot follow-ups", () => {
  let tenantId: number, clientId: number, otherClient: number, accountId: number, otherAccount: number;
  let manager: number, viewer: number, foreignUser: number, foreignTenant: number;
  let server: ReturnType<express.Express["listen"]>, url: string;
  let permission: "none" | "view" | "manage" = "manage";
  let permissionSection: "gtm" | "sales" = "gtm";
  const at = new Date(Date.now() - 86400000).toISOString();
  const product = "Fixture HP Product";
  const request = async (path = "", body?: object) => {
    const response = await fetch(`${url}/api/sales-feedback/hot-follow-ups${path}`, {
      method: body ? "PATCH" : "GET", headers: { "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: await response.json() as any };
  };
  const person = async (name: string, status = "active") => Number((await pool.query(
    `INSERT INTO contacts(tenant_id,client_id,company_id,first_name,last_name,email,phone,status)
      VALUES($1,$2,$3,$4,'Fixture',$5,'+910000000000',$6) RETURNING id`,
    [tenantId, clientId, accountId, name, `${randomUUID()}@example.invalid`, status])).rows[0].id);
  const feedback = async (contactId: number | null, months: number, date = at, approved = true) =>
    Number((await pool.query(`INSERT INTO sales_feedback(tenant_id,client_id,account_id,contact_id,type,occurred_at,rep_name,
      feedback,product,timing_months,review_status,approved_qualification,record_key,content_hash)
      VALUES($1,$2,$3,$4,'telesales',$5,'Fixture','Verified interaction',$6,$7,$8,$9,$10,$11) RETURNING id`,
      [tenantId, clientId, accountId, contactId, date, product, months, approved ? "approved" : "pending",
        approved, randomUUID(), randomUUID()])).rows[0].id);
  beforeAll(async () => {
    tenantId = Number((await pool.query("INSERT INTO tenants(name,slug) VALUES('Hot worklist fixture',$1) RETURNING id", [randomUUID()])).rows[0].id);
    foreignTenant = Number((await pool.query("INSERT INTO tenants(name,slug) VALUES('Other worklist fixture',$1) RETURNING id", [randomUUID()])).rows[0].id);
    clientId = Number((await pool.query("INSERT INTO clients(tenant_id,name) VALUES($1,'HP') RETURNING id", [tenantId])).rows[0].id);
    otherClient = Number((await pool.query("INSERT INTO clients(tenant_id,name) VALUES($1,'Not HP') RETURNING id", [tenantId])).rows[0].id);
    accountId = Number((await pool.query("INSERT INTO companies(tenant_id,client_id,name) VALUES($1,$2,'Worklist Account') RETURNING id", [tenantId, clientId])).rows[0].id);
    otherAccount = Number((await pool.query("INSERT INTO companies(tenant_id,client_id,name) VALUES($1,$2,'Other Account') RETURNING id", [tenantId, otherClient])).rows[0].id);
    const user = async (tid: number, level: string) => Number((await pool.query(`INSERT INTO users(tenant_id,email,password_hash,first_name,last_name,role,section_permissions)
      VALUES($1,$2,'not-a-password','Fixture','User','member',$3::jsonb) RETURNING id`,
      [tid, `${randomUUID()}@example.invalid`, JSON.stringify({ gtm: level })])).rows[0].id);
    manager = await user(tenantId, "manage"); viewer = await user(tenantId, "view"); foreignUser = await user(foreignTenant, "manage");
    // This fixture exercises a shared marketing worklist, not owner-scoped Sales.
    await pool.query("INSERT INTO sales_user_access(tenant_id,user_id,visibility) VALUES($1,$2,'all')", [tenantId,manager]);
    const app = express(); app.use(express.json());
    app.use((req: any, _res, next) => {
      req.isAuthenticated = () => true;
      req.user = { id: manager, tenantId, role: "member", sectionPermissions: { [permissionSection]: permission } }; next();
    });
    app.use("/api", sectionAccess, router);
    app.use((err: any, _req: any, res: any, _next: any) => res.status(500).json({ error: err.message }));
    server = app.listen(0, "127.0.0.1"); await new Promise<void>(r => server.once("listening", r));
    url = `http://127.0.0.1:${(server.address() as any).port}`;
  });
  afterAll(async () => {
    if (server) await new Promise<void>(r => server.close(() => r()));
    for (const tid of [tenantId, foreignTenant].filter(Boolean)) {
      for (const table of ["call_dnc_contacts", "hp_hot_follow_ups", "sales_feedback", "contacts", "companies", "clients", "users"])
        await pool.query(`DELETE FROM ${table} WHERE tenant_id=$1`, [tid]);
      await pool.query("DELETE FROM tenants WHERE id=$1", [tid]);
    }
  });

  it("requires own fresh explicit Hot purchase evidence, never sibling/account heat", () => {
    const base: PriorityForm = { accountId: 1, contactId: 1, product, months: 2, at, reference: "form:1" };
    const forms = [base, { ...base, contactId: 2, months: 4 }, { ...base, contactId: null },
      { ...base, contactId: 3, at: new Date(Date.now() - 40 * 86400000).toISOString() },
      { ...base, contactId: 4, at: new Date(Date.now() + 86400000).toISOString() },
      { ...base, contactId: 5 }];
    expect([...hotContactEvidence({ forms, blockedContacts: new Set([5]) }).keys()]).toEqual([1]);
  });
  it("allows Sales-only users to view real eligible leads and assign/complete only with Manage", async () => {
    const contact = await person("SalesOnly");
    await feedback(contact, 2);
    await syncHotFollowUps(tenantId, clientId, [accountId]);
    permissionSection = "sales"; permission = "view";
    try {
      const list = await request();
      expect(list.status).toBe(200);
      const lead = list.body.items.find((item: any) => item.contactId === contact);
      expect(lead).toBeTruthy();
      expect((await request(`/${lead.id}`, { complete: true, note: "Sales follow-up fixture" })).status).toBe(403);
      permission = "manage";
      await pool.query("UPDATE users SET section_permissions=$2::jsonb WHERE id=$1",
        [viewer, JSON.stringify({ sales: "manage" })]);
      expect((await request(`/${lead.id}`, { assigneeId: viewer })).status).toBe(200);
      expect((await request(`/${lead.id}`, { complete: true, note: "Sales follow-up fixture" })).status).toBe(200);
    } finally {
      permissionSection = "gtm"; permission = "manage";
      await pool.query("UPDATE users SET section_permissions=$2::jsonb WHERE id=$1",
        [viewer, JSON.stringify({ gtm: "view" })]);
    }
  });
  it("automatically creates exactly one open row per eligible person, without outreach", async () => {
    const hot = await person("Hot"), sibling = await person("Sibling"), warm = await person("Warm");
    const optedOut = await person("OptedOut", "unsubscribed"), dnc = await person("DNC"), callDnc = await person("CallDNC");
    const pending = await person("Pending");
    await feedback(hot, 2); await feedback(hot, 1); await feedback(warm, 4); await feedback(null, 1);
    await feedback(optedOut, 1); await feedback(dnc, 1); await feedback(callDnc, 1); await feedback(pending, 1, at, false);
    await pool.query("UPDATE contacts SET dnc=true WHERE id=$1", [dnc]);
    await pool.query("INSERT INTO call_dnc_contacts(tenant_id,contact_id,source) VALUES($1,$2,'manual')", [tenantId, callDnc]);
    await Promise.all([syncHotFollowUps(tenantId, clientId, [accountId]), syncHotFollowUps(tenantId, clientId, [accountId])]);
    const list = await request(`?accountId=${accountId}`);
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    expect(list.body.items.map((r: any) => r.contactId)).toEqual([hot]);
    expect(list.body.items[0].evidence).toHaveLength(2);
    expect(list.body.assignees.map((r: any) => r.id)).toEqual([manager]);
    expect(list.body.items[0].contactId).not.toBe(sibling);
    expect((await pool.query("SELECT count(*)::int AS n FROM sequence_enrollments WHERE contact_id=$1", [hot])).rows[0].n).toBe(0);
  });
  it("enforces section rights and tenant-scoped eligible assignment, then persists completion", async () => {
    const hot = (await request(`?accountId=${accountId}`)).body.items[0];
    permission = "view";
    expect((await request()).status).toBe(200);
    expect((await request(`/${hot.id}`, { assigneeId: manager })).status).toBe(403);
    permission = "none"; expect((await request()).status).toBe(403);
    permission = "manage";
    expect((await request(`/${hot.id}`, { assigneeId: foreignUser })).status).toBe(400);
    expect((await request(`/${hot.id}`, { assigneeId: viewer })).status).toBe(400);
    expect((await request(`/${hot.id}`, { assigneeId: manager })).body.assigneeId).toBe(manager);
    expect((await request(`/${hot.id}`, { assigneeId: null })).body.assigneeId).toBeNull();
    expect((await request(`/${hot.id}`, { complete: true, note: "" })).status).toBe(400);
    const complete = await request(`/${hot.id}`, { complete: true, note: "Buyer requested a callback next week." });
    expect(complete.status, JSON.stringify(complete.body)).toBe(200);
    expect(complete.body.status).toBe("completed");
    await syncHotFollowUps(tenantId, clientId, [accountId]);
    const done = await request(`?contactId=${hot.contactId}&status=completed`);
    expect(done.body.items[0].completionNote).toContain("callback");
    expect((await request(`/${hot.id}`, { complete: true, note: "Duplicate" })).status).toBe(409);
  });
  it("revokes stale qualification, DNC and moved ownership on both list and mutation", async () => {
    const revoked = await person("Revoked"), moved = await person("Moved"), blocked = await person("Blocked");
    const source = await feedback(revoked, 1); await feedback(moved, 1); await feedback(blocked, 1);
    await syncHotFollowUps(tenantId, clientId, [accountId]);
    const rows = (await request()).body.items;
    const row = (cid: number) => rows.find((r: any) => r.contactId === cid);
    await pool.query("UPDATE sales_feedback SET approved_qualification=false WHERE id=$1", [source]);
    expect((await request(`/${row(revoked).id}`, { assigneeId: manager })).status).toBe(409);
    expect((await request(`?contactId=${revoked}`)).body.items).toEqual([]);
    await pool.query("UPDATE contacts SET company_id=$2,client_id=$3 WHERE id=$1", [moved, otherAccount, otherClient]);
    expect((await request(`/${row(moved).id}`, { assigneeId: manager })).status).toBe(409);
    await pool.query("UPDATE contacts SET dnc=true WHERE id=$1", [blocked]);
    expect((await request(`/${row(blocked).id}`, { complete: true, note: "Not allowed" })).status).toBe(409);
    expect((await request()).body.items).toEqual([]);
  });
  it("reopens only for new qualifying evidence and removes rows when the person is deleted", async () => {
    const completed = (await request("?status=completed")).body.items[0];
    await feedback(completed.contactId, 1, new Date().toISOString());
    await syncHotFollowUps(tenantId, clientId, [accountId]);
    const fresh = (await request(`?contactId=${completed.contactId}`)).body;
    expect(fresh.items).toHaveLength(1);
    expect(fresh.items[0].id).toBe(completed.id);
    expect(fresh.items[0].completedAt).toBeNull();
    await pool.query("DELETE FROM contacts WHERE id=$1", [completed.contactId]);
    expect((await pool.query("SELECT 1 FROM hp_hot_follow_ups WHERE id=$1", [completed.id])).rowCount).toBe(0);
  });
  it("pages the current eligible set after a full page of earlier records loses approval", async () => {
    const revokedIds: number[] = [];
    for (let i = 0; i < 25; i++) revokedIds.push(await feedback(await person(`Earlier ${i}`), 1));
    const survivor = await person("Still eligible");
    await feedback(survivor, 1);
    await syncHotFollowUps(tenantId, clientId, [accountId]);
    expect((await request()).body.total).toBe(26);
    await pool.query("UPDATE sales_feedback SET approved_qualification=false WHERE id=ANY($1::int[])", [revokedIds]);
    const page = await request("?page=1");
    expect(page.status, JSON.stringify(page.body)).toBe(200);
    expect(page.body.total).toBe(1);
    expect(page.body.items.map((r: any) => r.contactId)).toEqual([survivor]);
    expect((await request("?page=2")).body.items).toEqual([]);
  });
});
