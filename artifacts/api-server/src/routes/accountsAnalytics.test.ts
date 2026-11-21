import express from "express";
import request from "supertest";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

let client: PoolClient;
let tenantId = 910101;
let queryTail: Promise<unknown> = Promise.resolve();
vi.mock("@workspace/db", () => ({
  pool: {
    query: (...args: Parameters<PoolClient["query"]>) => {
      const result = queryTail.then(() => client.query(...args));
      queryTail = result.then(() => undefined, () => undefined);
      return result;
    },
  },
}));
vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { id: 1, tenantId, role: "admin" };
    next();
  },
}));

import router from "./accountsAnalytics";

const app = express().use(router).use((error: Error, _req: any, res: any, _next: any) => {
  res.status(500).json({ error: error.message });
});
const suite = describe.skipIf(!process.env.DATABASE_URL);

suite("analytics accounts endpoints with PostgreSQL", () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  beforeAll(async () => {
    client = await pool.connect();
    await client.query("BEGIN");
    await client.query(`
      CREATE TEMP TABLE clients (id int, tenant_id int, name text) ON COMMIT DROP;
      CREATE TEMP TABLE companies (
        id int, tenant_id int, client_id int, name text,
        inbound_manual_at timestamptz, created_at timestamptz
      ) ON COMMIT DROP;
      CREATE TEMP TABLE contacts (
        id int, tenant_id int, company_id int, first_name text, last_name text,
        lead_score int, stage text, last_activity timestamptz
      ) ON COMMIT DROP;
      CREATE TEMP TABLE journeys (id int, tenant_id int, client_id int, name text) ON COMMIT DROP;
      CREATE TEMP TABLE journey_pages (id int, journey_id int, title text) ON COMMIT DROP;
      CREATE TEMP TABLE journey_events (
        id int, tenant_id int, journey_id int, page_id int, event_type text,
        visitor_token text, created_at timestamptz, is_bot boolean
      ) ON COMMIT DROP;
      CREATE TEMP TABLE activity_events (
        id int, tenant_id int, company_id int, contact_id int, contact_name text,
        event_type text, description text, created_at timestamptz, score_delta int,
        journey_id int, page_name text, stage text, visitor_token text, is_bot boolean
      ) ON COMMIT DROP;
      CREATE TEMP TABLE form_submissions (
        tenant_id int, visitor_token text, contact_id int, submitted_at timestamptz
      ) ON COMMIT DROP;
      CREATE TEMP TABLE intent_entity_scores (
        tenant_id int, account_id int, contact_id int, score int
      ) ON COMMIT DROP;
      CREATE TEMP TABLE intent_inbound_submissions (
        id int, tenant_id int, account_id int, classification text, updated_at timestamptz,
        source_id int, client_id int, raw_fields jsonb, created_at timestamptz,
        contact_id int, routing_status text, routed_rule_id int, routed_at timestamptz,
        form_type text
      ) ON COMMIT DROP;
      CREATE TEMP TABLE intent_inbound_manual_routes (
        tenant_id int, submission_id int, journey_id int
      ) ON COMMIT DROP;
      CREATE TEMP TABLE intent_inbound_routing_rules (
        id int, tenant_id int, journey_id int
      ) ON COMMIT DROP;
      CREATE TEMP TABLE verified_journey_sessions (
        id int, tenant_id int, account_id int, event_ids int[],
        activity_event_ids int[], revoked_at timestamptz
      ) ON COMMIT DROP;
      CREATE TEMP TABLE visitor_tokens (tenant_id int, token text, contact_id int) ON COMMIT DROP;

      INSERT INTO clients VALUES (1,910101,'Client One'),(1,910102,'Other Client');
      INSERT INTO companies(id,tenant_id,client_id,name,inbound_manual_at,created_at) VALUES
        (10,910101,1,'Active Account',NULL,'2026-01-01'),
        (11,910101,1,'Empty Account',NULL,'2026-01-01'),
        (20,910101,1,'Linked Contact Account',NULL,'2026-01-01'),
        (21,910101,1,'Reviewed Account','2026-06-01','2026-06-01'),
        (90,910102,1,'Other Tenant Account',NULL,'2026-01-01');
      INSERT INTO contacts VALUES
        (1,910101,10,'Ada','One',30,'aware','2026-07-01T00:00:00Z'),
        (2,910101,10,'Ben','Two',12,'consideration','2026-07-02T00:00:00Z'),
        (3,910101,20,'Cy','Three',8,'aware',NULL);
      INSERT INTO journeys VALUES
        (5,910101,1,'Journey Five'),(6,910102,1,'Private Journey'),(7,910101,1,'Reviewed Journey');
      INSERT INTO journey_pages VALUES (501,5,'Landing'),(502,7,'Reviewed page');
      INSERT INTO activity_events VALUES
        (100,910101,10,1,'Ada One','page_view','Page viewed','2026-07-03T00:00:00Z',2,5,'Landing','aware',NULL,false),
        (101,910101,10,3,'Cy Three','form_submit','Submitted','2026-07-04T00:00:00Z',4,5,'Form','consideration',NULL,false),
        (102,910101,NULL,1,'Ada One','click','Clicked','2026-07-05T00:00:00Z',1,5,'CTA','aware',NULL,false),
        (103,910101,10,1,'Ada One','page_view','Reviewed link','2026-07-06T00:00:00Z',3,7,'Reviewed','aware',NULL,false),
        (104,910101,10,1,'Ada One','page_view','Verified link','2026-07-07T00:00:00Z',5,5,'Verified','aware',NULL,false),
        (105,910101,10,1,'Ada One','page_view','Bot activity','2026-07-09T00:00:00Z',100,5,'Bot','aware',NULL,true),
        (190,910102,90,NULL,NULL,'page_view','Other tenant event','2026-07-08T00:00:00Z',100,6,'Private',NULL,NULL,false);
      INSERT INTO journey_events VALUES
        (201,910101,7,502,'page_view','manual-visit','2026-07-06T02:00:00Z',false),
        (202,910101,5,501,'page_view',NULL,'2026-07-08T00:00:00Z',false),
        (203,910101,5,501,'page_view','duplicate-page','2026-07-03T00:01:00Z',false),
        (204,910101,5,501,'page_view','bot-visit','2026-07-10T00:00:00Z',true),
        (290,910102,6,501,'page_view',NULL,'2026-07-11T00:00:00Z',false);
      INSERT INTO visitor_tokens VALUES
        (910101,'manual-visit',1),(910101,'duplicate-page',1),(910101,'bot-visit',1);
      INSERT INTO intent_entity_scores VALUES (910101,10,NULL,64),(910101,NULL,1,99);
      INSERT INTO intent_inbound_submissions
        (id,tenant_id,account_id,classification,updated_at,source_id,client_id,raw_fields,created_at) VALUES
        (1,910101,10,'cold','2026-07-01T00:00:00Z',1,1,'{}','2026-07-01T00:00:00Z'),
        (2,910101,10,'warm','2026-07-02T00:00:00Z',2,1,'{}','2026-07-02T00:00:00Z'),
        (3,910101,21,'cold','2026-07-02T00:00:00Z',NULL,1,
          '{"manualProvenance":"manual","trackedContact":{"contactId":"1","journeyId":"7","effectiveFrom":"2026-07-01T00:00:00Z"}}',
          '2026-07-02T00:00:00Z');
      INSERT INTO verified_journey_sessions VALUES (1,910101,20,'{202}','{104}',NULL);
    `);
    await client.query(`
      INSERT INTO contacts
      SELECT 1000 + n, 910101, 10, 'Bulk', n::text, 1, 'aware', NULL
      FROM generate_series(1, 203) n
    `);
  });

  afterAll(async () => {
    if (client) {
      await client.query("ROLLBACK");
      client.release();
    }
    await pool.end();
  });

  it("returns tenant-scoped, aggregate account pages and honors search/client pagination", async () => {
    const page = await request(app)
      .get("/analytics/accounts?clientId=1&q=account&page=1&limit=1");
    expect(page.status, JSON.stringify(page.body)).toBe(200);
    expect(page.body).toMatchObject({
      page: 1,
      hasMore: true,
      total: 4,
      items: [{
        id: 10,
        name: "Active Account",
        clientName: "Client One",
        contactCount: 205,
        activityScore: 245,
        intentScore: 64,
        gtmStatus: { status: "warm", updatedAt: "2026-07-02T00:00:00.000Z" },
        eventCount: 3,
        journeyCount: 1,
        lastActivity: "2026-07-05T00:00:00.000Z",
      }],
    });

    const second = await request(app)
      .get("/analytics/accounts?clientId=1&q=account&page=2&limit=1")
      .expect(200);
    expect(second.body).toMatchObject({
      page: 2,
      hasMore: true,
      total: 4,
      items: [{ id: 11, eventCount: 0, contactCount: 0 }],
    });
    const reviewed = await request(app).get("/analytics/accounts?q=Reviewed").expect(200);
    expect(reviewed.body.items).toMatchObject([{ id: 21, eventCount: 2, journeyCount: 1 }]);
    const verified = await request(app).get("/analytics/accounts?q=Linked").expect(200);
    expect(verified.body.items).toMatchObject([{ id: 20, eventCount: 2, journeyCount: 1 }]);

    tenantId = 910102;
    try {
      const isolated = await request(app).get("/analytics/accounts").expect(200);
      expect(isolated.body.items.map((account: any) => account.id)).toEqual([90]);
      expect(isolated.body.items[0].eventCount).toBe(1);
    } finally {
      tenantId = 910101;
    }
  });

  it("includes empty accounts and keeps GTM qualification distinct from score", async () => {
    const result = await request(app).get("/analytics/accounts?q=Empty").expect(200);
    expect(result.body).toMatchObject({
      hasMore: false,
      total: 1,
      items: [{
        id: 11,
        contactCount: 0,
        activityScore: 0,
        intentScore: null,
        gtmStatus: null,
        lastActivity: null,
        journeyCount: 0,
        eventCount: 0,
      }],
    });
  });

  it("bounds detail contacts at 200, reports the full count, and scopes detail/activity", async () => {
    const detail = await request(app).get("/analytics/accounts/10").expect(200);
    expect(detail.body.account).toMatchObject({ id: 10, contactCount: 205 });
    expect(detail.body.contactCount).toBe(205);
    expect(detail.body.contacts).toHaveLength(200);
    expect(detail.body.journeys).toEqual([{
      id: 5,
      name: "Journey Five",
      views: 1,
      lastActivity: "2026-07-05T00:00:00.000Z",
    }]);

    const activity = await request(app).get("/analytics/accounts/10/activity?limit=1").expect(200);
    expect(activity.body).toMatchObject({
      page: 1,
      hasMore: true,
      items: [{
        id: "activity_event:102",
        sourceType: "activity_event",
        sourceId: 102,
        contactId: 1,
        journeyName: "Journey Five",
        scoreDelta: 1,
      }],
    });
    const nextPage = await request(app).get("/analytics/accounts/10/activity?limit=1&page=2").expect(200);
    expect(nextPage.body.items[0].id).toBe("activity_event:101");
    const duplicateAndBots = await request(app).get("/analytics/accounts/10/activity?limit=50").expect(200);
    expect(duplicateAndBots.body.items.map((event: any) => event.id)).not.toContain("journey_event:203");
    expect(duplicateAndBots.body.items.map((event: any) => event.id)).not.toContain("journey_event:204");
    expect(duplicateAndBots.body.items.map((event: any) => event.id)).not.toContain("activity_event:105");

    const manuallyAssociated = await request(app)
      .get("/analytics/accounts/21/activity?limit=5")
      .expect(200);
    expect(manuallyAssociated.body.items.map((event: any) => event.id)).toEqual([
      "journey_event:201",
      "activity_event:103",
    ]);
    const verifiedAssociated = await request(app)
      .get("/analytics/accounts/20/activity?limit=5")
      .expect(200);
    expect(verifiedAssociated.body.items.map((event: any) => event.id)).toContain("journey_event:202");
    expect(verifiedAssociated.body.items.map((event: any) => event.id)).toContain("activity_event:104");

    tenantId = 910102;
    try {
      await request(app).get("/analytics/accounts/10").expect(404);
      await request(app).get("/analytics/accounts/10/activity").expect(404);
    } finally {
      tenantId = 910101;
    }
  });

  it("rejects malformed ids and pagination arguments", async () => {
    await request(app).get("/analytics/accounts?clientId=1.5").expect(400);
    await request(app).get("/analytics/accounts?page=0").expect(400);
    await request(app).get("/analytics/accounts?limit=51").expect(400);
    await request(app).get("/analytics/accounts/0").expect(400);
    await request(app).get("/analytics/accounts/10/activity?limit=0").expect(400);
  });
});