import { pool } from "@workspace/db";
import type { PoolClient } from "pg";
import { committeeError, requireHpCommitteeClient } from "./buyingCommittee";
import { committeeCountryValues } from "./buyingCommitteeCountry";

export async function validateCommitteeContactScope(tenantId: number, clientId: number, accountIds: number[], connection: Pick<PoolClient, "query"> = pool) {
  if (!accountIds.length) committeeError("Select at least one HP account.");
  await requireHpCommitteeClient(tenantId, clientId);
  const owned = await connection.query("SELECT id FROM companies WHERE tenant_id=$1 AND client_id=$2 AND id=ANY($3::int[])", [tenantId, clientId, accountIds]);
  if (owned.rowCount !== new Set(accountIds).size) committeeError("Some selected HP accounts are unavailable.", 404);
}

/** Shared by the screen and export: exact same identity matching and evidence rules. */
export const committeePeopleSql = `WITH scoped AS MATERIALIZED (
    SELECT c.* FROM contacts c JOIN companies co ON co.id=c.company_id AND co.tenant_id=c.tenant_id AND co.client_id=c.client_id
    WHERE c.tenant_id=$1 AND c.client_id=$2 AND c.company_id=ANY($3::int[]) AND NOT COALESCE(c.is_anonymous,false)
  ), evidence AS (
    SELECT c.id contact_id,CASE WHEN s.form_type IN('event_feedback','feedback') THEN 'Event questionnaire'
      ELSE 'Lead form / questionnaire' END source
    FROM intent_inbound_submissions s JOIN scoped c ON c.id=s.contact_id AND c.company_id=s.account_id
    WHERE s.tenant_id=$1 AND s.client_id=$2 AND COALESCE(s.identity_review,'')<>'keep'
      AND COALESCE(s.routing_error,'') NOT ILIKE '%email%another account%'
    UNION
    SELECT c.id,'Lead form' FROM form_submissions f JOIN scoped c ON c.id=f.contact_id
      JOIN journeys j ON j.id=f.journey_id AND j.tenant_id=f.tenant_id AND j.client_id=$2 WHERE f.tenant_id=$1
    UNION
    SELECT c.id,'Journey engagement' FROM journey_events je
      JOIN visitor_tokens vt ON vt.tenant_id=je.tenant_id AND vt.token=je.visitor_token
      JOIN scoped c ON c.id=vt.contact_id
      JOIN journeys j ON j.id=je.journey_id AND j.tenant_id=je.tenant_id AND j.client_id=$2
    WHERE je.tenant_id=$1 AND NOT COALESCE(je.is_bot,false)
      AND (je.event_type IN('page_view','button_click','cta_click','link_click','scroll_depth','video_play','video_complete','form_submit','quiz_complete','page_exit','session_start','click')
        OR je.event_type ~ '^scroll_[0-9]+$')
    UNION
    SELECT c.id,'Journey engagement' FROM activity_events a JOIN scoped c ON c.id=a.contact_id
      JOIN journeys j ON j.id=a.journey_id AND j.tenant_id=a.tenant_id AND j.client_id=$2
    WHERE a.tenant_id=$1 AND (a.client_id IS NULL OR a.client_id=$2) AND (a.company_id IS NULL OR a.company_id=c.company_id)
      AND NOT COALESCE(a.is_bot,false)
      AND (a.event_type IN('page_view','button_click','cta_click','link_click','scroll_depth','video_play','video_complete','form_submit','quiz_complete','page_exit','session_start','click')
        OR a.event_type ~ '^scroll_[0-9]+$')
    UNION
    SELECT c.id,CASE WHEN a.event_type='call_completed' THEN 'Completed call' ELSE 'Email interaction' END
    FROM activity_events a JOIN scoped c ON c.id=a.contact_id
    WHERE a.tenant_id=$1 AND (a.client_id IS NULL OR a.client_id=$2)
      AND (a.company_id IS NULL OR a.company_id=c.company_id) AND NOT COALESCE(a.is_bot,false)
      AND a.event_type IN('call_completed','email_reply','email_replied','email_open','email_click')
  ), engaged AS MATERIALIZED (
    SELECT c.*,ARRAY(SELECT DISTINCT e.source FROM evidence e WHERE e.contact_id=c.id ORDER BY e.source) sources
    FROM scoped c WHERE EXISTS(SELECT 1 FROM evidence e WHERE e.contact_id=c.id)
  ), internal AS MATERIALIZED (
    SELECT c.id,jsonb_agg(DISTINCT category.value) categories,min(i.sourced_at) sourced_at
    FROM scoped c JOIN buying_committee_internal_contacts i ON i.contact_id=c.id
      AND i.tenant_id=c.tenant_id AND i.client_id=c.client_id AND i.company_id=c.company_id
    CROSS JOIN LATERAL jsonb_array_elements(i.categories) category(value)
    WHERE ($4::text[] IS NULL OR lower(btrim(c.country))=ANY($4::text[]))
    GROUP BY c.id
  ), database_people AS MATERIALIZED (
    SELECT c.*,COALESCE(e.sources,ARRAY[]::text[]) sources,
      COALESCE(i.categories,'[]'::jsonb) committee_categories,i.sourced_at committee_sourced_at,
      i.id IS NOT NULL internal_match
    FROM scoped c LEFT JOIN engaged e ON e.id=c.id LEFT JOIN internal i ON i.id=c.id
    WHERE e.id IS NOT NULL OR i.id IS NOT NULL
  ), prospects AS MATERIALIZED (
    SELECT b.*,ARRAY(SELECT DISTINCT unnest(e.sources) FROM engaged e
      WHERE e.company_id=b.company_id AND
        (e.identifier='buying-committee:'||b.id
          OR NULLIF(lower(btrim(e.email)),'')=NULLIF(lower(btrim(b.email)),'')
          OR NULLIF(btrim(e.linkedin_url),'')=NULLIF(btrim(b.linkedin),'')) ORDER BY 1) sources
    FROM buying_committee_contacts b WHERE b.tenant_id=$1 AND b.client_id=$2 AND b.company_id=ANY($3::int[])
      AND ($4::text[] IS NULL OR EXISTS(SELECT 1 FROM unnest($4::text[]) AS country(name)
        WHERE lower(btrim(b.location))=country.name OR right(lower(btrim(b.location)),length(country.name)+2)=', '||country.name))
      AND NOT EXISTS(SELECT 1 FROM database_people c WHERE c.internal_match AND c.company_id=b.company_id AND
        (c.identifier='buying-committee:'||b.id
          OR NULLIF(lower(btrim(c.email)),'')=NULLIF(lower(btrim(b.email)),'')
          OR NULLIF(btrim(c.linkedin_url),'')=NULLIF(btrim(b.linkedin),'')))
  ), people AS (
    SELECT 'apollo:'||b.id id,b.company_id "companyId",co.name "companyName",b.name,b.title,b.email,b.phone,b.linkedin,b.location,b.categories,
      'Apollo' source,b.sources "engagementSources",cardinality(b.sources)>0 engaged,b.sourced_at "sourcedAt",
      (SELECT min(c.id) FROM scoped c WHERE c.company_id=b.company_id AND (
        c.identifier='buying-committee:'||b.id
        OR NULLIF(lower(btrim(c.email)),'')=NULLIF(lower(btrim(b.email)),'')
        OR NULLIF(btrim(c.linkedin_url),'')=NULLIF(btrim(b.linkedin),''))
        HAVING count(*)=1) "crmContactId"
    FROM prospects b JOIN companies co ON co.id=b.company_id AND co.tenant_id=b.tenant_id AND co.client_id=b.client_id
    UNION ALL
    SELECT 'contact:'||c.id,c.company_id,co.name,COALESCE(NULLIF(btrim(concat_ws(' ',c.first_name,c.last_name)),''),c.email,'Contact #'||c.id),
      COALESCE(NULLIF(btrim(c.title),''),c.designation),c.email,c.phone,c.linkedin_url,concat_ws(', ',c.city,c.state,c.country),c.committee_categories,
      CASE WHEN c.internal_match THEN 'Internal database' ELSE 'Existing engagement' END,
      c.sources,cardinality(c.sources)>0,c.committee_sourced_at,c.id
    FROM database_people c JOIN companies co ON co.id=c.company_id AND co.tenant_id=c.tenant_id AND co.client_id=c.client_id
    WHERE NOT EXISTS(SELECT 1 FROM prospects b WHERE b.company_id=c.company_id AND
      (c.identifier='buying-committee:'||b.id
        OR NULLIF(lower(btrim(b.email)),'')=NULLIF(lower(btrim(c.email)),'')
        OR NULLIF(btrim(b.linkedin),'')=NULLIF(btrim(c.linkedin_url),'')))
  )`;

