import { pool } from "@workspace/db";

export type MonitoringRunProgress = {
  id: number; provider: string; status: string; startedAt: Date; lastActivityAt: Date;
  completedAt: Date | null; summary: Record<string, unknown>;
};

export function monitoringRunIsFresh(run: Pick<MonitoringRunProgress, "status" | "lastActivityAt">, now = Date.now()) {
  return (run.status === "queued" || run.status === "running")
    && new Date(run.lastActivityAt).getTime() >= now - 15 * 60_000;
}

/** $3 optionally pins a displayed run, so drilldowns never switch batches. */
export const monitoringBatchCtes = `WITH RECURSIVE latest_run AS (
       SELECT id,retry_of_id,idempotency_key
         FROM intent_research_runs WHERE tenant_id=$1
          AND ((split_part(idempotency_key,':',1)='monitoring-activation' AND split_part(idempotency_key,':',2)=$2)
            OR (split_part(idempotency_key,':',1)='daily-monitoring' AND split_part(idempotency_key,':',3)=$2))
          AND ($3::int IS NULL OR id=$3)
        ORDER BY started_at DESC,id DESC LIMIT 1
     ), ancestors AS (
       SELECT * FROM latest_run
       UNION
       SELECT r.id,r.retry_of_id,r.idempotency_key FROM intent_research_runs r
         JOIN ancestors a ON a.retry_of_id=r.id WHERE r.tenant_id=$1
     ), latest_batch AS (
       SELECT regexp_replace(idempotency_key, ':[^:]+:[^:]+$', '') AS batch_key
         FROM ancestors WHERE retry_of_id IS NULL
     ), family AS (
       SELECT r.id FROM intent_research_runs r CROSS JOIN latest_batch b
         WHERE r.tenant_id=$1 AND r.retry_of_id IS NULL
           AND regexp_replace(r.idempotency_key, ':[^:]+:[^:]+$', '')=b.batch_key
       UNION
       SELECT r.id FROM intent_research_runs r JOIN family f ON r.retry_of_id=f.id
         WHERE r.tenant_id=$1
     ), effective_accounts AS MATERIALIZED (
       SELECT DISTINCT ON(a.account_id) a.*
         FROM intent_research_run_accounts a JOIN family f ON f.id=a.run_id
         JOIN intent_research_runs attempt ON attempt.tenant_id=a.tenant_id AND attempt.id=a.run_id
         WHERE a.tenant_id=$1
         ORDER BY a.account_id,attempt.started_at DESC,attempt.id DESC
     )`;

export async function readLatestMonitoringRuns(tenantId: number, configId: number) {
  return (await pool.query<MonitoringRunProgress>(
    `${monitoringBatchCtes}
     SELECT r.id,r.provider,
       CASE WHEN progress.remaining>0 THEN r.status
         WHEN progress.failed>0 THEN CASE WHEN progress.completed>0 THEN 'partial' ELSE 'failed' END
         WHEN progress.total>0 OR EXISTS(SELECT 1 FROM intent_research_run_accounts a WHERE a.tenant_id=r.tenant_id AND a.run_id=r.id)
           THEN 'completed'
         ELSE r.status END AS status,
       r.started_at AS "startedAt",r.completed_at AS "completedAt",
       GREATEST(r.started_at,progress.last_activity_at) AS "lastActivityAt",
       r.summary || jsonb_build_object(
         'accountsTotal',progress.total,'accountsCompleted',progress.completed,
         'accountsFailed',progress.failed,'accountsRemaining',progress.remaining)
         || CASE WHEN r.retry_of_id IS NOT NULL THEN jsonb_build_object(
           'retryOfId',r.retry_of_id,'laneCounts',jsonb_build_object('eligible',0,'scheduled',0,'deferred',0))
           ELSE '{}'::jsonb END AS summary
       FROM intent_research_runs r JOIN family f ON f.id=r.id
       LEFT JOIN LATERAL (
         SELECT count(*)::int AS total,
           count(*) FILTER(WHERE a.status='completed')::int AS completed,
           count(*) FILTER(WHERE a.status='failed')::int AS failed,
           count(*) FILTER(WHERE a.status NOT IN ('completed','failed'))::int AS remaining,
           GREATEST(max(a.started_at) FILTER(WHERE a.status IN ('running','claimed')),max(a.completed_at)) AS last_activity_at
         FROM effective_accounts a WHERE a.tenant_id=r.tenant_id AND a.run_id=r.id
       ) progress ON true
      WHERE r.tenant_id=$1
      ORDER BY r.started_at,r.id`, [tenantId, String(configId), null],
  )).rows;
}
