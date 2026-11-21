import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { pool } from "@workspace/db";
import { seedHpCrmAccounts, cleanHpCrmTenant } from "./testFixtures/hpCrm";
import { readHpCrm } from "./hpBiCrmRead";
import { loadHpBi } from "./hpBiMetrics";

let tenant: number, client: number, company: number;
beforeAll(async () => {
  tenant = (await pool.query("INSERT INTO tenants(name,slug) VALUES('Deal lifecycle fixture',$1) RETURNING id", [randomUUID()])).rows[0].id;
  client = (await pool.query("INSERT INTO clients(tenant_id,name) VALUES($1,'HP') RETURNING id", [tenant])).rows[0].id;
  company = (await seedHpCrmAccounts(tenant, client)).companyId;
  const rows = [
    ["closed_won", "2025-12-01", "2025-12-11", true],
    ["closed_won", "2025-12-01", "2025-12-21", true],
    ["closed_lost", "2025-12-01", "2025-12-06", true],
    ["proposal", "2026-10-21", null, true],
    ["closed_won", "2026-10-11", "2026-11-01", true],
    ["closed_won", "2026-10-03", "2026-10-01", true],
    ["proposal", "2026-10-01", null, false],
    ["proposal", null, null, true],
  ];
  for (const [stage, opportunity, outcome, confirmed] of rows) await pool.query(`INSERT INTO deals
    (tenant_id,client_id,company_id,title,stage,opportunity_confirmed,actual_opportunity_date,actual_outcome_date)
    VALUES($1,$2,$3,'Lifecycle fixture',$4,$5,$6,$7)`, [tenant, client, company, stage, confirmed, opportunity, outcome]);
});
afterAll(async () => {
  if (tenant) await cleanHpCrmTenant(tenant);
});
describe("HP deal lifecycle KPIs", () => {
  it("uses real dates, includes carryover open deals, reconstructs historical closure and excludes invalid durations", async () => {
    const result = await readHpCrm(tenant, client, { selectedIds: new Set([company]), start: "2025-11-01",
      end: "2026-11-01", showUnlinked: false, mirrors: [] });
    expect(result.lifecycle).toEqual({ asOfDate: "2026-10-31", openDeals: 2, avgOpenDealAge: 15,
      avgDaysToClose: 15, closedDurationSamples: 2 });
    const dashboard: any = await loadHpBi(tenant, { clientId: client, year: 2026, page: 1, pageSize: 25 });
    expect(dashboard.summary.dealLifecycle).toMatchObject({ winRate: 75, closedOutcomes: 4, openDeals: 2,
      avgDaysToClose: 15, avgOpenDealAge: 15 });
  });
  it("keeps empty and foreign account scopes empty and future snapshots unavailable", async () => {
    const empty = await readHpCrm(tenant, client, { selectedIds: new Set(), start: "2025-11-01",
      end: "2026-11-01", showUnlinked: false, mirrors: [] });
    expect(empty.lifecycle).toMatchObject({ openDeals: 0, avgOpenDealAge: null, avgDaysToClose: null, closedDurationSamples: 0 });
    const future = await readHpCrm(tenant, client, { selectedIds: new Set([company]), start: "2098-11-01",
      end: "2099-11-01", showUnlinked: false, mirrors: [] });
    expect(future.lifecycle).toMatchObject({ asOfDate: null, openDeals: null, avgOpenDealAge: null });
    const foreign = await readHpCrm(tenant + 999999, client, { selectedIds: new Set([company]), start: "2025-11-01",
      end: "2026-11-01", showUnlinked: false, mirrors: [] });
    expect(foreign.lifecycle.openDeals).toBe(0);
  });
});
