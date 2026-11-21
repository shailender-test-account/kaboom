import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { pool } from "@workspace/db";
import { checkQuality, loadMonitoringCheckQuality } from "./monitoringCheckQuality";
import { monitoringHistoryAccounts } from "./monitoringHistory";
import { monitoringBatchAccounts } from "./monitoringBatchAccounts";
import type { MonitoringFinding } from "./monitoredAccountContext";
import { GetMonitoringHistoryAccountsResponse, GetMonitoringBatchAccountsResponse } from "@workspace/api-zod";

const now = new Date("2026-11-03T12:00:00Z");
const identity = { name: "Northstar Manufacturing", domain: "northstar.example" };
function finding(excerpt: string, sourceUrl = "https://news.example/article", id = 1): MonitoringFinding {
  return { id, excerpt, sourceUrl, occurredAt: "2026-11-01T00:00:00Z", eventType: "partnership",
    reviewStatus: "approved", context: { scope: { country: "India" } }, raw_evidence: { excerpt } };
}
it("reuses source validation for directories, indexes and unattributable geography without mutating findings", () => {
  const sources = [
    finding("Northstar Manufacturing India jobs and open roles.", "https://jobs.example/northstar-jobs"),
    finding("Northstar Manufacturing India financial news.", "https://news.example/company/northstar/news/", 2),
    finding("Northstar Manufacturing announced a partnership in London.", undefined, 3),
  ];
  const before = JSON.stringify(sources);
  const quality = checkQuality(1, sources, now, identity);
  expect(quality).toMatchObject({ assessedCount: 3, usableCount: 0, excludedCount: 3 });
  expect(quality.exclusions).toEqual(expect.arrayContaining([
    expect.objectContaining({ reason: "source_furniture", count: 2 }),
    expect.objectContaining({ reason: "non_selected_country", count: 1 }),
  ]));
  expect(JSON.stringify(sources)).toBe(before);
});
it("retains usable business context without demanding operational or purchase evidence", () => {
  const quality = checkQuality(1, [
    finding("Northstar Manufacturing reported increased revenue in India."),
    finding("Northstar Manufacturing India jobs.", "https://jobs.example/northstar-jobs", 2),
  ], now, identity);
  expect(quality).toMatchObject({ assessedCount: 2, usableCount: 1, excludedCount: 1 });
  expect(checkQuality(1, [], now, identity)).toMatchObject({ assessedCount: 0, usableCount: 0, exclusions: [] });
});

