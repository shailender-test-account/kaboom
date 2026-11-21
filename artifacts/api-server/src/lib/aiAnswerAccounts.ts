import { pool } from "@workspace/db";
import { accountPlanRestrictions, termPattern, type AnswerPlan } from "./aiAnswerPlan";
import { accountEventCtes, accountEventFilterInputs } from "../routes/accountsAnalytics";

const negative = String.raw`^\s*(no([[:space:],;:]|$)|none\M|not[[:space:]]+(interested|looking|required)|n/?a\M|nil\M|not[[:space:]]+applicable)`;
const positive = (column: string) => `CASE WHEN trim(COALESCE(${column},''))<>'' AND ${column} !~* '${negative}' THEN ${column} ELSE NULL END`;

/** Static SQL only. Requires owned candidate_accounts and canonical account_events. */
export const firstPartyAccountEvidence = `
  SELECT r.account_id,r.contact_id,'hp:'||r.id reference,
    CASE WHEN r.kind IN ('lead','interest') THEN 'declared' ELSE 'engaged' END basis,
    ${positive("r.product")} product,r.occurred_at,COALESCE(r.source_name,r.source)||' / '||r.kind source
  FROM hp_bi_records r JOIN candidate_accounts a ON a.id=r.account_id
  WHERE r.tenant_id=$1 AND r.client_id=$2 AND r.kind IN ('attendance','lead','interest','digital','content')
    AND lower(COALESCE(r.status,'')) NOT IN ('email_open','email_sent','invitation')
    AND (r.contact_id IS NULL OR EXISTS(SELECT 1 FROM contacts c WHERE c.id=r.contact_id
      AND c.tenant_id=$1 AND c.client_id=$2 AND c.company_id=r.account_id AND NOT c.is_anonymous))
  UNION ALL
  SELECT s.account_id,s.contact_id,'inbound:'||s.id,
    CASE WHEN ${positive("s.product_interest")} IS NULL THEN 'engaged' ELSE 'declared' END,
    ${positive("s.product_interest")},s.submitted_at,COALESCE(s.file_name,'Questionnaire')||' / response'
  FROM intent_inbound_submissions s JOIN candidate_accounts a ON a.id=s.account_id
  WHERE s.tenant_id=$1 AND s.client_id=$2 AND COALESCE(s.identity_review,'')<>'keep'
    AND COALESCE(s.routing_error,'') NOT ILIKE '%email%another account%'
    AND (s.contact_id IS NULL OR EXISTS(SELECT 1 FROM contacts c WHERE c.id=s.contact_id
      AND c.tenant_id=$1 AND c.client_id=$2 AND c.company_id=s.account_id AND NOT c.is_anonymous))
  UNION ALL
  SELECT c.company_id,f.contact_id,'form:'||f.id,'engaged',NULL::text,f.submitted_at,'Journey form: '||j.name
  FROM form_submissions f JOIN contacts c ON c.id=f.contact_id AND c.tenant_id=$1 AND c.client_id=$2 AND NOT c.is_anonymous
  JOIN candidate_accounts a ON a.id=c.company_id
  JOIN journeys j ON j.id=f.journey_id AND j.tenant_id=$1 AND j.client_id=$2
  WHERE f.tenant_id=$1
  UNION ALL
  SELECT c.company_id,f.contact_id,'form:'||f.id,'declared',v.value,f.submitted_at,'Journey form: '||j.name
  FROM form_submissions f JOIN contacts c ON c.id=f.contact_id AND c.tenant_id=$1 AND c.client_id=$2 AND NOT c.is_anonymous
  JOIN candidate_accounts a ON a.id=c.company_id
  JOIN journeys j ON j.id=f.journey_id AND j.tenant_id=$1 AND j.client_id=$2
  LEFT JOIN journey_forms jf ON jf.id=f.form_id AND jf.tenant_id=$1
  CROSS JOIN LATERAL jsonb_each_text(CASE WHEN jsonb_typeof(f.field_values)='object' THEN f.field_values ELSE '{}'::jsonb END) v
  WHERE f.tenant_id=$1 AND ${positive("v.value")} IS NOT NULL
    AND (regexp_replace(lower(v.key),'[^a-z]','','g') IN ('productinterest','product','service','solution','services','products')
      OR EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(jf.config->'fields','[]'::jsonb)) cfg
        WHERE cfg->>'id'=v.key AND regexp_replace(lower(COALESCE(NULLIF(cfg->>'mapToBiField',''),NULLIF(cfg->>'mapToContactField',''),cfg->>'label')),'[^a-z]','','g')
          IN ('productinterest','product','service','solution','services','products')))
  UNION ALL
  SELECT e.account_id,e.contact_id,e.source_type||':'||e.source_id,'engaged',
    ${positive("COALESCE(NULLIF(raw.props->'biContext'->>'product',''),NULLIF(p.bi_product,''))")},
    e.created_at,COALESCE(e.journey_name,'Tracked activity')||' / '||e.event_type||COALESCE(' / '||e.page_name,'')
  FROM account_events e
  LEFT JOIN journeys j ON j.id=e.journey_id AND j.tenant_id=$1 AND j.client_id=$2
  LEFT JOIN journey_events raw ON e.source_type='journey_event' AND raw.id=e.source_id AND raw.tenant_id=$1
  LEFT JOIN LATERAL (
    SELECT jp.bi_product FROM journey_pages jp WHERE jp.journey_id=e.journey_id
      AND (jp.id=raw.page_id OR (raw.id IS NULL AND jp.title=e.page_name
        AND (SELECT count(*) FROM journey_pages other WHERE other.journey_id=e.journey_id AND other.title=e.page_name)=1))
    LIMIT 1
  ) p ON TRUE
  WHERE (e.journey_id IS NULL OR j.id IS NOT NULL)
    AND e.event_type IN ('page_view','cta_click','asset_download','download','form_submitted','email_click','call_completed')
    AND (e.contact_id IS NULL OR EXISTS(SELECT 1 FROM contacts c WHERE c.id=e.contact_id
      AND c.tenant_id=$1 AND c.client_id=$2 AND c.company_id=e.account_id AND NOT c.is_anonymous))
`;

