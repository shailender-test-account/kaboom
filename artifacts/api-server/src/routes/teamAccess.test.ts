import { beforeAll, afterAll, describe, it, expect } from "vitest";
import express from "express";
import supertest from "supertest";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { pool } from "@workspace/db";
import teamRouter from "./team";
import clientsRouter from "./clients";
import companiesRouter from "./companies";
import { sectionAccess, apiSection } from "../middlewares/sectionAccess";
import { clientAccess } from "../middlewares/clientAccess";
import { requireRole } from "../middlewares/requireAuth";
import { canAccess, pageSection } from "@workspace/api-zod";

let tenantId: number, otherTenant: number, adminId: number, memberId: number, foreignId: number;
let hpClientId: number, otherClientId: number;
async function addUser(tenant: number, role: string, permissions: object | null = null) {
  return (await pool.query(`INSERT INTO users(tenant_id,email,password_hash,first_name,last_name,role,section_permissions)
    VALUES($1,$2,'not-a-login-hash','Access','Test',$3,$4::jsonb) RETURNING id`,
  [tenant, `${randomUUID()}@example.invalid`, role, JSON.stringify(permissions)])).rows[0].id as number;
}
function api(actorId: number | null = adminId) {
  const app = express(); app.use(express.json());
  app.use(async (req, _res, next) => {
    req.isAuthenticated = (() => actorId !== null) as any;
    if (actorId !== null) req.user = (await pool.query(`SELECT id,tenant_id AS "tenantId",role,
      section_permissions AS "sectionPermissions",client_ids AS "clientIds" FROM users WHERE id=$1`, [actorId])).rows[0];
    next();
  });
  app.use("/api", sectionAccess);
  app.use("/api", clientAccess);
  app.use("/api", teamRouter);
  app.use("/api", clientsRouter);
  app.use("/api", companiesRouter);
  app.get("/api/analytics/hp-bi", (req, res) => res.json({ ok: true, clientId: req.query.clientId }));
  app.post("/api/analytics/hp-bi/records", requireRole("admin"), (_req, res) => res.json({ ok: true }));
  app.post("/api/analytics/gtm-status", (_req, res) => res.json({ contacts: {} }));
  app.post("/api/analytics/acquisition", (_req, res) => res.json({ contacts: {}, accounts: {} }));
  app.get("/api/companies/:id", (req, res) => res.json({ id: req.params.id }));
  app.get("/api/sales-feedback/hot-follow-ups", (_req, res) => res.json([]));
  app.patch("/api/sales-feedback/hot-follow-ups/1", (_req, res) => res.json({ ok: true }));
  app.get("/api/sales-feedback/sources", (_req, res) => res.json([]));
  app.get("/api/sales-feedback/options", (_req, res) => res.json({ clients: [] }));
  app.get("/api/sales-feedback", (_req, res) => res.json({ items: [] }));
  app.post("/api/sales-feedback", requireRole("admin"), (_req, res) => res.json({ ok: true }));
  app.post("/api/sales-feedback/sources", requireRole("admin"), (_req, res) => res.json({ ok: true }));
  app.get("/api/future-sensitive-endpoint", (_req, res) => res.json({ secret: true }));
  app.use((err: any, _req: any, res: any, _next: any) => res.status(err.status ?? 500).json({ error: err.message }));
  return supertest(app);
}
beforeAll(async () => {
  tenantId = (await pool.query("INSERT INTO tenants(name,slug) VALUES('Isolated access tests',$1) RETURNING id", [`access-${randomUUID()}`])).rows[0].id;
  otherTenant = (await pool.query("INSERT INTO tenants(name,slug) VALUES('Other isolated access tests',$1) RETURNING id", [`access-${randomUUID()}`])).rows[0].id;
  adminId = await addUser(tenantId, "admin");
  memberId = await addUser(tenantId, "editor", { analytics: "view" });
  foreignId = await addUser(otherTenant, "admin");
  hpClientId = (await pool.query("INSERT INTO clients(tenant_id,name) VALUES($1,'HP test') RETURNING id", [tenantId])).rows[0].id;
  otherClientId = (await pool.query("INSERT INTO clients(tenant_id,name) VALUES($1,'Other test') RETURNING id", [tenantId])).rows[0].id;
});
afterAll(async () => {
  await pool.query("DELETE FROM users WHERE tenant_id=ANY($1::int[])", [[tenantId, otherTenant]]);
  await pool.query("DELETE FROM companies WHERE tenant_id=$1", [tenantId]);
  await pool.query("DELETE FROM clients WHERE tenant_id=$1", [tenantId]);
  await pool.query("DELETE FROM tenants WHERE id=ANY($1::int[])", [[tenantId, otherTenant]]);
});

