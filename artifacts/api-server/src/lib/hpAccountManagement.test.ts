import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import type { Server } from "node:http";
import { pool } from "@workspace/db";
import hpRouter from "../routes/hpBi";
import { contactRoutingMemberships } from "./contactRoutingMemberships";
import { cleanHpCrmTenant, seedHpCrmAccounts } from "./testFixtures/hpCrm";

describe("HP account management uses owned contacts and production mutation guards", () => {
  let tenantId: number, clientId: number, otherClient: number, companyId: number, contactId: number,
    siblingId: number, siblingContact: number, journeyId: number, foreignJourney: number, sequenceId: number, foreignSequence: number;
  let url: string, server: Server;
  const base = () => ({ clientId, accountId: companyId, contactId });
  const post = (fields: Record<string, unknown>, role = "admin") => fetch(url, {
    method: "POST", headers: { "Content-Type": "application/json", "x-test-role": role }, body: JSON.stringify({ ...base(), ...fields }),
  });
  const get = (account = companyId, person = contactId) => fetch(`${url}?clientId=${clientId}&accountId=${account}&contactId=${person}`);
  const data = async () => (await (await get()).json()) as {
    journeys: { id: number; removable: boolean; addedVia: string }[];
    enrollments: { id: number; status: string }[];
  };
  beforeAll(async () => {
    tenantId = Number((await pool.query("INSERT INTO tenants(name,slug) VALUES('HP management fixture',$1) RETURNING id",
      [`hp-manage-${Date.now()}`])).rows[0].id);
    clientId = Number((await pool.query("INSERT INTO clients(tenant_id,name) VALUES($1,'HP') RETURNING id", [tenantId])).rows[0].id);
    otherClient = Number((await pool.query("INSERT INTO clients(tenant_id,name) VALUES($1,'Other') RETURNING id", [tenantId])).rows[0].id);
    ({ companyId, contactId, siblingId, siblingContact } = await seedHpCrmAccounts(tenantId, clientId));
    await pool.query(`INSERT INTO intent_inbound_submissions
      (tenant_id,client_id,account_id,contact_id,drive_file_id,row_key,file_name,form_type,classification,
       classification_reason,product_interest,purchase_timeframe_months,submitted_at,raw_fields)
      VALUES($1,$2,$3,$4,'management-warm','management-warm','fixture.xlsx','event_feedback','warm',
        'Warm-only nurture fixture','HP Security Services',6,NOW(),'{}')`,[tenantId,clientId,companyId,contactId]);
    for (const [client, suffix] of [[clientId, "hp"], [otherClient, "other"]]) {
      const play = Number((await pool.query("INSERT INTO abm_plays(tenant_id,client_id,name) VALUES($1,$2,$3) RETURNING id",
        [tenantId, client, `${suffix} play`])).rows[0].id);
      const j = Number((await pool.query("INSERT INTO journeys(tenant_id,client_id,name,slug,status) VALUES($1,$2,$3,$4,'published') RETURNING id",
        [tenantId, client, `${suffix} journey`, `manage-${tenantId}-${suffix}`])).rows[0].id);
      // No email steps: enrollment tests cannot deliver a message or enqueue a job.
      const seq = Number((await pool.query("INSERT INTO email_sequences(tenant_id,name,play_id,status) VALUES($1,$2,$3,'active') RETURNING id",
        [tenantId, `${suffix} sequence`, play])).rows[0].id);
      if (client === clientId) { journeyId = j; sequenceId = seq; } else { foreignJourney = j; foreignSequence = seq; }
    }
    await pool.query("UPDATE contacts SET intent_score=77 WHERE id=$1", [contactId]);
    const app = express(); app.use(express.json());
    app.use((req: any, _res, next) => {
      req.isAuthenticated = () => true; req.user = { tenantId, role: req.headers["x-test-role"] || "admin",
        ...(req.headers["x-test-permissions"] ? { sectionPermissions: JSON.parse(String(req.headers["x-test-permissions"])) } : {}) };
      req.log = { warn() {} }; next();
    });
    app.use(hpRouter);
    app.use((err: any, _req: any, res: any, _next: any) => res.status(500).json({ error: err.message }));
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>(resolve => server.once("listening", resolve));
    url = `http://127.0.0.1:${(server.address() as any).port}/analytics/hp-bi/manage-account`;
  });
  afterAll(async () => {
    if (server) await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
    if (!tenantId) return;
    await pool.query("DELETE FROM sequence_enrollments WHERE sequence_id IN(SELECT id FROM email_sequences WHERE tenant_id=$1)", [tenantId]);
    await pool.query("DELETE FROM email_sequences WHERE tenant_id=$1", [tenantId]);
    await pool.query("DELETE FROM journey_contacts WHERE journey_id IN(SELECT id FROM journeys WHERE tenant_id=$1)", [tenantId]);
    await pool.query("DELETE FROM journey_companies WHERE journey_id IN(SELECT id FROM journeys WHERE tenant_id=$1)", [tenantId]);
    await pool.query("DELETE FROM journeys WHERE tenant_id=$1", [tenantId]);
    await pool.query("DELETE FROM abm_plays WHERE tenant_id=$1", [tenantId]);
    await cleanHpCrmTenant(tenantId);
  });
  it("returns HP-only options and rejects the wrong member contact", async () => {
    const r = await get(); expect(r.status).toBe(200);
    const data = await r.json() as { journeyOptions: { id: number }[]; sequenceOptions: { id: number }[] };
    expect(data.journeyOptions.map((j: any) => j.id)).toEqual([journeyId]);
    expect(data.sequenceOptions.map((s: any) => s.id)).toEqual([sequenceId]);
    expect((await get(companyId, siblingContact)).status).toBe(404);
    expect((await get(siblingId, siblingContact)).status).toBe(200);
  });
  it("edits contact details without accepting score or ownership changes, and blocks viewers", async () => {
    expect((await post({ action: "update-contact", values: { title: "Director", city: null, intentScore: 0, companyId: siblingId } }, "viewer")).status).toBe(403);
    const r = await post({ action: "update-contact", values: { title: "Director", city: null, intentScore: 0, companyId: siblingId } });
    expect(r.status).toBe(200);
    const person = (await pool.query("SELECT title,city,company_id,intent_score FROM contacts WHERE id=$1", [contactId])).rows[0];
    expect(person.title).toBe("Director"); expect(person.city).toBeNull();
    expect(person.company_id).toBe(companyId); expect(Number(person.intent_score)).toBe(77);
  });
  it("adds and removes only HP manual journey assignments; inherited memberships remain", async () => {
    expect((await post({ action: "add-journey", journeyId: foreignJourney })).status).toBe(400);
    const added = await post({ action: "add-journey", journeyId }); expect(added.status).toBe(200);
    expect(await added.json()).toMatchObject({ added: 1 });
    expect((await data()).journeys[0]).toMatchObject({ id: journeyId, removable: true });
    expect((await post({ action: "remove-journey", journeyId })).status).toBe(204);
    await pool.query("INSERT INTO journey_companies(journey_id,company_id) VALUES($1,$2)", [journeyId, companyId]);
    expect((await data()).journeys[0]).toMatchObject({ addedVia: "company", removable: false });
    expect((await post({ action: "remove-journey", journeyId })).status).toBe(409);
  });
  it("retains DNC and duplicate guards, cancels only the owned active enrollment and keeps its history", async () => {
    expect((await post({ action: "enroll-sequence", sequenceId: foreignSequence })).status).toBe(400);
    await pool.query("UPDATE contacts SET dnc=true WHERE id=$1", [contactId]);
    expect((await post({ action: "enroll-sequence", sequenceId })).status).toBe(409);
    expect((await post({ action: "add-journey", journeyId })).status).toBe(409);
    await pool.query("UPDATE contacts SET dnc=false WHERE id=$1", [contactId]);
    const first = await post({ action: "enroll-sequence", sequenceId }); expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ enrolled: 1 });
    expect(await (await post({ action: "enroll-sequence", sequenceId })).json()).toMatchObject({ enrolled: 0, alreadyActive: 1 });
    const history = (await data()).enrollments;
    expect(history).toHaveLength(1);
    expect((await post({ action: "cancel-sequence", accountId: siblingId, contactId: siblingContact, enrollmentId: history[0].id })).status).toBe(409);
    expect((await post({ action: "cancel-sequence", enrollmentId: history[0].id })).status).toBe(200);
    expect((await data()).enrollments[0]).toMatchObject({ id: history[0].id, status: "cancelled" });
    expect((await post({ action: "cancel-sequence", enrollmentId: history[0].id })).status).toBe(409);
  });
  it("links an opportunity idempotently without replacing its primary contact or value", async () => {
    const primary = Number((await pool.query(`INSERT INTO contacts(tenant_id,client_id,company_id,first_name,email)
      VALUES($1,$2,$3,'Primary stakeholder',$4) RETURNING id`,
    [tenantId, clientId, companyId, `primary-${tenantId}@example.test`])).rows[0].id);
    const deal = Number((await pool.query(`INSERT INTO deals(tenant_id,client_id,company_id,contact_id,title,value)
      VALUES($1,$2,$3,$4,'Owned opportunity',12000) RETURNING id`, [tenantId, clientId, companyId, primary])).rows[0].id);
    const wrongAccount = Number((await pool.query(`INSERT INTO deals(tenant_id,client_id,company_id,title)
      VALUES($1,$2,$3,'Other account opportunity') RETURNING id`, [tenantId, clientId, siblingId])).rows[0].id);
    expect((await post({ action: "link-opportunity", dealId: wrongAccount })).status).toBe(404);
    expect(await (await post({ action: "link-opportunity", dealId: deal })).json()).toMatchObject({ linked: true, added: true });
    expect(await (await post({ action: "link-opportunity", dealId: deal })).json()).toMatchObject({ linked: true, added: false });
    expect((await pool.query("SELECT contact_id,value FROM deals WHERE id=$1", [deal])).rows[0])
      .toMatchObject({ contact_id: primary, value: "12000.00" });
    expect(Number((await pool.query("SELECT count(*) FROM deal_audit WHERE deal_id=$1 AND action='contact_linked'", [deal])).rows[0].count)).toBe(1);
    const memberships = await contactRoutingMemberships(tenantId, [contactId, primary, siblingContact]);
    expect(memberships.opportunities.filter(o => o.id === deal)).toEqual(expect.arrayContaining([
      expect.objectContaining({ contactId, isPrimary: false }),
      expect.objectContaining({ contactId: primary, isPrimary: true }),
    ]));
    expect(memberships.opportunities.some(o => o.contactId === siblingContact && o.id === deal)).toBe(false);
    expect((await contactRoutingMemberships(tenantId + 1000000, [contactId])).opportunities).toHaveLength(0);
  });
  it("does not turn Analytics manage rights into outreach or opportunity rights", async () => {
    for (const fields of [{ action: "add-journey", journeyId }, { action: "enroll-sequence", sequenceId }, { action: "link-opportunity", dealId: 1 }]) {
      const response = await fetch(url, { method: "POST", headers: {
        "Content-Type": "application/json", "x-test-role": "editor",
        "x-test-permissions": JSON.stringify({ analytics: "manage", journeys: "view", sequences: "view", deals: "view" }),
      }, body: JSON.stringify({ ...base(), ...fields }) });
      expect(response.status).toBe(403);
    }
  });
  it("rejects unpublished journeys and active sequences without published steps in bulk routing", async () => {
    await pool.query("UPDATE journeys SET status='draft' WHERE id=$1",[journeyId]);
    try { expect((await post({action:"add-journey",journeyId})).status).toBe(409); }
    finally { await pool.query("UPDATE journeys SET status='published' WHERE id=$1",[journeyId]); }
    expect((await post({action:"enroll-sequence",accountId:siblingId,contactId:siblingContact,journeyId,sequenceId})).status).toBe(409);
  });
  it("blocks reviewed identity conflicts and rejected products at the manual write boundary", async () => {
    const key=`manage-guard-${Date.now()}`;
    const id=Number((await pool.query(`INSERT INTO intent_inbound_submissions
      (tenant_id,client_id,account_id,contact_id,drive_file_id,row_key,file_name,form_type,classification,classification_reason,affinity_reviews)
      VALUES($1,$2,$3,$4,$5,$5,'Guard fixture','event_feedback','cold','fixture','{"HP Security":"rejected"}') RETURNING id`,
    [tenantId,clientId,companyId,contactId,key])).rows[0].id);
    try {
      expect((await post({action:"add-journey",journeyId,product:"HP Security"})).status).toBe(409);
      expect((await post({action:"add-journey",journeyId})).status).toBe(409);
      await pool.query("UPDATE intent_inbound_submissions SET identity_review='keep',affinity_reviews='{}' WHERE id=$1",[id]);
      expect((await post({action:"enroll-sequence",sequenceId,product:"HP Device as a Service"})).status).toBe(409);
    } finally { await pool.query("DELETE FROM intent_inbound_submissions WHERE id=$1",[id]); }
  });
});
