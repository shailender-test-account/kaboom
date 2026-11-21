import { pool } from "@workspace/db";
import { canonicalInboundSubmissionSql } from "./inboundSubmissionDuplicates";
import { readEngagementHistory } from "./engagementHistory";
import { field, text } from "./hpBiImport";
import { parsePurchaseTimeframeMonths } from "./inboundAccounts";
import { evidenceQualification } from "./engagementHistory";
import { readInboundProvenance } from "./inboundSubmissionProvenance";

/** Person-level source evidence only. Never inherit a colleague's form or account news. */
export async function readContactEngagementEvidence(
  tenantId: number, contactId: number, clientId: number | null, gtmPage: number, timelinePage: number,
) {
  const pageSize = 25;
  const [responses, history] = await Promise.all([
    pool.query(`WITH responses AS (
      SELECT 'inbound:'||s.id id,s.form_type AS "sourceType",
        COALESCE(src.name,s.file_name,'Imported response') AS "sourceName",
        s.submitted_at AS "occurredAt",s.classification AS qualification,
        s.product_interest AS product,s.purchase_timeframe_months AS "horizonMonths",
        s.raw_fields AS answers,s.event_feedback AS feedback,NULL::text AS journey,
        s.classification_reason AS reason
      FROM intent_inbound_submissions s
      JOIN contacts c ON c.id=s.contact_id AND c.tenant_id=s.tenant_id AND c.company_id=s.account_id
      JOIN companies co ON co.id=s.account_id AND co.tenant_id=s.tenant_id
        AND co.client_id IS NOT DISTINCT FROM s.client_id
      LEFT JOIN intent_inbound_sources src ON src.id=s.source_id AND src.tenant_id=s.tenant_id
      WHERE s.tenant_id=$1 AND s.contact_id=$2 AND s.client_id IS NOT DISTINCT FROM $3::int
        AND ${canonicalInboundSubmissionSql("s")}
        AND COALESCE(s.identity_review,'')<>'keep'
        AND COALESCE(s.routing_error,'') NOT ILIKE '%email%another account%'
      UNION ALL
      SELECT 'form:'||f.id,'lead_form',COALESCE(jf.name,'Journey form'),f.submitted_at,
        NULL,NULL,NULL,f.field_values,COALESCE(jf.config,'{}'::jsonb),j.name,NULL
      FROM form_submissions f JOIN contacts c ON c.id=f.contact_id AND c.tenant_id=f.tenant_id
      JOIN journeys j ON j.id=f.journey_id AND j.tenant_id=f.tenant_id
        AND j.client_id IS NOT DISTINCT FROM $3::int
      LEFT JOIN journey_forms jf ON jf.id=f.form_id AND jf.tenant_id=f.tenant_id
      WHERE f.tenant_id=$1 AND f.contact_id=$2
      UNION ALL
      SELECT 'hp-record:'||r.id,'lead_form',COALESCE(r.source_name,'Recorded lead form'),r.occurred_at,
        r.status,r.product,r.horizon_months,r.lineage,'{}'::jsonb,NULL,NULL
      FROM hp_bi_records r JOIN contacts c ON c.id=r.contact_id AND c.tenant_id=r.tenant_id
        AND c.company_id=r.account_id
      JOIN companies co ON co.id=r.account_id AND co.tenant_id=r.tenant_id
        AND co.client_id IS NOT DISTINCT FROM r.client_id
      WHERE r.tenant_id=$1 AND r.contact_id=$2 AND r.client_id IS NOT DISTINCT FROM $3::int
        AND r.kind='lead' AND COALESCE(r.source_key,'') NOT LIKE 'inbound:%'
        AND COALESCE(r.source_key,'') NOT LIKE 'form:%'
      UNION ALL
      SELECT 'intent-response:'||min(e.id),min(e.evidence_kind),
        COALESCE(min(e.context->>'formName'),'Imported contact response'),e.occurred_at,
        NULL,string_agg(DISTINCT p.name,', '),NULL,e.raw_evidence,
        jsonb_build_object('Imported answer evidence',jsonb_agg(e.context->'answer')),NULL,NULL
      FROM intent_evidence e JOIN contacts c ON c.id=e.contact_id AND c.tenant_id=e.tenant_id
        AND (e.account_id IS NULL OR e.account_id=c.company_id)
      LEFT JOIN intent_products p ON p.id=e.product_id AND p.tenant_id=e.tenant_id
      WHERE e.tenant_id=$1 AND e.contact_id=$2 AND c.client_id IS NOT DISTINCT FROM $3::int
        AND e.evidence_kind IN ('lead_form','event_questionnaire','event_feedback','product_buy_intent')
        AND e.review_status='approved'
      GROUP BY e.import_run_id,e.occurred_at,e.raw_evidence
    ), paged AS (
      SELECT * FROM responses ORDER BY "occurredAt" DESC NULLS LAST,id DESC LIMIT $4 OFFSET $5
    )
    SELECT (SELECT count(*)::int FROM responses) total,
      COALESCE((SELECT jsonb_agg(to_jsonb(p) ORDER BY "occurredAt" DESC NULLS LAST,id DESC) FROM paged p),'[]'::jsonb) items`,
    [tenantId, contactId, clientId, pageSize, (gtmPage - 1) * pageSize]),
    readEngagementHistory(tenantId, { clientId, companyIds: null, contactId }, timelinePage, pageSize),
  ]);
  const total = Number(responses.rows[0]?.total ?? 0);
  const provenance = await readInboundProvenance(tenantId, clientId,
    (responses.rows[0]?.items ?? []).filter((row: any) => /^inbound:\d+$/.test(row.id))
      .map((row: any) => ({ submissionId: Number(row.id.slice(8)), contactId })));
  const items = (responses.rows[0]?.items ?? []).map((row: any) => {
    const answers: Record<string, unknown> = {};
    const normalized: Record<string, unknown> = {};
    const configFields = row.id.startsWith("form:") && Array.isArray(row.feedback?.fields) ? row.feedback.fields : [];
    for (const [key, value] of Object.entries(row.answers ?? {})) {
      if (key.startsWith("__")) continue;
      const config = configFields.find((item: any) => item.id === key);
      const keyLabel = config?.label || config?.mapToBiField || key;
      answers[keyLabel] = value;
      normalized[keyLabel] = value;
      if (config?.mapToBiField) normalized[config.mapToBiField] = value;
    }
    const product = row.product || text(field(normalized, "productInterest", "product", "service", "solution")) || null;
    const horizon = row.horizonMonths ?? parsePurchaseTimeframeMonths(field(normalized, "horizonMonths", "purchaseTimeframeMonths", "purchaseTimeframe", "timeline", "horizon", "purchase timeline"));
    return { ...row, answers, product, horizonMonths: horizon,
      provenance: provenance.get(Number(row.id.replace(/^inbound:/, ""))),
      feedback: row.id.startsWith("form:") ? {} : row.feedback,
      qualification: evidenceQualification(product, horizon) };
  });
  return {
    gtmStatus: total > 0 ? history.summary.status : "Not available",
    gtmEvidence: { items, total, page: gtmPage, pageSize, hasMore: gtmPage * pageSize < total },
    timeline: { items: history.items, total: history.total, page: timelinePage, pageSize, hasMore: history.hasMore },
  };
}
