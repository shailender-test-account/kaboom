import { pool } from "@workspace/db";
import { termPattern, type AnswerPlan } from "./aiAnswerPlan";
import { firstPartyAccountEvidence } from "./aiAnswerAccounts";
export { termPattern };
import { accountEventCtes, accountEventFilterInputs } from "../routes/accountsAnalytics";

export const regionLocations: Record<string, { states: string[]; cities: string[] }> = {
  north: { states: ["delhi", "new delhi", "nct of delhi", "punjab", "haryana", "himachal pradesh", "uttarakhand", "uttar pradesh", "rajasthan", "chandigarh", "jammu and kashmir", "jammu & kashmir", "ladakh"],
    cities: ["delhi", "new delhi", "gurgaon", "gurugram", "noida", "greater noida", "faridabad", "ghaziabad", "chandigarh", "jaipur", "lucknow", "ludhiana", "amritsar", "dehradun", "shimla", "jammu", "srinagar"] },
  south: { states: ["tamil nadu", "kerala", "karnataka", "andhra pradesh", "telangana", "puducherry", "lakshadweep"], cities: ["bengaluru", "bangalore", "hyderabad", "chennai", "kochi", "coimbatore", "thiruvananthapuram", "visakhapatnam"] },
  east: { states: ["west bengal", "odisha", "orissa", "bihar", "jharkhand", "andaman and nicobar islands"], cities: ["kolkata", "bhubaneswar", "patna", "ranchi"] },
  west: { states: ["maharashtra", "gujarat", "goa", "dadra and nagar haveli and daman and diu"], cities: ["mumbai", "pune", "ahmedabad", "surat", "vadodara", "panaji"] },
  central: { states: ["madhya pradesh", "chhattisgarh"], cities: ["bhopal", "indore", "raipur"] },
  "north-east": { states: ["assam", "arunachal pradesh", "manipur", "meghalaya", "mizoram", "nagaland", "sikkim", "tripura"], cities: ["guwahati", "shillong", "imphal", "gangtok", "agartala"] },
};

