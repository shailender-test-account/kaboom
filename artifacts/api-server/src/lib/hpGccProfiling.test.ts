import { beforeAll, afterAll, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { pool } from "@workspace/db";
import { seedHpCrmAccounts, cleanHpCrmTenant } from "./testFixtures/hpCrm";
import { importApprovedGccProfiling, type GccSourceRow } from "./hpGccProfiling";
import { deleteContactAndHistory } from "./deleteCrmEntity";

let tenantId: number, clientId: number, accountId: number, otherId: number, hpId: string, contactId: number;
const fileHash = "c".repeat(64);
const values = { companyName: "Approved firm", name: "Directory Person", title: "Head IT", email: "gcc-person@example.invalid",
  email2: "gcc-alternate@example.invalid", phone: "9876543210", phone2: "9876543211", city: "Delhi" };
const source = (rows: GccSourceRow[] = [{ sourceRow: 2, values }]) => ({ fileName: "profiling.xlsx", fileHash, rows });
// The worksheet uses sentence case; the approval deliberately uses all caps.
const approval = () => [{ sourceCompany: values.companyName.toUpperCase(), accountId, hpId }];
beforeAll(async () => {
  tenantId = Number((await pool.query("INSERT INTO tenants(name,slug) VALUES('GCC directory import',$1) RETURNING id", [randomUUID()])).rows[0].id);
  clientId = Number((await pool.query("INSERT INTO clients(tenant_id,name) VALUES($1,'HP') RETURNING id", [tenantId])).rows[0].id);
  const fixture = await seedHpCrmAccounts(tenantId, clientId);
  accountId = fixture.companyId; otherId = fixture.siblingId;
  hpId = (await pool.query("SELECT hp_id FROM hp_account_profiles WHERE tenant_id=$1 AND company_id=$2", [tenantId, accountId])).rows[0].hp_id;
});
afterAll(async () => { if (tenantId) await cleanHpCrmTenant(tenantId); });
it("validates without writing and rejects stale approved HP identities", async () => {
  const preview = await importApprovedGccProfiling(tenantId, clientId, source(), approval());
  expect(preview.results[0]).toMatchObject({ outcome: "created", contactId: null });
  expect((await pool.query("SELECT id FROM contacts WHERE tenant_id=$1 AND email=$2", [tenantId, values.email])).rows).toHaveLength(0);
  await expect(importApprovedGccProfiling(tenantId, clientId, source(), [{ ...approval()[0], hpId: "changed" }], true)).rejects.toThrow("identity changed");
});
it("creates only approved contacts and retains all eight source fields without lead/intent activity", async () => {
  const before = (await pool.query("SELECT count(*)::int n FROM activity_events WHERE tenant_id=$1", [tenantId])).rows[0].n;
  const imported = await importApprovedGccProfiling(tenantId, clientId, source([
    { sourceRow: 2, values }, { sourceRow: 3, values: { ...values, companyName: "Held company", email: "held@example.invalid", phone: "" } },
  ]), approval(), true);
  expect(imported.results.map(r => r.outcome)).toEqual(["created", "held"]);
  contactId = imported.results[0].contactId!;
  const c = (await pool.query("SELECT *,intent_score::float8 AS intent_score FROM contacts WHERE tenant_id=$1 AND id=$2", [tenantId, contactId])).rows[0];
  expect(c).toMatchObject({ company_id: accountId, client_id: clientId, first_name: "Directory", last_name: "Person",
    title: "Head IT", email: values.email, city: "Delhi", phone: "+919876543210", stage: "pre-aware", intent_score: 0, lead_score: 0, last_activity: null });
  const p = (await pool.query("SELECT dimensions FROM hp_account_profiles WHERE tenant_id=$1 AND company_id=$2", [tenantId, accountId])).rows[0];
  expect(p.dimensions._gccProfiling[0]).toMatchObject({ sourceRow: 2, contactId, sheet: "GCC", values });
  expect((await pool.query("SELECT count(*)::int n FROM activity_events WHERE tenant_id=$1", [tenantId])).rows[0].n).toBe(before);
});
it("is idempotent and preserves populated fields, scores, status and DNC on existing contacts", async () => {
  await pool.query("UPDATE contacts SET title='Existing title',city='Mumbai',intent_score=73,lead_score=22,stage='engage',dnc=true,status='inactive' WHERE id=$1", [contactId]);
  const again = await importApprovedGccProfiling(tenantId, clientId, source(), approval(), true);
  expect(again.results[0]).toMatchObject({ outcome: "enriched", contactId });
  expect((await pool.query("SELECT id FROM contacts WHERE tenant_id=$1 AND email=$2", [tenantId, values.email])).rows).toHaveLength(1);
  const c = (await pool.query("SELECT title,city,intent_score::float8 AS intent_score,lead_score,stage,dnc,status FROM contacts WHERE id=$1", [contactId])).rows[0];
  expect(c).toMatchObject({ title: "Existing title", city: "Mumbai", intent_score: 73, lead_score: 22, stage: "engage", dnc: true, status: "inactive" });
});
it("holds conflicting contact ownership instead of moving or duplicating the person", async () => {
  await pool.query("UPDATE contacts SET company_id=$2 WHERE id=$1", [contactId, otherId]);
  const report = await importApprovedGccProfiling(tenantId, clientId, source(), approval(), true);
  expect(report.results[0].outcome).toBe("held");
  expect((await pool.query("SELECT company_id FROM contacts WHERE id=$1", [contactId])).rows[0].company_id).toBe(otherId);
  await pool.query("UPDATE contacts SET company_id=$2 WHERE id=$1", [contactId, accountId]);
});
it("does not combine differently named people who share an email", async () => {
  const result = await importApprovedGccProfiling(tenantId, clientId, source([
    { sourceRow: 4, values: { ...values, name: "Another Person", phone: "9999999999" } },
  ]), approval(), true);
  expect(result.results[0]).toMatchObject({ outcome: "held", contactId: null });
  expect(result.results[0].reason).toContain("differently named contact");
  expect((await pool.query("SELECT first_name,last_name,phone FROM contacts WHERE id=$1", [contactId])).rows[0])
    .toMatchObject({ first_name: "Directory", last_name: "Person", phone: "+919876543210" });
  const p = (await pool.query("SELECT dimensions FROM hp_account_profiles WHERE tenant_id=$1 AND company_id=$2", [tenantId, accountId])).rows[0];
  expect(p.dimensions._gccProfiling).toHaveLength(1);
});
it("keeps explicitly approved shared-email people separate, with their own phones, on repeat imports", async () => {
  const rows = [
    { sourceRow: 2, values },
    { sourceRow: 4, values: { ...values, name: "Another Person", phone: "9999999999" } },
  ];
  const approved = [{ ...approval()[0], allowSharedEmails: true }];
  const imported = await importApprovedGccProfiling(tenantId, clientId, source(rows), approved, true);
  expect(imported.results.map(r => r.outcome)).toEqual(["enriched", "created"]);
  const secondId = imported.results[1].contactId!;
  expect(secondId).not.toBe(contactId);
  expect((await pool.query("SELECT first_name,last_name,email,phone FROM contacts WHERE id=$1", [secondId])).rows[0])
    .toMatchObject({ first_name: "Another", last_name: "Person", email: values.email, phone: "+919999999999" });
  // The reviewed decision survives even when a later call uses the original company approval.
  const repeated = await importApprovedGccProfiling(tenantId, clientId, source(rows), approval(), true);
  expect(repeated.results.map(r => r.contactId)).toEqual([contactId, secondId]);
  expect(repeated.results.map(r => r.outcome)).toEqual(["enriched", "enriched"]);
  expect((await pool.query("SELECT id FROM contacts WHERE tenant_id=$1 AND email=$2", [tenantId, values.email])).rows).toHaveLength(2);
  const first = (await pool.query("SELECT phone,intent_score::float8 AS score,dnc,status FROM contacts WHERE id=$1", [contactId])).rows[0];
  expect(first).toMatchObject({ phone: "+919876543210", score: 73, dnc: true, status: "inactive" });
});
it("deletion clears copied personal details and the source row cannot silently recreate the contact", async () => {
  await deleteContactAndHistory(tenantId, contactId);
  const p = (await pool.query("SELECT dimensions FROM hp_account_profiles WHERE tenant_id=$1 AND company_id=$2", [tenantId, accountId])).rows[0];
  expect(p.dimensions._gccProfiling[0]).toEqual({ sourceRow: 2, fileHash, deleted: true });
  const repeat = await importApprovedGccProfiling(tenantId, clientId, source(), approval(), true);
  expect(repeat.results[0]).toMatchObject({ outcome: "held", contactId: null });
});
