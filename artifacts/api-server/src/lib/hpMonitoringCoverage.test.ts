import { expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { pool } from "@workspace/db";
import { hpMonitoringCoverage, matchesHpMonitoring } from "./hpMonitoringCoverage";
import { importHpWorkbook } from "./hpBiImport";
import { loadHpBi } from "./hpBiMetrics";
import { hpWorkbook, cleanHpCrmTenant } from "./testFixtures/hpCrm";

const now = Date.parse("2026-10-29T18:30:00Z");
const cutoff = now - 7 * 86400000;
const member = (time: number | null) => ({ last_researched_at: time === null ? null : new Date(time) });

it("uses a strict seven-day completion boundary, including across India midnight", () => {
  for (const [time, overdue] of [[cutoff - 1, 1], [cutoff, 0], [cutoff + 1, 0]] as const) {
    const coverage = hpMonitoringCoverage([member(time)], now);
    expect(coverage.monitoringOverdueMembers).toBe(overdue);
    expect(matchesHpMonitoring(coverage, "overdue")).toBe(!!overdue);
    expect(matchesHpMonitoring(coverage, "never")).toBe(false);
  }
});

it("does not let a recent member conceal never-checked or stale members", () => {
  const partial = hpMonitoringCoverage([member(now), member(null), member(cutoff - 1)], now);
  expect(partial).toMatchObject({ lastMonitoredAt: new Date(now).toISOString(),
    monitoringCheckedMembers: 2, monitoringTotalMembers: 3, monitoringNeverMembers: 1, monitoringOverdueMembers: 2 });
  expect(matchesHpMonitoring(partial, "never")).toBe(true);
  expect(matchesHpMonitoring(partial, "overdue")).toBe(true);
  const never = hpMonitoringCoverage([member(null), member(null)], now);
  expect(never.lastMonitoredAt).toBeNull();
  expect(never.monitoringNeverMembers).toBe(2);
  expect(matchesHpMonitoring(never, "overdue")).toBe(true);
  const full = hpMonitoringCoverage([member(now), member(cutoff)], now);
  expect(matchesHpMonitoring(full, "never")).toBe(false);
  expect(matchesHpMonitoring(full, "overdue")).toBe(false);
  expect(matchesHpMonitoring(full)).toBe(true);
});

it("filters full parent coverage before pagination, intersecting scoped members without changing completion dates", async () => {
  const tenantId = Number((await pool.query("INSERT INTO tenants(name,slug) VALUES('HP monitoring filter test',$1) RETURNING id", [randomUUID()])).rows[0].id);
  const clock = vi.spyOn(Date, "now").mockReturnValue(now);
  try {
    const clientId = Number((await pool.query("INSERT INTO clients(tenant_id,name) VALUES($1,'HP') RETURNING id", [tenantId])).rows[0].id);
    const otherClientId = Number((await pool.query("INSERT INTO clients(tenant_id,name) VALUES($1,'Other') RETURNING id", [tenantId])).rows[0].id);
    const headers = ["UNIQUE ID", "SUBSIDIARY_LEGAL_NAME", "TOP_ID", "TOP_NAME", "FY25 GTM", "PS RAD"];
    await importHpWorkbook(tenantId, clientId, hpWorkbook(headers, [
      ["M-1", "Fresh", "A", "A fresh", "GCC", "R1"],
      ["M-2", "Mixed fresh", "B", "B mixed", "GCC", "R1"],
      ["M-3", "Mixed never", "B", "B mixed", "Gov/Edu", "A1"],
      ["M-4", "Stale", "C", "C stale", "GCC", "R1"],
      ["M-5", "Never", "D", "D never", "GCC", "R1"],
    ]), "monitoring.xlsx", "accounts", {}, null);
    await importHpWorkbook(tenantId, otherClientId, hpWorkbook(headers, [
      ["OTHER", "Foreign never", "Z", "Z foreign", "GCC", "R1"],
    ]), "other.xlsx", "accounts", {}, null);
    await pool.query(`UPDATE companies c SET last_researched_at=CASE WHEN p.hp_id='M-4' THEN $3::timestamptz ELSE $4::timestamptz END
      FROM hp_account_profiles p WHERE c.id=p.company_id AND p.tenant_id=$1 AND p.client_id=$2 AND p.hp_id IN ('M-1','M-2','M-4')`,
    [tenantId, clientId, new Date(cutoff - 1), new Date(now)]);
    const before = (await pool.query("SELECT id,last_researched_at FROM companies WHERE tenant_id=$1 ORDER BY id", [tenantId])).rows;
    const filters = { clientId, year: 2027, page: 1, pageSize: 1, sortBy: "name" as const, sortDir: "asc" as const };
    const never: any = await loadHpBi(tenantId, { ...filters, monitoring: "never" });
    expect(never.total).toBe(2);
    expect(never.matchingLegalAccounts).toBe(3);
    expect(never.accounts[0]).toMatchObject({ name: "B mixed", monitoringCheckedMembers: 1, monitoringNeverMembers: 1 });
    expect(never.summary.accounts).toBe(5);
    const second: any = await loadHpBi(tenantId, { ...filters, monitoring: "never", page: 2 });
    expect(second.accounts.map((a: any) => a.name)).toEqual(["D never"]);
    const overdue: any = await loadHpBi(tenantId, { ...filters, monitoring: "overdue", pageSize: 100 });
    expect(overdue.accounts.map((a: any) => a.name)).toEqual(["B mixed", "C stale", "D never"]);
    const narrowed: any = await loadHpBi(tenantId, { ...filters, monitoring: "never", segment: "GCC", search: "mixed" });
    expect(narrowed.total).toBe(0); // the only matching member has completed monitoring
    const cold: any = await loadHpBi(tenantId, { ...filters, monitoring: "never", qualification: "Cold", search: "Never", pageSize: 100 });
    expect(cold.accounts).toHaveLength(2);
    const hot: any = await loadHpBi(tenantId, { ...filters, monitoring: "overdue", qualification: "Hot" });
    expect(hot.total).toBe(0); // heat cannot fabricate monitoring or qualification
    const exportRows: any = await loadHpBi(tenantId, { ...filters, monitoring: "never", pageSize: Number.MAX_SAFE_INTEGER });
    expect(exportRows.accounts).toHaveLength(2);
    expect((await pool.query("SELECT id,last_researched_at FROM companies WHERE tenant_id=$1 ORDER BY id", [tenantId])).rows).toEqual(before);
  } finally {
    clock.mockRestore();
    await cleanHpCrmTenant(tenantId);
  }
});
