import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import express from "express";
import supertest from "supertest";
import { get } from "node:http";
import { randomUUID } from "node:crypto";
import { pool } from "@workspace/db";
import committeeRouter from "../routes/buyingCommittee";
import { startCommitteeExportAudit, finishCommitteeExportAudit } from "./buyingCommitteeExportAudit";
import * as csvExport from "./buyingCommitteeExport";
import { parse } from "csv-parse/sync";

let tenantId: number, clientId: number, accountId: number, emptyId: number;
let otherTenant: number, otherClient: number, otherAccount: number;
const actorId = 741;
const actor = () => ({ tenantId, id: actorId });
const path = "/buying-committee/contacts/export";
const logs = { error: vi.fn() };
function app(role = "admin", tenant = tenantId, id = actorId) {
  const server = express();
  server.use((req, _res, next) => {
    req.isAuthenticated = (() => role !== "anonymous") as any;
    req.user = { tenantId: tenant, id, role } as any;
    req.log = logs as any;
    next();
  });
  server.use(committeeRouter);
  return server;
}
const scope = () => ({ clientId, accountIds: String(accountId) });
async function latest(tenant = tenantId) {
  return (await pool.query("SELECT * FROM buying_committee_export_audits WHERE tenant_id=$1 ORDER BY id DESC LIMIT 1", [tenant])).rows[0];
}
async function settled(tenant = tenantId) {
  let audit: any;
  await vi.waitFor(async () => {
    audit = await latest(tenant);
    expect(audit?.finished_at).not.toBeNull();
    expect(audit?.outcome).not.toBe("started");
  });
  return audit;
}
beforeAll(async () => {
  async function seed() {
    const tenant = Number((await pool.query("INSERT INTO tenants(name,slug) VALUES('Export audit test',$1) RETURNING id", [randomUUID()])).rows[0].id);
    const client = Number((await pool.query("INSERT INTO clients(tenant_id,name) VALUES($1,'HP') RETURNING id", [tenant])).rows[0].id);
    const account = Number((await pool.query("INSERT INTO companies(tenant_id,client_id,name) VALUES($1,$2,'Audit company') RETURNING id", [tenant, client])).rows[0].id);
    return [tenant, client, account];
  }
  [tenantId, clientId, accountId] = await seed();
  [otherTenant, otherClient, otherAccount] = await seed();
  emptyId = Number((await pool.query("INSERT INTO companies(tenant_id,client_id,name) VALUES($1,$2,'Empty') RETURNING id", [tenantId, clientId])).rows[0].id);
  await pool.query(`INSERT INTO buying_committee_contacts(tenant_id,client_id,company_id,apollo_id,name,email,phone)
    SELECT $1,$2,$3,'audit-'||n,'Private Person '||n,'private'||n||'@example.invalid','123456789'
    FROM generate_series(1,405) n`, [tenantId, clientId, accountId]);
});
afterEach(() => { vi.restoreAllMocks(); logs.error.mockClear(); });
afterAll(async () => {
  for (const tenant of [tenantId, otherTenant].filter(Boolean)) {
    for (const table of ["buying_committee_export_audits", "buying_committee_contacts", "companies", "clients"])
      await pool.query(`DELETE FROM ${table} WHERE tenant_id=$1`, [tenant]);
    await pool.query("DELETE FROM tenants WHERE id=$1", [tenant]);
  }
});

it("audits successful multi-batch and empty downloads without contact PII", async () => {
  const response = await supertest(app()).get(path).query({ clientId, accountIds: `${accountId},${accountId}` });
  expect(response.status).toBe(200);
  expect(parse(response.text, { bom: true, columns: true })).toHaveLength(405);
  const audit = await settled();
  expect(audit).toMatchObject({ tenant_id: tenantId, requested_by: actorId, client_id: clientId,
    account_ids: [accountId], row_count: 405, outcome: "completed" });
  expect(audit.started_at).toBeInstanceOf(Date);
  expect(audit.finished_at.getTime()).toBeGreaterThanOrEqual(audit.started_at.getTime());
  expect(Object.keys(audit).sort()).toEqual(["id", "tenant_id", "requested_by", "client_id",
    "account_ids", "started_at", "finished_at", "row_count", "outcome"].sort());
  expect(JSON.stringify(audit)).not.toMatch(/Private Person|example\.invalid|123456789|Business email/);
  expect((await supertest(app()).get(path).query({ clientId, accountIds: String(emptyId) })).status).toBe(200);
  expect(await settled()).toMatchObject({ row_count: 0, outcome: "completed", account_ids: [emptyId] });
});

it("audits forbidden and malformed attempts, but does not invent an anonymous tenant", async () => {
  for (const role of ["viewer", "member"]) {
    expect((await supertest(app(role)).get(path).query(scope())).status).toBe(403);
    expect(await settled()).toMatchObject({ requested_by: actorId, outcome: "rejected", row_count: 0 });
  }
  for (const query of [{ clientId, accountIds: "private@example.invalid" }, { clientId }, {}]) {
    const denied = await supertest(app()).get(path).query(query);
    expect(denied.status).toBe(400);
    expect(denied.headers["content-disposition"]).toBeUndefined();
    const audit = await settled();
    expect(audit).toMatchObject({ outcome: "rejected", row_count: 0, account_ids: [] });
    expect(JSON.stringify(audit)).not.toContain("private@example.invalid");
  }
  const before = (await latest()).id;
  expect((await supertest(app("anonymous")).get(path).query(scope())).status).toBe(401);
  expect((await latest()).id).toBe(before);
});

