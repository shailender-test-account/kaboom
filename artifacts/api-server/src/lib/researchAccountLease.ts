import { pool } from "@workspace/db";

export const RESEARCH_ACCOUNT_LEASE_MS = 10 * 60_000;
export const RESEARCH_ACCOUNT_HEARTBEAT_MS = 30_000;

export class ResearchAccountLeaseLost extends Error {
  constructor() { super("Research account ownership changed; the old worker must stop."); }
}

export function researchAccountIsLive(status: string, heartbeat: Date | string | null, now = Date.now()) {
  return (status === "running" || status === "claimed") && heartbeat != null
    && new Date(heartbeat).getTime() >= now - RESEARCH_ACCOUNT_LEASE_MS;
}

export type AccountLease = { id: number; attempts: number };

export async function heartbeatResearchAccount(tenantId: number, runId: number, account: AccountLease) {
  const result = await pool.query(`UPDATE intent_research_run_accounts a SET started_at=NOW()
    WHERE a.tenant_id=$1 AND a.run_id=$2 AND a.id=$3 AND a.attempts=$4 AND a.status='running'
      AND EXISTS(SELECT 1 FROM intent_research_runs r WHERE r.tenant_id=$1 AND r.id=$2 AND r.status IN ('queued','running'))
    RETURNING a.id`, [tenantId, runId, account.id, account.attempts]);
  return !!result.rowCount;
}

export async function assertResearchAccountLease(tenantId: number, runId: number, account: AccountLease) {
  const current = await pool.query(`SELECT 1 FROM intent_research_run_accounts a
    WHERE a.tenant_id=$1 AND a.run_id=$2 AND a.id=$3 AND a.attempts=$4 AND a.status='running'
      AND a.started_at >= NOW()-interval '10 minutes'
      AND EXISTS(SELECT 1 FROM intent_research_runs r WHERE r.tenant_id=$1 AND r.id=$2 AND r.status IN ('queued','running'))`,
    [tenantId, runId, account.id, account.attempts]);
  if (!current.rowCount) throw new ResearchAccountLeaseLost();
}
