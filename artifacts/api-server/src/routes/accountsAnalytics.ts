import { Router, type IRouter, type Request } from "express";
import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  pool,
} from "@workspace/db";
import {
  GetAnalyticsAccountsQueryParams,
  GetAnalyticsAccountsResponse,
  GetAnalyticsAccountParams,
  GetAnalyticsAccountResponse,
  GetAnalyticsAccountActivityParams,
  GetAnalyticsAccountActivityQueryParams,
  GetAnalyticsAccountActivityResponse,
} from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import {
  activityCompanyIdExpression,
  reviewedJourneyAccount,
  verifiedJourneyAccount,
} from "./analyticsAttribution";

const router: IRouter = Router();
router.use(requireAuth);
const dialect = new PgDialect();
const activityCompanyIdSql = dialect.sqlToQuery(activityCompanyIdExpression("ae")).sql;
const journeyCompanyIdSql = dialect.sqlToQuery(sql`COALESCE(
  ${verifiedJourneyAccount(sql`je.tenant_id`, sql`je.id`)},
  ${reviewedJourneyAccount(
    sql`je.tenant_id`, sql`COALESCE(vt.contact_id, fs.contact_id)`,
    sql`je.journey_id`, sql`je.created_at`,
  )},
  c.company_id
)`).sql;

export function accountEventFilterInputs(startIndex: number) {
  return `event_filter_inputs AS (
    SELECT $${startIndex}::timestamptz AS date_from,
           $${startIndex + 1}::timestamptz AS date_to,
           $${startIndex + 2}::int AS journey_id
  )`;
}

function earlyAccountEventScope(alias: "ae" | "je") {
  return `AND EXISTS (
    SELECT 1 FROM event_filter_inputs filter
    WHERE (filter.date_from IS NULL OR ${alias}.created_at >= filter.date_from)
      AND (filter.date_to IS NULL OR ${alias}.created_at < filter.date_to)
      AND (filter.journey_id IS NULL OR ${alias}.journey_id = filter.journey_id)
  )`;
}

/**
 * Candidate IDs are found through account/contact linkage and reviewed event
 * lists first. The relatively expensive canonical attribution expressions are
 * therefore evaluated only for events that could belong to this company page.
 * This follows the same resolution order as Analytics while avoiding a
 * tenant-wide event scan.
 */
