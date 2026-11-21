import { pool } from "@workspace/db";
import { inboundRoutingAuditTargets, matchingInboundRoutingRule, type InboundRoutingRule } from "./inboundAccounts";
import { loadInboundCategoryRules } from "./inboundTaxonomy";
import { hpAuthorizationField, hpRuleRoutingState } from "./hpRuleSequence";
import { warmRoutingCandidates, type HpPriorityEvidence } from "./hpAccountPriorityData";
import type { ImportCatalogProduct } from "./intentImportProductMatching";

type AuditRule = InboundRoutingRule & {
  journey_name: string | null; journey_status: string | null;
  sequence_name: string | null; sequence_status: string | null;
  has_steps: boolean;
};

/** Bounded by the displayed account IDs. All reads: never repair old routed
 * flags, enroll, authorize or restart while loading a status page. */
export async function loadHpRoutingAudit(tenantId: number, clientId: number, accountIds: number[], evidence: HpPriorityEvidence) {
  const [rules, submissions, contacts, memberships, enrollments, categories, catalog] = await Promise.all([
    pool.query<AuditRule>(`SELECT r.*,j.name AS journey_name,j.status AS journey_status,
        es.name AS sequence_name,es.status AS sequence_status,
        EXISTS(SELECT 1 FROM sequence_steps st WHERE st.sequence_id=es.id) AS has_steps,
        COALESCE(r.inbound_product_name,p.name) AS product_name,
        COALESCE(r.inbound_category_name,pc.name) AS category_name
      FROM intent_inbound_routing_rules r
      LEFT JOIN journeys j ON j.id=r.journey_id AND j.tenant_id=r.tenant_id AND j.client_id=r.client_id
      LEFT JOIN email_sequences es ON es.id=r.sequence_id AND es.tenant_id=r.tenant_id AND es.client_id=r.client_id
      LEFT JOIN intent_products p ON p.id=r.product_id AND p.tenant_id=r.tenant_id
      LEFT JOIN intent_product_categories pc ON pc.id=r.category_id AND pc.tenant_id=r.tenant_id
      WHERE r.tenant_id=$1 AND r.client_id=$2 ORDER BY r.priority,r.id`, [tenantId, clientId]),
    pool.query(`SELECT s.id,s.account_id,s.contact_id,s.product_interest,s.classification,s.affinity_reviews,s.identity_review
      FROM intent_inbound_submissions s
      WHERE s.tenant_id=$1 AND s.client_id=$2 AND s.account_id=ANY($3::int[])`, [tenantId, clientId, accountIds]),
    pool.query(`SELECT c.id,c.company_id,c.dnc,c.status,c.email,c.is_anonymous,
        EXISTS(SELECT 1 FROM intent_inbound_submissions s WHERE s.tenant_id=c.tenant_id
          AND s.client_id=c.client_id AND s.contact_id=c.id
          AND (s.account_id IS DISTINCT FROM c.company_id OR s.identity_review='keep'
            OR (s.identity_review='relink' AND lower(btrim(c.email)) IS DISTINCT FROM lower(btrim(s.reviewed_email)))
            OR s.routing_error ILIKE '%email%another account%')) AS identity_blocked
      FROM contacts c WHERE c.tenant_id=$1 AND c.client_id=$2 AND c.company_id=ANY($3::int[])`,
    [tenantId, clientId, accountIds]),
    pool.query(`SELECT jc.contact_id,jc.journey_id FROM journey_contacts jc
      JOIN journeys j ON j.id=jc.journey_id JOIN contacts c ON c.id=jc.contact_id
      WHERE c.tenant_id=$1 AND c.client_id=$2 AND c.company_id=ANY($3::int[])
        AND j.tenant_id=c.tenant_id AND j.client_id=c.client_id`, [tenantId, clientId, accountIds]),
    pool.query(`SELECT se.id,se.contact_id,se.sequence_id,se.status,
        a.metadata::jsonb AS authorization
      FROM sequence_enrollments se JOIN contacts c ON c.id=se.contact_id
      JOIN email_sequences es ON es.id=se.sequence_id AND es.tenant_id=c.tenant_id AND es.client_id=c.client_id
      LEFT JOIN LATERAL (SELECT a.metadata FROM activity_events a
        WHERE a.tenant_id=c.tenant_id AND a.client_id=c.client_id AND a.contact_id=c.id
          AND a.company_id=c.company_id AND a.event_type='hp_rule_sequence_authorized'
          AND ${hpAuthorizationField("a", "enrollmentId")}=se.id::text LIMIT 1) a ON true
      WHERE c.tenant_id=$1 AND c.client_id=$2 AND c.company_id=ANY($3::int[])
      ORDER BY se.enrolled_at DESC,se.id DESC`, [tenantId, clientId, accountIds]),
    loadInboundCategoryRules(tenantId),
    pool.query<ImportCatalogProduct>(`SELECT p.id,p.name,c.name AS category,sub.name AS subcategory
      FROM intent_products p JOIN intent_product_categories c ON c.id=p.category_id AND c.tenant_id=p.tenant_id
      LEFT JOIN intent_product_subcategories sub ON sub.id=p.subcategory_id AND sub.tenant_id=p.tenant_id
      WHERE p.tenant_id=$1 AND p.active=true`, [tenantId]),
  ]);
  const targets = submissions.rows.flatMap(s => inboundRoutingAuditTargets(s, rules.rows, clientId, categories, catalog.rows)
    .map(t => ({ ...t, submissionId: Number(s.id) as number | null, accountId: Number(s.account_id),
      contactId: s.contact_id == null ? null : Number(s.contact_id), identityReview: s.identity_review })));
  // Include eligible Overall-Warm contacts without inventing a form submission.
  for (const candidate of warmRoutingCandidates(evidence, new Set(accountIds))) {
    if (targets.some(t => t.contactId === candidate.contactId && t.product === candidate.product)) continue;
    targets.push({ ...candidate, submissionId: null as number | null, identityReview: null,
      rejected: false, rule: matchingInboundRoutingRule(rules.rows, clientId, candidate.product, "warm", [], candidate.overrides, categories) });
  }
  return targets.map(target => {
    const rule = target.rule as AuditRule | undefined;
    const contact = contacts.rows.find(c => Number(c.id) === target.contactId && Number(c.company_id) === target.accountId);
    const rejected = target.rejected || submissions.rows.some(s => Number(s.contact_id) === target.contactId
      && s.affinity_reviews?.[target.product] === "rejected");
    const blockedReason = !contact || contact.identity_blocked || target.identityReview === "keep"
      ? "Review contact identity and account ownership before routing."
      : rejected ? "Product interest was rejected in review. Resolve the review; do not override it to route."
      : contact.dnc ? "Do not contact. Keep suppression in place."
      : contact.is_anonymous || contact.status !== "active" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact.email ?? "")
      ? "Review active contact status and valid email before routing."
      : !rule?.enabled || !rule.journey_id || rule.journey_status !== "published" || rule.sequence_status !== "active" || !rule.has_steps
      ? "Configure the applicable enabled rule with a published same-client journey and an active same-client sequence with published steps. Do not substitute another destination."
      : "";
    const enrollment = enrollments.rows.find(e => Number(e.contact_id) === target.contactId && Number(e.sequence_id) === rule?.sequence_id);
    const auth = enrollment?.authorization;
    const managed = Boolean(auth && Number(auth.ruleId) === rule?.id && Number(auth.journeyId) === rule?.journey_id
      && Number(auth.sequenceId) === rule?.sequence_id && Array.isArray(auth.products) && auth.products.includes(target.product));
    const journeyMember = memberships.rows.some(m => Number(m.contact_id) === target.contactId && Number(m.journey_id) === rule?.journey_id);
    return { accountId: target.accountId, submissionId: target.submissionId, contactId: target.contactId,
      product: target.product || "No product answer", ruleId: rule?.id ?? null,
      journeyId: rule?.journey_id ?? null, journeyName: rule?.journey_name ?? null,
      sequenceId: rule?.sequence_id ?? null, sequenceName: rule?.sequence_name ?? null,
      enrollmentStatus: enrollment?.status ?? null,
      ...hpRuleRoutingState({ blockedReason: blockedReason && enrollment
        ? `${blockedReason} Existing ${enrollment.status} enrollment is retained, never adopted or restarted by this check.`
        : blockedReason, journeyMember, enrollment: enrollment && { status: enrollment.status, managed } }) };
  });
}
