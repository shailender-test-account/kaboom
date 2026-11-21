import { beforeAll, afterAll, describe, it, expect, vi } from "vitest";
import express from "express";
import { randomUUID } from "node:crypto";
import { pool } from "@workspace/db";
import sales from "../routes/salesAccounts";
import feedback from "../routes/salesFeedback";
import followUps from "../routes/hotFollowUps";
import intent from "../routes/intent";
import { sectionAccess } from "../middlewares/sectionAccess";
import { clientAccess } from "../middlewares/clientAccess";
import { syncHotFollowUps } from "./hpHotFollowUps";
import * as audit from "./salesAccessAudit";

describe("Hot account ownership and marketing visibility", () => {
  let tenant: number, client: number, otherClient: number;
  let admin: number, rep: number, otherRep: number, marketing: number, none: number;
  let rosterAccount: number, assignedAccount: number, unassigned: number, otherAccount: number;
  let server: ReturnType<express.Express["listen"]>, url: string, contact: number, followUp: number;
  let foreignTenant: number, foreignClient: number, foreignAccount: number, foreignUser: number;
  const actor = async (role: string, grants: object, clients: number[] | null) => Number((await pool.query(
    `INSERT INTO users(tenant_id,email,password_hash,first_name,last_name,role,section_permissions,client_ids)
     VALUES($1,$2,'invalid-test-hash','Sales','Fixture',$3,$4::jsonb,$5::jsonb) RETURNING id`,
    [tenant, `${randomUUID()}@example.invalid`, role, JSON.stringify(grants), clients === null ? null : JSON.stringify(clients)])).rows[0].id);
  const request = async (user: number, path: string, method = "GET", body?: object) => {
    const r = await fetch(`${url}/api${path}`, { method, headers: { "Content-Type": "application/json", "X-Test-Actor": String(user) },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, body: await r.json() as any };
  };
  beforeAll(async () => {
    tenant = (await pool.query("INSERT INTO tenants(name,slug) VALUES('Sales access fixture',$1) RETURNING id", [randomUUID()])).rows[0].id;
    client = (await pool.query("INSERT INTO clients(tenant_id,name) VALUES($1,'HP') RETURNING id", [tenant])).rows[0].id;
    otherClient = (await pool.query("INSERT INTO clients(tenant_id,name) VALUES($1,'Other permitted client') RETURNING id", [tenant])).rows[0].id;
    admin = await actor("admin", {}, null);
    rep = await actor("viewer", { sales: "manage" }, [client]);
    otherRep = await actor("viewer", { sales: "manage" }, null);
    marketing = await actor("viewer", { sales: "view" }, [client, otherClient]);
    none = await actor("viewer", { sales: "none" }, null);
    foreignTenant = (await pool.query("INSERT INTO tenants(name,slug) VALUES('Foreign sales fixture',$1) RETURNING id", [randomUUID()])).rows[0].id;
    foreignClient = (await pool.query("INSERT INTO clients(tenant_id,name) VALUES($1,'Foreign client') RETURNING id", [foreignTenant])).rows[0].id;
    foreignAccount = (await pool.query("INSERT INTO companies(tenant_id,client_id,name) VALUES($1,$2,'Foreign account') RETURNING id", [foreignTenant,foreignClient])).rows[0].id;
    foreignUser = (await pool.query(`INSERT INTO users(tenant_id,email,password_hash,first_name,last_name,role)
      VALUES($1,$2,'invalid-test-hash','Foreign','Owner','admin') RETURNING id`, [foreignTenant,`${randomUUID()}@example.invalid`])).rows[0].id;
    await pool.query("INSERT INTO sales_user_access(tenant_id,user_id,visibility) VALUES($1,$2,'all')", [tenant, marketing]);
    const makeAccount = async (cid: number, name: string, age = 45) => {
      const a = (await pool.query("INSERT INTO companies(tenant_id,client_id,name) VALUES($1,$2,$3) RETURNING id", [tenant, cid, name])).rows[0].id;
      const c = (await pool.query(`INSERT INTO contacts(tenant_id,client_id,company_id,first_name,last_name,email,status)
        VALUES($1,$2,$3,'Declared','Buyer',$4,'active') RETURNING id`, [tenant, cid, a, `${randomUUID()}@example.invalid`])).rows[0].id;
      await pool.query(`INSERT INTO hp_bi_records(tenant_id,client_id,account_id,contact_id,kind,occurred_at,product,horizon_months,source,source_key)
        VALUES($1,$2,$3,$4,'lead',$5,'Explicit product',2,'manual',$6)`,
      [tenant, cid, a, c, new Date(Date.now() - age * 86400000), randomUUID()]);
      return { id: Number(a), contactId: Number(c) };
    };
    const a = await makeAccount(client, "A Roster owned", 1); rosterAccount = a.id; contact = a.contactId;
    assignedAccount = (await makeAccount(client, "B Assigned owned")).id;
    unassigned = (await makeAccount(client, "C Unassigned")).id;
    otherAccount = (await makeAccount(otherClient, "D Other client")).id;
    const email = (await pool.query("SELECT email FROM users WHERE id=$1", [rep])).rows[0].email;
    await pool.query(`INSERT INTO hp_account_profiles(tenant_id,client_id,company_id,parent_key,parent_name,eam_email,provenance)
      VALUES($1,$2,$3,'test-parent','Roster parent',$4,'{}'::jsonb)`, [tenant, client, rosterAccount, ` ${email.toUpperCase()} `]);
    await pool.query(`INSERT INTO sales_account_owners(tenant_id,client_id,account_id,user_id)
      VALUES($1,$2,$3,$4),($1,$5,$6,$7)`, [tenant, client, assignedAccount, otherRep, otherClient, otherAccount, rep]);
    await pool.query(`INSERT INTO sales_feedback(tenant_id,client_id,account_id,contact_id,type,rep_name,feedback,record_key,content_hash)
      VALUES($1,$2,$3,$4,'sales_rep','Fixture','Own account feedback',$5,$6)`,
    [tenant, client, rosterAccount, contact, randomUUID(), randomUUID()]);
    await syncHotFollowUps(tenant, client, [rosterAccount]);
    followUp = (await pool.query("SELECT id FROM hp_hot_follow_ups WHERE tenant_id=$1 AND contact_id=$2", [tenant, contact])).rows[0].id;
    const app = express(); app.use(express.json());
    app.use(async (req: any, _res, next) => {
      try {
        const u = (await pool.query(`SELECT id,tenant_id AS "tenantId",email,role,section_permissions AS "sectionPermissions",
          client_ids AS "clientIds" FROM users WHERE id=$1 AND tenant_id=$2`, [Number(req.headers["x-test-actor"]), tenant])).rows[0];
        req.user = u; req.isAuthenticated = () => !!u; next();
      } catch (e) { next(e); }
    });
    app.use("/api", sectionAccess, clientAccess, sales, followUps, feedback, intent);
    app.use((error: any, _req: any, res: any, _next: any) => res.status(500).json({ error: error.message }));
    server = app.listen(0, "127.0.0.1"); await new Promise<void>(r => server.once("listening", r));
    url = `http://127.0.0.1:${(server.address() as any).port}`;
  });
  afterAll(async () => {
    if (server) await new Promise<void>(r => server.close(() => r()));
    if (!tenant) return;
    for (const table of ["intent_inbound_submissions", "intent_products", "intent_product_categories",
      "hp_hot_follow_ups", "sales_feedback", "hp_bi_records", "contacts", "companies", "clients", "users"])
      await pool.query(`DELETE FROM ${table} WHERE tenant_id=$1`, [tenant]);
    await pool.query("DELETE FROM tenants WHERE id=$1", [tenant]);
    if(foreignTenant) {
      for (const table of ["companies","clients","users"]) await pool.query(`DELETE FROM ${table} WHERE tenant_id=$1`,[foreignTenant]);
      await pool.query("DELETE FROM tenants WHERE id=$1",[foreignTenant]);
    }
  });
  it("automatically includes every client's declared Hot accounts for admin and marketing, including older declarations", async () => {
    for (const user of [admin, marketing]) {
      const r = await request(user, "/sales/accounts");
      expect(r.status).toBe(200); expect(r.body.total).toBe(4);
      expect(r.body.items.map((a: any) => a.id)).toEqual([rosterAccount, assignedAccount, unassigned, otherAccount]);
      expect(r.body.items.find((a: any) => a.id === assignedAccount).evidence[0].fresh).toBe(false);
    }
  });
  it("routes only product-qualified Hot GTM accounts, excluding Warm, Cold and incomplete declarations", async () => {
    const accounts: number[] = [];
    const add = async (name: string, product: string | null, months: number | null, classification: string, rejected = false) => {
      const account = Number((await pool.query("INSERT INTO companies(tenant_id,client_id,name) VALUES($1,$2,$3) RETURNING id",
        [tenant, client, `GTM sales gate ${name}`])).rows[0].id);
      accounts.push(account);
      await pool.query(`INSERT INTO intent_inbound_submissions(tenant_id,client_id,account_id,drive_file_id,row_key,
        file_name,form_type,classification,classification_reason,product_interest,purchase_timeframe_months,submitted_at,affinity_reviews)
        VALUES($1,$2,$3,$4,$4,'sales-gate-fixture.xlsx','event_feedback',$5,'Sales gate fixture',$6,$7,NOW(),$8::jsonb)`,
        [tenant, client, account, randomUUID(), classification, product, months,
          JSON.stringify(rejected && product ? { [product]: "rejected" } : {})]);
      return account;
    };
    try {
      const hotNow = await add("Hot now", "HP Anyware Services", 0, "hot");
      const hotThree = await add("Hot three months", "HP Anyware Services", 3, "hot");
      await add("Warm four months", "HP Anyware Services", 4, "warm");
      await add("Warm six months", "HP Anyware Services", 6, "warm");
      await add("Cold later", "HP Anyware Services", 7, "cold");
      await add("Cold missing timeline", "HP Anyware Services", null, "cold");
      await add("Cold missing product", null, 2, "cold");
      await add("Rejected interest", "HP Anyware Services", 2, "hot", true);
      for (const user of [admin, marketing]) {
        const result = await request(user, "/sales/accounts?search=GTM%20sales%20gate");
        expect(result.status).toBe(200);
        expect(result.body.items.map((a: any) => a.id).sort((a: number, b: number) => a - b)).toEqual([hotNow, hotThree]);
        expect(result.body.total).toBe(2);
        expect(result.body.items.every((a: any) => a.evidence.every((e: any) => e.months >= 0 && e.months <= 3))).toBe(true);
      }
      const warmOnly = await request(admin, "/sales/accounts?search=GTM%20sales%20gate%20Warm");
      expect(warmOnly.body.total).toBe(0);
      // An administrator's owner-assignment filter cannot admit non-Hot accounts.
      const unassignedOnly = await request(admin, "/sales/accounts?search=GTM%20sales%20gate&unassigned=true");
      expect(unassignedOnly.body.total).toBe(2);
    } finally {
      await pool.query("DELETE FROM intent_inbound_submissions WHERE tenant_id=$1 AND account_id=ANY($2::int[])", [tenant, accounts]);
      await pool.query("DELETE FROM companies WHERE tenant_id=$1 AND id=ANY($2::int[])", [tenant, accounts]);
    }
  });
  it("matches roster email case-insensitively and intersects ownership with client grants", async () => {
    const r = await request(rep, "/sales/accounts");
    expect(r.status).toBe(200); expect(r.body.visibility).toBe("owned");
    expect(r.body.items.map((a: any) => a.id)).toEqual([rosterAccount]);
    expect((await request(rep, `/sales/accounts?clientId=${otherClient}`)).body.total).toBe(0);
    expect((await request(rep, `/sales/accounts/${otherAccount}`)).status).toBe(404);
    expect((await request(rep, `/sales/accounts/${assignedAccount}`)).status).toBe(404);
    expect((await request(none, "/sales/accounts")).status).toBe(403);
  });
  it("allows an owning Sales manager to submit stamped feedback but denies View-only users and other owners", async () => {
    const body = {clientId:client,accountId:rosterAccount,contactId:contact,type:"sales_rep",feedback:"Feedback from account table"};
    const created = await request(rep, "/sales-feedback", "POST", {...body,repName:"Spoofed name",createdBy:admin});
    expect(created.status,JSON.stringify(created.body)).toBe(201);
    try {
      expect(created.body).toMatchObject({createdBy:rep,createdByName:"Sales Fixture",repName:"Sales Fixture",reviewStatus:"pending",approvedQualification:false});
      expect((await request(marketing, "/sales-feedback", "POST", body)).status).toBe(403);
      expect((await request(otherRep, "/sales-feedback", "POST", body)).status).toBe(404);
      expect((await request(none, "/sales-feedback", "POST", body)).status).toBe(403);
    } finally {
      if(created.body.id) await pool.query("DELETE FROM sales_feedback WHERE tenant_id=$1 AND id=$2",[tenant,created.body.id]);
    }
  });
  it("uses explicit assignments for non-roster users without granting everyone the account", async () => {
    const r = await request(otherRep, "/sales/accounts");
    expect(r.body.items.map((a: any) => a.id)).toEqual([assignedAccount]);
    expect((await request(otherRep, `/sales/accounts/${assignedAccount}`)).status).toBe(200);
    expect((await request(otherRep, `/sales/accounts/${rosterAccount}`)).status).toBe(404);
  });
  it("keeps call follow-ups, feedback and contact selectors within the same ownership boundary", async () => {
    const options = await request(rep, `/sales-feedback/options?clientId=${client}`);
    expect(options.status).toBe(200); expect(options.body.accounts.map((a: any) => a.id)).toEqual([rosterAccount]);
    const hiddenOptions = await request(otherRep, `/sales-feedback/options?clientId=${client}&contactId=${contact}`);
    expect(hiddenOptions.status).toBe(404);
    expect((await request(rep, `/sales-feedback?clientId=${client}`)).body.total).toBe(1);
    expect((await request(otherRep, `/sales-feedback?clientId=${client}`)).body.total).toBe(0);
    expect((await request(rep, `/sales-feedback/hot-follow-ups?clientId=${client}`)).body.total).toBe(1);
    expect((await request(otherRep, `/sales-feedback/hot-follow-ups?clientId=${client}`)).body.total).toBe(0);
    expect((await request(otherRep, `/sales-feedback/hot-follow-ups/${followUp}`, "PATCH", { complete: true, note: "Forbidden" })).status).toBe(404);
    expect((await request(rep, "/sales-feedback/sources")).status).toBe(403);
  });
  it("only admin may grant all-account visibility; revocation is effective on the next request", async () => {
    expect((await request(rep, `/team-access/${rep}/sales-access`, "PUT", { visibility: "all" })).status).toBe(403);
    expect((await request(admin, `/team-access/${otherRep}/sales-access`, "PUT", { visibility: "all" })).status).toBe(200);
    expect((await request(otherRep, "/sales/accounts")).body.total).toBe(4);
    await request(admin, `/team-access/${otherRep}/sales-access`, "PUT", { visibility: "owned" });
    expect((await request(otherRep, "/sales/accounts")).body.total).toBe(1);
  });
  it("persists owner changes, rejects unauthorized assignees, and retains additive roster ownership", async () => {
    expect((await request(rep, `/sales/accounts/${unassigned}/owners`, "PUT", { userIds: [rep] })).status).toBe(403);
    expect((await request(admin, `/sales/accounts/${otherAccount}/owners`, "PUT", { userIds: [rep] })).status).toBe(400);
    const saved = await request(admin, `/sales/accounts/${unassigned}/owners`, "PUT", { userIds: [rep] });
    expect(saved.status).toBe(200); expect(saved.body.assignedUserIds).toEqual([rep]);
    expect((await request(rep, "/sales/accounts")).body.total).toBe(2);
    await request(admin, `/sales/accounts/${unassigned}/owners`, "PUT", { userIds: [] });
    expect((await request(rep, `/sales/accounts/${unassigned}`)).status).toBe(404);
    await request(admin, `/sales/accounts/${rosterAccount}/owners`, "PUT", { userIds: [] });
    expect((await request(rep, `/sales/accounts/${rosterAccount}`)).status).toBe(200);
  });
  it("does not allow tenant-crossing owner assignments, grants or account reads", async () => {
    expect((await request(admin, `/sales/accounts/${foreignAccount}`)).status).toBe(404);
    expect((await request(admin, `/sales/accounts/${unassigned}/owners`, "PUT", {userIds:[foreignUser]})).status).toBe(400);
    expect((await request(admin, `/team-access/${foreignUser}/sales-access`, "PUT", {visibility:"all"})).status).toBe(404);
    expect((await request(admin, `/team-access/${foreignUser}/sales-access`)).status).toBe(404);
  });
  const previewBatch = (assignments: { accountId: number; userIds: number[] }[], user = admin) =>
    request(user, "/sales/accounts/owners/preview", "POST", { assignments });
  const confirmBatch = (reviewToken: string, user = admin) =>
    request(user, "/sales/accounts/owners/confirm", "POST", { reviewToken });
  it("filters unassigned Hot accounts for admins only, ignoring unmatched roster email labels", async () => {
    await pool.query(`INSERT INTO hp_account_profiles(tenant_id,client_id,company_id,parent_key,parent_name,eam_email,provenance)
      VALUES($1,$2,$3,'unmatched-parent','Unmatched','nobody@example.invalid','{}'::jsonb)`, [tenant, client, unassigned]);
    const r = await request(admin, "/sales/accounts?unassigned=true");
    expect(r.status).toBe(200); expect(r.body.total).toBe(1);
    expect(r.body.items.map((a: any) => a.id)).toEqual([unassigned]);
    for (const user of [rep, marketing]) {
      expect((await request(user, "/sales/accounts?unassigned=true")).status).toBe(403);
      expect((await previewBatch([{ accountId: unassigned, userIds: [user] }], user)).status).toBe(403);
      expect((await confirmBatch("invalid", user)).status).toBe(403);
    }
  });
  it("bounds previews, rejects duplicates and blocks wrong-tenant or cross-client owners without writing", async () => {
    expect((await previewBatch([])).status).toBe(400);
    expect((await previewBatch(Array.from({ length: 26 }, () => ({ accountId: unassigned, userIds: [rep] })))).status).toBe(400);
    expect((await previewBatch([{ accountId: unassigned, userIds: Array.from({ length: 11 }, (_, i) => i + 1) }])).status).toBe(400);
    expect((await previewBatch([{ accountId: unassigned, userIds: [rep] }, { accountId: unassigned, userIds: [rep] }])).status).toBe(409);
    for (const accountId of [rosterAccount, assignedAccount, foreignAccount]) {
      expect((await previewBatch([{ accountId, userIds: [rep] }])).status).toBe(409);
    }
    for (const userId of [foreignUser, none]) {
      expect((await previewBatch([{ accountId: unassigned, userIds: [userId] }])).status).toBe(409);
    }
    // An own-only HP salesperson cannot be proposed for another client's account.
    await pool.query("DELETE FROM sales_account_owners WHERE tenant_id=$1 AND account_id=$2", [tenant, otherAccount]);
    expect((await previewBatch([{ accountId: otherAccount, userIds: [rep] }])).status).toBe(409);
    const choices = await previewBatch([{ accountId: otherAccount, userIds: [] }]);
    expect(choices.body.reviewToken).toBeNull();
    expect(choices.body.rows[0].assignableUsers.some((u: any) => u.id === rep)).toBe(false);
  });
  it("invalidates reviewed batches when section/client access or ownership changes", async () => {
    for (const field of ["section", "client", "owner"]) {
      const p = await previewBatch([{ accountId: unassigned, userIds: [rep] }]);
      expect(p.status).toBe(200); expect(p.body.rows[0]).toMatchObject({
        accountId: unassigned, clientId: client, clientName: "HP", proposedUsers: [{ id: rep }],
      });
      if (field === "section") await pool.query(`UPDATE users SET section_permissions='{"sales":"none"}' WHERE id=$1`, [rep]);
      if (field === "client") await pool.query(`UPDATE users SET client_ids='[]' WHERE id=$1`, [rep]);
      if (field === "owner") await request(admin, `/sales/accounts/${unassigned}/owners`, "PUT", { userIds: [otherRep] });
      try {
        expect((await confirmBatch(p.body.reviewToken)).status).toBe(409);
        expect((await pool.query("SELECT user_id FROM sales_account_owners WHERE tenant_id=$1 AND account_id=$2 AND user_id=$3",
          [tenant, unassigned, rep])).rows).toHaveLength(0);
      } finally {
        await pool.query(`UPDATE users SET section_permissions='{"sales":"manage"}',client_ids=$2::jsonb WHERE id=$1`, [rep, JSON.stringify([client])]);
        await request(admin, `/sales/accounts/${unassigned}/owners`, "PUT", { userIds: [] });
      }
    }
  });
  it("rolls back earlier inserts if a later assignment fails, and a reviewed retry saves the full batch", async () => {
    const batch = [{ accountId: unassigned, userIds: [rep] }, { accountId: otherAccount, userIds: [otherRep] }];
    const p = await previewBatch(batch);
    expect(p.status).toBe(200);
    expect((await confirmBatch(`${p.body.reviewToken}edited`)).status).toBe(409);
    expect((await confirmBatch(p.body.reviewToken, marketing)).status).toBe(403);
    // A fixture-scoped database failure on the second insert proves actual rollback.
    const trigger = `sales_batch_failure_${tenant}`;
    await pool.query(`CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.tenant_id=${Number(tenant)} AND NEW.account_id=${Number(otherAccount)} THEN
      RAISE EXCEPTION 'fixture insert failure'; END IF; RETURN NEW; END $$`);
    try {
      await pool.query(`CREATE TRIGGER ${trigger} BEFORE INSERT ON sales_account_owners FOR EACH ROW EXECUTE FUNCTION ${trigger}()`);
      expect((await confirmBatch(p.body.reviewToken)).status).toBe(500);
      expect((await pool.query("SELECT user_id FROM sales_account_owners WHERE tenant_id=$1 AND account_id=ANY($2::int[])",
        [tenant, [unassigned, otherAccount]])).rows).toHaveLength(0);
    } finally {
      await pool.query(`DROP TRIGGER IF EXISTS ${trigger} ON sales_account_owners`);
      await pool.query(`DROP FUNCTION ${trigger}()`);
    }
    const saved = await confirmBatch(p.body.reviewToken);
    expect(saved.status).toBe(200); expect(saved.body.assignedAccounts).toEqual([unassigned, otherAccount]);
    expect((await request(rep, "/sales/accounts")).body.items.map((a: any) => a.id)).toContain(unassigned);
    expect((await request(otherRep, `/sales/accounts/${otherAccount}`)).status).toBe(200);
    expect((await confirmBatch(p.body.reviewToken)).status).toBe(409);
    // Assignment never modifies grants, all-account visibility, or the calling queue.
    expect((await request(rep, `/sales/accounts/${otherAccount}`)).status).toBe(404);
    expect((await request(rep, "/sales/accounts/options")).body.visibility).toBe("owned");
    expect((await pool.query("SELECT count(*)::int AS n FROM hp_hot_follow_ups WHERE tenant_id=$1", [tenant])).rows[0].n).toBe(1);
    expect((await request(rep, `/sales/accounts/${rosterAccount}`)).status).toBe(200);
  });
  it("keeps both histories admin-only, including for Sales managers and all-account viewers", async () => {
    for (const user of [rep, otherRep, marketing, none, 0]) {
      for (const path of [`/sales/accounts/${unassigned}/owner-history`, `/team-access/${rep}/sales-access/history`]) {
        expect([401, 403]).toContain((await request(user, path)).status);
      }
    }
    for (const path of [`/sales/accounts/${foreignAccount}/owner-history`, `/team-access/${foreignUser}/sales-access/history`]) {
      const r = await request(admin, path);
      expect(r.status).toBe(200); expect(r.body.items).toEqual([]);
    }
    const owners = await request(admin, `/sales/accounts/${unassigned}/owner-history`);
    expect(owners.body.items.some((e: any) => e.outcome === "changed")).toBe(true);
    expect(owners.body.items.some((e: any) => e.outcome === "rejected")).toBe(true);
    expect(JSON.stringify(owners.body)).not.toMatch(/password|example.invalid|contactId|phone|credential/);
    expect((await request(admin, `/sales/accounts/${unassigned}/owner-history?beforeId=bad`)).status).toBe(400);
  });
  it("rolls back each mutation if its audit cannot be saved", async () => {
    const before = (await pool.query("SELECT user_id FROM sales_account_owners WHERE tenant_id=$1 AND account_id=$2 ORDER BY user_id",
      [tenant, unassigned])).rows;
    let spy = vi.spyOn(audit, "recordSalesAccess").mockRejectedValueOnce(new Error("Audit storage unavailable"));
    try {
      expect((await request(admin, `/sales/accounts/${unassigned}/owners`, "PUT", { userIds: [rep] })).status).toBe(500);
    } finally { spy.mockRestore(); }
    expect((await pool.query("SELECT user_id FROM sales_account_owners WHERE tenant_id=$1 AND account_id=$2 ORDER BY user_id",
      [tenant, unassigned])).rows).toEqual(before);
    const original = (await request(admin, `/team-access/${otherRep}/sales-access`)).body;
    spy = vi.spyOn(audit, "recordSalesAccess").mockRejectedValueOnce(new Error("Audit storage unavailable"));
    try {
      expect((await request(admin, `/team-access/${otherRep}/sales-access`, "PUT", { visibility: "all" })).status).toBe(500);
    } finally { spy.mockRestore(); }
    expect((await request(admin, `/team-access/${otherRep}/sales-access`)).body).toEqual(original);
  });
  it("serializes simultaneous owner replacements and visibility changes without losing before/after history", async () => {
    const startId = Number((await pool.query("SELECT coalesce(max(id),0) AS id FROM sales_access_audit WHERE tenant_id=$1", [tenant])).rows[0].id);
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => [
      request(admin, `/sales/accounts/${unassigned}/owners`, "PUT", { userIds: i % 2 ? [rep] : [otherRep] }),
      request(admin, `/team-access/${otherRep}/sales-access`, "PUT", { visibility: i % 2 ? "owned" : "all" }),
    ]).flat());
    expect(results.every(r => r.status === 200)).toBe(true);
    const rows = (await pool.query("SELECT * FROM sales_access_audit WHERE tenant_id=$1 AND id>$2 ORDER BY id", [tenant, startId])).rows;
    expect(rows).toHaveLength(16);
    for (const kind of ["owners", "visibility"]) {
      const changes = rows.filter(r => r.kind === kind);
      expect(changes).toHaveLength(8);
      for (let i = 1; i < changes.length; i++) expect(changes[i].before_value).toEqual(changes[i - 1].after_value);
      for (const row of changes) expect(row.requested_at.getTime()).toBeLessThanOrEqual(row.recorded_at.getTime());
      const final = kind === "owners"
        ? (await pool.query("SELECT user_id FROM sales_account_owners WHERE tenant_id=$1 AND account_id=$2 ORDER BY user_id",
          [tenant, unassigned])).rows.map(r => r.user_id)
        : (await request(admin, `/team-access/${otherRep}/sales-access`)).body.visibility;
      expect(changes.at(-1).after_value).toEqual(final);
    }
  });
  it("allows HP inbound creation to finish while ownership and visibility saves wait, without opposite-order deadlocks", async () => {
    const category = (await pool.query(`INSERT INTO intent_product_categories(tenant_id,name)
      VALUES($1,'Security') RETURNING id`, [tenant])).rows[0].id;
    const product = (await pool.query(`INSERT INTO intent_products(tenant_id,category_id,name)
      VALUES($1,$2,'HP Security Services') RETURNING id`, [tenant, category])).rows[0].id;
    const waitForLock = async (lockId: number) => {
      for (let attempt = 0; attempt < 100; attempt++) {
        if ((await pool.query(`SELECT 1 FROM pg_locks WHERE locktype='advisory'
          AND classid=$1 AND objid=$2 AND NOT granted`, [tenant, lockId])).rowCount) return;
        await new Promise(r => setTimeout(r, 10));
      }
      throw new Error(`Expected request to wait for lock ${lockId}`);
    };
    for (const kind of ["owners", "visibility"]) {
      const gate = await pool.connect();
      let inbound: ReturnType<typeof request> | undefined, save: ReturnType<typeof request> | undefined;
      try {
        await gate.query("BEGIN");
        // HP inbound obtains the ownership lock before this client lock. Hold
        // it here so the sales request is forced to overlap, not merely race.
        await gate.query("SELECT pg_advisory_xact_lock($1,$2)", [tenant, client]);
        inbound = request(admin, "/intent/inbound/accounts", "POST", {
          clientId: client, name: `Concurrent HP inbound ${kind}`, contactName: "Concurrency fixture",
          contactEmail: `${randomUUID()}@example.invalid`, productId: product, categoryName: "Security",
          formType: "lead_form", formFilledDate: "2026-11-12", purchaseTimeframeMonths: 3,
        });
        await Promise.race([waitForLock(client), inbound.then(result => {
          throw new Error(`Inbound completed before the concurrency gate: ${JSON.stringify(result)}`);
        })]);
        save = kind === "owners"
          ? request(admin, `/sales/accounts/${unassigned}/owners`, "PUT", { userIds: [rep] })
          : request(admin, `/team-access/${otherRep}/sales-access`, "PUT", { visibility: "all" });
        await waitForLock(914357);
        await gate.query("COMMIT");
        expect((await inbound).status).toBe(201);
        expect((await save).status).toBe(200);
        const row = (await pool.query(`SELECT outcome FROM sales_access_audit
          WHERE tenant_id=$1 AND kind=$2 AND target_id=$3 ORDER BY id DESC LIMIT 1`,
        [tenant, kind, kind === "owners" ? unassigned : otherRep])).rows[0];
        expect(["changed", "unchanged"]).toContain(row.outcome);
      } finally {
        await gate.query("ROLLBACK"); gate.release();
        await Promise.all([inbound, save].filter(Boolean));
      }
    }
  });
  it("keeps original request time while queued and rejects a queued actor whose admin rights were removed", async () => {
    const lock = await pool.connect();
    const queuedAdmin = await actor("admin", {}, null);
    let pending: ReturnType<typeof request> | undefined;
    try {
      await lock.query("BEGIN");
      await lock.query("SELECT pg_advisory_xact_lock($1,914358)", [tenant]);
      pending = request(queuedAdmin, `/team-access/${rep}/sales-access`, "PUT", { visibility: "all" });
      let waiting = false;
      for (let attempt = 0; attempt < 100 && !waiting; attempt++) {
        waiting = (await pool.query(`SELECT 1 FROM pg_locks WHERE locktype='advisory'
          AND classid=$1 AND objid=914358 AND NOT granted`, [tenant])).rowCount! > 0;
        if (!waiting) await new Promise(r => setTimeout(r, 10));
      }
      expect(waiting).toBe(true);
      await lock.query("UPDATE users SET role='viewer' WHERE tenant_id=$1 AND id=$2", [tenant, queuedAdmin]);
      await lock.query("COMMIT");
      expect((await pending).status).toBe(403);
      expect((await pool.query("SELECT 1 FROM sales_access_audit WHERE tenant_id=$1 AND actor_id=$2", [tenant, queuedAdmin])).rowCount).toBe(0);
    } finally { await lock.query("ROLLBACK"); lock.release(); if (pending) await pending; }
    const before = new Date();
    const held = await pool.connect();
    let successful: ReturnType<typeof request> | undefined;
    let releasedAt = before;
    try {
      await held.query("BEGIN");
      await held.query("SELECT pg_advisory_xact_lock($1,914358)", [tenant]);
      successful = request(admin, `/team-access/${rep}/sales-access`, "PUT", { visibility: "owned" });
      let waiting = false;
      for (let attempt = 0; attempt < 100 && !waiting; attempt++) {
        waiting = (await pool.query(`SELECT 1 FROM pg_locks WHERE locktype='advisory'
          AND classid=$1 AND objid=914358 AND NOT granted`, [tenant])).rowCount! > 0;
        if (!waiting) await new Promise(r => setTimeout(r, 10));
      }
      expect(waiting).toBe(true);
      // Leave a measurable gap between the original request and its commit.
      await new Promise(r => setTimeout(r, 30));
      releasedAt = new Date();
      await held.query("COMMIT");
      expect((await successful).status).toBe(200);
    } finally { await held.query("ROLLBACK"); held.release(); if (successful) await successful; }
    const row = (await pool.query(`SELECT requested_at,recorded_at FROM sales_access_audit
      WHERE tenant_id=$1 AND target_id=$2 AND kind='visibility' ORDER BY id DESC LIMIT 1`, [tenant, rep])).rows[0];
    expect(row.requested_at.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(row.requested_at.getTime()).toBeLessThan(releasedAt.getTime());
    expect(row.recorded_at.getTime()).toBeGreaterThanOrEqual(releasedAt.getTime());
  });
  it("restricts tenant history to admins and validates bounded dates, actor, type and cursor", async () => {
    const path = "/team-access/sales-history?dateFrom=2002-01-01&dateTo=2002-01-31";
    expect((await request(-1, path)).status).toBe(401);
    const settingsManager = await actor("manager", { settings: "manage", sales: "manage" }, null);
    for (const user of [rep, marketing, none, settingsManager]) expect((await request(user, path)).status).toBe(403);
    for (const query of [
      "", "?dateFrom=2002-02-30&dateTo=2002-03-01", "?dateFrom=2002-01-02&dateTo=2002-01-01",
      "?dateFrom=2002-01-01&dateTo=2003-01-02", "?dateFrom=invalid&dateTo=2002-01-01",
      "?dateFrom=2002-01-01&dateTo=2002-01-01&actorId=0",
      "?dateFrom=2002-01-01&dateTo=2002-01-01&actorId=2147483648",
      "?dateFrom=2002-01-01&dateTo=2002-01-01&kind=password",
      "?dateFrom=2002-01-01&dateTo=2002-01-01&beforeId=1.5",
      "?dateFrom=2002-01-01&dateTo=2002-01-01&actorId=1&actorId=2",
      "?dateFrom=0000-01-01&dateTo=0000-01-02",
    ]) expect((await request(admin, `/team-access/sales-history${query}`)).status, query).toBe(400);
    expect((await request(admin, "/team-access/sales-history?dateFrom=2000-01-01&dateTo=2000-12-31")).status).toBe(200);
  });
  it("filters inclusive recorded UTC days and pages only this tenant without gaps under new inserts", async () => {
    const inserted: number[] = [];
    const insert = async (tid: number, actorId: number, targetId: number, kind: "owners" | "visibility", recorded: string, outcome = "changed") =>
      Number((await pool.query(`INSERT INTO sales_access_audit
        (tenant_id,actor_id,target_id,kind,before_value,after_value,requested_at,recorded_at,outcome)
        VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,'2001-12-31T23:00:00Z',$7,$8) RETURNING id`,
      [tid, actorId, targetId, kind, kind === "owners" ? "[]" : '"owned"',
        kind === "owners" ? JSON.stringify([rep]) : '"all"', recorded, outcome])).rows[0].id);
    for (let i = 0; i < 29; i++) inserted.push(await insert(tenant, i % 2 ? admin : marketing,
      i % 2 ? assignedAccount : rep, i % 2 ? "owners" : "visibility",
      i === 0 ? "2002-01-01T00:00:00Z" : "2002-01-31T23:59:59.999999Z",
      ["changed", "unchanged", "rejected"][i % 3]));
    await insert(tenant, admin, assignedAccount, "owners", "2002-02-01T00:00:00Z");
    await insert(foreignTenant, foreignUser, foreignAccount, "owners", "2002-01-15T00:00:00Z");
    const path = "/team-access/sales-history?dateFrom=2002-01-01&dateTo=2002-01-31";
    const first = await request(admin, path);
    expect(first.status).toBe(200); expect(first.body.items).toHaveLength(25);
    const newest = await insert(tenant, admin, assignedAccount, "owners", "2002-01-15T00:00:00Z");
    const second = (await request(admin, `${path}&beforeId=${first.body.nextBeforeId}`)).body;
    expect(second.items).toHaveLength(4); expect(second.nextBeforeId).toBeNull();
    expect([...first.body.items, ...second.items].map((e: any) => e.id)).toEqual([...inserted].reverse());
    const filtered = (await request(admin, `${path}&actorId=${admin}&kind=owners`)).body;
    expect(filtered.items.map((e: any) => e.id)).toEqual([newest, ...inserted.filter((_, i) => i % 2).reverse()]);
    expect(filtered.items.every((e: any) => e.kind === "owners" && e.actorId === admin)).toBe(true);
    expect(filtered.items[0].target).toBe("B Assigned owned");
    expect(new Set(first.body.items.map((e: any) => e.outcome))).toEqual(new Set(["changed", "unchanged", "rejected"]));
    expect((await request(admin, `${path}&actorId=${foreignUser}`)).body.items).toEqual([]);
    expect((await request(admin, `${path}&beforeId=1`)).body).toEqual({ items: [], nextBeforeId: null });
  });
  it("pages without gaps and retains immutable nonpersonal tombstones after user and account deletion", async () => {
    const deletedActor = await actor("admin", {}, null);
    const deletedOwner = await actor("viewer", { sales: "view" }, null);
    const deletedAccount = Number((await pool.query("INSERT INTO companies(tenant_id,client_id,name) VALUES($1,$2,'Audit deletion fixture') RETURNING id",
      [tenant, client])).rows[0].id);
    expect((await request(deletedActor, `/sales/accounts/${deletedAccount}/owners`, "PUT", { userIds: [deletedOwner] })).status).toBe(200);
    for (let i = 0; i < 27; i++) expect((await request(deletedActor, `/team-access/${deletedOwner}/sales-access`, "PUT", { visibility: i % 2 ? "all" : "owned" })).status).toBe(200);
    await pool.query("DELETE FROM users WHERE tenant_id=$1 AND id=ANY($2::int[])", [tenant, [deletedActor, deletedOwner]]);
    await pool.query("DELETE FROM companies WHERE tenant_id=$1 AND id=$2", [tenant, deletedAccount]);
    const first = (await request(admin, `/team-access/${deletedOwner}/sales-access/history`)).body;
    const second = (await request(admin, `/team-access/${deletedOwner}/sales-access/history?beforeId=${first.nextBeforeId}`)).body;
    expect(first.items).toHaveLength(25); expect(second.items).toHaveLength(2); expect(second.nextBeforeId).toBeNull();
    expect(new Set([...first.items, ...second.items].map((r: any) => r.id)).size).toBe(27);
    expect(first.target).toBe(`Deleted user #${deletedOwner}`);
    expect(first.items[0].actor).toBe(`Deleted user #${deletedActor}`);
    const ownerHistory = (await request(admin, `/sales/accounts/${deletedAccount}/owner-history`)).body;
    expect(ownerHistory.target).toBe(`Deleted account #${deletedAccount}`);
    expect(ownerHistory.items[0].after).toEqual([`Deleted user #${deletedOwner}`]);
    const day = new Date().toISOString().slice(0, 10);
    const tenantPath = `/team-access/sales-history?dateFrom=${day}&dateTo=${day}&actorId=${deletedActor}`;
    const tenantPage = (await request(admin, `${tenantPath}&kind=visibility`)).body;
    expect(tenantPage.items).toHaveLength(25);
    expect(tenantPage.items.every((r: any) => r.target === `Deleted user #${deletedOwner}`
      && r.actor === `Deleted user #${deletedActor}`)).toBe(true);
    const tenantOlder = (await request(admin, `${tenantPath}&kind=visibility&beforeId=${tenantPage.nextBeforeId}`)).body;
    expect(tenantOlder.items).toHaveLength(2);
    const deletedAccountHistory = (await request(admin, `${tenantPath}&kind=owners`)).body;
    expect(deletedAccountHistory.items[0].target).toBe(`Deleted account #${deletedAccount}`);
    expect(deletedAccountHistory.items[0].after).toEqual([`Deleted user #${deletedOwner}`]);
    expect(JSON.stringify(deletedAccountHistory)).not.toMatch(/password|email|Fixture|invalid/i);
    const auditId = first.items[0].id;
    await expect(pool.query("UPDATE sales_access_audit SET outcome='changed' WHERE id=$1", [auditId])).rejects.toThrow("append-only");
    await expect(pool.query("DELETE FROM sales_access_audit WHERE id=$1", [auditId])).rejects.toThrow("append-only");
    const connection = await pool.connect();
    try {
      await connection.query("BEGIN");
      await expect(connection.query("TRUNCATE sales_access_audit")).rejects.toThrow("append-only");
    } finally { await connection.query("ROLLBACK"); connection.release(); }
  });
});
