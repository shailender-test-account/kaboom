import express from "express";
import request from "supertest";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

let client: PoolClient;
let tenantId = 910001;
vi.mock("@workspace/db", () => ({
  pool: {
    // The route uses pool.query; keep its count and page queries on the same
    // connection as the isolated temporary tables.
    query: (...args: Parameters<PoolClient["query"]>) => client.query(...args),
  },
}));
vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { id: 1, tenantId, role: "admin" };
    next();
  },
}));
vi.mock("@replit/connectors-sdk", () => ({
  ReplitConnectors: class {},
}));

import router from "../routes/intentOpportunities";

const app = express().use(router);
const suite = describe.skipIf(!process.env.DATABASE_URL);

suite("monitored accounts route with PostgreSQL", () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  it("returns saved news on an account detail request even when its HP interpretation is incomplete",async()=>{
    try{
      await client.query(`INSERT INTO companies VALUES(88,910001,10,'Partial News Labs','partial.example',now());
        INSERT INTO intent_research_run_accounts (id,tenant_id,account_id,status) VALUES(888,910001,88,'completed')`);
      const excerpt="Partial News Labs sponsored the India Retail Summit in Mumbai.";
      await client.query(`INSERT INTO intent_evidence(id,tenant_id,account_id,evidence_kind,review_status,excerpt,
        occurred_at,source_url,event_type,context,raw_evidence)
        VALUES(88800,910001,88,'public_event','approved',$1,now()-interval '1 day',
        'https://partial.example/news/india-summit','partnership','{"scope":{"country":"India"}}',$2::jsonb)`,
      [excerpt,JSON.stringify({excerpt})]);
      const detail=await request(app).get("/intent/opportunities/monitored-accounts?accountId=88&completeResearch=false");
      expect(detail.status).toBe(200);
      expect(detail.body.items).toHaveLength(1);
      expect(detail.body.items[0].researchContext.evidence).toHaveLength(1);
      expect(detail.body.items[0].researchContext.takeaways).toHaveLength(0);
      const curated=await request(app).get("/intent/opportunities/monitored-accounts?accountId=88&completeResearch=true");
      expect(curated.body.items).toHaveLength(0);
    }finally{
      await client.query("DELETE FROM intent_evidence WHERE tenant_id=910001 AND account_id=88");
      await client.query("DELETE FROM intent_research_run_accounts WHERE tenant_id=910001 AND account_id=88");
      await client.query("DELETE FROM companies WHERE tenant_id=910001 AND id=88");
    }
  });

  beforeAll(async () => {
    client = await pool.connect();
    await client.query("BEGIN");
    // Shadow only the tables read by this endpoint. Nothing is committed to
    // the development database, even if the test fails.
    await client.query(`
      CREATE TEMP TABLE clients (id int, tenant_id int, name text) ON COMMIT DROP;
      CREATE TEMP TABLE companies (
        id int, tenant_id int, client_id int, name text, domain text,
        last_researched_at timestamptz
      ) ON COMMIT DROP;
      CREATE TEMP TABLE intent_research_run_accounts (
        id int, tenant_id int, account_id int, status text, summary jsonb
      ) ON COMMIT DROP;
      CREATE TEMP TABLE intent_monitoring_accounts (
        tenant_id int, config_id int, company_id int
      ) ON COMMIT DROP;
      CREATE TEMP TABLE intent_evidence (
        id int, tenant_id int, account_id int, evidence_kind text,
        review_status text, excerpt text, occurred_at timestamptz,
        source_url text, event_type text, context jsonb, raw_evidence jsonb
      ) ON COMMIT DROP;
      CREATE TEMP TABLE intent_inbound_submissions (
        tenant_id int, account_id int, classification text
      ) ON COMMIT DROP;
      INSERT INTO clients VALUES (10,910001,'HP'),(20,910001,'Other client'),(10,910002,'Other tenant client');
      INSERT INTO companies VALUES
        (1,910001,10,'Repeat Labs','repeat.example','2026-09-20'),
        (2,910001,10,'Overlap Labs','overlap.example','2026-09-21'),
        (3,910001,20,'Scheduled Only','scheduled.example',NULL),
        (4,910001,20,'Quiet Labs','quiet.example',NULL),
        (5,910002,10,'Other Tenant','other.example','2026-09-22'),
        (6,910001,99,'Orphan Client','orphan.example',NULL);
      INSERT INTO intent_monitoring_accounts VALUES (910001,100,1),(910001,100,2),(910001,100,3);
      INSERT INTO intent_research_run_accounts (id,tenant_id,account_id,status) VALUES
        (1,910001,1,'completed'),(2,910001,1,'failed'),(3,910001,1,'completed'),
        (4,910001,2,'completed'),(5,910001,2,'failed'),
        (6,910002,5,'completed'),
        (7,910002,4,'completed'),
        (8,910001,6,'completed');
      INSERT INTO intent_inbound_submissions VALUES
        (910001,2,'hot'),(910001,2,'warm'),(910002,1,'hot'),
        (910001,3,'warm');
      INSERT INTO intent_evidence (id,tenant_id,account_id,evidence_kind,review_status,excerpt,occurred_at) VALUES
        (1,910001,1,'public_event','approved','Repeat Labs published financial results for Hyderabad operations.',NOW()-interval '1 day'),
        (2,910001,1,'public_event','rejected','Do not show',NOW()),
        (3,910002,2,'public_event','approved','Other tenant signal',NOW());
      UPDATE intent_evidence SET source_url='https://example.com/financial-results' WHERE id=1;
    `);
  });

  afterAll(async () => {
    if (client) {
      await client.query("ROLLBACK");
      client.release();
    }
    await pool.end();
  });

  it("returns parent-owned research when the run was initiated through a roster member", async () => {
    try {
      await client.query(`INSERT INTO companies VALUES
        (89,910001,10,'Parent Research Labs','parent.example',now()),
        (90,910001,10,'Roster Member Labs','member.example',NULL);
        INSERT INTO intent_research_run_accounts (id,tenant_id,account_id,status,summary) VALUES
        (890,910001,90,'completed','{"researchSubject":{"scope":"parent","accountId":89,"memberAccountId":90}}'),
        (891,910002,89,'failed','{"researchSubject":{"scope":"parent","accountId":89}}')`);
      const excerpt = "Parent Research Labs announced a new India office in Hyderabad.";
      await client.query(`INSERT INTO intent_evidence
        (id,tenant_id,account_id,evidence_kind,review_status,excerpt,occurred_at,source_url,context,raw_evidence)
        VALUES (89000,910001,89,'public_event','approved',$1,now()-interval '1 day',
        'https://parent.example/news/india-office','{"scope":{"country":"India"}}',$2::jsonb)`,
        [excerpt, JSON.stringify({excerpt})]);
      const detail = await request(app).get("/intent/opportunities/monitored-accounts?accountId=89&completeResearch=false").expect(200);
      expect(detail.body).toMatchObject({total:1,items:[{id:89,latestRunStatus:"completed"}]});
      expect(detail.body.items[0].researchContext.evidence).toHaveLength(1);
      expect(detail.body.items[0].researchContext.businessDirections.length).toBeGreaterThan(0);
      expect(detail.body.items[0].researchContext.takeaways.length).toBeGreaterThan(0);
      const list = await request(app).get("/intent/opportunities/monitored-accounts?accountId=89&completeResearch=true").expect(200);
      expect(list.body).toMatchObject({total:1,items:[{id:89}]});
      const member = await request(app).get("/intent/opportunities/monitored-accounts?accountId=90&completeResearch=false").expect(200);
      expect(member.body.items).toHaveLength(0);
    } finally {
      await client.query("DELETE FROM intent_evidence WHERE id=89000");
      await client.query("DELETE FROM intent_research_run_accounts WHERE id IN (890,891)");
      await client.query("DELETE FROM companies WHERE id IN (89,90)");
    }
  });

  it("counts accounts once across repeat checks and inbound overlap, not scheduled-only accounts", async () => {
    const first = await request(app).get("/intent/opportunities/monitored-accounts?pageSize=1").expect(200);
    expect(first.body).toMatchObject({
      total: 2, page: 1, pageSize: 1,
      items: [{ id: 2, name: "Overlap Labs", latestRunStatus: "failed", hasInbound: true,
        lastResearchedAt: "2026-09-21T00:00:00.000Z" }],
    });
    const second = await request(app).get("/intent/opportunities/monitored-accounts?pageSize=1&page=2").expect(200);
    expect(second.body).toMatchObject({
      total: 2, page: 2, pageSize: 1,
      items: [{ id: 1, latestRunStatus: "completed", hasInbound: false, latestSignal: "Repeat Labs published financial results for Hyderabad operations.",
        researchContext: {kind: "business_context", possibleNeeds: [], takeaways: []} }],
    });
    const empty = await request(app).get("/intent/opportunities/monitored-accounts?pageSize=1&page=3").expect(200);
    expect(empty.body).toMatchObject({ total: 2, items: [] });
  });

  it("shows an approved expansion independently of intent and excludes rejected, pending, global and stale findings", async () => {
    await client.query(`INSERT INTO intent_evidence
      (id,tenant_id,account_id,evidence_kind,review_status,excerpt,occurred_at,source_url) VALUES
      (10,910001,1,'public_event','approved','Repeat Labs announced a new Hyderabad office: 600,000 square feet, expected to open in 2027.',NOW()-interval '2 days','https://example.com/office'),
      (11,910001,1,'public_event','pending','New Hyderabad office announced, unreviewed.',NOW(),NULL),
      (12,910001,2,'public_event','approved','New London office announced.',NOW(),NULL),
      (13,910001,2,'public_event','approved','New Hyderabad office announced.',NOW()-interval '100 days',NULL);
      UPDATE intent_evidence SET context=jsonb_build_object('publishedDate',CURRENT_DATE::text) WHERE id=10;`);
    try {
      const result = await request(app).get("/intent/opportunities/monitored-accounts").expect(200);
      const expansion = result.body.items.find((item: any) => item.id === 1);
      expect(expansion.researchContext).toMatchObject({
        kind: "expansion", summary: expect.stringContaining("600,000"),
        possibleNeeds: expect.arrayContaining(["Meeting-room and collaboration equipment"]),
        caution: expect.stringContaining("not confirmed buying intent"),
      });
      expect(expansion.researchContext.evidence.map((item: any) => item.id)).toEqual([10, 1]);
      expect(expansion.researchContext.takeaways.map((item: any) => item.category)).toEqual(["IT Hardware", "Business Collaboration", "Business Services"]);
      expect(expansion.researchContext.takeaways.every((item: any) => item.evidenceIds[0] === 10)).toBe(true);
      expect(expansion.hasInbound).toBe(false);
      expect(result.body.items.find((item: any) => item.id === 2)).toMatchObject({
        latestSignal: null, researchContext: { kind: "no_recent_findings", evidence: [], possibleNeeds: [] },
      });
    } finally {
      await client.query("DELETE FROM intent_evidence WHERE id>=10");
    }
  });

  it("applies search, client scope, and tenant scope equally to page rows and total", async () => {
    const search = await request(app).get("/intent/opportunities/monitored-accounts?search=repeat&pageSize=1").expect(200);
    expect(search.body).toMatchObject({ total: 1, items: [{ id: 1 }] });
    const domain = await request(app).get("/intent/opportunities/monitored-accounts?search=overlap.example").expect(200);
    expect(domain.body).toMatchObject({ total: 1, items: [{ id: 2, hasInbound: true }] });
    const noClient = await request(app).get("/intent/opportunities/monitored-accounts?clientId=20").expect(200);
    expect(noClient.body).toMatchObject({ total: 0, items: [] });
    const exact = await request(app).get("/intent/opportunities/monitored-accounts?accountId=1").expect(200);
    expect(exact.body).toMatchObject({ total: 1, items: [{ id: 1 }] });
    const wrongTenant = await request(app).get("/intent/opportunities/monitored-accounts?accountId=5").expect(200);
    expect(wrongTenant.body).toMatchObject({ total: 0, items: [] });
    await request(app).get("/intent/opportunities/monitored-accounts?accountId=0").expect(400);
    await request(app).get("/intent/opportunities/monitored-accounts?clientId=0").expect(400);

    tenantId = 910002;
    try {
      const other = await request(app).get("/intent/opportunities/monitored-accounts").expect(200);
      expect(other.body).toMatchObject({ total: 1, items: [{ id: 5, hasInbound: false }] });
      const hidden = await request(app).get("/intent/opportunities/monitored-accounts?search=Repeat").expect(200);
      expect(hidden.body).toMatchObject({ total: 0, items: [] });
    } finally {
      tenantId = 910001;
    }
  });

  it("filters complete research before counting and paging, without altering run history", async () => {
    await client.query(`INSERT INTO companies VALUES
      (7,910001,10,'Ready Labs','ready.example',NOW()),
      (8,910001,10,'Empty Labs','empty.example',NOW()),
      (9,910001,10,'Stale Labs','stale.example',NOW());
      INSERT INTO intent_research_run_accounts (id,tenant_id,account_id,status) VALUES
      (101,910001,7,'completed'),(102,910001,8,'completed'),(103,910001,9,'completed');
      INSERT INTO intent_evidence
        (id,tenant_id,account_id,evidence_kind,review_status,excerpt,occurred_at,source_url,context) VALUES
      (101,910001,7,'public_event','approved','Ready Labs announced a new Hyderabad office: 600,000 square feet, expected to open in 2027.',NOW(),'https://ready.example/news',jsonb_build_object('publishedDate',CURRENT_DATE::text)),
      (102,910001,2,'public_event','approved','Overlap Labs announced a new Hyderabad office: 600,000 square feet, expected to open in 2027.',NOW(),'https://overlap.example/news',jsonb_build_object('publishedDate',CURRENT_DATE::text)),
      (103,910001,9,'public_event','approved','Stale Labs announced a new Hyderabad office.',NOW()-interval '100 days','https://stale.example/news',NULL);`);
    try {
      const first=await request(app).get("/intent/opportunities/monitored-accounts?completeResearch=true&pageSize=1").expect(200);
      expect(first.body).toMatchObject({total:2,items:[{id:7}]});
      expect(first.body.items[0].researchContext.businessDirections.length).toBeGreaterThan(0);
      expect(first.body.items[0].researchContext.takeaways.length).toBeGreaterThan(0);
      const second=await request(app).get("/intent/opportunities/monitored-accounts?completeResearch=true&pageSize=1&page=2").expect(200);
      expect(second.body).toMatchObject({total:2,items:[{id:2}]});
      const end=await request(app).get("/intent/opportunities/monitored-accounts?completeResearch=true&pageSize=1&page=3").expect(200);
      expect(end.body).toMatchObject({total:2,items:[]});
      // Plain financial context without an HP recommendation is not "complete".
      const newsOnly=await request(app).get("/intent/opportunities/monitored-accounts?completeResearch=true&accountId=1").expect(200);
      expect(newsOnly.body).toMatchObject({total:0,items:[]});
      const search=await request(app).get("/intent/opportunities/monitored-accounts?completeResearch=true&search=overlap").expect(200);
      expect(search.body).toMatchObject({total:1,items:[{id:2}]});
      const otherClient=await request(app).get("/intent/opportunities/monitored-accounts?completeResearch=true&clientId=20").expect(200);
      expect(otherClient.body).toMatchObject({total:0,items:[]});
      const history=await request(app).get("/intent/opportunities/monitored-accounts").expect(200);
      expect(history.body.total).toBe(5);
      await request(app).get("/intent/opportunities/monitored-accounts?completeResearch=maybe").expect(400);
    } finally {
      await client.query(`DELETE FROM intent_evidence WHERE id IN (101,102,103);
        DELETE FROM intent_research_run_accounts WHERE id IN (101,102,103);
        DELETE FROM companies WHERE id IN (7,8,9);`);
    }
  });
});