import { randomUUID } from "node:crypto";
import express from "express";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { pool } from "@workspace/db";
import { retryMonitoringRun } from "./monitoringRetry";
import { registerMonitoringRetryRoutes } from "../routes/monitoringRetry";
import { MONITORING_RUN_SCOPE_SQL } from "./monitoringResearchPolicy";
import { assertResearchAccountLease, heartbeatResearchAccount } from "./researchAccountLease";
import { readLatestMonitoringRuns, monitoringRunIsFresh } from "./monitoringRunProgress";

vi.mock("./intentProviders", () => ({
  providerConfigured: vi.fn(async (_tenant: number, provider: string) => provider !== "newsapi"),
  providerRequestLimit: vi.fn(async () => 1000),
}));
vi.mock("../intentResearchRunner", () => ({ kickIntentResearchRunner: vi.fn() }));

let tenantId: number, clientId: number, configId: number, ids: number[];
let server: ReturnType<ReturnType<typeof express>["listen"]>, url: string;
beforeAll(async () => {
  vi.stubEnv("COPIED_DATA_SAFE_MODE", "false");
  vi.stubEnv("MONITORING_RESEARCH_ENABLED", "false");
  tenantId = (await pool.query("INSERT INTO tenants(name,slug) VALUES('Monitoring retry fixture',$1) RETURNING id", [randomUUID()])).rows[0].id;
  clientId = (await pool.query("INSERT INTO clients(tenant_id,name) VALUES($1,'Retry client') RETURNING id", [tenantId])).rows[0].id;
  ids = (await pool.query(`INSERT INTO companies(tenant_id,client_id,name)
    SELECT $1,$2,'Retry fixture '||n FROM generate_series(1,3) n RETURNING id`, [tenantId, clientId])).rows.map(r => r.id);
  configId = (await pool.query(`INSERT INTO intent_monitoring_configs(tenant_id,name,client_id,enabled,daily_limit)
    VALUES($1,'Recovery fixture',$2,false,100) RETURNING id`, [tenantId, clientId])).rows[0].id;
  const app = express();
  app.use(express.json(), (req, _res, next) => {
    (req as any).user = { id: 1, tenantId, role: req.headers["x-role"] ?? "admin" }; next();
  });
  registerMonitoringRetryRoutes(app);
  server = app.listen(0);
  await new Promise<void>(resolve => server.once("listening", resolve));
  url = `http://127.0.0.1:${(server.address() as any).port}`;
});
afterEach(async () => {
  vi.stubEnv("COPIED_DATA_SAFE_MODE", "false"); vi.stubEnv("MONITORING_RESEARCH_ENABLED", "false");
  if (tenantId) {
    await pool.query("DELETE FROM intent_research_run_accounts WHERE tenant_id=$1", [tenantId]);
    await pool.query("DELETE FROM intent_research_runs WHERE tenant_id=$1", [tenantId]);
  }
});
afterAll(async () => {
  if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  if (tenantId) {
    for (const table of ["intent_research_run_accounts", "intent_research_runs", "intent_monitoring_configs", "companies", "clients"]) {
      await pool.query(`DELETE FROM ${table} WHERE tenant_id=$1`, [tenantId]);
    }
    await pool.query("DELETE FROM tenants WHERE id=$1", [tenantId]);
  }
  vi.unstubAllEnvs();
});
async function seed(status = "partial", accountStatus = "failed", scope = configId) {
  const summary = { accountsTotal: 2, accountsCompleted: 1, accountsFailed: 1, accountsRemaining: 0,
    scheduled: true, monitoringLane: "prospect", request: { country: "India", categoryIds: [7], eventTypes: ["expansion"] } };
  const source = (await pool.query(`INSERT INTO intent_research_runs
    (tenant_id,client_id,provider,status,idempotency_key,summary,request_count,confirmed_request_count,started_at)
    VALUES($1,$2,'tavily',$3,$4,$5,17,15,NOW()-interval '30 minutes') RETURNING id`,
    [tenantId, clientId, status, `monitoring-activation:${scope}:${randomUUID()}:${clientId}:tavily-prospect`, summary])).rows[0].id;
  await pool.query(`INSERT INTO intent_research_run_accounts(tenant_id,run_id,account_id,status,started_at)
    VALUES($1,$2,$3,'completed',NOW()),($1,$2,$4,$5,NOW())`, [tenantId, source, ids[0], ids[1], accountStatus]);
  return source;
}
async function clearRecoveryQueue() {
  // This isolated fixture never starts a real worker.
  await pool.query("UPDATE intent_research_runs SET status='failed' WHERE tenant_id=$1", [tenantId]);
}
it("preserves completed results, request usage, country/categories and lineage while retrying only unfinished accounts", async () => {
  const source = await seed();
  const result = await retryMonitoringRun(tenantId, 1, configId, source, "perplexity");
  const old = (await pool.query("SELECT * FROM intent_research_runs WHERE id=$1", [source])).rows[0];
  expect(old).toMatchObject({ request_count: 17, confirmed_request_count: 15, provider: "tavily" });
  const fresh = (await pool.query("SELECT * FROM intent_research_runs WHERE id=$1", [result.runId])).rows[0];
  expect(fresh).toMatchObject({ provider: "perplexity", retry_of_id: source, status: "queued", request_limit: 1000,
    summary: { request: { country: "India", categoryIds: [7] }, accountsTotal: 1 } });
  const accounts = (await pool.query("SELECT account_id,status FROM intent_research_run_accounts WHERE run_id=$1", [result.runId])).rows;
  expect(accounts).toEqual([{ account_id: ids[1], status: "pending" }]);
  expect((await pool.query("SELECT status FROM intent_research_run_accounts WHERE run_id=$1 AND account_id=$2", [source, ids[0]])).rows[0].status).toBe("completed");
  expect(await retryMonitoringRun(tenantId, 1, configId, source, "perplexity")).toMatchObject({ runId: result.runId, duplicate: true });
  await clearRecoveryQueue();
});
it("serializes double-click retries into one linked recovery", async () => {
  const source = await seed();
  const [a, b] = await Promise.all([
    retryMonitoringRun(tenantId, 1, configId, source, "perplexity"),
    retryMonitoringRun(tenantId, 1, configId, source, "tavily"),
  ]);
  expect(a.runId).toBe(b.runId);
  expect([a.duplicate, b.duplicate].sort()).toEqual([false, true]);
  await clearRecoveryQueue();
});
it("recovers a stale queued batch, but never moves a running account", async () => {
  const source = await seed("queued", "pending");
  expect(await retryMonitoringRun(tenantId, 1, configId, source, "perplexity")).toMatchObject({ accountsQueued: 1 });
  await clearRecoveryQueue();
  const busy = await seed("running", "running");
  await expect(retryMonitoringRun(tenantId, 1, configId, busy, "perplexity")).rejects.toMatchObject({ status: 409 });
  await pool.query("UPDATE intent_research_run_accounts SET status='failed' WHERE tenant_id=$1 AND run_id=$2", [tenantId, busy]);
  await clearRecoveryQueue();
});
it("reclaims orphaned running accounts while fencing old worker heartbeats and preserving actual completed work", async () => {
  const source = await seed("running", "running");
  await pool.query(`UPDATE intent_research_run_accounts SET started_at=NOW()-interval '12 hours'
    WHERE run_id=$1 AND status='running'`, [source]);
  await pool.query(`UPDATE intent_research_runs SET summary=summary || '{"accountsCompleted":0}'::jsonb WHERE id=$1`, [source]);
  const account = (await pool.query("SELECT id,attempts FROM intent_research_run_accounts WHERE run_id=$1 AND status='running'", [source])).rows[0];
  const before = (await readLatestMonitoringRuns(tenantId, configId))[0];
  expect(before.summary).toMatchObject({ accountsCompleted: 1, accountsRemaining: 1, accountsTotal: 2 });
  expect(monitoringRunIsFresh(before)).toBe(false);
  const result = await retryMonitoringRun(tenantId, 1, configId, source, "perplexity");
  expect(result.accountsQueued).toBe(1);
  expect(await heartbeatResearchAccount(tenantId, source, account)).toBe(false);
  await expect(assertResearchAccountLease(tenantId, source, account)).rejects.toThrow("ownership changed");
  const old = (await pool.query("SELECT summary,request_count,confirmed_request_count FROM intent_research_runs WHERE id=$1", [source])).rows[0];
  expect(old).toMatchObject({ summary: { accountsCompleted: 1 }, request_count: 17, confirmed_request_count: 15 });
  const progress = (await readLatestMonitoringRuns(tenantId, configId)).find(run=>run.id===result.runId);
  expect(progress).toMatchObject({ id: result.runId, provider: "perplexity" });
  await clearRecoveryQueue();
});
it("uses live heartbeats rather than the original run start time and rejects an obsolete attempt", async () => {
  const source = await seed("running", "running");
  const account = (await pool.query("SELECT id,attempts FROM intent_research_run_accounts WHERE run_id=$1 AND status='running'", [source])).rows[0];
  expect(await heartbeatResearchAccount(tenantId, source, account)).toBe(true);
  expect(monitoringRunIsFresh((await readLatestMonitoringRuns(tenantId, configId))[0])).toBe(true);
  await expect(retryMonitoringRun(tenantId, 1, configId, source, "perplexity")).rejects.toMatchObject({ status: 409 });
  await pool.query("UPDATE intent_research_run_accounts SET attempts=attempts+1 WHERE id=$1", [account.id]);
  expect(await heartbeatResearchAccount(tenantId, source, account)).toBe(false);
  await expect(assertResearchAccountLease(tenantId, source, account)).rejects.toThrow("ownership changed");
  await pool.query("UPDATE intent_research_run_accounts SET status='failed' WHERE run_id=$1 AND status='running'", [source]);
  await clearRecoveryQueue();
});
it("blocks unavailable providers, copied-data safety, mismatched schedule and tenant", async () => {
  const source = await seed();
  await expect(retryMonitoringRun(tenantId, 1, configId, source, "newsapi")).rejects.toMatchObject({ status: 503 });
  vi.stubEnv("COPIED_DATA_SAFE_MODE", "true");
  await expect(retryMonitoringRun(tenantId, 1, configId, source, "perplexity")).rejects.toMatchObject({ status: 503 });
  vi.stubEnv("COPIED_DATA_SAFE_MODE", "false");
  const wrongScope = await seed("failed", "failed", configId + 1000000);
  await expect(retryMonitoringRun(tenantId, 1, configId, wrongScope, "perplexity")).rejects.toMatchObject({ status: 404 });
  await expect(retryMonitoringRun(tenantId + 1000000, 1, configId, source, "perplexity")).rejects.toMatchObject({ status: 404 });
});
it("enforces admin permissions, validates input and returns the configured engine list", async () => {
  const forbidden = await fetch(`${url}/intent/monitoring-configs/${configId}/retry`, {
    method: "POST", headers: { "content-type": "application/json", "x-role": "editor" }, body: "{}",
  });
  expect(forbidden.status).toBe(403);
  const invalid = await fetch(`${url}/intent/monitoring-configs/${configId}/retry`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: "unknown" }),
  });
  expect(invalid.status).toBe(400);
  const options = await fetch(`${url}/intent/monitoring-retry-options`);
  expect(await options.json()).toMatchObject({ safetyPaused: false, engines: expect.arrayContaining([
    { provider: "perplexity", label: "Perplexity / Web Search", configured: true },
    { provider: "newsapi", label: "NewsAPI", configured: false },
  ]) });
});
it("queues recovery through the admin endpoint, preserving the chosen engine and reporting its account count", async () => {
  const source = await seed();
  const response = await fetch(`${url}/intent/monitoring-configs/${configId}/retry`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ runId: source, provider: "perplexity" }),
  });
  expect(response.status).toBe(202);
  const result = await response.json() as any;
  expect(result).toMatchObject({ accountsQueued: 1, duplicate: false });
  expect((await pool.query("SELECT provider,retry_of_id FROM intent_research_runs WHERE id=$1", [result.runId])).rows[0])
    .toMatchObject({ provider: "perplexity", retry_of_id: source });
  await clearRecoveryQueue();
});
it("allows approved monitoring-only recovery while copied-data protection stays on", async () => {
  vi.stubEnv("COPIED_DATA_SAFE_MODE", "true");
  vi.stubEnv("MONITORING_RESEARCH_ENABLED", "true");
  const source = await seed();
  const options = await fetch(`${url}/intent/monitoring-retry-options`);
  expect(await options.json()).toMatchObject({ safetyPaused: false });
  expect(await retryMonitoringRun(tenantId, 1, configId, source, "perplexity")).toMatchObject({ accountsQueued: 1 });
  expect(process.env.COPIED_DATA_SAFE_MODE).toBe("true");
  await clearRecoveryQueue();
});
it("limits the research-only worker to active monitoring and explicit recovery, never unrelated copied jobs", async () => {
  const source = await seed();
  const manual = await seed();
  await pool.query("UPDATE intent_research_runs SET idempotency_key=$2 WHERE id=$1", [manual, `manual:${randomUUID()}`]);
  // A client ID that resembles an active schedule must not authorize another
  // schedule's daily run (the old wildcard scope check could do this).
  const wrongDaily = await seed();
  await pool.query("UPDATE intent_research_runs SET idempotency_key=$2 WHERE id=$1",
    [wrongDaily, `daily-monitoring:2026-10-21:${configId + 100000}:${configId}:tavily-prospect`]);
  await pool.query("UPDATE intent_monitoring_configs SET enabled=true WHERE id=$1", [configId]);
  const allowed = async () => (await pool.query(`SELECT r.id FROM intent_research_runs r WHERE r.tenant_id=$1 AND ${MONITORING_RUN_SCOPE_SQL}`, [tenantId])).rows.map(r => r.id);
  let selected = await allowed();
  expect(selected).toContain(source);
  expect(selected).not.toContain(manual);
  expect(selected).not.toContain(wrongDaily);
  await pool.query("UPDATE intent_monitoring_configs SET enabled=false WHERE id=$1", [configId]);
  expect(await allowed()).not.toContain(source);
  await clearRecoveryQueue();
  const recovery = await retryMonitoringRun(tenantId, 1, configId, source, "perplexity");
  selected = await allowed();
  expect(selected).toContain(recovery.runId);
  expect(selected).not.toContain(manual);
  await clearRecoveryQueue();
});
