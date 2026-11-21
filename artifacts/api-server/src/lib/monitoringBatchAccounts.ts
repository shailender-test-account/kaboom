import { pool } from "@workspace/db";
import { monitoringBatchCtes } from "./monitoringRunProgress";
import { researchedAccountId } from "./monitoringHistory";
import { loadMonitoringCheckQuality, type MonitoringCheck } from "./monitoringCheckQuality";

export type BatchAccountStatus = "all" | "processed" | "completed" | "failed" | "remaining";
/** Same retry-aware effective accounts as the displayed latest-run counters. */
export async function monitoringBatchAccounts(tenantId: number, configId: number, runId: number,
  status: BatchAccountStatus, page: number, pageSize: number, lane?: "warm" | "prospect",
  clientIds: number[] | null = null) {
  const result = await pool.query(`${monitoringBatchCtes}, matched AS MATERIALIZED (
    SELECT a.account_id,a.status,a.completed_at,a.error,r.id AS run_id,r.provider,
      ${researchedAccountId} AS research_account_id,
      COALESCE(a.summary->>'reusedParentCheck'='true',false) AS reused_parent_check
    FROM effective_accounts a JOIN intent_research_runs r ON r.id=a.run_id AND r.tenant_id=$1
    WHERE ($4='all' OR ($4='processed' AND a.status IN ('completed','failed')) OR ($4='remaining' AND a.status NOT IN ('completed','failed')) OR a.status=$4)
      AND ($7::text IS NULL OR r.summary->>'monitoringLane'=$7)
      AND ($8::int[] IS NULL OR EXISTS (SELECT 1 FROM companies scoped
        WHERE scoped.tenant_id=$1 AND scoped.id=a.account_id AND scoped.client_id=ANY($8::int[])))
      AND ($8::int[] IS NULL OR EXISTS (SELECT 1 FROM companies scoped
        WHERE scoped.tenant_id=$1 AND scoped.id=${researchedAccountId} AND scoped.client_id=ANY($8::int[])))
  ), totals AS (SELECT count(*)::int AS total FROM matched), entries AS (
    SELECT a.*,c.name,c.id IS NOT NULL AS available FROM matched a
    LEFT JOIN companies c ON c.id=a.account_id AND c.tenant_id=$1
    ORDER BY a.account_id LIMIT $5 OFFSET $6
  )
  SELECT totals.total AS "totalAccounts",
    COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'accountId',account_id,'accountName',name,'available',available,'status',status,
      'completedAt',completed_at,'provider',provider,'runId',run_id,'error',error,
      'researchAccountId',research_account_id,'reusedParentCheck',reused_parent_check
    ) ORDER BY account_id) FROM entries),'[]'::jsonb) AS items FROM totals`,
  [tenantId, String(configId), runId, status, pageSize, (page-1)*pageSize, lane ?? null, clientIds]);
  const data = result.rows[0];
  const quality = await loadMonitoringCheckQuality(tenantId, data.items);
  const items = data.items.map((item: MonitoringCheck) => {
    const { researchAccountId, reusedParentCheck, ...account } = item;
    const assessment = quality.get(`${item.runId}:${researchAccountId ?? item.accountId}`);
    return { ...account, ...(item.status === "completed" && !reusedParentCheck && assessment
      ? { researchQuality: assessment } : {}) };
  });
  return {configId, runId, status, page, pageSize, ...data, items};
}
