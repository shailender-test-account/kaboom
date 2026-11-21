import { pool } from "@workspace/db";
import { canonicalInboundSubmissionSql } from "./inboundSubmissionDuplicates";
import { hpLeadStatus, positiveProduct } from "./hpBiImport";

/** GTM qualification is all-response account context, never a fiscal activity. */
export async function loadHpGtmQualification(tenantId: number, clientId: number) {
  const result = await pool.query(`SELECT s.id,s.account_id,s.contact_id,s.form_type,s.classification,s.product_interest,s.affinity_reviews,s.purchase_timeframe_months,
      COALESCE(s.submitted_at,s.created_at) AS submitted_at,s.file_name,s.routing_status,
      j.id AS routed_journey_id,j.name AS routed_journey_name,
      CASE WHEN s.raw_fields ? '__submissionDateOverride' THEN 'edited'
        WHEN s.submitted_at IS NULL OR s.raw_fields->>'__submissionDateOrigin'='upload' THEN 'upload' ELSE 'source' END AS date_origin
    FROM intent_inbound_submissions s JOIN companies c
      ON c.id=s.account_id AND c.tenant_id=s.tenant_id AND c.client_id=s.client_id
    LEFT JOIN intent_inbound_manual_routes mr ON mr.submission_id=s.id AND mr.tenant_id=s.tenant_id
    LEFT JOIN intent_inbound_routing_rules rule ON rule.id=s.routed_rule_id
      AND rule.tenant_id=s.tenant_id AND rule.client_id=s.client_id
    LEFT JOIN journeys j ON j.id=CASE WHEN mr.id IS NOT NULL THEN mr.journey_id ELSE rule.journey_id END
      AND j.tenant_id=s.tenant_id AND j.client_id=s.client_id AND s.routing_status='routed'
      AND (mr.id IS NULL OR mr.contact_id=s.contact_id)
    WHERE s.tenant_id=$1 AND s.client_id=$2
      AND ${canonicalInboundSubmissionSql("s")}
      AND COALESCE(s.identity_review,'')<>'keep'
      AND COALESCE(s.routing_error,'') NOT ILIKE '%email%another account%'
      AND (s.contact_id IS NULL OR EXISTS(SELECT 1 FROM contacts ct WHERE ct.id=s.contact_id
        AND ct.tenant_id=s.tenant_id AND ct.client_id=s.client_id AND ct.company_id=s.account_id AND NOT ct.is_anonymous))
    ORDER BY s.submitted_at DESC NULLS LAST,s.id DESC`, [tenantId, clientId]);
  const sourceByAccount = new Map<number, typeof result.rows>();
  const byAccount = new Map<number, typeof result.rows>();
  for (const row of result.rows) {
    const id = Number(row.account_id);
    if (!sourceByAccount.has(id)) sourceByAccount.set(id, []);
    sourceByAccount.get(id)!.push(row);
    if (!String(row.product_interest ?? "").split(/[,;|\n]/).some(selection =>
      positiveProduct(selection) && row.affinity_reviews?.[selection.trim()] !== "rejected")) continue;
    const status = hpLeadStatus(row.product_interest, row.purchase_timeframe_months);
    row.status = status === "hot" ? "Hot" : status === "warm" ? "Warm" : "Cold";
    if (!byAccount.has(id)) byAccount.set(id, []);
    byAccount.get(id)!.push(row);
  }
  const summarize = (ids: Set<number>) => {
    const formTypes = [...new Set([...ids].flatMap(id => (sourceByAccount.get(id) ?? [])
      .map(row => row.form_type as string)))].filter(type => type === "lead_form" || type === "event_feedback").sort();
    let inboundAccounts = 0, inboundResponses = 0, inboundHotAccounts = 0, inboundWarmAccounts = 0, inboundColdAccounts = 0;
    let inboundHotResponses = 0, inboundWarmResponses = 0, inboundColdResponses = 0, inboundUnclassifiedResponses = 0;
    let hotAccounts = 0, warmAccounts = 0, coldAccounts = 0, responses = 0, undatedResponses = 0, uploadDateResponses = 0;
    for (const id of ids) {
      const sourceRows = sourceByAccount.get(id) ?? [];
      if (sourceRows.length) {
        inboundAccounts++;
        inboundResponses += sourceRows.length;
        inboundHotResponses += sourceRows.filter(r => r.classification === "hot").length;
        inboundWarmResponses += sourceRows.filter(r => r.classification === "warm").length;
        inboundColdResponses += sourceRows.filter(r => r.classification === "cold").length;
        inboundUnclassifiedResponses += sourceRows.filter(r => !["hot", "warm", "cold"].includes(r.classification)).length;
        if (sourceRows.some(r => r.classification === "hot")) inboundHotAccounts++;
        else if (sourceRows.some(r => r.classification === "warm")) inboundWarmAccounts++;
        else if (sourceRows.some(r => r.classification === "cold")) inboundColdAccounts++;
      }
      const rows = byAccount.get(id) ?? [];
      if (rows.some(r => r.status === "Hot")) hotAccounts++;
      else if (rows.some(r => r.status === "Warm")) warmAccounts++;
      else coldAccounts++;
      responses += rows.length;
      undatedResponses += rows.filter(r => !r.submitted_at).length;
      uploadDateResponses += rows.filter(r => r.date_origin === "upload").length;
    }
    return { formTypes, status: hotAccounts ? "Hot" : warmAccounts ? "Warm" : "Cold",
      inboundStatus: inboundHotAccounts ? "Hot" : inboundWarmAccounts ? "Warm" : inboundColdAccounts ? "Cold" : "Unclassified",
      inboundHotResponses, inboundWarmResponses, inboundColdResponses, inboundUnclassifiedResponses,
      inboundAccounts, inboundResponses, inboundHotAccounts, inboundWarmAccounts, inboundColdAccounts,
      hotAccounts, warmAccounts, coldAccounts, qualifiedAccounts: hotAccounts + warmAccounts, responses, undatedResponses, uploadDateResponses };
  };
  const sourceEvidence = (ids: Set<number>) => [...ids].flatMap(id => sourceByAccount.get(id) ?? [])
    .slice(0, 1000).map(r => ({
      reference: `inbound:${r.id}`, accountId: Number(r.account_id), contactId: r.contact_id ? Number(r.contact_id) : null,
      classification: r.classification as string | null, product: r.product_interest as string | null,
      horizonMonths: r.purchase_timeframe_months as number | null,
      submittedAt: r.submitted_at ? new Date(r.submitted_at).toISOString() : null,
      source: r.file_name as string, routingStatus: r.routing_status as string | null,
    }));
  const evidence = (ids: Set<number>) => [...ids].flatMap(id => [...(byAccount.get(id) ?? [])]
    .sort((a, b) => Number(b.status === "Hot") - Number(a.status === "Hot")).slice(0, 5).map(r => ({
    reference: `inbound:${r.id}`, accountId: id, product: r.product_interest as string,
    horizonMonths: r.purchase_timeframe_months as number | null, status: r.status as string,
    submittedAt: r.submitted_at ? new Date(r.submitted_at).toISOString() : null, source: r.file_name as string,
    submissionDateOrigin: r.date_origin as string,
  })));
  const routes = (ids: Set<number>) => {
    const journeys = new Map<number, { id: number; name: string }>();
    let pendingJourneyRoutes = 0, failedJourneyRoutes = 0, unavailableJourneyRoutes = 0;
    for (const id of ids) for (const row of sourceByAccount.get(id) ?? []) {
      if (row.routing_status === "routed") {
        if (row.routed_journey_id && row.routed_journey_name)
          journeys.set(Number(row.routed_journey_id), { id: Number(row.routed_journey_id), name: row.routed_journey_name });
        else unavailableJourneyRoutes++;
      } else if (row.routing_status === "error") failedJourneyRoutes++;
      else if (row.routing_status === "pending") pendingJourneyRoutes++;
    }
    return { journeys: [...journeys.values()].sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id),
      pendingJourneyRoutes, failedJourneyRoutes, unavailableJourneyRoutes };
  };
  const intentEvidence = (ids: Set<number>) => [...ids].flatMap(id => (byAccount.get(id) ?? []).flatMap(r =>
    String(r.product_interest ?? "").split(/[,;|\n]/).map(selection => selection.trim())
      .filter(selection => positiveProduct(selection) && r.affinity_reviews?.[selection] !== "rejected")
      .map(product => ({ accountId: id, product, category: null as string | null, status: r.status as string }))));
  const hasSource = (ids: Set<number>, formType: "lead_form" | "event_feedback") =>
    [...ids].some(id => (sourceByAccount.get(id) ?? []).some(row => row.form_type === formType));
  return { summarize, evidence, routes, sourceEvidence, intentEvidence, hasSource };
}