export const accountEventCtes = `
  candidate_activity_ids AS (
    SELECT candidate.id
    FROM (
      SELECT ae.id
      FROM activity_events ae
      JOIN candidate_accounts p ON p.id = ae.company_id
      WHERE ae.tenant_id = $1 AND COALESCE(ae.is_bot, false) = false ${earlyAccountEventScope("ae")}
    UNION
    SELECT ae.id
    FROM activity_events ae
    JOIN contacts linked_contact
      ON linked_contact.id = ae.contact_id AND linked_contact.tenant_id = $1
    JOIN candidate_accounts p ON p.id = linked_contact.company_id
    WHERE ae.tenant_id = $1 AND COALESCE(ae.is_bot, false) = false ${earlyAccountEventScope("ae")}
    UNION
    SELECT ae.id
    FROM verified_journey_sessions verified
    CROSS JOIN LATERAL unnest(verified.activity_event_ids) verified_ids(event_id)
    JOIN activity_events ae ON ae.id = verified_ids.event_id AND ae.tenant_id = verified.tenant_id
    JOIN candidate_accounts p ON p.id = verified.account_id
    WHERE verified.tenant_id = $1 AND verified.revoked_at IS NULL
      AND COALESCE(ae.is_bot, false) = false ${earlyAccountEventScope("ae")}
    UNION
    SELECT ae.id
    FROM visitor_tokens vt
    JOIN contacts linked_contact ON linked_contact.id = vt.contact_id AND linked_contact.tenant_id = vt.tenant_id
    JOIN candidate_accounts p ON p.id = linked_contact.company_id
    JOIN activity_events ae ON ae.tenant_id = vt.tenant_id AND ae.visitor_token = vt.token
    WHERE vt.tenant_id = $1 AND COALESCE(ae.is_bot, false) = false ${earlyAccountEventScope("ae")}
    UNION
    SELECT ae.id
    FROM form_submissions fs
    JOIN contacts linked_contact ON linked_contact.id = fs.contact_id AND linked_contact.tenant_id = fs.tenant_id
    JOIN candidate_accounts p ON p.id = linked_contact.company_id
    JOIN activity_events ae ON ae.tenant_id = fs.tenant_id
      AND ae.contact_id IS NULL AND ae.visitor_token = fs.visitor_token
    WHERE fs.tenant_id = $1 AND fs.contact_id IS NOT NULL
      AND COALESCE(ae.is_bot, false) = false ${earlyAccountEventScope("ae")}
    UNION
    SELECT ae.id
    FROM activity_events ae
    LEFT JOIN visitor_tokens vt ON vt.tenant_id = ae.tenant_id AND vt.token = ae.visitor_token
    JOIN intent_inbound_submissions reviewed
      ON reviewed.tenant_id = ae.tenant_id AND reviewed.account_id IN (SELECT id FROM candidate_accounts)
    JOIN candidate_accounts p ON p.id = reviewed.account_id
    WHERE ae.tenant_id = $1 AND COALESCE(ae.is_bot, false) = false
      ${earlyAccountEventScope("ae")}
      AND reviewed.source_id IS NULL
      AND reviewed.raw_fields->>'manualProvenance' = 'manual'
      AND reviewed.raw_fields->'trackedContact'->>'contactId'
          = COALESCE(ae.contact_id::text, vt.contact_id::text)
        AND reviewed.raw_fields->'trackedContact'->>'journeyId' = ae.journey_id::text
    ) candidate
    JOIN activity_events candidate_event
      ON candidate_event.id = candidate.id AND candidate_event.tenant_id = $1
    CROSS JOIN event_filter_inputs filter
    WHERE (filter.date_from IS NULL OR candidate_event.created_at >= filter.date_from)
      AND (filter.date_to IS NULL OR candidate_event.created_at < filter.date_to)
      AND (filter.journey_id IS NULL OR candidate_event.journey_id = filter.journey_id)
  ),
  candidate_journey_ids AS (
    SELECT candidate.id
    FROM (
      SELECT je.id
      FROM verified_journey_sessions verified
    CROSS JOIN LATERAL unnest(verified.event_ids) verified_ids(event_id)
    JOIN journey_events je ON je.id = verified_ids.event_id AND je.tenant_id = verified.tenant_id
    JOIN candidate_accounts p ON p.id = verified.account_id
    WHERE verified.tenant_id = $1 AND verified.revoked_at IS NULL
      ${earlyAccountEventScope("je")}
    UNION
    SELECT je.id
    FROM visitor_tokens vt
    JOIN contacts linked_contact ON linked_contact.id = vt.contact_id AND linked_contact.tenant_id = vt.tenant_id
    JOIN candidate_accounts p ON p.id = linked_contact.company_id
    JOIN journey_events je ON je.tenant_id = vt.tenant_id AND je.visitor_token = vt.token
    WHERE vt.tenant_id = $1 ${earlyAccountEventScope("je")}
    UNION
    SELECT je.id
    FROM form_submissions fs
    JOIN contacts linked_contact ON linked_contact.id = fs.contact_id AND linked_contact.tenant_id = fs.tenant_id
    JOIN candidate_accounts p ON p.id = linked_contact.company_id
    JOIN journey_events je ON je.tenant_id = fs.tenant_id AND je.visitor_token = fs.visitor_token
    WHERE fs.tenant_id = $1 AND fs.contact_id IS NOT NULL ${earlyAccountEventScope("je")}
    UNION
    SELECT je.id
    FROM intent_inbound_submissions reviewed
    JOIN candidate_accounts p ON p.id = reviewed.account_id
    JOIN journeys mapped_journey
      ON mapped_journey.tenant_id = reviewed.tenant_id
      AND mapped_journey.id::text = reviewed.raw_fields->'trackedContact'->>'journeyId'
      AND mapped_journey.client_id = reviewed.client_id
    JOIN visitor_tokens vt
      ON vt.tenant_id = reviewed.tenant_id
      AND vt.contact_id::text = reviewed.raw_fields->'trackedContact'->>'contactId'
    JOIN journey_events je ON je.tenant_id = reviewed.tenant_id
      AND je.journey_id = mapped_journey.id AND je.visitor_token = vt.token
    WHERE reviewed.tenant_id = $1 AND reviewed.source_id IS NULL
      AND reviewed.raw_fields->>'manualProvenance' = 'manual' ${earlyAccountEventScope("je")}
    UNION
    SELECT je.id
    FROM intent_inbound_submissions reviewed
    JOIN candidate_accounts p ON p.id = reviewed.account_id
    JOIN journeys mapped_journey
      ON mapped_journey.tenant_id = reviewed.tenant_id
      AND mapped_journey.id::text = reviewed.raw_fields->'trackedContact'->>'journeyId'
      AND mapped_journey.client_id = reviewed.client_id
    JOIN form_submissions fs
      ON fs.tenant_id = reviewed.tenant_id
      AND fs.contact_id::text = reviewed.raw_fields->'trackedContact'->>'contactId'
    JOIN journey_events je ON je.tenant_id = reviewed.tenant_id
      AND je.journey_id = mapped_journey.id AND je.visitor_token = fs.visitor_token
    WHERE reviewed.tenant_id = $1 AND reviewed.source_id IS NULL
        AND reviewed.raw_fields->>'manualProvenance' = 'manual' ${earlyAccountEventScope("je")}
    ) candidate
    JOIN journey_events candidate_event
      ON candidate_event.id = candidate.id AND candidate_event.tenant_id = $1
    CROSS JOIN event_filter_inputs filter
    WHERE (filter.date_from IS NULL OR candidate_event.created_at >= filter.date_from)
      AND (filter.date_to IS NULL OR candidate_event.created_at < filter.date_to)
      AND (filter.journey_id IS NULL OR candidate_event.journey_id = filter.journey_id)
  ),
  activity_event_rows AS (
    SELECT ${activityCompanyIdSql} AS account_id,
           'activity_event'::text AS source_type, ae.id AS source_id,
           ae.event_type, ae.description, ae.created_at,
           c.id AS contact_id,
           CASE WHEN c.id IS NOT NULL
                  THEN COALESCE(NULLIF(concat_ws(' ', c.first_name, c.last_name), ''), ae.contact_name)
                WHEN ae.contact_id IS NULL THEN ae.contact_name
                ELSE NULL END AS contact_name,
           COALESCE(ae.score_delta, 0)::float8 AS score_delta,
           ae.journey_id, j.name AS journey_name, ae.page_name, ae.stage,
           ae.visitor_token, ae.contact_id AS match_contact_id
    FROM candidate_activity_ids candidate
    JOIN activity_events ae ON ae.id = candidate.id AND ae.tenant_id = $1
    LEFT JOIN contacts c ON c.id = ae.contact_id AND c.tenant_id = $1
    LEFT JOIN journeys j ON j.id = ae.journey_id AND j.tenant_id = $1
    JOIN candidate_accounts p ON p.id = ${activityCompanyIdSql}
    WHERE COALESCE(ae.is_bot, false) = false
  ),
  journey_event_rows AS (
    SELECT ${journeyCompanyIdSql} AS account_id,
           'journey_event'::text AS source_type, je.id AS source_id,
           je.event_type, NULL::text AS description, je.created_at,
           c.id AS contact_id,
           NULLIF(concat_ws(' ', c.first_name, c.last_name), '') AS contact_name,
           0::float8 AS score_delta,
           je.journey_id, j.name AS journey_name,
           NULLIF(TRIM(COALESCE(jp.title, '')), '') AS page_name,
           COALESCE(c.stage, 'pre-aware') AS stage,
           je.visitor_token, COALESCE(vt.contact_id, fs.contact_id) AS match_contact_id
    FROM candidate_journey_ids candidate
    JOIN journey_events je ON je.id = candidate.id AND je.tenant_id = $1
    LEFT JOIN visitor_tokens vt ON vt.tenant_id = je.tenant_id AND vt.token = je.visitor_token
    LEFT JOIN LATERAL (
      SELECT fs.contact_id
      FROM form_submissions fs
      WHERE fs.tenant_id = je.tenant_id AND fs.visitor_token = je.visitor_token
        AND fs.contact_id IS NOT NULL
      ORDER BY fs.submitted_at DESC
      LIMIT 1
    ) fs ON TRUE
    LEFT JOIN contacts c
      ON c.id = COALESCE(vt.contact_id, fs.contact_id) AND c.tenant_id = je.tenant_id
    LEFT JOIN journeys j ON j.id = je.journey_id AND j.tenant_id = je.tenant_id
    LEFT JOIN journey_pages jp ON jp.id = je.page_id AND jp.journey_id = je.journey_id
    JOIN candidate_accounts p ON p.id = ${journeyCompanyIdSql}
    WHERE COALESCE(je.is_bot, false) = false
  ),
  /* Bound deduplication to actual page views, not every email/send/system event.
     Materialize once so the correlated identity/time test scans a small set. */
  activity_page_views AS MATERIALIZED (
    SELECT account_id,event_type,journey_id,created_at,match_contact_id,visitor_token
    FROM activity_event_rows WHERE event_type='page_view'
  ),
  account_events AS (
    SELECT * FROM activity_event_rows
    UNION ALL
    SELECT v.*
    FROM journey_event_rows v
    WHERE NOT (
      v.event_type = 'page_view'
      AND EXISTS (
        SELECT 1
        FROM activity_page_views a
        WHERE a.account_id = v.account_id
          AND a.event_type = 'page_view'
          AND a.journey_id = v.journey_id
          AND a.created_at > v.created_at - INTERVAL '120 seconds'
          AND a.created_at < v.created_at + INTERVAL '120 seconds'
          AND (
            (v.match_contact_id IS NOT NULL AND a.match_contact_id = v.match_contact_id)
            OR (v.visitor_token IS NOT NULL AND a.visitor_token = v.visitor_token)
          )
      )
    )
  )
`;

