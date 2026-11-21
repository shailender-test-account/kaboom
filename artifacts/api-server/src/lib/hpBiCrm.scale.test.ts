import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import express from "express";
import { pool } from "@workspace/db";
import hpRouter from "../routes/hpBi";
import { projectHpCrm } from "./hpBiCrm";
import { fiscalBounds } from "./hpBiImport";
import * as crmRead from "./hpBiCrmRead";
import type { BusinessRecord } from "./hpBiMetrics";

// Real PostgreSQL, synthetic isolated tenant, never production/customer rows.
// HP_BI_BASELINE=1 also runs against the pre-optimization implementation.
describe("HP multiyear reporting bounds", () => {
  let tenantId: number, clientId: number, otherClient: number, deletedId: number, companies: any[], legacy: any[];
  let server: ReturnType<express.Application["listen"]>, url: string;
  beforeAll(async () => {
    tenantId = (await pool.query("INSERT INTO tenants(name,slug) VALUES('HP scale fixture',$1) RETURNING id",
      [`hp-scale-${Date.now()}`])).rows[0].id;
    clientId = (await pool.query("INSERT INTO clients(tenant_id,name) VALUES($1,'HP') RETURNING id", [tenantId])).rows[0].id;
    companies = (await pool.query(`INSERT INTO companies(tenant_id,client_id,name)
      SELECT $1::int,$2::int,'Scale account '||s FROM generate_series(1,10) s RETURNING id,name`, [tenantId, clientId])).rows;
    for (const [i, c] of companies.entries()) await pool.query(`INSERT INTO hp_account_profiles
      (tenant_id,client_id,company_id,hp_id,parent_key,parent_name,gtm,provenance)
      VALUES($1,$2,$3,$4,$4,$5,$6,'{}')`, [tenantId, clientId, c.id, `scale-${i}`, c.name, i % 2 ? "Gov/Edu" : "GCC"]);
    await pool.query(`INSERT INTO deals(tenant_id,client_id,company_id,title,stage,value,currency,value_meaning,
      booked_value,opportunity_confirmed,actual_opportunity_date,actual_outcome_date,notes)
      SELECT $1::int,$2::int,($3::int[])[1+(s-1)%10],'Historical deal '||s,
        CASE WHEN s%5=0 THEN 'qualified' WHEN s%5=1 THEN 'closed_won' WHEN s%5=2 THEN 'closed_lost' ELSE 'proposal' END,
        10,CASE WHEN s%13=0 THEN NULL WHEN (s/10)%2=0 THEN 'INR' ELSE 'USD' END,
        CASE WHEN s%11=0 THEN 'unknown' WHEN s%23=0 THEN 'prospective' ELSE 'total_order_value' END,
        CASE WHEN s%17=0 THEN NULL ELSE 7 END,s%7<>0,
        CASE WHEN s%19=0 THEN NULL ELSE make_date(2020+(s-1)/1000,1,31) END,
        CASE WHEN s%5 IN (1,2) THEN make_date(2020+(s-1)/1000,2,1) ELSE NULL END,repeat('private history ',100)
      FROM generate_series(1,8000) s`, [tenantId, clientId, companies.map(c => c.id)]);
    await pool.query(`INSERT INTO deal_audit(tenant_id,client_id,deal_id,action,before)
      SELECT d.tenant_id,d.client_id,d.id,'updated',jsonb_build_object('notes',repeat('old history ',50))
      FROM deals d CROSS JOIN generate_series(1,8) s WHERE d.tenant_id=$1`, [tenantId]);
    legacy = (await pool.query(`SELECT d.*,c.name account_name,p.company_id profile_account_id,true contact_valid
      FROM deals d JOIN companies c ON c.id=d.company_id JOIN hp_account_profiles p ON p.company_id=c.id
      WHERE d.tenant_id=$1 ORDER BY d.id`, [tenantId])).rows;
    deletedId = (await pool.query("INSERT INTO deals(tenant_id,client_id,title) VALUES($1,$2,'Deleted identity') RETURNING id",
      [tenantId, clientId])).rows[0].id;
    await pool.query("INSERT INTO deal_audit(tenant_id,client_id,deal_id,action) VALUES($1,$2,$3,'account_deleted')",
      [tenantId, clientId, deletedId]);
    await pool.query("DELETE FROM deals WHERE tenant_id=$1 AND id=$2", [tenantId, deletedId]);
    otherClient = (await pool.query("INSERT INTO clients(tenant_id,name) VALUES($1,'Other scale client') RETURNING id", [tenantId])).rows[0].id;
    // Same reference in a different ownership scope must not suppress our row.
    await pool.query("INSERT INTO deal_audit(tenant_id,client_id,deal_id,action) VALUES($1,$2,$3,'deleted')",
      [tenantId, otherClient, 2147483647]);
    for (const id of [legacy[1].id, deletedId]) await pool.query(`INSERT INTO hp_bi_records
      (tenant_id,client_id,account_id,kind,occurred_at,order_value,currency,source,source_key,external_event_id)
      VALUES($1,$2,$3,'opportunity','2027-01-31T00:00:00+05:30',999,'INR','excel',$4,$4)`,
      [tenantId, clientId, companies[0].id, `crm:deal:${id}:opportunity`]);
    const app = express();
    app.use((req: any, _res, next) => {
      req.isAuthenticated = () => true; req.user = { tenantId, role: "admin" }; req.log = { warn() {} }; next();
    });
    app.use(hpRouter);
    server = app.listen(0); url = `http://127.0.0.1:${(server.address() as any).port}`;
  }, 120_000);
  afterAll(async () => {
    vi.restoreAllMocks();
    if (server) await new Promise<void>(resolve => server.close(() => resolve()));
    if (!tenantId) return;
    for (const table of ["deal_audit", "deals", "hp_bi_records", "hp_account_profiles", "companies", "clients", "intent_inbound_category_rules"])
      await pool.query(`DELETE FROM ${table} WHERE tenant_id=$1`, [tenantId]);
    await pool.query("DELETE FROM tenants WHERE id=$1", [tenantId]);
  });
  it("measures dashboard, evidence, account and CSV; retains full coverage and currency totals", async () => {
    const bounds = fiscalBounds(2027);
    const expected = projectHpCrm(legacy, new Set(companies.map(c => c.id)), bounds.start, bounds.end, true);
    const original = pool.query.bind(pool);
    if (process.env.HP_BI_BASELINE) vi.spyOn(crmRead, "readHpCrm").mockImplementation(async (tenant, client, scope) => {
      const [deals, audit] = await Promise.all([
        original(`SELECT d.*,c.name account_name,p.company_id profile_account_id,
          CASE WHEN d.contact_id IS NULL THEN true ELSE ct.id IS NOT NULL AND NOT ct.is_anonymous AND ct.company_id=d.company_id END contact_valid
          FROM deals d LEFT JOIN companies c ON c.id=d.company_id AND c.tenant_id=d.tenant_id AND c.client_id=d.client_id
          LEFT JOIN hp_account_profiles p ON p.company_id=c.id AND p.tenant_id=d.tenant_id AND p.client_id=d.client_id
          LEFT JOIN contacts ct ON ct.id=d.contact_id AND ct.tenant_id=d.tenant_id AND ct.client_id=d.client_id
          WHERE d.tenant_id=$1 AND d.client_id=$2 ORDER BY d.id`, [tenant, client]),
        original("SELECT DISTINCT deal_id FROM deal_audit WHERE tenant_id=$1 AND client_id=$2", [tenant, client]),
      ]);
      reads.push(...[deals, audit].map(r => ({ rows: r.rows.length, bytes: Buffer.byteLength(JSON.stringify(r.rows)) })));
      const projection = projectHpCrm(deals.rows, scope.selectedIds, scope.start, scope.end, scope.showUnlinked);
      return { deals: deals.rows, coverage: projection.quality, lifecycle: undefined,
        issueIds: new Set(projection.quality.issues.map(i => i.dealId)),
        knownIds: new Set([...deals.rows.map(d => Number(d.id)), ...audit.rows.map(d => Number(d.deal_id))]) };
    });
    const reads: { rows: number; bytes: number }[] = [];
    let explainArgs: any[];
    vi.spyOn(pool, "query").mockImplementation((async (...args: any[]) => {
      const result = await (original as any)(...args);
      if (typeof args[0] === "string" && /\b(?:deals|deal_audit)\b/.test(args[0])) {
        if (args[0].startsWith("WITH scoped")) explainArgs = args;
        reads.push({ rows: result.rows.length, bytes: Buffer.byteLength(JSON.stringify(result.rows)) });
      }
      return result;
    }) as any);
    const metrics = [];
    for (const path of ["", "/evidence", "/account", "/export"]) {
      reads.length = 0;
      const start = performance.now();
      const response = await fetch(`${url}/analytics/hp-bi${path}?clientId=${clientId}&year=2027&pageSize=100${path === "/account" ? "&parentKey=scale-0" : ""}`);
      expect(response.status).toBe(200);
      const body: any = path === "/export" ? await response.text() : await response.json();
      metrics.push({ path: path || "/dashboard", ms: Math.round(performance.now() - start),
        crmRows: reads.reduce((n, r) => n + r.rows, 0), crmBytes: reads.reduce((n, r) => n + r.bytes, 0) });
      if (!path) {
        for (const key of ["total", "includedOpportunities", "includedOutcomes", "incompleteDeals", "excludedDeals"])
          expect(body.quality.crmDeals[key], key).toBe((expected.quality as any)[key]);
        expect(body.quality.crmDeals.suppressedMirrors).toBe(2);
        if (!process.env.HP_BI_BASELINE) {
          expect(body.quality.crmDeals.issuesTruncated).toBe(true);
          expect(body.quality.crmDeals.issues).toEqual(expected.quality.issues.slice(0, 25));
        }
        for (const [kind, key] of [["opportunity", "values"], ["closed_won", "bookedValues"], ["prospective", "prospectiveValues"]]) {
          const money: Record<string, number> = {};
          expected.records.filter(r => r.kind === kind && r.orderValue !== null && r.currency)
            .forEach(r => money[r.currency!] = (money[r.currency!] ?? 0) + r.orderValue!);
          expect(body.summary[key]).toEqual(money);
        }
      } else if (path === "/evidence") {
        expect(body.total).toBe(expected.records.length);
        expect(body.records).toHaveLength(100);
      } else if (path === "/account") {
        const scoped = projectHpCrm(legacy, new Set([companies[0].id]), bounds.start, bounds.end, false);
        expect(body.records).toEqual(JSON.parse(JSON.stringify(scoped.records.sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.id.localeCompare(b.id)))));
        expect(body.crmDeals.total).toBe(scoped.quality.total);
        expect(body.crmDeals.suppressedMirrors).toBe(2);
        for (const key of ["includedOpportunities", "includedOutcomes", "incompleteDeals", "excludedDeals"])
          expect(body.crmDeals[key], key).toBe((scoped.quality as any)[key]);
      } else expect(body).toContain("scale-9");
      if (!process.env.HP_BI_BASELINE) {
        expect(reads.reduce((n, r) => n + r.rows, 0)).toBeLessThan(path === "/account" ? 160 : 1060);
        expect(reads.reduce((n, r) => n + r.bytes, 0)).toBeLessThan(750_000);
      }
    }
    process.stdout.write(`HP_SCALE_MEASUREMENTS ${JSON.stringify(metrics)}\n`);
    if (process.env.HP_BI_EXPLAIN && explainArgs!) {
      const plan = await original("EXPLAIN (ANALYZE,BUFFERS) " + explainArgs[0], explainArgs[1]);
      process.stdout.write(plan.rows.map(r => r["QUERY PLAN"]).join("\n") + "\n");
    }
    vi.restoreAllMocks();
  }, 120_000);
  it("resolves only requested mirror identities even across account/year moves and deleted histories", async () => {
    const ids = [legacy[1].id, deletedId, 2147483647];
    const mirrors = ids.map(id => ({ source: "excel", externalEventId: `crm:deal:${id}:opportunity` } as BusinessRecord));
    const result = await crmRead.readHpCrm(tenantId, clientId, {
      selectedIds: new Set(), showUnlinked: false, ...fiscalBounds(2028), mirrors,
    });
    expect([...result.knownIds].sort((a, b) => a - b)).toEqual([legacy[1].id, deletedId].sort((a, b) => a - b));
    expect(result.deals).toEqual([]);
    expect(result.coverage).toEqual({ total: 0, includedOpportunities: 0, includedOutcomes: 0, incompleteDeals: 0, excludedDeals: 0 });
    expect((await crmRead.readHpCrm(tenantId, otherClient, {
      selectedIds: new Set(), showUnlinked: false, ...fiscalBounds(2028), mirrors,
    })).knownIds).toEqual(new Set([2147483647]));
  });
});
