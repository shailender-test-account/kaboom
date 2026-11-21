import { pool } from "@workspace/db";
import { loadMonitoringCheckQuality } from "./monitoringCheckQuality";

// Shared by the summary and drilldown. $3 is always the optional schedule ID.
const monitoringScope = `
  r.tenant_id=$1
  AND split_part(r.idempotency_key,':',1) IN ('monitoring-activation','daily-monitoring')
  AND ($3::text IS NULL
    OR (split_part(r.idempotency_key,':',1)='monitoring-activation' AND split_part(r.idempotency_key,':',2)=$3)
    OR (split_part(r.idempotency_key,':',1)='daily-monitoring' AND split_part(r.idempotency_key,':',3)=$3))
  AND a.status IN ('completed','failed') AND a.completed_at IS NOT NULL
  AND a.summary->>'reusedParentCheck' IS DISTINCT FROM 'true'
  AND (a.status<>'failed' OR COALESCE(a.error,'') NOT LIKE 'Superseded by admin-selected monitoring recovery%')`;

// Count the entity actually researched, not every sibling that reused its result.
export const researchedAccountId = `CASE WHEN a.summary->'researchSubject'->>'scope'='parent'
  AND a.summary->'researchSubject'->>'accountId' ~ '^[0-9]{1,9}$'
  THEN (a.summary->'researchSubject'->>'accountId')::int ELSE a.account_id END`;

/** Completion-day reporting, not scheduled capacity or run summary estimates.
 * An account is distinct per day/range even if several engines check it. */
export async function monitoringHistory(tenantId: number, days: number, configId?: number, clientIds: number[] | null = null) {
  const result = await pool.query(`WITH bounds AS (
      SELECT (NOW() AT TIME ZONE 'Asia/Kolkata')::date AS today
    ), tracked AS MATERIALIZED (
      SELECT ${researchedAccountId} AS account_id,a.status,
        (a.completed_at AT TIME ZONE 'Asia/Kolkata')::date AS day
      FROM intent_research_runs r JOIN intent_research_run_accounts a
        ON a.run_id=r.id AND a.tenant_id=r.tenant_id CROSS JOIN bounds b
      WHERE ${monitoringScope}
        AND ($4::int[] IS NULL OR EXISTS (SELECT 1 FROM companies scoped
          WHERE scoped.tenant_id=r.tenant_id AND scoped.id=${researchedAccountId}
            AND scoped.client_id=ANY($4::int[])))
        AND a.completed_at >= ((b.today-($2::int-1))::timestamp AT TIME ZONE 'Asia/Kolkata')
        AND a.completed_at < ((b.today+1)::timestamp AT TIME ZONE 'Asia/Kolkata')
    ), daily AS (
      SELECT day,count(DISTINCT account_id) FILTER(WHERE status='completed')::int AS completed_accounts,
        count(*) FILTER(WHERE status='completed')::int AS completed_checks,
        count(*) FILTER(WHERE status='failed')::int AS failed_checks FROM tracked GROUP BY day
    ), totals AS (
      SELECT count(DISTINCT account_id) FILTER(WHERE status='completed')::int AS total_accounts,
        count(*) FILTER(WHERE status='completed')::int AS total_checks,
        count(*) FILTER(WHERE status='failed')::int AS total_failed FROM tracked
    )
    SELECT to_char(b.today-series.day,'YYYY-MM-DD') AS date,
      COALESCE(d.completed_accounts,0) AS "completedAccounts",
      COALESCE(d.completed_checks,0) AS "completedChecks",
      COALESCE(d.failed_checks,0) AS "failedChecks",
      t.total_accounts AS "totalCompletedAccounts",t.total_checks AS "totalCompletedChecks",t.total_failed AS "totalFailedChecks"
    FROM bounds b CROSS JOIN generate_series(0,$2::int-1) series(day) CROSS JOIN totals t
    LEFT JOIN daily d ON d.day=b.today-series.day ORDER BY date DESC`,
  [tenantId, days, configId == null ? null : String(configId), clientIds]);
  const first = result.rows[0];
  return { timeZone: "Asia/Kolkata", days,
    totalCompletedAccounts: Number(first?.totalCompletedAccounts ?? 0),
    totalCompletedChecks: Number(first?.totalCompletedChecks ?? 0),
    totalFailedChecks: Number(first?.totalFailedChecks ?? 0),
    items: result.rows.map(({date,completedAccounts,completedChecks,failedChecks}) =>
      ({date,completedAccounts,completedChecks,failedChecks})),
  };
}

