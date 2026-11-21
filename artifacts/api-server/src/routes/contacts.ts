import { Router, type IRouter } from "express";
import { z } from "zod";
import { and, asc, desc, eq, gte, ilike, inArray, lte, or, sql } from "drizzle-orm";
import { db, pool, contactsTable, companiesTable, activityEventsTable, emailSequencesTable, sequenceEnrollmentsTable, sequenceStepsTable } from "@workspace/db";
import { requireAuth } from "../middlewares/requireAuth";
import { deleteContactAndHistory } from "../lib/deleteCrmEntity";
import { contactGccAlternatives } from "../lib/contactGccAlternatives";
import { evaluateRoutingRules } from "../lib/scoringEngine";
import { buildContactsWhereClause } from "../utils/segmentFilter";
import { enqueueStep, isTenantQueueAvailable } from "../services/queue";
import {
  CreateContactBody,
  UpdateContactBody,
  GetContactParams,
  UpdateContactParams,
  DeleteContactParams,
  ListContactActivitiesParams,
} from "@workspace/api-zod";

function escapeCsvField(value: unknown): string {
  if (value === null || value === undefined) return "";
  const str = String(value);
  if (str.includes('"') || str.includes(",") || str.includes("\n") || str.includes("\r")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function buildCsvRow(fields: unknown[]): string {
  return fields.map(escapeCsvField).join(",");
}

const router: IRouter = Router();
router.use(requireAuth);

// GET /contacts/tags — distinct tags across all contacts for this tenant
// MUST be before /:id routes so "tags" is not parsed as a contact ID
router.get("/contacts/tags", async (req, res, next): Promise<void> => {
  try {
    const user = req.user as { tenantId: number };
    const rows = await pool.query<{ tag: string }>(
      `SELECT DISTINCT unnest(tags) AS tag
       FROM contacts
       WHERE tenant_id = $1 AND tags IS NOT NULL AND array_length(tags, 1) > 0
       ORDER BY 1`,
      [user.tenantId]
    );
    res.json(rows.rows.map(r => r.tag));
  } catch (err) { next(err); }
});

router.get("/contacts/export", async (req, res, next): Promise<void> => {
  try {
    const user = req.user as any;
    const q = req.query;

    // Parse the same filters as the list route so "export what you see" works
    const scoreMin = q.scoreMin !== undefined && q.scoreMin !== "" ? parseInt(String(q.scoreMin)) : null;
    const scoreMax = q.scoreMax !== undefined && q.scoreMax !== "" ? parseInt(String(q.scoreMax)) : null;
    const stageFilter = q.stage && q.stage !== "all" ? String(q.stage) : null;
    const tagFilter = q.tag ? String(q.tag) : null;
    const searchFilter = q.search ? String(q.search) : null;
    const identifierFilter = q.identifier ? String(q.identifier) : null;
    const clientIdFilter = q.clientId !== undefined && q.clientId !== "" ? parseInt(String(q.clientId)) : null;
    const journeyIdFilter = q.journeyId !== undefined && q.journeyId !== "" ? parseInt(String(q.journeyId)) : null;
    const playIdFilter = q.playId !== undefined && q.playId !== "" ? parseInt(String(q.playId)) : null;
    const formIdFilter = q.formId !== undefined && q.formId !== "" ? parseInt(String(q.formId)) : null;
    const segmentIdFilter = q.segmentId !== undefined && q.segmentId !== "" ? parseInt(String(q.segmentId)) : null;
    const createdFromFilter = q.createdFrom ? String(q.createdFrom) : null;
    const createdToFilter = q.createdTo ? String(q.createdTo) : null;
    const statusFilter = q.status && q.status !== "all" ? String(q.status) : null;
    const intentStateFilter = q.intentState && q.intentState !== "all" ? String(q.intentState) : null;
    const dncFilter = q.dnc && q.dnc !== "all" ? String(q.dnc) : null;
    const callOutcomeFilter = q.callOutcome && q.callOutcome !== "all" ? String(q.callOutcome) : null;
    const campaignTypeFilter = q.campaignType && q.campaignType !== "all" ? String(q.campaignType) : null;

    // Resolve segment filter to a list of contact IDs (mirrors the list route logic)
    let segmentContactIds: number[] | null = null;
    if (segmentIdFilter !== null && !isNaN(segmentIdFilter)) {
      const segRows = (await db.execute(
        sql`SELECT * FROM segments WHERE id = ${segmentIdFilter} AND tenant_id = ${user.tenantId}`
      )).rows;
      const seg = segRows[0] as any;
      if (seg) {
        if (seg.segment_type === "static") {
          segmentContactIds = ((seg.static_contact_ids ?? []) as unknown[])
            .map((id) => parseInt(String(id), 10))
            .filter((n) => !isNaN(n));
        } else if (Array.isArray(seg.filter_criteria) && seg.filter_criteria.length > 0) {
          const logicOp = seg.logic_operator === "OR" ? "OR" : "AND";
          const whereExpr = await buildContactsWhereClause(user.tenantId, seg.filter_criteria, logicOp);
          const idRows = (await db.execute(
            sql`SELECT c.id FROM contacts c LEFT JOIN companies co ON co.id = c.company_id WHERE ${whereExpr}`
          )).rows as { id: number }[];
          segmentContactIds = idRows.map((r) => r.id);
        } else {
          segmentContactIds = null;
        }
      }
    }

    const whereClause = and(
      eq(contactsTable.tenantId, user.tenantId),
      eq(contactsTable.isAnonymous, false),
      clientIdFilter !== null && !isNaN(clientIdFilter) ? eq(contactsTable.clientId, clientIdFilter) : undefined,
      searchFilter
        ? or(
            ilike(contactsTable.firstName, `%${searchFilter}%`),
            ilike(contactsTable.lastName, `%${searchFilter}%`),
            ilike(contactsTable.email, `%${searchFilter}%`),
            ilike(contactsTable.identifier, `%${searchFilter}%`),
          )
        : undefined,
      identifierFilter ? ilike(contactsTable.identifier, `%${identifierFilter}%`) : undefined,
      scoreMin !== null && !isNaN(scoreMin) ? gte(contactsTable.leadScore, scoreMin) : undefined,
      scoreMax !== null && !isNaN(scoreMax) ? lte(contactsTable.leadScore, scoreMax) : undefined,
      stageFilter ? sql`contacts.stage = ${stageFilter}` : undefined,
      tagFilter ? sql`${tagFilter} = ANY(contacts.tags)` : undefined,
      statusFilter ? sql`contacts.status = ${statusFilter}` : undefined,
      intentStateFilter ? sql`contacts.intent_state = ${intentStateFilter}` : undefined,
      journeyIdFilter !== null && !isNaN(journeyIdFilter)
        ? sql`contacts.id IN (
            SELECT contact_id FROM journey_contacts WHERE journey_id = ${journeyIdFilter}
            UNION
            SELECT DISTINCT contact_id FROM activity_events
            WHERE journey_id = ${journeyIdFilter} AND contact_id IS NOT NULL
          )`
        : undefined,
      playIdFilter !== null && !isNaN(playIdFilter)
        ? sql`contacts.id IN (
            SELECT contact_id FROM play_contacts WHERE play_id = ${playIdFilter} AND tenant_id = ${user.tenantId}
            UNION
            SELECT DISTINCT se.contact_id
            FROM sequence_enrollments se
            JOIN sequence_runs sr ON sr.id = se.run_id AND sr.play_id = ${playIdFilter} AND sr.tenant_id = ${user.tenantId}
            WHERE se.contact_id IN (SELECT id FROM contacts WHERE tenant_id = ${user.tenantId})
          )`
        : undefined,
      formIdFilter !== null && !isNaN(formIdFilter)
        ? sql`contacts.id IN (SELECT DISTINCT contact_id FROM form_submissions WHERE form_id = ${formIdFilter} AND tenant_id = ${user.tenantId} AND contact_id IS NOT NULL)`
        : undefined,
      createdFromFilter ? sql`contacts.created_at::date >= ${createdFromFilter}::date` : undefined,
      createdToFilter ? sql`contacts.created_at::date <= ${createdToFilter}::date` : undefined,
      callOutcomeFilter === "answered"
        ? sql`contacts.id IN (SELECT DISTINCT contact_id FROM call_logs WHERE tenant_id = ${user.tenantId} AND contact_id IS NOT NULL AND outcome = 'answered' AND COALESCE(duration_seconds, 0) >= 30)`
        : callOutcomeFilter === "short_call"
        ? sql`contacts.id IN (SELECT DISTINCT contact_id FROM call_logs WHERE tenant_id = ${user.tenantId} AND contact_id IS NOT NULL AND outcome = 'answered' AND COALESCE(duration_seconds, 0) < 30)`
        : callOutcomeFilter === "not_answered"
        ? sql`contacts.id IN (SELECT DISTINCT contact_id FROM call_logs WHERE tenant_id = ${user.tenantId} AND contact_id IS NOT NULL AND outcome IS NULL AND COALESCE(ended_reason, '') NOT IN ('voicemail', 'customer-busy', 'busy'))`
        : callOutcomeFilter === "voicemail"
        ? sql`contacts.id IN (SELECT DISTINCT contact_id FROM call_logs WHERE tenant_id = ${user.tenantId} AND contact_id IS NOT NULL AND ended_reason = 'voicemail')`
        : callOutcomeFilter === "busy"
        ? sql`contacts.id IN (SELECT DISTINCT contact_id FROM call_logs WHERE tenant_id = ${user.tenantId} AND contact_id IS NOT NULL AND ended_reason IN ('customer-busy', 'busy', 'no-answer', 'customer-did-not-give-microphone-permission'))`
        : callOutcomeFilter === "never_called"
        ? sql`contacts.id NOT IN (SELECT DISTINCT contact_id FROM call_logs WHERE tenant_id = ${user.tenantId} AND contact_id IS NOT NULL)`
        : undefined,
      campaignTypeFilter === "call"
        ? sql`contacts.id IN (SELECT DISTINCT contact_id FROM call_campaign_contacts WHERE tenant_id = ${user.tenantId} AND contact_id IS NOT NULL)`
        : campaignTypeFilter === "email"
        ? sql`contacts.id IN (SELECT DISTINCT se.contact_id FROM sequence_enrollments se WHERE se.contact_id IN (SELECT id FROM contacts WHERE tenant_id = ${user.tenantId}))`
        : undefined,
      segmentContactIds !== null
        ? segmentContactIds.length > 0
          ? inArray(contactsTable.id, segmentContactIds)
          : sql`FALSE`
        : undefined,
      dncFilter === "dnc" ? sql`contacts.dnc = TRUE` : dncFilter === "non-dnc" ? sql`contacts.dnc = FALSE` : undefined,
    );

    // Use unaliased `contacts` so the Drizzle-generated whereClause (which references
    // `contacts.*`) resolves correctly — aliasing the table as `c` would break those refs.
    const result = await db.execute(sql`
      SELECT
        contacts.id,
        contacts.first_name,
        contacts.last_name,
        contacts.email,
        contacts.phone,
        contacts.title,
        contacts.dnc,
        contacts.lead_score,
        contacts.intent_state,
        contacts.intent_score,
        contacts.tags,
        contacts.status,
        contacts.last_activity,
        contacts.created_at,
        co.name AS company_name
      FROM contacts
      LEFT JOIN companies co ON co.id = contacts.company_id
      WHERE ${whereClause}
      ORDER BY contacts.created_at DESC
    `);

    const rows = result.rows as any[];

    const headerRow = [
      "id", "first_name", "last_name", "email", "phone", "title",
      "company_name", "dnc", "lead_score", "intent_state", "intent_score",
      "tags", "status", "last_activity", "created_at",
    ].join(",");

    const dataRows = rows.map(r =>
      buildCsvRow([
        r.id,
        r.first_name,
        r.last_name,
        r.email,
        r.phone,
        r.title,
        r.company_name,
        r.dnc ? "true" : "false",
        r.lead_score,
        r.intent_state ?? "",
        r.intent_score ?? "",
        Array.isArray(r.tags) ? r.tags.join("; ") : (r.tags ?? ""),
        r.status,
        r.last_activity ? new Date(r.last_activity).toISOString() : "",
        r.created_at ? new Date(r.created_at).toISOString() : "",
      ])
    );

    const csv = [headerRow, ...dataRows].join("\r\n");

    const filename = dncFilter === "dnc" ? "dnc-contacts.csv" : "contacts.csv";
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(csv);
  } catch (err) { next(err); }
});

router.get("/contacts", async (req, res, next): Promise<void> => {
  try {
    const user = req.user as any;
    const q = req.query;

    const scoreMin = q.scoreMin !== undefined && q.scoreMin !== "" ? parseInt(String(q.scoreMin)) : null;
    const scoreMax = q.scoreMax !== undefined && q.scoreMax !== "" ? parseInt(String(q.scoreMax)) : null;
    const stageFilter = q.stage && q.stage !== "all" ? String(q.stage) : null;
    const tagFilter = q.tag ? String(q.tag) : null;
    const sourceFilter = q.source && q.source !== "all" ? String(q.source) : null;
    const searchFilter = q.search ? String(q.search) : null;
    const identifierFilter = q.identifier ? String(q.identifier) : null;
    const clientIdFilter = q.clientId !== undefined && q.clientId !== "" ? parseInt(String(q.clientId)) : null;
    const journeyIdFilter = q.journeyId !== undefined && q.journeyId !== "" ? parseInt(String(q.journeyId)) : null;
    const playIdFilter = q.playId !== undefined && q.playId !== "" ? parseInt(String(q.playId)) : null;
    const formIdFilter = q.formId !== undefined && q.formId !== "" ? parseInt(String(q.formId)) : null;
    const segmentIdFilter = q.segmentId !== undefined && q.segmentId !== "" ? parseInt(String(q.segmentId)) : null;
    const createdFromFilter = q.createdFrom ? String(q.createdFrom) : null;
    const createdToFilter = q.createdTo ? String(q.createdTo) : null;
    const callOutcomeFilter = q.callOutcome && q.callOutcome !== "all" ? String(q.callOutcome) : null;
    const campaignTypeFilter = q.campaignType && q.campaignType !== "all" ? String(q.campaignType) : null;
    const statusFilter = q.status && q.status !== "all" ? String(q.status) : null;
    const intentStateFilter = q.intentState && q.intentState !== "all" ? String(q.intentState) : null;
    const dncFilter = q.dnc && q.dnc !== "all" ? String(q.dnc) : null;
    const sortByRaw = String(q.sortBy ?? "leadScore");
    const sortBy = (["leadScore", "intentScore", "name", "createdAt"] as const).includes(sortByRaw as any)
      ? (sortByRaw as "leadScore" | "intentScore" | "name" | "createdAt")
      : "leadScore";

    // Pagination is opt-in: callers that don't send `page` get the full
    // unpaginated list (back-compat for existing views like the Database page).
    const pageRaw = q.page !== undefined ? parseInt(String(q.page), 10) : null;
    const pageSizeRaw = q.pageSize !== undefined ? parseInt(String(q.pageSize), 10) : null;
    const paginated = pageRaw !== null && !isNaN(pageRaw);
    const page = paginated && pageRaw! > 0 ? pageRaw! : 1;
    const pageSize = pageSizeRaw !== null && !isNaN(pageSizeRaw) && pageSizeRaw! > 0 ? Math.min(pageSizeRaw!, 200) : 50;

    // ── Segment filter: resolve segment to a list of matching contact IDs ──────
    let segmentContactIds: number[] | null = null;
    if (segmentIdFilter !== null && !isNaN(segmentIdFilter)) {
      const segRows = (await db.execute(
        sql`SELECT * FROM segments WHERE id = ${segmentIdFilter} AND tenant_id = ${user.tenantId}`
      )).rows;
      const seg = segRows[0] as any;
      if (seg) {
        if (seg.segment_type === "static") {
          segmentContactIds = ((seg.static_contact_ids ?? []) as unknown[])
            .map((id) => parseInt(String(id), 10))
            .filter((n) => !isNaN(n));
        } else if (Array.isArray(seg.filter_criteria) && seg.filter_criteria.length > 0) {
          const logicOp = seg.logic_operator === "OR" ? "OR" : "AND";
          const whereExpr = await buildContactsWhereClause(user.tenantId, seg.filter_criteria, logicOp);
          const idRows = (await db.execute(
            sql`SELECT c.id FROM contacts c LEFT JOIN companies co ON co.id = c.company_id WHERE ${whereExpr}`
          )).rows as { id: number }[];
          segmentContactIds = idRows.map((r) => r.id);
        } else {
          // Empty dynamic segment → no filter (show all tenant contacts)
          segmentContactIds = null;
        }
      }
    }

    const databaseIdFilter = q.databaseId !== undefined ? Number(q.databaseId) : null;
    const datasetIdFilter = q.datasetId !== undefined ? Number(q.datasetId) : null;
    if ([databaseIdFilter,datasetIdFilter].some(id=>id!==null && (!Number.isSafeInteger(id) || id<=0))) {
      res.status(400).json({ error: "Invalid database or dataset" }); return;
    }
    const whereClause =
        and(
          eq(contactsTable.tenantId, user.tenantId),
          eq(contactsTable.isAnonymous, false),
          databaseIdFilter !== null ? sql`EXISTS (
            SELECT 1 FROM contact_dataset_members m JOIN contact_datasets ds ON ds.id=m.dataset_id
            JOIN contact_databases d ON d.id=ds.database_id AND d.tenant_id=${user.tenantId}
            WHERE m.contact_id=contacts.id AND ds.tenant_id=${user.tenantId} AND ds.database_id=${databaseIdFilter}
          )` : undefined,
          datasetIdFilter !== null ? sql`EXISTS (
            SELECT 1 FROM contact_dataset_members m JOIN contact_datasets ds ON ds.id=m.dataset_id
            WHERE m.contact_id=contacts.id AND ds.tenant_id=${user.tenantId} AND m.dataset_id=${datasetIdFilter}
          )` : undefined,
          clientIdFilter !== null && !isNaN(clientIdFilter) ? eq(contactsTable.clientId, clientIdFilter) : undefined,
          searchFilter
            ? or(
                ilike(contactsTable.firstName, `%${searchFilter}%`),
                ilike(contactsTable.lastName, `%${searchFilter}%`),
                ilike(contactsTable.email, `%${searchFilter}%`),
                ilike(contactsTable.identifier, `%${searchFilter}%`),
              )
            : undefined,
          identifierFilter ? ilike(contactsTable.identifier, `%${identifierFilter}%`) : undefined,
          scoreMin !== null && !isNaN(scoreMin) ? gte(contactsTable.leadScore, scoreMin) : undefined,
          scoreMax !== null && !isNaN(scoreMax) ? lte(contactsTable.leadScore, scoreMax) : undefined,
          stageFilter ? sql`contacts.stage = ${stageFilter}` : undefined,
          tagFilter ? sql`${tagFilter} = ANY(contacts.tags)` : undefined,
          sourceFilter ? sql`contacts.source = ${sourceFilter}` : undefined,
          statusFilter ? sql`contacts.status = ${statusFilter}` : undefined,
          intentStateFilter ? sql`contacts.intent_state = ${intentStateFilter}` : undefined,
          journeyIdFilter !== null && !isNaN(journeyIdFilter)
            ? sql`contacts.id IN (
                SELECT contact_id FROM journey_contacts WHERE journey_id = ${journeyIdFilter}
                UNION
                SELECT DISTINCT contact_id FROM activity_events
                WHERE journey_id = ${journeyIdFilter} AND contact_id IS NOT NULL
              )`
            : undefined,
          playIdFilter !== null && !isNaN(playIdFilter)
            ? sql`contacts.id IN (
                SELECT contact_id FROM play_contacts WHERE play_id = ${playIdFilter} AND tenant_id = ${user.tenantId}
                UNION
                SELECT DISTINCT se.contact_id
                FROM sequence_enrollments se
                JOIN sequence_runs sr ON sr.id = se.run_id AND sr.play_id = ${playIdFilter} AND sr.tenant_id = ${user.tenantId}
                WHERE se.contact_id IN (SELECT id FROM contacts WHERE tenant_id = ${user.tenantId})
              )`
            : undefined,
          formIdFilter !== null && !isNaN(formIdFilter)
            ? sql`contacts.id IN (SELECT DISTINCT contact_id FROM form_submissions WHERE form_id = ${formIdFilter} AND tenant_id = ${user.tenantId} AND contact_id IS NOT NULL)`
            : undefined,
          segmentContactIds !== null
            ? segmentContactIds.length > 0
              ? inArray(contactsTable.id, segmentContactIds)
              : sql`FALSE`
            : undefined,
          createdFromFilter
            ? sql`contacts.created_at::date >= ${createdFromFilter}::date`
            : undefined,
          createdToFilter
            ? sql`contacts.created_at::date <= ${createdToFilter}::date`
            : undefined,
          callOutcomeFilter === "answered"
            ? sql`contacts.id IN (SELECT DISTINCT contact_id FROM call_logs WHERE tenant_id = ${user.tenantId} AND contact_id IS NOT NULL AND outcome = 'answered' AND COALESCE(duration_seconds, 0) >= 30)`
            : callOutcomeFilter === "short_call"
            ? sql`contacts.id IN (SELECT DISTINCT contact_id FROM call_logs WHERE tenant_id = ${user.tenantId} AND contact_id IS NOT NULL AND outcome = 'answered' AND COALESCE(duration_seconds, 0) < 30)`
            : callOutcomeFilter === "not_answered"
            ? sql`contacts.id IN (SELECT DISTINCT contact_id FROM call_logs WHERE tenant_id = ${user.tenantId} AND contact_id IS NOT NULL AND outcome IS NULL AND COALESCE(ended_reason, '') NOT IN ('voicemail', 'customer-busy', 'busy'))`
            : callOutcomeFilter === "voicemail"
            ? sql`contacts.id IN (SELECT DISTINCT contact_id FROM call_logs WHERE tenant_id = ${user.tenantId} AND contact_id IS NOT NULL AND ended_reason = 'voicemail')`
            : callOutcomeFilter === "busy"
            ? sql`contacts.id IN (SELECT DISTINCT contact_id FROM call_logs WHERE tenant_id = ${user.tenantId} AND contact_id IS NOT NULL AND ended_reason IN ('customer-busy', 'busy', 'no-answer', 'customer-did-not-give-microphone-permission'))`
            : callOutcomeFilter === "never_called"
            ? sql`contacts.id NOT IN (SELECT DISTINCT contact_id FROM call_logs WHERE tenant_id = ${user.tenantId} AND contact_id IS NOT NULL)`
            : undefined,
          campaignTypeFilter === "call"
            ? sql`contacts.id IN (SELECT DISTINCT contact_id FROM call_campaign_contacts WHERE tenant_id = ${user.tenantId} AND contact_id IS NOT NULL)`
            : campaignTypeFilter === "email"
            ? sql`contacts.id IN (SELECT DISTINCT se.contact_id FROM sequence_enrollments se WHERE se.contact_id IN (SELECT id FROM contacts WHERE tenant_id = ${user.tenantId}))`
            : undefined,
          dncFilter === "dnc" ? sql`contacts.dnc = TRUE` : dncFilter === "non-dnc" ? sql`contacts.dnc = FALSE` : undefined,
        );

    // Total count of matching rows (before pagination), only needed when paginating.
    let totalCount: number | null = null;
    if (paginated) {
      const countRows = await db.execute(
        sql`SELECT COUNT(*)::int AS cnt FROM contacts LEFT JOIN companies co ON co.id = contacts.company_id WHERE ${whereClause}`
      );
      totalCount = (countRows.rows[0] as { cnt: number } | undefined)?.cnt ?? 0;
    }

    const baseQuery = db
      .select()
      .from(contactsTable)
      .where(whereClause)
      .orderBy(
        sortBy === "intentScore" ? sql`intent_score DESC NULLS LAST`
        : sortBy === "name" ? sql`lower(first_name || ' ' || last_name) ASC`
        : sortBy === "createdAt" ? desc(contactsTable.createdAt)
        : desc(contactsTable.leadScore)
      );

    const contacts = paginated
      ? await baseQuery.limit(pageSize).offset((page - 1) * pageSize)
      : await baseQuery;

    if (paginated) {
      res.setHeader("X-Total-Count", String(totalCount ?? 0));
      res.setHeader("X-Page", String(page));
      res.setHeader("X-Page-Size", String(pageSize));
    }

    if (contacts.length === 0) { res.json([]); return; }

    // These follow-up lookups are scoped to just the contacts being returned
    // (the current page when paginated) rather than every tenant contact —
    // scanning the whole tenant on every request was the main slow-page culprit.
    const pageContactIds = contacts.map(c => c.id);

    // Per-journey score: sum of score_delta for activity_events in this journey
    let journeyScoreMap = new Map<number, number>();
    if (journeyIdFilter !== null && !isNaN(journeyIdFilter)) {
      const jsr = await db.execute(sql`
        SELECT contact_id, COALESCE(SUM(score_delta), 0)::int AS journey_score
        FROM activity_events
        WHERE journey_id = ${journeyIdFilter}
          AND contact_id IN (${sql.join(pageContactIds.map(id => sql`${id}`), sql`, `)})
        GROUP BY contact_id
      `);
      type JSRow = { contact_id: number; journey_score: number };
      journeyScoreMap = new Map((jsr.rows as JSRow[]).map(r => [r.contact_id, r.journey_score]));
    }

    const companyIds = [...new Set(contacts.map(c => c.companyId).filter((id): id is number => id !== null))];
    const companyMap = new Map<number, string>();
    if (companyIds.length > 0) {
      const companies = await db
        .select({ id: companiesTable.id, name: companiesTable.name })
        .from(companiesTable)
        .where(inArray(companiesTable.id, companyIds));
      companies.forEach(c => companyMap.set(c.id, c.name));
    }

    const [journeyRows, seqRows, emailCountRows, seqCompletedRows, formCountRows, playCountRows, phoneScoreRows] = await Promise.all([
      db.execute(sql`
        SELECT contact_id,
               COUNT(DISTINCT journey_id)::int        AS cnt,
               ARRAY_AGG(DISTINCT journey_id)::int[]  AS journey_ids
        FROM (
          SELECT contact_id, journey_id
          FROM journey_contacts
          WHERE contact_id IN (${sql.join(pageContactIds.map(id => sql`${id}`), sql`, `)})
          UNION
          SELECT ae.contact_id, j.id AS journey_id
          FROM activity_events ae
          JOIN journeys j ON j.slug = SUBSTRING(ae.source FROM 9) AND j.tenant_id = ${user.tenantId}
          WHERE ae.contact_id IN (${sql.join(pageContactIds.map(id => sql`${id}`), sql`, `)})
            AND ae.source LIKE 'journey:%'
        ) _jcombined
        GROUP BY contact_id
      `),
      db.execute(sql`
        SELECT DISTINCT ON (contact_id) contact_id, status
        FROM sequence_enrollments
        WHERE contact_id IN (${sql.join(pageContactIds.map(id => sql`${id}`), sql`, `)})
        ORDER BY contact_id, enrolled_at DESC
      `),
      db.execute(sql`
        SELECT contact_id, COUNT(*)::int AS email_count
        FROM activity_events
        WHERE contact_id IN (${sql.join(pageContactIds.map(id => sql`${id}`), sql`, `)})
          AND event_type LIKE 'email%'
        GROUP BY contact_id
      `),
      db.execute(sql`
        SELECT DISTINCT ON (contact_id) contact_id, completed_at
        FROM sequence_enrollments
        WHERE contact_id IN (${sql.join(pageContactIds.map(id => sql`${id}`), sql`, `)})
          AND status = 'completed' AND completed_at IS NOT NULL
        ORDER BY contact_id, completed_at DESC
      `),
      db.execute(sql`
        SELECT contact_id, COUNT(*)::int AS form_count
        FROM form_submissions
        WHERE contact_id IN (${sql.join(pageContactIds.map(id => sql`${id}`), sql`, `)})
        GROUP BY contact_id
      `),
      db.execute(sql`
        SELECT contact_id, COUNT(DISTINCT play_id)::int AS play_count
        FROM (
          SELECT pc.contact_id, pc.play_id
          FROM play_contacts pc
          WHERE pc.tenant_id = ${user.tenantId}
            AND pc.contact_id IN (${sql.join(pageContactIds.map(id => sql`${id}`), sql`, `)})
          UNION
          SELECT se.contact_id, sr.play_id
          FROM sequence_enrollments se
          JOIN sequence_runs sr ON sr.id = se.run_id
            AND sr.play_id IS NOT NULL
            AND sr.tenant_id = ${user.tenantId}
          WHERE se.contact_id IN (${sql.join(pageContactIds.map(id => sql`${id}`), sql`, `)})
        ) _pcombined
        GROUP BY contact_id
      `),
      // Phone (call) score: best interest_score from call_analysis per contact
      db.execute(sql`
        SELECT cl.contact_id,
               MAX(ca.interest_score)::int AS phone_score
        FROM call_analysis ca
        JOIN call_logs cl ON cl.id = ca.call_log_id
        WHERE cl.tenant_id = ${user.tenantId}
          AND cl.contact_id IN (${sql.join(pageContactIds.map(id => sql`${id}`), sql`, `)})
          AND ca.interest_score IS NOT NULL
        GROUP BY cl.contact_id
      `),
    ]);

    type JRow = { contact_id: number; cnt: number; journey_ids: number[] };
    type SRow = { contact_id: number; status: string };
    type ERow = { contact_id: number; email_count: number };
    type CRow = { contact_id: number; completed_at: string };
    type FRow = { contact_id: number; form_count: number };
    type PRow = { contact_id: number; play_count: number };
    type PhRow = { contact_id: number; phone_score: number };
    const journeyMap = new Map((journeyRows.rows as JRow[]).map(r => [r.contact_id, { cnt: r.cnt, ids: r.journey_ids ?? [] }]));
    const seqMap = new Map((seqRows.rows as SRow[]).map(r => [r.contact_id, r.status]));
    const emailCountMap = new Map((emailCountRows.rows as ERow[]).map(r => [r.contact_id, r.email_count]));
    const seqCompletedMap = new Map((seqCompletedRows.rows as CRow[]).map(r => [r.contact_id, r.completed_at]));
    const formCountMap = new Map((formCountRows.rows as FRow[]).map(r => [r.contact_id, r.form_count]));
    const playCountMap = new Map((playCountRows.rows as PRow[]).map(r => [r.contact_id, r.play_count]));
    const phoneScoreMap = new Map((phoneScoreRows.rows as PhRow[]).map(r => [r.contact_id, r.phone_score]));

    const result = contacts.map(c => {
      const phoneScore = phoneScoreMap.get(c.id) ?? null;
      // combinedScore = ABM lead_score + phone interest_score scaled to 100 (interest_score is 1-10)
      const combinedScore = (c.leadScore ?? 0) + (phoneScore != null ? phoneScore * 10 : 0);
      return {
        ...c,
        companyName: c.companyId ? (companyMap.get(c.companyId) ?? null) : null,
        journeyCount: journeyMap.get(c.id)?.cnt ?? 0,
        journeyIds: journeyMap.get(c.id)?.ids ?? [],
        sequenceStatus: seqMap.get(c.id) ?? null,
        emailCount: emailCountMap.get(c.id) ?? 0,
        sequenceCompletedAt: seqCompletedMap.get(c.id) ?? null,
        formSubmissionCount: formCountMap.get(c.id) ?? 0,
        playCount: playCountMap.get(c.id) ?? 0,
        journeyScore: journeyIdFilter !== null ? (journeyScoreMap.get(c.id) ?? 0) : null,
        phoneScore,
        combinedScore,
      };
    });

    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.post("/contacts", async (req, res, next): Promise<void> => {
  const parsed = CreateContactBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  try {
    const user = req.user as any;
    const [contact] = await db
      .insert(contactsTable)
      .values({
        ...parsed.data,
        tenantId: user.tenantId,
        tags: parsed.data.tags ?? [],
        status: parsed.data.status ?? "active",
      })
      .returning();
    res.status(201).json({ ...contact, companyName: null });
  } catch (err) { next(err); }
});

// POST /contacts/import — bulk upsert contacts from CSV (JSON array)
router.post("/contacts/import", async (req, res, next): Promise<void> => {
  try {
    const user = req.user as any;
    const rows = z.array(z.object({
      firstName:   z.string().optional(),
      lastName:    z.string().optional(),
      email:       z.string().email().optional(),
      phone:       z.string().optional(),
      title:       z.string().optional(),
      companyName: z.string().optional(),
      tags:        z.array(z.string()).optional(),
    })).parse(req.body);

    let created = 0, updated = 0;
    const errors: { row: number; identifier: string; error: string }[] = [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      // Skip rows with neither email nor phone
      if (!row.email && !row.phone) {
        errors.push({ row: i + 2, identifier: "(no email or phone)", error: "Skipped — no email or phone number" });
        continue;
      }
      const identifier = row.email || row.phone || "";
      try {
        // Look up existing contact: prefer email match, fall back to phone match
        let existingRes;
        if (row.email) {
          existingRes = await pool.query(
            `SELECT id, tags FROM contacts WHERE tenant_id=$1 AND email=$2 LIMIT 1`,
            [user.tenantId, row.email],
          );
        } else {
          existingRes = await pool.query(
            `SELECT id, tags FROM contacts WHERE tenant_id=$1 AND phone=$2 LIMIT 1`,
            [user.tenantId, row.phone],
          );
        }

        if (existingRes.rows.length > 0) {
          const prev: string[] = existingRes.rows[0].tags ?? [];
          const merged = Array.from(new Set([...prev, ...(row.tags ?? [])]));
          const existingId: number = existingRes.rows[0].id;
          await pool.query(
            `UPDATE contacts SET
               first_name   = COALESCE($2, first_name),
               last_name    = COALESCE($3, last_name),
               email        = COALESCE($4, email),
               phone        = COALESCE($5, phone),
               title        = COALESCE($6, title),
               company_name = COALESCE($7, company_name),
               tags         = $8,
               updated_at   = NOW()
             WHERE id=$1`,
            [existingId,
             row.firstName || null, row.lastName || null,
             row.email || null, row.phone || null,
             row.title || null, row.companyName || null,
             merged],
          );
          updated++;
        } else {
          await pool.query(
            `INSERT INTO contacts
               (tenant_id, first_name, last_name, email, phone, title, company_name, tags, status, source)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'active','import')`,
            [user.tenantId,
             row.firstName || null, row.lastName || null,
             row.email || null,
             row.phone || null, row.title || null,
             row.companyName || null,
             row.tags ?? []],
          );
          created++;
        }
      } catch (err: any) {
        errors.push({ row: i + 2, identifier, error: err.message ?? String(err) });
      }
    }

    res.json({ created, updated, errors, total: rows.length });
  } catch (err) { next(err); }
});

router.get("/contacts/:id", async (req, res, next): Promise<void> => {
  const params = GetContactParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  try {
    const user = req.user as any;
    const contactRes = await db.execute(sql`
      SELECT c.*, comp.name AS company_name_join, p.dimensions->'_gccProfiling' AS gcc_profiling
      FROM contacts c
      LEFT JOIN companies comp ON comp.id = c.company_id AND comp.tenant_id = c.tenant_id
        AND comp.client_id IS NOT DISTINCT FROM c.client_id
      LEFT JOIN hp_account_profiles p ON p.company_id = comp.id
        AND p.tenant_id = c.tenant_id AND p.client_id = c.client_id
      WHERE c.id = ${params.data.id} AND c.tenant_id = ${user.tenantId}
      LIMIT 1
    `);
    const rows = (contactRes as any).rows as any[];
    if (!rows.length) { res.status(404).json({ error: "Contact not found" }); return; }
    const r = rows[0];
    let clientName: string | null = null;
    if (r.client_id) {
      const clientRes = await db.execute(sql`SELECT name FROM clients WHERE id = ${r.client_id} AND tenant_id = ${user.tenantId} LIMIT 1`);
      clientName = (clientRes.rows[0] as any)?.name ?? null;
    }
    res.json({
      id: r.id,
      tenantId: r.tenant_id,
      clientId: r.client_id,
      clientName,
      companyId: r.company_id,
      companyName: r.company_name_join ?? null,
      firstName: r.first_name,
      lastName: r.last_name,
      email: r.email,
      phone: r.phone ?? null,
      gccAlternatives: contactGccAlternatives(r.gcc_profiling, r.id),
      title: r.title ?? null,
      tags: r.tags ?? [],
      dnc: r.dnc,
      leadScore: r.lead_score,
      status: r.status,
      stage: r.stage ?? 'pre-aware',
      source: r.source ?? null,
      lastActivity: r.last_activity ?? null,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      website: r.website ?? null,
      linkedinUrl: r.linkedin_url ?? null,
      city: r.city ?? null,
      country: r.country ?? null,
      intentScore: r.intent_score ?? null,
      rawIntentScore: r.raw_intent_score ?? null,
      intentState: r.intent_state ?? null,
      suggestedNextAction: r.suggested_next_action ?? null,
      distinctActiveDays: r.distinct_active_days ?? null,
      freqScore: r.freq_score ?? null,
      maxStageScore: r.max_stage_score ?? null,
      engagementScore: r.engagement_score ?? null,
      velocityBonus: r.velocity_bonus ?? null,
      accountBonus: r.account_bonus ?? null,
      accountColleagues: r.account_colleagues ?? null,
    });
  } catch (err) { next(err); }
});

const ExtendedUpdateContactBody = z.object({
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  email: z.string().optional(),
  phone: z.string().nullish(),
  title: z.string().nullish(),
  companyId: z.number().nullish(),
  clientId: z.number().nullish(),
  tags: z.array(z.string()).optional(),
  leadScore: z.number().optional(),
  status: z.enum(["active", "inactive", "unsubscribed"]).optional(),
  stage: z.enum(["pre-aware", "aware", "pre-engage", "engage", "advance-engage", "action"]).optional(),
  website: z.string().nullish(),
  linkedinUrl: z.string().nullish(),
  city: z.string().nullish(),
  country: z.string().nullish(),
  source: z.string().optional(),
  dnc: z.boolean().optional(),
});

router.patch("/contacts/:id", async (req, res, next): Promise<void> => {
  const params = UpdateContactParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const parsed = ExtendedUpdateContactBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  try {
    const user = req.user as any;
    const existingRes = await db.execute(sql`SELECT id, tenant_id, lead_score FROM contacts WHERE id = ${params.data.id} LIMIT 1`);
    const existing = (existingRes as any).rows[0] as any;
    if (!existing || existing.tenant_id !== user.tenantId) { res.status(404).json({ error: "Contact not found" }); return; }
    const [contact] = await db.update(contactsTable).set(parsed.data).where(eq(contactsTable.id, params.data.id)).returning();
    res.json({ ...contact, companyName: null });
    // Fire routing rules asynchronously if score changed
    if (parsed.data.leadScore !== undefined && parsed.data.leadScore !== existing.lead_score) {
      evaluateRoutingRules({
        tenantId: user.tenantId,
        contactId: contact.id,
        newScore: contact.leadScore ?? 0,
        oldScore: existing.lead_score ?? 0,
      }).catch(() => {}); // non-blocking
    }
  } catch (err) { next(err); }
});

router.delete("/contacts/:id", async (req, res, next): Promise<void> => {
  const params = DeleteContactParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  try {
    const user = req.user as any;
    if(user.role!=="admin"){res.status(403).json({error:"Admins only"});return;}
    const deleted=await deleteContactAndHistory(user.tenantId,params.data.id);
    if(!deleted){res.status(404).json({error:"Contact not found"});return;}
    res.sendStatus(204);
  } catch (err) { next(err); }
});

router.get("/contacts/:id/activities", async (req, res, next): Promise<void> => {
  const params = ListContactActivitiesParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  try {
    const activities = await db
      .select()
      .from(activityEventsTable)
      .where(eq(activityEventsTable.contactId, params.data.id))
      .orderBy(desc(activityEventsTable.createdAt));
    res.json(activities);
  } catch (err) { next(err); }
});

// ── Contact Form Submissions ──────────────────────────────────────────────────
router.get("/contacts/:id/submissions", async (req, res, next): Promise<void> => {
  const params = ListContactActivitiesParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  try {
    const user = req.user as any;
    const [contact] = await db.select({ id: contactsTable.id }).from(contactsTable)
      .where(and(eq(contactsTable.id, params.data.id), eq(contactsTable.tenantId, user.tenantId)));
    if (!contact) { res.status(404).json({ error: "Contact not found" }); return; }

    const result = await db.execute(sql`
      SELECT
        fs.id,
        fs.form_id,
        jf.name                AS form_name,
        fs.journey_id,
        j.name                 AS journey_name,
        fs.page_id,
        fs.action_type,
        fs.field_values,
        fs.submitted_at
      FROM form_submissions fs
      LEFT JOIN journey_forms jf ON jf.id = fs.form_id
      LEFT JOIN journeys j ON j.id = fs.journey_id
      WHERE fs.contact_id = ${params.data.id}
        AND fs.tenant_id  = ${user.tenantId}
      ORDER BY fs.submitted_at DESC
    `);

    res.json(result.rows);
  } catch (err) { next(err); }
});

// ── Contact Plays ─────────────────────────────────────────────────────────────
router.get("/contacts/:id/plays", async (req, res, next): Promise<void> => {
  const params = ListContactActivitiesParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  try {
    const user = req.user as any;
    const [contact] = await db.select({ id: contactsTable.id }).from(contactsTable)
      .where(and(eq(contactsTable.id, params.data.id), eq(contactsTable.tenantId, user.tenantId)));
    if (!contact) { res.status(404).json({ error: "Contact not found" }); return; }

    const result = await db.execute(sql`
      SELECT DISTINCT ON (p.id)
        p.id,
        p.name,
        p.status,
        p.client_id                             AS "clientId",
        cl.name                                 AS "clientName",
        COALESCE(pc.enrolled_at, se.enrolled_at) AS "enrolledAt"
      FROM abm_plays p
      LEFT JOIN clients cl ON cl.id = p.client_id
      LEFT JOIN play_contacts pc
             ON pc.play_id = p.id
            AND pc.contact_id = ${params.data.id}
            AND pc.tenant_id  = ${user.tenantId}
      LEFT JOIN (
        SELECT sr.play_id, se2.enrolled_at
        FROM sequence_enrollments se2
        JOIN sequence_runs sr ON sr.id = se2.run_id
          AND sr.play_id IS NOT NULL
          AND sr.tenant_id = ${user.tenantId}
        WHERE se2.contact_id = ${params.data.id}
      ) se ON se.play_id = p.id
      WHERE p.tenant_id = ${user.tenantId}
        AND (pc.contact_id IS NOT NULL OR se.play_id IS NOT NULL)
      ORDER BY p.id, COALESCE(pc.enrolled_at, se.enrolled_at) DESC NULLS LAST
    `);

    res.json(result.rows);
  } catch (err) { next(err); }
});

// ── Contact Journeys ──────────────────────────────────────────────────────────
router.get("/contacts/:id/journeys", async (req, res, next): Promise<void> => {
  const params = ListContactActivitiesParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  try {
    const user = req.user as any;
    const [contact] = await db.select({ id: contactsTable.id }).from(contactsTable)
      .where(and(eq(contactsTable.id, params.data.id), eq(contactsTable.tenantId, user.tenantId)));
    if (!contact) { res.status(404).json({ error: "Contact not found" }); return; }
    const result = await db.execute(sql`
      SELECT DISTINCT ON (j.id)
        j.id, j.name, j.status, j.slug,
        COALESCE(jc.added_at, ae.created_at) AS "assignedAt"
      FROM journeys j
      LEFT JOIN journey_contacts jc
             ON jc.journey_id = j.id
            AND jc.contact_id = ${params.data.id}
      LEFT JOIN (
        SELECT ae2.created_at, j2.id AS journey_id
        FROM activity_events ae2
        JOIN journeys j2
          ON j2.slug = SUBSTRING(ae2.source FROM 9)
         AND j2.tenant_id = ${user.tenantId}
        WHERE ae2.contact_id = ${params.data.id}
          AND ae2.source LIKE 'journey:%'
        ORDER BY ae2.created_at ASC
        LIMIT 1000
      ) ae ON ae.journey_id = j.id
      WHERE j.tenant_id = ${user.tenantId}
        AND (jc.contact_id IS NOT NULL OR ae.journey_id IS NOT NULL)
      ORDER BY j.id, COALESCE(jc.added_at, ae.created_at) DESC NULLS LAST
    `);
    res.json(result.rows);
  } catch (err) { next(err); }
});

// ── Contact Sequence Enrollments ──────────────────────────────────────────────
router.get("/contacts/:id/sequences", async (req, res, next): Promise<void> => {
  const params = ListContactActivitiesParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  try {
    const user = req.user as any;
    const [contact] = await db.select({ id: contactsTable.id }).from(contactsTable)
      .where(and(eq(contactsTable.id, params.data.id), eq(contactsTable.tenantId, user.tenantId)));
    if (!contact) { res.status(404).json({ error: "Contact not found" }); return; }
    const result = await db.execute(sql`
      SELECT
        se.id,
        es.id          AS "sequenceId",
        es.name        AS "sequenceName",
        se.status,
        se.enrolled_at  AS "enrolledAt",
        se.completed_at AS "completedAt"
      FROM sequence_enrollments se
      JOIN email_sequences es ON es.id = se.sequence_id
      WHERE se.contact_id = ${params.data.id}
        AND es.tenant_id  = ${user.tenantId}
      ORDER BY se.enrolled_at DESC
    `);
    res.json(result.rows);
  } catch (err) { next(err); }
});

// ── Re-enroll a contact into a completed sequence ─────────────────────────────
router.post("/contacts/:id/sequences/:enrollmentId/re-enroll", async (req, res, next): Promise<void> => {
  const contactId = parseInt(req.params.id);
  const enrollmentId = parseInt(req.params.enrollmentId);
  if (isNaN(contactId) || isNaN(enrollmentId)) { res.status(400).json({ error: "Invalid id" }); return; }
  try {
    const user = req.user as any;

    // Admin-only action
    if (user.role !== "admin") { res.status(403).json({ error: "Admin role required" }); return; }

    // Verify the contact belongs to this tenant
    const [contact] = await db.select({ id: contactsTable.id, dnc: contactsTable.dnc })
      .from(contactsTable)
      .where(and(eq(contactsTable.id, contactId), eq(contactsTable.tenantId, user.tenantId)));
    if (!contact) { res.status(404).json({ error: "Contact not found" }); return; }
    if (contact.dnc) { res.status(409).json({ error: "Contact is on the DNC list" }); return; }

    // Verify the enrollment exists, belongs to this contact, and is completed
    const [enrollment] = await db.select({
      id: sequenceEnrollmentsTable.id,
      sequenceId: sequenceEnrollmentsTable.sequenceId,
      status: sequenceEnrollmentsTable.status,
    })
      .from(sequenceEnrollmentsTable)
      .where(and(
        eq(sequenceEnrollmentsTable.id, enrollmentId),
        eq(sequenceEnrollmentsTable.contactId, contactId),
      ));
    if (!enrollment) { res.status(404).json({ error: "Enrollment not found" }); return; }
    if (enrollment.status !== "completed") { res.status(409).json({ error: "Enrollment is not completed" }); return; }

    // Verify the sequence belongs to this tenant
    const [seq] = await db.select({ id: emailSequencesTable.id })
      .from(emailSequencesTable)
      .where(and(eq(emailSequencesTable.id, enrollment.sequenceId), eq(emailSequencesTable.tenantId, user.tenantId)));
    if (!seq) { res.status(404).json({ error: "Sequence not found" }); return; }

    // Ensure there is no existing active enrollment for this contact + sequence
    const [activeEnrollment] = await db.select({ id: sequenceEnrollmentsTable.id })
      .from(sequenceEnrollmentsTable)
      .where(and(
        eq(sequenceEnrollmentsTable.sequenceId, enrollment.sequenceId),
        eq(sequenceEnrollmentsTable.contactId, contactId),
        eq(sequenceEnrollmentsTable.status, "active"),
      ));
    if (activeEnrollment) { res.status(409).json({ error: "Contact is already actively enrolled in this sequence" }); return; }

    // Get the first step of the sequence
    const [firstStep] = await db.select()
      .from(sequenceStepsTable)
      .where(eq(sequenceStepsTable.sequenceId, enrollment.sequenceId))
      .orderBy(asc(sequenceStepsTable.stepOrder))
      .limit(1);

    // When the sequence has never been published (no sequence_steps rows), fall back to
    // the nodes_json path used by runEnrollmentService.  We encode "start at nodes_json
    // index 0" as currentStepId = -1  (sentinel: -(nodeIndex + 1), so index 0 → -1) so
    // resumeContactFromWait dispatches to processContactNodesJsonSteps rather than the
    // published-steps path.  BullMQ cannot handle nodes_json enrollments (no real step
    // id exists), so we always use the resume_at path for this branch — the
    // sequenceResumeRunner will call resumeContactFromWait on its next tick.
    const currentStepId = firstStep ? firstStep.id : -1;

    // Insert a new enrollment row
    const [newEnrollment] = await db.insert(sequenceEnrollmentsTable).values({
      sequenceId: enrollment.sequenceId,
      contactId,
      status: "active",
      currentStepId,
    }).returning();

    if (firstStep) {
      // Published-steps path: prefer BullMQ; fall back to resume_at when Redis is down.
      const queueAvailable = await isTenantQueueAvailable(user.tenantId);
      if (queueAvailable) {
        await enqueueStep({
          enrollmentId: newEnrollment.id,
          stepId: firstStep.id,
          sequenceId: enrollment.sequenceId,
          contactId,
          tenantId: user.tenantId,
        });
      } else {
        // Redis is unavailable — set resume_at = NOW() so the sequenceResumeRunner
        // picks this enrollment up on its next tick and processes from the first step.
        await db.execute(
          sql`UPDATE sequence_enrollments SET resume_at = NOW() WHERE id = ${newEnrollment.id}`
        );
      }
    } else {
      // nodes_json-only path — BullMQ cannot be used; always set resume_at so the
      // sequenceResumeRunner picks up this enrollment and walks nodes_json from index 0.
      await db.execute(
        sql`UPDATE sequence_enrollments SET resume_at = NOW() WHERE id = ${newEnrollment.id}`
      );
    }

    res.status(201).json({ enrollment: newEnrollment });
  } catch (err) { next(err); }
});

// ── Contact Stage History ─────────────────────────────────────────────────────
router.get("/contacts/:id/stage-history", async (req, res, next): Promise<void> => {
  const params = ListContactActivitiesParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  try {
    const user = req.user as any;
    const [contact] = await db.select({ id: contactsTable.id }).from(contactsTable)
      .where(and(eq(contactsTable.id, params.data.id), eq(contactsTable.tenantId, user.tenantId)));
    if (!contact) { res.status(404).json({ error: "Contact not found" }); return; }

    const result = await pool.query(
      `SELECT
         csh.id,
         csh.from_stage,
         csh.to_stage,
         csh.score_at_transition,
         csh.created_at,
         ae.event_type   AS source_event_type,
         ae.description  AS source_description
       FROM contact_stage_history csh
       LEFT JOIN activity_events ae ON ae.id = csh.activity_event_id
       WHERE csh.contact_id = $1 AND csh.tenant_id = $2
       ORDER BY csh.created_at ASC`,
      [params.data.id, user.tenantId]
    );

    const SOURCE_LABELS: Record<string, string> = {
      page_view: "Journey page view",
      email_click: "Email link click",
      form_submit: "Form submission",
      asset_download: "Asset download",
      email_open: "Email open",
      score_change: "Scoring engine",
    };

    const rows = (result.rows as any[]).map(r => ({
      id: r.id,
      fromStage: r.from_stage ?? null,
      toStage: r.to_stage,
      scoreAtTransition: r.score_at_transition,
      source: r.source_event_type ? (SOURCE_LABELS[r.source_event_type] ?? r.source_event_type) : null,
      createdAt: r.created_at,
    }));

    res.json(rows);
  } catch (err) { next(err); }
});

// ── Contact Stage Timeline ────────────────────────────────────────────────────
router.get("/contacts/:id/timeline", async (req, res, next): Promise<void> => {
  const params = ListContactActivitiesParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  try {
    const user = req.user as any;
    const contactResult = await db.execute(sql`
      SELECT c.*, co.name AS linked_company_name
      FROM contacts c
      LEFT JOIN companies co ON co.id=c.company_id AND co.tenant_id=c.tenant_id
      WHERE c.id = ${params.data.id} AND c.tenant_id = ${user.tenantId}
    `);
    const contactRows = (contactResult as any).rows as any[];
    if (!contactRows.length) { res.status(404).json({ error: "Contact not found" }); return; }
    const contact = contactRows[0];

    // GTM OS qualification is account-level, not the contact's journey stage or
    // score-derived heat tag. Only show a status backed by inbound submissions.
    const gtmResult = contact.company_id ? await db.execute(sql`
      SELECT CASE
          WHEN bool_or(classification = 'hot') THEN 'hot'
          WHEN bool_or(classification = 'warm') THEN 'warm'
          ELSE 'cold'
        END AS status,
        MAX(updated_at) AS updated_at
      FROM intent_inbound_submissions
      WHERE tenant_id = ${user.tenantId} AND account_id = ${contact.company_id}
      HAVING COUNT(*) > 0
    `) : null;
    const gtmRow = gtmResult?.rows[0] as { status: string; updated_at: Date | null } | undefined;

    const activitiesResult = await db.execute(sql`
      SELECT
        ae.id,
        ae.event_type,
        ae.description,
        ae.score_delta,
        ae.stage,
        ae.page_name,
        ae.source,
        ae.created_at,
        ae.journey_id,
        j.name AS journey_name,
        ae.sequence_id,
        es.name AS sequence_name,
        ae.metadata,
        ae.intent_score_at
      FROM activity_events ae
      LEFT JOIN journeys j ON j.id = ae.journey_id
      LEFT JOIN email_sequences es ON es.id = ae.sequence_id
      WHERE ae.contact_id = ${params.data.id}
      ORDER BY ae.created_at ASC
    `);
    const activities: any[] = (activitiesResult as any).rows as any[];

    // Fetch all stage history records so we can show every intermediate step.
    // JOIN activity_events to surface the triggering page view / event so the
    // timeline can show "Triggered by: Journey page view — Solution Demo".
    const stageHistoryDbResult = await pool.query(
      `SELECT
         csh.id, csh.from_stage, csh.to_stage, csh.score_at_transition,
         csh.created_at, csh.activity_event_id,
         ae.event_type  AS trigger_event_type,
         ae.page_name   AS trigger_page_name,
         ae.description AS trigger_description
       FROM contact_stage_history csh
       LEFT JOIN activity_events ae ON ae.id = csh.activity_event_id
       WHERE csh.contact_id = $1 AND csh.tenant_id = $2
       ORDER BY csh.created_at ASC`,
      [params.data.id, user.tenantId]
    );
    const stageHistoryRecords: any[] = (stageHistoryDbResult as any).rows;

    let runningScore = 0;
    const STAGE_ORDER = ['pre-aware','aware','pre-engage','engage','advance-engage','action'];

    // Build a sorted lookup for interpolating formula scores from stage history.
    // For events without a snapshotted intent_score_at we find the last stage
    // transition that occurred at or before the event and use its score —
    // approximate, but always on the same scale as the contact card score.
    const sortedStageScores = stageHistoryRecords
      .map(sh => ({ time: new Date(sh.created_at).getTime(), score: sh.score_at_transition ?? 0 }))
      .sort((a, b) => a.time - b.time);

    function interpolateFormulaScore(eventTimeMs: number): number {
      let best = 0;
      for (const sh of sortedStageScores) {
        if (sh.time <= eventTimeMs) best = sh.score;
        else break;
      }
      return best;
    }

    // Build activity timeline entries.
    // cumulativeScore is: intent_score_at (formula snapshot) when available,
    // interpolated from nearest preceding stage-history score when not.
    const activityTimeline = activities.map((a) => {
      runningScore += (a.score_delta ?? 0);
      const eventTimeMs = new Date(a.created_at).getTime();
      const cumulativeScore =
        a.intent_score_at != null
          ? Number(a.intent_score_at)
          : (sortedStageScores.length > 0 ? interpolateFormulaScore(eventTimeMs) : runningScore);
      return {
        id: a.id,
        eventType: a.event_type,
        description: a.description,
        scoreDelta: a.score_delta ?? 0,
        cumulativeScore,
        stage: a.stage,
        pageName: a.page_name,
        source: a.source,
        isStageChange: false,
        isPureStageChange: false,
        fromStage: null,
        toStage: null,
        createdAt: a.created_at,
        journeyId: a.journey_id ?? null,
        journeyName: a.journey_name ?? null,
        sequenceId: a.sequence_id ?? null,
        sequenceName: a.sequence_name ?? null,
        metadata: a.metadata ?? null,
      };
    });

    let timeline: any[];
    if (stageHistoryRecords.length > 0) {
      // Use contact_stage_history as the authoritative source for stage transitions.
      // Each record becomes its own synthetic entry so multi-step advances
      // (Pre-Aware → Aware → Pre-Engage in one page view) show as two distinct markers.
      const stageChangeEntries = stageHistoryRecords.map((sh) => ({
        id: `stage-${sh.id}`,
        eventType: 'stage_advance',
        description: null,
        scoreDelta: 0,
        cumulativeScore: sh.score_at_transition ?? 0,
        stage: sh.to_stage,
        pageName: null,
        source: null,
        isStageChange: true,
        isPureStageChange: true,
        fromStage: sh.from_stage ?? null,
        toStage: sh.to_stage,
        createdAt: sh.created_at,
        journeyId: null,
        journeyName: null,
        sequenceId: null,
        sequenceName: null,
        metadata: null,
        // Triggering event info — present when the advance was caused by a specific
        // activity event (e.g. a page view on a stage-tagged journey page).
        triggerEventType: sh.trigger_event_type ?? null,
        triggerPageName:  sh.trigger_page_name  ?? null,
        triggerDescription: sh.trigger_description ?? null,
      }));

      // Merge and sort chronologically; stage-change entries sort before same-timestamp activities
      timeline = [...activityTimeline, ...stageChangeEntries].sort((a, b) => {
        const ta = new Date(a.createdAt).getTime();
        const tb = new Date(b.createdAt).getTime();
        if (ta !== tb) return ta - tb;
        if (a.isPureStageChange && !b.isPureStageChange) return -1;
        if (!a.isPureStageChange && b.isPureStageChange) return 1;
        return 0;
      });
    } else {
      // Fallback for contacts with no stage history rows: derive markers from activity_events.stage
      let prevStage: string | null = null;
      runningScore = 0;
      timeline = activities.map((a) => {
        runningScore += (a.score_delta ?? 0);
        const isStageChange = a.stage && a.stage !== prevStage && STAGE_ORDER.indexOf(a.stage) > STAGE_ORDER.indexOf(prevStage ?? '');
        const fromStage = prevStage;
        if (isStageChange) prevStage = a.stage;
        // Use formula snapshot if present; fall back to delta accumulation (no stage history to interpolate from)
        const cumulativeScore = a.intent_score_at != null ? Number(a.intent_score_at) : runningScore;
        return {
          id: a.id,
          eventType: a.event_type,
          description: a.description,
          scoreDelta: a.score_delta ?? 0,
          cumulativeScore,
          stage: a.stage,
          pageName: a.page_name,
          source: a.source,
          isStageChange: !!isStageChange,
          isPureStageChange: false,
          fromStage: isStageChange ? fromStage : null,
          toStage: isStageChange ? a.stage : null,
          createdAt: a.created_at,
          journeyId: a.journey_id ?? null,
          journeyName: a.journey_name ?? null,
          sequenceId: a.sequence_id ?? null,
          sequenceName: a.sequence_name ?? null,
          metadata: a.metadata ?? null,
        };
      });
    }

    const stageHistory = stageHistoryRecords.length > 0
      ? stageHistoryRecords.map(sh => ({
          fromStage: sh.from_stage ?? null,
          toStage: sh.to_stage,
          scoreAtTransition: sh.score_at_transition,
          achievedAt: sh.created_at,
        }))
      : timeline.filter(e => e.isStageChange).map(e => ({
          fromStage: e.fromStage,
          toStage: e.toStage,
          scoreAtTransition: e.cumulativeScore,
          achievedAt: e.createdAt,
        }));

    // ── Call logs for this contact (with LLM intelligence) ────────────────
    const callLogsResult = await db.execute(sql`
      SELECT cl.id, cl.vapi_call_id, cl.outcome, cl.duration_seconds,
             cl.started_at, cl.ended_at, cl.ended_reason,
             cl.ai_summary, cl.ai_next_steps,
             cl.transcript, cl.recording_url,
             cc.name AS campaign_name,
             ca.id                   AS analysis_id,
             ca.status               AS analysis_status,
             ca.call_summary         AS llm_call_summary,
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
      LEFT JOIN call_campaigns cc ON cc.id = cl.campaign_id
      LEFT JOIN call_analysis ca ON ca.call_log_id = cl.id
      WHERE cl.contact_id = ${params.data.id} AND cl.tenant_id = ${user.tenantId}
      ORDER BY cl.created_at DESC
    `);
    const callLogs = ((callLogsResult as any).rows as any[]).map(cl => ({
      id: cl.id,
      outcome: cl.outcome,
      durationSeconds: cl.duration_seconds,
      startedAt: cl.started_at,
      endedAt: cl.ended_at,
      endedReason: cl.ended_reason ?? null,
      aiSummary: cl.ai_summary ?? null,
      aiNextSteps: cl.ai_next_steps ?? null,
      transcriptText: (() => {
        const tx = cl.transcript;
        if (!tx) return null;
        if (typeof tx === "string") {
          try {
            const parsed = JSON.parse(tx);
            if (Array.isArray(parsed)) {
              return parsed.map((m: any) => `${m.role === "assistant" ? "AI" : "User"}: ${m.content ?? ""}`).join("\n");
            }
            return parsed?.text ?? tx;
          } catch { return tx; }
        }
        if (Array.isArray(tx)) {
          return (tx as any[]).map((m: any) => `${m.role === "assistant" ? "AI" : "User"}: ${m.content ?? ""}`).join("\n");
        }
        return (tx as any)?.text ?? null;
      })(),
      recordingUrl: cl.recording_url ?? null,
      campaignName: cl.campaign_name ?? null,
      analysisId: cl.analysis_id ?? null,
      analysisStatus: cl.analysis_status ?? null,
      llmCallSummary: cl.llm_call_summary ?? null,
      prospectProfile: cl.prospect_profile ?? null,
      keyHighlights: cl.key_highlights ?? null,
      sentiment: cl.sentiment ?? null,
      sentimentJustification: cl.sentiment_justification ?? null,
      interestScore: cl.interest_score ?? null,
      interestJustification: cl.interest_justification ?? null,
      recommendedAction: cl.recommended_action ?? null,
      owningTeam: cl.owning_team ?? null,
      actionReason: cl.action_reason ?? null,
      actionTiming: cl.action_timing ?? null,
      followUpMessage: cl.follow_up_message ?? null,
    }));

    res.json({
      contact: {
        id: contact.id,
        companyId: contact.company_id ?? null,
        companyName: contact.linked_company_name ?? contact.company_name ?? null,
        gtmStatus: gtmRow ? { status: gtmRow.status, updatedAt: gtmRow.updated_at } : null,
        firstName: contact.first_name,
        lastName: contact.last_name,
        leadScore: contact.lead_score,
        stage: contact.stage ?? 'pre-aware',
        intentScore: contact.intent_score ?? 0,
        rawIntentScore: contact.raw_intent_score ?? 0,
        intentState: contact.intent_state ?? 'Browsing',
        suggestedNextAction: contact.suggested_next_action ?? null,
        freqScore: contact.freq_score ?? null,
        maxStageScore: contact.max_stage_score ?? null,
        engagementScore: contact.engagement_score ?? null,
        velocityBonus: contact.velocity_bonus ?? 0,
        accountBonus: contact.account_bonus ?? 0,
        accountColleagues: contact.account_colleagues ?? 0,
        distinctActiveDays: contact.distinct_active_days ?? 0,
      },
      timeline: [...timeline].reverse(),
      stageHistory,
      callLogs,
    });
  } catch (err) { next(err); }
});

// ── Contact Contest Events ────────────────────────────────────────────────────
// Fetches contest events (scenario_selected, challenges_selected, entry_submitted, etc.)
// from journey_events keyed by visitor_tokens linked to this contact.
router.get("/contacts/:id/contest-events", async (req, res, next): Promise<void> => {
  const params = ListContactActivitiesParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  try {
    const user = req.user as any;
    const [contact] = await db.select({ id: contactsTable.id }).from(contactsTable)
      .where(and(eq(contactsTable.id, params.data.id), eq(contactsTable.tenantId, user.tenantId)));
    if (!contact) { res.status(404).json({ error: "Contact not found" }); return; }

    const result = await db.execute(sql`
      SELECT
        je.id,
        je.event_type   AS "eventType",
        je.props,
        je.created_at   AS "createdAt",
        je.journey_id   AS "journeyId",
        j.name          AS "journeyName"
      FROM journey_events je
      LEFT JOIN journeys j ON j.id = je.journey_id
      WHERE je.tenant_id = ${user.tenantId}
        AND je.event_type IN ('scenario_selected', 'registration_completed', 'challenges_selected', 'entry_submitted')
        AND je.visitor_token IN (
          SELECT token FROM visitor_tokens
          WHERE contact_id = ${params.data.id} AND tenant_id = ${user.tenantId}
        )
      ORDER BY je.created_at DESC
    `);

    res.json((result.rows as any[]).map(r => ({
      id: r.id,
      eventType: r.eventType,
      props: r.props ?? null,
      createdAt: r.createdAt,
      journeyId: r.journeyId ?? null,
      journeyName: r.journeyName ?? null,
    })));
  } catch (err) { next(err); }
});

// ── Contact Score History ─────────────────────────────────────────────────────
router.get("/contacts/:id/score-history", async (req, res, next): Promise<void> => {
  const params = ListContactActivitiesParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  try {
    const user = req.user as any;
    const [contact] = await db.select({ id: contactsTable.id }).from(contactsTable)
      .where(and(eq(contactsTable.id, params.data.id), eq(contactsTable.tenantId, user.tenantId)));
    if (!contact) { res.status(404).json({ error: "Contact not found" }); return; }

    const result = await pool.query(
      `SELECT id, old_score, new_score, delta, source, created_at
       FROM score_history
       WHERE contact_id = $1 AND tenant_id = $2
       ORDER BY created_at ASC`,
      [params.data.id, user.tenantId]
    );

    res.json((result.rows as any[]).map(r => ({
      id: r.id,
      oldScore: Number(r.old_score),
      newScore: Number(r.new_score),
      delta: Number(r.delta),
      source: r.source ?? null,
      createdAt: r.created_at,
    })));
  } catch (err) { next(err); }
});

export default router;