export async function queryAnswerAccounts(tenantId: number, clientId: number, plan: AnswerPlan, page: number) {
  if ((plan.mode !== "accounts" && plan.mode !== "account-count") || accountPlanRestrictions(plan).length)
    throw new Error("Unsupported account filters");
  const values: unknown[] = [tenantId, clientId, null, null, null];
  const bind = (v: unknown) => { values.push(v); return `$${values.length}`; };
  const match = (column: string, terms: string[], kind?: string) =>
    terms.length ? `COALESCE(${column},'') ~* ${bind(termPattern(terms, kind))}` : "TRUE";
  const groups = plan.groups.map(g => {
    const company = [match("a.name", g.companies), match("a.industry", g.industries)].join(" AND ");
    const basis = g.interest === "declared" ? ["e.basis='declared'", "e.product IS NOT NULL"] :
      g.interest === "engaged" && g.products.length ? ["e.basis='engaged'"] : [];
    const dates = [
      ...(g.since ? [`e.occurred_at >= (${bind(g.since)}::date::timestamp AT TIME ZONE 'Asia/Kolkata')`] : []),
      ...(g.until ? [`e.occurred_at < ((${bind(g.until)}::date + 1)::timestamp AT TIME ZONE 'Asia/Kolkata')`] : []),
    ];
    const sets = g.productMatch === "all" ? g.products.map(p => [p]) : [g.products];
    const evidence = sets.map(products => [match("e.product", products, "product"), ...basis, ...dates].join(" AND "));
    const required = g.products.length > 0 || g.interest !== "any" || !!g.since || !!g.until;
    const condition = required ? evidence.map(where =>
      `EXISTS(SELECT 1 FROM account_evidence e WHERE e.account_id=a.id AND ${where})`).join(" AND ") : "TRUE";
    return { company, condition, evidence: `(${evidence.join(") OR (")})` };
  });
  const where = groups.map(g => `(${g.company} AND ${g.condition})`).join(" OR ");
  const evidenceWhere = groups.map(g => `(${g.company} AND ${g.condition} AND ${g.evidence})`).join(" OR ");
  const sql = `WITH candidate_accounts AS MATERIALIZED (
    SELECT id,name,industry FROM companies a WHERE a.tenant_id=$1 AND a.client_id=$2
      AND (${groups.map(g => `(${g.company})`).join(" OR ")})
  ), ${accountEventFilterInputs(3)}, ${accountEventCtes},
  account_evidence AS MATERIALIZED (${firstPartyAccountEvidence}),
  matched AS MATERIALIZED (SELECT a.* FROM candidate_accounts a WHERE ${where}),
  paged AS (SELECT * FROM matched ORDER BY id LIMIT 25 OFFSET $${values.length + 1})
  SELECT (SELECT count(*)::int FROM matched) total,COALESCE((
    SELECT jsonb_agg(jsonb_build_object('id',a.id,'name',a.name,'industry',a.industry,
      'matchingRecords',(SELECT count(DISTINCT e.reference)::int FROM account_evidence e WHERE e.account_id=a.id AND (${evidenceWhere})),
      'lastEngagedAt',(SELECT max(e.occurred_at) FROM account_evidence e WHERE e.account_id=a.id AND (${evidenceWhere})),
      'evidence',COALESCE((SELECT jsonb_agg(ev) FROM (
        SELECT DISTINCT e.reference,e.basis,e.product,e.occurred_at AS "occurredAt",e.source
        FROM account_evidence e WHERE e.account_id=a.id AND (${evidenceWhere})
        ORDER BY "occurredAt" DESC NULLS LAST,e.reference LIMIT 5
      ) ev),'[]'::jsonb))) FROM paged a
  ),'[]'::jsonb) accounts`;
  const client = await pool.connect();
  try {
    await client.query("BEGIN READ ONLY"); await client.query("SET LOCAL statement_timeout='8s'");
    const result = await client.query(sql, [...values, (page - 1) * 25]);
    await client.query("COMMIT");
    return { total: result.rows[0].total as number, accounts: result.rows[0].accounts as any[], people: [], page, pageSize: 25 };
  } catch (err) { await client.query("ROLLBACK"); throw err; }
  finally { client.release(); }
}
