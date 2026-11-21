import express from "express";
import request from "supertest";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

let client: PoolClient;
const tenantId = 910777;
vi.mock("@workspace/db", () => ({
  pool: {
    query: (...args: Parameters<PoolClient["query"]>) => client.query(...args),
  },
}));
vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { id: 1, tenantId, role: "admin" };
    next();
  },
}));

import router from "../routes/accountsAnalytics";

const app = express().use(router).use((error: Error, _req: any, res: any, _next: any) =>
  res.status(500).json({ error: error.message }));
const suite = describe.skipIf(!process.env.DATABASE_URL);

suite("analytics account Traffic filters", () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  beforeAll(async () => {
    client = await pool.connect();
    await client.query("BEGIN");
    await client.query(`
      CREATE TEMP TABLE clients(id int,tenant_id int,name text) ON COMMIT DROP;
      CREATE TEMP TABLE companies(id int,tenant_id int,client_id int,name text,inbound_manual boolean,inbound_manual_at timestamptz) ON COMMIT DROP;
      CREATE TEMP TABLE contacts(
        id int,tenant_id int,company_id int,first_name text,last_name text,
        lead_score float8,stage text,last_activity timestamptz
      ) ON COMMIT DROP;
      CREATE TEMP TABLE activity_events(
        id int,tenant_id int,company_id int,contact_id int,visitor_token text,
        journey_id int,client_id int,created_at timestamptz,is_bot boolean,event_type text,
        description text,score_delta float8,contact_name text,page_name text,stage text
      ) ON COMMIT DROP;
      CREATE TEMP TABLE journey_events(
        id int,tenant_id int,visitor_token text,journey_id int,created_at timestamptz,
        event_type text,is_bot boolean,page_id int
      ) ON COMMIT DROP;
      CREATE TEMP TABLE verified_journey_sessions(
        id int,tenant_id int,account_id int,event_ids int[],activity_event_ids int[],revoked_at timestamptz
      ) ON COMMIT DROP;
      CREATE TEMP TABLE visitor_tokens(tenant_id int,token text,contact_id int) ON COMMIT DROP;
      CREATE TEMP TABLE form_submissions(tenant_id int,visitor_token text,contact_id int,submitted_at timestamptz) ON COMMIT DROP;
      CREATE TEMP TABLE journeys(id int,tenant_id int,client_id int,name text) ON COMMIT DROP;
      CREATE TEMP TABLE journey_pages(id int,journey_id int,title text) ON COMMIT DROP;
       CREATE TEMP TABLE intent_inbound_submissions(id int,tenant_id int,account_id int,classification text,updated_at timestamptz,client_id int,source_id int,raw_fields jsonb,created_at timestamptz,contact_id int,routing_status text,routed_rule_id int,routed_at timestamptz) ON COMMIT DROP;
       CREATE TEMP TABLE intent_inbound_manual_routes(tenant_id int,submission_id int,journey_id int) ON COMMIT DROP;
       CREATE TEMP TABLE intent_inbound_routing_rules(id int,tenant_id int,journey_id int) ON COMMIT DROP;
      CREATE TEMP TABLE intent_entity_scores(tenant_id int,account_id int,score float8) ON COMMIT DROP;
      CREATE TEMP TABLE abm_plays(id int,tenant_id int,client_id int) ON COMMIT DROP;
      CREATE TEMP TABLE journey_plays(journey_id int,play_id int) ON COMMIT DROP;

      INSERT INTO clients VALUES (10,${tenantId},'Acme');
      INSERT INTO companies VALUES
        (100,${tenantId},10,'Alpha',false,NULL),(101,${tenantId},10,'Beta',true,NULL),(102,${tenantId},10,'Quiet',false,NULL),
        (900,999999,10,'Other tenant',true,NULL);
      INSERT INTO contacts VALUES
        (1000,${tenantId},100,'A','One',80,'aware','2026-09-04T00:00:00Z'),
        (1001,${tenantId},101,'B','Two',20,'action','2026-09-05T00:00:00Z');
      INSERT INTO contacts
      SELECT 1100 + contact_num,${tenantId},100,'Extra','Contact',1,'aware',NULL
      FROM generate_series(1,205) AS contact_num;
      INSERT INTO journeys VALUES (70,${tenantId},10,'Alpha Journey'),(80,${tenantId},10,'Beta Journey');
      INSERT INTO activity_events VALUES
        (700,${tenantId},100,1000,'v1',70,10,'2026-09-04T09:00:00Z',false,'page_view','Alpha event',4,'A One','Start','aware'),
        (800,${tenantId},101,1001,'v2',80,10,'2026-09-05T09:00:00Z',false,'form_submit','Beta event',2,'B Two','Finish','action');
       INSERT INTO intent_inbound_submissions VALUES
         (1,${tenantId},101,'warm','2026-09-05T10:00:00Z',10,NULL,'{}','2026-09-05T10:00:00Z',1001,'routed',null,'2026-09-05T10:00:00Z');
       ALTER TABLE intent_inbound_submissions ADD COLUMN form_type text DEFAULT 'lead_form';
       INSERT INTO intent_inbound_manual_routes VALUES (${tenantId},1,80);
      INSERT INTO abm_plays VALUES (500,${tenantId},10);
      INSERT INTO journey_plays VALUES (70,500);
    `);
  });
  afterAll(async () => {
    if (client) { await client.query("ROLLBACK"); client.release(); }
    await pool.end();
  });

  it("scopes a selected account and returns zero for an empty inbound cohort", async () => {
    const selected = await request(app).get("/analytics/accounts?clientId=10&companyId=100");
    expect(selected.status).toBe(200);
    expect(selected.body.items.map((item: any) => item.id)).toEqual([100]);
    const emptyInbound = await request(app).get("/analytics/accounts?clientId=10&inboundOnly=1&dateFrom=2026-09-10&dateTo=2026-09-10").expect(200);
    expect(emptyInbound.body.items).toEqual([]);
    await request(app).get("/analytics/accounts?clientId=10&companyIds=999").expect(400);
    await request(app).get("/analytics/accounts?companyId=900").expect(400);
  });

  it("filters list activity by date, journey, stage, score, and tenant-owned play linkage", async () => {
    const result = await request(app).get(
      "/analytics/accounts?clientId=10&dateFrom=2026-09-04&dateTo=2026-09-04&journeyId=70&stage=aware&scoreMin=70&playId=500",
    );
    expect(result.status).toBe(200);
    expect(result.body.items.map((item: any) => item.id)).toEqual([100]);
    expect(result.body.items[0].eventCount).toBeGreaterThan(0);
    const excluded = await request(app).get("/analytics/accounts?clientId=10&journeyId=80&stage=aware").expect(200);
    expect(excluded.body.items).toEqual([]);
    await request(app).get("/analytics/accounts?playId=999").expect(400);
  });

  it("keeps account detail and activity within the exact selected event filters", async () => {
    const detail = await request(app).get(
      "/analytics/accounts/100?dateFrom=2026-09-04&dateTo=2026-09-04&journeyId=70&stage=aware&scoreMin=70",
    ).expect(200);
    expect(detail.body.account.id).toBe(100);
    expect(detail.body.journeys.map((journey: any) => journey.id)).toEqual([70]);
    expect(detail.body.contacts.map((contact: any) => contact.id)).toEqual([1000]);
    const activity = await request(app).get(
      "/analytics/accounts/100/activity?dateFrom=2026-09-04&dateTo=2026-09-04&journeyId=70&stage=aware&scoreMin=70",
    ).expect(200);
    expect(activity.body.items.map((item: any) => item.sourceId)).toEqual([700]);
    await request(app).get("/analytics/accounts/100/activity?journeyId=80").expect(404);
    await request(app).get("/analytics/accounts/100/activity?companyId=101").expect(404);
  });

  it("reports the full contact count when detail contacts are capped at 200", async () => {
    const detail = await request(app).get("/analytics/accounts/100").expect(200);
    expect(detail.body.contacts).toHaveLength(200);
    expect(detail.body.contactCount).toBe(206);
  });

  it("puts a linked event respondent with a zero-score journey view first without marking other CRM contacts", async () => {
    await client.query("SAVEPOINT overlap_test");
    try {
      await client.query(`INSERT INTO activity_events VALUES
        (701,$1,100,1101,'v3',70,10,'2026-09-04T09:10:00Z',false,'page_view','Zero-score journey view',0,'Extra Contact','Start','aware')`, [tenantId]);
      await client.query(`INSERT INTO intent_inbound_submissions (id,tenant_id,account_id,classification,updated_at,client_id,source_id,raw_fields,created_at,contact_id,routing_status,form_type)
        VALUES (2,$1,100,'hot','2026-09-04T10:00:00Z',10,5,'{}','2026-09-04T10:00:00Z',1101,'pending','event_feedback')`, [tenantId]);
      const detail = await request(app).get("/analytics/accounts/100").expect(200);
      expect(detail.body.contacts[0]).toMatchObject({
        id: 1101, leadForm: false, eventFeedback: true, journey: true,
        gtmStatus: { status: "hot" }, leadScore: 1,
      });
      expect(detail.body.contacts.find((contact: any) => contact.id === 1000)).toMatchObject({
        leadForm: false, eventFeedback: false, journey: true, gtmStatus: null,
      });
      expect(detail.body.contacts.find((contact: any) => contact.id === 1102)).toMatchObject({
        leadForm: false, eventFeedback: false, journey: false, gtmStatus: null,
      });
    } finally {
      await client.query("ROLLBACK TO SAVEPOINT overlap_test");
      await client.query("RELEASE SAVEPOINT overlap_test");
    }
  });

  it("filters qualification before paging and shows a matching journey and key contact", async () => {
    const warm = await request(app).get("/analytics/accounts?status=warm&limit=1").expect(200);
    expect(warm.body.items.map((item: any) => item.id)).toEqual([101]);
    expect(warm.body.items[0]).toMatchObject({ journeyName: "Beta Journey", keyContactName: "B Two" });
    expect(warm.body.hasMore).toBe(false);
    const uncategorized = await request(app).get("/analytics/accounts?status=uncategorized&limit=1").expect(200);
    expect(uncategorized.body.items.map((item: any) => item.id)).toEqual([100]);
    expect(uncategorized.body.hasMore).toBe(true);
    const selected = await request(app).get("/analytics/accounts/101?status=warm").expect(200);
    expect(selected.body.account.keyContactName).toBe("B Two");
    await request(app).get("/analytics/accounts/101?status=hot").expect(404);
    await request(app).get("/analytics/accounts/101/activity?status=uncategorized").expect(404);
    await request(app).get("/analytics/accounts?status=very-hot").expect(400);
  });

  it("shows a routed journey even before the account has viewed it", async () => {
    await client.query("SAVEPOINT route_preview");
    try {
      await client.query(`INSERT INTO intent_inbound_submissions VALUES
        (2,${tenantId},102,'cold','2026-09-06T10:00:00Z',10,NULL,'{}','2026-09-06T10:00:00Z',NULL,'routed',50,'2026-09-06T10:00:00Z')`);
      await client.query(`INSERT INTO intent_inbound_routing_rules VALUES (50,${tenantId},70)`);
      const response = await request(app).get("/analytics/accounts?companyId=102&status=cold").expect(200);
      expect(response.body.items[0]).toMatchObject({ journeyName: "Alpha Journey", keyContactName: null });
    } finally {
      await client.query("ROLLBACK TO SAVEPOINT route_preview");
    }
  });
});