it("never attaches foreign client/accounts to an audit, even for mixed rejected scopes", async () => {
  expect((await supertest(app()).get(path).query({ clientId: otherClient, accountIds: String(otherAccount) })).status).toBe(404);
  expect(await settled()).toMatchObject({ tenant_id: tenantId, client_id: null, account_ids: [], outcome: "rejected" });
  expect((await supertest(app()).get(path).query({ clientId, accountIds: `${accountId},${otherAccount}` })).status).toBe(404);
  expect(await settled()).toMatchObject({ client_id: clientId, account_ids: [accountId], outcome: "rejected" });
  expect(await latest(otherTenant)).toBeUndefined();
  const id = await startCommitteeExportAudit(actor(), clientId, [accountId]);
  await expect(finishCommitteeExportAudit({ tenantId: otherTenant, id: actorId }, id, "completed", 999)).rejects.toThrow();
  await expect(finishCommitteeExportAudit({ tenantId, id: actorId + 1 }, id, "completed", 999)).rejects.toThrow();
  expect(await latest()).toMatchObject({ id, outcome: "started", row_count: 0 });
  await finishCommitteeExportAudit(actor(), id, "cancelled", 0);
  await expect(finishCommitteeExportAudit(actor(), id, "completed", 999)).rejects.toThrow();
  expect(await latest()).toMatchObject({ outcome: "cancelled", row_count: 0 });
});

it("fails closed before reading contact PII if the initial audit write fails", async () => {
  const query = pool.query.bind(pool);
  vi.spyOn(pool, "query").mockImplementation(((text: any, ...args: any[]) => {
    if (String(text).includes("INSERT INTO buying_committee_export_audits")) throw new Error("Unavailable");
    return (query as any)(text, ...args);
  }) as any);
  const response = await supertest(app()).get(path).query(scope());
  expect(response.status).toBe(500);
  expect(response.headers["content-disposition"]).toBeUndefined();
  expect(response.text).not.toContain("Private Person");
});

it("records server-side read failures as failed without copying the error into the audit", async () => {
  vi.spyOn(csvExport, "exportCommitteeCsv").mockImplementation(async function* () {
    throw new Error("Private Person private@example.invalid 123456789");
  });
  const response = await supertest(app()).get(path).query(scope());
  expect(response.status).toBe(500);
  expect(response.headers["content-disposition"]).toBeUndefined();
  const audit = await settled();
  expect(audit).toMatchObject({ outcome: "failed", row_count: 0 });
  expect(JSON.stringify(audit)).not.toMatch(/Private Person|example\.invalid|123456789/);
  expect(response.text).not.toContain("private@example.invalid");
});

it("retains an unfinished attempt and logs only safe IDs if finalization fails", async () => {
  const query = pool.query.bind(pool);
  vi.spyOn(pool, "query").mockImplementation(((text: any, ...args: any[]) => {
    if (String(text).includes("UPDATE buying_committee_export_audits")) throw new Error("private@example.invalid");
    return (query as any)(text, ...args);
  }) as any);
  expect((await supertest(app()).get(path).query(scope())).status).toBe(200);
  await vi.waitFor(() => expect(logs.error).toHaveBeenCalledOnce());
  expect(await latest()).toMatchObject({ outcome: "started", finished_at: null });
  expect(JSON.stringify(logs.error.mock.calls)).not.toContain("private@example.invalid");
});

// Exercise an actual socket disconnect while a cursor FETCH is in flight, not
// merely a generator.return(). Also cover cancellation before download headers.
for (const interruptBeforeHeaders of [false, true]) {
  it(`audits interruption ${interruptBeforeHeaders ? "before headers" : "mid-stream"} and releases the snapshot`, async () => {
    let unblock!: () => void, fetched!: () => void;
    const gate = new Promise<void>(resolve => { unblock = resolve; });
    const atFetch = new Promise<void>(resolve => { fetched = resolve; });
    const connect = pool.connect.bind(pool);
    let release: any, querySpy: any;
    vi.spyOn(pool, "connect").mockImplementation((function (...args: any[]) {
      // Pool.query uses callback-style connect; only wrap the export's checkout.
      if (args.length) return (connect as any)(...args);
      return connect().then(connection => {
        release = vi.spyOn(connection, "release");
        const query = connection.query.bind(connection);
        let fetches = 0;
        querySpy = vi.spyOn(connection, "query").mockImplementation((async (text: any, ...params: any[]) => {
          if (String(text).startsWith("FETCH") && ++fetches === (interruptBeforeHeaders ? 1 : 2)) {
            fetched();
            await gate;
          }
          return (query as any)(text, ...params);
        }) as any);
        return connection;
      });
    }) as any);
    const server = app().listen(0, "127.0.0.1");
    await new Promise<void>(resolve => server.once("listening", resolve));
    const socketClosed = new Promise<void>(resolve => server.once("connection", socket => socket.once("close", resolve)));
    const port = (server.address() as { port: number }).port;
    const request = get(`http://127.0.0.1:${port}${path}?clientId=${clientId}&accountIds=${accountId}`);
    request.on("error", () => {});
    try {
      await atFetch;
      request.destroy();
      // Allow the server to observe socket closure before its pending DB read returns.
      await socketClosed;
    } finally {
      unblock();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
    const audit = await settled();
    expect(audit).toMatchObject({ outcome: "cancelled", row_count: interruptBeforeHeaders ? 0 : 200 });
    expect(querySpy).toHaveBeenCalledWith("ROLLBACK");
    expect(release).toHaveBeenCalledOnce();
  });
}