/** Shared canonical attribution and deduplication for HP reporting. */
export async function loadHpAttributedEvents(tenantId: number, clientId: number, start: string, end: string) {
  const result = await pool.query(`WITH candidate_accounts AS (
    SELECT id FROM companies WHERE tenant_id=$1 AND client_id=$2
  ), ${accountEventFilterInputs(3)}, ${accountEventCtes}
  SELECT e.account_id,e.contact_id,e.event_type,e.created_at,e.source_type,e.source_id,e.journey_id,e.journey_name,e.page_name,
    context.bi_category,context.bi_product,context.bi_program, raw.props AS journey_props, rawae.metadata AS activity_metadata,
    rawae.source AS activity_source
  FROM account_events e
  LEFT JOIN journey_events raw ON e.source_type='journey_event' AND raw.id=e.source_id AND raw.tenant_id=$1
  LEFT JOIN activity_events rawae ON e.source_type='activity_event' AND rawae.id=e.source_id AND rawae.tenant_id=$1
  LEFT JOIN LATERAL (
    SELECT p.bi_category,p.bi_product,p.bi_program FROM journey_pages p
    WHERE p.journey_id=e.journey_id AND (p.id=raw.page_id OR (raw.id IS NULL AND p.title=e.page_name
      AND (SELECT count(*) FROM journey_pages other WHERE other.journey_id=e.journey_id AND other.title=e.page_name)=1))
    LIMIT 1
  ) context ON TRUE
  WHERE e.event_type IN
    ('page_view','cta_click','asset_download','download','form_submit','form_submitted','email_open','email_click','call_completed',
     'telesales_contact','sales_rep_contact')
  ORDER BY e.created_at,e.source_type,e.source_id`, [tenantId, clientId, start, end, null]);
  return result.rows;
}

function isPositiveIntegerText(value: unknown, max = Number.MAX_SAFE_INTEGER): value is string {
  return typeof value === "string" && /^[1-9]\d*$/.test(value)
    && Number.isSafeInteger(Number(value)) && Number(value) <= max;
}

function tenantIdFrom(req: Request): number {
  return Number((req.user as any)?.tenantId);
}

function queryValue(req: Request, key: string): unknown {
  return (req.query as Record<string, unknown>)[key];
}

function parseListQuery(req: Request) {
  const filters = parseAccountFilters(req);
  const clientId = queryValue(req, "clientId");
  const page = queryValue(req, "page");
  const limit = queryValue(req, "limit");
  const q = queryValue(req, "q");
  if (!filters || q !== undefined && typeof q !== "string") return null;
  if (clientId !== undefined && !isPositiveIntegerText(clientId, 2_147_483_647)) return null;
  if (page !== undefined && !isPositiveIntegerText(page)) return null;
  if (limit !== undefined && !isPositiveIntegerText(limit, 50)) return null;
  const parsed = GetAnalyticsAccountsQueryParams.safeParse({
    ...req.query,
    ...(req.query.companyIds !== undefined ? { companyId: undefined } : {}),
    ...(req.query.dateFrom ? { dateFrom: new Date(`${String(req.query.dateFrom)}T00:00:00+05:30`) } : {}),
    ...(req.query.dateTo ? { dateTo: new Date(`${String(req.query.dateTo)}T00:00:00+05:30`) } : {}),
  });
  if (!parsed.success) return null;
  if (!Number.isSafeInteger((parsed.data.page - 1) * parsed.data.limit)) return null;
  return {
    ...filters,
    q: parsed.data.q?.trim() || null,
    page: parsed.data.page,
    limit: parsed.data.limit,
  };
}