/** Page distinct account IDs before expanding attempts. Both status views show
 * all that account's checks on the day, so a later success cannot hide failure. */
export async function monitoringHistoryAccounts(tenantId: number, date: string,
  status: "completed" | "failed", page: number, pageSize: number, configId?: number, endDate?: string,
  clientIds: number[] | null = null) {
  const result = await pool.query(`WITH tracked AS MATERIALIZED (
    SELECT ${researchedAccountId} AS account_id,a.status,a.completed_at,r.id AS run_id,r.provider
    FROM intent_research_runs r JOIN intent_research_run_accounts a
      ON a.run_id=r.id AND a.tenant_id=r.tenant_id
    WHERE ${monitoringScope}
      AND ($8::int[] IS NULL OR EXISTS (SELECT 1 FROM companies scoped
        WHERE scoped.tenant_id=r.tenant_id AND scoped.id=${researchedAccountId}
          AND scoped.client_id=ANY($8::int[])))
      AND a.completed_at >= ($2::date::timestamp AT TIME ZONE 'Asia/Kolkata')
      AND a.completed_at < ((COALESCE($7::date,$2::date)+1)::timestamp AT TIME ZONE 'Asia/Kolkata')
  ), matched AS (
    SELECT account_id,count(*)::int AS checks FROM tracked WHERE status=$4 GROUP BY account_id
  ), totals AS (
    SELECT count(*)::int AS accounts,COALESCE(sum(checks),0)::int AS checks FROM matched
  ), page AS (
    SELECT account_id FROM matched ORDER BY account_id LIMIT $5 OFFSET $6
  )
  SELECT totals.accounts AS "totalAccounts",totals.checks AS "totalChecks",
    COALESCE((SELECT jsonb_agg(item ORDER BY account_id) FROM (
      SELECT p.account_id,jsonb_build_object(
        'accountId',p.account_id,'accountName',c.name,
        'completedChecks',count(*) FILTER(WHERE t.status='completed'),
        'failedChecks',count(*) FILTER(WHERE t.status='failed'),
        'attempts',jsonb_agg(jsonb_build_object('runId',t.run_id,'provider',t.provider,
          'status',t.status,'completedAt',t.completed_at) ORDER BY t.completed_at,t.run_id)
      ) AS item FROM page p JOIN tracked t ON t.account_id=p.account_id
      LEFT JOIN companies c ON c.id=p.account_id AND c.tenant_id=$1
      GROUP BY p.account_id,c.name
    ) entries),'[]'::jsonb) AS items FROM totals`,
  [tenantId,date,configId == null ? null : String(configId),status,pageSize,(page-1)*pageSize,endDate ?? null,clientIds]);
  const data = result.rows[0];
  const quality = await loadMonitoringCheckQuality(tenantId, data.items.flatMap((account: any) =>
    account.attempts.map((attempt: any) => ({ ...attempt, accountId: account.accountId }))));
  const items = data.items.map((account: any) => ({ ...account, attempts: account.attempts.map((attempt: any) => ({
    ...attempt, ...(attempt.status === "completed" && quality.has(`${attempt.runId}:${account.accountId}`)
      ? { researchQuality: quality.get(`${attempt.runId}:${account.accountId}`) } : {}),
  })) }));
  return { date, timeZone: "Asia/Kolkata", status, page, pageSize, ...data, items };
}