/** All dates; only attributable first-party interactions, never score/tag proxies. */
export async function readCommitteeContacts(tenantId: number, clientId: number, accountIds: number[], page: number, pageSize: number, country?: string, planPage = 1) {
  await validateCommitteeContactScope(tenantId, clientId, accountIds);
  const sql = committeePeopleSql;
  const params = [tenantId, clientId, accountIds, committeeCountryValues(country)];
  const [items, count, sourcing, plans] = await Promise.all([
    pool.query(`${sql} SELECT * FROM people ORDER BY engaged DESC,lower(name),"companyId",id LIMIT $5 OFFSET $6`, [...params, pageSize, (page - 1) * pageSize]),
    pool.query(`${sql} SELECT count(*)::int total FROM people`, params),
    pool.query(`WITH latest AS (
      SELECT DISTINCT ON(t.company_id) t.company_id,t.found,t.completed_at,
        CASE WHEN t.status='processing' AND t.started_at<NOW()-interval '5 minutes' THEN 'interrupted' ELSE t.status END status
      FROM buying_committee_targets t JOIN buying_committee_plans p ON p.id=t.plan_id AND p.tenant_id=t.tenant_id
      WHERE t.tenant_id=$1 AND p.client_id=$2 AND t.company_id=ANY($3::int[])
        AND (p.status='approved' OR t.requests>0)
        AND ($4::text[] IS NULL OR lower(p.config->>'country')=ANY($4::text[]))
      ORDER BY t.company_id,t.id DESC
    ) SELECT count(*)::int accounts,
      count(*) FILTER(WHERE status='completed')::int "completedAccounts",
      count(*) FILTER(WHERE status='pending')::int "pendingAccounts",
      count(*) FILTER(WHERE status='processing')::int "processingAccounts",
      count(*) FILTER(WHERE status IN('failed','interrupted'))::int "failedAccounts",
      COALESCE(sum(found) FILTER(WHERE status='completed'),0)::int "returnedContacts",
      max(completed_at) FILTER(WHERE status='completed') "lastCompletedAt" FROM latest`, params),
    // One row per legal account and saved plan. Never imply a parent shares one
    // plan or silently discard earlier plans/countries. Fetch one lookahead row.
    pool.query(`SELECT p.id "planId",p.client_id "clientId",p.name "planName",p.status "planStatus",
        p.config->>'country' country,t.company_id "companyId",c.name "companyName",
        CASE WHEN t.status='processing' AND t.started_at<NOW()-interval '5 minutes' THEN 'interrupted' ELSE t.status END status
      FROM buying_committee_plans p
      JOIN buying_committee_targets t ON t.plan_id=p.id AND t.tenant_id=p.tenant_id
      JOIN companies c ON c.id=t.company_id AND c.tenant_id=p.tenant_id AND c.client_id=p.client_id
      WHERE p.tenant_id=$1 AND p.client_id=$2 AND t.company_id=ANY($3::int[])
        AND ($4::text[] IS NULL OR lower(p.config->>'country')=ANY($4::text[]))
      ORDER BY p.id DESC,t.company_id LIMIT 26 OFFSET $5`, [...params, (planPage - 1) * 25]),
  ]);
  return { items: items.rows, total: count.rows[0].total, page, pageSize, sourcing: sourcing.rows[0],
    savedPlans: { items: plans.rows.slice(0, 25), page: planPage, hasMore: plans.rows.length > 25 } };
}