function parseActivityQuery(req: Request) {
  const filters = parseAccountFilters(req);
  const page = queryValue(req, "page");
  const limit = queryValue(req, "limit");
  if (!filters || page !== undefined && !isPositiveIntegerText(page)) return null;
  if (limit !== undefined && !isPositiveIntegerText(limit, 50)) return null;
  const parsed = GetAnalyticsAccountActivityQueryParams.safeParse({
    ...req.query,
    ...(req.query.companyIds !== undefined ? { companyId: undefined } : {}),
    ...(req.query.dateFrom ? { dateFrom: new Date(`${String(req.query.dateFrom)}T00:00:00+05:30`) } : {}),
    ...(req.query.dateTo ? { dateTo: new Date(`${String(req.query.dateTo)}T00:00:00+05:30`) } : {}),
  });
  if (!parsed.success) return null;
  if (!Number.isSafeInteger((parsed.data.page - 1) * parsed.data.limit)) return null;
  return { ...filters, page: parsed.data.page, limit: parsed.data.limit };
}

function parsedAccountId(req: Request): number | null {
  if (!isPositiveIntegerText(req.params.id, 2_147_483_647)) return null;
  const parsed = GetAnalyticsAccountParams.safeParse(req.params);
  return parsed.success && Number.isSafeInteger(parsed.data.id)
    && parsed.data.id <= 2_147_483_647 ? parsed.data.id : null;
}

const FILTER_STAGES = new Set(["pre-aware", "aware", "pre-engage", "engage", "advance-engage", "action"]);
type AccountFilters = {
  clientId: number | null;
  companyIds: number[] | null;
  inboundOnly: boolean;
  playId: number | null;
  journeyId: number | null;
  stages: string[] | null;
  scoreMin: number | null;
  scoreMax: number | null;
  dateFrom: string | null;
  dateTo: string | null;
  status: "hot" | "warm" | "cold" | "uncategorized" | null;
};

function queryText(req: Request, key: string): string | null | false {
  const value = queryValue(req, key);
  if (value == null || value === "") return null;
  return typeof value === "string" ? value : false;
}

function parseAccountFilters(req: Request): AccountFilters | null {
  const clientRaw = queryText(req, "clientId");
  const playRaw = queryText(req, "playId");
  const journeyRaw = queryText(req, "journeyId");
  const companyRaw = queryText(req, "companyId");
  const companiesRaw = queryText(req, "companyIds");
  const stageRaw = queryText(req, "stage");
  const stagesRaw = queryText(req, "stages");
  const dateFrom = queryText(req, "dateFrom");
  const dateTo = queryText(req, "dateTo");
  const scoreMinRaw = queryText(req, "scoreMin");
  const scoreMaxRaw = queryText(req, "scoreMax");
  const inboundValue = queryValue(req, "inboundOnly");
  const statusRaw = queryText(req, "status");
  const inboundRaw = inboundValue === undefined || inboundValue === null ? null
    : typeof inboundValue === "string" ? inboundValue : false;
  if ([clientRaw, playRaw, journeyRaw, companiesRaw, stageRaw, stagesRaw, dateFrom, dateTo,
    scoreMinRaw, scoreMaxRaw, inboundRaw, statusRaw].includes(false)
    || (companiesRaw === null && companyRaw === false)) return null;
  if (statusRaw !== null && !["hot", "warm", "cold", "uncategorized"].includes(statusRaw as string)) return null;
  const positive = (value: string | null) => value == null ? null
    : isPositiveIntegerText(value, 2_147_483_647) ? Number(value) : false;
  const clientId = positive(clientRaw as string | null);
  const playId = positive(playRaw as string | null);
  const journeyId = positive(journeyRaw as string | null);
  const companyId = companiesRaw !== null ? null : positive(companyRaw as string | null);
  if ([clientId, playId, journeyId, companyId].includes(false)) return null;
  let companyIds: number[] | null = null;
  if (companiesRaw !== null || companyId !== null) {
    const values = companiesRaw !== null ? (companiesRaw as string).split(",") : [String(companyId)];
    if (values.length > 200 || values.some(value => !/^[1-9]\d*$/.test(value))) return null;
    const parsed = values.map(Number);
    if (parsed.some(value => !Number.isSafeInteger(value) || value > 2_147_483_647)) return null;
    companyIds = [...new Set(parsed)];
  }
  const inboundOnly = inboundRaw !== null;
  if (inboundOnly && inboundRaw !== "1") return null;
  const stages = stageRaw !== null || stagesRaw !== null
    ? [...new Set([...(stageRaw ? [stageRaw as string] : []), ...(stagesRaw ? (stagesRaw as string).split(",") : [])])]
    : null;
  if (stages?.some(stage => !FILTER_STAGES.has(stage))) return null;
  const parseScore = (value: string | null): number | null | false => {
    if (value == null) return null;
    if (!/^(?:\d+\.?\d*|\.\d+)$/.test(value)) return false;
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 && parsed <= 100 ? parsed : false;
  };
  const scoreMin = parseScore(scoreMinRaw as string | null);
  const scoreMax = parseScore(scoreMaxRaw as string | null);
  if (scoreMin === false || scoreMax === false || (scoreMin !== null && scoreMax !== null && scoreMin > scoreMax)) return null;
  const validDay = (value: string | null) => value === null || /^\d{4}-\d{2}-\d{2}$/.test(value)
    && !Number.isNaN(Date.parse(`${value}T00:00:00Z`))
    && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
  if (!validDay(dateFrom as string | null) || !validDay(dateTo as string | null)
    || (dateFrom && dateTo && (dateFrom as string) > (dateTo as string))) return null;
  return {
    clientId: clientId as number | null, companyIds, inboundOnly,
    playId: playId as number | null, journeyId: journeyId as number | null,
    stages, scoreMin: scoreMin as number | null, scoreMax: scoreMax as number | null,
    dateFrom: dateFrom as string | null, dateTo: dateTo as string | null,
    status: statusRaw as AccountFilters["status"],
  };
}

