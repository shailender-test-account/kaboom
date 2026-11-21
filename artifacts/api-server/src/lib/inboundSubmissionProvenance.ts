import { pool } from "@workspace/db";
import { canonicalInboundSubmissionSql, supersedesInboundSubmissionSql } from "./inboundSubmissionDuplicates";

export interface InboundProvenance {
  retainedSubmissionId: number;
  savedReviewCount: number;
  copies: Array<{
    submissionId: number; fileName: string; fileUrl: string | null; sourceName: string | null; rowKey: string;
    submittedAt: string | null; importedAt: string | null; sourceModifiedAt: string | null; hasSavedReviews: boolean;
  }>;
}
type OwnedResponse = { submissionId: number; accountId?: number; contactId?: number | null };

/** Read-only, batched enrichment of displayed responses. No classification, imports or routing. */
export async function readInboundProvenance(
  tenantId: number, clientId: number | null, responses: OwnedResponse[],
): Promise<Map<number, InboundProvenance>> {
  if (!responses.length) return new Map();
  const result = await pool.query(`WITH requested AS (
    SELECT * FROM jsonb_to_recordset($3::jsonb) AS x("submissionId" int,"accountId" int,"contactId" int)
  )
  SELECT s.id AS retained_id,s.affinity_reviews,
    jsonb_agg(jsonb_build_object(
      'submissionId',cp.id,'fileName',cp.file_name,'fileId',cp.drive_file_id,
      'sourceName',src.name,'rowKey',cp.row_key,'submittedAt',cp.submitted_at,
      'importedAt',cp.created_at,'sourceModifiedAt',cp.drive_modified_at,
      'hasSavedReviews',COALESCE(cp.affinity_reviews,'{}'::jsonb)<>'{}'::jsonb
    ) ORDER BY cp.created_at,cp.id) AS copies
  FROM requested r JOIN intent_inbound_submissions s ON s.id=r."submissionId"
    AND (r."accountId" IS NULL OR s.account_id=r."accountId")
    AND s.contact_id IS NOT DISTINCT FROM r."contactId"
  JOIN contacts c ON c.id=s.contact_id AND c.tenant_id=s.tenant_id AND c.company_id=s.account_id
    AND c.client_id IS NOT DISTINCT FROM s.client_id
  JOIN companies co ON co.id=s.account_id AND co.tenant_id=s.tenant_id
    AND co.client_id IS NOT DISTINCT FROM s.client_id
  JOIN intent_inbound_submissions cp ON cp.id=s.id OR (
    s.contact_id IS NOT NULL AND COALESCE(s.raw_fields-'__submissionDateOrigin','{}'::jsonb)<>'{}'::jsonb
    AND ${supersedesInboundSubmissionSql("s", "cp")}
  )
  LEFT JOIN intent_inbound_sources src ON src.id=cp.source_id AND src.tenant_id=cp.tenant_id
    AND src.client_id IS NOT DISTINCT FROM cp.client_id
  WHERE s.tenant_id=$1 AND s.client_id IS NOT DISTINCT FROM $2::int
    AND ${canonicalInboundSubmissionSql("s")}
    AND COALESCE(s.identity_review,'')<>'keep'
    AND COALESCE(s.routing_error,'') NOT ILIKE '%email%another account%'
    AND COALESCE(cp.identity_review,'')<>'keep'
    AND COALESCE(cp.routing_error,'') NOT ILIKE '%email%another account%'
  GROUP BY s.id,s.affinity_reviews`, [tenantId, clientId, JSON.stringify(
    [...new Map(responses.map(r => [r.submissionId, r])).values()],
  )]);
  return new Map(result.rows.map(row => [Number(row.retained_id), {
    retainedSubmissionId: Number(row.retained_id),
    savedReviewCount: Object.keys(row.affinity_reviews ?? {}).length,
    copies: row.copies.map(({ fileId, ...copy }: any) => ({
      ...copy,
      // Manual/synthetic import identifiers are not Google Drive files.
      fileUrl: typeof fileId === "string" && /^[a-zA-Z0-9_-]{10,}$/.test(fileId)
        ? `https://drive.google.com/file/d/${encodeURIComponent(fileId)}/view` : null,
    })),
  }]));
}

/** HP mirror records carry the original submission reference as their source key. */
export function inboundSubmissionId(record: { id: string; externalEventId?: string | null; sourceSubmissionId?: number }): number | null {
  if (record.sourceSubmissionId !== undefined) return record.sourceSubmissionId;
  const match = /^(?:inbound:)(\d+)(?::response)?$/.exec(record.externalEventId ?? record.id);
  return match ? Number(match[1]) : null;
}