describe("team management and section rights", () => {
  it("creates a batch atomically with shared client and section access and private credentials", async () => {
    const emails = [`${randomUUID()}@example.invalid`, `${randomUUID()}@example.invalid`];
    const created = await api().post("/api/users/bulk").send({
      users: emails.map(email => ({ firstName: " Bulk ", lastName: " Member ", email })),
      role: "viewer", sectionPermissions: { analytics: "view", sales: "manage" }, clientIds: [hpClientId],
    }).expect(201);
    expect(created.headers["cache-control"]).toBe("no-store");
    expect(created.body).toHaveLength(2);
    expect(new Set(created.body.map((row: any) => row.tempPassword)).size).toBe(2);
    for (const row of created.body) {
      expect(row.user).toMatchObject({ firstName: "Bulk", lastName: "Member", role: "viewer", clientIds: [hpClientId], sectionPermissions: { analytics: "view", sales: "manage" } });
      expect(row.user).not.toHaveProperty("passwordHash");
      expect(row.tempPassword.length).toBeGreaterThan(20);
      expect(row.tempPassword.startsWith("U")).toBe(true);
      const stored = (await pool.query("SELECT password_hash FROM users WHERE id=$1", [row.user.id])).rows[0];
      expect(await bcrypt.compare(row.tempPassword, stored.password_hash)).toBe(true);
      expect((await api(row.user.id).get("/api/clients").expect(200)).body.map((client: any) => client.id)).toEqual([hpClientId]);
    }
    const listed = (await api().get("/api/team-access").expect(200)).body;
    expect(listed.filter((row: any) => emails.includes(row.email)).every((row: any) => !("tempPassword" in row))).toBe(true);
  });
  it("rejects duplicate, registered, invalid and excessive batches without partial users", async () => {
    const fresh = `${randomUUID()}@example.invalid`;
    const existing = (await pool.query("SELECT email FROM users WHERE id=$1", [adminId])).rows[0].email;
    const row = { firstName: "Batch", lastName: "Member", email: fresh };
    const shared = { role: "viewer", sectionPermissions: {}, clientIds: [] };
    await api().post("/api/users/bulk").send({ ...shared, users: [row, { ...row, email: fresh.toUpperCase() }] }).expect(400);
    await api().post("/api/users/bulk").send({ ...shared, users: [row, { ...row, email: existing.toUpperCase() }] }).expect(409);
    await api().post("/api/users/bulk").send({ ...shared, users: [row, { ...row, email: "bad" }] }).expect(400);
    await api().post("/api/users/bulk").send({ ...shared, users: [] }).expect(400);
    await api().post("/api/users/bulk").send({ ...shared, users: Array.from({ length: 51 }, () => row) }).expect(400);
    await api().post("/api/users/bulk").send({ ...shared, users: [row], role: "admin" }).expect(400);
    await api().post("/api/users/bulk").send({ ...shared, users: [row], sectionPermissions: null }).expect(400);
    await api().post("/api/users/bulk").send({ ...shared, users: [row], sectionPermissions: { fake: "manage" } }).expect(400);
    expect((await pool.query("SELECT id FROM users WHERE lower(email)=$1", [fresh])).rowCount).toBe(0);
  });
  it("keeps bulk creation admin-only and rejects foreign-client assignment", async () => {
    const fresh = `${randomUUID()}@example.invalid`;
    const body = { users: [{ firstName: "Scope", lastName: "Test", email: fresh }], role: "viewer", sectionPermissions: {}, clientIds: null };
    await api(null).post("/api/users/bulk").send(body).expect(401);
    await api(memberId).post("/api/users/bulk").send(body).expect(403);
    const foreignClient = (await pool.query("INSERT INTO clients(tenant_id,name) VALUES($1,'Foreign batch client') RETURNING id", [otherTenant])).rows[0].id;
    try {
      await api().post("/api/users/bulk").send({ ...body, clientIds: [hpClientId, foreignClient] }).expect(400);
      expect((await pool.query("SELECT id FROM users WHERE email=$1", [fresh])).rowCount).toBe(0);
    } finally { await pool.query("DELETE FROM clients WHERE id=$1", [foreignClient]); }
  });
  it("prevents two simultaneous submissions from creating duplicate sign-ins", async () => {
    const email = `${randomUUID()}@example.invalid`;
    const body = { users: [{ firstName: "Concurrent", lastName: "Batch", email }], role: "editor", sectionPermissions: {}, clientIds: null };
    const responses = await Promise.all([api().post("/api/users/bulk").send(body), api().post("/api/users/bulk").send(body)]);
    expect(responses.map(response => response.status).sort()).toEqual([201, 409]);
    expect((await pool.query("SELECT id FROM users WHERE email=$1", [email])).rowCount).toBe(1);
  });
  it("assigns one or multiple clients and blocks unscoped, cross-client and shared routes", async () => {
    const hpCompany = (await pool.query("INSERT INTO companies(tenant_id,client_id,name) VALUES($1,$2,'HP account') RETURNING id",
      [tenantId, hpClientId])).rows[0].id;
    const otherCompany = (await pool.query("INSERT INTO companies(tenant_id,client_id,name) VALUES($1,$2,'Other account') RETURNING id",
      [tenantId, otherClientId])).rows[0].id;
    const created = await api().post("/api/users/invite").send({
      email: `${randomUUID()}@example.invalid`, firstName: "Restricted", lastName: "Member",
      role: "viewer", sectionPermissions: { analytics: "view", companies: "view" },
      clientIds: [hpClientId],
    }).expect(201);
    const id = created.body.user.id;
    expect(created.body.user.clientIds).toEqual([hpClientId]);
    expect((await api(id).get("/api/clients").expect(200)).body.map((c: any) => c.id)).toEqual([hpClientId]);
    expect((await api(id).get("/api/companies").expect(200)).body.map((c: any) => c.id)).toEqual([hpCompany]);
    await api(id).get(`/api/companies/${otherCompany}`).expect(403);
    await api(id).get(`/api/companies?clientId=${otherClientId}`).expect(403);
    await api(id).post("/api/companies").send({ name: "Cross-linked", clientId: hpClientId, companyId: otherCompany }).expect(403);
    expect((await api(id).get("/api/analytics/hp-bi").expect(200)).body.clientId).toBe(String(hpClientId));
    await api(id).get(`/api/analytics/hp-bi?clientId=${otherClientId}`).expect(403);
    await api(id).get("/api/future-sensitive-endpoint").expect(403);
    await api(id).get("/api/analytics/dashboard").expect(403);
    await api().patch(`/api/users/${id}/access`).send({
      role: "viewer", sectionPermissions: { analytics: "view", companies: "view" },
      clientIds: [hpClientId, otherClientId],
    }).expect(200);
    expect((await api(id).get("/api/clients").expect(200)).body.map((c: any) => c.id).sort()).toEqual([hpClientId, otherClientId].sort());
    expect((await api(id).get(`/api/analytics/hp-bi?clientId=${otherClientId}`).expect(200)).body.clientId).toBe(String(otherClientId));
    await api().patch(`/api/users/${id}/access`).send({
      role: "viewer", sectionPermissions: { analytics: "view", companies: "view" }, clientIds: [],
    }).expect(200);
    await api(id).get("/api/clients").expect(403);
    await api().delete(`/api/users/${id}`).expect(200);
    await pool.query("DELETE FROM companies WHERE id=ANY($1::int[])", [[hpCompany, otherCompany]]);
  });
  it("rejects clients belonging to a different workspace", async () => {
    const foreignClient = (await pool.query("INSERT INTO clients(tenant_id,name) VALUES($1,'Foreign test') RETURNING id", [otherTenant])).rows[0].id;
    await api().patch(`/api/users/${memberId}/access`).send({
      role: "viewer", sectionPermissions: { analytics: "view" }, clientIds: [foreignClient],
    }).expect(400);
    await api().post("/api/users/invite").send({
      email: `${randomUUID()}@example.invalid`, firstName: "Invalid", lastName: "Member",
      role: "viewer", sectionPermissions: { analytics: "view" }, clientIds: [foreignClient],
    }).expect(400);
    await pool.query("DELETE FROM clients WHERE id=$1", [foreignClient]);
  });
  it("admin can grant Sales only, with separate view/write access and immediate revocation", async () => {
    await api().patch(`/api/users/${memberId}/access`).send({ role: "viewer", sectionPermissions: { sales: "view" } }).expect(200);
    await api(memberId).get("/api/sales-feedback/hot-follow-ups").expect(200);
    await api(memberId).patch("/api/sales-feedback/hot-follow-ups/1").send({ complete: true }).expect(403);
    await api(memberId).get("/api/sales-feedback/sources").expect(200);
    await api(memberId).get("/api/sales-feedback/options").expect(200);
    await api(memberId).get("/api/sales-feedback").expect(200);
    await api(memberId).post("/api/sales-feedback").send({}).expect(403);
    await api(memberId).post("/api/sales-feedback/sources").send({}).expect(403);
    await api(memberId).get("/api/clients").expect(200);
    await api(memberId).get("/api/team-access").expect(403);
    await api().patch(`/api/users/${memberId}/access`).send({ role: "viewer", sectionPermissions: { sales: "manage" } }).expect(200);
    await api(memberId).patch("/api/sales-feedback/hot-follow-ups/1").send({ complete: true }).expect(200);
    await api(memberId).post("/api/sales-feedback").send({}).expect(200);
    await api(memberId).post("/api/sales-feedback/sources").send({}).expect(200);
    await api().patch(`/api/users/${memberId}/access`).send({ role: "viewer", sectionPermissions: {} }).expect(200);
    await api(memberId).get("/api/sales-feedback/hot-follow-ups").expect(403);
    await api().patch(`/api/users/${memberId}/access`).send({ role: "editor", sectionPermissions: { analytics: "view" } }).expect(200);
  });
  it("keeps listing, role/profile changes, invites and deletion admin-only", async () => {
    for (const path of ["/users", "/team-access"]) await api(memberId).get(`/api${path}`).expect(403);
    await api(null).get("/api/team-access").expect(401);
    for (const suffix of ["role", "profile", "access", "password", "deactivate"]) {
      await api(memberId).patch(`/api/users/${adminId}/${suffix}`).send({ role: "admin", firstName: "Hijack", password: "NotApplied123!" }).expect(403);
    }
    await api(memberId).post("/api/users/invite").send({}).expect(403);
    await api(memberId).delete(`/api/users/${adminId}`).expect(403);
    const list = await api().get("/api/team-access").expect(200);
    expect(list.body.some((row: any) => row.id === foreignId)).toBe(false);
    expect(list.body.some((row: any) => "passwordHash" in row || "password_hash" in row)).toBe(false);
  });
  it("persists explicit view, manage and no-access rules, including server enforcement", async () => {
    await api().patch(`/api/users/${memberId}/access`).send({ role: "viewer", sectionPermissions: { analytics: "view" } }).expect(200);
    await api(memberId).get("/api/analytics/hp-bi").expect(200);
    await api(memberId).get("/api/clients").expect(200);
    await api(memberId).post("/api/analytics/hp-bi/records").send({}).expect(403);
    await api(memberId).post("/api/analytics/gtm-status").send({ contactIds: [] }).expect(200);
    await api(memberId).post("/api/analytics/acquisition").send({ contactIds: [], accountIds: [] }).expect(200);
    await api(memberId).get("/api/future-sensitive-endpoint").expect(403);
    await api().patch(`/api/users/${memberId}/access`).send({ role: "viewer", sectionPermissions: { analytics: "manage" } }).expect(200);
    await api(memberId).post("/api/analytics/hp-bi/records").send({}).expect(200);
    await api().patch(`/api/users/${memberId}/access`).send({ role: "viewer", sectionPermissions: { settings: "manage" } }).expect(200);
    await api(memberId).patch(`/api/users/${memberId}/role`).send({ role: "admin" }).expect(403);
    await api().patch(`/api/users/${memberId}/access`).send({ role: "viewer", sectionPermissions: {} }).expect(200);
    await api(memberId).get("/api/analytics/hp-bi").expect(403);
  });
  it("rejects invalid grants and cross-tenant targets", async () => {
    await api().patch(`/api/users/${memberId}/access`).send({ role: "admin", sectionPermissions: { fake: "manage" } }).expect(400);
    await api().patch(`/api/users/${memberId}/access`).send({ role: "owner", sectionPermissions: null }).expect(400);
    await api().patch(`/api/users/${memberId}/access`).send({ role: "viewer", sectionPermissions: { analytics: "superuser" } }).expect(400);
    await api().patch(`/api/users/${foreignId}/access`).send({ role: "viewer", sectionPermissions: {} }).expect(404);
    await api().patch(`/api/users/${foreignId}/profile`).send({ firstName: "No" }).expect(404);
    await api().delete(`/api/users/${foreignId}`).expect(404);
  });
  it("adds a user with scoped rights and returns only one-time credentials", async () => {
    const email = `${randomUUID()}@example.invalid`;
    const created = await api().post("/api/users/invite").send({
      email: email.toUpperCase(), firstName: "New", lastName: "Member",
      role: "viewer", sectionPermissions: { analytics: "view", committee: "manage" },
    }).expect(201);
    expect(created.body.user).toMatchObject({ email, role: "viewer", sectionPermissions: { analytics: "view", committee: "manage" } });
    expect(created.body.tempPassword.length).toBeGreaterThan(20);
    const list = await api().get("/api/team-access").expect(200);
    expect(list.body.find((row: any) => row.id === created.body.user.id)).not.toHaveProperty("tempPassword");
    await api().post("/api/users/invite").send({ email, firstName: "Duplicate", lastName: "Member" }).expect(409);
  });
  it("allows admin handover but blocks every route that removes the last admin", async () => {
    await api().patch(`/api/users/${adminId}/access`).send({ role: "viewer", sectionPermissions: {} }).expect(409);
    const second = await addUser(tenantId, "admin");
    await api().patch(`/api/users/${adminId}/access`).send({ role: "manager", sectionPermissions: { analytics: "manage" } }).expect(200);
    await api(adminId).get("/api/team-access").expect(403);
    await api(second).patch(`/api/users/${second}/role`).send({ role: "viewer" }).expect(409);
    await api(second).patch(`/api/users/${second}/deactivate`).send({}).expect(400);
    await api(second).delete(`/api/users/${second}`).expect(400);
    await api(second).patch(`/api/users/${adminId}/role`).send({ role: "admin" }).expect(200);
    await api().delete(`/api/users/${second}`).expect(200);
  });
  it("serializes concurrent administrator demotions", async () => {
    const second = await addUser(tenantId, "admin");
    const results = await Promise.all([
      api().patch(`/api/users/${adminId}/access`).send({ role: "viewer", sectionPermissions: {} }),
      api(second).patch(`/api/users/${second}/access`).send({ role: "viewer", sectionPermissions: {} }),
    ]);
    expect(results.map(r => r.status).sort()).toEqual([200, 409]);
    const admins = (await pool.query("SELECT id FROM users WHERE tenant_id=$1 AND role='admin'", [tenantId])).rows;
    expect(admins).toHaveLength(1);
    // Restore the fixture's primary admin for any following checks.
    await api(admins[0].id).patch(`/api/users/${adminId}/role`).send({ role: "admin" }).expect(200);
  });
});
it("maps independent sidebar sections and their API boundaries", () => {
  for (const [path, section] of [
    ["/intent/monitoring-configs/1/retry", "monitoring"], ["/intent/inbound/sources", "gtm"],
    ["/buying-committee/plans", "committee"], ["/analytics/hp-bi", "analytics"],
    ["/call-campaigns/dnc", "dnc"], ["/users/1/access", "settings"],
  ]) expect(apiSection(path)).toBe(section);
  expect(pageSection("/intent/buying-committee")).toBe("committee");
  expect(pageSection("/intent/inbound-accounts")).toBe("gtm");
  expect(pageSection("/sales-dashboard")).toBe("sales");
  expect(pageSection("/intent/sales-feedback")).toBe("sales");
  expect(canAccess({ role: "admin", sectionPermissions: {} }, "analytics", true)).toBe(true);
  expect(canAccess({ role: "editor", sectionPermissions: {} }, "analytics")).toBe(false);
});