function eventFilterActive(filters: AccountFilters) {
  return !!(filters.playId || filters.journeyId || filters.stages || filters.scoreMin !== null
    || filters.scoreMax !== null || filters.dateFrom || filters.dateTo);
}

async function resolveAccountFilters(tenantId: number, filters: AccountFilters): Promise<AccountFilters | null> {
  if (filters.clientId !== null) {
    const client = await pool.query("SELECT 1 FROM clients WHERE tenant_id=$1 AND id=$2", [tenantId, filters.clientId]);
    if (!client.rowCount) return null;
  }
  if (filters.playId !== null) {
    const play = await pool.query("SELECT 1 FROM abm_plays WHERE tenant_id=$1 AND id=$2 AND ($3::int IS NULL OR client_id=$3)",
      [tenantId, filters.playId, filters.clientId]);
    if (!play.rowCount) return null;
  }
  if (filters.journeyId !== null) {
    const journey = await pool.query(
      "SELECT 1 FROM journeys WHERE tenant_id=$1 AND id=$2 AND ($3::int IS NULL OR client_id=$3)",
      [tenantId, filters.journeyId, filters.clientId],
    );
    if (!journey.rowCount) return null;
  }
  if (filters.companyIds !== null) {
    const selected = await pool.query<{id:number}>(`SELECT id FROM companies
      WHERE tenant_id=$1 AND id=ANY($2::int[]) AND ($3::int IS NULL OR client_id=$3)`,
    [tenantId, filters.companyIds, filters.clientId]);
    if (selected.rowCount !== filters.companyIds.length) return null;
  } else if (filters.inboundOnly) {
    if (filters.clientId === null) return null;
    const inbound = await pool.query<{id:number}>(`SELECT c.id FROM companies c
      WHERE c.tenant_id=$1 AND c.client_id=$2 AND (c.inbound_manual=true OR EXISTS(
        SELECT 1 FROM intent_inbound_submissions s
        WHERE s.tenant_id=c.tenant_id AND s.client_id=c.client_id AND s.account_id=c.id
      ))`, [tenantId, filters.clientId]);
    filters = { ...filters, companyIds: inbound.rows.map(row => Number(row.id)) };
  }
  return filters;
}

function accountEventFilterSql(startIndex: number) {
  const n = (offset: number) => `$${startIndex + offset}`;
  // play filters use only an explicit, tenant-owned journey_plays link; plays
  // do not otherwise imply that every account for their client is in scope.
  return `(${n(0)}::timestamptz IS NULL OR e.created_at >= ${n(0)})
    AND (${n(1)}::timestamptz IS NULL OR e.created_at < ${n(1)})
    AND (${n(2)}::int IS NULL OR e.journey_id=${n(2)})
    AND (${n(3)}::text[] IS NULL OR e.stage=ANY(${n(3)}::text[]))
    AND (${n(4)}::float8 IS NULL OR EXISTS(SELECT 1 FROM contacts score_contact WHERE
      score_contact.tenant_id=$1 AND score_contact.id=e.contact_id AND score_contact.lead_score >= ${n(4)}))
    AND (${n(5)}::float8 IS NULL OR EXISTS(SELECT 1 FROM contacts score_contact WHERE
      score_contact.tenant_id=$1 AND score_contact.id=e.contact_id AND score_contact.lead_score <= ${n(5)}))
    AND (${n(6)}::int IS NULL OR EXISTS(SELECT 1 FROM journey_plays jp JOIN abm_plays p
      ON p.id=jp.play_id AND p.tenant_id=$1 WHERE jp.journey_id=e.journey_id AND jp.play_id=${n(6)}))`;
}

function accountEventFilterParams(filters: AccountFilters) {
  const dayStart = (value: string | null) => value ? new Date(`${value}T00:00:00+05:30`).toISOString() : null;
  const dayEnd = (value: string | null) => {
    if (!value) return null;
    const next = new Date(`${value}T00:00:00+05:30`);
    next.setUTCDate(next.getUTCDate() + 1);
    return next.toISOString();
  };
  return [
    dayStart(filters.dateFrom), dayEnd(filters.dateTo), filters.journeyId,
    filters.stages, filters.scoreMin, filters.scoreMax, filters.playId,
  ];
}

/**
 * The company page is sliced before any contact/event aggregation. Every
 * aggregate is tenant-scoped and restricted to those page IDs, so large
 * tenants do not aggregate every company merely to render one page.
 */