/** No AI-generated SQL. Only allowlisted predicates and bound values. */
export function compileAnswerQuery(tenantId: number, clientId: number, plan: AnswerPlan) {
  const values: unknown[] = [tenantId, clientId, null, null, null];
  const withGenericEngagement = plan.groups.some(g => !g.products.length && g.interest === "engaged");
  const withEngagement = withGenericEngagement || plan.groups.some(g => g.products.length > 0 && g.interest !== "declared");
  const bind = (value: unknown) => { values.push(value); return `$${values.length}`; };
  const match = (column: string, terms: string[], kind?: string) => terms.length ? `COALESCE(${column},'') ~* ${bind(termPattern(terms, kind))}` : "TRUE";
  const periods = (g: AnswerPlan["groups"][number], column: string) => [
    ...(g.since ? [`${column} >= (${bind(g.since)}::date::timestamp AT TIME ZONE 'Asia/Kolkata')`] : []),
    ...(g.until ? [`${column} < ((${bind(g.until)}::date + 1)::timestamp AT TIME ZONE 'Asia/Kolkata')`] : []),
  ];
  const predicates = plan.groups.map(g => {
    const geographic = g.regions.map(region => {
      const { states, cities } = regionLocations[region];
      // Recognized state wins over city; do not infer from conflicting city/state
      // or from a foreign contact who happens to share an Indian city name.
      return `((lower(trim(COALESCE(c.country,''))) IN ('','india','in','ind','bharat'))
        AND (lower(trim(c.state))=ANY(${bind(states)}::text[]) OR
          (COALESCE(trim(c.state),'')='' AND lower(trim(c.city))=ANY(${bind(cities)}::text[]))))`;
    });
    const conditions = [
      ...(geographic.length ? [`(${geographic.join(" OR ")})`] : []),
      match("c.state", g.states), match("c.city", g.cities), match("c.country", g.countries),
      match('c."function"', g.functions, "function"), match("COALESCE(NULLIF(c.title,''),c.designation)", g.titles),
      match("COALESCE(co.name,c.company_name)", g.companies), match("co.industry", g.industries),
      ...(g.scoreMin !== null ? [`c.intent_score >= ${bind(g.scoreMin)}`] : []),
      ...(g.scoreMax !== null ? [`c.intent_score <= ${bind(g.scoreMax)}`] : []),
      ...(!g.products.length && g.interest === "any" ? periods(g, "c.last_activity") : []),
    ];
    const evidenceConditions = [
      ...(g.interest !== "any" ? [`e.basis=${bind(g.interest)}`] : []),
      ...periods(g, "e.occurred_at"),
    ];
    const productSets = g.productMatch === "all" && g.products.length ? g.products.map(p => [p]) :
      g.products.length || g.interest !== "any" ? [g.products] : [];
    return {
      contact: conditions.join(" AND "),
      interest: productSets.map(products => `EXISTS (SELECT 1 FROM evidence e WHERE e.contact_id=c.id AND ${
        [match("e.product", products, "product"), ...evidenceConditions].join(" AND ")})`).join(" AND ") || "TRUE",
      evidence: [match("e.product", g.products, "product"), ...evidenceConditions].join(" AND "),
    };
  });
  const ctes = `WITH candidates AS MATERIALIZED (
    SELECT c.*,co.name account_name FROM contacts c
    LEFT JOIN companies co ON co.id=c.company_id AND co.tenant_id=$1 AND co.client_id=$2
    WHERE c.tenant_id=$1 AND c.client_id=$2 AND NOT c.is_anonymous AND
      (${predicates.map(g => `(${g.contact})`).join(" OR ")})
  ), ${accountEventFilterInputs(3)}, ${withEngagement ? `candidate_accounts AS (
    SELECT DISTINCT c.company_id id FROM candidates c JOIN companies owned
      ON owned.id=c.company_id AND owned.tenant_id=$1 AND owned.client_id=$2
  ), ${accountEventCtes},` : ""} ${withGenericEngagement ? `general_account_evidence AS MATERIALIZED (${firstPartyAccountEvidence}),` : ""} evidence AS MATERIALIZED (
    SELECT s.contact_id,'inbound:'||s.id reference,'declared' basis,s.product_interest product,
      s.submitted_at occurred_at,COALESCE(s.file_name,'Questionnaire') source
    FROM intent_inbound_submissions s JOIN candidates c ON c.id=s.contact_id AND c.company_id=s.account_id
    WHERE s.tenant_id=$1 AND s.client_id=$2 AND COALESCE(s.identity_review,'')<>'keep'
      AND COALESCE(s.routing_error,'') NOT ILIKE '%email%another account%'
      AND s.product_interest IS NOT NULL AND trim(s.product_interest)<>''
      AND s.product_interest !~* '^\\s*(no([[:space:],;:]|$)|none\\M|not[[:space:]]+(interested|looking|required)|n/?a\\M|nil\\M|not[[:space:]]+applicable)'
    UNION ALL
    SELECT r.contact_id,'hp:'||r.id,CASE WHEN r.kind IN ('lead','interest') THEN 'declared' ELSE 'engaged' END,
      r.product,r.occurred_at,COALESCE(r.source_name,r.source)
    FROM hp_bi_records r JOIN candidates c ON c.id=r.contact_id AND c.company_id=r.account_id
    WHERE r.tenant_id=$1 AND r.client_id=$2 AND r.kind IN ('lead','interest','digital','content')
      AND COALESCE(r.status,'') NOT IN ('email_open','email_sent','invitation')
      AND r.product IS NOT NULL AND trim(r.product)<>''
      AND r.product !~* '^\\s*(no([[:space:],;:]|$)|none\\M|not[[:space:]]+(interested|looking|required)|n/?a\\M|nil\\M|not[[:space:]]+applicable)'
    UNION ALL
    SELECT f.contact_id,'form:'||f.id||':'||v.key,'declared',v.value,f.submitted_at,'Journey form: '||j.name
    FROM form_submissions f JOIN candidates c ON c.id=f.contact_id
    JOIN journeys j ON j.id=f.journey_id AND j.tenant_id=$1 AND j.client_id=$2
    LEFT JOIN journey_forms jf ON jf.id=f.form_id AND jf.tenant_id=$1
    CROSS JOIN LATERAL jsonb_each_text(CASE WHEN jsonb_typeof(f.field_values)='object' THEN f.field_values ELSE '{}'::jsonb END) v
    WHERE f.tenant_id=$1 AND v.value IS NOT NULL AND trim(v.value)<>''
      AND v.value !~* '^\\s*(no([[:space:],;:]|$)|none\\M|not[[:space:]]+(interested|looking|required)|n/?a\\M|nil\\M|not[[:space:]]+applicable)'
      AND (regexp_replace(lower(v.key),'[^a-z]','','g') IN ('productinterest','product','service','solution','services','products')
        OR EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(jf.config->'fields','[]'::jsonb)) cfg
          WHERE cfg->>'id'=v.key AND regexp_replace(lower(COALESCE(NULLIF(cfg->>'mapToBiField',''),NULLIF(cfg->>'mapToContactField',''),cfg->>'label')),'[^a-z]','','g')
            IN ('productinterest','product','service','solution','services','products')))
    ${withEngagement ? `UNION ALL
    SELECT e.contact_id,e.source_type||':'||e.source_id,'engaged',
      COALESCE(NULLIF(raw.props->'biContext'->>'product',''),NULLIF(p.bi_product,'')),
      e.created_at,COALESCE(e.journey_name,'Tracked journey')||COALESCE(' / '||e.page_name,'')
    FROM account_events e JOIN candidates c ON c.id=e.contact_id AND c.company_id=e.account_id
    JOIN journeys j ON j.id=e.journey_id AND j.tenant_id=$1 AND j.client_id=$2
    LEFT JOIN journey_events raw ON e.source_type='journey_event' AND raw.id=e.source_id AND raw.tenant_id=$1
    LEFT JOIN LATERAL (
      SELECT jp.bi_product FROM journey_pages jp WHERE jp.journey_id=e.journey_id
        AND (jp.id=raw.page_id OR (raw.id IS NULL AND jp.title=e.page_name AND
          (SELECT count(*) FROM journey_pages other WHERE other.journey_id=e.journey_id AND other.title=e.page_name)=1))
      LIMIT 1
    ) p ON TRUE
    WHERE e.event_type IN ('page_view','cta_click','asset_download','download')
      AND COALESCE(NULLIF(raw.props->'biContext'->>'product',''),NULLIF(p.bi_product,'')) IS NOT NULL
    ` : ""}
    ${withGenericEngagement ? `UNION ALL
    SELECT c.id,g.reference,'engaged',g.product,g.occurred_at,g.source
    FROM general_account_evidence g JOIN candidates c ON c.id=g.contact_id AND c.company_id=g.account_id
    ` : ""}
  ), matched AS MATERIALIZED (
    SELECT c.* FROM candidates c
    LEFT JOIN companies co ON co.id=c.company_id AND co.tenant_id=$1 AND co.client_id=$2
    WHERE ${predicates.map(g => `(${g.contact} AND ${g.interest})`).join(" OR ")}
  )`;
  const evidenceWhere = predicates.map(g => `(${g.contact} AND ${g.interest} AND ${g.evidence})`).join(" OR ");
  return { ctes, values, evidenceWhere };
}

