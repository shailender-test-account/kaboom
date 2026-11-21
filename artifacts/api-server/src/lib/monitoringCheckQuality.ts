import { pool } from "@workspace/db";
import { monitoringFindingAnalysis } from "./monitoringFindingAnalysis";
import type { MonitoringFinding } from "./monitoredAccountContext";

export type MonitoringCheck = {
  runId: number; accountId: number; status: string;
  researchAccountId?: number; reusedParentCheck?: boolean;
};

/** Validate only sources retained by the actual check, never unrelated or newer
 * account research. Reused sibling results are not independent provider checks.
 * This is a current read model, not a historical quality snapshot. */
export async function loadMonitoringCheckQuality(tenantId: number, checks: MonitoringCheck[], now = new Date()) {
  const completed = checks.filter(check => check.status === "completed" && !check.reusedParentCheck);
  const qualities = new Map<string, ReturnType<typeof checkQuality>>();
  if (!completed.length) return qualities;
  const pairs = [...new Map(completed.map(check => {
    const accountId = check.researchAccountId ?? check.accountId;
    return [`${check.runId}:${accountId}`, { runId: check.runId, accountId }];
  })).values()];
  const result = await pool.query<{
    runId: number; accountId: number; name: string | null; domain: string | null; findings: MonitoringFinding[];
  }>(`WITH requested AS (
      SELECT * FROM unnest($2::int[],$3::int[]) AS p(run_id,account_id)
    )
    SELECT p.run_id AS "runId",p.account_id AS "accountId",c.name,c.domain,
      COALESCE(jsonb_agg(jsonb_build_object(
        'id',e.id,'excerpt',e.excerpt,'sourceUrl',e.source_url,'occurredAt',e.occurred_at,
        'eventType',e.event_type,'reviewStatus',e.review_status,'context',e.context,'raw_evidence',e.raw_evidence
      ) ORDER BY e.id) FILTER(WHERE e.id IS NOT NULL),'[]'::jsonb) AS findings
    FROM requested p
    JOIN companies c ON c.id=p.account_id AND c.tenant_id=$1
    LEFT JOIN intent_evidence e ON e.tenant_id=$1 AND e.account_id=p.account_id
      AND e.research_run_id=p.run_id AND e.evidence_kind='public_event'
    GROUP BY p.run_id,p.account_id,c.name,c.domain`,
  [tenantId, pairs.map(pair => pair.runId), pairs.map(pair => pair.accountId)]);
  for (const row of result.rows) {
    qualities.set(`${row.runId}:${row.accountId}`, checkQuality(row.accountId, row.findings, now,
      { name: row.name ?? "", domain: row.domain }));
  }
  return qualities;
}

export function checkQuality(accountId: number, findings: MonitoringFinding[], now: Date,
  identity: { name: string; domain?: string | null }) {
  const { assessedCount, usableCount, excludedCount, exclusions } = monitoringFindingAnalysis(findings, now, identity).diagnostics;
  return { accountId, assessedCount, usableCount, excludedCount, exclusions };
}
