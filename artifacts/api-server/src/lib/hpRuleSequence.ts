import { pool } from "@workspace/db";
import type { PoolClient } from "pg";
import { hpClientNameSql } from "./hpClientScope";
import { hpContactMayNurture, WARM_ONLY_ROUTING_MESSAGE } from "./hpNurturePolicy";

/** Independent approval: never releases copied campaigns or shared Redis jobs. */
export const hpRuleSequenceEnabled = () => process.env.HP_RULE_SEQUENCE_ROUTING_ENABLED === "true";

/** Status is evidence, not authorization. In particular, completed or unmarked
 * historical enrollments must never become permission to replay a campaign. */
export function hpRuleRoutingState(input: {
  blockedReason: string; journeyMember: boolean;
  enrollment?: { status: string; managed: boolean };
}) {
  if (input.blockedReason) return { state: "blocked" as const, nextAction: input.blockedReason };
  if (input.enrollment && (!input.enrollment.managed || input.enrollment.status !== "active"))
    return { state: "historical_enrollment" as const,
      nextAction: `Existing ${input.enrollment.status} enrollment in the exact rule sequence is retained, not adopted or restarted.${input.journeyMember ? "" : " Journey membership is missing; review the exact destination separately."}` };
  if (!input.journeyMember) return { state: "pending" as const,
    nextAction: "Review assignment to the exact saved journey. Other journey memberships do not complete this route." };
  if (!input.enrollment) return { state: "journey_only" as const,
    nextAction: "Journey membership only. Review eligibility and approval for enrollment in the exact saved sequence; this check does not enroll anyone." };
  return { state: "journey_and_sequence" as const,
    nextAction: "Journey membership and an active rule-authorized sequence enrollment exist. Delivery still requires current approval and safeguards; no restart is needed." };
}

// activity_events.metadata is legacy text, not a jsonb column. Do not attempt
// to parse unrelated historical descriptions while the planner reorders joins.
export const hpAuthorizationField = (alias:"a"|"auth", field:"ruleId"|"journeyId"|"enrollmentId") =>
  `((CASE WHEN ${alias}.event_type='hp_rule_sequence_authorized' THEN ${alias}.metadata::jsonb END)->>'${field}')`;
const authorizedProducts = `(CASE WHEN jsonb_typeof(
  CASE WHEN auth.event_type='hp_rule_sequence_authorized' THEN auth.metadata::jsonb->'products' END)='array'
  THEN auth.metadata::jsonb->'products' ELSE '[]'::jsonb END)`;

/** se and es are the enrollment/sequence aliases at each call site.
 * Only enrollments created by this policy can run in copied-data safe mode.
 */
export const hpAuthorizedEnrollmentSql = `EXISTS (
  SELECT 1 FROM activity_events auth
  JOIN intent_inbound_routing_rules r ON r.tenant_id=auth.tenant_id
    AND r.id::text=${hpAuthorizationField("auth","ruleId")}
  JOIN journeys j ON j.id=r.journey_id AND j.tenant_id=r.tenant_id AND j.client_id=r.client_id
  JOIN clients cl ON cl.id=r.client_id AND cl.tenant_id=r.tenant_id AND ${hpClientNameSql("cl.name")}
  JOIN contacts c ON c.id=auth.contact_id AND c.tenant_id=r.tenant_id AND c.client_id=r.client_id
  JOIN journey_contacts jc ON jc.contact_id=c.id AND jc.journey_id=j.id
  WHERE auth.event_type='hp_rule_sequence_authorized' AND auth.tenant_id=es.tenant_id
    AND auth.contact_id=se.contact_id AND auth.company_id=c.company_id
    AND ${hpAuthorizationField("auth","enrollmentId")}=se.id::text
    AND ${hpAuthorizationField("auth","journeyId")}=j.id::text AND r.sequence_id=se.sequence_id
    AND es.client_id=r.client_id AND es.status='active' AND j.status='published' AND r.enabled
    AND r.classification IN ('warm','all')
    AND c.status='active' AND NOT c.dnc AND NOT c.is_anonymous
    AND c.email ~ '^[^[:space:]@]+@[^[:space:]@]+\\.[^[:space:]@]+$'
    -- Old authorization markers without explicit product attribution fail closed.
    AND jsonb_array_length(${authorizedProducts})>0
    AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(${authorizedProducts}) product(value)
      WHERE NULLIF(btrim(product.value),'') IS NULL OR EXISTS(
        SELECT 1 FROM intent_inbound_submissions s WHERE s.tenant_id=c.tenant_id
          AND s.client_id=c.client_id AND s.contact_id=c.id
          AND s.affinity_reviews->>product.value='rejected'))
    AND NOT EXISTS(SELECT 1 FROM intent_inbound_submissions s WHERE s.tenant_id=c.tenant_id
      AND s.client_id=c.client_id AND s.contact_id=c.id
      AND (s.account_id IS DISTINCT FROM c.company_id OR s.identity_review='keep'
        OR s.routing_error ILIKE '%email%another account%'))
)`;