export async function loadAccountSummaries(
  tenantId: number,
  options: {
    clientId?: number | null; q?: string | null; accountId?: number; page?: number; limit?: number;
    companyIds?: number[] | null; filters?: AccountFilters;
  } = {},
) {
  const page = options.page ?? 1;
  const limit = options.limit ?? 1;
  const limitPlusOne = limit + 1;
  const offset = (page - 1) * limit;
  const filters = options.filters ?? {
    clientId:null,companyIds:null,inboundOnly:false,playId:null,journeyId:null,stages:null,
    scoreMin:null,scoreMax:null,dateFrom:null,dateTo:null,status:null,
  };
  const hasEventFilters = eventFilterActive(filters);
  const accountSelectionCtes = hasEventFilters
    ? `candidate_accounts AS (SELECT id FROM eligible),
       ${accountEventFilterInputs(9)},
       ${accountEventCtes},
       filtered_account_events AS (
         SELECT e.* FROM account_events e WHERE ${accountEventFilterSql(9)}
       ),
       matching_eligible AS (
         SELECT x.* FROM eligible x
         WHERE $16::boolean=false OR EXISTS (
           SELECT 1 FROM filtered_account_events e WHERE e.account_id=x.id
         )
       ),
       page_slice AS (
         SELECT id, name, client_name, COUNT(*) OVER()::int AS total
         FROM matching_eligible
         ORDER BY name, id
         LIMIT $5 OFFSET $6
       ),
       page_accounts AS (
         SELECT * FROM page_slice ORDER BY name, id LIMIT $7
       )`
    : `page_slice AS (
         SELECT id, name, client_name, COUNT(*) OVER()::int AS total
         FROM eligible
         ORDER BY name, id
         LIMIT $5 OFFSET $6
       ),
       page_accounts AS (
         SELECT * FROM page_slice ORDER BY name, id LIMIT $7
       ),
       candidate_accounts AS (SELECT id FROM page_accounts),
       ${accountEventFilterInputs(9)},
       ${accountEventCtes},
       filtered_account_events AS (
         SELECT e.* FROM account_events e WHERE ${accountEventFilterSql(9)}
       )`;
  const result = await pool.query(
    `WITH eligible AS (
       SELECT co.id, co.name, cl.name AS client_name
       FROM companies co
       LEFT JOIN clients cl ON cl.id = co.client_id AND cl.tenant_id = co.tenant_id
       WHERE co.tenant_id = $1
         AND ($2::int IS NULL OR (co.client_id = $2 AND cl.id IS NOT NULL))
         AND ($3::text IS NULL OR position(lower($3) in lower(co.name)) > 0
              OR position(lower($3) in lower(COALESCE(cl.name, ''))) > 0)
         AND ($4::int IS NULL OR co.id = $4)
          AND ($8::int[] IS NULL OR co.id=ANY($8::int[]))
          AND ($17::text IS NULL OR COALESCE((
            SELECT CASE WHEN COUNT(*)=0 THEN NULL
                        WHEN bool_or(s.classification='hot') THEN 'hot'
                        WHEN bool_or(s.classification='warm') THEN 'warm'
                        ELSE 'cold' END
            FROM intent_inbound_submissions s
            WHERE s.tenant_id=co.tenant_id AND s.account_id=co.id
          ), 'uncategorized') = $17)
     ),
      ${accountSelectionCtes},
      contact_agg AS (
        SELECT c.company_id AS account_id,
               COUNT(*)::int AS contact_count,
               COALESCE(SUM(c.lead_score), 0)::float8 AS activity_score,
               MAX(c.last_activity) AS contact_last_activity
        FROM contacts c
        JOIN page_accounts p ON p.id = c.company_id
        WHERE c.tenant_id = $1
          AND ($16::boolean=false OR EXISTS(
            SELECT 1 FROM filtered_account_events e WHERE e.account_id=p.id AND e.contact_id=c.id
          ))
        GROUP BY c.company_id
      ),
     event_agg AS (
        SELECT e.account_id, COUNT(*)::int AS event_count,
               (COUNT(DISTINCT e.journey_id) FILTER (WHERE e.journey_name IS NOT NULL))::int AS journey_count,
              MAX(e.created_at) AS event_last_activity
          FROM filtered_account_events e
          JOIN page_accounts p ON p.id=e.account_id
       GROUP BY e.account_id
     ),
     intent_agg AS (
       SELECT es.account_id, es.score
       FROM intent_entity_scores es
       JOIN page_accounts p ON p.id = es.account_id
       WHERE es.tenant_id = $1 AND es.account_id IS NOT NULL
     ),
     gtm_agg AS (
       SELECT s.account_id,
              CASE WHEN bool_or(s.classification = 'hot') THEN 'hot'
                   WHEN bool_or(s.classification = 'warm') THEN 'warm'
                   ELSE 'cold' END AS status,
              MAX(s.updated_at) AS updated_at
       FROM intent_inbound_submissions s
       JOIN page_accounts p ON p.id = s.account_id
       WHERE s.tenant_id = $1
       GROUP BY s.account_id
     )
     SELECT p.id, p.name, p.client_name, p.total,
            COALESCE(ca.contact_count, 0)::int AS contact_count,
            COALESCE(ca.activity_score, 0)::float8 AS activity_score,
            ia.score AS intent_score,
            ga.status AS gtm_status, ga.updated_at AS gtm_updated_at,
            CASE WHEN ca.contact_last_activity IS NULL THEN ea.event_last_activity
                 WHEN ea.event_last_activity IS NULL THEN ca.contact_last_activity
                 ELSE GREATEST(ca.contact_last_activity, ea.event_last_activity) END AS last_activity,
            COALESCE(ea.journey_count, 0)::int AS journey_count,
            COALESCE(ea.event_count, 0)::int AS event_count,
             COALESCE(recent_journey.journey_name, routed_journey.journey_name) AS journey_name,
             key_contact.contact_name AS key_contact_name,
            (SELECT COUNT(*)::int FROM page_slice) > $7 AS has_more
     FROM page_accounts p
     LEFT JOIN contact_agg ca ON ca.account_id = p.id
     LEFT JOIN event_agg ea ON ea.account_id = p.id
     LEFT JOIN intent_agg ia ON ia.account_id = p.id
     LEFT JOIN gtm_agg ga ON ga.account_id = p.id
      LEFT JOIN LATERAL (
        SELECT e.journey_name
        FROM filtered_account_events e
        WHERE e.account_id=p.id AND e.journey_name IS NOT NULL
        ORDER BY e.created_at DESC, e.source_id DESC
        LIMIT 1
      ) recent_journey ON TRUE
      LEFT JOIN LATERAL (
        SELECT j.name AS journey_name
        FROM intent_inbound_submissions s
        LEFT JOIN intent_inbound_manual_routes mr
          ON mr.tenant_id=s.tenant_id AND mr.submission_id=s.id
        LEFT JOIN intent_inbound_routing_rules rule
          ON rule.tenant_id=s.tenant_id AND rule.id=s.routed_rule_id
        JOIN journeys j ON j.tenant_id=s.tenant_id
          AND j.id=COALESCE(mr.journey_id, rule.journey_id)
        JOIN companies co ON co.tenant_id=s.tenant_id AND co.id=s.account_id AND co.client_id=j.client_id
        WHERE s.tenant_id=$1 AND s.account_id=p.id
          AND s.routing_status='routed' AND $16::boolean=false
        ORDER BY s.routed_at DESC NULLS LAST, s.updated_at DESC, s.id DESC
        LIMIT 1
      ) routed_journey ON TRUE
      LEFT JOIN LATERAL (
        SELECT NULLIF(TRIM(CONCAT_WS(' ', ct.first_name, ct.last_name)), '') AS contact_name
        FROM contacts ct
        WHERE ct.tenant_id=$1 AND ct.company_id=p.id
          AND ($16::boolean=false OR EXISTS (
            SELECT 1 FROM filtered_account_events e
            WHERE e.account_id=p.id AND e.contact_id=ct.id
          ))
          AND NULLIF(TRIM(CONCAT_WS(' ', ct.first_name, ct.last_name)), '') IS NOT NULL
        ORDER BY (
          SELECT MAX(s.updated_at)
          FROM intent_inbound_submissions s
          WHERE s.tenant_id=$1 AND s.account_id=p.id AND s.contact_id=ct.id
        ) DESC NULLS LAST, ct.lead_score DESC NULLS LAST, ct.id
        LIMIT 1
      ) key_contact ON TRUE
     ORDER BY p.name, p.id`,
    [
      tenantId,
      options.clientId ?? null,
      options.q ?? null,
      options.accountId ?? null,
      limitPlusOne,
      offset,
      limit,
       options.companyIds ?? null,
       ...accountEventFilterParams(filters),
       hasEventFilters,
        filters.status,
    ],
  );
  const rows = result.rows as Array<Record<string, any>>;
  const hasMore = rows.length > 0 ? Boolean(rows[0].has_more) : false;
  return {
    rows: rows.map((row) => ({
      id: Number(row.id),
      name: row.name,
      clientName: row.client_name,
      contactCount: Number(row.contact_count),
      activityScore: Number(row.activity_score),
      intentScore: row.intent_score == null ? null : Number(row.intent_score),
      gtmStatus: row.gtm_status == null ? null : {
        status: row.gtm_status,
        updatedAt: row.gtm_updated_at,
      },
      lastActivity: row.last_activity,
      journeyCount: Number(row.journey_count),
      eventCount: Number(row.event_count),
      journeyName: row.journey_name,
      keyContactName: row.key_contact_name,
    })),
    hasMore,
    total: rows.length > 0 ? Number(rows[0].total) : 0,
  };
}

