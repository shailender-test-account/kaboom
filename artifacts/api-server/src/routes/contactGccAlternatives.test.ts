import express from "express";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { pool } from "@workspace/db";
import { seedHpCrmAccounts, cleanHpCrmTenant } from "../lib/testFixtures/hpCrm";
import { deleteContactAndHistory } from "../lib/deleteCrmEntity";
import { contactGccAlternatives } from "../lib/contactGccAlternatives";

let tenantId: number, clientId: number, accountId: number, siblingId: number, contactId: number;
let requestedTenant: number;
vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { id: 1, tenantId: requestedTenant, role: "admin" }; next();
  },
}));
import router from "./contacts";
const app = express().use("/api", router);
const record = (overrides = {}) => ({ contactId, sourceRow: 4, fileHash: "a".repeat(64),
  fileName: "first.xlsx", sheet: "GCC", importedAt: "2026-10-01T00:00:00Z",
  values: { email2: "alternate@example.invalid", phone2: "9876543211" }, ...overrides });
async function store(records: unknown[], companyId = accountId, profileClient = clientId) {
  await pool.query(`UPDATE hp_account_profiles SET dimensions=jsonb_build_object('_gccProfiling',$4::jsonb)
    WHERE tenant_id=$1 AND client_id=$2 AND company_id=$3`,
  [tenantId, profileClient, companyId, JSON.stringify(records)]);
}
beforeAll(async () => {
  tenantId = Number((await pool.query("INSERT INTO tenants(name,slug) VALUES('Contact GCC read',$1) RETURNING id", [randomUUID()])).rows[0].id);
  requestedTenant = tenantId;
  clientId = Number((await pool.query("INSERT INTO clients(tenant_id,name) VALUES($1,'HP') RETURNING id", [tenantId])).rows[0].id);
  const fixture = await seedHpCrmAccounts(tenantId, clientId);
  accountId = fixture.companyId; siblingId = fixture.siblingId;
  contactId = Number((await pool.query(`INSERT INTO contacts(tenant_id,client_id,company_id,email,phone,first_name)
    VALUES($1,$2,$3,'primary@example.invalid','1111111111','Directory') RETURNING id`,
  [tenantId, clientId, accountId])).rows[0].id);
});
afterAll(async () => { if (tenantId) await cleanHpCrmTenant(tenantId); });
it("reads only this contact's versions and preserves primary fields", async () => {
  await store([record(), record({ fileHash: "b".repeat(64), fileName: "second.xlsx",
    values: { email2: "different@example.invalid", phone2: " " } }),
    record({ contactId: contactId + 1000, values: { email2: "other@example.invalid" } }),
    record({ sourceRow: 10, values: { email2: " ", phone2: "" } })]);
  await store([record({ values: { email2: "wrong-account@example.invalid" } })], siblingId);
  const response = await request(app).get(`/api/contacts/${contactId}`).expect(200);
  expect(response.body).toMatchObject({ email: "primary@example.invalid", phone: "1111111111",
    gccAlternatives: [
      { alternateEmail: "alternate@example.invalid", alternatePhone: "9876543211", fileName: "first.xlsx", sheet: "GCC", sourceRow: 4 },
      { alternateEmail: "different@example.invalid", alternatePhone: null, fileName: "second.xlsx" },
    ] });
  expect(response.body.gccAlternatives).toHaveLength(2);
  expect(response.body).not.toHaveProperty("gcc_profiling");
  requestedTenant = tenantId + 100000;
  await request(app).get(`/api/contacts/${contactId}`).expect(404);
  requestedTenant = tenantId;
});
it("does not expose a previous client's metadata after a contact reassignment", async () => {
  const otherClient = Number((await pool.query("INSERT INTO clients(tenant_id,name) VALUES($1,'Other client') RETURNING id", [tenantId])).rows[0].id);
  await pool.query("UPDATE contacts SET client_id=$2 WHERE id=$1", [contactId, otherClient]);
  const response = await request(app).get(`/api/contacts/${contactId}`).expect(200);
  expect(response.body.gccAlternatives).toEqual([]);
  await pool.query("UPDATE contacts SET client_id=$2 WHERE id=$1", [contactId, clientId]);
});
it("honors source tombstones, malformed collections and blanks", async () => {
  const tombstone = { fileHash: "a".repeat(64), sourceRow: 4, deleted: true };
  await store([record(), tombstone, record({ sourceRow: 5, values: { phone2: "2222222222" } })]);
  const response = await request(app).get(`/api/contacts/${contactId}`).expect(200);
  expect(response.body.gccAlternatives).toMatchObject([{ alternateEmail: null, alternatePhone: "2222222222", sourceRow: 5 }]);
  expect(response.body.gccAlternatives).toHaveLength(1);
  for (const input of [null, {}, "", [null, {}, record({ values: [] }), record({ values: { email2: "" } })]]) {
    expect(contactGccAlternatives(input, contactId)).toEqual([]);
  }
});
it("returns 404 after permanent deletion and retains only redacted source tombstones", async () => {
  await deleteContactAndHistory(tenantId, contactId);
  await request(app).get(`/api/contacts/${contactId}`).expect(404);
  const profile = (await pool.query("SELECT dimensions FROM hp_account_profiles WHERE tenant_id=$1 AND company_id=$2", [tenantId, accountId])).rows[0];
  expect(contactGccAlternatives(profile.dimensions._gccProfiling, contactId)).toEqual([]);
  expect(JSON.stringify(profile.dimensions)).not.toContain("alternate@example.invalid");
  expect(JSON.stringify(profile.dimensions)).not.toContain("2222222222");
});
