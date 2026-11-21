/** Separate research permission from the copied-data pause on other automation. */
export function copiedDataSafetyEnabled() {
  return process.env.COPIED_DATA_SAFE_MODE === "true";
}

export function monitoringResearchAllowed() {
  return !copiedDataSafetyEnabled() || process.env.MONITORING_RESEARCH_ENABLED === "true";
}

// Used only with the fixed "r" SQL alias. A research-only exception must not
// release unrelated manual research or policy-rebuild work from a copied DB.
export const MONITORING_RUN_SCOPE_SQL = `(
  r.summary->>'scheduled'='true'
  AND EXISTS (
    SELECT 1 FROM intent_monitoring_configs c
    WHERE c.tenant_id=r.tenant_id
      AND (c.enabled=true OR r.retry_of_id IS NOT NULL)
      AND ((split_part(r.idempotency_key,':',1)='monitoring-activation'
            AND split_part(r.idempotency_key,':',2)=c.id::text)
        OR (split_part(r.idempotency_key,':',1)='daily-monitoring'
            AND split_part(r.idempotency_key,':',3)=c.id::text))
  )
)`;