let tenant: number, foreign: number, parent: number, member: number, run: number, newer: number, date: string;
beforeAll(async () => {
  tenant = (await pool.query("INSERT INTO tenants(name,slug) VALUES('Quality check test',$1) RETURNING id", [randomUUID()])).rows[0].id;
  foreign = (await pool.query("INSERT INTO tenants(name,slug) VALUES('Other quality test',$1) RETURNING id", [randomUUID()])).rows[0].id;
  const client = (await pool.query("INSERT INTO clients(tenant_id,name) VALUES($1,'Quality client') RETURNING id", [tenant])).rows[0].id;
  parent = (await pool.query("INSERT INTO companies(tenant_id,client_id,name,domain) VALUES($1,$2,$3,$4) RETURNING id",
    [tenant, client, identity.name, identity.domain])).rows[0].id;
  member = (await pool.query("INSERT INTO companies(tenant_id,client_id,name) VALUES($1,$2,'Member') RETURNING id", [tenant, client])).rows[0].id;
  run = (await pool.query(`INSERT INTO intent_research_runs(tenant_id,provider,status,idempotency_key)
    VALUES($1,'tavily','completed','monitoring-activation:777:quality:9:tavily-prospect') RETURNING id`, [tenant])).rows[0].id;
  newer = (await pool.query(`INSERT INTO intent_research_runs(tenant_id,provider,status,idempotency_key)
    VALUES($1,'tavily','completed','manual-quality') RETURNING id`, [tenant])).rows[0].id;
  await pool.query(`INSERT INTO intent_research_run_accounts(tenant_id,run_id,account_id,status,completed_at,summary)
    VALUES($1,$2,$3,'completed',NOW(),$4::jsonb),($1,$2,$5,'completed',NOW(),$6::jsonb)`,
  [tenant, run, member, JSON.stringify({ researchSubject: { scope: "parent", accountId: parent } }), parent,
    JSON.stringify({ researchSubject: { scope: "parent", accountId: parent }, reusedParentCheck: true })]);
  for (const [runId, excerpt, url] of [
    [run, "Northstar Manufacturing India jobs and open roles.", "https://jobs.example/northstar-jobs"],
    [newer, "Northstar Manufacturing reported increased revenue in India.", "https://news.example/revenue"],
  ] as const) {
    await pool.query(`INSERT INTO intent_evidence(tenant_id,research_run_id,account_id,evidence_kind,event_type,
      excerpt,source_url,provider,confidence,review_status,occurred_at,context,raw_evidence)
      VALUES($1,$2,$3,'public_event','partnership',$4,$5,'tavily',80,'approved',NOW(),
        '{"scope":{"country":"India"}}'::jsonb,$6::jsonb)`,
    [tenant, runId, parent, excerpt, url, JSON.stringify({ excerpt })]);
  }
  date = (await pool.query("SELECT to_char(NOW() AT TIME ZONE 'Asia/Kolkata','YYYY-MM-DD') AS day")).rows[0].day;
});
afterAll(async () => {
  for (const id of [tenant, foreign].filter(Boolean)) {
    for (const table of ["intent_evidence", "intent_research_run_accounts", "intent_research_runs", "companies", "clients"]) {
      await pool.query(`DELETE FROM ${table} WHERE tenant_id=$1`, [id]);
    }
    await pool.query("DELETE FROM tenants WHERE id=$1", [id]);
  }
});
it("projects parent quality into history and batch views, leaving operational outcomes and sources unchanged", async () => {
  const history = GetMonitoringHistoryAccountsResponse.parse(await monitoringHistoryAccounts(tenant, date, "completed", 1, 20, 777));
  expect(history).toMatchObject({ totalAccounts: 1, totalChecks: 1 });
  expect(history.items[0]).toMatchObject({ accountId: parent, completedChecks: 1, failedChecks: 0 });
  expect(history.items[0].attempts[0]).toMatchObject({
    status: "completed", researchQuality: { accountId: parent, assessedCount: 1, usableCount: 0 },
  });
  const batch = GetMonitoringBatchAccountsResponse.parse(await monitoringBatchAccounts(tenant, 777, run, "completed", 1, 20));
  expect(batch.totalAccounts).toBe(2);
  expect(batch.items.find(item => item.accountId === member)?.researchQuality).toMatchObject({ accountId: parent, usableCount: 0 });
  expect(batch.items.find(item => item.accountId === parent)?.researchQuality).toBeUndefined();
  expect((await pool.query("SELECT status FROM intent_research_run_accounts WHERE tenant_id=$1", [tenant])).rows.every(row => row.status === "completed")).toBe(true);
  expect((await pool.query("SELECT count(*)::int AS n FROM intent_evidence WHERE tenant_id=$1", [tenant])).rows[0].n).toBe(2);
});
it("does not borrow newer evidence, leak another tenant, assess failed/unfinished checks or expand empty pages", async () => {
  const checks = [{ runId: run, accountId: parent, status: "completed" }];
  expect((await loadMonitoringCheckQuality(tenant, checks)).get(`${run}:${parent}`)).toMatchObject({ assessedCount: 1, usableCount: 0 });
  expect((await loadMonitoringCheckQuality(foreign, checks)).size).toBe(0);
  expect((await loadMonitoringCheckQuality(tenant, ["failed", "running", "pending"].map(status => ({ ...checks[0], status })))).size).toBe(0);
  expect((await loadMonitoringCheckQuality(tenant, [{ ...checks[0], reusedParentCheck: true }])).size).toBe(0);
  expect((await monitoringHistoryAccounts(tenant, date, "completed", 2, 20, 777)).items).toEqual([]);
  expect((await monitoringBatchAccounts(tenant, 777, run, "completed", 2, 20)).items).toEqual([]);
  expect((await monitoringHistoryAccounts(foreign, date, "completed", 1, 20, 777)).items).toEqual([]);
});