/** Caller holds the CRM deletion boundary and transaction. Historical
 * enrollments are never adopted/restarted, even if completed or errored.
 */
export async function enrollHpRuleSequence(
  db: PoolClient, tenantId: number, clientId: number, contactId: number, ruleId: number, products: string[],
) {
  if (!hpRuleSequenceEnabled()) return null;
  if (!await hpContactMayNurture(tenantId,clientId,contactId,db))
    throw new Error(WARM_ONLY_ROUTING_MESSAGE);
  const attributedProducts = [...new Set(products.map(p => p.trim()).filter(Boolean))];
  if (!attributedProducts.length) throw new Error("Approved product attribution is required for automatic sequence routing.");
  const ready = await db.query(`SELECT r.sequence_id,r.journey_id,c.company_id,
      (SELECT id FROM sequence_steps WHERE sequence_id=r.sequence_id ORDER BY step_order,id LIMIT 1) AS first_step
    FROM intent_inbound_routing_rules r
    JOIN journeys j ON j.id=r.journey_id AND j.tenant_id=r.tenant_id AND j.client_id=r.client_id
    JOIN email_sequences es ON es.id=r.sequence_id AND es.tenant_id=r.tenant_id AND es.client_id=r.client_id
    JOIN clients cl ON cl.id=r.client_id AND cl.tenant_id=r.tenant_id AND ${hpClientNameSql("cl.name")}
    JOIN contacts c ON c.tenant_id=r.tenant_id AND c.client_id=r.client_id AND c.id=$3
    WHERE r.tenant_id=$1 AND r.client_id=$2 AND r.id=$4 AND r.enabled
      AND j.status='published' AND es.status='active' AND NOT c.dnc AND NOT c.is_anonymous
      AND c.status='active' AND c.email ~ '^[^[:space:]@]+@[^[:space:]@]+\\.[^[:space:]@]+$'
      AND EXISTS(SELECT 1 FROM journey_contacts jc WHERE jc.contact_id=c.id AND jc.journey_id=j.id)
      AND NOT EXISTS(SELECT 1 FROM intent_inbound_submissions s WHERE s.tenant_id=c.tenant_id
        AND s.client_id=c.client_id AND s.contact_id=c.id
        AND EXISTS(SELECT 1 FROM unnest($5::text[]) p WHERE s.affinity_reviews->>p='rejected'))
    FOR SHARE OF r,j,es,c`, [tenantId, clientId, contactId, ruleId, attributedProducts]);
  const rule = ready.rows[0];
  if (!rule) throw new Error("Routing destination or contact is no longer eligible. Use a published journey and active same-client sequence.");
  if (!rule.first_step) throw new Error("The active sequence has no published steps. Publish its steps before automatic routing.");
  const inserted = await db.query(`INSERT INTO sequence_enrollments
    (sequence_id,contact_id,status,current_step_id,resume_at)
    SELECT $1,$2,'active',$3,NOW()
    WHERE NOT EXISTS(SELECT 1 FROM sequence_enrollments WHERE sequence_id=$1 AND contact_id=$2)
    ON CONFLICT (sequence_id,contact_id) WHERE status='active' DO NOTHING RETURNING id`,
  [rule.sequence_id, contactId, rule.first_step]);
  const id = inserted.rows[0]?.id;
  if (id) await db.query(`INSERT INTO activity_events
    (tenant_id,client_id,company_id,contact_id,journey_id,event_type,description,metadata,points_earned)
    VALUES($1,$2,$3,$4,$5,'hp_rule_sequence_authorized','Automatically enrolled through approved routing rule',$6,0)`,
  [tenantId, clientId, rule.company_id, contactId, rule.journey_id,
    JSON.stringify({ enrollmentId: id, ruleId, journeyId: rule.journey_id, sequenceId: rule.sequence_id, products: attributedProducts })]);
  return id ? Number(id) : null;
}

/** Fail closed at delivery, not merely when the runner selected its batch. */
export async function hpRuleDeliveryAllowed(enrollmentId: number, tenantId: number) {
  const result = await pool.query(`SELECT
      EXISTS(SELECT 1 FROM activity_events a WHERE a.tenant_id=es.tenant_id
        AND a.event_type='hp_rule_sequence_authorized' AND a.contact_id=se.contact_id
        AND ${hpAuthorizationField("a","enrollmentId")}=se.id::text) AS managed,
      ${hpAuthorizedEnrollmentSql} AS authorized,COALESCE(es.client_id,person.client_id) AS client_id,se.contact_id
    FROM sequence_enrollments se JOIN email_sequences es ON es.id=se.sequence_id
    JOIN contacts person ON person.id=se.contact_id AND person.tenant_id=es.tenant_id
    WHERE se.id=$1 AND es.tenant_id=$2 AND se.status='active'`, [enrollmentId, tenantId]);
  const row = result.rows[0];
  if (!row) return false;
  if (row.client_id && !await hpContactMayNurture(tenantId,Number(row.client_id),Number(row.contact_id))) return false;
  if (row.managed) return hpRuleSequenceEnabled() && row.authorized;
  return process.env.COPIED_DATA_SAFE_MODE !== "true";
}
