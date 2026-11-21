/**
 * One logical response for exact copies of a GTM upload. Keep raw source rows for
 * audit. Ignore spreadsheet whitespace/empty-cell formatting, never identities,
 * source folders, conflicting reviewed answers or real submission dates.
 */
function normalizedAnswersSql(alias:string):string {
  // Group normalized keys into value sets so conflicting duplicate columns
  // cannot overwrite one another. Raw source answers are never rewritten.
  return `COALESCE((SELECT jsonb_object_agg(answer_key,answer_values) FROM (
    SELECT answer_key,jsonb_agg(DISTINCT answer_value ORDER BY answer_value) AS answer_values FROM (
      SELECT btrim(regexp_replace(raw.key,'[[:space:]]+',' ','g')) AS answer_key,
        CASE WHEN jsonb_typeof(raw.value)='string'
          AND raw.key ~* '(^|[[:space:]_])time$'
          AND (raw.value #>> '{}') ~ '^1899-12-(30|31)T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]+)?Z$'
          THEN to_jsonb(substring(raw.value #>> '{}' FROM 12))
          WHEN jsonb_typeof(raw.value)='string'
          THEN to_jsonb(btrim(regexp_replace(raw.value #>> '{}','[[:space:]]+',' ','g')))
          ELSE raw.value END AS answer_value
      FROM jsonb_each(COALESCE(${alias}.raw_fields,'{}'::jsonb)-'__submissionDateOrigin') raw
    ) normalized WHERE answer_key<>'' AND answer_value<>'null'::jsonb AND answer_value<>'""'::jsonb
    GROUP BY answer_key
  ) answers),'{}'::jsonb)`;
}

export function canonicalInboundSubmissionSql(alias: string): string {
  if (!/^[a-z][a-z0-9_]*$/i.test(alias) || alias === "inbound_copy") throw new Error("Invalid submission alias");
  const s = alias;
  return `(${s}.contact_id IS NULL OR
    ${normalizedAnswersSql(s)}='{}'::jsonb OR NOT EXISTS (
      SELECT 1 FROM intent_inbound_submissions inbound_copy
      WHERE ${supersedesInboundSubmissionSql("inbound_copy", s)}
    ))`;
}

/** The same exact-copy and compatible-review rule powers counts and audit provenance. */
export function supersedesInboundSubmissionSql(copy: string, s: string): string {
  if (![copy, s].every(a => /^[a-z][a-z0-9_]*$/i.test(a)) || copy === s) throw new Error("Invalid submission alias");
  return `${copy}.tenant_id=${s}.tenant_id
        AND ${copy}.client_id IS NOT DISTINCT FROM ${s}.client_id
        AND ${copy}.source_id=${s}.source_id
        AND ${copy}.account_id=${s}.account_id AND ${copy}.contact_id=${s}.contact_id
        AND ${copy}.form_type=${s}.form_type
        AND ${normalizedAnswersSql(copy)}=${normalizedAnswersSql(s)}
        AND ${copy}.product_interest IS NOT DISTINCT FROM ${s}.product_interest
        AND ${copy}.purchase_timeframe_months IS NOT DISTINCT FROM ${s}.purchase_timeframe_months
        AND ${copy}.classification IS NOT DISTINCT FROM ${s}.classification
        AND ${copy}.explicit_interest IS NOT DISTINCT FROM ${s}.explicit_interest
        AND ${copy}.requested_demo IS NOT DISTINCT FROM ${s}.requested_demo
        AND ${copy}.is_decision_maker IS NOT DISTINCT FROM ${s}.is_decision_maker
        AND COALESCE(${copy}.affinity_reviews,'{}'::jsonb) @> COALESCE(${s}.affinity_reviews,'{}'::jsonb)
        AND (COALESCE(${copy}.affinity_reviews,'{}'::jsonb)<>COALESCE(${s}.affinity_reviews,'{}'::jsonb)
          OR (COALESCE(${copy}.affinity_reviews,'{}'::jsonb)=COALESCE(${s}.affinity_reviews,'{}'::jsonb) AND (
            (COALESCE(${copy}.routing_status,'')='routed' AND COALESCE(${s}.routing_status,'')<>'routed')
            OR ((COALESCE(${copy}.routing_status,'')='routed')=(COALESCE(${s}.routing_status,'')='routed')
              AND ${copy}.id<${s}.id)
          )))
        AND COALESCE(${copy}.identity_review,'')=COALESCE(${s}.identity_review,'')
        AND COALESCE(${copy}.routing_error,'') NOT ILIKE '%email%another account%'
        AND (
          ${copy}.submitted_at=${s}.submitted_at
          OR (${s}.raw_fields->>'__submissionDateOrigin'='upload'
            AND ${copy}.raw_fields->>'__submissionDateOrigin'='upload'
            AND (COALESCE(${copy}.submitted_at,${copy}.created_at) AT TIME ZONE 'Asia/Kolkata')::date
              =(COALESCE(${s}.submitted_at,${s}.created_at) AT TIME ZONE 'Asia/Kolkata')::date)
        )
    `;
}
