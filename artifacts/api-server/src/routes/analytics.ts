import { Router, type IRouter } from "express";
import { logger } from "../lib/logger";
import { and, eq, gte, sql, desc } from "drizzle-orm";
import {
  db, pool, clientsTable, playsTable, contactsTable, companiesTable,
  dealsTable, activityEventsTable, emailSequencesTable,
} from "@workspace/db";
import { requireAuth } from "../middlewares/requireAuth";
import { permittedClientIds, clientScopeSql, authorizedClients } from "../lib/requestClientScope";
import { buildContactsWhereClause, type FilterCriterion } from "../utils/segmentFilter";
import { reportDay, reportDayStart, reportDayEnd } from "./analyticsDay";
import {
  activityCompanyIdExpression,
  reviewedJourneyAccount,
  verifiedActivityAccount,
  verifiedJourneyAccount,
} from "./analyticsAttribution";
import { loadAccountSummaries } from "./accountsAnalytics";

const router: IRouter = Router();
router.use(requireAuth);

type CompanySelection = { companyIds: number[] | null; error?: string };

export function parseCompanySelection(query: Record<string, unknown>): CompanySelection {
  const raw = query.companyIds ?? query.companyId;
  if (raw == null || raw === "") return { companyIds: null };
  if (typeof raw !== "string") {
    return { companyIds: null, error: "companyId/companyIds must be a comma-separated list of positive integer IDs" };
  }

  const values = raw.split(",");
  if (values.length > 200 || values.some((value) => !/^[1-9]\d*$/.test(value))) {
    return { companyIds: null, error: "companyId/companyIds must contain up to 200 positive integer IDs" };
  }
  const ids = values.map(Number);
  if (ids.some((id) => !Number.isSafeInteger(id) || id > 2_147_483_647)) {
    return { companyIds: null, error: "companyId/companyIds must contain valid database IDs" };
  }
  return { companyIds: [...new Set(ids)] };
}

function pgIntArrayLiteral(ids: number[]): string {
  if (ids.some((id) => !Number.isSafeInteger(id) || id <= 0 || id > 2_147_483_647)) {
    throw new Error("Invalid company ID in account selection");
  }
  return `{${ids.join(",")}}`;
}

export function inboundCompanySelectionQuery(tenantId: number, clientId: number): ReturnType<typeof sql> {
  return sql`
    SELECT c.id
    FROM companies c
    WHERE c.tenant_id = ${tenantId}
      AND c.client_id = ${clientId}
      AND (
        c.inbound_manual = TRUE
        OR EXISTS (
          SELECT 1 FROM intent_inbound_submissions s
          WHERE s.tenant_id = c.tenant_id
            AND s.client_id = c.client_id
            AND s.account_id = c.id
        )
      )
  `;
}

export function selectedCompanySelectionQuery(
  tenantId: number,
  companyIds: number[],
  clientId: number | null,
): ReturnType<typeof sql> {
  if (!companyIds.length) return sql`SELECT id FROM companies WHERE FALSE`;
  return sql`
    SELECT id FROM companies
    WHERE tenant_id = ${tenantId}
      ${clientId !== null ? sql`AND client_id = ${clientId}` : sql``}
      AND id IN (${sql.join(companyIds.map((id) => sql`${id}`), sql`, `)})
  `;
}

async function getTenantCompanySelection(query: Record<string, unknown>, tenantId: number): Promise<CompanySelection> {
  const selection = parseCompanySelection(query);
  if (selection.error) return selection;
  const allowed = (query as Record<symbol, number[] | undefined>)[authorizedClients];
  if (allowed !== undefined) {
    const result = await db.execute(sql`SELECT id FROM companies WHERE tenant_id=${tenantId}
      AND ${clientScopeSql(sql`client_id`, allowed)}
      ${query.clientId ? sql`AND client_id=${Number(query.clientId)}` : sql``}`);
    const ids = (result.rows as any[]).map(row => Number(row.id));
    const set = new Set(ids);
    if (selection.companyIds?.some(id => !set.has(id))) {
      return { companyIds: null, error: "One or more selected accounts are outside your client access" };
    }
    // Apply the normal selection and inbound-only validation as well. Trusted
    // derived lists are not subject to the public 200-ID request limit.
    const unscoped = { ...query };
    delete (unscoped as Record<symbol, unknown>)[authorizedClients];
    const selected = await getTenantCompanySelection(unscoped, tenantId);
    if (selected.error) return selected;
    return { companyIds: selected.companyIds === null ? ids : selected.companyIds.filter(id => set.has(id)) };
  }

  const inboundOnly = query.inboundOnly != null;
  if (inboundOnly && query.inboundOnly !== "1") {
    return { companyIds: null, error: "inboundOnly must be 1 when provided" };
  }
  const clientRequired = inboundOnly && !selection.companyIds;
  const clientIdRaw = query.clientId;
  let clientId: number | null = null;
  if (clientRequired || (selection.companyIds && clientIdRaw != null)) {
    if (typeof clientIdRaw !== "string" || !/^[1-9]\d*$/.test(clientIdRaw)) {
      return { companyIds: null, error: "A valid clientId is required for account scoping" };
    }
    clientId = Number(clientIdRaw);
    if (!Number.isSafeInteger(clientId) || clientId > 2_147_483_647) {
      return { companyIds: null, error: "clientId must be a valid database ID" };
    }
    const clientResult = await db.execute(sql`
      SELECT id FROM clients WHERE tenant_id = ${tenantId} AND id = ${clientId}
    `);
    if ((clientResult.rows as any[]).length !== 1) {
      return { companyIds: null, error: "Client is unavailable for this tenant" };
    }
  }

  if (selection.companyIds) {
    const result = await db.execute(selectedCompanySelectionQuery(tenantId, selection.companyIds, clientId));
    if ((result.rows as any[]).length !== selection.companyIds.length) {
      return { companyIds: null, error: "One or more selected accounts are unavailable for this tenant/client" };
    }
    return selection;
  }

  if (!inboundOnly) return selection;

  const inboundAccounts = await db.execute(inboundCompanySelectionQuery(tenantId, clientId!));
  return { companyIds: (inboundAccounts.rows as any[]).map((row) => Number(row.id)) };
}

export function activityCompanyFilter(alias: "ae" | "ax" | "ae2", companyIds: number[] | null): ReturnType<typeof sql> {
  if (companyIds === null) return sql``;
  if (!companyIds.length) return sql`AND FALSE`;
  return sql`AND ${activityCompanyIdExpression(alias)} = ANY(${pgIntArrayLiteral(companyIds)}::int[])`;
}

export function journeyCompanyFilter(companyIds: number[] | null): ReturnType<typeof sql> {
  if (companyIds === null) return sql``;
  if (!companyIds.length) return sql`AND FALSE`;
  return sql`AND COALESCE(${verifiedJourneyAccount(sql`je.tenant_id`,sql`je.id`)}, (
    SELECT COALESCE(
      ${reviewedJourneyAccount(sql`je.tenant_id`, sql`account_contact.id`, sql`je.journey_id`, sql`je.created_at`)},
      account_contact.company_id)
    FROM contacts account_contact
    WHERE account_contact.tenant_id = je.tenant_id
      AND account_contact.id = COALESCE(
        (SELECT vt.contact_id FROM visitor_tokens vt WHERE vt.token = je.visitor_token AND vt.tenant_id = je.tenant_id),
        (SELECT fs.contact_id FROM form_submissions fs
         WHERE fs.visitor_token = je.visitor_token AND fs.tenant_id = je.tenant_id
           AND fs.contact_id IS NOT NULL
         ORDER BY fs.submitted_at DESC LIMIT 1)
      )
  )) = ANY(${pgIntArrayLiteral(companyIds)}::int[])`;
}

export function activityClientFilter(alias: "ae" | "ax", clientId: number | null): ReturnType<typeof sql> {
  if (clientId === null) return sql``;
  const ref = alias === "ae" ? sql`ae` : sql`ax`;
  // A public journey's client is authoritative even when the visitor's CRM
  // contact belongs to a different client.
  return sql`AND COALESCE(
    (SELECT j.client_id FROM journeys j WHERE j.id=${ref}.journey_id AND j.tenant_id=${ref}.tenant_id),
    ${ref}.client_id
  )=${clientId}`;
}

export function journeyClientFilter(clientId: number | null): ReturnType<typeof sql> {
  if (clientId === null) return sql``;
  return sql`AND EXISTS (SELECT 1 FROM journeys j
    WHERE j.id=je.journey_id AND j.tenant_id=je.tenant_id AND j.client_id=${clientId})`;
}

export function companyIdFilter(column: ReturnType<typeof sql>, companyIds: number[] | null): ReturnType<typeof sql> {
  if (companyIds === null) return sql``;
  if (!companyIds.length) return sql`AND FALSE`;
  return sql`AND ${column} = ANY(${pgIntArrayLiteral(companyIds)}::int[])`;
}

export function rawContactCompanyFilter(contactIdColumn: string, companyIds: number[] | null, arrayParamIndex = 2): string {
  if (companyIds === null) return "";
  if (!companyIds.length) return "AND FALSE";
  return `AND EXISTS (
    SELECT 1 FROM contacts scoped_contact
    WHERE scoped_contact.id = ${contactIdColumn}
      AND scoped_contact.tenant_id = $1
      AND scoped_contact.company_id = ANY($${arrayParamIndex}::int[])
  )`;
}

export function rawCallAnalysisContactColumn(alias: "ca"): string {
  return `COALESCE(
    (SELECT scoped_call.contact_id FROM call_logs scoped_call
     WHERE scoped_call.id = ${alias}.call_log_id AND scoped_call.tenant_id = ${alias}.tenant_id),
    ${alias}.contact_id
  )`;
}

type AcquisitionFormType = "lead_form" | "event_feedback";
type AcquisitionSource = AcquisitionFormType | "monitored" | "manual";
type Acquisition = {
  recordCreatedAt: string | null;
  firstAcquiredAt: string | null;
  sources: AcquisitionSource[];
  leadForms: { id: number; at: string; formName: string | null }[];
  eventFeedback: { id: number; at: string; formName: string | null }[];
};

router.post("/analytics/gtm-status", async (req, res, next): Promise<void> => {
  try {
    const body = req.body;
    const contactIds = body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>).contactIds
      : undefined;
    if (
      !Array.isArray(contactIds) ||
      contactIds.length > 200 ||
      contactIds.some((id) => !Number.isSafeInteger(id) || (id as number) <= 0)
    ) {
      res.status(400).json({ error: "contactIds must be an array of up to 200 positive safe integers" });
      return;
    }
    if (contactIds.length === 0) {
      res.json({ contacts: {} });
      return;
    }

    const tenantId = (req.user as any).tenantId;
    // Contact/company IDs are PostgreSQL int4 values. Larger safe request IDs
    // are valid but cannot match persisted records, so exclude them from queries.
    const dbContactIds = contactIds.filter((id): id is number => id <= 2_147_483_647);
    const submissionRows = dbContactIds.length
      ? (await pool.query(
        `SELECT s.contact_id,
           CASE
              WHEN bool_or(s.classification = 'hot') THEN 'hot'
              WHEN bool_or(s.classification = 'warm') THEN 'warm'
             ELSE 'cold'
           END AS status,
            MAX(s.updated_at) AS updated_at
         FROM intent_inbound_submissions s
         JOIN contacts c ON c.id = s.contact_id AND c.tenant_id = s.tenant_id
           AND c.company_id = s.account_id
         WHERE s.tenant_id = $1 AND s.contact_id = ANY($2::int[])
           AND s.form_type IN ('lead_form', 'event_feedback')
         GROUP BY s.contact_id`,
        [tenantId, dbContactIds],
      )).rows as { contact_id: number; status: "hot" | "warm" | "cold"; updated_at: Date | string | null }[]
      : [];

    const contacts: Record<string, { status: "hot" | "warm" | "cold"; updatedAt: string | null }> = {};
    for (const row of submissionRows) {
      // A missing group means this person has not submitted a qualifying form;
      // the employer's status must not stand in for their own response.
      contacts[String(row.contact_id)] = {
        status: row.status,
        updatedAt: row.updated_at == null ? null : new Date(row.updated_at).toISOString(),
      };
    }
    res.json({ contacts });
  } catch (err) { next(err); }
});

router.post("/analytics/acquisition", async (req, res, next): Promise<void> => {
  try {
    const body = req.body;
    const validIds = (value: unknown): value is number[] =>
      Array.isArray(value) &&
      value.length <= 200 &&
      value.every((id) => Number.isSafeInteger(id) && id > 0) &&
      new Set(value).size === value.length;

    if (!body || typeof body !== "object" ||
        !validIds(body.contactIds) || !validIds(body.accountIds)) {
      req.log.warn("Invalid acquisition analytics request");
      res.status(400).json({ error: "contactIds and accountIds must be arrays of up to 200 unique positive safe integers" });
      return;
    }

    const tenantId = (req.user as any).tenantId;
    const contactIds = body.contactIds as number[];
    const accountIds = body.accountIds as number[];
    // Database entity keys are PostgreSQL int4 values; larger safe integers are
    // valid request values but cannot identify a persisted record.
    const dbContactIds = contactIds.filter((id) => id <= 2_147_483_647);
    const dbAccountIds = accountIds.filter((id) => id <= 2_147_483_647);
    const [contactRows, accountRows, formRows] = await Promise.all([
      dbContactIds.length
        ? pool.query(
          `SELECT id, created_at, source, is_anonymous
           FROM contacts WHERE tenant_id=$1 AND id=ANY($2::int[])`,
          [tenantId, dbContactIds],
        )
        : Promise.resolve({ rows: [] }),
      dbAccountIds.length
        ? pool.query(
          `SELECT co.id, co.created_at, co.inbound_manual,
            (EXISTS (
              SELECT 1 FROM intent_monitoring_accounts ima
              JOIN intent_monitoring_configs imc
                ON imc.id=ima.config_id AND imc.tenant_id=ima.tenant_id AND imc.enabled=true
              WHERE ima.tenant_id=$1 AND ima.company_id=co.id
                AND (imc.client_id IS NULL OR imc.client_id=co.client_id)
            ) OR EXISTS (
              SELECT 1 FROM intent_monitoring_audiences imau
              JOIN intent_monitoring_configs imc
                ON imc.id=imau.config_id AND imc.tenant_id=imau.tenant_id AND imc.enabled=true
              JOIN intent_audiences ia
                ON ia.id=imau.audience_id AND ia.tenant_id=imau.tenant_id
              JOIN intent_audience_companies iac
                ON iac.audience_id=ia.id AND iac.tenant_id=ia.tenant_id
              WHERE imau.tenant_id=$1 AND iac.company_id=co.id
                AND (imc.client_id IS NULL OR imc.client_id=co.client_id)
            )) AS monitored
           FROM companies co WHERE co.tenant_id=$1 AND co.id=ANY($2::int[])`,
          [tenantId, dbAccountIds],
        )
        : Promise.resolve({ rows: [] }),
      dbContactIds.length || dbAccountIds.length
        ? pool.query(
          `SELECT 'contact' AS entity_type, s.contact_id AS entity_id, s.id,
              COALESCE(s.submitted_at,s.created_at) AS acquired_at, s.file_name AS form_name, s.form_type
           FROM intent_inbound_submissions s
           JOIN contacts c ON c.id=s.contact_id AND c.tenant_id=s.tenant_id
           WHERE s.tenant_id=$1 AND s.contact_id=ANY($2::int[])
             AND s.form_type IN ('lead_form','event_feedback')
           UNION ALL
           SELECT 'account' AS entity_type, s.account_id AS entity_id, s.id,
              COALESCE(s.submitted_at,s.created_at) AS acquired_at, s.file_name AS form_name, s.form_type
           FROM intent_inbound_submissions s
           JOIN companies co ON co.id=s.account_id AND co.tenant_id=s.tenant_id
           WHERE s.tenant_id=$1 AND s.account_id=ANY($3::int[])
             AND s.form_type IN ('lead_form','event_feedback')
           ORDER BY entity_type, entity_id, acquired_at, id`,
          [tenantId, dbContactIds, dbAccountIds],
        )
        : Promise.resolve({ rows: [] }),
    ]);

    // Segment selections also schedule accounts. Evaluate their current static
    // or dynamic contact membership with the same tenant-scoped filter builder
    // used by the monitoring scheduler, then map matched contacts to their tenant
    // accounts in one bulk query.
    if (dbAccountIds.length) {
      const selectedSegments = await pool.query<{
        id: number;
        segment_type: string;
        static_contact_ids: number[] | null;
        filter_criteria: FilterCriterion[] | null;
        logic_operator: string;
      }>(
        `SELECT s.id, s.segment_type, s.static_contact_ids, s.filter_criteria, s.logic_operator
         FROM intent_monitoring_segments ims
         JOIN intent_monitoring_configs imc
           ON imc.id=ims.config_id AND imc.tenant_id=ims.tenant_id AND imc.enabled=true
         JOIN segments s ON s.id=ims.segment_id AND s.tenant_id=ims.tenant_id
         WHERE ims.tenant_id=$1`,
        [tenantId],
      );
      if (selectedSegments.rows.length) {
        const segmentPredicates = await Promise.all(selectedSegments.rows.map(async (segment) => {
          const membership = segment.segment_type === "static"
            ? (segment.static_contact_ids?.length
              ? sql`c.id IN (${sql.join(segment.static_contact_ids.map((id) => sql`${id}`), sql`, `)})`
              : sql`FALSE`)
            : await buildContactsWhereClause(
              tenantId,
              segment.filter_criteria ?? [],
              segment.logic_operator === "OR" ? "OR" : "AND",
            );
          return sql`(s.id=${segment.id} AND ${membership} AND
            (imc.client_id IS NULL OR imc.client_id=co.client_id))`;
        }));
        const monitoredSegmentCompanies = await db.execute(sql`
          SELECT DISTINCT c.company_id
          FROM contacts c
          JOIN companies co ON co.id=c.company_id AND co.tenant_id=c.tenant_id
          JOIN intent_monitoring_segments ims ON ims.tenant_id=c.tenant_id
          JOIN intent_monitoring_configs imc
            ON imc.id=ims.config_id AND imc.tenant_id=ims.tenant_id AND imc.enabled=true
          JOIN segments s ON s.id=ims.segment_id AND s.tenant_id=ims.tenant_id
          WHERE c.tenant_id=${tenantId}
            AND c.company_id IN (${sql.join(dbAccountIds.map((id) => sql`${id}`), sql`, `)})
            AND (${sql.join(segmentPredicates, sql` OR `)})
        `);
        const monitoredSegmentIds = new Set(
          (monitoredSegmentCompanies.rows as Array<{ company_id: number }>).map((row) => String(row.company_id)),
        );
        for (const row of accountRows.rows as any[]) {
          if (monitoredSegmentIds.has(String(row.id))) row.monitored = true;
        }
      }
    }

    const iso = (value: unknown): string | null => {
      if (value == null) return null;
      const date = value instanceof Date ? value : new Date(String(value));
      return Number.isNaN(date.getTime()) ? null : date.toISOString();
    };
    const makeAcquisition = (createdAt: unknown): Acquisition => ({
      recordCreatedAt: iso(createdAt),
      firstAcquiredAt: null,
      sources: [],
      leadForms: [],
      eventFeedback: [],
    });
    const contacts: Record<string, Acquisition> = {};
    const accounts: Record<string, Acquisition> = {};
    const manuallySourcedContactIds = new Set<string>();
    for (const row of contactRows.rows as any[]) {
      const id = String(row.id);
      contacts[id] = makeAcquisition(row.created_at);
      if (row.source === "manual" && row.is_anonymous !== true) manuallySourcedContactIds.add(id);
    }
    for (const row of accountRows.rows as any[]) {
      const acquisition = makeAcquisition(row.created_at);
      if (row.monitored) acquisition.sources.push("monitored");
      accounts[String(row.id)] = acquisition;
    }

    for (const row of formRows.rows as any[]) {
      const target = row.entity_type === "contact" ? contacts : accounts;
      const acquisition = target[String(row.entity_id)];
      if (!acquisition) continue;
      const at = iso(row.acquired_at);
      if (!at) continue;
      const form = { id: Number(row.id), at, formName: row.form_name ?? null };
      if (row.form_type === "lead_form") {
        acquisition.leadForms.push(form);
        if (!acquisition.sources.includes("lead_form")) acquisition.sources.push("lead_form");
      } else if (row.form_type === "event_feedback") {
        acquisition.eventFeedback.push(form);
        if (!acquisition.sources.includes("event_feedback")) acquisition.sources.push("event_feedback");
      }
      if (!acquisition.firstAcquiredAt || at < acquisition.firstAcquiredAt) {
        acquisition.firstAcquiredAt = at;
      }
    }

    for (const [id, acquisition] of Object.entries(contacts)) {
      if (!acquisition.sources.length && manuallySourcedContactIds.has(id)) {
        acquisition.sources.push("manual");
      }
    }
    for (const row of accountRows.rows as any[]) {
      const acquisition = accounts[String(row.id)];
      if (row.inbound_manual && acquisition && !acquisition.sources.includes("monitored") &&
          !acquisition.sources.includes("lead_form") &&
          !acquisition.sources.includes("event_feedback")) {
        acquisition.sources.push("manual");
      }
    }
    res.json({ contacts, accounts });
  } catch (err) { next(err); }
});

// Only real, classified inbound submissions qualify. Manually added accounts
// without responses must not appear as Hot or Warm.
router.get("/analytics/inbound-account-options", async (req, res, next): Promise<void> => {
  try {
    const tid = (req.user as any).tenantId;
    const clientId = Number(req.query.clientId);
    const accountId = req.query.accountId == null ? null : Number(req.query.accountId);
    if (!Number.isSafeInteger(clientId) || clientId <= 0 ||
        (accountId !== null && (!Number.isSafeInteger(accountId) || accountId <= 0))) {
      res.status(400).json({ error: "Invalid client or account" }); return;
    }
    const accounts = await pool.query(
      `SELECT id, name, domain, classification FROM (
         SELECT c.id, c.name, c.domain,
           CASE WHEN bool_or(s.classification='hot') THEN 'hot'
             WHEN bool_or(s.classification='warm') THEN 'warm' ELSE 'cold' END AS classification
         FROM intent_inbound_submissions s
         JOIN companies c ON c.id=s.account_id AND c.tenant_id=s.tenant_id AND c.client_id=s.client_id
         WHERE s.tenant_id=$1 AND s.client_id=$2
         GROUP BY c.id, c.name, c.domain
         UNION ALL
         SELECT c.id, c.name, c.domain, 'cold'::text AS classification
         FROM companies c
         WHERE c.tenant_id=$1 AND c.client_id=$2 AND c.inbound_manual=true
           AND NOT EXISTS (
             SELECT 1 FROM intent_inbound_submissions s
             WHERE s.tenant_id=c.tenant_id AND s.client_id=c.client_id AND s.account_id=c.id
           )
       ) inbound_accounts ORDER BY name`, [tid, clientId]);
    if (accountId === null) { res.json({ accounts: accounts.rows, plays: [], journeys: [] }); return; }
    if (!accounts.rows.some(a => Number(a.id) === accountId)) {
      res.status(404).json({ error: "No qualifying inbound account for this client" }); return;
    }
    const contacts = `SELECT id FROM contacts WHERE tenant_id=$1 AND company_id=$3`;
    const [plays, journeys] = await Promise.all([
      pool.query(`SELECT DISTINCT p.id,p.name,p.journey_id AS "journeyId"
        FROM abm_plays p
        WHERE p.tenant_id=$1 AND p.client_id=$2 AND (
          EXISTS (SELECT 1 FROM email_sequences es JOIN sequence_enrollments se ON se.sequence_id=es.id
            WHERE es.play_id=p.id AND se.contact_id IN (${contacts}))
          OR EXISTS (SELECT 1 FROM intent_inbound_submissions s
            LEFT JOIN intent_inbound_routing_rules rr ON rr.id=s.routed_rule_id AND rr.tenant_id=s.tenant_id
            LEFT JOIN intent_inbound_manual_routes mr ON mr.submission_id=s.id AND mr.tenant_id=s.tenant_id
            LEFT JOIN email_sequences es ON es.id=COALESCE(mr.sequence_id,rr.sequence_id) AND es.tenant_id=s.tenant_id
            WHERE s.tenant_id=$1 AND s.client_id=$2 AND s.account_id=$3 AND es.play_id=p.id)
          OR (p.journey_id IS NOT NULL AND EXISTS (
            SELECT 1 FROM activity_events ae WHERE ae.tenant_id=$1 AND ae.journey_id=p.journey_id
            AND (ae.company_id=$3 OR ae.contact_id IN (${contacts}))))
        ) ORDER BY p.name`, [tid, clientId, accountId]),
      pool.query(`SELECT DISTINCT j.id,j.name
        FROM journeys j
        WHERE j.tenant_id=$1 AND j.client_id=$2 AND (
          EXISTS (SELECT 1 FROM activity_events ae WHERE ae.tenant_id=$1 AND ae.journey_id=j.id
            AND (ae.company_id=$3 OR ae.contact_id IN (${contacts})))
          OR EXISTS (SELECT 1 FROM journey_contacts jc WHERE jc.journey_id=j.id AND jc.contact_id IN (${contacts}))
          OR EXISTS (SELECT 1 FROM journey_events je
            JOIN visitor_tokens vt ON vt.tenant_id=je.tenant_id AND vt.token=je.visitor_token
            WHERE je.tenant_id=$1 AND je.journey_id=j.id AND vt.contact_id IN (${contacts}))
          OR EXISTS (SELECT 1 FROM abm_plays p WHERE p.tenant_id=$1 AND p.client_id=$2
            AND p.journey_id=j.id AND EXISTS (SELECT 1 FROM email_sequences es
              JOIN sequence_enrollments se ON se.sequence_id=es.id
              WHERE es.play_id=p.id AND se.contact_id IN (${contacts})))
          OR EXISTS (SELECT 1 FROM intent_inbound_submissions s
            LEFT JOIN intent_inbound_routing_rules rr ON rr.id=s.routed_rule_id AND rr.tenant_id=s.tenant_id
            LEFT JOIN intent_inbound_manual_routes mr ON mr.submission_id=s.id AND mr.tenant_id=s.tenant_id
            WHERE s.tenant_id=$1 AND s.client_id=$2 AND s.account_id=$3
              AND (rr.journey_id=j.id OR mr.journey_id=j.id))
        ) ORDER BY j.name`, [tid, clientId, accountId]),
    ]);
    res.json({ accounts: accounts.rows, plays: plays.rows, journeys: journeys.rows });
  } catch (err) { next(err); }
});

