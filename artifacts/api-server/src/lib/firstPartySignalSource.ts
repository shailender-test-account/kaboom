import { pool } from "@workspace/db";

export type FirstPartySourceRef = { kind: "inbound_submission" | "intent_evidence"; id: number; formType?: string };
export function inboundSourceRef(row: { id: number; form_type?: string }): FirstPartySourceRef {
  return { kind: "inbound_submission", id: row.id, formType: row.form_type || "unknown" };
}
export function inboundSignalType(formType?: string) {
  if (formType === "lead_form") return "lead_form";
  if (["questionnaire", "event_questionnaire", "event_feedback"].includes(formType || "")) return "event_questionnaire";
  return "inbound_response";
}
export async function readFirstPartySignalSource(tenantId: number, accountId: number, ref: FirstPartySourceRef) {
  const result = ref.kind === "inbound_submission"
    ? await pool.query(`SELECT s.id,s.form_type AS "formType",src.name AS "sourceName",s.file_name AS "fileName",
        s.submitted_at AS "submittedAt",s.created_at AS "importedAt",
        s.contact_id AS "contactId",NULLIF(trim(concat_ws(' ',c.first_name,c.last_name)),'') AS "contactName",
        s.classification,s.classification_reason AS reason,s.product_interest AS product,
        s.purchase_timeframe_months AS "horizonMonths",s.raw_fields AS answers,s.event_feedback AS feedback
      FROM intent_inbound_submissions s
      LEFT JOIN contacts c ON c.id=s.contact_id AND c.tenant_id=s.tenant_id AND c.company_id=s.account_id
      LEFT JOIN intent_inbound_sources src ON src.id=s.source_id AND src.tenant_id=s.tenant_id AND src.client_id=s.client_id
      WHERE s.tenant_id=$1 AND s.account_id=$2 AND s.id=$3`, [tenantId, accountId, ref.id])
    : await pool.query(`SELECT e.id,e.evidence_kind AS "formType",e.context->>'formName' AS "sourceName",
        e.context->'provenance'->>'fileName' AS "fileName",e.occurred_at AS "submittedAt",e.created_at AS "importedAt",
        e.contact_id AS "contactId",NULLIF(trim(concat_ws(' ',c.first_name,c.last_name)),'') AS "contactName",
        e.excerpt AS reason,e.raw_evidence AS answers,e.context->'answer' AS feedback,e.review_status AS "reviewStatus"
      FROM intent_evidence e
      LEFT JOIN contacts c ON c.id=e.contact_id AND c.tenant_id=e.tenant_id AND c.company_id=e.account_id
      WHERE e.tenant_id=$1 AND e.account_id=$2 AND e.id=$3
        AND e.evidence_kind IN ('lead_form','event_questionnaire','event_feedback','product_buy_intent')
        AND e.review_status='approved'`, [tenantId, accountId, ref.id]);
  const row = result.rows[0];
  if (!row) return null;
  const answers = Object.fromEntries(Object.entries(row.answers || {}).filter(([key]) => !key.startsWith("__")));
  const origin = row.answers?.__submissionDateOrigin === "upload" || !row.submittedAt ? "imported" :
    row.answers?.__submissionDateOverride ? "edited" : "source";
  return { ...row, answers, dateOrigin: origin, kind: ref.kind };
}