router.get("/analytics/accounts", async (req, res): Promise<void> => {
  const params = parseListQuery(req);
  if (!params) {
    res.status(400).json({ error: "Invalid account analytics filters or pagination" });
    return;
  }
  const tenantId = tenantIdFrom(req);
  if (!Number.isSafeInteger(tenantId) || tenantId <= 0) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }
  const filters = await resolveAccountFilters(tenantId, params);
  if (!filters) { res.status(400).json({ error: "One or more filter selections are invalid or unavailable for this tenant/client" }); return; }
  const data = await loadAccountSummaries(tenantId, {
    ...params, clientId: filters.clientId, companyIds: filters.companyIds, filters,
  });
  res.json(GetAnalyticsAccountsResponse.parse({
    items: data.rows,
    page: params.page,
    hasMore: data.hasMore,
    total: data.total,
  }));
});

router.get("/analytics/accounts/:id", async (req, res): Promise<void> => {
  const accountId = parsedAccountId(req);
  const filters = parseActivityQuery(req);
  if (accountId === null || !filters) {
    res.status(400).json({ error: "Invalid account ID or analytics filters" });
    return;
  }
  const tenantId = tenantIdFrom(req);
  const resolvedFilters = await resolveAccountFilters(tenantId, filters);
  if (!resolvedFilters) { res.status(400).json({ error: "One or more filter selections are invalid or unavailable for this tenant/client" }); return; }
  const [summary, contactResult, journeyResult] = await Promise.all([
    loadAccountSummaries(tenantId, {
      accountId, clientId: resolvedFilters.clientId, companyIds: resolvedFilters.companyIds,
      filters: resolvedFilters,
    }),
    pool.query(
      `WITH candidate_accounts AS (
         SELECT id FROM companies WHERE tenant_id=$1 AND id=$2
       ),
       ${accountEventFilterInputs(4)},
       ${accountEventCtes},
        journey_contacts AS (
          SELECT DISTINCT e.contact_id
          FROM account_events e
          WHERE e.account_id=$2 AND e.contact_id IS NOT NULL
            AND e.journey_id IS NOT NULL AND e.event_type='page_view'
        ),
        inbound_contacts AS (
          SELECT s.contact_id,
                 BOOL_OR(s.form_type='lead_form') AS lead_form,
                 BOOL_OR(s.form_type='event_feedback') AS event_feedback,
                 CASE
                   WHEN BOOL_OR(s.classification='hot') THEN 'hot'
                   WHEN BOOL_OR(s.classification='warm') THEN 'warm'
                   ELSE 'cold'
                 END AS gtm_status,
                 MAX(s.updated_at) AS gtm_updated_at
          FROM intent_inbound_submissions s
          JOIN contacts linked ON linked.id=s.contact_id AND linked.tenant_id=s.tenant_id
            AND linked.company_id=$2
          WHERE s.tenant_id=$1 AND s.account_id=$2
            AND s.form_type IN ('lead_form', 'event_feedback')
          GROUP BY s.contact_id
        ),
       filtered_account_events AS (
          SELECT e.* FROM account_events e WHERE ${accountEventFilterSql(7)}
       )
       SELECT c.id, concat_ws(' ', c.first_name, c.last_name) AS name,
               c.lead_score, c.stage, c.last_activity,
               COALESCE(inbound.lead_form, false) AS lead_form,
               COALESCE(inbound.event_feedback, false) AS event_feedback,
               (journey.contact_id IS NOT NULL) AS journey,
               inbound.gtm_status, inbound.gtm_updated_at
       FROM contacts c
       JOIN companies co ON co.id = c.company_id AND co.tenant_id = c.tenant_id
        LEFT JOIN journey_contacts journey ON journey.contact_id=c.id
        LEFT JOIN inbound_contacts inbound ON inbound.contact_id=c.id
       WHERE c.tenant_id = $1 AND co.id = $2
         AND ($3::boolean=false OR c.id IN (SELECT contact_id FROM filtered_account_events WHERE account_id=$2 AND contact_id IS NOT NULL))
        ORDER BY CASE WHEN journey.contact_id IS NOT NULL
               AND (COALESCE(inbound.lead_form, false) OR COALESCE(inbound.event_feedback, false))
               THEN 0 ELSE 1 END,
               c.lead_score DESC, c.id
       LIMIT 200`,
      [tenantId, accountId, eventFilterActive(resolvedFilters), null, null, null, ...accountEventFilterParams(resolvedFilters)],
    ),
    pool.query(
      `WITH candidate_accounts AS (
         SELECT id FROM companies WHERE tenant_id = $1 AND id = $2
       ),
       ${accountEventFilterInputs(3)},
       ${accountEventCtes}
        , filtered_account_events AS (
          SELECT e.* FROM account_events e WHERE ${accountEventFilterSql(3)}
        )
       SELECT e.journey_id AS id, e.journey_name AS name,
              COUNT(*) FILTER (WHERE e.event_type = 'page_view')::int AS views,
              MAX(e.created_at) AS last_activity
        FROM filtered_account_events e
       WHERE e.account_id = $2 AND e.journey_name IS NOT NULL
       GROUP BY e.journey_id, e.journey_name
       ORDER BY MAX(e.created_at) DESC NULLS LAST, e.journey_name, e.journey_id`,
      [tenantId, accountId, ...accountEventFilterParams(resolvedFilters)],
    ),
  ]);
  if (!summary.rows.length) {
    res.status(404).json({ error: "Account not found" });
    return;
  }
  const contacts = contactResult.rows.map((row: any) => ({
    id: Number(row.id),
    name: row.name ?? "",
    leadScore: Number(row.lead_score),
    stage: row.stage,
    lastActivity: row.last_activity,
    leadForm: row.lead_form,
    eventFeedback: row.event_feedback,
    journey: row.journey,
    gtmStatus: row.gtm_status
      ? { status: row.gtm_status, updatedAt: row.gtm_updated_at }
      : null,
  }));
  const journeys = journeyResult.rows.map((row: any) => ({
    id: Number(row.id),
    name: row.name,
    views: Number(row.views),
    lastActivity: row.last_activity,
  }));
  res.json(GetAnalyticsAccountResponse.parse({
    account: summary.rows[0],
    contacts,
    journeys,
    contactCount: summary.rows[0].contactCount,
  }));
});

