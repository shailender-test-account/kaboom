import { pool } from "@workspace/db";
import { providerConfigured, providerRequestLimit, type ResearchProvider } from "./intentProviders";
import { monitoringResearchAllowed } from "./monitoringResearchPolicy";
import { researchAccountIsLive } from "./researchAccountLease";
import { guardMonitoringConnection } from "./monitoringConnection";

export const MONITORING_ENGINES: { provider: ResearchProvider; label: string }[] = [
  { provider: "perplexity", label: "Perplexity / Web Search" },
  { provider: "tavily", label: "Tavily" },
  { provider: "newsapi", label: "NewsAPI" },
  { provider: "explorium", label: "Explorium" },
];

export class MonitoringRetryError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

/** Keep the old run and its usage intact; recovery is a separate, linked run. */
export async function retryMonitoringRun(tenantId: number, userId: number, configId: number, sourceId: number, provider: ResearchProvider) {
  if (!monitoringResearchAllowed()) throw new MonitoringRetryError(503, "Monitoring research is paused by copied-data safety mode. No retry was started.");
  if (!await providerConfigured(tenantId, provider)) throw new MonitoringRetryError(503, "The selected engine is not configured. Choose another engine.");
  const requestLimit = await providerRequestLimit(tenantId, provider);
  const c = await pool.connect();
  const connection = guardMonitoringConnection(c, "retry monitoring");
  try {
    await c.query("BEGIN");
    await c.query("SELECT pg_advisory_xact_lock($1,$2)", [73421, tenantId]);
    const config = await c.query("SELECT id FROM intent_monitoring_configs WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [tenantId, configId]);
    if (!config.rowCount) throw new MonitoringRetryError(404, "Monitoring schedule not found.");
    const source = (await c.query<{
      id: number; client_id: number | null; status: string; started_at: Date;
      summary: Record<string, any>;
    }>(`SELECT id,client_id,status,started_at,summary FROM intent_research_runs
      WHERE tenant_id=$1 AND id=$2
        AND ((split_part(idempotency_key,':',1)='monitoring-activation' AND split_part(idempotency_key,':',2)=$3)
          OR (split_part(idempotency_key,':',1)='daily-monitoring' AND split_part(idempotency_key,':',3)=$3)) FOR UPDATE`,
      [tenantId, sourceId, String(configId)])).rows[0];
    if (!source) throw new MonitoringRetryError(404, "Source run does not belong to this monitoring schedule.");
    const prior = (await c.query<{ id: number; summary: Record<string, any> }>(
      "SELECT id,summary FROM intent_research_runs WHERE tenant_id=$1 AND retry_of_id=$2 ORDER BY id LIMIT 1",
      [tenantId, sourceId])).rows[0];
    if (prior) {
      await c.query("COMMIT");
      connection.check();
      return { runId: prior.id, accountsQueued: Number(prior.summary?.accountsTotal ?? 0), duplicate: true };
    }
    const stale = new Date(source.started_at).getTime() < Date.now() - 15 * 60_000;
    if (!["failed", "partial"].includes(source.status) && !(stale && ["queued", "running"].includes(source.status))) {
      throw new MonitoringRetryError(409, "This run is still active or has already completed. Refresh its progress before retrying.");
    }
    // Lock queue rows before retiring expired claims. Fresh worker heartbeats
    // block recovery; old attempts lose ownership when their rows are retired.
    const unfinished = (await c.query<{ id: number; account_id: number; status: string; started_at: Date | null }>(
      `SELECT id,account_id,status,started_at FROM intent_research_run_accounts
       WHERE tenant_id=$1 AND run_id=$2 AND status<>'completed' ORDER BY id FOR UPDATE`,
      [tenantId, sourceId])).rows;
    if (!unfinished.length) throw new MonitoringRetryError(409, "There are no unfinished accounts to retry.");
    if (unfinished.some(row => researchAccountIsLive(row.status, row.started_at))) {
      throw new MonitoringRetryError(409, "Some accounts are still being processed. Wait for them to finish before switching engines.");
    }
    const ids = unfinished.map(row => row.account_id);
    const scoped = await c.query(`SELECT id FROM companies WHERE tenant_id=$1 AND id=ANY($2::int[])
      AND client_id=$3`, [tenantId, ids, source.client_id]);
    if (scoped.rowCount !== ids.length) throw new MonitoringRetryError(409, "Some accounts changed client ownership. Review the schedule before retrying.");
    const overlapping = await c.query(`SELECT 1 FROM intent_research_run_accounts a
      JOIN intent_research_runs r ON r.tenant_id=a.tenant_id AND r.id=a.run_id
      WHERE a.tenant_id=$1 AND a.account_id=ANY($2::int[]) AND a.run_id<>$3
        AND a.status IN ('pending','claimed','running') AND r.status IN ('queued','running') LIMIT 1`,
      [tenantId, ids, sourceId]);
    if (overlapping.rowCount) throw new MonitoringRetryError(409, "These accounts are already queued in another run. Refresh before retrying.");
    const lane = source.summary?.monitoringLane === "warm" ? "warm" : "prospect";
    const summary = {
      request: { ...source.summary?.request, accountIds: ids },
      monitoringLane: lane, scheduled: true, retryOfId: sourceId,
      laneCounts: { eligible: ids.length, scheduled: ids.length, completed: 0, failed: 0, deferred: 0 },
      accountsTotal: ids.length, accountsCompleted: 0, accountsRemaining: ids.length, accountsFailed: 0,
      cost: { provider, billableRequests: 0, unit: "provider_request" },
    };
    const key = `monitoring-activation:${configId}:retry-${sourceId}:${source.client_id}:${provider}-${lane}`;
    const created = await c.query<{ id: number }>(`INSERT INTO intent_research_runs
      (tenant_id,client_id,provider,status,idempotency_key,retry_of_id,requested_by,request_limit,summary)
      VALUES($1,$2,$3,'queued',$4,$5,$6,$7,$8) RETURNING id`,
      [tenantId, source.client_id, provider, key, sourceId, userId, requestLimit, summary]);
    const runId = created.rows[0].id;
    await c.query(`INSERT INTO intent_research_run_accounts(tenant_id,run_id,account_id,status)
      SELECT $1,$2,x,'pending' FROM unnest($3::int[]) x`, [tenantId, runId, ids]);
    await c.query(`UPDATE intent_research_run_accounts SET status='failed',completed_at=NOW(),
      error='Superseded by admin-selected monitoring recovery'
      WHERE tenant_id=$1 AND run_id=$2 AND status<>'completed'`, [tenantId, sourceId]);
    await c.query(`UPDATE intent_research_runs SET status=CASE WHEN EXISTS(
      SELECT 1 FROM intent_research_run_accounts a WHERE a.tenant_id=$1 AND a.run_id=$2 AND a.status='completed'
      ) THEN 'partial' ELSE 'failed' END,completed_at=NOW(),
      summary=summary || jsonb_build_object('recoveryRunId',$3::int,'accountsRemaining',0,'accountsFailed',$4::int,
        'accountsCompleted',(SELECT count(*) FROM intent_research_run_accounts a
          WHERE a.tenant_id=$1 AND a.run_id=$2 AND a.status='completed'))
      WHERE tenant_id=$1 AND id=$2`,
      [tenantId, sourceId, runId, ids.length]);
    await c.query("COMMIT");
    connection.check();
    return { runId, accountsQueued: ids.length, duplicate: false };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally { connection.release(); }
}