router.get("/analytics/inbound-account-journey", async (req, res, next): Promise<void> => {
  try {
    const tid = (req.user as any).tenantId;
    const clientId = Number(req.query.clientId), accountId = Number(req.query.accountId);
    const playId = req.query.playId ? Number(req.query.playId) : null;
    const journeyId = req.query.journeyId ? Number(req.query.journeyId) : null;
    if (![clientId, accountId, playId, journeyId].every(v => v === null || (Number.isSafeInteger(v) && v > 0))) {
      res.status(400).json({ error: "Invalid filter" }); return;
    }
    const valid = await pool.query(`SELECT c.name FROM companies c WHERE c.tenant_id=$1 AND c.client_id=$2 AND c.id=$3
      AND (c.inbound_manual=true OR EXISTS (SELECT 1 FROM intent_inbound_submissions s WHERE s.tenant_id=$1
        AND s.client_id=$2 AND s.account_id=$3))`,
      [tid, clientId, accountId]);
    if (!valid.rows.length) { res.status(404).json({ error: "Inbound account not found for this client" }); return; }
    if (playId || journeyId) {
      const scoped = await pool.query(`SELECT
        ($4::int IS NULL OR EXISTS (SELECT 1 FROM abm_plays WHERE id=$4 AND tenant_id=$1 AND client_id=$2)) AS play_ok,
        ($5::int IS NULL OR EXISTS (SELECT 1 FROM journeys WHERE id=$5 AND tenant_id=$1 AND client_id=$2)) AS journey_ok`,
        [tid, clientId, accountId, playId, journeyId]);
      if (!scoped.rows[0].play_ok || !scoped.rows[0].journey_ok) {
        res.status(400).json({ error: "Play or journey does not belong to this client" }); return;
      }
    }
    const dateFrom = typeof req.query.dateFrom === "string" && /^\d{4}-\d{2}-\d{2}$/.test(req.query.dateFrom) ? req.query.dateFrom : null;
    const dateTo = typeof req.query.dateTo === "string" && /^\d{4}-\d{2}-\d{2}$/.test(req.query.dateTo) ? req.query.dateTo : null;
    const params = [tid, clientId, accountId, playId, journeyId, dateFrom, dateTo];
    const [submissions, activities, visits] = await Promise.all([
      pool.query(`SELECT ('inbound-'||s.id) AS id,s.form_type AS "eventType",
        CASE s.form_type WHEN 'lead_form' THEN 'Lead form submitted'
          WHEN 'event_feedback' THEN 'Event feedback submitted' ELSE 'Inbound form submitted' END AS description,
        s.classification,s.product_interest AS "productInterest",
        COALESCE(s.submitted_at,s.created_at) AS "createdAt",
        s.contact_id AS "contactId",trim(concat_ws(' ',c.first_name,c.last_name)) AS "contactName",
        c.email,c.lead_score AS "totalScore",c.tags,c.stage,s.file_name AS "formName",
        NULL::text AS "journeyName",NULL::text AS "sequenceName",
        NULL::text AS "pageName",NULL::text AS url,0 AS "scoreDelta"
        FROM intent_inbound_submissions s
        LEFT JOIN contacts c ON c.id=s.contact_id AND c.tenant_id=s.tenant_id
        WHERE s.tenant_id=$1 AND s.client_id=$2 AND s.account_id=$3
          AND s.form_type IN ('lead_form','event_feedback')
          AND ($6::date IS NULL OR COALESCE(s.submitted_at,s.created_at)>=($6::date::timestamp AT TIME ZONE 'Asia/Kolkata'))
          AND ($7::date IS NULL OR COALESCE(s.submitted_at,s.created_at)<(($7::date + 1)::timestamp AT TIME ZONE 'Asia/Kolkata'))
        ORDER BY "createdAt" DESC LIMIT 500`, params),
      pool.query(`SELECT ('activity-'||ae.id) AS id,ae.event_type AS "eventType",ae.description,
        ae.created_at AS "createdAt",ae.contact_id AS "contactId",
        trim(concat_ws(' ',c.first_name,c.last_name)) AS "contactName",c.email,
        c.lead_score AS "totalScore",c.tags,c.stage,ae.score_delta AS "scoreDelta",
        ae.page_name AS "pageName",
        CASE WHEN ae.event_type='email_click'
          THEN COALESCE(click_email.metadata->>'destinationUrl',ae.page_url)
          ELSE ae.page_url END AS url,
        j.name AS "journeyName",
        COALESCE(es.name,click_sequence.name) AS "sequenceName",
        sent_message.subject AS "sentSubject"
        FROM activity_events ae
        LEFT JOIN contacts c ON c.id=ae.contact_id AND c.tenant_id=ae.tenant_id
        LEFT JOIN journeys j ON j.id=ae.journey_id AND j.tenant_id=ae.tenant_id
        LEFT JOIN email_sequences es ON es.id=ae.sequence_id AND es.tenant_id=ae.tenant_id
          AND EXISTS (SELECT 1 FROM abm_plays seq_play WHERE seq_play.id=es.play_id
            AND seq_play.tenant_id=ae.tenant_id AND seq_play.client_id=$2)
        LEFT JOIN abm_plays p ON p.id=es.play_id AND p.tenant_id=ae.tenant_id
        LEFT JOIN LATERAL (
          SELECT ee.template_id,ee.metadata,ee.occurred_at
          FROM email_events ee
          WHERE ae.event_type='email_click' AND c.id IS NOT NULL
            AND ee.tenant_id=ae.tenant_id AND ee.contact_id=c.id
            AND ee.event_type='clicked' AND COALESCE(ee.is_bot,false)=false
            -- If the click names an enrollment, it must belong to this client.
            AND (ee.metadata->>'enrollmentId' IS NULL OR EXISTS (
              SELECT 1 FROM sequence_enrollments scope_se
              JOIN email_sequences scope_es ON scope_es.id=scope_se.sequence_id
                AND scope_es.tenant_id=ae.tenant_id
              JOIN abm_plays scope_p ON scope_p.id=scope_es.play_id
                AND scope_p.tenant_id=ae.tenant_id AND scope_p.client_id=$2
              WHERE scope_se.id=CASE
                WHEN ee.metadata->>'enrollmentId' ~ '^[0-9]{1,9}$'
                THEN (ee.metadata->>'enrollmentId')::int END
                AND scope_se.contact_id=c.id
            ))
            AND (
              -- New redirects link the two records by id. Old rows are only
              -- usable if there is exactly one click on each side of the match.
              ee.metadata->>'activityEventId'=ae.id::text
              OR (
                ee.metadata->>'activityEventId' IS NULL
                AND ae.description IN ('Email link clicked','Email link clicked (external)')
                AND abs(extract(epoch FROM (ee.occurred_at-ae.created_at)))<=10
                AND (SELECT count(*) FROM email_events other_ee
                  WHERE other_ee.tenant_id=ae.tenant_id AND other_ee.contact_id=c.id
                    AND other_ee.event_type='clicked' AND COALESCE(other_ee.is_bot,false)=false
                    AND abs(extract(epoch FROM (other_ee.occurred_at-ae.created_at)))<=10)=1
                AND NOT EXISTS (SELECT 1 FROM activity_events other_ae
                  WHERE other_ae.tenant_id=ae.tenant_id AND other_ae.contact_id=c.id
                    AND other_ae.event_type='email_click' AND other_ae.id<>ae.id
                    AND abs(extract(epoch FROM (other_ae.created_at-ee.occurred_at)))<=10)
              )
            )
          ORDER BY CASE WHEN ee.metadata->>'activityEventId'=ae.id::text THEN 0 ELSE 1 END
          LIMIT 1
        ) click_email ON TRUE
        -- The current template is editable. Only a subject captured at send time
        -- is evidence of what this contact actually received. Older sends already
        -- captured it on activity_events; newer sends also capture it on email_events.
        LEFT JOIN LATERAL (
          -- An enrollment can send the same template more than once. Without a
          -- message identifier, conflicting send snapshots cannot be attributed
          -- to this click, even when its enrollment ID is known.
          SELECT CASE WHEN count(DISTINCT candidate.subject)=1
            THEN (array_agg(candidate.subject ORDER BY candidate.sent_at DESC, candidate.priority))[1]
            END AS subject
          FROM (
            SELECT sent.metadata->>'subject' AS subject, sent.occurred_at AS sent_at, 0 AS priority
            FROM email_events sent
            WHERE sent.tenant_id=ae.tenant_id AND sent.contact_id=c.id
              AND sent.event_type='sent' AND sent.template_id=click_email.template_id
              AND sent.occurred_at<=click_email.occurred_at
              AND sent.metadata->>'subject' IS NOT NULL
              AND (click_email.metadata->>'enrollmentId' IS NULL
                OR sent.metadata->>'enrollmentId'=click_email.metadata->>'enrollmentId')
            UNION ALL
            SELECT sent_ae.metadata::jsonb->>'subject', sent_ae.created_at, 1
            FROM activity_events sent_ae
            WHERE sent_ae.tenant_id=ae.tenant_id AND sent_ae.contact_id=c.id
              AND sent_ae.event_type='email_sent'
              AND sent_ae.metadata::jsonb->>'templateId'=click_email.template_id::text
              AND sent_ae.created_at<=click_email.occurred_at
              AND sent_ae.metadata::jsonb->>'subject' IS NOT NULL
              AND (click_email.metadata->>'enrollmentId' IS NULL
                OR sent_ae.metadata::jsonb->>'enrollmentId'=click_email.metadata->>'enrollmentId')
          ) candidate
        ) sent_message ON TRUE
        LEFT JOIN sequence_enrollments click_enrollment
          ON click_enrollment.id=CASE
            WHEN click_email.metadata->>'enrollmentId' ~ '^[0-9]{1,9}$'
            THEN (click_email.metadata->>'enrollmentId')::int END
          AND click_enrollment.contact_id=c.id
        LEFT JOIN email_sequences click_sequence ON click_sequence.id=click_enrollment.sequence_id
          AND click_sequence.tenant_id=ae.tenant_id
          AND EXISTS (SELECT 1 FROM abm_plays cp WHERE cp.id=click_sequence.play_id
            AND cp.tenant_id=ae.tenant_id AND cp.client_id=$2)
        WHERE ae.tenant_id=$1 AND COALESCE(ae.is_bot,false)=false
          AND COALESCE(ae.company_id,c.company_id)=$3
          AND (c.client_id IS NULL OR c.client_id=$2)
          AND (ae.client_id IS NULL OR ae.client_id=$2)
          -- Redirect-based email clicks may have neither client ID populated;
          -- the validated account/company relationship already supplies client scope.
          AND ae.event_type IN ('email_sent','email_open','email_click','page_view','form_submit',
            'form_submitted','asset_download','banner_click','cta_click','call_completed','scroll_depth')
          AND ($4::int IS NULL OR p.id=$4 OR EXISTS
            (SELECT 1 FROM abm_plays ap WHERE ap.id=$4 AND ap.tenant_id=$1 AND ap.journey_id=ae.journey_id))
          AND ($5::int IS NULL OR ae.journey_id=$5 OR
            (ae.event_type IN ('email_sent','email_open','email_click')
              AND (es.journey_id=$5 OR p.journey_id=$5)))
          AND ($6::date IS NULL OR ae.created_at >= ($6::date::timestamp AT TIME ZONE 'Asia/Kolkata'))
          AND ($7::date IS NULL OR ae.created_at < (($7::date + 1)::timestamp AT TIME ZONE 'Asia/Kolkata'))
        ORDER BY ae.created_at DESC LIMIT 500`, params),
      pool.query(`SELECT ('visit-'||je.id) AS id,je.event_type AS "eventType",
        CASE WHEN je.event_type='page_view' THEN 'Journey page visited'
          ELSE 'Journey '||replace(je.event_type,'_',' ') END AS description,
        je.created_at AS "createdAt",c.id AS "contactId",
        trim(concat_ws(' ',c.first_name,c.last_name)) AS "contactName",c.email,
        c.lead_score AS "totalScore",c.tags,c.stage,0 AS "scoreDelta",
        jp.title AS "pageName",COALESCE(je.cta_url,je.page_url) AS url,j.name AS "journeyName"
        FROM journey_events je
        JOIN journeys j ON j.id=je.journey_id AND j.tenant_id=je.tenant_id AND j.client_id=$2
        LEFT JOIN journey_pages jp ON jp.id=je.page_id
        LEFT JOIN visitor_tokens vt ON vt.tenant_id=je.tenant_id AND vt.token=je.visitor_token
        LEFT JOIN LATERAL (SELECT contact_id FROM form_submissions fs
          WHERE fs.tenant_id=je.tenant_id AND fs.visitor_token=je.visitor_token
            AND fs.contact_id IS NOT NULL ORDER BY fs.submitted_at DESC LIMIT 1) fs ON TRUE
        JOIN contacts c ON c.id=COALESCE(vt.contact_id,fs.contact_id)
          AND c.tenant_id=je.tenant_id AND c.company_id=$3
        WHERE je.tenant_id=$1 AND COALESCE(je.is_bot,false)=false
          AND je.event_type IN ('page_view','cta_click','banner_dismiss')
          AND ($4::int IS NULL OR EXISTS
            (SELECT 1 FROM abm_plays ap WHERE ap.id=$4 AND ap.tenant_id=$1 AND ap.journey_id=j.id))
          AND ($5::int IS NULL OR je.journey_id=$5)
          AND ($6::date IS NULL OR je.created_at >= ($6::date::timestamp AT TIME ZONE 'Asia/Kolkata'))
          AND ($7::date IS NULL OR je.created_at < (($7::date + 1)::timestamp AT TIME ZONE 'Asia/Kolkata'))
          AND NOT EXISTS (SELECT 1 FROM activity_events ae WHERE ae.tenant_id=$1
            AND ae.contact_id=c.id AND ae.event_type='page_view' AND ae.journey_id=je.journey_id
            AND ae.page_name=jp.title AND abs(extract(epoch FROM (ae.created_at-je.created_at)))<120)
        ORDER BY je.created_at DESC LIMIT 500`, params),
    ]);
    const events = [...submissions.rows, ...activities.rows, ...visits.rows]
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    res.json({ accountName: valid.rows[0].name, events, hasMore: [submissions, activities, visits].some(r => r.rows.length === 500) });
  } catch (err) { next(err); }
});

// ── Dashboard ──────────────────────────────────────────────────────────────────
async function getDashboardSummary(tid: number, clientIds: number[] | null = null) {
  const now = new Date();
  const d30 = new Date(now.getTime() - 30 * 86400_000);
  const d60 = new Date(now.getTime() - 60 * 86400_000);

  const [[clientsRow], [playsRow], [contactsRow], [formsRow]] = await Promise.all([
    db.select({ count: sql<number>`count(*)::int` }).from(clientsTable).where(and(eq(clientsTable.tenantId, tid), clientScopeSql(sql`${clientsTable.id}`, clientIds))),
    db.select({
      active: sql<number>`count(*) FILTER (WHERE ${playsTable.status} = 'active')::int`,
      emails: sql<number>`coalesce(sum(${playsTable.emailsSent}),0)::int`,
      pageViews: sql<number>`coalesce(sum(${playsTable.pageViews}),0)::int`,
    }).from(playsTable).where(and(eq(playsTable.tenantId, tid), clientScopeSql(sql`${playsTable.clientId}`, clientIds))),
    db.select({
      total: sql<number>`count(*)::int`,
      hot: sql<number>`count(*) FILTER (WHERE ${contactsTable.leadScore} >= 50)::int`,
      avg: sql<number>`coalesce(avg(${contactsTable.leadScore}),0)::float`,
      previous: sql<number>`count(*) FILTER (WHERE ${contactsTable.createdAt} < ${d30.toISOString()} AND ${contactsTable.createdAt} >= ${d60.toISOString()})::int`,
      previousHot: sql<number>`count(*) FILTER (WHERE ${contactsTable.leadScore} >= 50 AND ${contactsTable.createdAt} < ${d30.toISOString()})::int`,
    }).from(contactsTable).where(and(eq(contactsTable.tenantId, tid), clientScopeSql(sql`${contactsTable.clientId}`, clientIds))),
    db.select({
      total: sql<number>`count(*)::int`,
      previous: sql<number>`count(*) FILTER (WHERE submitted_at < ${d30.toISOString()} AND submitted_at >= ${d60.toISOString()})::int`,
    }).from(sql`form_submissions`).where(sql`tenant_id = ${tid}
      AND (${clientIds === null ? sql`true` : sql`EXISTS (SELECT 1 FROM contacts fc
        WHERE fc.id=form_submissions.contact_id AND fc.tenant_id=${tid}
        AND ${clientScopeSql(sql`fc.client_id`, clientIds)})`})`),
  ]);

  const pct = (curr: number, prev: number) =>
    prev === 0 ? (curr > 0 ? 100 : 0) : Math.round(((curr - prev) / prev) * 100);
  const totalContacts = contactsRow?.total ?? 0;
  const hotLeads = contactsRow?.hot ?? 0;
  const formSubs = formsRow?.total ?? 0;

  return {
    totalClients: clientsRow?.count ?? 0,
    activePlays: playsRow?.active ?? 0,
    totalContacts,
    emailsSentThisMonth: playsRow?.emails ?? 0,
    pageViewsThisMonth: playsRow?.pageViews ?? 0,
    formSubmissions: formSubs,
    hotLeads,
    avgLeadScore: Math.round((contactsRow?.avg ?? 0) * 10) / 10,
    trends: {
      contacts: pct(totalContacts, contactsRow?.previous ?? 0),
      hotLeads: pct(hotLeads, contactsRow?.previousHot ?? 0),
      formSubs: pct(formSubs, formsRow?.previous ?? 0),
    },
  };
}

async function getDashboardPanels(tid: number, clientIds: number[] | null = null) {
  const [topPlays, activityFeed, accountsToWatch] = await Promise.all([
    db
      .select({ id: playsTable.id, name: playsTable.name, status: playsTable.status, pageViews: playsTable.pageViews, contactsEnrolled: playsTable.contactsEnrolled, emailsSent: playsTable.emailsSent })
      .from(playsTable)
      .where(and(eq(playsTable.tenantId, tid), clientScopeSql(sql`${playsTable.clientId}`, clientIds)))
      .orderBy(desc(playsTable.pageViews))
      .limit(5),
    db
      .select()
      .from(activityEventsTable)
      .where(sql`tenant_id=${tid} AND contact_id IN (SELECT id FROM contacts WHERE tenant_id = ${tid}
        AND ${clientScopeSql(sql`client_id`, clientIds)})`)
      .orderBy(desc(activityEventsTable.createdAt))
      .limit(20),
    db.execute(sql`
      SELECT co.id, co.name, co.domain, co.industry,
             coalesce(avg(c.lead_score),0)::float as avg_score,
             count(c.id)::int as contact_count
      FROM companies co
      LEFT JOIN contacts c ON c.company_id = co.id AND c.tenant_id=co.tenant_id AND c.client_id=co.client_id
      WHERE co.tenant_id = ${tid} AND ${clientScopeSql(sql`co.client_id`, clientIds)}
      GROUP BY co.id, co.name, co.domain, co.industry
      ORDER BY avg_score DESC
      LIMIT 5
    `),
  ]);

  return { topPlays, activityFeed, accountsToWatch: accountsToWatch.rows };
}

router.get("/analytics/dashboard/summary", async (req, res, next): Promise<void> => {
  try {
    const user = req.user as any;
    res.json(await getDashboardSummary(user.tenantId, permittedClientIds(req)));
  } catch (err) { next(err); }
});

router.get("/analytics/dashboard/panels", async (req, res, next): Promise<void> => {
  try {
    const user = req.user as any;
    res.json(await getDashboardPanels(user.tenantId, permittedClientIds(req)));
  } catch (err) { next(err); }
});

router.get("/analytics/dashboard", async (req, res, next): Promise<void> => {
  try {
    const user = req.user as any;
    const [summary, panels] = await Promise.all([
      getDashboardSummary(user.tenantId, permittedClientIds(req)),
      getDashboardPanels(user.tenantId, permittedClientIds(req)),
    ]);
    res.json({ ...summary, ...panels });
  } catch (err) { next(err); }
});

