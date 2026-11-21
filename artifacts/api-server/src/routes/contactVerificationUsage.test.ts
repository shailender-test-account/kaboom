import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import express from "express";
import supertest from "supertest";
import { randomUUID } from "node:crypto";
import { pool } from "@workspace/db";
import verification from "./contactVerification";

vi.mock("../lib/buyingCommittee", () => ({
  apolloCommitteeConfig: vi.fn(async () => ({ configured: true, apiKey: "test-only-key" })),
}));

let tenant: number, other: number, contacts: number[];
function api(scope = tenant, role = "admin", authenticated = true) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { tenantId: scope, role, sectionPermissions: { database: "manage" } } as any;
    req.isAuthenticated = (() => authenticated) as any; next();
  });
  app.use("/api", verification);
  app.use((err: any, _req: any, res: any, _next: any) => res.status(500).json({ error: err.message }));
  return supertest(app);
}
const path = (id: number) => `/api/contacts/${id}/verification`;
const limit = (requestLimit: number) => api().patch("/api/contact-verification-usage").send({ requestLimit });
const usage = async () => (await api().get("/api/contact-verification-usage").expect(200)).body;

beforeEach(async () => {
  tenant = (await pool.query("INSERT INTO tenants(name,slug) VALUES('Verification budget tests',$1) RETURNING id", [randomUUID()])).rows[0].id;
  other = (await pool.query("INSERT INTO tenants(name,slug) VALUES('Other budget tests',$1) RETURNING id", [randomUUID()])).rows[0].id;
  contacts = (await pool.query(`INSERT INTO contacts(tenant_id,email) VALUES($1,$2),($1,$3) RETURNING id`,
    [tenant, `${randomUUID()}@example.com`, `${randomUUID()}@example.com`])).rows.map(r => r.id);
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await pool.query("DELETE FROM contacts WHERE tenant_id=ANY($1::int[])", [[tenant, other]]);
  await pool.query("DELETE FROM contact_verification_usage WHERE tenant_id=ANY($1::int[])", [[tenant, other]]);
  await pool.query("DELETE FROM tenants WHERE id=ANY($1::int[])", [[tenant, other]]);
});

describe("verification budgets and transport accounting", () => {
  it("fails closed by default and rejects invalid ceilings and non-admin access", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    expect(await usage()).toMatchObject({ requestLimit: 0, attempts: 0, responses: 0, remaining: 0 });
    await api().post(path(contacts[0])).expect(429);
    expect(fetch).not.toHaveBeenCalled();
    for (const requestLimit of [-1, 1.5, "10", null, 1000001]) {
      await api().patch("/api/contact-verification-usage").send({ requestLimit }).expect(400);
    }
    for (const role of ["member", "manager"]) {
      await api(tenant, role).get("/api/contact-verification-usage").expect(403);
      await api(tenant, role).patch("/api/contact-verification-usage").send({ requestLimit: 5 }).expect(403);
    }
    await api(tenant, "admin", false).get("/api/contact-verification-usage").expect(401);
    await limit(2).expect(200);
    expect((await api(other).get("/api/contact-verification-usage").expect(200)).body.requestLimit).toBe(0);
    await api(other).post(path(contacts[0])).expect(404);
    expect((await usage()).attempts).toBe(0);
  });

  it("serializes a shared tenant ceiling across different concurrent contacts", async () => {
    await limit(1).expect(200);
    const fetch = vi.fn(async () => ({ ok: false, status: 503 })); vi.stubGlobal("fetch", fetch);
    const results = await Promise.all(contacts.map(id => api().post(path(id))));
    expect(results.map(r => r.status).sort()).toEqual([429, 502]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await usage()).toMatchObject({ attempts: 1, responses: 1, unconfirmedAttempts: 0, remaining: 0 });
    expect((await pool.query("SELECT status FROM contact_verifications WHERE tenant_id=$1", [tenant])).rows).toEqual([{ status: "failed" }]);
  });

  it("retains timeouts without retry or refund; changing the ceiling never resets counters", async () => {
    await limit(1).expect(200);
    const fetch = vi.fn(async () => { throw new Error("Timed out"); }); vi.stubGlobal("fetch", fetch);
    await api().post(path(contacts[0])).expect(502);
    await api().post(path(contacts[0])).expect(429);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await usage()).toMatchObject({ attempts: 1, responses: 0, unconfirmedAttempts: 1 });
    await limit(0).expect(200);
    await limit(2).expect(200);
    expect(await usage()).toMatchObject({ attempts: 1, responses: 0, remaining: 1 });
    await pool.query("DELETE FROM contacts WHERE tenant_id=$1", [tenant]);
    expect(await usage()).toMatchObject({ attempts: 1, responses: 0, remaining: 1 });
  });

  it("counts every response independently of status, JSON validity and identity outcome", async () => {
    await limit(10).expect(200);
    const email = (await pool.query("SELECT email FROM contacts WHERE id=$1", [contacts[0]])).rows[0].email;
    const fetch = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 429 })
      .mockResolvedValueOnce({ ok: true, json: async () => { throw new Error("Invalid JSON"); } })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ person: { email: "wrong@example.com" } }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ person: { email } }) });
    vi.stubGlobal("fetch", fetch);
    for (const status of [502, 502, 502, 200]) await api().post(path(contacts[0])).expect(status);
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(await usage()).toMatchObject({ attempts: 4, responses: 4, unconfirmedAttempts: 0, remaining: 6 });
    const rows = (await pool.query("SELECT status FROM contact_verifications WHERE tenant_id=$1 ORDER BY id", [tenant])).rows;
    expect(rows.map(r => r.status)).toEqual(["failed", "failed", "failed", "verified"]);
    // Read and field review never consume a provider request.
    await api().get(path(contacts[0])).expect(200);
    await api().patch(`${path(contacts[0])}/1`).send({ fields: [] }).expect(409);
    expect((await usage()).attempts).toBe(4);
  });

  it("does not consume the ceiling for a duplicate active claim on the same contact", async () => {
    await limit(2).expect(200);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let started!: () => void;
    const called = new Promise<void>(resolve => { started = resolve; });
    const fetch = vi.fn(async () => { started(); await gate; throw new Error("Timed out"); });
    vi.stubGlobal("fetch", fetch);
    const first = api().post(path(contacts[0])).then(r => r);
    await called;
    try {
      await api().post(path(contacts[0])).expect(409);
      expect((await usage()).attempts).toBe(1);
    } finally { release(); }
    expect((await first).status).toBe(502);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