export async function queryAnswerPeople(tenantId: number, clientId: number, plan: AnswerPlan, page: number) {
  const { ctes, values, evidenceWhere } = compileAnswerQuery(tenantId, clientId, plan);
  const client = await pool.connect();
  try {
    await client.query("BEGIN READ ONLY");
    await client.query("SET LOCAL statement_timeout='8s'");
    const result = await client.query(`${ctes}, paged AS (
      SELECT * FROM matched ORDER BY id LIMIT 25 OFFSET $${values.length + 1}
    )
    SELECT (SELECT count(*)::int FROM matched) total, COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id',c.id,'name',trim(COALESCE(c.first_name,'')||' '||COALESCE(c.last_name,'')),
        'email',c.email,'companyId',c.company_id,'company',COALESCE(c.account_name,c.company_name),
        'function',c."function",'title',COALESCE(c.title,c.designation),'city',c.city,'state',c.state,'country',c.country,
        'score',c.intent_score,'dnc',c.dnc,'evidence',COALESCE((
          SELECT jsonb_agg(ev) FROM (
            SELECT DISTINCT e.reference,e.basis,e.product,e.occurred_at AS "occurredAt",e.source
            FROM evidence e LEFT JOIN companies co ON co.id=c.company_id AND co.tenant_id=$1 AND co.client_id=$2
            WHERE e.contact_id=c.id AND (${evidenceWhere})
            ORDER BY "occurredAt" DESC NULLS LAST,e.reference LIMIT 5
          ) ev
        ),'[]'::jsonb))) FROM paged c
    ),'[]'::jsonb) people`, [...values, (page - 1) * 25]);
    await client.query("COMMIT");
    return { total: result.rows[0].total as number, people: result.rows[0].people as any[], page, pageSize: 25 };
  } catch (err) { await client.query("ROLLBACK"); throw err; }
  finally { client.release(); }
}