// ── Play Analytics ────────────────────────────────────────────────────────────
router.get("/analytics/plays/:id", async (req, res, next): Promise<void> => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  try {
    const user = req.user as any;
    const [play] = await db.select().from(playsTable).where(eq(playsTable.id, id));
    if (!play || play.tenantId !== user.tenantId) { res.status(404).json({ error: "Play not found" }); return; }

    const { dateFrom, dateTo } = req.query as Record<string, string | undefined>;
    const dateFromClause = dateFrom ? sql`AND je.created_at >= ${reportDayStart(dateFrom)}` : sql``;
    const dateToClause   = dateTo   ? sql`AND je.created_at < ${reportDayEnd(dateTo)}` : sql``;
    const fsDateFromClause = dateFrom ? sql`AND fs.submitted_at >= ${reportDayStart(dateFrom)}` : sql``;
    const fsDateToClause   = dateTo   ? sql`AND fs.submitted_at < ${reportDayEnd(dateTo)}` : sql``;

    const enrolled = play.contactsEnrolled;
    const sent     = play.emailsSent;
    const pageVws  = play.pageViews;

    // Real open/click/form counts from email_events and form_submissions
    const openedRow = (await db.execute(sql`
      SELECT count(*)::int AS cnt FROM email_events
      WHERE tenant_id = ${play.tenantId}
        AND event_type = 'opened'
        AND template_id IN (
          SELECT DISTINCT (cfg->>'templateId')::int AS template_id
          FROM sequence_steps ss
          JOIN sequence_enrollments se ON se.sequence_id = ss.sequence_id
          JOIN play_contacts pc ON pc.contact_id = se.contact_id AND pc.play_id = ${play.id}
          WHERE (cfg->>'templateId') IS NOT NULL
        )
    `)).rows[0] as any;
    const clickedRow = (await db.execute(sql`
      SELECT count(*)::int AS cnt FROM email_events
      WHERE tenant_id = ${play.tenantId}
        AND event_type = 'clicked'
        AND template_id IN (
          SELECT DISTINCT (cfg->>'templateId')::int AS template_id
          FROM sequence_steps ss
          JOIN sequence_enrollments se ON se.sequence_id = ss.sequence_id
          JOIN play_contacts pc ON pc.contact_id = se.contact_id AND pc.play_id = ${play.id}
          WHERE (cfg->>'templateId') IS NOT NULL
        )
    `)).rows[0] as any;
    const formSubsRow = (await db.execute(sql`
      SELECT count(*)::int AS cnt
      FROM form_submissions fs
      WHERE fs.tenant_id = ${play.tenantId}
        AND fs.contact_id IN (
          SELECT contact_id FROM play_contacts WHERE play_id = ${play.id}
        )
    `)).rows[0] as any;

    // Also count from activity_events (covers opens tracked via pixel before email_events were wired)
    const aeOpenRow = (await db.execute(sql`
      SELECT count(*)::int AS cnt FROM activity_events
      WHERE tenant_id = ${play.tenantId}
        AND event_type = 'email_open'
        AND contact_id IN (SELECT contact_id FROM play_contacts WHERE play_id = ${play.id})
    `)).rows[0] as any;
    const aeClickRow = (await db.execute(sql`
      SELECT count(*)::int AS cnt FROM activity_events
      WHERE tenant_id = ${play.tenantId}
        AND event_type = 'email_click'
        AND contact_id IN (SELECT contact_id FROM play_contacts WHERE play_id = ${play.id})
    `)).rows[0] as any;

    const opened   = (openedRow?.cnt  ?? 0) + (aeOpenRow?.cnt  ?? 0);
    const clicked  = (clickedRow?.cnt ?? 0) + (aeClickRow?.cnt ?? 0);
    const formSubs = formSubsRow?.cnt ?? 0;
    const openRate  = sent > 0 ? Math.round((opened  / sent) * 100 * 10) / 10 : 0;
    const clickRate = sent > 0 ? Math.round((clicked / sent) * 100 * 10) / 10 : 0;

    // Avg score from enrolled contacts in this play
    const avgRow = (await db.execute(sql`
      SELECT coalesce(avg(c.lead_score), 0)::float AS avg
      FROM contacts c
      JOIN play_contacts pc ON pc.contact_id = c.id
      WHERE pc.play_id = ${play.id} AND c.tenant_id = ${play.tenantId}
    `)).rows[0] as any;
    const avgScore = Math.round(((avgRow as any)?.avg ?? 0) * 10) / 10;

    // Journey funnel
    const funnelStages = [
      { stage: "Enrolled",     count: enrolled,  pct: 100 },
      { stage: "Email Opened", count: opened,    pct: enrolled > 0 ? Math.round((opened  / enrolled) * 100) : 0 },
      { stage: "Page Viewed",  count: pageVws,   pct: enrolled > 0 ? Math.round((pageVws / enrolled) * 100) : 0 },
      { stage: "Link Clicked", count: clicked,   pct: enrolled > 0 ? Math.round((clicked / enrolled) * 100) : 0 },
      { stage: "Form Submit",  count: formSubs,  pct: enrolled > 0 ? Math.round((formSubs / enrolled) * 100) : 0 },
    ];

    // Email engagement: real daily data from email_events + activity_events over last 14 days
    const engagementRows = await db.execute(sql`
      SELECT
        ${reportDay(sql`occurred_at`)}::text AS day,
        count(*) FILTER (WHERE event_type = 'sent')::int    AS sent,
        count(*) FILTER (WHERE event_type = 'opened')::int  AS opens,
        count(*) FILTER (WHERE event_type = 'clicked')::int AS clicks
      FROM email_events
      WHERE tenant_id = ${play.tenantId}
        AND occurred_at >= now() - INTERVAL '14 days'
      GROUP BY 1 ORDER BY 1
    `);
    const aeEngagementRows = await db.execute(sql`
      SELECT
        ${reportDay(sql`created_at`)}::text AS day,
        count(*) FILTER (WHERE event_type = 'email_open')::int  AS opens,
        count(*) FILTER (WHERE event_type = 'email_click')::int AS clicks
      FROM activity_events
      WHERE tenant_id = ${play.tenantId}
        AND created_at >= now() - INTERVAL '14 days'
        AND contact_id IN (SELECT contact_id FROM play_contacts WHERE play_id = ${play.id})
      GROUP BY 1 ORDER BY 1
    `);

    // Build 14-day map merging both sources
    const eeMap: Record<string, { sent: number; opens: number; clicks: number }> = {};
    for (const r of engagementRows.rows as any[]) {
      const k = String(r.day).slice(0, 10);
      eeMap[k] = { sent: r.sent ?? 0, opens: r.opens ?? 0, clicks: r.clicks ?? 0 };
    }
    for (const r of aeEngagementRows.rows as any[]) {
      const k = String(r.day).slice(0, 10);
      if (!eeMap[k]) eeMap[k] = { sent: 0, opens: 0, clicks: 0 };
      eeMap[k].opens  += r.opens  ?? 0;
      eeMap[k].clicks += r.clicks ?? 0;
    }
    const today = new Intl.DateTimeFormat("sv-SE", {
      timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit",
    }).format(new Date());
    const emailEngagement = Array.from({ length: 14 }, (_, i) => {
      const d = new Date(`${today}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() - (13 - i));
      const key = d.toISOString().slice(0, 10);
      const row = eeMap[key] ?? { sent: 0, opens: 0, clicks: 0 };
      return { date: key, sent: row.sent, opens: row.opens, clicks: row.clicks };
    });

    // Leaderboard: top 10 contacts enrolled in this play via play_contacts
    const leaderboardRows = await db.execute(sql`
      SELECT c.id, c.first_name AS "firstName", c.last_name AS "lastName",
             c.email, c.lead_score AS "leadScore", c.tags
      FROM play_contacts pc
      JOIN contacts c ON c.id = pc.contact_id AND c.tenant_id = ${play.tenantId}
      WHERE pc.play_id = ${play.id} AND pc.tenant_id = ${play.tenantId}
      ORDER BY c.lead_score DESC
      LIMIT 10
    `);
    type LeaderboardRow = { id: number; firstName: string | null; lastName: string | null; email: string | null; leadScore: number; tags: string[] };
    const leaderboard = leaderboardRows.rows as LeaderboardRow[];

    // Per-page stats from journey_events (across all journeys linked to this play)
    let pageStats: { pageId: number; title: string; views: number; ctaClicks: number; ctr: number; formStarts: number; formCompletions: number; bannerDismisses: number }[] = [];
    const linkedJourneyRows = (await db.execute(sql`
      SELECT journey_id FROM journey_plays WHERE play_id = ${play.id}
    `)).rows as { journey_id: number }[];
    const linkedJourneyIds = linkedJourneyRows.map(r => r.journey_id);

    if (linkedJourneyIds.length > 0) {
      const pageRows = (await db.execute(sql`
        SELECT id, title, sort_order AS "sortOrder"
        FROM journey_pages WHERE journey_id = ANY(${sql`ARRAY[${sql.join(linkedJourneyIds.map(jid => sql`${jid}`), sql`, `)}]::int[]`})
        ORDER BY sort_order ASC
      `)).rows as { id: number; title: string; sortOrder: number }[];

      if (pageRows.length > 0) {
        const eventRows = (await db.execute(sql`
          SELECT je.page_id AS "pageId", je.event_type AS "eventType", COUNT(*)::int AS cnt
          FROM journey_events je
          WHERE je.journey_id = ANY(${sql`ARRAY[${sql.join(linkedJourneyIds.map(jid => sql`${jid}`), sql`, `)}]::int[]`}) AND je.page_id IS NOT NULL
            AND je.event_type IN ('page_view', 'cta_click', 'banner_dismiss', 'form_start')
            ${dateFromClause} ${dateToClause}
          GROUP BY je.page_id, je.event_type
        `)).rows as { pageId: number; eventType: string; cnt: number }[];

        const formCompRows = (await db.execute(sql`
          SELECT fs.page_id AS "pageId", COUNT(*)::int AS cnt
          FROM form_submissions fs
          WHERE fs.journey_id = ANY(${sql`ARRAY[${sql.join(linkedJourneyIds.map(jid => sql`${jid}`), sql`, `)}]::int[]`}) AND fs.page_id IS NOT NULL
            ${fsDateFromClause} ${fsDateToClause}
          GROUP BY fs.page_id
        `)).rows as { pageId: number; cnt: number }[];

        const statsMap: Record<number, { views: number; ctaClicks: number; formStarts: number; bannerDismisses: number }> = {};
        for (const r of eventRows) {
          if (!statsMap[r.pageId]) statsMap[r.pageId] = { views: 0, ctaClicks: 0, formStarts: 0, bannerDismisses: 0 };
          if (r.eventType === "page_view") statsMap[r.pageId].views = r.cnt;
          else if (r.eventType === "cta_click") statsMap[r.pageId].ctaClicks = r.cnt;
          else if (r.eventType === "form_start") statsMap[r.pageId].formStarts = r.cnt;
          else if (r.eventType === "banner_dismiss") statsMap[r.pageId].bannerDismisses = r.cnt;
        }

        const formCompMap: Record<number, number> = {};
        for (const r of formCompRows) formCompMap[r.pageId] = r.cnt;

        pageStats = pageRows.map(p => {
          const s = statsMap[p.id] ?? { views: 0, ctaClicks: 0, formStarts: 0, bannerDismisses: 0 };
          const ctr = s.views > 0 ? Math.round((s.ctaClicks / s.views) * 100 * 10) / 10 : 0;
          return { pageId: p.id, title: p.title, views: s.views, ctaClicks: s.ctaClicks, ctr, formStarts: s.formStarts, formCompletions: formCompMap[p.id] ?? 0, bannerDismisses: s.bannerDismisses };
        });
      }
    }

    res.json({
      playId: play.id, playName: play.name,
      kpi: { enrolled, emailsSent: sent, openRate, clickRate, pageViews: pageVws, formSubmits: formSubs, avgScore, completionRate: openRate },
      funnelStages,
      emailEngagement,
      leaderboard,
      pageStats,
    });
  } catch (err) { next(err); }
});

// ── Journey Page Stats ────────────────────────────────────────────────────────
// Returns per-page view counts and CTA click-through rates for a journey.
router.get("/analytics/journeys/:id/page-stats", async (req, res, next): Promise<void> => {
  const journeyId = parseInt(req.params.id);
  if (isNaN(journeyId)) { res.status(400).json({ error: "Invalid id" }); return; }
  try {
    const user = req.user as any;
    const jRows = (await db.execute(sql`
      SELECT id, tenant_id AS "tenantId", name, slug FROM journeys
      WHERE id = ${journeyId} LIMIT 1
    `)).rows as { id: number; tenantId: number; name: string; slug: string }[];
    if (!jRows[0] || jRows[0].tenantId !== user.tenantId) {
      res.status(404).json({ error: "Journey not found" }); return;
    }

    const { dateFrom, dateTo } = req.query as Record<string, string | undefined>;
    const dateFromClause = dateFrom ? sql`AND created_at >= ${reportDayStart(dateFrom)}` : sql``;
    const dateToClause   = dateTo   ? sql`AND created_at < ${reportDayEnd(dateTo)}` : sql``;

    const pageRows = (await db.execute(sql`
      SELECT id, title, sort_order AS "sortOrder"
      FROM journey_pages WHERE journey_id = ${journeyId}
      ORDER BY sort_order ASC
    `)).rows as { id: number; title: string; sortOrder: number }[];

    const eventRows = (await db.execute(sql`
      SELECT
        page_id AS "pageId",
        event_type AS "eventType",
        COUNT(*)::int AS cnt,
        COUNT(DISTINCT visitor_token) FILTER (WHERE visitor_token IS NOT NULL)::int AS unique_visitors
      FROM journey_events
      WHERE journey_id = ${journeyId}
        AND page_id IS NOT NULL
        AND event_type IN ('page_view', 'cta_click')
        ${dateFromClause} ${dateToClause}
      GROUP BY page_id, event_type
    `)).rows as { pageId: number; eventType: string; cnt: number; unique_visitors: number }[];

    const totalsRow = (await db.execute(sql`
      SELECT
        COUNT(*) FILTER (WHERE event_type = 'page_view')::int AS total_views,
        COUNT(*) FILTER (WHERE event_type = 'cta_click')::int AS total_cta_clicks,
        COUNT(DISTINCT visitor_token) FILTER (WHERE event_type = 'page_view' AND visitor_token IS NOT NULL)::int AS unique_visitors
      FROM journey_events
      WHERE journey_id = ${journeyId}
        ${dateFromClause} ${dateToClause}
    `)).rows[0] as { total_views: number; total_cta_clicks: number; unique_visitors: number } | undefined;

    const statsMap: Record<number, { views: number; ctaClicks: number; uniqueVisitors: number }> = {};
    for (const r of eventRows) {
      if (!statsMap[r.pageId]) statsMap[r.pageId] = { views: 0, ctaClicks: 0, uniqueVisitors: 0 };
      if (r.eventType === "page_view") {
        statsMap[r.pageId].views = r.cnt;
        statsMap[r.pageId].uniqueVisitors = r.unique_visitors;
      } else if (r.eventType === "cta_click") {
        statsMap[r.pageId].ctaClicks = r.cnt;
      }
    }

    const pages = pageRows.map(p => {
      const s = statsMap[p.id] ?? { views: 0, ctaClicks: 0, uniqueVisitors: 0 };
      const ctr = s.views > 0 ? Math.round((s.ctaClicks / s.views) * 100 * 10) / 10 : 0;
      return { pageId: p.id, title: p.title, sortOrder: p.sortOrder, views: s.views, ctaClicks: s.ctaClicks, uniqueVisitors: s.uniqueVisitors, ctr };
    });

    res.json({
      journeyId,
      journeyName: jRows[0].name,
      totalViews: totalsRow?.total_views ?? 0,
      totalCtaClicks: totalsRow?.total_cta_clicks ?? 0,
      uniqueVisitors: totalsRow?.unique_visitors ?? 0,
      pages,
    });
  } catch (err) { next(err); }
});

// ── Journey Visitor Trends ────────────────────────────────────────────────────
// Returns daily page_view and cta_click counts for the last N days (default 30).
router.get("/analytics/journeys/:id/trends", async (req, res, next): Promise<void> => {
  const journeyId = parseInt(req.params.id);
  if (isNaN(journeyId)) { res.status(400).json({ error: "Invalid id" }); return; }
  try {
    const user = req.user as any;
    const days = Math.min(90, Math.max(1, parseInt(String(req.query.days ?? "30")) || 30));
    const { dateFrom, dateTo } = req.query as Record<string, string | undefined>;

    const jRows = (await db.execute(sql`
      SELECT id, tenant_id AS "tenantId", name, slug FROM journeys
      WHERE id = ${journeyId} LIMIT 1
    `)).rows as { id: number; tenantId: number; name: string; slug: string }[];
    if (!jRows[0] || jRows[0].tenantId !== user.tenantId) {
      res.status(404).json({ error: "Journey not found" }); return;
    }

    // When explicit dateFrom/dateTo are provided, use them directly.
    // Otherwise fall back to the rolling `days` window.
    let startDate: string;
    let endDate: string;
    if (dateFrom || dateTo) {
      const computed = (await db.execute(sql`
        SELECT
          coalesce(${dateFrom ?? null}::date, ${reportDay(sql`NOW()`)} - ${days - 1})::text AS start_date,
          coalesce(${dateTo ?? null}::date, ${reportDay(sql`NOW()`)})::text AS end_date
      `)).rows[0] as { start_date: string; end_date: string };
      startDate = computed.start_date;
      endDate = computed.end_date;
    } else {
      const computed = (await db.execute(sql`
        SELECT (${reportDay(sql`NOW()`)} - ${days - 1})::text AS start_date,
               ${reportDay(sql`NOW()`)}::text AS end_date
      `)).rows[0] as { start_date: string; end_date: string };
      startDate = computed.start_date;
      endDate = computed.end_date;
    }

    // Build a complete date series so days with 0 events still appear
    const seriesRows = (await db.execute(sql`
      SELECT gs::date::text AS date
      FROM generate_series(
        ${startDate}::date,
        ${endDate}::date,
        '1 day'::interval
      ) AS gs
      ORDER BY gs ASC
    `)).rows as { date: string }[];

    const isStandaloneContest =
      jRows[0].slug === "poly-contest" ||
      jRows[0].slug === "2-minute-meeting-rescue-1786861832577";

    const eventRows = (await db.execute(isStandaloneContest ? sql`
      SELECT
        date,
        SUM(page_views)::int AS page_views,
        SUM(cta_clicks)::int AS cta_clicks,
        SUM(unique_visitors)::int AS unique_visitors
      FROM (
        SELECT
          ${reportDay(sql`created_at`)}::text AS date,
          COUNT(*)::int AS page_views,
          0::int AS cta_clicks,
          COUNT(DISTINCT COALESCE(contact_id::text, visitor_token))::int AS unique_visitors
        FROM activity_events
        WHERE journey_id = ${journeyId}
          AND event_type = 'page_view'
          AND COALESCE(is_bot, false) = false
          AND created_at >= ${reportDayStart(startDate)}
          AND created_at < ${reportDayEnd(endDate)}
        GROUP BY 1
        UNION ALL
        SELECT
          ${reportDay(sql`created_at`)}::text AS date,
          0::int AS page_views,
          COUNT(*) FILTER (WHERE event_type = 'cta_click')::int AS cta_clicks,
          0::int AS unique_visitors
        FROM journey_events
        WHERE journey_id = ${journeyId}
          AND event_type = 'cta_click'
          AND is_bot IS DISTINCT FROM TRUE
          AND created_at >= ${reportDayStart(startDate)}
          AND created_at < ${reportDayEnd(endDate)}
        GROUP BY 1
      ) contest_daily
      GROUP BY date
      ORDER BY date ASC
    ` : sql`
      SELECT
        ${reportDay(sql`created_at`)}::text AS date,
        COUNT(*) FILTER (WHERE event_type = 'page_view')::int  AS page_views,
        COUNT(*) FILTER (WHERE event_type = 'cta_click')::int  AS cta_clicks,
        COUNT(DISTINCT visitor_token) FILTER (WHERE event_type = 'page_view' AND visitor_token IS NOT NULL)::int AS unique_visitors
      FROM journey_events
      WHERE journey_id = ${journeyId}
        AND created_at >= ${reportDayStart(startDate)}
        AND created_at < ${reportDayEnd(endDate)}
      GROUP BY 1
      ORDER BY 1 ASC
    `)).rows as { date: string; page_views: number; cta_clicks: number; unique_visitors: number }[];

    const eventMap: Record<string, { pageViews: number; ctaClicks: number; uniqueVisitors: number }> = {};
    for (const r of eventRows) {
      eventMap[r.date] = { pageViews: r.page_views, ctaClicks: r.cta_clicks, uniqueVisitors: r.unique_visitors };
    }

    const trend = seriesRows.map(({ date }) => {
      const e = eventMap[date] ?? { pageViews: 0, ctaClicks: 0, uniqueVisitors: 0 };
      return { date, pageViews: e.pageViews, ctaClicks: e.ctaClicks, uniqueVisitors: e.uniqueVisitors };
    });

    const totalsRow = (await db.execute(isStandaloneContest ? sql`
      SELECT
        (SELECT COUNT(*)::int
           FROM activity_events
          WHERE journey_id = ${journeyId}
            AND event_type = 'page_view'
            AND COALESCE(is_bot, false) = false
            AND created_at >= ${reportDayStart(startDate)}
            AND created_at < ${reportDayEnd(endDate)}) AS total_views,
        (SELECT COUNT(*)::int
           FROM journey_events
          WHERE journey_id = ${journeyId}
            AND event_type = 'cta_click'
            AND is_bot IS DISTINCT FROM TRUE
            AND created_at >= ${reportDayStart(startDate)}
            AND created_at < ${reportDayEnd(endDate)}) AS total_cta_clicks,
        (SELECT COUNT(DISTINCT COALESCE(contact_id::text, visitor_token))::int
           FROM activity_events
          WHERE journey_id = ${journeyId}
            AND event_type = 'page_view'
            AND COALESCE(is_bot, false) = false
            AND created_at >= ${reportDayStart(startDate)}
            AND created_at < ${reportDayEnd(endDate)}) AS unique_visitors
    ` : sql`
      SELECT
        COUNT(*) FILTER (WHERE event_type = 'page_view')::int AS total_views,
        COUNT(*) FILTER (WHERE event_type = 'cta_click')::int AS total_cta_clicks,
        COUNT(DISTINCT visitor_token) FILTER (WHERE event_type = 'page_view' AND visitor_token IS NOT NULL)::int AS unique_visitors
      FROM journey_events
      WHERE journey_id = ${journeyId}
        AND created_at >= ${reportDayStart(startDate)}
        AND created_at < ${reportDayEnd(endDate)}
    `)).rows[0] as { total_views: number; total_cta_clicks: number; unique_visitors: number } | undefined;

    res.json({
      journeyId,
      journeyName: jRows[0].name,
      days,
      totalViews:      totalsRow?.total_views ?? 0,
      totalCtaClicks:  totalsRow?.total_cta_clicks ?? 0,
      uniqueVisitors:  totalsRow?.unique_visitors ?? 0,
      trend,
    });
  } catch (err) { next(err); }
});

// ── Journey Event Log ─────────────────────────────────────────────────────────
// Returns the most recent journey_events (all types including custom) for a journey.
// Used by the journey builder analytics tab to show a live event stream.
router.get("/analytics/journeys/:id/events", async (req, res, next): Promise<void> => {
  const journeyId = parseInt(req.params.id);
  if (isNaN(journeyId)) { res.status(400).json({ error: "Invalid id" }); return; }
  try {
    const user = req.user as any;
    const jRows = (await db.execute(sql`
      SELECT id, tenant_id AS "tenantId", slug FROM journeys WHERE id = ${journeyId} LIMIT 1
    `)).rows as { id: number; tenantId: number; slug: string }[];
    if (!jRows[0] || jRows[0].tenantId !== user.tenantId) {
      res.status(404).json({ error: "Journey not found" }); return;
    }

    const limit = Math.min(200, Math.max(1, parseInt(String(req.query.limit ?? "100")) || 100));
    const { dateFrom, dateTo, eventType } = req.query as Record<string, string | undefined>;

    const dateFromClause = dateFrom ? sql`AND je.created_at >= ${reportDayStart(dateFrom)}` : sql``;
    const dateToClause   = dateTo   ? sql`AND je.created_at < ${reportDayEnd(dateTo)}` : sql``;
    const typeClause     = eventType ? sql`AND je.event_type = ${eventType}` : sql``;
    const aeDateFromClause = dateFrom ? sql`AND ae.created_at >= ${reportDayStart(dateFrom)}` : sql``;
    const aeDateToClause   = dateTo   ? sql`AND ae.created_at < ${reportDayEnd(dateTo)}` : sql``;
    const isStandaloneContest =
      jRows[0].slug === "poly-contest" ||
      jRows[0].slug === "2-minute-meeting-rescue-1786861832577";

    const eventRows = (await db.execute(isStandaloneContest ? sql`
      SELECT * FROM (
        SELECT
          -ae.id AS id,
          'page_view'::text AS "eventType",
          ae.visitor_token AS "visitorToken",
          ae.page_url AS "pageUrl",
          jsonb_build_object('source', ae.source, 'embedded', true) AS props,
          ae.created_at AS "createdAt",
          ae.page_name AS "pageTitle"
        FROM activity_events ae
        WHERE ae.journey_id = ${journeyId}
          AND ae.event_type = 'page_view'
          AND COALESCE(ae.is_bot, false) = false
          ${aeDateFromClause} ${aeDateToClause}
        UNION ALL
        SELECT
          je.id,
          je.event_type AS "eventType",
          je.visitor_token AS "visitorToken",
          je.page_url AS "pageUrl",
          je.props,
          je.created_at AS "createdAt",
          jp.title AS "pageTitle"
        FROM journey_events je
        LEFT JOIN journey_pages jp ON jp.id = je.page_id
        WHERE je.journey_id = ${journeyId}
          AND je.event_type <> 'page_view'
          AND je.is_bot IS DISTINCT FROM TRUE
          ${dateFromClause} ${dateToClause}
      ) contest_events
      ${eventType ? sql`WHERE contest_events."eventType" = ${eventType}` : sql``}
      ORDER BY "createdAt" DESC
      LIMIT ${limit}
    ` : sql`
      SELECT
        je.id,
        je.event_type   AS "eventType",
        je.visitor_token AS "visitorToken",
        je.page_url     AS "pageUrl",
        je.props,
        je.created_at   AS "createdAt",
        jp.title        AS "pageTitle"
      FROM journey_events je
      LEFT JOIN journey_pages jp ON jp.id = je.page_id
      WHERE je.journey_id = ${journeyId}
        AND je.is_bot IS DISTINCT FROM TRUE
        ${dateFromClause} ${dateToClause} ${typeClause}
      ORDER BY je.created_at DESC
      LIMIT ${limit}
    `)).rows as {
      id: number; eventType: string; visitorToken: string | null;
      pageUrl: string | null; props: Record<string, unknown> | null;
      createdAt: string; pageTitle: string | null;
    }[];

    // Aggregate event type counts for the funnel summary
    const countRows = (await db.execute(isStandaloneContest ? sql`
      SELECT "eventType", COUNT(*)::int AS cnt
      FROM (
        SELECT 'page_view'::text AS "eventType"
        FROM activity_events ae
        WHERE ae.journey_id = ${journeyId}
          AND ae.event_type = 'page_view'
          AND COALESCE(ae.is_bot, false) = false
        UNION ALL
        SELECT je.event_type AS "eventType"
        FROM journey_events je
        WHERE je.journey_id = ${journeyId}
          AND je.event_type <> 'page_view'
          AND je.is_bot IS DISTINCT FROM TRUE
      ) contest_event_types
      GROUP BY "eventType"
      ORDER BY cnt DESC
    ` : sql`
      SELECT event_type AS "eventType", COUNT(*)::int AS cnt
      FROM journey_events
      WHERE journey_id = ${journeyId} AND is_bot IS DISTINCT FROM TRUE
      GROUP BY event_type
      ORDER BY cnt DESC
    `)).rows as { eventType: string; cnt: number }[];

    res.json({ events: eventRows, summary: countRows });
  } catch (err) { next(err); }
});

// ── Sequence Deliverability Overview ─────────────────────────────────────────
// Returns per-sequence deliverability stats for all sequences in the tenant.
// Used by the Sequences list to show a health badge without opening each sequence.
// IMPORTANT: must be registered BEFORE /analytics/sequences/:id to avoid route shadowing.
router.get("/analytics/sequences/deliverability", async (req, res, next): Promise<void> => {
  try {
    const user = req.user as any;
    const tid  = user.tenantId;
    const pool = (await import("@workspace/db")).pool;

    const rows = await pool.query<{
      sequence_id: string;
      sent: string;
      delivered: string;
      bounced: string;
      unsubscribed: string;
    }>(
      `SELECT
         se.sequence_id,
         COUNT(*) FILTER (WHERE ee.event_type = 'sent')::text         AS sent,
         COUNT(*) FILTER (WHERE ee.event_type = 'delivered')::text    AS delivered,
         COUNT(*) FILTER (WHERE ee.event_type = 'bounced')::text      AS bounced,
         COUNT(*) FILTER (WHERE ee.event_type = 'unsubscribed')::text AS unsubscribed
       FROM email_events ee
       JOIN sequence_enrollments se
         ON (ee.metadata->>'enrollmentId')::int = se.id
       WHERE ee.tenant_id = $1
         AND COALESCE(ee.is_bot, false) = false
       GROUP BY se.sequence_id`,
      [tid]
    );

    const result: Record<number, {
      sent: number; delivered: number; bounced: number; unsubscribed: number;
      deliveryRate: number; bounceRate: number; unsubscribeRate: number;
      health: "green" | "amber" | "red" | "none";
    }> = {};

    for (const r of rows.rows) {
      const sent         = parseInt(r.sent ?? "0");
      const delivered    = parseInt(r.delivered ?? "0");
      const bounced      = parseInt(r.bounced ?? "0");
      const unsubscribed = parseInt(r.unsubscribed ?? "0");

      // effectiveDelivered: when delivered=0 AND bounced=0 we have no negative signal —
      // this happens for SMTP sends that pre-date the smtp_accepted delivered event fix,
      // or Resend sends where the delivery webhook was not configured. Treat all
      // non-bounced sent emails as delivered so the badge is not falsely Critical.
      const effectiveDelivered = delivered > 0 ? delivered : (bounced === 0 ? sent : sent - bounced);
      const deliveryRate    = sent > 0 ? Math.round((effectiveDelivered / sent) * 1000) / 10 : 0;
      const bounceRate      = sent > 0 ? Math.round((bounced      / sent) * 1000) / 10 : 0;
      const unsubscribeRate = sent > 0 ? Math.round((unsubscribed / sent) * 1000) / 10 : 0;

      let health: "green" | "amber" | "red" | "none" = "none";
      if (sent > 0) {
        if (bounceRate < 2 && deliveryRate >= 95)       health = "green";
        else if (bounceRate < 5 && deliveryRate >= 85)  health = "amber";
        else                                             health = "red";
      }

      result[parseInt(r.sequence_id)] = { sent, delivered, bounced, unsubscribed, deliveryRate, bounceRate, unsubscribeRate, health };
    }

    res.json(result);
  } catch (err) { next(err); }
});

// ── Sequence Analytics ────────────────────────────────────────────────────────
router.get("/analytics/sequences/:id", async (req, res, next): Promise<void> => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  try {
    const user = req.user as any;
    const tid  = user.tenantId;
    const pool = (await import("@workspace/db")).pool;

    const [seq] = await db.select().from(emailSequencesTable).where(eq(emailSequencesTable.id, id));
    if (!seq || seq.tenantId !== tid) { res.status(404).json({ error: "Sequence not found" }); return; }

    // Parse nodes to get email steps
    let nodes: any[] = [];
    try {
      const raw = seq.nodesJson as any;
      const parsed = typeof raw === "string" ? JSON.parse(raw) : (raw ?? {});
      nodes = parsed.nodes ?? [];
    } catch { /* empty graph */ }

    // ── Real enrollment counts ────────────────────────────────────────────────
    const enrollRows = await pool.query<{ total: string; completed: string }>(
      `SELECT COUNT(*)::text AS total,
              COUNT(*) FILTER (WHERE status = 'completed')::text AS completed
       FROM sequence_enrollments
       WHERE sequence_id = $1 AND tenant_id = $2`,
      [id, tid]
    );
    const totalEnrolled  = parseInt(enrollRows.rows[0]?.total ?? "0");
    const totalCompleted = parseInt(enrollRows.rows[0]?.completed ?? "0");

    // ── Deliverability: real counts from email_events via enrollmentId in metadata ──
    const delivRows = await pool.query<{ event_type: string; cnt: string; bot_cnt: string }>(
      `SELECT ee.event_type,
              COUNT(*)::text AS cnt,
              COUNT(*) FILTER (WHERE COALESCE(ee.is_bot, false) = true)::text AS bot_cnt
       FROM email_events ee
       WHERE ee.tenant_id = $1
         AND (ee.metadata->>'enrollmentId')::int IN (
               SELECT id FROM sequence_enrollments WHERE sequence_id = $2 AND tenant_id = $1
             )
       GROUP BY ee.event_type`,
      [tid, id]
    );
    const delivMap: Record<string, { total: number; bots: number }> = {};
    for (const r of delivRows.rows) {
      delivMap[r.event_type] = { total: parseInt(r.cnt), bots: parseInt(r.bot_cnt) };
    }

    // ── Per sending-path aggregate (resend vs smtp) ────────────────────────────
    const pathRows = await pool.query<{ sending_path: string | null; cnt: string }>(
      `SELECT COALESCE(sending_path, 'resend') AS sending_path,
              COUNT(*)::text AS cnt
       FROM email_events
       WHERE tenant_id = $1
         AND event_type = 'sent'
         AND (metadata->>'enrollmentId')::int IN (
               SELECT id FROM sequence_enrollments WHERE sequence_id = $2 AND tenant_id = $1
             )
       GROUP BY sending_path`,
      [tid, id]
    );
    const pathMap: Record<string, number> = {};
    for (const r of pathRows.rows) {
      pathMap[r.sending_path ?? "resend"] = parseInt(r.cnt);
    }

    const deliverability = {
      sent:         delivMap["sent"]?.total ?? 0,
      delivered:    delivMap["delivered"]?.total ?? 0,
      opened:       (delivMap["opened"]?.total ?? 0) - (delivMap["opened"]?.bots ?? 0),  // bot-filtered
      openedBots:   delivMap["opened"]?.bots ?? 0,
      clicked:      (delivMap["clicked"]?.total ?? 0) - (delivMap["clicked"]?.bots ?? 0),
      bounced:      delivMap["bounced"]?.total ?? 0,
      unsubscribed: delivMap["unsubscribed"]?.total ?? 0,
      spam:         delivMap["complained"]?.total ?? 0,  // Resend sends complained events for spam reports
      sentViaResend: pathMap["resend"] ?? 0,
      sentViaSMTP:   pathMap["smtp"] ?? 0,
    };

    // ── Per-step breakdown from real email_events ─────────────────────────────
    const stepRows = await pool.query<{ step_id: string; event_type: string; cnt: string; bot_cnt: string }>(
      `SELECT ee.metadata->>'stepId' AS step_id,
              ee.event_type,
              COUNT(*)::text AS cnt,
              COUNT(*) FILTER (WHERE COALESCE(ee.is_bot, false) = true)::text AS bot_cnt
       FROM email_events ee
       WHERE ee.tenant_id = $1
         AND (ee.metadata->>'enrollmentId')::int IN (
               SELECT id FROM sequence_enrollments WHERE sequence_id = $2 AND tenant_id = $1
             )
         AND ee.metadata->>'stepId' IS NOT NULL
       GROUP BY ee.metadata->>'stepId', ee.event_type`,
      [tid, id]
    );

    // Per-step sending path counts (resend vs smtp, 'sent' events only)
    const stepPathRows = await pool.query<{ step_id: string; sending_path: string | null; cnt: string }>(
      `SELECT ee.metadata->>'stepId' AS step_id,
              COALESCE(ee.sending_path, 'resend') AS sending_path,
              COUNT(*)::text AS cnt
       FROM email_events ee
       WHERE ee.tenant_id = $1
         AND ee.event_type = 'sent'
         AND (ee.metadata->>'enrollmentId')::int IN (
               SELECT id FROM sequence_enrollments WHERE sequence_id = $2 AND tenant_id = $1
             )
         AND ee.metadata->>'stepId' IS NOT NULL
       GROUP BY ee.metadata->>'stepId', ee.sending_path`,
      [tid, id]
    );

    // Map stepId → event type → counts
    const stepMap: Record<string, Record<string, { total: number; bots: number }>> = {};
    for (const r of stepRows.rows) {
      const sid = r.step_id ?? "";
      if (!stepMap[sid]) stepMap[sid] = {};
      stepMap[sid][r.event_type] = { total: parseInt(r.cnt), bots: parseInt(r.bot_cnt) };
    }

    // Map stepId → sending path → count
    const stepPathMap: Record<string, Record<string, number>> = {};
    for (const r of stepPathRows.rows) {
      const sid = r.step_id ?? "";
      if (!stepPathMap[sid]) stepPathMap[sid] = {};
      stepPathMap[sid][r.sending_path ?? "resend"] = parseInt(r.cnt);
    }

    const emailNodes = nodes.filter((n: any) => n.type === "email");
    const stepBreakdown = emailNodes.map((n: any, i: number) => {
      const sm    = stepMap[String(i)] ?? stepMap[n.id] ?? {};
      const pm    = stepPathMap[String(i)] ?? stepPathMap[n.id] ?? {};
      const sent  = sm["sent"]?.total ?? 0;
      const opens = Math.max(0, (sm["opened"]?.total ?? 0) - (sm["opened"]?.bots ?? 0));
      const clicks = Math.max(0, (sm["clicked"]?.total ?? 0) - (sm["clicked"]?.bots ?? 0));
      const bounces = sm["bounced"]?.total ?? 0;
      return {
        stepId:    n.id,
        name:      n.data?.templateName ?? `Email ${i + 1}`,
        sent,
        opens,
        clicks,
        bounces,
        openRate:   sent > 0 ? Math.round((opens / sent) * 100 * 10) / 10 : 0,
        clickRate:  sent > 0 ? Math.round((clicks / sent) * 100 * 10) / 10 : 0,
        bounceRate: sent > 0 ? Math.round((bounces / sent) * 100 * 10) / 10 : 0,
        sendingPaths: { resend: pm["resend"] ?? 0, smtp: pm["smtp"] ?? 0 },
      };
    });

    const avgOpenRate  = stepBreakdown.length ? Math.round(stepBreakdown.reduce((s: number, r: any) => s + r.openRate, 0) / stepBreakdown.length * 10) / 10 : 0;
    const avgClickRate = stepBreakdown.length ? Math.round(stepBreakdown.reduce((s: number, r: any) => s + r.clickRate, 0) / stepBreakdown.length * 10) / 10 : 0;

    // ── Email client & device type breakdown from metadata ────────────────────
    // Only for non-bot opens that have UA data stored in metadata
    const clientRows = await pool.query<{ email_client: string; cnt: string }>(
      `SELECT COALESCE(metadata->>'emailClient', 'Unknown') AS email_client,
              COUNT(*)::text AS cnt
       FROM email_events
       WHERE tenant_id = $1
         AND event_type = 'opened'
         AND COALESCE(is_bot, false) = false
         AND (metadata->>'enrollmentId')::int IN (
               SELECT id FROM sequence_enrollments WHERE sequence_id = $2 AND tenant_id = $1
             )
         AND metadata->>'emailClient' IS NOT NULL
       GROUP BY email_client
       ORDER BY cnt::int DESC
       LIMIT 10`,
      [tid, id]
    );

    const deviceRows = await pool.query<{ device_type: string; cnt: string }>(
      `SELECT COALESCE(metadata->>'deviceType', 'unknown') AS device_type,
              COUNT(*)::text AS cnt
       FROM email_events
       WHERE tenant_id = $1
         AND event_type = 'opened'
         AND COALESCE(is_bot, false) = false
         AND (metadata->>'enrollmentId')::int IN (
               SELECT id FROM sequence_enrollments WHERE sequence_id = $2 AND tenant_id = $1
             )
         AND metadata->>'deviceType' IS NOT NULL
       GROUP BY device_type
       ORDER BY cnt::int DESC`,
      [tid, id]
    );

    const totalClientOpens = clientRows.rows.reduce((s, r) => s + parseInt(r.cnt), 0);
    const emailClients = clientRows.rows.map(r => ({
      client: r.email_client,
      count: parseInt(r.cnt),
      share: totalClientOpens > 0 ? Math.round((parseInt(r.cnt) / totalClientOpens) * 100 * 10) / 10 : 0,
    }));

    const totalDeviceOpens = deviceRows.rows.reduce((s, r) => s + parseInt(r.cnt), 0);
    const deviceTypes = deviceRows.rows.map(r => ({
      device: r.device_type,
      count: parseInt(r.cnt),
      share: totalDeviceOpens > 0 ? Math.round((parseInt(r.cnt) / totalDeviceOpens) * 100 * 10) / 10 : 0,
    }));

    res.json({
      sequenceId: seq.id, sequenceName: seq.name, status: seq.status,
      totalEnrolled, totalCompleted,
      avgOpenRate, avgClickRate,
      deliverability,
      stepBreakdown,
      emailClients,
      deviceTypes,
    });
  } catch (err) { next(err); }
});

// ── Leaderboard ───────────────────────────────────────────────────────────────
router.get("/analytics/leaderboard", async (req, res, next): Promise<void> => {
  try {
    const user = req.user as any;
    const limit = parseInt(String(req.query.limit ?? "10")) || 10;
    const contacts = await db
      .select()
      .from(contactsTable)
      .where(eq(contactsTable.tenantId, user.tenantId))
      .orderBy(desc(contactsTable.leadScore))
      .limit(limit);

    const result = await Promise.all(
      contacts.map(async (c) => {
        let company: string | null = null;
        if (c.companyId) {
          const [co] = await db.select({ name: companiesTable.name }).from(companiesTable).where(eq(companiesTable.id, c.companyId));
          company = co?.name ?? null;
        }
        const [actCount] = await db.select({ count: sql<number>`count(*)::int` }).from(activityEventsTable).where(eq(activityEventsTable.contactId, c.id));
        return { contactId: c.id, firstName: c.firstName, lastName: c.lastName, email: c.email, company, leadScore: c.leadScore, activityCount: actCount?.count ?? 0, lastActivity: c.lastActivity?.toISOString() ?? null };
      }),
    );
    res.json(result);
  } catch (err) { next(err); }
});

// ── Activity Feed ─────────────────────────────────────────────────────────────
router.get("/analytics/activity-feed", async (req, res, next): Promise<void> => {
  try {
    const user = req.user as any;
    const limit = parseInt(String(req.query.limit ?? "20")) || 20;
    const feed = await db
      .select()
      .from(activityEventsTable)
      .where(sql`contact_id IN (SELECT id FROM contacts WHERE tenant_id = ${user.tenantId})`)
      .orderBy(desc(activityEventsTable.createdAt))
      .limit(limit);
    res.json(feed);
  } catch (err) { next(err); }
});

// ── Traffic Analytics ─────────────────────────────────────────────────────────
router.get("/analytics/traffic", async (req, res, next): Promise<void> => {
  try {
    const user = req.user as any;
    const tid = user.tenantId;
    const { dateFrom, dateTo, source: srcF, journeyId, part } = req.query as Record<string, string | undefined>;
    const jid = journeyId ? Number(journeyId) : null;
    const accountSelection = await getTenantCompanySelection(req.query as Record<string, unknown>, tid);
    if (accountSelection.error) {
      res.status(400).json({ error: accountSelection.error });
      return;
    }
    const companyIds = accountSelection.companyIds;
    const clientRaw = req.query.clientId;
    let clientId: number | null = null;
    if (clientRaw != null) {
      if (typeof clientRaw !== "string" || !/^[1-9]\d*$/.test(clientRaw) ||
          !Number.isSafeInteger(Number(clientRaw))) {
        res.status(400).json({ error: "Invalid client" }); return;
      }
      clientId = Number(clientRaw);
      const client = await db.execute(sql`SELECT 1 FROM clients WHERE tenant_id=${tid} AND id=${clientId}`);
      if (!client.rows.length) { res.status(400).json({ error: "Client is unavailable for this tenant" }); return; }
    }

    const rr = (x: any) => x.rows as any[];
    let summary: { kpi: Record<string, number>; trend: any[] } | undefined;

    if (part !== "details") {
    // Count page views across both activity_events (identified contacts) and
    // journey_events (anonymous visitors). journey_events captures all traffic;
    // activity_events only captures identified-contact events.
    // Date filters include the full selected Asia/Kolkata calendar day.
    const visitsPromise = db.execute(sql`
      SELECT count(*)::int AS total FROM (
        SELECT ae.id FROM activity_events ae
        WHERE tenant_id=${tid} AND event_type='page_view' AND COALESCE(is_bot, false) = false
          ${activityCompanyFilter("ae", companyIds)}
          ${activityClientFilter("ae", clientId)}
          ${srcF     ? sql`AND source=${srcF}` : sql``}
          ${jid      ? sql`AND journey_id=${jid}` : sql``}
          ${dateFrom ? sql`AND created_at >= ${reportDayStart(dateFrom)}` : sql``}
          ${dateTo   ? sql`AND created_at < ${reportDayEnd(dateTo)}` : sql``}
        UNION ALL
        SELECT je.id FROM journey_events je
        WHERE je.tenant_id=${tid} AND je.event_type='page_view' AND COALESCE(je.is_bot, false) = false
          ${journeyCompanyFilter(companyIds)}
          ${journeyClientFilter(clientId)}
          ${jid      ? sql`AND journey_id=${jid}` : sql``}
          ${dateFrom ? sql`AND created_at >= ${reportDayStart(dateFrom)}` : sql``}
          ${dateTo   ? sql`AND created_at < ${reportDayEnd(dateTo)}` : sql``}
      ) _pv
    `);

    // Count bot page_view events that were filtered out (for UI display)
    const botFilteredPromise = db.execute(sql`
      SELECT count(*)::int AS total FROM (
        SELECT ae.id FROM activity_events ae
        WHERE ae.tenant_id=${tid} AND ae.event_type='page_view' AND COALESCE(ae.is_bot, false) = true
          ${activityCompanyFilter("ae", companyIds)}
          ${activityClientFilter("ae", clientId)}
          ${jid      ? sql`AND journey_id=${jid}` : sql``}
          ${dateFrom ? sql`AND created_at >= ${reportDayStart(dateFrom)}` : sql``}
          ${dateTo   ? sql`AND created_at < ${reportDayEnd(dateTo)}` : sql``}
        UNION ALL
        SELECT je.id FROM journey_events je
        WHERE je.tenant_id=${tid} AND je.event_type='page_view' AND COALESCE(je.is_bot, false) = true
          ${journeyCompanyFilter(companyIds)}
          ${journeyClientFilter(clientId)}
          ${jid      ? sql`AND journey_id=${jid}` : sql``}
          ${dateFrom ? sql`AND created_at >= ${reportDayStart(dateFrom)}` : sql``}
          ${dateTo   ? sql`AND created_at < ${reportDayEnd(dateTo)}` : sql``}
      ) _bot
    `);

    const uniquePromise = db.execute(sql`
      SELECT count(DISTINCT token)::int AS total FROM (
        -- Identified contacts from activity_events; use contact_id as the dedup key
        SELECT ae.contact_id::text AS token FROM activity_events ae
        WHERE ae.tenant_id=${tid} AND ae.event_type='page_view' AND ae.contact_id IS NOT NULL AND COALESCE(ae.is_bot, false) = false
          ${activityCompanyFilter("ae", companyIds)}
          ${activityClientFilter("ae", clientId)}
          ${srcF     ? sql`AND source=${srcF}` : sql``}
          ${jid      ? sql`AND journey_id=${jid}` : sql``}
          ${dateFrom ? sql`AND created_at >= ${reportDayStart(dateFrom)}` : sql``}
          ${dateTo   ? sql`AND created_at < ${reportDayEnd(dateTo)}` : sql``}
        UNION ALL
        -- Anonymous activity_events (no contact linked yet); use visitor_token as the dedup key
        SELECT ae.visitor_token AS token FROM activity_events ae
        WHERE ae.tenant_id=${tid} AND ae.event_type='page_view' AND ae.contact_id IS NULL AND ae.visitor_token IS NOT NULL AND COALESCE(ae.is_bot, false) = false
          ${activityCompanyFilter("ae", companyIds)}
          ${activityClientFilter("ae", clientId)}
          ${srcF     ? sql`AND source=${srcF}` : sql``}
          ${jid      ? sql`AND journey_id=${jid}` : sql``}
          ${dateFrom ? sql`AND created_at >= ${reportDayStart(dateFrom)}` : sql``}
          ${dateTo   ? sql`AND created_at < ${reportDayEnd(dateTo)}` : sql``}
        UNION ALL
        -- Journey events: resolve visitor_token → contact_id so the same person isn't
        -- double-counted when they also appear in activity_events
        SELECT ${companyIds !== null
          ? sql`COALESCE(vt.contact_id::text, fs.contact_id::text, je.visitor_token)`
          : sql`COALESCE(vt.contact_id::text, je.visitor_token)`} AS token
        FROM journey_events je
        LEFT JOIN visitor_tokens vt ON vt.token = je.visitor_token AND vt.tenant_id = je.tenant_id
        LEFT JOIN LATERAL (
          SELECT contact_id FROM form_submissions
          WHERE visitor_token = je.visitor_token AND tenant_id = je.tenant_id AND contact_id IS NOT NULL
          ORDER BY submitted_at DESC LIMIT 1
        ) fs ON TRUE
        WHERE je.tenant_id=${tid} AND je.event_type='page_view' AND je.visitor_token IS NOT NULL AND COALESCE(je.is_bot, false) = false
          ${journeyCompanyFilter(companyIds)}
          ${journeyClientFilter(clientId)}
          ${jid      ? sql`AND je.journey_id=${jid}` : sql``}
          ${dateFrom ? sql`AND je.created_at >= ${reportDayStart(dateFrom)}` : sql``}
          ${dateTo   ? sql`AND je.created_at < ${reportDayEnd(dateTo)}` : sql``}
          -- Exclude if already counted via activity_events (same contact_id)
          AND NOT EXISTS (
            SELECT 1 FROM activity_events ax
            WHERE ax.tenant_id = ${tid} AND ax.event_type = 'page_view'
              ${activityCompanyFilter("ax", companyIds)}
              ${activityClientFilter("ax", clientId)}
              AND ax.contact_id = ${companyIds !== null ? sql`COALESCE(vt.contact_id, fs.contact_id)` : sql`vt.contact_id`}
              AND ${companyIds !== null ? sql`COALESCE(vt.contact_id, fs.contact_id)` : sql`vt.contact_id`} IS NOT NULL
              AND COALESCE(ax.is_bot, false) = false
              ${jid      ? sql`AND ax.journey_id=${jid}` : sql``}
              ${dateFrom ? sql`AND ax.created_at >= ${reportDayStart(dateFrom)}` : sql``}
              ${dateTo   ? sql`AND ax.created_at < ${reportDayEnd(dateTo)}` : sql``}
          )
      ) _uniq
    `);

    const formPromise = db.execute(sql`
      SELECT count(*)::int as total FROM activity_events ae
      WHERE ae.tenant_id=${tid} AND ae.event_type IN ('form_submit','form_submitted')
        ${activityCompanyFilter("ae", companyIds)}
        ${activityClientFilter("ae", clientId)}
        ${jid      ? sql`AND journey_id=${jid}` : sql``}
        ${dateFrom ? sql`AND created_at >= ${reportDayStart(dateFrom)}` : sql``}
        ${dateTo   ? sql`AND created_at < ${reportDayEnd(dateTo)}` : sql``}
    `);
    const downloadsPromise = db.execute(sql`
      SELECT count(*)::int as total FROM activity_events ae
      WHERE ae.tenant_id=${tid} AND ae.event_type='asset_download'
        ${activityCompanyFilter("ae", companyIds)}
        ${activityClientFilter("ae", clientId)}
        ${jid      ? sql`AND journey_id=${jid}` : sql``}
        ${dateFrom ? sql`AND created_at >= ${reportDayStart(dateFrom)}` : sql``}
        ${dateTo   ? sql`AND created_at < ${reportDayEnd(dateTo)}` : sql``}
    `);

    const trendPromise = db.execute(sql`
      SELECT ${reportDay(sql`created_at`)}::text AS date,
             count(*)::int AS visits,
             count(DISTINCT token)::int AS unique_visits
      FROM (
        SELECT ae.created_at, ae.contact_id::text AS token
        FROM activity_events ae
        WHERE ae.tenant_id=${tid} AND ae.event_type='page_view' AND COALESCE(ae.is_bot, false) = false
          ${activityCompanyFilter("ae", companyIds)}
          ${activityClientFilter("ae", clientId)}
          ${srcF     ? sql`AND source=${srcF}` : sql``}
          ${jid      ? sql`AND journey_id=${jid}` : sql``}
          ${dateFrom ? sql`AND created_at >= ${reportDayStart(dateFrom)}` : sql``}
          ${dateTo   ? sql`AND created_at < ${reportDayEnd(dateTo)}` : sql``}
        UNION ALL
        SELECT je.created_at, COALESCE(je.visitor_token, gen_random_uuid()::text) AS token
        FROM journey_events je
        WHERE je.tenant_id=${tid} AND je.event_type='page_view' AND COALESCE(je.is_bot, false) = false
          ${journeyCompanyFilter(companyIds)}
          ${journeyClientFilter(clientId)}
          ${jid      ? sql`AND journey_id=${jid}` : sql``}
          ${dateFrom ? sql`AND created_at >= ${reportDayStart(dateFrom)}` : sql``}
          ${dateTo   ? sql`AND created_at < ${reportDayEnd(dateTo)}` : sql``}
      ) _all
      GROUP BY 1 ORDER BY 1
    `);

    const [visitsResult, botFilteredResult, uniqueResult, formResult, downloadsResult, trendResult] =
      await Promise.all([visitsPromise, botFilteredPromise, uniquePromise, formPromise, downloadsPromise, trendPromise]);
    const [visitsRow] = rr(visitsResult);
    const [botFilteredRow] = rr(botFilteredResult);
    const [uniqueRow] = rr(uniqueResult);
    const [formRow] = rr(formResult);
    const [dlRow] = rr(downloadsResult);
    const trend = rr(trendResult);
    summary = {
      kpi: {
        visits: visitsRow?.total ?? 0,
        uniqueVisits: uniqueRow?.total ?? 0,
        formFills: formRow?.total ?? 0,
        downloads: dlRow?.total ?? 0,
        botFiltered: botFilteredRow?.total ?? 0,
      },
      trend,
    };
    if (part === "summary") {
      res.json(summary);
      return;
    }
    }

    if (part !== "summary") {
    const table = rr(await db.execute(sql`
      -- Resolve the IP-based company hint only for the 100 rows we actually return.
      -- Running its correlated lookup inside each UNION branch evaluated it for
      -- every candidate before the final ORDER BY/LIMIT on large accounts.
      WITH recent AS MATERIALIZED (
      SELECT * FROM (
        -- Identified + anonymous from activity_events (tracked page views)
        SELECT
          ae.id::text        AS id,
          ae.contact_id,
          c.first_name, c.last_name, c.email,
          co.name            AS company_name,
          co.id              AS company_id,
          ae.page_name,
          ae.source,
          COALESCE(c.stage, ae.stage) AS stage,
          ae.score_delta,
          ae.created_at,
          ae.ip_address,
          ae.duration_seconds,
          (c.id IS NULL OR COALESCE(c.is_anonymous, false) = true) AS hint_allowed
        FROM activity_events ae
        LEFT JOIN contacts  c  ON c.id  = ae.contact_id AND c.tenant_id = ae.tenant_id
        LEFT JOIN companies co ON co.id = COALESCE(
          ${verifiedActivityAccount(sql`ae.tenant_id`,sql`ae.id`)},
          ${reviewedJourneyAccount(sql`ae.tenant_id`, sql`ae.contact_id`, sql`ae.journey_id`, sql`ae.created_at`)},
          ae.company_id, c.company_id) AND co.tenant_id = ae.tenant_id
        WHERE ae.tenant_id = ${tid} AND ae.event_type = 'page_view' AND COALESCE(ae.is_bot, false) = false
          ${activityCompanyFilter("ae", companyIds)}
          ${activityClientFilter("ae", clientId)}
          ${srcF     ? sql`AND ae.source = ${srcF}`                                          : sql``}
          ${jid      ? sql`AND ae.journey_id = ${jid}`                                       : sql``}
          ${dateFrom ? sql`AND ae.created_at >= ${reportDayStart(dateFrom)}` : sql``}
          ${dateTo   ? sql`AND ae.created_at < ${reportDayEnd(dateTo)}` : sql``}

        UNION ALL

        -- Anonymous + recognised journey page views not already in activity_events
        SELECT
          ('je-' || je.id::text)                                          AS id,
          c.id                                                            AS contact_id,
          c.first_name, c.last_name, c.email,
          co.name                                                         AS company_name,
          co.id                                                           AS company_id,
          NULLIF(TRIM(COALESCE(jp.title, '')), '')                       AS page_name,
          COALESCE('journey:' || j.slug, je.event_type)                  AS source,
          COALESCE(c.stage, 'pre-aware')                                 AS stage,
          0                                                               AS score_delta,
          je.created_at,
          je.ip_address,
          NULL::int                                                       AS duration_seconds,
          (c.id IS NULL OR COALESCE(c.is_anonymous, false) = true)        AS hint_allowed
        FROM journey_events je
        LEFT JOIN journey_pages jp  ON jp.id  = je.page_id
        LEFT JOIN journeys      j   ON j.id   = je.journey_id
        LEFT JOIN visitor_tokens vt ON vt.token = je.visitor_token AND vt.tenant_id = je.tenant_id
        LEFT JOIN LATERAL (
          SELECT contact_id FROM form_submissions
          WHERE visitor_token = je.visitor_token AND tenant_id = je.tenant_id AND contact_id IS NOT NULL
          ORDER BY submitted_at DESC LIMIT 1
        ) fs ON TRUE
        LEFT JOIN contacts  c  ON c.id  = COALESCE(vt.contact_id, fs.contact_id) AND c.tenant_id = je.tenant_id
        LEFT JOIN companies co ON co.id = COALESCE(
          ${verifiedJourneyAccount(sql`je.tenant_id`,sql`je.id`)},
          ${reviewedJourneyAccount(sql`je.tenant_id`, sql`c.id`, sql`je.journey_id`, sql`je.created_at`)},
          c.company_id) AND co.tenant_id = je.tenant_id
        WHERE je.tenant_id = ${tid} AND je.event_type = 'page_view' AND COALESCE(je.is_bot, false) = false
          ${journeyCompanyFilter(companyIds)}
          ${journeyClientFilter(clientId)}
          ${jid      ? sql`AND je.journey_id = ${jid}`                                       : sql``}
          ${dateFrom ? sql`AND je.created_at >= ${reportDayStart(dateFrom)}` : sql``}
          ${dateTo   ? sql`AND je.created_at < ${reportDayEnd(dateTo)}` : sql``}
          AND NOT EXISTS (
            SELECT 1 FROM activity_events ax
            WHERE ax.tenant_id  = ${tid}
              ${activityCompanyFilter("ax", companyIds)}
              ${activityClientFilter("ax", clientId)}
              AND ax.event_type = 'page_view'
              AND ax.journey_id = je.journey_id
              AND ax.created_at > je.created_at - interval '120 seconds'
              AND ax.created_at < je.created_at + interval '120 seconds'
              AND (
                -- match by contact when visitor is identified
                (COALESCE(vt.contact_id, fs.contact_id) IS NOT NULL
                  AND ax.contact_id = COALESCE(vt.contact_id, fs.contact_id))
                OR
                -- match by visitor_token as a fallback (covers the race window before
                -- visitor_tokens is populated but after activity_events is written)
                (je.visitor_token IS NOT NULL AND ax.visitor_token = je.visitor_token)
              )
          )

        ${jid ? sql`
        UNION ALL

        -- Email engagement (click/open) events for contacts enrolled in sequences
        -- linked to this journey via play → client. Shows identified clickers even
        -- when the click-redirect was disrupted and no page_view was ever recorded.
        SELECT
          ('email-' || ae.id::text)                                  AS id,
          ae.contact_id,
          c.first_name, c.last_name, c.email,
          co.name                                                     AS company_name,
          co.id                                                       AS company_id,
          COALESCE(ae.description, ae.event_type)                    AS page_name,
          ae.source                                                   AS source,
          COALESCE(c.stage, 'aware')                                 AS stage,
          ae.score_delta,
          ae.created_at,
          ae.ip_address,
          NULL::int                                                   AS duration_seconds,
          false                                                       AS hint_allowed
        FROM activity_events ae
        LEFT JOIN contacts  c  ON c.id  = ae.contact_id AND c.tenant_id = ae.tenant_id
        LEFT JOIN companies co ON co.id = COALESCE(ae.company_id, c.company_id) AND co.tenant_id = ae.tenant_id
        WHERE ae.tenant_id = ${tid}
          ${activityCompanyFilter("ae", companyIds)}
          ${activityClientFilter("ae", clientId)}
          AND ae.event_type IN ('email_click','email_open')
          AND ae.contact_id IS NOT NULL
          AND COALESCE(ae.is_bot, false) = false
          AND (
            -- primary: contact enrolled in a sequence linked to this journey
            EXISTS (
              SELECT 1 FROM sequence_enrollments se
              JOIN email_sequences es ON es.id = se.sequence_id
              JOIN abm_plays       p  ON p.id  = es.play_id
              JOIN journeys        j  ON j.client_id = p.client_id AND j.id = ${jid}
              WHERE se.contact_id = ae.contact_id
            )
          )
          ${dateFrom ? sql`AND ae.created_at >= ${reportDayStart(dateFrom)}` : sql``}
          ${dateTo   ? sql`AND ae.created_at < ${reportDayEnd(dateTo)}` : sql``}
        ` : sql``}
      ) _t
      ORDER BY created_at DESC LIMIT 100
      )
      SELECT _t.id, _t.contact_id, _t.first_name, _t.last_name, _t.email,
             _t.company_name, _t.company_id, _t.page_name, _t.source, _t.stage,
             _t.score_delta, _t.created_at, _t.ip_address, _t.duration_seconds,
             CASE WHEN _t.hint_allowed THEN (
               SELECT co2.name
               FROM activity_events ae2
               JOIN contacts c2 ON c2.id = ae2.contact_id
               JOIN companies co2 ON co2.id = c2.company_id
               WHERE ae2.tenant_id = ${tid}
                 ${companyIdFilter(sql`c2.company_id`, companyIds)}
                 AND ae2.ip_address = _t.ip_address
                 AND _t.ip_address IS NOT NULL AND _t.ip_address <> ''
                 AND COALESCE(c2.is_anonymous, false) = false
                 AND c2.company_id IS NOT NULL
               LIMIT 1
             ) END AS company_hint
      FROM recent _t
      ORDER BY _t.created_at DESC
    `));

    // ── Identified contacts who visited (aggregated, de-duped) ────────────
    const contacts = rr(await db.execute(sql`
      SELECT
        c.id,
        c.first_name,
        c.last_name,
        c.email,
        c.lead_score,
        c.stage,
        COALESCE(co.name, c.company_name) AS company_name,
         co.id AS company_id,
        SUM(v.visit_count)::int            AS visit_count,
        MAX(v.last_seen)                   AS last_seen
      FROM (
        -- From activity_events (tracked page views, bot-filtered)
        SELECT contact_id AS cid, count(*)::int AS visit_count, max(created_at) AS last_seen
        FROM activity_events ae
        WHERE ae.tenant_id = ${tid} AND ae.event_type = 'page_view' AND ae.contact_id IS NOT NULL AND COALESCE(ae.is_bot, false) = false
          ${activityCompanyFilter("ae", companyIds)}
          ${activityClientFilter("ae", clientId)}
          ${jid      ? sql`AND journey_id = ${jid}`                                    : sql``}
          ${dateFrom ? sql`AND created_at >= ${reportDayStart(dateFrom)}` : sql``}
          ${dateTo   ? sql`AND created_at < ${reportDayEnd(dateTo)}` : sql``}
        GROUP BY contact_id

        UNION ALL

        -- From journey_events resolved via visitor_tokens (bot-filtered)
        SELECT vt.contact_id AS cid, count(*)::int AS visit_count, max(je.created_at) AS last_seen
        FROM journey_events je
        JOIN visitor_tokens vt ON vt.token = je.visitor_token AND vt.tenant_id = je.tenant_id
        WHERE je.tenant_id = ${tid} AND je.event_type = 'page_view' AND vt.contact_id IS NOT NULL AND COALESCE(je.is_bot, false) = false
          ${journeyCompanyFilter(companyIds)}
          ${journeyClientFilter(clientId)}
          ${jid      ? sql`AND je.journey_id = ${jid}`                                 : sql``}
          ${dateFrom ? sql`AND je.created_at >= ${reportDayStart(dateFrom)}` : sql``}
          ${dateTo   ? sql`AND je.created_at < ${reportDayEnd(dateTo)}` : sql``}
        GROUP BY vt.contact_id

        UNION ALL

        -- From form_submissions resolved via visitor_token (bot-filtered)
        SELECT fs.contact_id AS cid, count(*)::int AS visit_count, max(je.created_at) AS last_seen
        FROM journey_events je
        JOIN form_submissions fs ON fs.visitor_token = je.visitor_token AND fs.tenant_id = je.tenant_id
        WHERE je.tenant_id = ${tid} AND je.event_type = 'page_view' AND fs.contact_id IS NOT NULL AND COALESCE(je.is_bot, false) = false
          ${journeyCompanyFilter(companyIds)}
          ${journeyClientFilter(clientId)}
          ${jid      ? sql`AND je.journey_id = ${jid}`                                 : sql``}
          ${dateFrom ? sql`AND je.created_at >= ${reportDayStart(dateFrom)}` : sql``}
          ${dateTo   ? sql`AND je.created_at < ${reportDayEnd(dateTo)}` : sql``}
        GROUP BY fs.contact_id

        UNION ALL

        -- Contacts who clicked/opened sequence emails linked to this journey via play → client.
        -- This surfaces contacts enrolled in the campaign even when the click-redirect was
        -- disrupted and no page_view activity_event was written for them.
        SELECT ae.contact_id AS cid, count(*)::int AS visit_count, max(ae.created_at) AS last_seen
        FROM activity_events ae
        WHERE ae.tenant_id = ${tid}
          ${activityCompanyFilter("ae", companyIds)}
          ${activityClientFilter("ae", clientId)}
          AND ae.event_type IN ('email_click','email_open')
          AND ae.contact_id IS NOT NULL
          AND COALESCE(ae.is_bot, false) = false
          ${jid ? sql`AND (
            EXISTS (
              SELECT 1 FROM sequence_enrollments se
              JOIN email_sequences es ON es.id = se.sequence_id
              JOIN abm_plays       p  ON p.id  = es.play_id
              JOIN journeys        j  ON j.client_id = p.client_id AND j.id = ${jid}
              WHERE se.contact_id = ae.contact_id
            )
            OR EXISTS (
              SELECT 1 FROM contacts cx
              JOIN journeys j2 ON j2.id = ${jid} AND j2.client_id IS NOT NULL
                               AND j2.client_id = cx.client_id
              WHERE cx.id = ae.contact_id
            )
          )` : sql``}
          ${dateFrom ? sql`AND ae.created_at >= ${reportDayStart(dateFrom)}` : sql``}
          ${dateTo   ? sql`AND ae.created_at < ${reportDayEnd(dateTo)}` : sql``}
        GROUP BY ae.contact_id
      ) v
      JOIN contacts  c  ON c.id = v.cid AND c.tenant_id = ${tid}
       LEFT JOIN companies co ON co.id = c.company_id AND co.tenant_id = c.tenant_id
       GROUP BY c.id, c.first_name, c.last_name, c.email, c.lead_score, c.stage, co.name, co.id, c.company_name
      ORDER BY c.lead_score DESC NULLS LAST, MAX(v.last_seen) DESC
      LIMIT 200
    `));

    if (part === "details") {
      res.json({ table, contacts });
    } else {
      res.json({ kpi: summary!.kpi, trend: summary!.trend, table, contacts });
    }
    }
  } catch (err) { next(err); }
});

// ── Stage Distribution ────────────────────────────────────────────────────────
router.get("/analytics/stage-distribution", async (req, res, next): Promise<void> => {
  try {
    const user = req.user as any;
    const tid = user.tenantId;
    const { clientId, scoreMin, scoreMax, dateFrom, dateTo, journeyId } = req.query as Record<string, string | undefined>;
    const jid = journeyId ? Number(journeyId) : null;
    const accountSelection = await getTenantCompanySelection(req.query as Record<string, unknown>, tid);
    if (accountSelection.error) {
      res.status(400).json({ error: accountSelection.error });
      return;
    }
    const companyIds = accountSelection.companyIds;

    const rows: any[] = (await db.execute(sql`
      SELECT stage, count(*)::int as count FROM contacts
      WHERE tenant_id=${tid}
        ${companyIdFilter(sql`company_id`, companyIds)}
        ${clientId  ? sql`AND client_id=${Number(clientId)}`   : sql``}
        ${scoreMin  ? sql`AND lead_score>=${Number(scoreMin)}`  : sql``}
        ${scoreMax  ? sql`AND lead_score<=${Number(scoreMax)}`  : sql``}
        ${jid ? sql`AND EXISTS (SELECT 1 FROM activity_events x WHERE x.contact_id=contacts.id AND x.journey_id=${jid})` : sql``}
        ${(dateFrom || dateTo) ? sql`AND EXISTS (
          SELECT 1 FROM activity_events _ae
          WHERE _ae.contact_id = contacts.id
            ${dateFrom ? sql`AND _ae.created_at >= ${reportDayStart(dateFrom)}` : sql``}
            ${dateTo   ? sql`AND _ae.created_at < ${reportDayEnd(dateTo)}` : sql``}
        )` : sql``}
      GROUP BY stage ORDER BY stage
    `)).rows as any[];

    const total = rows.reduce((s: number, r: any) => s + r.count, 0);
    const data  = rows.map((r: any) => ({ stage: r.stage, count: r.count, pct: total > 0 ? Math.round((r.count / total) * 10000) / 100 : 0 }));
    res.json({ data, total });
  } catch (err) { next(err); }
});

// ── Content Popularity ────────────────────────────────────────────────────────
router.get("/analytics/content-popularity", async (req, res, next): Promise<void> => {
  try {
    const user = req.user as any;
    const tid = user.tenantId;
    const { stage, dateFrom, dateTo, journeyId } = req.query as Record<string, string | undefined>;
    const jid = journeyId ? Number(journeyId) : null;
    const accountSelection = await getTenantCompanySelection(req.query as Record<string, unknown>, tid);
    if (accountSelection.error) {
      res.status(400).json({ error: accountSelection.error });
      return;
    }
    const companyIds = accountSelection.companyIds;

    const rr = (x: any) => x.rows as any[];
    const byPage = rr(await db.execute(sql`
      SELECT page_name, count(*)::int as views, count(DISTINCT contact_id)::int as unique_visitors
      FROM activity_events ae
      WHERE tenant_id=${tid} AND event_type='page_view' AND page_name IS NOT NULL
        ${activityCompanyFilter("ae", companyIds)}
        ${stage   ? sql`AND stage=${stage}`                           : sql``}
        ${jid     ? sql`AND journey_id=${jid}`                        : sql``}
        ${dateFrom? sql`AND created_at >= ${reportDayStart(dateFrom)}` : sql``}
        ${dateTo  ? sql`AND created_at < ${reportDayEnd(dateTo)}` : sql``}
      GROUP BY page_name ORDER BY views DESC LIMIT 20
    `));

    const byStage = rr(await db.execute(sql`
      SELECT stage, page_name, count(*)::int as views
      FROM activity_events ae
      WHERE tenant_id=${tid} AND event_type='page_view' AND page_name IS NOT NULL AND stage IS NOT NULL
        ${activityCompanyFilter("ae", companyIds)}
        ${jid     ? sql`AND journey_id=${jid}`                        : sql``}
        ${dateFrom? sql`AND created_at >= ${reportDayStart(dateFrom)}` : sql``}
        ${dateTo  ? sql`AND created_at < ${reportDayEnd(dateTo)}` : sql``}
      GROUP BY stage, page_name ORDER BY stage, views DESC
    `));

    res.json({ byPage, byStage });
  } catch (err) { next(err); }
});

// ── Traffic Source ────────────────────────────────────────────────────────────
// Normalise raw source values → friendly channel labels
function normaliseSource(raw: string | null | undefined): string {
  if (!raw) return "Direct";
  const s = raw.toLowerCase();
  if (s === "email" || s.startsWith("email")) return "Email";
  if (s.includes("linkedin")) return "LinkedIn";
  if (s.includes("google") || s.includes("organic")) return "Google Search";
  if (s.includes("facebook") || s.includes("instagram") || s.includes("meta")) return "Meta";
  if (s.includes("twitter") || s.includes("x.com")) return "X / Twitter";
  if (s === "direct") return "Direct";
  if (s === "public" || s.startsWith("journey:")) return "Journey Link";
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

router.get("/analytics/traffic-source", async (req, res, next): Promise<void> => {
  try {
    const user = req.user as any;
    const tid = user.tenantId;
    const { dateFrom, dateTo, stage, journeyId } = req.query as Record<string, string | undefined>;
    const jid = journeyId ? Number(journeyId) : null;
    const accountSelection = await getTenantCompanySelection(req.query as Record<string, unknown>, tid);
    if (accountSelection.error) {
      res.status(400).json({ error: accountSelection.error });
      return;
    }
    const companyIds = accountSelection.companyIds;

    // identified + source-tagged events from activity_events
    const aeRows: any[] = (await db.execute(sql`
      SELECT ae.source, count(*)::int as count FROM activity_events ae
      WHERE ae.tenant_id=${tid} AND ae.event_type='page_view'
        ${activityCompanyFilter("ae", companyIds)}
        ${stage   ? sql`AND stage=${stage}` : sql``}
        ${jid     ? sql`AND journey_id=${jid}` : sql``}
        ${dateFrom? sql`AND created_at >= ${reportDayStart(dateFrom)}` : sql``}
        ${dateTo  ? sql`AND created_at < ${reportDayEnd(dateTo)}` : sql``}
      GROUP BY source ORDER BY count DESC
    `)).rows as any[];

    // anonymous journey_events not already captured in activity_events
    const [jeRow] = (await db.execute(sql`
      SELECT count(*)::int as count FROM journey_events je
      WHERE je.tenant_id = ${tid} AND je.event_type = 'page_view'
        ${journeyCompanyFilter(companyIds)}
        ${jid      ? sql`AND je.journey_id = ${jid}` : sql``}
        ${dateFrom ? sql`AND je.created_at >= ${reportDayStart(dateFrom)}` : sql``}
        ${dateTo   ? sql`AND je.created_at < ${reportDayEnd(dateTo)}` : sql``}
        AND NOT EXISTS (
          SELECT 1 FROM activity_events ax
          WHERE ax.tenant_id = ${tid}
            ${activityCompanyFilter("ax", companyIds)}
            AND ax.event_type = 'page_view'
            AND ax.journey_id = je.journey_id
            AND ABS(EXTRACT(EPOCH FROM (ax.created_at - je.created_at))) < 120
        )
    `)).rows as any[];

    // Aggregate by normalised channel
    const channelMap: Record<string, number> = {};
    for (const r of aeRows) {
      const label = normaliseSource(r.source);
      channelMap[label] = (channelMap[label] ?? 0) + Number(r.count);
    }
    // anonymous journey traffic → Direct
    if ((jeRow?.count ?? 0) > 0) {
      channelMap["Direct"] = (channelMap["Direct"] ?? 0) + Number(jeRow.count);
    }

    const entries = Object.entries(channelMap).sort((a, b) => b[1] - a[1]);
    const total = entries.reduce((s, [, c]) => s + c, 0);
    const data = entries.map(([source, count]) => ({
      source,
      count,
      pct: total > 0 ? Math.round((count / total) * 10000) / 100 : 0,
    }));

    res.json({ data, total });
  } catch (err) { next(err); }
});

// ── Users by Stage ────────────────────────────────────────────────────────────
router.get("/analytics/users-by-stage", async (req, res, next): Promise<void> => {
  try {
    const user = req.user as any;
    const tid = user.tenantId;
    const { clientId, playId, scoreMin, scoreMax, dateFrom, dateTo, journeyId } = req.query as Record<string, string | undefined>;
    const jid = journeyId ? Number(journeyId) : null;
    const accountSelection = await getTenantCompanySelection(req.query as Record<string, unknown>, tid);
    if (accountSelection.error) {
      res.status(400).json({ error: accountSelection.error });
      return;
    }
    const companyIds = accountSelection.companyIds;

    const STAGE_ORDER = ['pre-aware','aware','pre-engage','engage','advance-engage','action'];
    const rows: any[] = (await db.execute(sql`
      SELECT stage, count(*)::int as count FROM contacts
      WHERE tenant_id=${tid}
        ${companyIdFilter(sql`company_id`, companyIds)}
        ${clientId  ? sql`AND (client_id=${Number(clientId)} OR EXISTS
          (SELECT 1 FROM companies co WHERE co.id=contacts.company_id
            AND co.tenant_id=${tid} AND co.client_id=${Number(clientId)}))` : sql``}
        ${playId    ? sql`AND client_id=(SELECT client_id FROM abm_plays WHERE id=${Number(playId)})` : sql``}
        ${scoreMin  ? sql`AND lead_score>=${Number(scoreMin)}`  : sql``}
        ${scoreMax  ? sql`AND lead_score<=${Number(scoreMax)}`  : sql``}
        ${jid ? sql`AND EXISTS (SELECT 1 FROM activity_events x WHERE x.contact_id=contacts.id AND x.journey_id=${jid})` : sql``}
        ${(dateFrom || dateTo) ? sql`AND EXISTS (
          SELECT 1 FROM activity_events _ae
          WHERE _ae.contact_id = contacts.id
            ${dateFrom ? sql`AND _ae.created_at >= ${reportDayStart(dateFrom)}` : sql``}
            ${dateTo   ? sql`AND _ae.created_at < ${reportDayEnd(dateTo)}` : sql``}
        )` : sql``}
      GROUP BY stage
    `)).rows as any[];

    const map  = Object.fromEntries(rows.map((r: any) => [r.stage, r.count]));
    const data = STAGE_ORDER.map(s => ({ stage: s, count: map[s] ?? 0 }));
    res.json(data);
  } catch (err) { next(err); }
});

// ── Contacts Drill-Down ────────────────────────────────────────────────────────
router.get("/analytics/contacts-drill", async (req, res, next): Promise<void> => {
  try {
    const user = req.user as any;
    const tid = user.tenantId;
    const { clientId, playId, journeyId, scoreMin, scoreMax, dateFrom, dateTo, source, pageName, eventType } = req.query as Record<string, string | undefined>;
    // Stage: support single ("stage") and multi ("stages" comma-sep)
    const drillStages: string[] = req.query.stages
      ? String(req.query.stages).split(",").filter(Boolean)
      : req.query.stage ? [String(req.query.stage)] : [];
    // Company: support single ("companyId") and multi ("companyIds" comma-sep)
    const accountSelection = await getTenantCompanySelection(req.query as Record<string, unknown>, tid);
    if (accountSelection.error) {
      res.status(400).json({ error: accountSelection.error });
      return;
    }
    const drillCompanyIds = accountSelection.companyIds;

    const rows: any[] = (await db.execute(sql`
      SELECT c.id, c.first_name, c.last_name, c.email, c.lead_score, c.stage,
             c.last_activity, co.name as company_name, co.id as company_id,
             c.intent_score, c.intent_state, c.suggested_next_action,
             c.freq_score, c.max_stage_score, c.engagement_score,
             count(DISTINCT ae.id)::int as activity_count
      FROM contacts c
      LEFT JOIN companies co ON co.id = c.company_id
      LEFT JOIN activity_events ae ON ae.contact_id = c.id AND ae.tenant_id = c.tenant_id
      WHERE c.tenant_id = ${tid}
        ${drillStages.length > 0 ? sql`AND c.stage IN (${sql.join(drillStages.map(s => sql`${s}`), sql`, `)})` : sql``}
        ${companyIdFilter(sql`c.company_id`, drillCompanyIds)}
        ${clientId  ? sql`AND (c.client_id = ${Number(clientId)} OR
          (co.tenant_id=${tid} AND co.client_id=${Number(clientId)}))` : sql``}
        ${playId    ? sql`AND c.client_id = (SELECT client_id FROM abm_plays WHERE id=${Number(playId)})` : sql``}
        ${scoreMin  ? sql`AND c.lead_score >= ${Number(scoreMin)}`    : sql``}
        ${scoreMax  ? sql`AND c.lead_score <= ${Number(scoreMax)}`    : sql``}
        ${(dateFrom || dateTo) ? sql`AND EXISTS (
          SELECT 1 FROM activity_events ax WHERE ax.contact_id = c.id
          ${dateFrom ? sql`AND ax.created_at >= ${reportDayStart(dateFrom)}` : sql``}
          ${dateTo   ? sql`AND ax.created_at < ${reportDayEnd(dateTo)}` : sql``}
        )` : sql``}
        ${source    ? sql`AND EXISTS (
          SELECT 1 FROM activity_events x WHERE x.contact_id=c.id AND (
            x.source = ${source}
            OR CASE
              WHEN ${source} = 'Email'         THEN lower(x.source) = 'email' OR x.source ILIKE 'email%'
              WHEN ${source} = 'Direct'        THEN x.source IS NULL OR x.source = 'direct'
              WHEN ${source} = 'LinkedIn'      THEN x.source ILIKE '%linkedin%'
              WHEN ${source} = 'Google Search' THEN x.source ILIKE '%google%' OR x.source ILIKE '%organic%'
              WHEN ${source} = 'Meta'          THEN x.source ILIKE '%facebook%' OR x.source ILIKE '%meta%' OR x.source ILIKE '%instagram%'
              WHEN ${source} = 'X / Twitter'   THEN x.source ILIKE '%twitter%' OR x.source ILIKE '%x.com%'
              WHEN ${source} = 'Journey Link'  THEN x.source = 'public' OR x.source ILIKE 'journey:%'
              ELSE FALSE END
          ))` : sql``}
        ${pageName  ? sql`AND (
          EXISTS (SELECT 1 FROM activity_events x WHERE x.contact_id=c.id AND x.page_name=${pageName})
          OR EXISTS (
            SELECT 1 FROM journey_events je
            JOIN journey_pages jp ON jp.id=je.page_id AND jp.title=${pageName}
            LEFT JOIN visitor_tokens vt ON vt.token=je.visitor_token AND vt.tenant_id=je.tenant_id
            LEFT JOIN LATERAL (
              SELECT contact_id FROM form_submissions
              WHERE visitor_token=je.visitor_token AND tenant_id=je.tenant_id AND contact_id IS NOT NULL
              ORDER BY submitted_at DESC LIMIT 1
            ) fs ON TRUE
            WHERE COALESCE(vt.contact_id, fs.contact_id) = c.id
          ))` : sql``}
        ${eventType ? sql`AND EXISTS (SELECT 1 FROM activity_events x WHERE x.contact_id=c.id AND x.event_type=${eventType})`   : sql``}
        ${journeyId ? sql`AND EXISTS (SELECT 1 FROM activity_events x WHERE x.contact_id=c.id AND x.journey_id=${Number(journeyId)})` : sql``}
      GROUP BY c.id, co.name, co.id
      ORDER BY c.lead_score DESC
      LIMIT 100
    `)).rows as any[];

    res.json(rows);
  } catch (err) { next(err); }
});

// ── ABM Data (visitor log) ────────────────────────────────────────────────────
router.get("/analytics/abm-data", async (req, res, next): Promise<void> => {
  try {
    const user = req.user as any;
    const tid = user.tenantId;
    const exportAll = req.query.export === "true";
    const visitorTokenFilter = req.query.visitorToken ? String(req.query.visitorToken) : null;
    const pageRaw = Number(req.query.page ?? 1);
    if (!Number.isSafeInteger(pageRaw) || pageRaw < 1 || pageRaw > 100_000) {
      res.status(400).json({ error: "page must be a positive integer" });
      return;
    }
    const page = pageRaw;
    const limit = exportAll ? 10000 : visitorTokenFilter ? 200 : 30;
    // Fetch one extra event to determine whether a next page exists without
    // running the expensive whole-history count on every paged visit.
    const queryLimit = exportAll ? limit : limit + 1;
    const offset = exportAll ? 0 : (page - 1) * limit;
    const journeyId = req.query.journeyId ? Number(req.query.journeyId) : null;
    const dateFrom  = req.query.dateFrom ? String(req.query.dateFrom) : null;
    const dateTo    = req.query.dateTo   ? String(req.query.dateTo)   : null;
    const clientId  = req.query.clientId ? Number(req.query.clientId) : null;
    const scoreMin  = req.query.scoreMin  ? parseInt(String(req.query.scoreMin))  : null;
    const scoreMax  = req.query.scoreMax  ? parseInt(String(req.query.scoreMax))  : null;
    // Stage: support single ("stage") and multi ("stages" comma-sep)
    const stagesArr: string[] = req.query.stages
      ? String(req.query.stages).split(",").filter(Boolean)
      : req.query.stage ? [String(req.query.stage)] : [];
    // Company: support single ("companyId") and multi ("companyIds" comma-sep)
    const accountSelection = await getTenantCompanySelection(req.query as Record<string, unknown>, tid);
    if (accountSelection.error) {
      res.status(400).json({ error: accountSelection.error });
      return;
    }
    const companyIdsArr = accountSelection.companyIds;
    // Single-visitor lookup: when set, all other filters are bypassed so we
    // see the visitor's full lifetime history regardless of journey/date scope.

    const rows = (await db.execute(sql`
      SELECT * FROM (
        -- Identified-contact events from activity_events
        SELECT
          ae.id::text        AS id,
          COALESCE(
            NULLIF(TRIM(COALESCE(ae.page_name, '')), ''),
            -- For email events, use the stored description ("Email opened" / "Email link clicked")
            -- since they are not tied to a journey page.
            CASE WHEN ae.event_type IN ('email_open','email_click') THEN ae.description ELSE NULL END,
            (SELECT NULLIF(TRIM(jp2.title), '')
             FROM journey_events je2
             JOIN journey_pages jp2 ON jp2.id = je2.page_id
             WHERE je2.journey_id = ae.journey_id
               AND je2.tenant_id  = ae.tenant_id
               AND ABS(EXTRACT(EPOCH FROM (je2.created_at - ae.created_at))) < 180
             ORDER BY ABS(EXTRACT(EPOCH FROM (je2.created_at - ae.created_at)))
             LIMIT 1)
          ) AS page_name,
          ae.event_type,
          ae.score_delta     AS score,
          ae.duration_seconds,
          ae.created_at      AS visit_date,
          NULLIF(TRIM(COALESCE(c.first_name, '')), '') AS first_name,
          NULLIF(TRIM(COALESCE(c.last_name,  '')), '') AS last_name,
          NULLIF(TRIM(COALESCE(c.email,      '')), '') AS email,
          NULLIF(TRIM(COALESCE(c.title, c.designation, '')), '') AS designation,
          -- Contact's CURRENT lead_score (the authoritative total stored on the contact).
          -- Previously a running SUM(score_delta) up to each event's timestamp, which
          -- diverged from lead_score whenever later events (e.g. a second sequence run
          -- later the same day) pushed the stored score higher than this filtered event's
          -- running total — causing the visible mismatch with the contact card "Score".
          COALESCE(c.lead_score, 0) AS total_score,
          -- Time on site scoped to the active date filter (blank when no filter is set, shows all-time).
          COALESCE((
            SELECT SUM(ae2.duration_seconds)::int
            FROM activity_events ae2
            WHERE ae2.tenant_id  = ae.tenant_id
              AND ae2.contact_id = ae.contact_id
              AND COALESCE(ae2.is_bot, false) = false
              ${dateFrom ? sql`AND ae2.created_at >= ${reportDayStart(dateFrom)}` : sql``}
              ${dateTo   ? sql`AND ae2.created_at < ${reportDayEnd(dateTo)}` : sql``}
          ), 0) AS period_time_seconds,
          -- Total time on site across ALL events for this contact (lifetime, unfiltered).
          COALESCE((
            SELECT SUM(ae2.duration_seconds)::int
            FROM activity_events ae2
            WHERE ae2.tenant_id  = ae.tenant_id
              AND ae2.contact_id = ae.contact_id
              AND COALESCE(ae2.is_bot, false) = false
          ), 0) AS total_time_seconds,
          COALESCE(c.stage, ae.stage, 'pre-aware') AS user_stage,
          c.tags             AS contact_tags,
          NULLIF(TRIM(COALESCE(co.name, '')), '') AS company_name,
          co.id AS company_id,
          NULLIF(TRIM(COALESCE(j.name,  '')), '') AS journey_name,
          CASE WHEN c.id IS NOT NULL AND COALESCE(c.is_anonymous, false) = false THEN 'known' ELSE 'anonymous' END AS user_type,
          c.id AS contact_id,
          NULL::text AS visitor_token,
          ae.page_url,
          NULL::text AS cta_url,
          CASE WHEN c.id IS NULL OR COALESCE(c.is_anonymous, false) = true THEN (
            SELECT co2.name
            FROM activity_events ae2
            JOIN contacts   c2  ON c2.id  = ae2.contact_id
            JOIN companies  co2 ON co2.id = c2.company_id
            WHERE ae2.tenant_id = ${tid}
              ${companyIdFilter(sql`c2.company_id`, companyIdsArr)}
              AND ae2.ip_address = ae.ip_address
              AND ae.ip_address IS NOT NULL AND ae.ip_address <> ''
              AND COALESCE(c2.is_anonymous, false) = false
              AND c2.company_id IS NOT NULL
            LIMIT 1
          ) END AS company_hint
        FROM activity_events ae
        LEFT JOIN contacts  c   ON c.id  = ae.contact_id AND c.tenant_id = ae.tenant_id
         LEFT JOIN companies co  ON co.id = COALESCE(
           ${verifiedActivityAccount(sql`ae.tenant_id`,sql`ae.id`)},
           ${reviewedJourneyAccount(sql`ae.tenant_id`, sql`ae.contact_id`, sql`ae.journey_id`, sql`ae.created_at`)},
           ae.company_id, c.company_id) AND co.tenant_id = ae.tenant_id
        LEFT JOIN journeys  j   ON j.id  = ae.journey_id
        WHERE ae.tenant_id = ${tid}
          ${activityCompanyFilter("ae", companyIdsArr)}
          AND COALESCE(ae.is_bot, false) = false
          AND ae.event_type IN (
            'page_view','form_submit','asset_download','banner_click','scroll_depth','form_submitted',
            'email_open','email_click','call_completed'
          )
          -- Email events have no journey_id/client_id (they come from sequences, not journey pages).
          -- Fall back (in priority order):
          --   1. journey_contacts membership (explicit list)
          --   2. sequence enrollment linked to this journey via play → client
          --   3. contact's client_id matches the journey's client_id (broadest safe fallback)
          ${journeyId ? sql`AND (
            ae.journey_id = ${journeyId}
            OR (ae.event_type IN ('email_open','email_click')
                AND EXISTS (
                  SELECT 1 FROM journey_contacts jc
                  WHERE jc.journey_id = ${journeyId} AND jc.contact_id = ae.contact_id
                ))
            OR (ae.event_type IN ('email_open','email_click')
                AND EXISTS (
                  SELECT 1 FROM sequence_enrollments se
                  JOIN email_sequences es ON es.id = se.sequence_id
                  JOIN abm_plays       p  ON p.id  = es.play_id
                  JOIN journeys        j  ON j.client_id = p.client_id AND j.id = ${journeyId}
                  WHERE se.contact_id = ae.contact_id
                ))
            OR (ae.event_type IN ('email_open','email_click')
                AND ae.contact_id IS NOT NULL
                AND EXISTS (
                  SELECT 1 FROM contacts cx
                  JOIN journeys j2 ON j2.id = ${journeyId} AND j2.client_id IS NOT NULL
                                   AND j2.client_id = cx.client_id
                  WHERE cx.id = ae.contact_id
                ))
            -- Fallback 4: email event's own client_id OR contact's client_id matches
            -- the journey's client_id. Covers HP contacts imported from Resend who
            -- have ae.client_id set but no journey_contacts or sequence_enrollment.
            OR (ae.event_type IN ('email_open','email_click')
                AND EXISTS (
                  SELECT 1 FROM journeys jf
                  WHERE jf.id = ${journeyId}
                    AND jf.client_id IS NOT NULL
                    AND (jf.client_id = ae.client_id OR jf.client_id = c.client_id)
                ))
          )` : sql``}
           ${clientId  ? sql`AND (j.client_id = ${clientId} OR ae.client_id = ${clientId}
             OR (ae.event_type IN ('email_open','email_click') AND c.client_id = ${clientId}))` : sql``}
          -- Stage filter: for email events ae.stage is captured at send time (pre-aware),
          -- so only check c.stage (current contact stage) for email event types.
          ${stagesArr.length > 0 ? sql`AND (
            CASE WHEN ae.event_type IN ('email_open','email_click')
              THEN LOWER(COALESCE(c.stage,'pre-aware')) IN (${sql.join(stagesArr.map(s => sql`LOWER(${s})`), sql`, `)})
              ELSE LOWER(COALESCE(ae.stage,''))         IN (${sql.join(stagesArr.map(s => sql`LOWER(${s})`), sql`, `)})
                OR LOWER(COALESCE(c.stage,''))          IN (${sql.join(stagesArr.map(s => sql`LOWER(${s})`), sql`, `)})
            END
          )` : sql``}
          ${!visitorTokenFilter && dateFrom  ? sql`AND ae.created_at >= ${reportDayStart(dateFrom)}` : sql``}
          ${!visitorTokenFilter && dateTo    ? sql`AND ae.created_at < ${reportDayEnd(dateTo)}` : sql``}
          ${visitorTokenFilter ? sql`AND ae.visitor_token = ${visitorTokenFilter}` : sql``}

        UNION ALL

        -- Anonymous + identified page views from journey_events (not already in activity_events)
        SELECT
          ('je-' || je.id::text)                        AS id,
          NULLIF(TRIM(COALESCE(jp.title, '')), '')       AS page_name,
          je.event_type,
          0                                              AS score,
          NULL::int                                      AS duration_seconds,
          je.created_at                                  AS visit_date,
          NULLIF(TRIM(COALESCE(c.first_name, '')), '')   AS first_name,
          NULLIF(TRIM(COALESCE(c.last_name,  '')), '')   AS last_name,
          NULLIF(TRIM(COALESCE(c.email,      '')), '')   AS email,
          NULLIF(TRIM(COALESCE(c.title, c.designation, '')), '')   AS designation,
          -- Contact's CURRENT lead_score — same value the card shows.
          -- The old running-sum subquery (SUM score_delta up to this event's timestamp)
          -- diverged from lead_score whenever later events pushed the stored total higher,
          -- creating the visible mismatch between table and card.
          COALESCE(c.lead_score, 0)                      AS total_score,
          COALESCE((
            SELECT SUM(ae2.duration_seconds)::int
            FROM activity_events ae2
            WHERE ae2.tenant_id  = je.tenant_id
              AND ae2.contact_id = c.id
              AND c.id IS NOT NULL
              AND COALESCE(ae2.is_bot, false) = false
              ${dateFrom ? sql`AND ae2.created_at >= ${reportDayStart(dateFrom)}` : sql``}
              ${dateTo   ? sql`AND ae2.created_at < ${reportDayEnd(dateTo)}` : sql``}
          ), 0)                                          AS period_time_seconds,
          COALESCE((
            SELECT SUM(ae2.duration_seconds)::int
            FROM activity_events ae2
            WHERE ae2.tenant_id  = je.tenant_id
              AND ae2.contact_id = c.id
              AND c.id IS NOT NULL
              AND COALESCE(ae2.is_bot, false) = false
          ), 0)                                          AS total_time_seconds,
          COALESCE(c.stage, 'pre-aware')                 AS user_stage,
          c.tags                                         AS contact_tags,
          NULLIF(TRIM(COALESCE(co.name, '')), '')        AS company_name,
          co.id                                          AS company_id,
          NULLIF(TRIM(COALESCE(j.name,  '')), '')        AS journey_name,
          CASE WHEN c.id IS NOT NULL AND COALESCE(c.is_anonymous, false) = false THEN 'known' ELSE 'anonymous' END AS user_type,
          COALESCE(vt.contact_id, fs.contact_id) AS contact_id,
          je.visitor_token,
          je.page_url,
          je.cta_url,
          CASE WHEN c.id IS NULL OR COALESCE(c.is_anonymous, false) = true THEN (
            SELECT co2.name
            FROM activity_events ae2
            JOIN contacts   c2  ON c2.id  = ae2.contact_id
            JOIN companies  co2 ON co2.id = c2.company_id
            WHERE ae2.tenant_id = ${tid}
              ${companyIdFilter(sql`c2.company_id`, companyIdsArr)}
              AND ae2.ip_address = je.ip_address
              AND je.ip_address IS NOT NULL AND je.ip_address <> ''
              AND COALESCE(c2.is_anonymous, false) = false
              AND c2.company_id IS NOT NULL
            LIMIT 1
          ) END AS company_hint
        FROM journey_events je
        LEFT JOIN journey_pages jp  ON jp.id  = je.page_id
        LEFT JOIN journeys j        ON j.id   = je.journey_id
        LEFT JOIN visitor_tokens vt ON vt.token = je.visitor_token AND vt.tenant_id = je.tenant_id
        LEFT JOIN LATERAL (
          SELECT contact_id FROM form_submissions
          WHERE visitor_token = je.visitor_token AND tenant_id = je.tenant_id AND contact_id IS NOT NULL
          ORDER BY submitted_at DESC LIMIT 1
        ) fs ON TRUE
        LEFT JOIN contacts c        ON c.id   = COALESCE(vt.contact_id, fs.contact_id) AND c.tenant_id = je.tenant_id
         LEFT JOIN companies co      ON co.id  = COALESCE(
           ${verifiedJourneyAccount(sql`je.tenant_id`,sql`je.id`)},
           ${reviewedJourneyAccount(sql`je.tenant_id`, sql`c.id`, sql`je.journey_id`, sql`je.created_at`)},
           c.company_id) AND co.tenant_id = je.tenant_id
        WHERE je.tenant_id = ${tid}
          AND je.event_type IN ('page_view','cta_click','banner_dismiss')
          ${journeyCompanyFilter(companyIdsArr)}
          ${journeyId ? sql`AND je.journey_id = ${journeyId}` : sql``}
           ${clientId  ? sql`AND j.client_id = ${clientId}` : sql``}
          ${stagesArr.length > 0 ? sql`AND LOWER(COALESCE(c.stage,'pre-aware')) IN (${sql.join(stagesArr.map(s => sql`LOWER(${s})`), sql`, `)})` : sql``}
          ${!visitorTokenFilter && dateFrom  ? sql`AND je.created_at >= ${reportDayStart(dateFrom)}` : sql``}
          ${!visitorTokenFilter && dateTo    ? sql`AND je.created_at < ${reportDayEnd(dateTo)}` : sql``}
          ${visitorTokenFilter ? sql`AND je.visitor_token = ${visitorTokenFilter}` : sql``}
          AND NOT EXISTS (
            SELECT 1 FROM activity_events ae2
            WHERE ae2.tenant_id  = ${tid}
              ${activityCompanyFilter("ae2", companyIdsArr)}
              AND ae2.contact_id = COALESCE(vt.contact_id, fs.contact_id)
              AND ae2.event_type = 'page_view'
              AND ae2.journey_id = je.journey_id
              -- Bug fix: match the specific page, not just any page in the journey.
              -- Without this, browsing page B within 120 s of page A incorrectly
              -- suppressed page B's journey_event even though a separate activity_event
              -- for page B exists.
              AND ae2.page_name  = NULLIF(TRIM(COALESCE(jp.title, '')), '')
              AND ABS(EXTRACT(EPOCH FROM (ae2.created_at - je.created_at))) < 120
          )
      ) _combined
      WHERE TRUE
        ${scoreMin !== null ? sql`AND total_score >= ${scoreMin}` : sql``}
        ${scoreMax !== null ? sql`AND total_score <= ${scoreMax}` : sql``}
      ORDER BY visit_date DESC
      LIMIT ${queryLimit} OFFSET ${offset}
    `)).rows;

    const countRes = req.query.includeTotal === "true" ? (await db.execute(sql`
      SELECT (
        -- Non-email activity events (have explicit journey_id)
        SELECT COUNT(*)::int FROM activity_events ae
        LEFT JOIN contacts c ON c.id = ae.contact_id
        WHERE ae.tenant_id = ${tid}
          ${activityCompanyFilter("ae", companyIdsArr)}
          AND ae.event_type IN ('page_view','form_submit','asset_download','banner_click','scroll_depth','form_submitted')
          ${journeyId ? sql`AND ae.journey_id = ${journeyId}` : sql``}
          ${clientId  ? sql`AND ae.client_id  = ${clientId}`  : sql``}
          ${stagesArr.length > 0 ? sql`AND (LOWER(COALESCE(ae.stage,'')) IN (${sql.join(stagesArr.map(s => sql`LOWER(${s})`), sql`, `)}) OR LOWER(COALESCE(c.stage,'')) IN (${sql.join(stagesArr.map(s => sql`LOWER(${s})`), sql`, `)}))` : sql``}
          ${scoreMin !== null ? sql`AND COALESCE(c.lead_score, 0) >= ${scoreMin}` : sql``}
          ${scoreMax !== null ? sql`AND COALESCE(c.lead_score, 0) <= ${scoreMax}` : sql``}
          ${dateFrom  ? sql`AND ae.created_at >= ${reportDayStart(dateFrom)}` : sql``}
          ${dateTo    ? sql`AND ae.created_at < ${reportDayEnd(dateTo)}` : sql``}
      ) + (
        -- Email events — linked via journey_contacts OR sequence enrollment → play → client
        -- OR contact's client_id matches journey's client_id (broadest safe fallback)
        SELECT COUNT(*)::int FROM activity_events ae
        LEFT JOIN contacts c ON c.id = ae.contact_id
        WHERE ae.tenant_id = ${tid}
          ${activityCompanyFilter("ae", companyIdsArr)}
          AND ae.event_type IN ('email_open','email_click','call_completed')
          ${journeyId ? sql`AND (
            EXISTS (SELECT 1 FROM journey_contacts jc WHERE jc.journey_id = ${journeyId} AND jc.contact_id = ae.contact_id)
            OR EXISTS (
              SELECT 1 FROM sequence_enrollments se
              JOIN email_sequences es ON es.id = se.sequence_id
              JOIN abm_plays       p  ON p.id  = es.play_id
              JOIN journeys        j  ON j.client_id = p.client_id AND j.id = ${journeyId}
              WHERE se.contact_id = ae.contact_id
            )
            OR (ae.contact_id IS NOT NULL AND EXISTS (
              SELECT 1 FROM contacts cx
              JOIN journeys j2 ON j2.id = ${journeyId} AND j2.client_id IS NOT NULL
                               AND j2.client_id = cx.client_id
              WHERE cx.id = ae.contact_id
            ))
            OR EXISTS (
              SELECT 1 FROM journeys jf
              WHERE jf.id = ${journeyId}
                AND jf.client_id IS NOT NULL
                AND (jf.client_id = ae.client_id OR jf.client_id = c.client_id)
            )
          )` : sql``}
          ${clientId  ? sql`AND (ae.client_id = ${clientId} OR c.client_id = ${clientId})` : sql``}
          ${stagesArr.length > 0 ? sql`AND LOWER(COALESCE(c.stage,'pre-aware')) IN (${sql.join(stagesArr.map(s => sql`LOWER(${s})`), sql`, `)})` : sql``}
          ${scoreMin !== null ? sql`AND COALESCE(c.lead_score, 0) >= ${scoreMin}` : sql``}
          ${scoreMax !== null ? sql`AND COALESCE(c.lead_score, 0) <= ${scoreMax}` : sql``}
          ${dateFrom  ? sql`AND ae.created_at >= ${reportDayStart(dateFrom)}` : sql``}
          ${dateTo    ? sql`AND ae.created_at < ${reportDayEnd(dateTo)}` : sql``}
      ) + (
        -- Anonymous + resolved journey page views
        SELECT COUNT(*)::int FROM journey_events je
        LEFT JOIN visitor_tokens vt ON vt.token = je.visitor_token AND vt.tenant_id = je.tenant_id
        LEFT JOIN LATERAL (
          SELECT contact_id FROM form_submissions
          WHERE visitor_token = je.visitor_token AND tenant_id = je.tenant_id AND contact_id IS NOT NULL
          ORDER BY submitted_at DESC LIMIT 1
        ) fs ON TRUE
        LEFT JOIN contacts c ON c.id = COALESCE(vt.contact_id, fs.contact_id) AND c.tenant_id = je.tenant_id
        WHERE je.tenant_id = ${tid}
          AND je.event_type IN ('page_view','cta_click','banner_dismiss')
          ${journeyCompanyFilter(companyIdsArr)}
          ${journeyId ? sql`AND je.journey_id = ${journeyId}` : sql``}
          ${stagesArr.length > 0 ? sql`AND LOWER(COALESCE(c.stage,'pre-aware')) IN (${sql.join(stagesArr.map(s => sql`LOWER(${s})`), sql`, `)})` : sql``}
          ${dateFrom  ? sql`AND je.created_at >= ${reportDayStart(dateFrom)}` : sql``}
          ${dateTo    ? sql`AND je.created_at < ${reportDayEnd(dateTo)}` : sql``}
          ${scoreMin !== null ? sql`AND COALESCE(c.lead_score, 0) >= ${scoreMin}` : sql``}
          ${scoreMax !== null ? sql`AND COALESCE(c.lead_score, 0) <= ${scoreMax}` : sql``}
           ${clientId  ? sql`AND EXISTS (SELECT 1 FROM journeys scoped_journey
             WHERE scoped_journey.id=je.journey_id AND scoped_journey.tenant_id=je.tenant_id
               AND scoped_journey.client_id=${clientId})` : sql``}
          AND NOT EXISTS (
            SELECT 1 FROM activity_events ae2
            WHERE ae2.tenant_id = ${tid}
              ${activityCompanyFilter("ae2", companyIdsArr)}
              AND ae2.contact_id = ${companyIdsArr !== null ? sql`COALESCE(vt.contact_id, fs.contact_id)` : sql`vt.contact_id`}
              AND ae2.event_type = 'page_view'
              AND ae2.journey_id = je.journey_id
              AND ae2.page_name  = (SELECT NULLIF(TRIM(jp2.title),'') FROM journey_pages jp2 WHERE jp2.id = je.page_id LIMIT 1)
              AND ABS(EXTRACT(EPOCH FROM (ae2.created_at - je.created_at))) < 120
          )
      ) AS total
    `)).rows[0] as { total: number } : null;

    // When a specific journey is filtered, tell the UI how many pages it has.
    // This explains why every contact shows the same number of page_view events.
    let journeyPageCount: number | null = null;
    if (journeyId) {
      const pcRes = (await db.execute(sql`
        SELECT COUNT(*)::int AS cnt FROM journey_pages WHERE journey_id = ${journeyId}
      `)).rows[0] as { cnt: number } | undefined;
      journeyPageCount = pcRes?.cnt ?? null;
    }

    res.json({ rows: exportAll ? rows : rows.slice(0, limit), total: countRes?.total ?? null,
      hasMore: !exportAll && rows.length > limit, page, limit, journeyPageCount });
  } catch (err) { next(err); }
});

// ── GET /analytics/landing-urls ───────────────────────────────────────────────
// Top landing URLs (window.location.href at page_view time) and top CTA
// destination URLs. Shown in the Traffic tab to surface exact entry points.
router.get("/analytics/landing-urls", async (req, res, next): Promise<void> => {
  try {
    const user = req.user as any;
    const tid = user.tenantId;
    const { journeyId, dateFrom, dateTo, clientId } = req.query as Record<string, string | undefined>;
    const jid = journeyId ? Number(journeyId) : null;
    const cid = clientId ? Number(clientId) : null;
    const accountSelection = await getTenantCompanySelection(req.query as Record<string, unknown>, tid);
    if (accountSelection.error) {
      res.status(400).json({ error: accountSelection.error });
      return;
    }
    const companyIds = accountSelection.companyIds;

    const landingUrls = (await db.execute(sql`
      SELECT
        page_url,
        COUNT(*)::int                       AS visits,
        COUNT(DISTINCT visitor_token)::int  AS unique_visitors
      FROM journey_events je
      WHERE je.tenant_id = ${tid}
        AND je.event_type = 'page_view'
        AND je.page_url IS NOT NULL
        AND je.page_url <> ''
        ${journeyCompanyFilter(companyIds)}
        ${jid ? sql`AND journey_id = ${jid}` : sql``}
        ${cid && companyIds === null ? sql`AND EXISTS (
          SELECT 1 FROM visitor_tokens vt2
          JOIN contacts c2 ON c2.id = vt2.contact_id
          WHERE vt2.token = je.visitor_token
            AND vt2.tenant_id = ${tid}
            AND c2.client_id = ${cid}
        )` : sql``}
        ${dateFrom ? sql`AND created_at >= ${reportDayStart(dateFrom)}` : sql``}
        ${dateTo   ? sql`AND created_at < ${reportDayEnd(dateTo)}` : sql``}
      GROUP BY page_url
      ORDER BY visits DESC
      LIMIT 30
    `)).rows;

    const ctaUrls = (await db.execute(sql`
      SELECT
        cta_url,
        COUNT(*)::int                       AS clicks,
        COUNT(DISTINCT visitor_token)::int  AS unique_clickers
      FROM journey_events je
      WHERE je.tenant_id = ${tid}
        AND je.event_type = 'cta_click'
        AND je.cta_url IS NOT NULL
        AND je.cta_url <> ''
        ${journeyCompanyFilter(companyIds)}
        ${jid ? sql`AND journey_id = ${jid}` : sql``}
        ${dateFrom ? sql`AND created_at >= ${reportDayStart(dateFrom)}` : sql``}
        ${dateTo   ? sql`AND created_at < ${reportDayEnd(dateTo)}` : sql``}
      GROUP BY cta_url
      ORDER BY clicks DESC
      LIMIT 20
    `)).rows;

    res.json({ landingUrls, ctaUrls });
  } catch (err) { next(err); }
});

// ── Scroll Depth ──────────────────────────────────────────────────────────────
router.get("/analytics/scroll-depth", async (req, res, next): Promise<void> => {
  try {
    const user = req.user as any;
    const tid = user.tenantId;
    const journeyId = req.query.journeyId ? Number(req.query.journeyId) : null;
    const accountSelection = await getTenantCompanySelection(req.query as Record<string, unknown>, tid);
    if (accountSelection.error) {
      res.status(400).json({ error: accountSelection.error });
      return;
    }
    const companyIds = accountSelection.companyIds;

    const byJourney = await db.execute(sql`
      SELECT
        j.id, j.name,
        COALESCE(COUNT(DISTINCT CASE WHEN (ae.metadata::jsonb->>'depth')::int >= 25  THEN ae.metadata::jsonb->>'visitorToken' END), 0)::int AS d25,
        COALESCE(COUNT(DISTINCT CASE WHEN (ae.metadata::jsonb->>'depth')::int >= 50  THEN ae.metadata::jsonb->>'visitorToken' END), 0)::int AS d50,
        COALESCE(COUNT(DISTINCT CASE WHEN (ae.metadata::jsonb->>'depth')::int >= 75  THEN ae.metadata::jsonb->>'visitorToken' END), 0)::int AS d75,
        COALESCE(COUNT(DISTINCT CASE WHEN (ae.metadata::jsonb->>'depth')::int >= 100 THEN ae.metadata::jsonb->>'visitorToken' END), 0)::int AS d100,
        COALESCE(COUNT(DISTINCT ae.metadata::jsonb->>'visitorToken'), 0)::int AS total
      FROM journeys j
      LEFT JOIN activity_events ae
        ON ae.journey_id = j.id
        AND ae.event_type = 'scroll_depth'
        AND ae.metadata IS NOT NULL
        AND ae.metadata <> ''
        ${activityCompanyFilter("ae", companyIds)}
      WHERE j.tenant_id = ${tid}
        ${journeyId ? sql`AND j.id = ${journeyId}` : sql``}
      GROUP BY j.id, j.name
      HAVING COUNT(ae.id) > 0
      ORDER BY total DESC
      LIMIT 20
    `);

    const totalsRes = await db.execute(sql`
      SELECT
        COALESCE(COUNT(DISTINCT CASE WHEN (ae.metadata::jsonb->>'depth')::int >= 25  THEN ae.metadata::jsonb->>'visitorToken' END), 0)::int AS d25,
        COALESCE(COUNT(DISTINCT CASE WHEN (ae.metadata::jsonb->>'depth')::int >= 50  THEN ae.metadata::jsonb->>'visitorToken' END), 0)::int AS d50,
        COALESCE(COUNT(DISTINCT CASE WHEN (ae.metadata::jsonb->>'depth')::int >= 75  THEN ae.metadata::jsonb->>'visitorToken' END), 0)::int AS d75,
        COALESCE(COUNT(DISTINCT CASE WHEN (ae.metadata::jsonb->>'depth')::int >= 100 THEN ae.metadata::jsonb->>'visitorToken' END), 0)::int AS d100
      FROM activity_events ae
      JOIN journeys j ON j.id = ae.journey_id
      WHERE j.tenant_id = ${tid}
        AND ae.event_type = 'scroll_depth'
        AND ae.metadata IS NOT NULL
        AND ae.metadata <> ''
        ${activityCompanyFilter("ae", companyIds)}
        ${journeyId ? sql`AND ae.journey_id = ${journeyId}` : sql``}
    `);

    res.json({
      byJourney: byJourney.rows,
      totals: totalsRes.rows[0] ?? { d25: 0, d50: 0, d75: 0, d100: 0 },
    });
  } catch (err) { next(err); }
});

// ── Account Intelligence ──────────────────────────────────────────────────────
router.get("/analytics/account-intelligence", async (req, res, next): Promise<void> => {
  try {
    const user = req.user as any;
    const tid = user.tenantId;
    const exportAll = req.query.export === "true";
    const page = Number(req.query.page ?? 1);
    if (!Number.isSafeInteger(page) || page < 1 || page > 100_000) {
      res.status(400).json({ error: "page must be a positive integer" });
      return;
    }
    const limit = 30;
    const offset = (page - 1) * limit;
    const { clientId, dateFrom, dateTo, journeyId } = req.query as Record<string, string | undefined>;
    const jid = journeyId ? Number(journeyId) : null;
    const accountSelection = await getTenantCompanySelection(req.query as Record<string, unknown>, tid);
    if (accountSelection.error) {
      res.status(400).json({ error: accountSelection.error });
      return;
    }
    const companyIds = accountSelection.companyIds;
    const eventCompanyExpression = companyIds !== null ? sql`COALESCE(ae.company_id, c.company_id)` : sql`c.company_id`;

    const rows = (await db.execute(sql`
      WITH all_contact_agg AS (
        SELECT
          company_id,
          COUNT(*)::int                         AS contact_count,
          ROUND(AVG(lead_score)::numeric, 1)   AS avg_score,
          MODE() WITHIN GROUP (ORDER BY stage) AS dominant_stage
        FROM contacts
        WHERE tenant_id = ${tid}
          AND company_id IS NOT NULL
          ${companyIdFilter(sql`company_id`, companyIds)}
          ${clientId ? sql`AND client_id = ${Number(clientId)}` : sql``}
          ${jid ? sql`AND EXISTS (SELECT 1 FROM activity_events x WHERE x.contact_id=contacts.id AND x.journey_id=${jid})` : sql``}
        GROUP BY company_id
      ),
      domain_agg AS (
        SELECT LOWER(split_part(split_part(c.email, '@', 2), '.', 1)) AS domain_key,
               ROUND(AVG(c.lead_score)::numeric, 1) AS avg_score
        FROM contacts c
        WHERE c.tenant_id = ${tid} AND c.company_id IS NULL
          ${companyIds !== null ? sql`AND FALSE` : sql``}
          ${clientId ? sql`AND c.client_id = ${Number(clientId)}` : sql``}
          AND LOWER(split_part(split_part(c.email, '@', 2), '.', 1)) NOT IN (
            SELECT LOWER(name) FROM companies WHERE tenant_id = ${tid}
          )
        GROUP BY LOWER(split_part(split_part(c.email, '@', 2), '.', 1))
      ),
      page_accounts AS (
        SELECT * FROM (
          SELECT co.id, co.name, ca.avg_score, NULL::text AS domain_key
          FROM companies co
          JOIN all_contact_agg ca ON ca.company_id = co.id
          WHERE co.tenant_id = ${tid}
          UNION ALL
          SELECT NULL::integer AS id, initcap(d.domain_key) AS name, d.avg_score, d.domain_key
          FROM domain_agg d
        ) candidates
        ORDER BY avg_score DESC NULLS LAST, name, id NULLS LAST, domain_key
        ${exportAll ? sql`` : sql`LIMIT ${limit + 1} OFFSET ${offset}`}
      ),
      contact_agg AS (
        SELECT ca.* FROM all_contact_agg ca JOIN page_accounts p ON p.id = ca.company_id
      ),
      recent_deltas AS (
        SELECT ${eventCompanyExpression} AS company_id,
               ROUND(SUM(ae.score_delta)::numeric / NULLIF(COUNT(DISTINCT c.id), 0), 1) AS avg_delta_30d
        FROM contacts c
        JOIN activity_events ae
          ON ae.contact_id = c.id
         AND ae.tenant_id  = ${tid}
         AND ae.score_delta > 0
         AND ae.created_at >= NOW() - INTERVAL '30 days'
        JOIN page_accounts p ON p.id = ${eventCompanyExpression}
        WHERE c.tenant_id = ${tid}
          ${activityCompanyFilter("ae", companyIds)}
        GROUP BY ${eventCompanyExpression}
      ),
      event_agg AS (
        SELECT
          ${eventCompanyExpression} AS company_id,
          COUNT(ae.id)::int                                                              AS total_events,
          COUNT(DISTINCT (ae.contact_id::text || '|' || ${reportDay(sql`ae.created_at`)}::text))::int AS sessions,
          ROUND(AVG(NULLIF(ae.duration_seconds, 0))::numeric, 1)                       AS avg_session_secs
        FROM contacts c
        LEFT JOIN activity_events ae
          ON ae.contact_id  = c.id
         AND ae.tenant_id   = ${tid}
         ${dateFrom ? sql`AND ae.created_at >= ${reportDayStart(dateFrom)}` : sql``}
         ${dateTo   ? sql`AND ae.created_at < ${reportDayEnd(dateTo)}` : sql``}
         ${activityCompanyFilter("ae", companyIds)}
        JOIN page_accounts p ON p.id = ${eventCompanyExpression}
        WHERE c.tenant_id = ${tid}
        GROUP BY ${eventCompanyExpression}
      ),
      stage_age AS (
        SELECT DISTINCT ON (c.company_id)
          c.company_id,
          GREATEST(0, EXTRACT(EPOCH FROM (NOW() - MAX(csh.created_at)))/86400)::int AS days_in_stage
        FROM contacts c
        JOIN contact_agg ca ON ca.company_id = c.company_id
        LEFT JOIN contact_stage_history csh
          ON csh.contact_id = c.id
         AND csh.to_stage   = ca.dominant_stage
        WHERE c.tenant_id = ${tid} AND c.company_id IS NOT NULL
        GROUP BY c.company_id, ca.dominant_stage
        ORDER BY c.company_id
      )
      SELECT
        co.id,
        co.name,
        co.industry,
        co.size                                                                             AS employee_size,
        ca.contact_count,
        ca.avg_score,
        ROUND((COALESCE(ca.avg_score::float, 0) - COALESCE(rd.avg_delta_30d::float, 0))::numeric, 1) AS prev_month_score,
        ca.dominant_stage,
        COALESCE(sa.days_in_stage, 0)    AS days_in_stage,
        COALESCE(ea.total_events, 0)     AS total_events,
        COALESCE(ea.sessions, 0)         AS sessions,
        COALESCE(ea.avg_session_secs, 0) AS avg_session_secs
      FROM companies co
      JOIN contact_agg ca ON ca.company_id = co.id
      JOIN page_accounts p ON p.id = co.id
      LEFT JOIN recent_deltas rd ON rd.company_id = co.id
      LEFT JOIN event_agg     ea ON ea.company_id = co.id
      LEFT JOIN stage_age     sa ON sa.company_id = co.id
      WHERE co.tenant_id = ${tid}

      UNION ALL

      -- Contacts not linked to any company: group by email domain so they still appear
      SELECT
        NULL::integer                                                                         AS id,
        initcap(LOWER(split_part(split_part(c.email, '@', 2), '.', 1)))                       AS name,
        NULL::text                                                                            AS industry,
        NULL::text                                                                            AS employee_size,
        COUNT(DISTINCT c.id)::int                                                             AS contact_count,
        ROUND(AVG(c.lead_score)::numeric, 1)                                                  AS avg_score,
        ROUND((COALESCE(AVG(c.lead_score)::float, 0) - COALESCE(
          SUM(CASE WHEN ae.score_delta > 0 AND ae.created_at >= NOW() - INTERVAL '30 days'
                   THEN ae.score_delta ELSE 0 END)::float
          / NULLIF(COUNT(DISTINCT c.id), 0), 0))::numeric, 1)                                AS prev_month_score,
        MODE() WITHIN GROUP (ORDER BY c.stage)                                                AS dominant_stage,
        0::int                                                                                AS days_in_stage,
        COUNT(ae.id)::int                                                                     AS total_events,
        COUNT(DISTINCT (ae.contact_id::text || '|' || ${reportDay(sql`ae.created_at`)}::text))::int AS sessions,
        COALESCE(ROUND(AVG(NULLIF(ae.duration_seconds, 0))::numeric, 1), 0)                  AS avg_session_secs
      FROM contacts c
      LEFT JOIN activity_events ae
        ON ae.contact_id = c.id
       AND ae.tenant_id  = ${tid}
       ${dateFrom ? sql`AND ae.created_at >= ${reportDayStart(dateFrom)}` : sql``}
       ${dateTo   ? sql`AND ae.created_at < ${reportDayEnd(dateTo)}` : sql``}
      WHERE c.tenant_id = ${tid}
        AND c.company_id IS NULL
        ${companyIds !== null ? sql`AND FALSE` : sql``}
        ${clientId ? sql`AND c.client_id = ${Number(clientId)}` : sql``}
        AND LOWER(split_part(split_part(c.email, '@', 2), '.', 1)) IN (
          SELECT domain_key FROM page_accounts WHERE id IS NULL
        )
        AND LOWER(split_part(split_part(c.email, '@', 2), '.', 1)) NOT IN (
          SELECT LOWER(name) FROM companies WHERE tenant_id = ${tid}
        )
      GROUP BY LOWER(split_part(split_part(c.email, '@', 2), '.', 1))
      HAVING COUNT(DISTINCT c.id) > 0

      ORDER BY avg_score DESC NULLS LAST, name, id NULLS LAST
    `)).rows as any[];

    // Use the same attributed account context as Analytics → Accounts rather
    // than deriving a second heat status from the contact score.
    const visibleRows = exportAll ? rows : rows.slice(0, limit);
    const accountIds = [...new Set(visibleRows.map((r: any) => Number(r.id))
      .filter((id: number) => Number.isSafeInteger(id) && id > 0))];
    const accountContext = new Map<number, { gtmStatus: { status: string; updatedAt: string | null } | null; journeyName: string | null }>();
    for (let i = 0; i < accountIds.length; i += 100) {
      const chunk = accountIds.slice(i, i + 100);
      const summaries = await loadAccountSummaries(tid, { companyIds: chunk, limit: chunk.length });
      for (const summary of summaries.rows) {
        accountContext.set(summary.id, { gtmStatus: summary.gtmStatus, journeyName: summary.journeyName });
      }
    }
    const data = visibleRows.map((r: any) => {
      const score = parseFloat(r.avg_score) || 0;
      return {
        ...r,
        heat_tag: score >= 75 ? "Very Hot" : score >= 50 ? "Hot" : score >= 25 ? "Warm" : "Cold",
        gtmStatus: accountContext.get(Number(r.id))?.gtmStatus ?? null,
        journeyName: accountContext.get(Number(r.id))?.journeyName ?? null,
      };
    });

    res.json({ rows: data, page, limit, hasMore: !exportAll && rows.length > limit });
  } catch (err) { next(err); }
});

// ── Journey Velocity ───────────────────────────────────────────────────────────
router.get("/analytics/journey-velocity", async (req, res, next): Promise<void> => {
  try {
    const user = req.user as any;
    const tid = user.tenantId;
    const { clientId, dateFrom, dateTo, journeyId } = req.query as Record<string, string | undefined>;
    const jid = journeyId ? Number(journeyId) : null;
    const accountSelection = await getTenantCompanySelection(req.query as Record<string, unknown>, tid);
    if (accountSelection.error) {
      res.status(400).json({ error: accountSelection.error });
      return;
    }
    const companyIds = accountSelection.companyIds;

    const transitionRows = (await db.execute(sql`
      WITH trans AS (
        SELECT
          csh.contact_id,
          csh.from_stage,
          csh.to_stage,
          csh.created_at AS entry_date,
          LEAD(csh.created_at) OVER (PARTITION BY csh.contact_id ORDER BY csh.created_at) AS exit_date
        FROM contact_stage_history csh
        JOIN contacts c ON c.id = csh.contact_id AND c.tenant_id = ${tid}
        WHERE c.tenant_id = ${tid}
          AND csh.from_stage IS NOT NULL
          ${companyIdFilter(sql`c.company_id`, companyIds)}
          ${jid    ? sql`AND EXISTS (SELECT 1 FROM activity_events x WHERE x.contact_id=c.id AND x.journey_id=${jid})` : sql``}
          ${dateTo ? sql`AND csh.created_at < ${reportDayEnd(dateTo)}` : sql``}
      ),
      avg_days_per_pair AS (
        SELECT from_stage, to_stage,
               AVG(EXTRACT(EPOCH FROM (COALESCE(exit_date, NOW()) - entry_date))/86400) AS avg_d
        FROM trans
        WHERE from_stage IS NOT NULL AND to_stage IS NOT NULL
        GROUP BY from_stage, to_stage
      )
      SELECT
        co.id   AS company_id,
        co.name AS account,
        co.industry,
        t.from_stage,
        t.to_stage,
        t.entry_date,
        t.exit_date,
        ROUND(EXTRACT(EPOCH FROM (COALESCE(t.exit_date, NOW()) - t.entry_date))/86400::numeric, 0)::int AS days_in_stage,
        ROUND(ad.avg_d::numeric, 0)::int AS avg_days_for_transition
      FROM trans t
      JOIN contacts c ON c.id = t.contact_id
      LEFT JOIN companies co ON co.id = c.company_id AND co.tenant_id = ${tid}
      LEFT JOIN avg_days_per_pair ad ON ad.from_stage = t.from_stage AND ad.to_stage = t.to_stage
      WHERE c.tenant_id = ${tid}
        AND t.from_stage IS NOT NULL
        AND t.to_stage IS NOT NULL
        ${clientId ? sql`AND co.client_id = ${Number(clientId)}` : sql``}
      ORDER BY t.entry_date DESC
      LIMIT 100
    `)).rows as any[];

    const conversionRows = (await db.execute(sql`
      WITH trans AS (
        SELECT
          csh.contact_id,
          c.company_id,
          csh.from_stage,
          csh.to_stage,
          csh.created_at AS entry_date,
          LEAD(csh.created_at) OVER (PARTITION BY csh.contact_id ORDER BY csh.created_at) AS exit_date,
          EXTRACT(EPOCH FROM (
            COALESCE(LEAD(csh.created_at) OVER (PARTITION BY csh.contact_id ORDER BY csh.created_at), NOW()) - csh.created_at
          ))/86400 AS days_spent
        FROM contact_stage_history csh
        JOIN contacts c ON c.id = csh.contact_id AND c.tenant_id = ${tid}
        WHERE c.tenant_id = ${tid} AND csh.from_stage IS NOT NULL
          ${companyIdFilter(sql`c.company_id`, companyIds)}
          ${dateTo   ? sql`AND csh.created_at < ${reportDayEnd(dateTo)}` : sql``}
      ),
      industry_avg AS (
        SELECT t2.from_stage, t2.to_stage, co2.industry,
               AVG(t2.days_spent) AS ind_avg
        FROM trans t2
        JOIN companies co2 ON co2.id = t2.company_id AND co2.tenant_id = ${tid}
        WHERE t2.from_stage IS NOT NULL AND t2.to_stage IS NOT NULL
        GROUP BY t2.from_stage, t2.to_stage, co2.industry
      ),
      best_industry AS (
        SELECT DISTINCT ON (from_stage, to_stage) from_stage, to_stage, industry AS leader_industry
        FROM industry_avg
        ORDER BY from_stage, to_stage, ind_avg ASC
      ),
      fastest AS (
        SELECT DISTINCT ON (t3.from_stage, t3.to_stage)
          t3.from_stage, t3.to_stage, co3.name AS fastest_account
        FROM trans t3
        JOIN companies co3 ON co3.id = t3.company_id AND co3.tenant_id = ${tid}
        WHERE t3.from_stage IS NOT NULL AND t3.to_stage IS NOT NULL AND co3.name IS NOT NULL
        ORDER BY t3.from_stage, t3.to_stage, t3.days_spent ASC
      )
      SELECT
        t.from_stage,
        t.to_stage,
        COUNT(*)::int                                   AS entered,
        COUNT(*) FILTER (WHERE exit_date IS NOT NULL)::int AS exited,
        ROUND(AVG(t.days_spent)::numeric, 0)::int      AS avg_days,
        bi.leader_industry,
        f.fastest_account
      FROM trans t
      LEFT JOIN best_industry bi ON bi.from_stage = t.from_stage AND bi.to_stage = t.to_stage
      LEFT JOIN fastest       f  ON f.from_stage  = t.from_stage AND f.to_stage  = t.to_stage
      WHERE t.from_stage IS NOT NULL AND t.to_stage IS NOT NULL
      GROUP BY t.from_stage, t.to_stage, bi.leader_industry, f.fastest_account
      ORDER BY entered DESC
    `)).rows as any[];

    const stageTransitions = transitionRows.map((r: any) => {
      const avgD = r.avg_days_for_transition ?? 0;
      const daysD = r.days_in_stage ?? 0;
      const diff = avgD - daysD;
      return {
        account: r.account ?? "Unknown",
        companyId: r.company_id ?? null,
        industry: r.industry ?? "—",
        fromStage: r.from_stage,
        toStage: r.to_stage,
        entryDate: r.entry_date,
        exitDate: r.exit_date,
        daysInStage: daysD,
        velocityVsAvg: diff > 1 ? `+${Math.round(diff)}d faster` : diff < -1 ? `${Math.round(Math.abs(diff))}d slower` : "On pace",
      };
    });

    const conversionRates = conversionRows.map((r: any) => ({
      fromStage: r.from_stage,
      toStage: r.to_stage,
      entered: r.entered,
      exited: r.exited,
      conversionRate: r.entered > 0 ? Math.round((r.exited / r.entered) * 100) : 0,
      avgDays: r.avg_days ?? 0,
      industryLeader: r.leader_industry ?? null,
      fastestAccount: r.fastest_account ?? null,
    }));

    res.json({ stageTransitions, conversionRates });
  } catch (err) { next(err); }
});

// ── Score Intelligence ─────────────────────────────────────────────────────────
router.get("/analytics/score-intelligence", async (req, res, next): Promise<void> => {
  try {
    const user = req.user as any;
    const tid = user.tenantId;
    const { clientId, journeyId } = req.query as Record<string, string | undefined>;
    const jid = journeyId ? Number(journeyId) : null;
    const accountSelection = await getTenantCompanySelection(req.query as Record<string, unknown>, tid);
    if (accountSelection.error) {
      res.status(400).json({ error: accountSelection.error });
      return;
    }
    const companyIds = accountSelection.companyIds;

    const [distRows, risersRows, trendRows, accountRows] = await Promise.all([
      db.execute(sql`
        SELECT
          CASE
            WHEN COALESCE(intent_score, 0) >= 65 THEN 'Very Hot (65+)'
            WHEN COALESCE(intent_score, 0) >= 40 THEN 'Hot (40–64)'
            WHEN COALESCE(intent_score, 0) >= 18 THEN 'Warm (18–39)'
            ELSE 'Cold (<18)'
          END AS bucket,
          COUNT(*)::int AS count
        FROM contacts
        WHERE tenant_id = ${tid}
          ${companyIdFilter(sql`company_id`, companyIds)}
          ${clientId  ? sql`AND client_id  = ${Number(clientId)}`  : sql``}
          ${jid ? sql`AND EXISTS (SELECT 1 FROM activity_events x WHERE x.contact_id=contacts.id AND x.journey_id=${jid})` : sql``}
        GROUP BY bucket
        ORDER BY MIN(COALESCE(intent_score, 0)) DESC
      `),
      db.execute(sql`
        SELECT
          c.id, c.first_name, c.last_name, c.email, c.lead_score, c.stage,
          co.name AS company_name,
          COALESCE(SUM(ae.score_delta), 0)::int             AS score_gain_30d,
          (c.lead_score - COALESCE(SUM(ae.score_delta),0))::int AS prev_score
        FROM contacts c
        LEFT JOIN activity_events ae
          ON ae.contact_id = c.id
         AND ae.tenant_id  = ${tid}
         AND ae.created_at >= NOW() - INTERVAL '30 days'
         AND ae.score_delta > 0
         ${activityCompanyFilter("ae", companyIds)}
        LEFT JOIN companies co ON co.id = c.company_id
        WHERE c.tenant_id = ${tid}
          ${companyIdFilter(sql`c.company_id`, companyIds)}
          ${clientId  ? sql`AND c.client_id  = ${Number(clientId)}`  : sql``}
          ${jid ? sql`AND EXISTS (SELECT 1 FROM activity_events x WHERE x.contact_id=c.id AND x.journey_id=${jid})` : sql``}
        GROUP BY c.id, c.first_name, c.last_name, c.email, c.lead_score, c.stage, co.name
        HAVING COALESCE(SUM(ae.score_delta), 0) > 0
        ORDER BY score_gain_30d DESC
        LIMIT 20
      `),
      db.execute(sql`
        SELECT
          ${reportDay(sql`ae.created_at`)}::text AS date,
          SUM(ae.score_delta)::int  AS total_delta,
          COUNT(DISTINCT ae.contact_id)::int AS active_contacts
        FROM activity_events ae
        WHERE ae.tenant_id  = ${tid}
          AND ae.score_delta > 0
          AND ae.created_at >= NOW() - INTERVAL '30 days'
          ${activityCompanyFilter("ae", companyIds)}
          ${clientId  ? sql`AND ae.contact_id IN (SELECT id FROM contacts WHERE client_id  = ${Number(clientId)}  AND tenant_id = ${tid})` : sql``}
          ${jid ? sql`AND ae.journey_id = ${jid}` : sql``}
        GROUP BY ${reportDay(sql`ae.created_at`)}
        ORDER BY date ASC
      `),
      db.execute(sql`
        SELECT
          co.id, co.name AS company_name, co.industry,
          COUNT(c.id)::int                       AS contact_count,
          ROUND(AVG(c.lead_score)::numeric, 1)  AS avg_score,
          MAX(c.lead_score)::int                AS max_score,
          MIN(c.lead_score)::int                AS min_score,
          COUNT(c.id) FILTER (WHERE COALESCE(c.intent_score,0) >= 65)::int AS very_hot_count,
          COUNT(c.id) FILTER (WHERE COALESCE(c.intent_score,0) >= 40 AND COALESCE(c.intent_score,0) < 65)::int AS hot_count,
          COUNT(c.id) FILTER (WHERE COALESCE(c.intent_score,0) >= 18 AND COALESCE(c.intent_score,0) < 40)::int AS warm_count,
          COUNT(c.id) FILTER (WHERE COALESCE(c.intent_score,0) < 18)::int AS cold_count
        FROM companies co
        JOIN contacts c ON c.company_id = co.id AND c.tenant_id = co.tenant_id
        WHERE co.tenant_id = ${tid}
          ${companyIdFilter(sql`co.id`, companyIds)}
          ${clientId ? sql`AND co.client_id = ${Number(clientId)}` : sql``}
        GROUP BY co.id, co.name, co.industry
        ORDER BY avg_score DESC
      `),
    ]);

    res.json({
      distribution: distRows.rows,
      risers: risersRows.rows,
      trend: trendRows.rows,
      byAccount: accountRows.rows,
    });
  } catch (err) { next(err); }
});

// ── GET /analytics/playbook-recommendations ───────────────────────────────────
// Returns contacts + accounts with actionable intent states, ordered by priority.
// When journeyId is supplied every metric is derived per-journey from activity_events;
// without journeyId the pre-computed global contacts fields are used.
router.get("/analytics/playbook-recommendations", async (req, res, next): Promise<void> => {
  try {
    const user = req.user as any;
    const tid = user.tenantId;
    const { clientId, journeyId } = req.query as Record<string, string | undefined>;
    const jid = journeyId ? Number(journeyId) : null;
    const cid = clientId ? Number(clientId) : null;
    const accountSelection = await getTenantCompanySelection(req.query as Record<string, unknown>, tid);
    if (accountSelection.error) {
      res.status(400).json({ error: accountSelection.error });
      return;
    }
    const companyIds = accountSelection.companyIds;

    // Helper: intent-state rank expression (used in multiple ORDER BY / HAVING clauses)
    // rank 1=Decision-Action … 6=Dormant, 7=Browsing
    const stateRankExpr = (stateCol: string) => `CASE ${stateCol}
      WHEN 'Decision-Action'   THEN 1
      WHEN 'Evaluating-Engage' THEN 2
      WHEN 'Stuck-PreEngage'   THEN 3
      WHEN 'Re-engaging'       THEN 4
      WHEN 'Stuck-Aware'       THEN 5
      WHEN 'Dormant'           THEN 6
      ELSE 7 END`;

    const playsQ = db.execute(sql`
      SELECT id, name, status FROM abm_plays
      WHERE tenant_id = ${tid} AND status = 'active'
        ${cid ? sql`AND (client_id = ${cid} OR client_id IS NULL)` : sql``}
        ${companyIds === null ? sql`` : sql`AND EXISTS (
          SELECT 1 FROM play_contacts pc
          JOIN contacts play_contact ON play_contact.id = pc.contact_id AND play_contact.tenant_id = ${tid}
          WHERE pc.play_id = abm_plays.id AND pc.tenant_id = ${tid}
            ${companyIdFilter(sql`play_contact.company_id`, companyIds)}
          UNION ALL
          SELECT 1 FROM email_sequences es
          JOIN sequence_enrollments se ON se.sequence_id = es.id
          JOIN contacts enrolled_contact ON enrolled_contact.id = se.contact_id AND enrolled_contact.tenant_id = ${tid}
          WHERE es.play_id = abm_plays.id AND es.tenant_id = ${tid}
            ${companyIdFilter(sql`enrolled_contact.company_id`, companyIds)}
        )`}
      ORDER BY name LIMIT 20
    `);

    if (jid) {
      // ── Journey-scoped: compute everything from activity_events for this journey ──
      // intent_state derived from per-journey max_stage_rank + journey_active_days + recency.
      // Contacts with no events in this journey are excluded entirely.

      const journeyQ = db.execute(sql`
        SELECT name FROM journeys WHERE id = ${jid} AND tenant_id = ${tid} LIMIT 1
      `);

      const contactsQ = db.execute(sql`
        WITH jm AS (
          SELECT
            ae.contact_id,
            COALESCE(SUM(ae.score_delta), 0)::int                                   AS journey_score,
            COUNT(DISTINCT ${reportDay(sql`ae.created_at`)})::int AS journey_active_days,
            MAX(ae.created_at)                                                       AS last_activity,
            COUNT(*)::int                                                             AS journey_events,
            ARRAY_AGG(DISTINCT ae.stage) FILTER (WHERE ae.stage IS NOT NULL
              AND ae.stage NOT IN ('pre-aware'))                                     AS journey_stages,
            MAX(CASE ae.stage
              WHEN 'action'         THEN 5
              WHEN 'advance-engage' THEN 4
              WHEN 'engage'         THEN 3
              WHEN 'pre-engage'     THEN 2
              WHEN 'aware'          THEN 1
              ELSE 0
            END)::int                                                                AS max_stage_rank
          FROM activity_events ae
          WHERE ae.tenant_id = ${tid} AND ae.journey_id = ${jid}
            ${activityCompanyFilter("ae", companyIds)}
          GROUP BY ae.contact_id
        )
        SELECT
          c.id, c.first_name, c.last_name, c.email, c.stage AS global_stage, c.lead_score,
          jm.journey_score,
          jm.journey_active_days,
          jm.last_activity::text                                                     AS last_activity,
          jm.journey_events                                                          AS recent_events,
          COALESCE(jm.journey_stages, ARRAY[]::text[])                              AS journey_stages,
          CASE jm.max_stage_rank
            WHEN 5 THEN 'action' WHEN 4 THEN 'advance-engage' WHEN 3 THEN 'engage'
            WHEN 2 THEN 'pre-engage' WHEN 1 THEN 'aware' ELSE 'pre-aware'
          END                                                                        AS journey_max_stage,
          CASE
            WHEN jm.last_activity < NOW() - INTERVAL '30 days'                     THEN 'Dormant'
            WHEN jm.max_stage_rank >= 5                                             THEN 'Decision-Action'
            WHEN jm.max_stage_rank IN (3,4) AND jm.journey_active_days >= 2        THEN 'Evaluating-Engage'
            WHEN jm.max_stage_rank = 2      AND jm.journey_active_days >= 2        THEN 'Stuck-PreEngage'
            WHEN jm.max_stage_rank = 1      AND jm.journey_active_days >= 2        THEN 'Stuck-Aware'
            ELSE 'Browsing'
          END                                                                        AS intent_state,
          CASE
            WHEN jm.last_activity < NOW() - INTERVAL '30 days'
              THEN 'Quarterly re-activation or remove from active list'
            WHEN jm.max_stage_rank >= 5
              THEN 'Route to AE immediately; high-priority follow-up'
            WHEN jm.max_stage_rank IN (3,4) AND jm.journey_active_days >= 2
              THEN 'Trigger sales outreach with a specific hook based on visited content'
            WHEN jm.max_stage_rank = 2 AND jm.journey_active_days >= 2
              THEN 'Share comparison content, case study, or why-us material'
            WHEN jm.max_stage_rank = 1 AND jm.journey_active_days >= 2
              THEN 'Send educational nurture sequence'
            ELSE 'No action; continue monitoring'
          END                                                                        AS suggested_next_action,
          co.name  AS company_name, co.id AS company_id,
          cl.name  AS client_name,  c.client_id
        FROM contacts c
        JOIN jm ON jm.contact_id = c.id
        LEFT JOIN companies co ON co.id = c.company_id
        LEFT JOIN clients   cl ON cl.id = c.client_id
        WHERE c.tenant_id = ${tid}
          ${companyIdFilter(sql`c.company_id`, companyIds)}
          ${cid ? sql`AND c.client_id = ${cid}` : sql``}
        ORDER BY
          CASE
            WHEN jm.last_activity < NOW() - INTERVAL '30 days' THEN 6
            WHEN jm.max_stage_rank >= 5                         THEN 1
            WHEN jm.max_stage_rank IN (3,4) AND jm.journey_active_days >= 2 THEN 2
            WHEN jm.max_stage_rank = 2      AND jm.journey_active_days >= 2 THEN 3
            WHEN jm.max_stage_rank = 1      AND jm.journey_active_days >= 2 THEN 4
            ELSE 5
          END ASC,
          jm.journey_score DESC
      `);

      const accountsQ = db.execute(sql`
        WITH jm AS (
          SELECT
            ae.contact_id,
            COALESCE(SUM(ae.score_delta), 0)::int AS journey_score,
            COUNT(DISTINCT ${reportDay(sql`ae.created_at`)})::int AS journey_active_days,
            MAX(ae.created_at) AS last_activity,
            MAX(CASE ae.stage
              WHEN 'action' THEN 5 WHEN 'advance-engage' THEN 4 WHEN 'engage' THEN 3
              WHEN 'pre-engage' THEN 2 WHEN 'aware' THEN 1 ELSE 0
            END)::int AS max_stage_rank
          FROM activity_events ae
          WHERE ae.tenant_id = ${tid} AND ae.journey_id = ${jid}
            ${activityCompanyFilter("ae", companyIds)}
          GROUP BY ae.contact_id
        ),
        cs AS (
          SELECT
            c.id AS contact_id, c.company_id,
            jm.journey_score,
            CASE
              WHEN jm.last_activity < NOW() - INTERVAL '30 days' THEN 6
              WHEN jm.max_stage_rank >= 5                         THEN 1
              WHEN jm.max_stage_rank IN (3,4) AND jm.journey_active_days >= 2 THEN 2
              WHEN jm.max_stage_rank = 2      AND jm.journey_active_days >= 2 THEN 3
              WHEN jm.max_stage_rank = 1      AND jm.journey_active_days >= 2 THEN 4
              ELSE 5
            END AS state_rank,
            CASE
              WHEN jm.last_activity < NOW() - INTERVAL '30 days'            THEN 'Dormant'
              WHEN jm.max_stage_rank >= 5                                    THEN 'Decision-Action'
              WHEN jm.max_stage_rank IN (3,4) AND jm.journey_active_days >= 2 THEN 'Evaluating-Engage'
              WHEN jm.max_stage_rank = 2      AND jm.journey_active_days >= 2 THEN 'Stuck-PreEngage'
              WHEN jm.max_stage_rank = 1      AND jm.journey_active_days >= 2 THEN 'Stuck-Aware'
              ELSE 'Browsing'
            END AS intent_state
          FROM contacts c
          JOIN jm ON jm.contact_id = c.id
          WHERE c.tenant_id = ${tid}
            ${companyIdFilter(sql`c.company_id`, companyIds)}
            ${cid ? sql`AND c.client_id = ${cid}` : sql``}
        )
        SELECT
          co.id, co.name, co.industry,
          COUNT(cs.contact_id)::int AS total_contacts,
          COUNT(cs.contact_id) FILTER (WHERE cs.intent_state NOT IN ('Browsing','Dormant'))::int AS actionable_contacts,
          (SELECT cs2.intent_state FROM cs cs2 WHERE cs2.company_id = co.id
           ORDER BY cs2.state_rank ASC LIMIT 1) AS dominant_intent_state,
          MAX(cs.journey_score)::int AS max_intent_score,
          ROUND(AVG(cs.journey_score)::numeric, 0)::int AS avg_lead_score
        FROM companies co
        JOIN cs ON cs.company_id = co.id
        WHERE co.tenant_id = ${tid}
          ${companyIdFilter(sql`co.id`, companyIds)}
        GROUP BY co.id, co.name, co.industry
        HAVING COUNT(cs.contact_id) FILTER (WHERE cs.intent_state NOT IN ('Browsing','Dormant')) > 0
        ORDER BY MIN(cs.state_rank) ASC, COUNT(cs.contact_id) DESC
      `);

      const [contactRows, accountRows, playsRows, journeyRows] =
        await Promise.all([contactsQ, accountsQ, playsQ, journeyQ]);

      res.json({
        contacts:       contactRows.rows,
        accounts:       accountRows.rows,
        plays:          playsRows.rows,
        isJourneyScoped: true,
        journeyName:    (journeyRows.rows[0] as any)?.name ?? null,
      });

    } else {
      // ── Global view: use pre-computed contacts fields ─────────────────────
      const contactsQ = db.execute(sql`
        SELECT
          c.id, c.first_name, c.last_name, c.email,
          c.stage, c.lead_score, c.intent_score, c.intent_state,
          c.suggested_next_action, c.distinct_active_days,
          co.name  AS company_name, co.id AS company_id,
          cl.name  AS client_name, c.client_id,
          (SELECT COUNT(*)::int FROM activity_events ae
           WHERE ae.contact_id = c.id AND ae.tenant_id = ${tid}
             ${activityCompanyFilter("ae", companyIds)}
             AND ae.created_at >= NOW() - INTERVAL '30 days') AS recent_events,
          (SELECT MAX(ae.created_at)::text FROM activity_events ae
           WHERE ae.contact_id = c.id AND ae.tenant_id = ${tid}
             ${activityCompanyFilter("ae", companyIds)}) AS last_activity
        FROM contacts c
        LEFT JOIN companies co ON co.id = c.company_id
        LEFT JOIN clients   cl ON cl.id = c.client_id
        WHERE c.tenant_id = ${tid}
          AND c.intent_state IS NOT NULL
          AND c.intent_state NOT IN ('Browsing')
          ${companyIdFilter(sql`c.company_id`, companyIds)}
          ${cid ? sql`AND c.client_id = ${cid}` : sql``}
        ORDER BY
          CASE c.intent_state
            WHEN 'Decision-Action'   THEN 1 WHEN 'Evaluating-Engage' THEN 2
            WHEN 'Stuck-PreEngage'   THEN 3 WHEN 'Re-engaging'       THEN 4
            WHEN 'Stuck-Aware'       THEN 5 WHEN 'Dormant'           THEN 6
            ELSE 7
          END,
          COALESCE(c.intent_score, 0) DESC
      `);

      const accountsQ = db.execute(sql`
        SELECT
          co.id, co.name, co.industry,
          COUNT(c.id)::int AS total_contacts,
          COUNT(c.id) FILTER (
            WHERE c.intent_state IS NOT NULL
              AND c.intent_state NOT IN ('Browsing','Dormant')
          )::int AS actionable_contacts,
          (SELECT c2.intent_state FROM contacts c2
           WHERE c2.company_id = co.id AND c2.tenant_id = ${tid}
             AND c2.intent_state IS NOT NULL
             AND c2.intent_state NOT IN ('Browsing','Dormant')
           ORDER BY CASE c2.intent_state
             WHEN 'Decision-Action'   THEN 1 WHEN 'Evaluating-Engage' THEN 2
             WHEN 'Stuck-PreEngage'   THEN 3 WHEN 'Re-engaging'       THEN 4
             WHEN 'Stuck-Aware'       THEN 5 ELSE 6 END
           LIMIT 1) AS dominant_intent_state,
          MAX(COALESCE(c.intent_score, 0))::int     AS max_intent_score,
          ROUND(AVG(c.lead_score)::numeric, 0)::int AS avg_lead_score
        FROM companies co
        JOIN contacts c ON c.company_id = co.id AND c.tenant_id = ${tid}
        WHERE co.tenant_id = ${tid}
          ${companyIdFilter(sql`co.id`, companyIds)}
          ${cid ? sql`AND co.client_id = ${cid}` : sql``}
        GROUP BY co.id, co.name, co.industry
        HAVING COUNT(c.id) FILTER (
          WHERE c.intent_state IS NOT NULL
            AND c.intent_state NOT IN ('Browsing','Dormant')
        ) > 0
        ORDER BY
          MIN(CASE c.intent_state
            WHEN 'Decision-Action'   THEN 1 WHEN 'Evaluating-Engage' THEN 2
            WHEN 'Stuck-PreEngage'   THEN 3 WHEN 'Re-engaging'       THEN 4
            WHEN 'Stuck-Aware'       THEN 5 WHEN 'Dormant'           THEN 6
            ELSE 7 END) ASC,
          COUNT(c.id) FILTER (
            WHERE c.intent_state IS NOT NULL
              AND c.intent_state NOT IN ('Browsing','Dormant')
          ) DESC
      `);

      const [contactRows, accountRows, playsRows] =
        await Promise.all([contactsQ, accountsQ, playsQ]);

      res.json({
        contacts:        contactRows.rows,
        accounts:        accountRows.rows,
        plays:           playsRows.rows,
        isJourneyScoped: false,
        journeyName:     null,
      });
    }
  } catch (err) { next(err); }
});

// ── GET /analytics/score-corrections ─────────────────────────────────────────
// Returns the immutable audit log of every score correction event.
// old_score/new_score/delta come from the metadata JSON persisted at correction
// time. For legacy rows (pre-metadata), we fall back to a computed estimate.
router.get("/analytics/score-corrections", async (req, res, next): Promise<void> => {
  try {
    const user = req.user as any;
    const tid = user.tenantId;
    const accountSelection = await getTenantCompanySelection(req.query as Record<string, unknown>, tid);
    if (accountSelection.error) {
      res.status(400).json({ error: accountSelection.error });
      return;
    }
    const companyIds = accountSelection.companyIds;

    // Summary: distinct correction runs (by run_id in metadata, falling back to
    // minute-level granularity for legacy rows), distinct contacts, last run time.
    const summaryRes = await db.execute(sql`
      SELECT
         COUNT(DISTINCT
           CASE
             WHEN ae.metadata IS NOT NULL
               THEN ae.metadata::jsonb ->> 'runId'
             ELSE to_char(date_trunc('minute', ae.created_at), 'YYYY-MM-DD HH24:MI')
           END
         )                          AS total_runs,
         COUNT(DISTINCT ae.contact_id) AS distinct_contacts,
         MAX(ae.created_at)            AS last_run
       FROM activity_events ae
       WHERE ae.tenant_id = ${tid} AND ae.event_type = 'score_correction'
         ${activityCompanyFilter("ae", companyIds)}
    `);
    const summary = summaryRes.rows[0];

    // Per-event correction rows — all correction events, newest first.
    // Prefer persisted audit values from metadata; fall back to computed estimate
    // for legacy rows that pre-date this audit enhancement.
    const rowsRes = await db.execute(sql`
      SELECT
         ae.id                                                              AS event_id,
         c.id                                                               AS contact_id,
         c.first_name,
         c.last_name,
         c.email,
         COALESCE(
           CASE WHEN ae.metadata IS NOT NULL
                THEN (ae.metadata::jsonb ->> 'oldScore')::int END,
           c.lead_score + COALESCE(bot.bot_inflation, 0)
         )                                                                  AS old_score,
         COALESCE(
           CASE WHEN ae.metadata IS NOT NULL
                THEN (ae.metadata::jsonb ->> 'newScore')::int END,
           c.lead_score
         )                                                                  AS new_score,
         COALESCE(
           CASE WHEN ae.metadata IS NOT NULL
                THEN (ae.metadata::jsonb ->> 'delta')::int END,
           -COALESCE(bot.bot_inflation, 0)
         )                                                                  AS delta,
         ae.created_at                                                      AS corrected_at,
         ae.metadata::jsonb ->> 'runId'                                    AS run_id
       FROM activity_events ae
       JOIN contacts c ON c.id = ae.contact_id AND c.tenant_id = ${tid}
       LEFT JOIN (
         SELECT ae2.contact_id, SUM(COALESCE(ae2.score_delta, 0)) AS bot_inflation
         FROM activity_events ae2
         WHERE ae2.tenant_id = ${tid} AND ae2.is_bot = TRUE
           ${activityCompanyFilter("ae2", companyIds)}
         GROUP BY ae2.contact_id
       ) bot ON bot.contact_id = c.id
       WHERE ae.tenant_id = ${tid} AND ae.event_type = 'score_correction'
         ${activityCompanyFilter("ae", companyIds)}
       ORDER BY ae.created_at DESC
    `);

    res.json({
      summary: {
        totalRuns:        Number(summary.total_runs ?? 0),
        distinctContacts: Number(summary.distinct_contacts ?? 0),
        lastRun:          summary.last_run ?? null,
      },
      corrections: rowsRes.rows,
    });
  } catch (err) { next(err); }
});

// ── POST /analytics/recalculate-scores ───────────────────────────────────────
// Retroactively marks bot-generated email_open activity_events and reverses
// their score inflation. Runs idempotently — safe to call multiple times.
// Criteria: email_open activity_event created within 120s of any enrollment.
router.post("/analytics/recalculate-scores", async (req, res, next): Promise<void> => {
  try {
    const user = req.user as any;
    const tid = user.tenantId;
    const pool = (await import("@workspace/db")).pool;
    const { randomUUID } = await import("crypto");
    const runId = randomUUID();

    // Step 1: Mark bot-generated email_open activity_events
    const flagResult = await pool.query<{ id: number }>(
      `WITH bot_opens AS (
        SELECT ae.id
        FROM activity_events ae
        JOIN sequence_enrollments se ON se.contact_id = ae.contact_id
        WHERE ae.tenant_id = $1
          AND ae.event_type = 'email_open'
          AND ae.is_bot = FALSE
          AND se.enrolled_at IS NOT NULL
          AND ABS(EXTRACT(EPOCH FROM (ae.created_at - se.enrolled_at))) < 120
      )
      UPDATE activity_events
      SET is_bot = TRUE
      WHERE id IN (SELECT id FROM bot_opens)
      RETURNING id`,
      [tid]
    );
    const flaggedCount = flagResult.rows.length;

    // Step 2: Recalculate lead scores, capturing old_score before the update.
    // The "before" CTE snapshots current scores so the delta is accurate even
    // after repeated runs. Returned rows carry both old and new values.
    const recalcResult = await pool.query<{ contact_id: number; new_score: number; old_score: number }>(
      `WITH before AS (
        SELECT id, lead_score AS old_score FROM contacts WHERE tenant_id = $1
      ),
      recalc AS (
        SELECT contact_id,
               GREATEST(0, COALESCE(SUM(CASE WHEN NOT COALESCE(is_bot, false) THEN score_delta ELSE 0 END), 0)) AS new_score
        FROM activity_events
        WHERE tenant_id = $1 AND contact_id IS NOT NULL AND score_delta IS NOT NULL
        GROUP BY contact_id
      ),
      updated AS (
        UPDATE contacts c
        SET lead_score = r.new_score
        FROM recalc r
        WHERE c.id = r.contact_id AND c.tenant_id = $1
          AND c.lead_score != r.new_score
        RETURNING c.id AS contact_id, r.new_score
      )
      SELECT u.contact_id, u.new_score, b.old_score
      FROM updated u
      JOIN before b ON b.id = u.contact_id`,
      [tid]
    );
    const correctedCount = recalcResult.rows.length;

    // Step 3: Log an immutable score_correction audit event per affected contact.
    // Metadata JSON stores correction-time values so the audit trail is stable
    // regardless of future score changes.
    if (correctedCount > 0) {
      const runTs = new Date().toISOString();
      for (const row of recalcResult.rows) {
        const delta = row.new_score - row.old_score;
        const metadata = JSON.stringify({
          runId,
          oldScore:        row.old_score,
          newScore:        row.new_score,
          delta,
          flaggedBotOpens: flaggedCount,
        });
        await pool.query(
          `INSERT INTO activity_events
             (tenant_id, contact_id, event_type, description, score_delta, created_at, is_bot, metadata)
           VALUES ($1, $2, 'score_correction', 'Bot-open score correction applied', 0, $3, FALSE, $4)`,
          [tid, row.contact_id, runTs, metadata]
        ).catch(() => {});
      }
    }

    res.json({
      ok: true,
      flaggedBotOpens: flaggedCount,
      contactsRecalculated: correctedCount,
      message: `Flagged ${flaggedCount} bot email opens, recalculated scores for ${correctedCount} contacts.`,
    });
  } catch (err) { next(err); }
});

// ── POST /admin/recalculate-scores ────────────────────────────────────────────
// Canonical admin path alias — identical logic to /analytics/recalculate-scores.
// Exposed under /api/admin/recalculate-scores via the routes/index.ts mount.
router.post("/admin/recalculate-scores", async (req, res, next): Promise<void> => {
  try {
    const user = req.user as any;
    const tid = user.tenantId;
    const pool = (await import("@workspace/db")).pool;

    const { randomUUID } = await import("crypto");
    const runId = randomUUID();

    // Step 1: Mark bot-generated email_open activity_events
    const flagResult = await pool.query<{ id: number }>(
      `WITH bot_opens AS (
        SELECT ae.id
        FROM activity_events ae
        JOIN sequence_enrollments se ON se.contact_id = ae.contact_id
        WHERE ae.tenant_id = $1
          AND ae.event_type = 'email_open'
          AND ae.is_bot = FALSE
          AND se.enrolled_at IS NOT NULL
          AND ABS(EXTRACT(EPOCH FROM (ae.created_at - se.enrolled_at))) < 120
      )
      UPDATE activity_events
      SET is_bot = TRUE
      WHERE id IN (SELECT id FROM bot_opens)
      RETURNING id`,
      [tid]
    );
    const flaggedCount = flagResult.rows.length;

    // Step 2: Recalculate lead scores capturing old_score before the update
    const recalcResult = await pool.query<{ contact_id: number; new_score: number; old_score: number }>(
      `WITH before AS (
        SELECT id, lead_score AS old_score FROM contacts WHERE tenant_id = $1
      ),
      recalc AS (
        SELECT contact_id,
               GREATEST(0, COALESCE(SUM(CASE WHEN NOT COALESCE(is_bot, false) THEN score_delta ELSE 0 END), 0)) AS new_score
        FROM activity_events
        WHERE tenant_id = $1 AND contact_id IS NOT NULL AND score_delta IS NOT NULL
        GROUP BY contact_id
      ),
      updated AS (
        UPDATE contacts c
        SET lead_score = r.new_score
        FROM recalc r
        WHERE c.id = r.contact_id AND c.tenant_id = $1
          AND c.lead_score != r.new_score
        RETURNING c.id AS contact_id, r.new_score
      )
      SELECT u.contact_id, u.new_score, b.old_score
      FROM updated u
      JOIN before b ON b.id = u.contact_id`,
      [tid]
    );
    const correctedCount = recalcResult.rows.length;

    // Step 3: Log an immutable score_correction audit event per affected contact
    if (correctedCount > 0) {
      const runTs = new Date().toISOString();
      for (const row of recalcResult.rows) {
        const delta = row.new_score - row.old_score;
        const metadata = JSON.stringify({
          runId,
          oldScore:        row.old_score,
          newScore:        row.new_score,
          delta,
          flaggedBotOpens: flaggedCount,
        });
        await pool.query(
          `INSERT INTO activity_events
             (tenant_id, contact_id, event_type, description, score_delta, created_at, is_bot, metadata)
           VALUES ($1, $2, 'score_correction', 'Bot-open score correction applied', 0, $3, FALSE, $4)`,
          [tid, row.contact_id, runTs, metadata]
        ).catch(() => {});
      }
    }

    res.json({
      ok: true,
      flaggedBotOpens: flaggedCount,
      contactsRecalculated: correctedCount,
      message: `Flagged ${flaggedCount} bot email opens, recalculated scores for ${correctedCount} contacts.`,
    });
  } catch (err) { next(err); }
});

// ── GET /analytics/calls/top-opportunities ────────────────────────────────────
// Returns up to 5 calls with completed analysis and interest_score >= 7,
// ordered by interest_score DESC. Used by the Top Opportunities panel.
router.get("/analytics/calls/top-opportunities", async (req, res, next): Promise<void> => {
  try {
    const user = req.user as any;
    const tid = user.tenantId;
    const limit = Math.min(20, Math.max(1, parseInt(String(req.query.limit ?? "5")) || 5));
    const accountSelection = await getTenantCompanySelection(req.query as Record<string, unknown>, tid);
    if (accountSelection.error) {
      res.status(400).json({ error: accountSelection.error });
      return;
    }
    const companyIds = accountSelection.companyIds;
    const hasCompanyArray = companyIds !== null && companyIds.length > 0;
    const limitParam = hasCompanyArray ? "$3" : "$2";

    const pool = (await import("@workspace/db")).pool;

    const rows = await pool.query(
      `SELECT
         cl.id                AS call_log_id,
         c.id                 AS contact_id,
         c.first_name,
         c.last_name,
         c.email,
         co.name              AS company_name,
         cl.outcome,
         cl.started_at,
         cc.name              AS campaign_name,
         ca.id                AS analysis_id,
         ca.sentiment,
         ca.interest_score,
         ca.interest_justification,
         ca.recommended_action,
         ca.action_timing,
         ca.owning_team,
         ca.follow_up_message
       FROM call_analysis ca
       LEFT JOIN call_logs cl      ON cl.id = ca.call_log_id AND cl.tenant_id = ca.tenant_id
        LEFT JOIN contacts c        ON c.id  = COALESCE(cl.contact_id, ca.contact_id) AND c.tenant_id = ca.tenant_id
       LEFT JOIN companies co      ON co.id = c.company_id
       LEFT JOIN call_campaigns cc ON cc.id = cl.campaign_id
       WHERE ca.tenant_id = $1
         AND ca.status    = 'completed'
         AND ca.interest_score >= 7
         ${rawContactCompanyFilter("COALESCE(cl.contact_id, ca.contact_id)", companyIds)}
       ORDER BY ca.interest_score DESC, ca.created_at DESC
       LIMIT ${limitParam}`,
      hasCompanyArray ? [tid, companyIds, limit] : [tid, limit]
    );

    res.json({ opportunities: rows.rows });
  } catch (err) { next(err); }
});

// ── GET /analytics/calls/recent ───────────────────────────────────────────────
// Paginated recent call logs with phone number.
router.get("/analytics/calls/recent", async (req, res, next): Promise<void> => {
  try {
    const user = req.user as any;
    const tid = user.tenantId;
    const PAGE_SIZE = 20;
    const page = Math.max(1, parseInt(String(req.query.page ?? "1")) || 1);
    const offset = (page - 1) * PAGE_SIZE;
    const accountSelection = await getTenantCompanySelection(req.query as Record<string, unknown>, tid);
    if (accountSelection.error) {
      res.status(400).json({ error: accountSelection.error });
      return;
    }
    const companyIds = accountSelection.companyIds;
    const hasCompanyArray = companyIds !== null && companyIds.length > 0;
    const accountParams = hasCompanyArray ? [tid, companyIds] : [tid];
    const limitParam = `$${accountParams.length + 1}`;
    const offsetParam = `$${accountParams.length + 2}`;

    const pool = (await import("@workspace/db")).pool;

    const [rowsRes, countRes] = await Promise.all([
      pool.query(
        `SELECT cl.id, c.id AS contact_id, c.first_name, c.last_name, c.email, c.phone,
                co.name AS company_name,
                cl.outcome, cl.duration_seconds, cl.started_at, cl.ended_reason,
                cl.transcript, cl.recording_url, cl.ai_summary, cl.ai_next_steps,
                cc.name AS campaign_name,
                ca.id              AS analysis_id,
                ca.status          AS analysis_status,
                ca.call_summary    AS llm_call_summary,
                ca.prospect_profile,
                ca.key_highlights,
                ca.sentiment,
                ca.sentiment_justification,
                ca.interest_score,
                ca.interest_justification,
                ca.recommended_action,
                ca.owning_team,
                ca.action_reason,
                ca.action_timing,
                ca.follow_up_message
         FROM call_logs cl
         LEFT JOIN contacts c ON c.id = cl.contact_id AND c.tenant_id = cl.tenant_id
         LEFT JOIN companies co ON co.id = c.company_id
         LEFT JOIN call_campaigns cc ON cc.id = cl.campaign_id
         LEFT JOIN call_analysis ca ON ca.call_log_id = cl.id
         WHERE cl.tenant_id = $1
           ${rawContactCompanyFilter("cl.contact_id", companyIds)}
         ORDER BY cl.created_at DESC
         LIMIT ${limitParam} OFFSET ${offsetParam}`,
        [...accountParams, PAGE_SIZE, offset]
      ),
      pool.query<{ total: string }>(
        `SELECT COUNT(*)::int AS total FROM call_logs cl
         WHERE cl.tenant_id = $1 ${rawContactCompanyFilter("cl.contact_id", companyIds)}`,
        accountParams
      ),
    ]);

    res.json({
      calls: rowsRes.rows,
      total: parseInt(countRes.rows[0]?.total ?? "0"),
      page,
      pageSize: PAGE_SIZE,
    });
  } catch (err) { next(err); }
});

// ── GET /analytics/calls/export — full export payload (all rows, no pagination)
router.get("/analytics/calls/export", async (req, res, next): Promise<void> => {
  try {
    const user = req.user as any;
    const tid = user.tenantId;
    const accountSelection = await getTenantCompanySelection(req.query as Record<string, unknown>, tid);
    if (accountSelection.error) {
      res.status(400).json({ error: accountSelection.error });
      return;
    }
    const companyIds = accountSelection.companyIds;
    const accountParams = companyIds !== null && companyIds.length > 0 ? [tid, companyIds] : [tid];
    const pool = (await import("@workspace/db")).pool;

    const rows = await pool.query(
      `SELECT
         cl.id,
         c.first_name, c.last_name, c.email, c.phone,
         co.name              AS company_name,
         cl.outcome,
         cl.duration_seconds,
         cl.started_at,
         cl.ended_at,
         cl.transcript,
         cl.recording_url,
         cl.ai_summary,
         cl.ai_next_steps,
         cc.name              AS campaign_name,
         ca.call_summary      AS llm_call_summary,
         ca.sentiment,
         ca.sentiment_justification,
         ca.interest_score,
         ca.interest_justification,
         ca.recommended_action,
         ca.owning_team,
         ca.action_reason,
         ca.action_timing,
         ca.follow_up_message
       FROM call_logs cl
       LEFT JOIN contacts c        ON c.id  = cl.contact_id AND c.tenant_id = cl.tenant_id
       LEFT JOIN companies co      ON co.id = c.company_id
       LEFT JOIN call_campaigns cc ON cc.id = cl.campaign_id
       LEFT JOIN call_analysis ca  ON ca.call_log_id = cl.id
       WHERE cl.tenant_id = $1
         ${rawContactCompanyFilter("cl.contact_id", companyIds)}
       ORDER BY cl.created_at DESC`,
      accountParams,
    );

    res.json({ calls: rows.rows });
  } catch (err) { next(err); }
});

// ── GET /analytics/calls ──────────────────────────────────────────────────────
router.get("/analytics/calls", async (req, res, next): Promise<void> => {
  try {
    const user = req.user as any;
    const tid = user.tenantId;
    const accountSelection = await getTenantCompanySelection(req.query as Record<string, unknown>, tid);
    if (accountSelection.error) {
      res.status(400).json({ error: accountSelection.error });
      return;
    }
    const companyIds = accountSelection.companyIds;
    const accountParams = companyIds !== null && companyIds.length > 0 ? [tid, companyIds] : [tid];

    const pool = (await import("@workspace/db")).pool;

    const [kpiRes, outcomeRes, campaignRes, recentRes, intelligenceRes] = await Promise.all([
      // KPIs
      pool.query<{
        total_calls: string; connected: string; interested: string;
        avg_duration: string; total_campaigns: string;
      }>(
        `SELECT
           COUNT(cl.id)                                            AS total_calls,
           COUNT(cl.id) FILTER (WHERE cl.duration_seconds > 5)    AS connected,
           COUNT(cl.id) FILTER (WHERE cl.outcome = 'interested')  AS interested,
           ROUND(AVG(cl.duration_seconds) FILTER (WHERE cl.duration_seconds > 0))::int AS avg_duration,
           COUNT(DISTINCT cl.campaign_id)                         AS total_campaigns
         FROM call_logs cl
         WHERE cl.tenant_id = $1 ${rawContactCompanyFilter("cl.contact_id", companyIds)}`,
        accountParams
      ),
      // Outcome breakdown
      pool.query<{ outcome: string; cnt: string }>(
        `SELECT COALESCE(cl.outcome, 'unknown') AS outcome, COUNT(*)::int AS cnt
         FROM call_logs cl
         WHERE cl.tenant_id = $1 AND cl.outcome IS NOT NULL
           ${rawContactCompanyFilter("cl.contact_id", companyIds)}
         GROUP BY cl.outcome ORDER BY cnt DESC`,
        accountParams
      ),
      // Per-campaign stats
      pool.query<{
        id: string; name: string; status: string;
        total: string; done: string; interested: string; callback: string;
      }>(
        `SELECT cc.id, cc.name, cc.status,
                COUNT(cl.id)::int                                    AS total,
                COUNT(cl.id) FILTER (WHERE cl.status='completed')::int AS done,
                COUNT(cl.id) FILTER (WHERE cl.outcome='interested')::int AS interested,
                COUNT(cl.id) FILTER (WHERE cl.outcome='callback')::int   AS callback
         FROM call_campaigns cc
         LEFT JOIN call_logs cl ON cl.campaign_id = cc.id AND cl.tenant_id = cc.tenant_id
           ${rawContactCompanyFilter("cl.contact_id", companyIds)}
         WHERE cc.tenant_id = $1
           ${companyIds !== null ? "AND cl.id IS NOT NULL" : ""}
         GROUP BY cc.id ORDER BY cc.created_at DESC LIMIT 10`,
        accountParams
      ),
      // Recent call logs — LEFT JOIN call_analysis for intelligence data
      pool.query(
        `SELECT cl.id, c.id AS contact_id, c.first_name, c.last_name, c.email,
                co.name AS company_name,
                cl.outcome, cl.duration_seconds, cl.started_at, cl.ended_reason,
                cl.transcript, cl.recording_url, cl.ai_summary, cl.ai_next_steps,
                cc.name AS campaign_name,
                ca.id              AS analysis_id,
                ca.status          AS analysis_status,
                ca.call_summary    AS llm_call_summary,
                ca.prospect_profile,
                ca.key_highlights,
                ca.sentiment,
                ca.sentiment_justification,
                ca.interest_score,
                ca.interest_justification,
                ca.recommended_action,
                ca.owning_team,
                ca.action_reason,
                ca.action_timing,
                ca.follow_up_message
         FROM call_logs cl
         LEFT JOIN contacts c ON c.id = cl.contact_id AND c.tenant_id = cl.tenant_id
         LEFT JOIN companies co ON co.id = c.company_id
         LEFT JOIN call_campaigns cc ON cc.id = cl.campaign_id
         LEFT JOIN call_analysis ca ON ca.call_log_id = cl.id
         WHERE cl.tenant_id = $1
           ${rawContactCompanyFilter("cl.contact_id", companyIds)}
         ORDER BY cl.created_at DESC LIMIT 20`,
        accountParams
      ),
      // Intelligence KPIs (from completed analyses)
      pool.query<{
        analysed: string; avg_score: string;
        positive: string; neutral: string; negative: string;
        sales_actions: string; marketing_actions: string;
      }>(
        `SELECT
           COUNT(ca.id)                                              AS analysed,
           ROUND(AVG(ca.interest_score))::int                       AS avg_score,
           COUNT(ca.id) FILTER (WHERE ca.sentiment = 'positive')    AS positive,
           COUNT(ca.id) FILTER (WHERE ca.sentiment = 'neutral')     AS neutral,
           COUNT(ca.id) FILTER (WHERE ca.sentiment = 'negative')    AS negative,
           COUNT(ca.id) FILTER (WHERE ca.owning_team = 'sales')     AS sales_actions,
           COUNT(ca.id) FILTER (WHERE ca.owning_team = 'marketing') AS marketing_actions
         FROM call_analysis ca
         WHERE ca.tenant_id = $1 AND ca.status = 'completed'
           ${rawContactCompanyFilter(rawCallAnalysisContactColumn("ca"), companyIds)}`,
        accountParams
      ),
    ]);

    const kpi = kpiRes.rows[0] ?? {};
    const totalCalls     = parseInt(kpi.total_calls     ?? "0");
    const connected      = parseInt(kpi.connected       ?? "0");
    const interested     = parseInt(kpi.interested      ?? "0");
    const completedCalls = outcomeRes.rows.reduce((s, r) => s + parseInt(r.cnt ?? "0"), 0);
    const intel = intelligenceRes.rows[0] ?? {};

    res.json({
      kpi: {
        totalCalls,
        connected,
        interested,
        avgDuration:     parseInt(kpi.avg_duration    ?? "0"),
        totalCampaigns:  parseInt(kpi.total_campaigns ?? "0"),
        connectionRate:  totalCalls > 0 ? Math.round((connected / totalCalls) * 100) : 0,
        completionRate:  totalCalls > 0 ? Math.round((completedCalls / totalCalls) * 100) : 0,
      },
      outcomeBreakdown: outcomeRes.rows.map(r => ({ outcome: r.outcome, count: parseInt(r.cnt) })),
      campaigns: campaignRes.rows,
      recentCalls: recentRes.rows,
      intelligence: {
        analysed:        parseInt(intel.analysed        ?? "0"),
        avgInterestScore: parseInt(intel.avg_score      ?? "0"),
        sentimentBreakdown: {
          positive: parseInt(intel.positive ?? "0"),
          neutral:  parseInt(intel.neutral  ?? "0"),
          negative: parseInt(intel.negative ?? "0"),
        },
        teamBreakdown: {
          sales:     parseInt(intel.sales_actions     ?? "0"),
          marketing: parseInt(intel.marketing_actions ?? "0"),
        },
      },
    });
  } catch (err) { next(err); }
});

// ── POST /analytics/calls/:callLogId/analyse ──────────────────────────────────
// Trigger (or re-trigger) LLM analysis for a specific call log.
router.post("/analytics/calls/:callLogId/analyse", async (req, res, next): Promise<void> => {
  try {
    const user = req.user as any;
    const callLogId = parseInt(req.params.callLogId);
    if (isNaN(callLogId)) { res.status(400).json({ error: "Invalid callLogId" }); return; }

    const pool = (await import("@workspace/db")).pool;

    const logRows = await pool.query(
      `SELECT cl.id, cl.transcript, cl.outcome, cl.duration_seconds, cl.contact_id,
              c.first_name, c.last_name, co.name AS company_name
       FROM call_logs cl
       LEFT JOIN contacts c  ON c.id  = cl.contact_id AND c.tenant_id = cl.tenant_id
       LEFT JOIN companies co ON co.id = c.company_id
       WHERE cl.id = $1 AND cl.tenant_id = $2`,
      [callLogId, user.tenantId],
    );
    const log = logRows.rows[0];
    if (!log) { res.status(404).json({ error: "Call log not found" }); return; }

    const transcriptText: string = (() => {
      const tx = log.transcript;
      if (!tx) return "";
      if (typeof tx === "string") {
        try { const p = JSON.parse(tx); return p?.text ?? tx; } catch { return tx; }
      }
      if (Array.isArray(tx)) return (tx as any[]).map((m: any) => `${m.role ?? "unknown"}: ${m.content ?? ""}`).join("\n");
      return (tx as any)?.text ?? "";
    })();

    if (!transcriptText) {
      res.status(422).json({ error: "No transcript available for this call" });
      return;
    }

    const contactName = [log.first_name, log.last_name].filter(Boolean).join(" ") || "The contact";

    // Respond immediately — analysis runs in background
    res.json({ ok: true, message: "LLM analysis queued" });

    const { analyseTranscriptLLM } = await import("../lib/transcriptAnalyserLLM");
    analyseTranscriptLLM({
      callLogId,
      tenantId: user.tenantId,
      contactId: log.contact_id ?? null,
      transcript: transcriptText,
      outcome: log.outcome ?? null,
      durationSeconds: log.duration_seconds != null ? Number(log.duration_seconds) : null,
      contactName,
      companyName: log.company_name ?? null,
    }).catch(err => {
      logger.warn({ err, callLogId }, "Background LLM analysis failed");
    });
  } catch (err) { next(err); }
});

// ── GET /analytics/calls/:callLogId/analysis ──────────────────────────────────
// Fetch persisted call_analysis for a call log.
router.get("/analytics/calls/:callLogId/analysis", async (req, res, next): Promise<void> => {
  try {
    const user = req.user as any;
    const callLogId = parseInt(req.params.callLogId);
    if (isNaN(callLogId)) { res.status(400).json({ error: "Invalid callLogId" }); return; }

    const pool = (await import("@workspace/db")).pool;

    // Verify the call log belongs to this tenant
    const logCheck = await pool.query(
      `SELECT id FROM call_logs WHERE id = $1 AND tenant_id = $2`,
      [callLogId, user.tenantId],
    );
    if (!logCheck.rows[0]) { res.status(404).json({ error: "Call log not found" }); return; }

    const rows = await pool.query(
      `SELECT * FROM call_analysis WHERE call_log_id = $1 AND tenant_id = $2`,
      [callLogId, user.tenantId],
    );
    if (!rows.rows[0]) {
      res.status(404).json({ error: "No analysis found for this call" });
      return;
    }
    res.json(rows.rows[0]);
  } catch (err) { next(err); }
});

// ── GET /analytics/call-intelligence ──────────────────────────────────────────
// Paginated, filterable list of all call analyses for the tenant.
// Query params: page, limit, sentiment, owning_team, score_min, score_max, status, search
router.get("/analytics/call-intelligence", async (req, res, next): Promise<void> => {
  try {
    const user = req.user as any;
    const tid = user.tenantId;
    const accountSelection = await getTenantCompanySelection(req.query as Record<string, unknown>, tid);
    if (accountSelection.error) {
      res.status(400).json({ error: accountSelection.error });
      return;
    }
    const companyIds = accountSelection.companyIds;
    const pool = (await import("@workspace/db")).pool;

    const page      = Math.max(1, parseInt(String(req.query.page ?? "1")));
    const limit     = Math.min(50, Math.max(1, parseInt(String(req.query.limit ?? "20"))));
    const offset    = (page - 1) * limit;
    const sentiment = String(req.query.sentiment ?? "");
    const team      = String(req.query.owning_team ?? "");
    const scoreMin  = req.query.score_min ? parseInt(String(req.query.score_min)) : null;
    const scoreMax  = req.query.score_max ? parseInt(String(req.query.score_max)) : null;
    const status    = String(req.query.status ?? "");
    const search    = String(req.query.search ?? "").trim();

    const dateFrom = String(req.query.dateFrom ?? req.query.date_from ?? "").trim();
    const dateTo   = String(req.query.dateTo   ?? req.query.date_to   ?? "").trim();

    const conditions: string[] = ["ca.tenant_id = $1"];
    const params: unknown[] = [tid];
    let idx = 2;
    if (companyIds !== null) {
      if (!companyIds.length) {
        conditions.push("FALSE");
      } else {
        conditions.push(rawContactCompanyFilter(rawCallAnalysisContactColumn("ca"), companyIds, idx).replace(/^AND /, ""));
        params.push(companyIds);
        idx++;
      }
    }

    if (sentiment)                    { conditions.push(`ca.sentiment = $${idx++}`);    params.push(sentiment); }
    if (team)                         { conditions.push(`ca.owning_team = $${idx++}`);  params.push(team); }
    if (scoreMin != null && !isNaN(scoreMin)) { conditions.push(`ca.interest_score >= $${idx++}`); params.push(scoreMin); }
    if (scoreMax != null && !isNaN(scoreMax)) { conditions.push(`ca.interest_score <= $${idx++}`); params.push(scoreMax); }
    // status param maps to call outcome (not analysis processing status)
    const callOutcomeConditions: Record<string, string> = {
      answered:    `(cl.outcome = 'answered' AND COALESCE(cl.duration_seconds, 0) >= 30)`,
      short_call:  `(cl.outcome = 'answered' AND COALESCE(cl.duration_seconds, 0) < 30)`,
      not_answered:`(cl.outcome IS NULL AND COALESCE(cl.ended_reason, '') NOT IN ('voicemail', 'customer-busy', 'busy'))`,
      voicemail:   `cl.ended_reason = 'voicemail'`,
      busy:        `cl.ended_reason IN ('customer-busy', 'busy', 'no-answer', 'customer-did-not-give-microphone-permission')`,
    };
    if (status && callOutcomeConditions[status]) {
      conditions.push(callOutcomeConditions[status]);
    }
    if (dateFrom) { conditions.push(`ca.created_at >= ($${idx++}::date::timestamp AT TIME ZONE 'Asia/Kolkata')`); params.push(dateFrom); }
    if (dateTo)   { conditions.push(`ca.created_at < (($${idx++}::date + 1)::timestamp AT TIME ZONE 'Asia/Kolkata')`); params.push(dateTo); }
    if (search) {
      conditions.push(`(c.first_name ILIKE $${idx} OR c.last_name ILIKE $${idx} OR c.email ILIKE $${idx} OR co.name ILIKE $${idx} OR ca.recommended_action ILIKE $${idx})`);
      params.push(`%${search}%`); idx++;
    }

    const where = conditions.join(" AND ");

    const [listRes, countRes] = await Promise.all([
      pool.query(
        `SELECT
           ca.id, ca.call_log_id, ca.contact_id, ca.status,
           ca.call_summary, ca.prospect_profile, ca.key_highlights,
           ca.sentiment, ca.sentiment_justification,
           ca.interest_score, ca.interest_justification,
           ca.recommended_action, ca.owning_team, ca.action_reason, ca.action_timing,
           ca.follow_up_message, ca.error_message,
           ca.processed_at, ca.created_at,
           c.first_name, c.last_name, c.email,
           co.name AS company_name,
           cl.outcome, cl.duration_seconds, cl.started_at, cl.ended_reason,
           cl.recording_url, cl.ai_summary,
           cc.name AS campaign_name
         FROM call_analysis ca
         LEFT JOIN call_logs cl      ON cl.id = ca.call_log_id AND cl.tenant_id = ca.tenant_id
         LEFT JOIN contacts c        ON c.id  = COALESCE(cl.contact_id, ca.contact_id) AND c.tenant_id = ca.tenant_id
         LEFT JOIN companies co      ON co.id = c.company_id
         LEFT JOIN call_campaigns cc ON cc.id = cl.campaign_id
         WHERE ${where}
         ORDER BY ca.created_at DESC
         LIMIT $${idx} OFFSET $${idx + 1}`,
        [...params, limit, offset],
      ),
      pool.query<{ total: string }>(
        `SELECT COUNT(*)::int AS total
         FROM call_analysis ca
         LEFT JOIN call_logs cl  ON cl.id = ca.call_log_id AND cl.tenant_id = ca.tenant_id
         LEFT JOIN contacts c    ON c.id  = COALESCE(cl.contact_id, ca.contact_id) AND c.tenant_id = ca.tenant_id
         LEFT JOIN companies co  ON co.id = c.company_id
         WHERE ${where}`,
        params,
      ),
    ]);

    const total = parseInt(countRes.rows[0]?.total ?? "0");
    res.json({
      items: listRes.rows,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (err) { next(err); }
});

// ── GET /analytics/call-intelligence/aggregate ───────────────────────────────
// Aggregate KPIs for the Call Intelligence section.
router.get("/analytics/call-intelligence/aggregate", async (req, res, next): Promise<void> => {
  try {
    const user = req.user as any;
    const tid = user.tenantId;
    const accountSelection = await getTenantCompanySelection(req.query as Record<string, unknown>, tid);
    if (accountSelection.error) {
      res.status(400).json({ error: accountSelection.error });
      return;
    }
    const companyIds = accountSelection.companyIds;
    const accountFilter = rawContactCompanyFilter(rawCallAnalysisContactColumn("ca"), companyIds);
    const accountParams = companyIds !== null && companyIds.length > 0 ? [tid, companyIds] : [tid];
    const pool = (await import("@workspace/db")).pool;

    const [summaryRes, scoreDistRes, timingRes, failedRes, callsOverTimeRes, salesVsMktRes] = await Promise.all([
      // Overall KPIs
      pool.query<{
        total: string; completed: string; failed: string; processing: string;
        avg_score: string;
        positive: string; neutral: string; negative: string;
        sales_ct: string; marketing_ct: string;
        hot: string; warm: string; cold: string;
      }>(
        `SELECT
           COUNT(*)::int                                                   AS total,
           COUNT(*) FILTER (WHERE status = 'completed')::int              AS completed,
           COUNT(*) FILTER (WHERE status = 'failed')::int                 AS failed,
           COUNT(*) FILTER (WHERE status = 'processing')::int             AS processing,
           COALESCE(ROUND(AVG(interest_score) FILTER (WHERE status = 'completed')), 0)::int AS avg_score,
           COUNT(*) FILTER (WHERE sentiment = 'positive')::int            AS positive,
           COUNT(*) FILTER (WHERE sentiment = 'neutral')::int             AS neutral,
           COUNT(*) FILTER (WHERE sentiment = 'negative')::int            AS negative,
           COUNT(*) FILTER (WHERE owning_team = 'sales')::int             AS sales_ct,
           COUNT(*) FILTER (WHERE owning_team = 'marketing')::int         AS marketing_ct,
           COUNT(*) FILTER (WHERE interest_score >= 7)::int               AS hot,
           COUNT(*) FILTER (WHERE interest_score >= 4 AND interest_score <= 6)::int AS warm,
           COUNT(*) FILTER (WHERE interest_score <= 3)::int               AS cold
         FROM call_analysis ca
         WHERE ca.tenant_id = $1 ${accountFilter}`,
        accountParams,
      ),
      // Interest score distribution (1-10)
      pool.query<{ score: string; count: string }>(
        `SELECT interest_score::text AS score, COUNT(*)::int AS count
         FROM call_analysis ca
         WHERE ca.tenant_id = $1 AND ca.status = 'completed' AND ca.interest_score IS NOT NULL
           ${accountFilter}
         GROUP BY ca.interest_score ORDER BY ca.interest_score`,
        accountParams,
      ),
      // Action timing breakdown (for pie/bar chart)
      pool.query<{ timing: string; count: string }>(
        `SELECT COALESCE(action_timing, 'unknown') AS timing, COUNT(*)::int AS count
         FROM call_analysis ca
         WHERE ca.tenant_id = $1 AND ca.status = 'completed'
           ${accountFilter}
         GROUP BY ca.action_timing ORDER BY count DESC`,
        accountParams,
      ),
      // Recent failures
      pool.query(
        `SELECT ca.id, ca.call_log_id, ca.error_message, ca.created_at,
                c.first_name, c.last_name
         FROM call_analysis ca
         LEFT JOIN contacts c ON c.id = ${rawCallAnalysisContactColumn("ca")} AND c.tenant_id = ca.tenant_id
         WHERE ca.tenant_id = $1 AND ca.status = 'failed'
           ${accountFilter}
         ORDER BY ca.created_at DESC LIMIT 5`,
        accountParams,
      ),
      // Calls analysed over time — daily for last 30 days (line chart)
      pool.query<{ day: string; completed: string; failed: string }>(
        `SELECT
           TO_CHAR((created_at AT TIME ZONE 'Asia/Kolkata')::date, 'YYYY-MM-DD') AS day,
           COUNT(*) FILTER (WHERE status = 'completed')::int AS completed,
           COUNT(*) FILTER (WHERE status = 'failed')::int    AS failed
         FROM call_analysis ca
         WHERE ca.tenant_id = $1
           AND ca.created_at >= NOW() - INTERVAL '30 days'
           ${accountFilter}
         GROUP BY day
         ORDER BY day`,
        accountParams,
      ),
      // Sales vs Marketing action timing stacked bar
      // Rows: { owning_team, action_timing, count }
      pool.query<{ owning_team: string; timing: string; count: string }>(
        `SELECT
           COALESCE(owning_team, 'unknown')   AS owning_team,
           COALESCE(action_timing, 'unknown') AS timing,
           COUNT(*)::int AS count
         FROM call_analysis ca
         WHERE ca.tenant_id = $1 AND ca.status = 'completed'
           ${accountFilter}
         GROUP BY ca.owning_team, ca.action_timing
         ORDER BY ca.owning_team, count DESC`,
        accountParams,
      ),
    ]);

    // Build callsOverTime as a sorted array with zero-fill placeholders
    const cotMap: Record<string, { completed: number; failed: number }> = {};
    for (const r of callsOverTimeRes.rows) {
      cotMap[r.day] = { completed: parseInt(r.completed), failed: parseInt(r.failed) };
    }

    // Sales vs Marketing stacked bar: pivot into { timing, sales, marketing } rows
    const salesVsMktPivot: Record<string, { sales: number; marketing: number }> = {};
    for (const r of salesVsMktRes.rows) {
      if (!salesVsMktPivot[r.timing]) salesVsMktPivot[r.timing] = { sales: 0, marketing: 0 };
      const team = r.owning_team === "sales" ? "sales" : "marketing";
      salesVsMktPivot[r.timing][team] = parseInt(r.count);
    }

    const s = summaryRes.rows[0] ?? {};
    res.json({
      summary: {
        total:       parseInt(s.total      ?? "0"),
        completed:   parseInt(s.completed  ?? "0"),
        failed:      parseInt(s.failed     ?? "0"),
        processing:  parseInt(s.processing ?? "0"),
        avgScore:    parseInt(s.avg_score  ?? "0"),
        sentimentBreakdown: {
          positive: parseInt(s.positive ?? "0"),
          neutral:  parseInt(s.neutral  ?? "0"),
          negative: parseInt(s.negative ?? "0"),
        },
        teamBreakdown: {
          sales:     parseInt(s.sales_ct     ?? "0"),
          marketing: parseInt(s.marketing_ct ?? "0"),
        },
        scoreBands: {
          hot:  parseInt(s.hot  ?? "0"),
          warm: parseInt(s.warm ?? "0"),
          cold: parseInt(s.cold ?? "0"),
        },
      },
      scoreDistribution: scoreDistRes.rows.map(r => ({
        score: parseInt(r.score),
        count: parseInt(r.count),
      })),
      actionTimingBreakdown: timingRes.rows.map(r => ({
        timing: r.timing,
        count: parseInt(r.count),
      })),
      recentFailures: failedRes.rows,
      callsOverTime: Object.entries(cotMap)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([day, v]) => ({ day, ...v })),
      salesVsMarketing: Object.entries(salesVsMktPivot)
        .map(([timing, v]) => ({ timing, sales: v.sales, marketing: v.marketing }))
        .sort((a, b) => (b.sales + b.marketing) - (a.sales + a.marketing)),
    });
  } catch (err) { next(err); }
});

// ── Shared helpers for detail + rerun routes ──────────────────────────────────

async function fetchAnalysisDetail(tenantId: number, where: string, param: number): Promise<any | null> {
  const pool = (await import("@workspace/db")).pool;
  const rows = await pool.query(
    `SELECT
       ca.*,
       c.first_name, c.last_name, c.email, c.lead_score,
       co.name AS company_name,
       cl.outcome, cl.duration_seconds, cl.started_at, cl.ended_reason,
       cl.transcript, cl.recording_url, cl.ai_summary, cl.ai_next_steps,
       cc.name AS campaign_name
     FROM call_analysis ca
     LEFT JOIN call_logs cl      ON cl.id = ca.call_log_id
     LEFT JOIN contacts c        ON c.id  = ca.contact_id AND c.tenant_id = ca.tenant_id
     LEFT JOIN companies co      ON co.id = c.company_id
     LEFT JOIN call_campaigns cc ON cc.id = cl.campaign_id
     WHERE ca.${where} = $1 AND ca.tenant_id = $2`,
    [param, tenantId],
  );
  return rows.rows[0] ?? null;
}

// ── GET /analytics/call-intelligence/:id ──────────────────────────────────────
// Primary (spec): Fetch full analysis detail by analysis row id.
// Registered after /aggregate, so the literal /aggregate path matches first.
router.get("/analytics/call-intelligence/:id", async (req, res, next): Promise<void> => {
  try {
    const user = req.user as any;
    const id = parseInt(req.params.id);
    if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
    const row = await fetchAnalysisDetail(user.tenantId, "id", id);
    if (!row) { res.status(404).json({ error: "Analysis not found" }); return; }
    res.json(row);
  } catch (err) { next(err); }
});

// ── POST /analytics/call-intelligence/:id/rerun ───────────────────────────────
// Primary (spec): Re-trigger LLM analysis by analysis row id.
router.post("/analytics/call-intelligence/:id/rerun", async (req, res, next): Promise<void> => {
  try {
    const user = req.user as any;
    const id = parseInt(req.params.id);
    if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

    const pool = (await import("@workspace/db")).pool;
    // Resolve call_log_id from analysis row id
    const aRes = await pool.query(`SELECT call_log_id FROM call_analysis WHERE id = $1 AND tenant_id = $2`, [id, user.tenantId]);
    if (!aRes.rows[0]) { res.status(404).json({ error: "Analysis not found" }); return; }
    const callLogId: number = parseInt(aRes.rows[0].call_log_id);

    const logRows = await pool.query(
      `SELECT cl.id, cl.transcript, cl.outcome, cl.duration_seconds, cl.contact_id,
              c.first_name, c.last_name, co.name AS company_name
       FROM call_logs cl
       LEFT JOIN contacts c   ON c.id  = cl.contact_id AND c.tenant_id = cl.tenant_id
       LEFT JOIN companies co ON co.id = c.company_id
       WHERE cl.id = $1 AND cl.tenant_id = $2`,
      [callLogId, user.tenantId],
    );
    const log = logRows.rows[0];
    if (!log) { res.status(404).json({ error: "Call log not found" }); return; }

    const transcriptText: string = (() => {
      const tx = log.transcript;
      if (!tx) return "";
      if (typeof tx === "string") {
        try { const p = JSON.parse(tx); if (Array.isArray(p)) return p.map((m: any) => `${m.role ?? "unknown"}: ${m.content ?? ""}`).join("\n"); return p?.text ?? tx; } catch { return tx; }
      }
      if (Array.isArray(tx)) return (tx as any[]).map((m: any) => `${m.role ?? "unknown"}: ${m.content ?? ""}`).join("\n");
      return (tx as any)?.text ?? "";
    })();

    const contactName = [log.first_name, log.last_name].filter(Boolean).join(" ") || "The contact";
    res.json({ ok: true, message: "LLM analysis requeued" });

    const { analyseTranscriptLLM } = await import("../lib/transcriptAnalyserLLM");
    analyseTranscriptLLM({
      callLogId,
      tenantId: user.tenantId,
      contactId: log.contact_id ?? null,
      transcript: transcriptText,
      outcome: log.outcome ?? null,
      durationSeconds: log.duration_seconds != null ? Number(log.duration_seconds) : null,
      contactName,
      companyName: log.company_name ?? null,
    }).catch((err: any) => {
      logger.warn({ err, callLogId }, "Background LLM rerun (by id) failed");
    });
  } catch (err) { next(err); }
});

// ── GET /analytics/call-intelligence/by-call/:callLogId ───────────────────────
// Compat alias: Fetch full analysis detail by call_log_id.
router.get("/analytics/call-intelligence/by-call/:callLogId", async (req, res, next): Promise<void> => {
  try {
    const user = req.user as any;
    const callLogId = parseInt(req.params.callLogId);
    if (isNaN(callLogId)) { res.status(400).json({ error: "Invalid callLogId" }); return; }
    const row = await fetchAnalysisDetail(user.tenantId, "call_log_id", callLogId);
    if (!row) { res.status(404).json({ error: "No analysis found for this call" }); return; }
    res.json(row);
  } catch (err) { next(err); }
});

// ── POST /analytics/call-intelligence/by-call/:callLogId/rerun ────────────────
// Compat alias: Re-trigger LLM analysis by call_log_id.
router.post("/analytics/call-intelligence/by-call/:callLogId/rerun", async (req, res, next): Promise<void> => {
  try {
    const user = req.user as any;
    const callLogId = parseInt(req.params.callLogId);
    if (isNaN(callLogId)) { res.status(400).json({ error: "Invalid callLogId" }); return; }

    const pool = (await import("@workspace/db")).pool;

    const logRows = await pool.query(
      `SELECT cl.id, cl.transcript, cl.outcome, cl.duration_seconds, cl.contact_id,
              c.first_name, c.last_name, co.name AS company_name
       FROM call_logs cl
       LEFT JOIN contacts c   ON c.id  = cl.contact_id AND c.tenant_id = cl.tenant_id
       LEFT JOIN companies co ON co.id = c.company_id
       WHERE cl.id = $1 AND cl.tenant_id = $2`,
      [callLogId, user.tenantId],
    );
    const log = logRows.rows[0];
    if (!log) { res.status(404).json({ error: "Call log not found" }); return; }

    const transcriptText: string = (() => {
      const tx = log.transcript;
      if (!tx) return "";
      if (typeof tx === "string") {
        try { const p = JSON.parse(tx); if (Array.isArray(p)) return p.map((m: any) => `${m.role ?? "unknown"}: ${m.content ?? ""}`).join("\n"); return p?.text ?? tx; } catch { return tx; }
      }
      if (Array.isArray(tx)) return (tx as any[]).map((m: any) => `${m.role ?? "unknown"}: ${m.content ?? ""}`).join("\n");
      return (tx as any)?.text ?? "";
    })();

    if (!transcriptText) {
      res.status(422).json({ error: "No transcript available for this call" });
      return;
    }

    const contactName = [log.first_name, log.last_name].filter(Boolean).join(" ") || "The contact";

    res.json({ ok: true, message: "LLM analysis requeued" });

    const { analyseTranscriptLLM } = await import("../lib/transcriptAnalyserLLM");
    analyseTranscriptLLM({
      callLogId,
      tenantId: user.tenantId,
      contactId: log.contact_id ?? null,
      transcript: transcriptText,
      outcome: log.outcome ?? null,
      durationSeconds: log.duration_seconds != null ? Number(log.duration_seconds) : null,
      contactName,
      companyName: log.company_name ?? null,
    }).catch((err: any) => {
      logger.warn({ err, callLogId }, "Background LLM rerun failed");
    });
  } catch (err) { next(err); }
});

export default router;
