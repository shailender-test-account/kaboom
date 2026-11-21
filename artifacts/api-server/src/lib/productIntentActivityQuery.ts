/**
 * Resolve only this account/product batch. Shared payload references are checked
 * once, while signal-linked reviews use the existing (tenant_id, signal_id)
 * index. Materialization prevents wide source reads from moving below dedup.
 * No tenant-wide evidence preload or persistent result cache is involved.
 */
export const PRODUCT_INTENT_ACTIVITY_SQL = `
WITH candidate_signals AS MATERIALIZED (
  SELECT s.id,s.tenant_id,s.account_id,s.source,s.summary,s.occurred_at,s.product_id,s.signal_type_id,
    CASE WHEN s.payload->>'evidenceId' ~ '^[0-9]{1,9}$'
      THEN (s.payload->>'evidenceId')::int END AS payload_evidence_id
  FROM intent_signals s
  WHERE s.tenant_id=$1 AND s.product_id=ANY($2::int[]) AND s.account_id=ANY($3::int[])
    AND s.occurred_at>=NOW()-interval '1 year' AND (s.expires_at IS NULL OR s.expires_at>NOW())
),
scoped_signals AS MATERIALIZED (
  SELECT s.* FROM candidate_signals s
  JOIN intent_signal_types st ON st.tenant_id=s.tenant_id AND st.id=s.signal_type_id AND st.active
  JOIN intent_products p ON p.tenant_id=s.tenant_id AND p.id=s.product_id
  JOIN intent_product_categories pc ON pc.tenant_id=p.tenant_id AND pc.id=p.category_id
),
payload_evidence AS MATERIALIZED (
  -- One small ID-only map avoids a planner-estimated nested-loop join between
  -- two materialized batches (which can otherwise become signals × sources).
  SELECT COALESCE(jsonb_object_agg(requested.id,evidence.id),'{}'::jsonb) AS approved_by_id
  FROM (SELECT DISTINCT payload_evidence_id AS id FROM scoped_signals WHERE payload_evidence_id IS NOT NULL) requested
  LEFT JOIN LATERAL (
    SELECT id FROM intent_evidence
    WHERE tenant_id=$1 AND id=requested.id AND review_status='approved' LIMIT 1
  ) evidence ON true
),
resolved_signals AS MATERIALIZED (
  SELECT s.*,GREATEST(linked.approved_id,(payload.approved_by_id->>s.payload_evidence_id::text)::int) AS evidence_id
  FROM scoped_signals s
  CROSS JOIN payload_evidence payload
  CROSS JOIN LATERAL (
    SELECT max(id) FILTER (WHERE review_status='approved') AS approved_id,count(*) AS review_count
    FROM intent_evidence WHERE tenant_id=s.tenant_id AND signal_id=s.id
  ) linked
  -- A payload reference must not rescue an explicitly unapproved signal.
  WHERE linked.review_count=0 OR linked.approved_id IS NOT NULL
),
activity_evidence AS MATERIALIZED (
  SELECT evidence.id,evidence.excerpt AS evidence_excerpt,
    jsonb_build_object('scope',evidence.context->'scope','country',evidence.context->'country',
      'originalExcerpt',evidence.context->'originalExcerpt','aiReview',evidence.context ? 'aiReview') AS evidence_context,
    jsonb_build_object('excerpt',evidence.raw_evidence->'excerpt',
      'context',jsonb_build_object('sourceTitle',evidence.raw_evidence->'context'->'sourceTitle',
        'rawEvent',jsonb_build_object(
          'description',evidence.raw_evidence->'context'->'rawEvent'->'description',
          'headline',evidence.raw_evidence->'context'->'rawEvent'->'headline',
          'title',evidence.raw_evidence->'context'->'rawEvent'->'title',
          'affected_market',evidence.raw_evidence->'context'->'rawEvent'->'affected_market',
          'event_location',evidence.raw_evidence->'context'->'rawEvent'->'event_location',
          'city',evidence.raw_evidence->'context'->'rawEvent'->'city',
          'location',evidence.raw_evidence->'context'->'rawEvent'->'location',
          'market',evidence.raw_evidence->'context'->'rawEvent'->'market',
          'data',jsonb_build_object(
            'description',evidence.raw_evidence->'context'->'rawEvent'->'data'->'description',
            'headline',evidence.raw_evidence->'context'->'rawEvent'->'data'->'headline',
            'title',evidence.raw_evidence->'context'->'rawEvent'->'data'->'title',
            'affected_market',evidence.raw_evidence->'context'->'rawEvent'->'data'->'affected_market',
            'event_location',evidence.raw_evidence->'context'->'rawEvent'->'data'->'event_location',
            'city',evidence.raw_evidence->'context'->'rawEvent'->'data'->'city',
            'location',evidence.raw_evidence->'context'->'rawEvent'->'data'->'location',
            'market',evidence.raw_evidence->'context'->'rawEvent'->'data'->'market'))),
      'companyName',evidence.raw_evidence->'companyName') AS raw_evidence
  FROM (SELECT DISTINCT evidence_id AS id FROM resolved_signals WHERE evidence_id IS NOT NULL) requested
  JOIN LATERAL (
    SELECT id,excerpt,context,raw_evidence FROM intent_evidence
    WHERE tenant_id=$1 AND id=requested.id AND review_status='approved' LIMIT 1
  ) evidence ON true
)
SELECT s.account_id,s.source,s.summary,s.occurred_at,s.evidence_id,
  false AS has_activity_evidence,NULL::text AS evidence_excerpt,
  NULL::jsonb AS evidence_context,NULL::jsonb AS raw_evidence
FROM resolved_signals s
UNION ALL
-- Source-only rows have no account: hydration in the reader associates them
-- by evidence ID, without joining/toasting the source once per signal.
SELECT NULL,NULL,NULL,NULL,evidence.id,true,evidence.evidence_excerpt,evidence.evidence_context,evidence.raw_evidence
FROM activity_evidence evidence
`;