router.get("/analytics/accounts/:id/activity", async (req, res): Promise<void> => {
  const accountId = parsedAccountId(req);
  const pagination = parseActivityQuery(req);
  if (accountId === null || !pagination) {
    res.status(400).json({ error: "id, page, and limit must be valid positive integers; limit must be at most 50" });
    return;
  }
  const tenantId = tenantIdFrom(req);
  const resolvedFilters = await resolveAccountFilters(tenantId, pagination);
  if (!resolvedFilters) {
    res.status(400).json({ error: "One or more filter selections are invalid or unavailable for this tenant/client" });
    return;
  }
  const accountScope = await loadAccountSummaries(tenantId, {
    accountId, clientId: resolvedFilters.clientId, companyIds: resolvedFilters.companyIds, filters: resolvedFilters,
  });
  if (!accountScope.rows.length) {
    res.status(404).json({ error: "Account not found" });
    return;
  }
  const result = await pool.query(
    `WITH candidate_accounts AS (
       SELECT id FROM companies WHERE tenant_id = $1 AND id = $2
     ),
     ${accountEventFilterInputs(5)},
      ${accountEventCtes},
      filtered_account_events AS (
        SELECT e.* FROM account_events e WHERE ${accountEventFilterSql(5)}
      )
     SELECT source_type || ':' || source_id::text AS id,
            source_type, source_id, event_type, description, created_at,
            contact_id, contact_name, score_delta, journey_name, page_name, stage
      FROM filtered_account_events
     WHERE account_id = $2
     ORDER BY created_at DESC, source_type, source_id DESC
     LIMIT $3 OFFSET $4`,
     [tenantId, accountId, pagination.limit + 1, (pagination.page - 1) * pagination.limit,
       ...accountEventFilterParams(resolvedFilters)],
  );
  const hasMore = result.rows.length > pagination.limit;
  const items = result.rows.slice(0, pagination.limit).map((row: any) => ({
    id: row.id,
    sourceType: row.source_type,
    sourceId: Number(row.source_id),
    eventType: row.event_type,
    description: row.description,
    createdAt: row.created_at,
    contactId: row.contact_id == null ? null : Number(row.contact_id),
    contactName: row.contact_name,
    scoreDelta: Number(row.score_delta),
    journeyName: row.journey_name,
    pageName: row.page_name,
    stage: row.stage,
  }));
  res.json(GetAnalyticsAccountActivityResponse.parse({
    items,
    page: pagination.page,
    hasMore,
  }));
});

export default router;