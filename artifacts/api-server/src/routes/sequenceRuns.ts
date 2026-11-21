import { Router, type IRouter } from "express";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { db, pool } from "@workspace/db";
import { requireAuth } from "../middlewares/requireAuth";
import { logger } from "../lib/logger";
import {
  buildContactsWhereClause,
  type FilterCriterion,
  type LogicOperator,
} from "../utils/segmentFilter";
import { runContactEnrollment, parseContactListIds } from "../services/runEnrollmentService";
import { enqueueRunStart, type EnqueueResult } from "../services/queue";

const router: IRouter = Router();
router.use(requireAuth);

type AuthUser = { tenantId: number; id: number };

type NodesJson = {
  nodes: Array<{ id: string; type: string; data: Record<string, unknown> }>;
  edges: unknown[];
};

type StepStat = {
  stepNum: number;
  label: string;
  subject: string | undefined;
  sent: number;
  opened: number;
  clicked: number;
  bounced: number;
  openRate: number;
  clickRate: number;
  waitLabel: string | undefined;
};

const CreateRunBody = z.object({
  sequenceId:          z.number().int().positive(),
  playId:              z.number().int().positive().optional(),
  journeyId:           z.number().int().positive().optional(),
  clientId:            z.number().int().positive().optional(),
  segmentId:           z.number().int().positive().optional(),
  segmentIds:          z.array(z.number().int().positive()).optional(),
  segmentMode:         z.enum(["union", "intersection"]).default("union"),
  contactIds:          z.array(z.number().int().positive()).optional(),
  manualEmails:        z.array(z.string()).optional(),
  sendImmediately:     z.boolean().default(true),
  scheduledAt:         z.string().optional(),
  sendWindowStart:     z.string().default("09:00"),
  sendWindowEnd:       z.string().default("18:00"),
  sendDays:            z.array(z.number()).default([1, 2, 3, 4, 5]),
  dailyCap:            z.number().int().positive().optional(),
  excludeActive:            z.boolean().default(true),
  /** When true (default), also exclude contacts enrolled in the last 24 h. */
  skipRecentlyEnrolled:     z.boolean().default(true),
  excludeUnsubscribed:      z.boolean().default(true),
  minScore:                 z.number().int().optional(),
});

// ── Helpers ───────────────────────────────────────────────────────────────────

type AllowedEntity = "email_sequences" | "journeys" | "clients" | "segments";

/**
 * Verify that a specific tenant owns a given entity.
 * Uses explicit per-table queries (not dynamic SQL interpolation) to prevent
 * SQL injection. Only the four entity types listed in AllowedEntity are supported.
 */
async function verifyTenantOwnsEntity(
  entity: AllowedEntity,
  id: number,
  tenantId: number
): Promise<boolean> {
  let r: { rows: unknown[] };
  if (entity === "email_sequences") {
    r = await pool.query(`SELECT 1 FROM email_sequences WHERE id=$1 AND tenant_id=$2 LIMIT 1`, [id, tenantId]);
  } else if (entity === "journeys") {
    r = await pool.query(`SELECT 1 FROM journeys WHERE id=$1 AND tenant_id=$2 LIMIT 1`, [id, tenantId]);
  } else if (entity === "clients") {
    r = await pool.query(`SELECT 1 FROM clients WHERE id=$1 AND tenant_id=$2 LIMIT 1`, [id, tenantId]);
  } else if (entity === "segments") {
    r = await pool.query(`SELECT 1 FROM segments WHERE id=$1 AND tenant_id=$2 LIMIT 1`, [id, tenantId]);
  } else {
    return false;
  }
  return r.rows.length > 0;
}

/** Resolve contacts for a single segment (static or dynamic). */
async function resolveSegmentContactIds(segmentId: number, tenantId: number): Promise<number[]> {
  const segRows = await pool.query(
    `SELECT segment_type, filter_criteria, static_contact_ids, logic_operator
     FROM segments WHERE id = $1 AND tenant_id = $2`,
    [segmentId, tenantId]
  );
  if (!segRows.rows.length) return [];
  const seg = segRows.rows[0] as {
    segment_type: string; filter_criteria: unknown;
    static_contact_ids: unknown; logic_operator: string;
  };
  if (seg.segment_type === "static") {
    return Array.isArray(seg.static_contact_ids)
      ? (seg.static_contact_ids as unknown[]).map(Number).filter(n => !isNaN(n))
      : [];
  }
  const criteria: FilterCriterion[] = Array.isArray(seg.filter_criteria)
    ? (seg.filter_criteria as FilterCriterion[]) : [];
  const logicOp: LogicOperator = seg.logic_operator === "OR" ? "OR" : "AND";
  const whereExpr = await buildContactsWhereClause(tenantId, criteria, logicOp);
  const rows = (await db.execute(sql`
    SELECT c.id FROM contacts c
    LEFT JOIN companies co ON co.id = c.company_id
    WHERE ${whereExpr}
    ORDER BY c.lead_score DESC
  `)).rows as Array<{ id: number }>;
  return rows.map(x => x.id);
}

async function resolveContactIds(
  tenantId: number,
  opts: {
    journeyId?: number;
    clientId?: number;
    segmentId?: number;
    segmentIds?: number[];
    segmentMode?: "union" | "intersection";
    sequenceId?: number;
    excludeActive?: boolean;
    /** When false, skip the 24-hour re-enrollment window (only exclude currently active). */
    skipRecentlyEnrolled?: boolean;
    excludeUnsubscribed?: boolean;
    minScore?: number;
    /** When false, DNC contacts are NOT filtered out. Defaults to true. */
    excludeDnc?: boolean;
  }
): Promise<number[]> {
  // Each scoping option (journey / client / segment) narrows the audience.
  // When more than one is supplied (e.g. a client picked in step 1 AND a segment
  // picked in step 4), they must be intersected — previously this was an if/else
  // chain where client silently won and the segment filter was dropped entirely.
  const scopeSets: Set<number>[] = [];

  if (opts.journeyId !== undefined) {
    const r = await pool.query<{ contact_id: number }>(
      `SELECT DISTINCT jc.contact_id
       FROM journey_contacts jc
       JOIN contacts c ON c.id = jc.contact_id AND c.tenant_id = $2
       WHERE jc.journey_id = $1`,
      [opts.journeyId, tenantId]
    );
    scopeSets.push(new Set(r.rows.map(x => x.contact_id)));
  }

  if (opts.clientId !== undefined) {
    const r = await pool.query<{ id: number }>(
      `SELECT id FROM contacts WHERE client_id = $1 AND tenant_id = $2
       ORDER BY lead_score DESC`,
      [opts.clientId, tenantId]
    );
    scopeSets.push(new Set(r.rows.map(x => x.id)));
  }

  if (opts.segmentIds && opts.segmentIds.length > 0) {
    const mode = opts.segmentMode ?? "union";
    if (mode === "intersection" && opts.segmentIds.length > 1) {
      // Intersection: only contacts present in ALL selected segments
      const perSegment = await Promise.all(
        opts.segmentIds.map(sid => resolveSegmentContactIds(sid, tenantId))
      );
      const first = new Set<number>(perSegment[0]);
      for (let i = 1; i < perSegment.length; i++) {
        const sSet = new Set<number>(perSegment[i]);
        for (const id of first) if (!sSet.has(id)) first.delete(id);
      }
      scopeSets.push(first);
    } else {
      // Union of multiple segments — deduplicate via Set
      const allIds = new Set<number>();
      for (const sid of opts.segmentIds) {
        const ids = await resolveSegmentContactIds(sid, tenantId);
        ids.forEach(id => allIds.add(id));
      }
      scopeSets.push(allIds);
    }
  } else if (opts.segmentId !== undefined) {
    scopeSets.push(new Set(await resolveSegmentContactIds(opts.segmentId, tenantId)));
  }

  let baseIds: number[];
  if (scopeSets.length === 0) {
    const r = await pool.query<{ id: number }>(
      `SELECT id FROM contacts WHERE tenant_id = $1
       ORDER BY lead_score DESC`,
      [tenantId]
    );
    baseIds = r.rows.map(x => x.id);
  } else {
    // Intersect all supplied scopes (journey ∩ client ∩ segment(s))
    let intersection = scopeSets[0];
    for (let i = 1; i < scopeSets.length; i++) {
      const next = scopeSets[i];
      intersection = new Set([...intersection].filter(id => next.has(id)));
    }
    baseIds = Array.from(intersection);
  }

  if (baseIds.length === 0) return [];

  const conditions: string[] = [`c.id = ANY($1::int[])`, `c.tenant_id = $2`];
  const params: unknown[] = [baseIds, tenantId];
  let p = 3;

  if (opts.minScore !== undefined) {
    conditions.push(`c.lead_score >= $${p++}`);
    params.push(opts.minScore);
  }
  if (opts.excludeUnsubscribed) {
    conditions.push(`NOT ('unsubscribed' = ANY(COALESCE(c.tags, '{}')))`);
  }
  // Exclude DNC contacts from email sequences (opt-out available for preview count purposes)
  if (opts.excludeDnc !== false) {
    conditions.push(`c.dnc IS NOT TRUE`);
  }
  if (opts.excludeActive && opts.sequenceId !== undefined) {
    // Mirror the enrollment INSERT guard. skipRecentlyEnrolled (default true)
    // adds the 24-hour window; toggling it off lets recently-completed contacts
    // be enrolled again in a new run.
    const recentClause = opts.skipRecentlyEnrolled !== false
      ? `OR se.enrolled_at >= NOW() - INTERVAL '24 hours'`
      : "";
    conditions.push(
      `c.id NOT IN (SELECT se.contact_id FROM sequence_enrollments se
                    WHERE se.sequence_id = $${p++}
                      AND (se.status = 'active' ${recentClause}))`
    );
    params.push(opts.sequenceId);
  }

  const result = await pool.query<{ id: number }>(
    `SELECT c.id FROM contacts c WHERE ${conditions.join(" AND ")} ORDER BY c.lead_score DESC`,
    params
  );
  return result.rows.map(x => x.id);
}


/**
 * Build per-step email stats by joining email_events → sequence_steps on template_id.
 * This gives true per-step attribution rather than an evenly-distributed approximation.
 * Falls back to aggregate-only if email_events is empty (e.g. no Resend configured).
 */
async function getStepStats(
  nodesJson: NodesJson | null,
  seqId: number,
  contactIds: number[],
  tenantId: number,
  runStart: string | null,
  runEnd: string | null
): Promise<StepStat[]> {
  if (!nodesJson || contactIds.length === 0) return [];
  const allNodes   = nodesJson.nodes ?? [];
  const emailNodes = allNodes.filter(n => n.type === "email");
  const waitNodes  = allNodes.filter(n => n.type === "wait");
  if (emailNodes.length === 0) return [];

  // Step-level attribution: join email_events to sequence_steps via templateId stored in config.
  // event_type values from sequence worker: 'sent'; from Resend webhook: 'opened','clicked','bounced'
  //
  // IMPORTANT: ss.step_order is the RAW published step order (0-indexed, includes every step
  // type — email, wait, tag, condition — not just emails). The output below is indexed by
  // *email-node position among email nodes only* (1, 2, 3...), which does NOT match step_order
  // whenever a non-email step (e.g. a wait step) sits between two email steps. We therefore
  // build a nodeId -> step_order lookup from the published steps and use THAT to key stepMap,
  // rather than assuming email node index N maps to stepMap[N]. Without this, any sequence with
  // an interstitial wait/tag/condition step attributes all of that step's stats to the wrong
  // (or a nonexistent) key, silently zeroing out real sent/opened/clicked counts for later email
  // steps and misattributing them via the activity_events fallback below.
  const publishedStepRows = await pool.query<{ id: number; step_order: number; node_id: string | null }>(
    `SELECT id, step_order, node_id FROM sequence_steps WHERE sequence_id = $1 ORDER BY step_order ASC`,
    [seqId]
  );
  const nodeIdToStepOrder: Record<string, number> = {};
  for (const row of publishedStepRows.rows) {
    if (row.node_id) nodeIdToStepOrder[row.node_id] = row.step_order;
  }

  const stepEventRows = await pool.query<{
    step_order: number; event_type: string; cnt: number;
  }>(
    `SELECT ss.step_order,
            ee.event_type,
            COUNT(*)::int AS cnt
     FROM email_events ee
     JOIN sequence_steps ss
       ON (ss.config->>'templateId')::int = ee.template_id
       AND ss.sequence_id = $1
     WHERE ee.contact_id = ANY($2::int[])
       AND ee.tenant_id = $3
       AND ee.event_type IN ('sent', 'opened', 'clicked', 'bounced')
       AND ($4::timestamptz IS NULL OR ee.occurred_at >= $4::timestamptz)
       AND ($5::timestamptz IS NULL OR ee.occurred_at <= $5::timestamptz)
     GROUP BY ss.step_order, ee.event_type
     ORDER BY ss.step_order`,
    [seqId, contactIds, tenantId, runStart ?? null, runEnd ?? null]
  );

  // Keyed by the RAW published step_order (matches publishedStepRows / nodeIdToStepOrder above).
  type StepCounts = { sent: number; opened: number; clicked: number; bounced: number };
  const stepMap: Record<number, StepCounts> = {};
  for (const row of stepEventRows.rows) {
    if (!stepMap[row.step_order]) stepMap[row.step_order] = { sent: 0, opened: 0, clicked: 0, bounced: 0 };
    if (row.event_type === "sent")    stepMap[row.step_order].sent    += row.cnt;
    if (row.event_type === "opened")  stepMap[row.step_order].opened  += row.cnt;
    if (row.event_type === "clicked") stepMap[row.step_order].clicked += row.cnt;
    if (row.event_type === "bounced") stepMap[row.step_order].bounced += row.cnt;
  }

  // Fallback: when sequence has no published steps (inline run path), the JOIN above returns
  // nothing because sequence_steps is empty. Query email_events directly by template IDs
  // extracted from nodes_json so open/click rates still appear in the run report.
  if (stepEventRows.rows.length === 0 && emailNodes.length > 0) {
    const templateIds = emailNodes
      .map(n => n.data.templateId)
      .filter((id): id is number => typeof id === "number" && id > 0);

    if (templateIds.length > 0) {
      const fallbackRows = await pool.query<{ template_id: number; event_type: string; cnt: number }>(
        `SELECT ee.template_id, ee.event_type, COUNT(*)::int AS cnt
         FROM email_events ee
         WHERE ee.contact_id = ANY($1::int[])
           AND ee.tenant_id = $2
           AND ee.template_id = ANY($3::int[])
           AND ee.event_type IN ('sent', 'opened', 'clicked', 'bounced')
           AND ($4::timestamptz IS NULL OR ee.occurred_at >= $4::timestamptz)
           AND ($5::timestamptz IS NULL OR ee.occurred_at <= $5::timestamptz)
         GROUP BY ee.template_id, ee.event_type`,
        [contactIds, tenantId, templateIds, runStart ?? null, runEnd ?? null]
      );
      const templateToStep: Record<number, number> = {};
      emailNodes.forEach((node, idx) => {
        const tid = node.data.templateId;
        if (typeof tid === "number") templateToStep[tid] = idx + 1;
      });
      for (const row of fallbackRows.rows) {
        const stepOrder = templateToStep[row.template_id] ?? 0;
        if (!stepOrder) continue;
        if (!stepMap[stepOrder]) stepMap[stepOrder] = { sent: 0, opened: 0, clicked: 0, bounced: 0 };
        if (row.event_type === "sent")    stepMap[stepOrder].sent    += row.cnt;
        if (row.event_type === "opened")  stepMap[stepOrder].opened  += row.cnt;
        if (row.event_type === "clicked") stepMap[stepOrder].clicked += row.cnt;
        if (row.event_type === "bounced") stepMap[stepOrder].bounced += row.cnt;
      }
    }
  }

  // Supplemental: use activity_events email_open / email_click as a catch-all source, but
  // ONLY when email_events has NO per-step data at all for that metric across the whole run.
  // This is a last resort for legacy sends (pixel/click token predates templateId tracking,
  // or a template was re-saved with a new id between runs) — it is a total-only aggregate with
  // no real per-step attribution, so it is dumped onto step 1 as a rough "something happened"
  // signal. Critically: once email_events has ANY real per-step opens/clicks (the normal case
  // now that click tokens carry templateId), we must NOT touch stepMap here — doing so used to
  // overwrite/inflate step 1 with a run-wide total while leaving other steps untouched, which is
  // exactly the "impossible numbers" bug (e.g. every step showing the same identical open count,
  // or step 1 showing more clicks than were ever sent for that step).
  const totalRealOpened  = Object.values(stepMap).reduce((s, c) => s + c.opened,  0);
  const totalRealClicked = Object.values(stepMap).reduce((s, c) => s + c.clicked, 0);
  if (contactIds.length > 0 && emailNodes.length > 0 && (totalRealOpened === 0 || totalRealClicked === 0)) {
    const aeRows = await pool.query<{ event_type: string; cnt: number }>(
      `SELECT event_type, COUNT(*)::int AS cnt
       FROM activity_events
       WHERE contact_id = ANY($1::int[])
         AND tenant_id = $2
         AND event_type IN ('email_open', 'email_click')
         AND ($3::timestamptz IS NULL OR created_at >= $3::timestamptz)
         AND ($4::timestamptz IS NULL OR created_at <= $4::timestamptz)
       GROUP BY event_type`,
      [contactIds, tenantId, runStart ?? null, runEnd ?? null]
    );
    const aeOpen  = aeRows.rows.find(r => r.event_type === "email_open")?.cnt  ?? 0;
    const aeClick = aeRows.rows.find(r => r.event_type === "email_click")?.cnt ?? 0;
    // Attribute to the first email node's REAL step_order (not display position 1),
    // so this fallback lands on the same key the primary join uses above.
    const firstEmailKey = nodeIdToStepOrder[emailNodes[0]?.id] ?? 1;
    if (!stepMap[firstEmailKey]) stepMap[firstEmailKey] = { sent: 0, opened: 0, clicked: 0, bounced: 0 };
    // Only fill in a metric that has zero real per-step data — never overwrite real counts.
    if (totalRealOpened === 0 && aeOpen > 0) stepMap[firstEmailKey].opened = aeOpen;
    if (totalRealClicked === 0 && aeClick > 0) stepMap[firstEmailKey].clicked = aeClick;
  }

  return emailNodes.map((node, idx) => {
    const displayStepNum = idx + 1;
    // Use the node's real published step_order (includes wait/tag/condition steps) to look up
    // stats, falling back to display position only for unpublished (nodes_json-only) sequences
    // where nodeIdToStepOrder is empty and the fallback block above already keyed by idx+1.
    const lookupKey = nodeIdToStepOrder[node.id] ?? displayStepNum;
    const st        = stepMap[lookupKey] ?? { sent: 0, opened: 0, clicked: 0, bounced: 0 };
    const data      = node.data;
    const wait      = waitNodes[idx];
    return {
      stepNum:   displayStepNum,
      label:     String(data.label   ?? `Email ${displayStepNum}`),
      subject:   data.subject !== undefined ? String(data.subject) : undefined,
      sent:      st.sent,
      opened:    st.opened,
      clicked:   st.clicked,
      bounced:   st.bounced,
      openRate:  st.sent > 0 ? Math.round((st.opened  / st.sent) * 100) : 0,
      clickRate: st.sent > 0 ? Math.round((st.clicked / st.sent) * 100) : 0,
      waitLabel: wait?.data?.label !== undefined ? String(wait.data.label) : undefined,
    };
  });
}

// ── Routes: /api/sequences/:seqId/runs (canonical) ───────────────────────────

// GET /api/sequences/:seqId/runs
router.get("/sequences/:seqId/runs", async (req, res, next): Promise<void> => {
  const seqId = parseInt(req.params.seqId);
  if (isNaN(seqId)) { res.status(400).json({ error: "Invalid sequence id" }); return; }
  try {
    const user = req.user as AuthUser;
    if (!await verifyTenantOwnsEntity("email_sequences", seqId, user.tenantId)) {
      res.status(404).json({ error: "Not found" }); return;
    }
    const rows = (await db.execute(sql`
      SELECT r.*,
        s.name AS sequence_name,
        j.name AS journey_name,
        cl.name AS client_name,
        u.first_name || ' ' || u.last_name AS started_by_name
      FROM sequence_runs r
      LEFT JOIN email_sequences s ON s.id = r.sequence_id
      LEFT JOIN journeys j ON j.id = r.journey_id
      LEFT JOIN clients cl ON cl.id = r.client_id
      LEFT JOIN users u ON u.id = r.started_by
      WHERE r.tenant_id = ${user.tenantId} AND r.sequence_id = ${seqId}
      ORDER BY r.created_at DESC
      LIMIT 50
    `)).rows;
    res.json(rows);
  } catch (err) { next(err); }
});

// POST /api/sequences/:seqId/runs — create a run, async enrollment
router.post("/sequences/:seqId/runs", async (req, res, next): Promise<void> => {
  const seqId = parseInt(req.params.seqId);
  if (isNaN(seqId)) { res.status(400).json({ error: "Invalid sequence id" }); return; }
  const body = { ...req.body, sequenceId: seqId };
  const parsed = CreateRunBody.safeParse(body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  try {
    const user = req.user as AuthUser;
    const d    = parsed.data;

    if (!await verifyTenantOwnsEntity("email_sequences", d.sequenceId, user.tenantId)) {
      res.status(403).json({ error: "Sequence not found" }); return;
    }
    if (d.journeyId && !await verifyTenantOwnsEntity("journeys", d.journeyId, user.tenantId)) {
      res.status(403).json({ error: "Journey not found" }); return;
    }
    if (d.clientId && !await verifyTenantOwnsEntity("clients", d.clientId, user.tenantId)) {
      res.status(403).json({ error: "Client not found" }); return;
    }
    if (d.segmentId && !await verifyTenantOwnsEntity("segments", d.segmentId, user.tenantId)) {
      res.status(403).json({ error: "Segment not found" }); return;
    }

    // Guard: reject runs where every email node is missing a template.
    // This catches sequences that were built but never had templates assigned.
    {
      const seqCheck = await pool.query<{ nodes_json: unknown; step_count: string }>(
        `SELECT es.nodes_json,
                (SELECT COUNT(*) FROM sequence_steps ss WHERE ss.sequence_id = es.id)::text AS step_count
         FROM email_sequences es WHERE es.id = $1`,
        [d.sequenceId]
      );
      const stepCount = Number(seqCheck.rows[0]?.step_count ?? 0);
      if (stepCount === 0) {
        const nj = seqCheck.rows[0]?.nodes_json as { nodes?: Array<{ type: string; data?: Record<string, unknown> }> } | null;
        const emailNodes = (nj?.nodes ?? []).filter(n => n.type === "email");
        if (emailNodes.length > 0 && emailNodes.every(n => !n.data?.templateId)) {
          res.status(422).json({
            error: "Sequence not ready: all email nodes are missing a template. Open the sequence editor and assign an email template to each step before running.",
          });
          return;
        }
      }
    }

    // ── Create the run record immediately so the 201 can be returned now ──────
    // Audience resolution (resolveContactIds) can take 30+ seconds on large
    // tenants — it must NOT block the HTTP response. We create the run with
    // contact_list_ids = NULL and total_contacts = -1 (sentinel for "resolving"),
    // respond 201, then do the full resolution in a background async task.
    const isScheduled = !!d.scheduledAt && new Date(d.scheduledAt) > new Date();
    const runStatus   = isScheduled ? "scheduled" : "pending";

    const runRow = (await pool.query(
      `INSERT INTO sequence_runs
         (tenant_id, sequence_id, play_id, journey_id, client_id, segment_id,
          contact_list_ids, status, total_contacts, enrolled, skipped, started_by,
          scheduled_at, send_window_start, send_window_end, daily_cap, send_days,
          dnc_excluded_count, skip_recently_enrolled)
       VALUES ($1,$2,$3,$4,$5,$6,NULL,$7,-1,0,0,$8,$9,$10,$11,$12,$13::integer[],0,$14)
       RETURNING *`,
      [
        user.tenantId, d.sequenceId, d.playId ?? null,
        d.journeyId ?? null, d.clientId ?? null, d.segmentId ?? null,
        runStatus, user.id,
        d.scheduledAt              ?? null,
        d.sendWindowStart          ?? "09:00",
        d.sendWindowEnd            ?? "18:00",
        d.dailyCap                 ?? null,
        d.sendDays                 ?? [1, 2, 3, 4, 5],
        d.skipRecentlyEnrolled     ?? true,
      ]
    )).rows[0] as { id: number };

    // Respond immediately — UI can start polling straight away.
    res.status(201).json({ ...runRow, enrolled: 0 });

    // ── Background: resolve audience, update run, kick off enrollment ─────────
    const runId    = runRow.id;
    const tenantId = user.tenantId;
    const seqIdCap = d.sequenceId;

    setImmediate(async () => {
      let contactIds: number[];
      let dncExcludedCount = 0;
      try {
        if (d.manualEmails && d.manualEmails.length > 0) {
          // Resolve emails → contact IDs (tenant-scoped). Auto-create minimal
          // contact rows for addresses that don't exist yet.
          const emails = d.manualEmails.map(e => e.trim().toLowerCase()).filter(e => e.includes("@"));
          const r = await pool.query<{ id: number; email: string }>(
            `SELECT id, LOWER(email) AS email FROM contacts WHERE LOWER(email) = ANY($1::text[]) AND tenant_id = $2`,
            [emails, user.tenantId]
          );
          const existingByEmail = new Map(r.rows.map(x => [x.email, x.id]));
          const resolvedIds: number[] = [];
          for (const email of emails) {
            if (existingByEmail.has(email)) {
              resolvedIds.push(existingByEmail.get(email)!);
            } else {
              const localPart   = email.split("@")[0] ?? "";
              const firstName   = localPart.split(/[._\-+]/).filter(Boolean)
                .map(s => s.charAt(0).toUpperCase() + s.slice(1)).join(" ");
              const companyName = email.split("@")[1]?.split(".")[0] ?? "";
              const ins = await pool.query<{ id: number }>(
                `INSERT INTO contacts
                   (tenant_id, client_id, email, first_name, company_name, source,
                    status, stage, tags, lead_score, distinct_active_days,
                    intent_score, raw_intent_score, intent_state, created_at, updated_at)
                 VALUES ($1,$2,$3,$4,$5,'sequence','active','pre-aware','{}',0,0,0,0,'Browsing',NOW(),NOW())
                 ON CONFLICT DO NOTHING RETURNING id`,
                [user.tenantId, d.clientId ?? null, email, firstName || localPart, companyName]
              );
              if (ins.rows[0]) {
                resolvedIds.push(ins.rows[0].id);
              } else {
                const retry = await pool.query<{ id: number }>(
                  `SELECT id FROM contacts WHERE LOWER(email)=$1 AND tenant_id=$2 LIMIT 1`,
                  [email, user.tenantId]
                );
                if (retry.rows[0]) resolvedIds.push(retry.rows[0].id);
              }
            }
          }
          contactIds = resolvedIds;
        } else if (d.contactIds && d.contactIds.length > 0) {
          const valid = await pool.query<{ id: number }>(
            `SELECT id FROM contacts WHERE id = ANY($1::int[]) AND tenant_id = $2`,
            [d.contactIds, user.tenantId]
          );
          contactIds = valid.rows.map(r => r.id);
        } else {
          // Main path: full audience resolution with DNC split.
          const preDncIds = await resolveContactIds(user.tenantId, {
            journeyId:            d.journeyId,
            clientId:             d.clientId,
            segmentId:            d.segmentId,
            segmentIds:           d.segmentIds,
            segmentMode:          d.segmentMode,
            sequenceId:           d.sequenceId,
            excludeActive:        d.excludeActive,
            skipRecentlyEnrolled: d.skipRecentlyEnrolled,
            excludeUnsubscribed:  d.excludeUnsubscribed,
            minScore:             d.minScore,
            excludeDnc:           false,
          });
          if (preDncIds.length > 0) {
            const dncRows = await pool.query<{ id: number }>(
              `SELECT id FROM contacts WHERE id = ANY($1::int[]) AND tenant_id = $2 AND dnc = true`,
              [preDncIds, user.tenantId]
            );
            const dncSet = new Set(dncRows.rows.map(r => r.id));
            dncExcludedCount = dncSet.size;
            contactIds = dncSet.size === 0 ? preDncIds : preDncIds.filter(id => !dncSet.has(id));
          } else {
            contactIds = [];
          }
        }

        const totalContacts = contactIds.length;

        // Stamp the run with the resolved contact list now that we have it.
        await pool.query(
          `UPDATE sequence_runs
           SET contact_list_ids = $2::integer[], total_contacts = $3, dnc_excluded_count = $4
           WHERE id = $1`,
          [runId, totalContacts > 0 ? contactIds : [], totalContacts, dncExcludedCount]
        );

        if (isScheduled) {
          const delayMs = Math.max(0, new Date(d.scheduledAt!).getTime() - Date.now());
          await enqueueRunStart({ runId, sequenceId: seqIdCap, tenantId }, delayMs);
        } else {
          const playIdCap = d.playId;
          const enqResult: EnqueueResult = await enqueueRunStart({ runId, sequenceId: seqIdCap, tenantId });
          if (enqResult === "unavailable" || enqResult === "error") {
            setImmediate(() => {
              runContactEnrollment(runId, seqIdCap, tenantId, contactIds, playIdCap)
                .catch(() => pool.query(`UPDATE sequence_runs SET status='error' WHERE id=$1`, [runId]).catch(() => {}));
            });
          }
        }
      } catch (bgErr) {
        logger.error({ bgErr, runId }, "Background audience resolution failed — marking run as error");
        pool.query(`UPDATE sequence_runs SET status='error' WHERE id=$1`, [runId]).catch(() => {});
      }
    });
  } catch (err) { next(err); }
});

// GET /api/sequences/:seqId/runs/preview — estimate contact count without creating a run
// MUST be registered BEFORE /:runId to avoid Express matching "preview" as a runId
router.get("/sequences/:seqId/runs/preview", async (req, res, next): Promise<void> => {
  const seqId = parseInt(req.params.seqId);
  if (isNaN(seqId)) { res.status(400).json({ error: "Invalid sequence id" }); return; }
  try {
    const user = req.user as AuthUser;
    if (!await verifyTenantOwnsEntity("email_sequences", seqId, user.tenantId)) {
      res.status(404).json({ error: "Not found" }); return;
    }

    const q = req.query;
    const segIds = q.segmentIds
      ? (q.segmentIds as string).split(",").map(Number).filter(n => !isNaN(n) && n > 0)
      : undefined;
    const rawMode = q.segmentMode as string | undefined;
    const segMode: "union" | "intersection" =
      rawMode === "intersection" ? "intersection" : "union";

    const sourceOpts = {
      journeyId:  q.journeyId  ? parseInt(q.journeyId  as string) : undefined,
      clientId:   q.clientId   ? parseInt(q.clientId   as string) : undefined,
      segmentId:  q.segmentId  ? parseInt(q.segmentId  as string) : undefined,
      segmentIds: segIds,
      segmentMode: segMode,
    };

    // Resolve included contacts (with all exclusion filters applied)
    const ids = await resolveContactIds(user.tenantId, {
      ...sourceOpts,
      sequenceId:          seqId,
      excludeActive:       q.excludeActive  !== "false",
      excludeUnsubscribed: q.excludeUnsubscribed !== "false",
      minScore:            q.minScore ? parseInt(q.minScore as string) : undefined,
    });

    type SampleContact = { id: number; first_name: string; last_name: string; email: string; lead_score: number };
    type ScoreDistribution = { cold: string; warm: string; hot: string; champion: string };
    const result: {
      estimatedCount: number;
      sampleContacts?: SampleContact[];
      scoreDistribution?: { cold: number; warm: number; hot: number; champion: number };
      excludedCount?: number;
      excludedSample?: SampleContact[];
      dncExcludedCount?: number;
      dncExcludedSample?: SampleContact[];
      personalizationWarning?: boolean;
      personalizationMissingCount?: number;
    } = { estimatedCount: ids.length };

    if (req.query.includeContacts === "true" && ids.length > 0) {
      const [contactRows, distRow] = await Promise.all([
        pool.query<SampleContact>(
          `SELECT id, first_name, last_name, email, lead_score
           FROM contacts WHERE id = ANY($1::int[]) AND tenant_id = $2
           ORDER BY lead_score DESC LIMIT 20`,
          [ids.slice(0, 20), user.tenantId]
        ),
        pool.query<ScoreDistribution>(
          `SELECT
             COUNT(*) FILTER (WHERE lead_score < 25)               AS cold,
             COUNT(*) FILTER (WHERE lead_score BETWEEN 25 AND 49)  AS warm,
             COUNT(*) FILTER (WHERE lead_score BETWEEN 50 AND 74)  AS hot,
             COUNT(*) FILTER (WHERE lead_score >= 75)              AS champion
           FROM contacts WHERE id = ANY($1::int[]) AND tenant_id = $2`,
          [ids, user.tenantId]
        ),
      ]);
      result.sampleContacts = contactRows.rows;
      const d = distRow.rows[0];
      result.scoreDistribution = {
        cold:     Number(d?.cold     ?? 0),
        warm:     Number(d?.warm     ?? 0),
        hot:      Number(d?.hot      ?? 0),
        champion: Number(d?.champion ?? 0),
      };
    }

    // Excluded contacts: resolve base set (no exclusion filters) and diff against included
    if (req.query.includeExcluded === "true") {
      const baseIds = await resolveContactIds(user.tenantId, sourceOpts);
      const includedSet = new Set(ids);
      const excludedIds = baseIds.filter(id => !includedSet.has(id));
      result.excludedCount = excludedIds.length;
      if (excludedIds.length > 0) {
        const excRows = await pool.query<SampleContact>(
          `SELECT id, first_name, last_name, email, lead_score
           FROM contacts WHERE id = ANY($1::int[]) AND tenant_id = $2
           ORDER BY lead_score DESC LIMIT 10`,
          [excludedIds.slice(0, 10), user.tenantId]
        );
        result.excludedSample = excRows.rows;
      }
    }

    // DNC excluded contacts: always compute so Step 5 can show them.
    // Use excludeDnc:false to get the raw scoped set, then count contacts with dnc=true.
    {
      const rawScopedIds = await resolveContactIds(user.tenantId, {
        ...sourceOpts,
        excludeDnc: false,
      });
      if (rawScopedIds.length > 0) {
        const dncCountRow = await pool.query<{ cnt: string }>(
          `SELECT COUNT(*)::text AS cnt FROM contacts
           WHERE id = ANY($1::int[]) AND tenant_id = $2 AND dnc = true`,
          [rawScopedIds, user.tenantId]
        );
        result.dncExcludedCount = Number(dncCountRow.rows[0]?.cnt ?? 0);
        if (result.dncExcludedCount > 0) {
          const dncRows = await pool.query<SampleContact>(
            `SELECT id, first_name, last_name, email, lead_score FROM contacts
             WHERE id = ANY($1::int[]) AND tenant_id = $2 AND dnc = true
             ORDER BY lead_score DESC LIMIT 10`,
            [rawScopedIds, user.tenantId]
          );
          result.dncExcludedSample = dncRows.rows;
        }
      }
    }

    // Personalization warning: count contacts missing first_name or email
    if (ids.length > 0) {
      const missingRow = await pool.query<{ cnt: string }>(
        `SELECT COUNT(*)::text AS cnt FROM contacts
         WHERE id = ANY($1::int[]) AND tenant_id = $2
           AND (COALESCE(TRIM(first_name), '') = '' OR COALESCE(TRIM(email), '') = '')`,
        [ids, user.tenantId]
      );
      const missingCount = Number(missingRow.rows[0]?.cnt ?? 0);
      result.personalizationWarning    = missingCount > 0;
      result.personalizationMissingCount = missingCount;
    }

    // Sequence health: check that every email node has a templateId configured.
    // A sequence with unconfigured email nodes will silently produce 0 emails sent.
    {
      const seqRow = await pool.query<{ nodes_json: unknown; step_count: string }>(
        `SELECT es.nodes_json,
                (SELECT COUNT(*) FROM sequence_steps ss WHERE ss.sequence_id = es.id)::text AS step_count
         FROM email_sequences es WHERE es.id = $1`,
        [seqId]
      );
      const nodesJson = seqRow.rows[0]?.nodes_json as {
        nodes?: Array<{ type: string; data?: Record<string, unknown> }>;
      } | null;
      const stepCount = Number(seqRow.rows[0]?.step_count ?? 0);

      // Only flag unconfigured nodes when we'll use the nodes_json path (no published steps)
      if (stepCount === 0 && nodesJson?.nodes) {
        const emailNodes = nodesJson.nodes.filter(n => n.type === "email");
        const unconfigured = emailNodes.filter(n => !n.data?.templateId);
        (result as any).unconfiguredEmailNodes = unconfigured.length;
        (result as any).totalEmailNodes        = emailNodes.length;
      } else {
        (result as any).unconfiguredEmailNodes = 0;
        (result as any).totalEmailNodes        = 0;
      }
    }

    res.json(result);
  } catch (err) { next(err); }
});

// GET /api/sequences/:seqId/runs/:runId — per-run detail
router.get("/sequences/:seqId/runs/:runId", async (req, res, next): Promise<void> => {
  const seqId = parseInt(req.params.seqId);
  const runId = parseInt(req.params.runId);
  if (isNaN(seqId) || isNaN(runId)) { res.status(400).json({ error: "Invalid id" }); return; }
  try {
    const user = req.user as AuthUser;
    const run = (await pool.query(
      `SELECT r.*,
         s.name AS sequence_name, s.nodes_json AS nodes,
         j.name AS journey_name,
         cl.name AS client_name,
         u.first_name || ' ' || u.last_name AS started_by_name
       FROM sequence_runs r
       LEFT JOIN email_sequences s ON s.id = r.sequence_id
       LEFT JOIN journeys j ON j.id = r.journey_id
       LEFT JOIN clients cl ON cl.id = r.client_id
       LEFT JOIN users u ON u.id = r.started_by
       WHERE r.id = $1 AND r.sequence_id = $2 AND r.tenant_id = $3`,
      [runId, seqId, user.tenantId]
    )).rows[0] as Record<string, unknown> | undefined;

    if (!run) { res.status(404).json({ error: "Not found" }); return; }

    // Source run-scoped contacts: contact_list_ids defines which contacts were targeted
    // for THIS run; LEFT JOIN sequence_enrollments on run_id to get accurate per-contact
    // enrollment status without mixing in contacts from other runs of the same sequence.
    const rawRunIds = run.contact_list_ids;
    const runContactIds = parseContactListIds(rawRunIds);

    type ContactRow = {
      id: number; first_name: string; last_name: string; email: string; lead_score: number;
      enrollment_status: string; enrolled_at: string | null;
    };
    // Pagination for the contacts table: ?contactPage=1&contactLimit=500
    const contactLimit = Math.min(parseInt(String(req.query.contactLimit ?? "500")), 2000);
    const contactPage  = Math.max(parseInt(String(req.query.contactPage  ?? "1")), 1);
    const contactOffset = (contactPage - 1) * contactLimit;
    const totalContacts = runContactIds.length;

    let enrolledContacts: (ContactRow & { opens: number; clicks: number })[] = [];
    if (runContactIds.length > 0) {
      const paginatedIds = runContactIds.slice(contactOffset, contactOffset + contactLimit);
      const r2 = await pool.query<ContactRow>(
        `SELECT c.id, c.first_name, c.last_name, c.email, COALESCE(c.lead_score, 0) AS lead_score,
                COALESCE(se.status, 'skipped') AS enrollment_status,
                se.enrolled_at::text AS enrolled_at,
                co.name AS company_name,
                se.id AS enrollment_id,
                COALESCE(se.resume_error_count, 0) AS resume_error_count
         FROM contacts c
         LEFT JOIN sequence_enrollments se
           ON se.contact_id = c.id AND se.run_id = $1
         LEFT JOIN companies co ON co.id = c.company_id AND co.tenant_id = c.tenant_id
         WHERE c.id = ANY($2::int[]) AND c.tenant_id = $3
         ORDER BY c.lead_score DESC NULLS LAST`,
        [runId, paginatedIds, user.tenantId]
      );
      // Per-contact opens/clicks for this run: count email_events on templates used by THIS
      // sequence's steps (primary source) UNION activity_events email_open/email_click as a
      // catch-all for pixels/links that had no templateId — same dual-source approach as
      // getStepStats, but aggregated per contact instead of per step.
      const templateIdRows = await pool.query<{ template_id: number }>(
        `SELECT DISTINCT (config->>'templateId')::int AS template_id
         FROM sequence_steps WHERE sequence_id = $1 AND config->>'templateId' IS NOT NULL`,
        [seqId]
      );
      const seqTemplateIds = templateIdRows.rows.map(r => r.template_id).filter(Boolean);
      const perContactIds  = r2.rows.map(c => c.id);
      const opensMap: Record<number, number>  = {};
      const clicksMap: Record<number, number> = {};
      if (perContactIds.length > 0) {
        if (seqTemplateIds.length > 0) {
          const evRows = await pool.query<{ contact_id: number; event_type: string; cnt: number }>(
            `SELECT contact_id, event_type, COUNT(*)::int AS cnt
             FROM email_events
             WHERE contact_id = ANY($1::int[]) AND tenant_id = $2
               AND template_id = ANY($3::int[])
               AND event_type IN ('opened', 'clicked')
               AND ($4::timestamptz IS NULL OR occurred_at >= $4::timestamptz)
               AND ($5::timestamptz IS NULL OR occurred_at <= $5::timestamptz)
             GROUP BY contact_id, event_type`,
            [perContactIds, user.tenantId, seqTemplateIds,
             (run.started_at as string | null) ?? null, (run.completed_at as string | null) ?? null]
          );
          for (const row of evRows.rows) {
            if (row.event_type === "opened")  opensMap[row.contact_id]  = (opensMap[row.contact_id]  ?? 0) + row.cnt;
            if (row.event_type === "clicked") clicksMap[row.contact_id] = (clicksMap[row.contact_id] ?? 0) + row.cnt;
          }
        }
        const aeRows = await pool.query<{ contact_id: number; event_type: string; cnt: number }>(
          `SELECT contact_id, event_type, COUNT(*)::int AS cnt
           FROM activity_events
           WHERE contact_id = ANY($1::int[]) AND tenant_id = $2
             AND event_type IN ('email_open', 'email_click')
             AND ($3::timestamptz IS NULL OR created_at >= $3::timestamptz)
             AND ($4::timestamptz IS NULL OR created_at <= $4::timestamptz)
           GROUP BY contact_id, event_type`,
          [perContactIds, user.tenantId,
           (run.started_at as string | null) ?? null, (run.completed_at as string | null) ?? null]
        );
        for (const row of aeRows.rows) {
          // Take the higher of the two sources per contact, per metric — mirrors the run-level
          // fallback logic so per-contact counts never contradict the per-step/run totals.
          if (row.event_type === "email_open"  && row.cnt > (opensMap[row.contact_id]  ?? 0)) opensMap[row.contact_id]  = row.cnt;
          if (row.event_type === "email_click" && row.cnt > (clicksMap[row.contact_id] ?? 0)) clicksMap[row.contact_id] = row.cnt;
        }
      }
      enrolledContacts = r2.rows.map(c => ({
        ...c,
        opens:  opensMap[c.id]  ?? 0,
        clicks: clicksMap[c.id] ?? 0,
      }));
    }
    // Enrolled IDs for charts/stats = all enrolled (not paginated), up to 1000
    const allEnrolledIds = runContactIds.length > 0
      ? (await pool.query<{ id: number }>(
          `SELECT c.id FROM contacts c
           JOIN sequence_enrollments se ON se.contact_id = c.id AND se.run_id = $1
           WHERE c.id = ANY($2::int[]) AND c.tenant_id = $3
           ORDER BY c.lead_score DESC NULLS LAST LIMIT 1000`,
          [runId, runContactIds.slice(0, 1000), user.tenantId]
        )).rows.map(r => r.id)
      : [];
    const enrolledIds = allEnrolledIds;

    let nodesJson: NodesJson | null = null;
    if (run.nodes) {
      nodesJson = typeof run.nodes === "string"
        ? (JSON.parse(run.nodes) as NodesJson)
        : (run.nodes as NodesJson);
    }

    const stepStats = await getStepStats(
      nodesJson, seqId, enrolledIds, user.tenantId,
      (run.started_at as string | null) ?? null,
      (run.completed_at as string | null) ?? null
    );

    // Enrollment timeline: count of new enrollments per day
    let enrollmentTimeline: Array<{ date: string; count: number }> = [];
    if (enrolledIds.length > 0) {
      const tl = await pool.query<{ date: string; count: number }>(
        `SELECT to_char(enrolled_at::date, 'YYYY-MM-DD') AS date, COUNT(*)::int AS count
         FROM sequence_enrollments
         WHERE run_id = $1 AND contact_id = ANY($2::int[]) AND enrolled_at IS NOT NULL
         GROUP BY enrolled_at::date ORDER BY enrolled_at::date`,
        [runId, enrolledIds]
      );
      enrollmentTimeline = tl.rows;
    }

    // Email event timeline: email opens/clicks per day during this run window
    const emailTimeline = enrolledIds.length > 0
      ? (await pool.query<{ date: string; event_type: string; count: number }>(
          `SELECT to_char(created_at::date, 'YYYY-MM-DD') AS date,
                  event_type, COUNT(*)::int AS count
           FROM activity_events
           WHERE contact_id = ANY($1::int[]) AND tenant_id = $2
             AND event_type IN ('email_open','email_click','email_bounced')
             AND ($3::timestamptz IS NULL OR created_at >= $3::timestamptz)
             AND ($4::timestamptz IS NULL OR created_at <= $4::timestamptz)
           GROUP BY created_at::date, event_type ORDER BY date`,
          [enrolledIds, user.tenantId,
           (run.started_at as string | null) ?? null,
           (run.completed_at as string | null) ?? null]
        )).rows
      : [];

    // Backfill-skipped contacts: contacts in this run whose intent state changed during a
    // CSV backfill but whose routing-rule evaluation (and sequence enrollment) was suppressed.
    // These contacts have a `sequence_enrollment_skipped` activity event with source='backfill'.
    // Events are scoped to the run window (started_at … completed_at) so contacts that had a
    // backfill-suppression event from a different run period are not counted here.
    // Upper bound falls back to NOW() for still-running runs, mirroring the email timeline query.
    let backfillSkippedContacts: Array<{
      id: number; first_name: string; last_name: string; email: string;
      lead_score: number; company_name: string | null; skipped_at: string;
    }> = [];
    if (runContactIds.length > 0) {
      const runStart  = (run.started_at  as string | null) ?? null;
      const runEnd    = (run.completed_at as string | null) ?? null;
      const bsRows = await pool.query<{
        id: number; first_name: string; last_name: string; email: string;
        lead_score: number; company_name: string | null; skipped_at: string;
      }>(
        `SELECT DISTINCT ON (c.id)
                c.id, c.first_name, c.last_name, c.email,
                COALESCE(c.lead_score, 0) AS lead_score,
                co.name AS company_name,
                ae.created_at::text AS skipped_at
         FROM activity_events ae
         JOIN contacts c ON c.id = ae.contact_id AND c.tenant_id = ae.tenant_id
         LEFT JOIN companies co ON co.id = c.company_id AND co.tenant_id = c.tenant_id
         WHERE ae.contact_id = ANY($1::int[])
           AND ae.tenant_id = $2
           AND ae.event_type = 'sequence_enrollment_skipped'
           AND ae.source = 'backfill'
           AND ($3::timestamptz IS NULL OR ae.created_at >= $3::timestamptz)
           AND ae.created_at <= COALESCE($4::timestamptz, NOW())
         ORDER BY c.id, ae.created_at DESC`,
        [runContactIds, user.tenantId, runStart, runEnd]
      );
      backfillSkippedContacts = bsRows.rows;
    }
    const backfillSkippedCount = backfillSkippedContacts.length;

    // Count enrollments with status='errored' for this run
    const erroredCountRow = await pool.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM sequence_enrollments WHERE run_id = $1 AND status = 'errored'`,
      [runId]
    );
    const erroredEnrollmentCount = erroredCountRow.rows[0]?.count ?? 0;

    res.json({
      ...run,
      enrolledContacts, totalContacts,
      contactPage, contactLimit,
      stepStats, enrollmentTimeline, emailTimeline,
      backfillSkippedContacts, backfillSkippedCount,
      erroredEnrollmentCount,
    });
  } catch (err) { next(err); }
});

// GET /api/sequences/:seqId/runs/:runId/contacts/:contactId/events — email history per contact
router.get("/sequences/:seqId/runs/:runId/contacts/:contactId/events", async (req, res, next): Promise<void> => {
  const seqId     = parseInt(req.params.seqId);
  const runId     = parseInt(req.params.runId);
  const contactId = parseInt(req.params.contactId);
  if (isNaN(seqId) || isNaN(runId) || isNaN(contactId)) { res.status(400).json({ error: "Invalid id" }); return; }
  try {
    const user = req.user as AuthUser;

    // Verify run belongs to the specified sequence and tenant
    const runRow = await pool.query<{
      started_at: string | null; completed_at: string | null; contact_list_ids: unknown;
    }>(
      `SELECT started_at, completed_at, contact_list_ids
       FROM sequence_runs
       WHERE id=$1 AND sequence_id=$2 AND tenant_id=$3`,
      [runId, seqId, user.tenantId]
    );
    if (!runRow.rows[0]) { res.status(404).json({ error: "Not found" }); return; }

    // Verify contact was targeted in this run (either enrolled or skipped)
    const runContactIds = parseContactListIds(runRow.rows[0].contact_list_ids);
    if (!runContactIds.includes(contactId)) {
      res.status(404).json({ error: "Contact not part of this run" }); return;
    }

    const { started_at, completed_at } = runRow.rows[0];
    const events = await pool.query(
      `SELECT event_type, metadata, created_at
       FROM activity_events
       WHERE contact_id=$1 AND tenant_id=$2
         AND event_type IN ('email_sent','email_open','email_click','email_bounced','sequence_enrolled')
         AND ($3::timestamptz IS NULL OR created_at >= $3::timestamptz)
         AND ($4::timestamptz IS NULL OR created_at <= $4::timestamptz)
       ORDER BY created_at DESC LIMIT 50`,
      [contactId, user.tenantId, started_at ?? null, completed_at ?? null]
    );
    res.json(events.rows);
  } catch (err) { next(err); }
});

// GET /api/sequences/:seqId/runs/:runId/steps/:stepNum/who?type=opened|clicked|sent|bounced
// Drill-down: WHO triggered a given event type for a given step in this run. stepNum is the
// 1-indexed display position among email nodes (matches StepStat.stepNum in the UI).
router.get("/sequences/:seqId/runs/:runId/steps/:stepNum/who", async (req, res, next): Promise<void> => {
  const seqId   = parseInt(req.params.seqId);
  const runId   = parseInt(req.params.runId);
  const stepNum = parseInt(req.params.stepNum);
  const type    = String(req.query.type ?? "opened");
  if (isNaN(seqId) || isNaN(runId) || isNaN(stepNum) || stepNum < 1) {
    res.status(400).json({ error: "Invalid id" }); return;
  }
  if (!["sent", "opened", "clicked", "bounced"].includes(type)) {
    res.status(400).json({ error: "Invalid type" }); return;
  }
  try {
    const user = req.user as AuthUser;
    const run = (await pool.query(
      `SELECT r.started_at, r.completed_at, r.contact_list_ids, s.nodes_json AS nodes
       FROM sequence_runs r
       LEFT JOIN email_sequences s ON s.id = r.sequence_id
       WHERE r.id = $1 AND r.sequence_id = $2 AND r.tenant_id = $3`,
      [runId, seqId, user.tenantId]
    )).rows[0] as { started_at: string | null; completed_at: string | null; contact_list_ids: unknown; nodes: unknown } | undefined;
    if (!run) { res.status(404).json({ error: "Not found" }); return; }

    let nodesJson: NodesJson | null = null;
    if (run.nodes) {
      nodesJson = typeof run.nodes === "string" ? (JSON.parse(run.nodes) as NodesJson) : (run.nodes as NodesJson);
    }
    const emailNodes = (nodesJson?.nodes ?? []).filter(n => n.type === "email");
    const targetNode  = emailNodes[stepNum - 1];
    if (!targetNode) { res.status(404).json({ error: "Step not found" }); return; }

    // Resolve the published step_order for this node, then its templateId — mirrors getStepStats.
    const publishedStepRows = await pool.query<{ id: number; step_order: number; node_id: string | null; template_id: number | null }>(
      `SELECT id, step_order, node_id, (config->>'templateId')::int AS template_id
       FROM sequence_steps WHERE sequence_id = $1 ORDER BY step_order ASC`,
      [seqId]
    );
    let templateId: number | null = publishedStepRows.rows.find(r => r.node_id === targetNode.id)?.template_id ?? null;
    if (!templateId) {
      const fallbackTid = targetNode.data.templateId;
      templateId = typeof fallbackTid === "number" ? fallbackTid : null;
    }

    const runContactIds = parseContactListIds(run.contact_list_ids);
    const enrolledIds = runContactIds.length > 0
      ? (await pool.query<{ id: number }>(
          `SELECT c.id FROM contacts c
           JOIN sequence_enrollments se ON se.contact_id = c.id AND se.run_id = $1
           WHERE c.id = ANY($2::int[]) AND c.tenant_id = $3`,
          [runId, runContactIds, user.tenantId]
        )).rows.map(r => r.id)
      : [];
    if (enrolledIds.length === 0 || !templateId) { res.json([]); return; }

    const rows = await pool.query(
      `SELECT c.id, c.first_name, c.last_name, c.email, MAX(ee.occurred_at)::text AS occurred_at
       FROM email_events ee
       JOIN contacts c ON c.id = ee.contact_id AND c.tenant_id = ee.tenant_id
       WHERE ee.contact_id = ANY($1::int[]) AND ee.tenant_id = $2
         AND ee.template_id = $3 AND ee.event_type = $4
         AND ($5::timestamptz IS NULL OR ee.occurred_at >= $5::timestamptz)
         AND ($6::timestamptz IS NULL OR ee.occurred_at <= $6::timestamptz)
       GROUP BY c.id, c.first_name, c.last_name, c.email
       ORDER BY occurred_at DESC`,
      [enrolledIds, user.tenantId, templateId, type, run.started_at ?? null, run.completed_at ?? null]
    );

    // For step 1 (first email), also fold in the activity_events catch-all (opens/clicks that
    // had no templateId), same dual-source approach as getStepStats — avoids drill-down showing
    // fewer names than the KPI number for that step.
    let extra: typeof rows.rows = [];
    if (stepNum === 1 && (type === "opened" || type === "clicked")) {
      const aeEventType = type === "opened" ? "email_open" : "email_click";
      const alreadyIds = new Set(rows.rows.map(r => r.id));
      const aeRows = await pool.query(
        `SELECT c.id, c.first_name, c.last_name, c.email, MAX(ae.created_at)::text AS occurred_at
         FROM activity_events ae
         JOIN contacts c ON c.id = ae.contact_id AND c.tenant_id = ae.tenant_id
         WHERE ae.contact_id = ANY($1::int[]) AND ae.tenant_id = $2 AND ae.event_type = $3
           AND ($4::timestamptz IS NULL OR ae.created_at >= $4::timestamptz)
           AND ($5::timestamptz IS NULL OR ae.created_at <= $5::timestamptz)
         GROUP BY c.id, c.first_name, c.last_name, c.email`,
        [enrolledIds, user.tenantId, aeEventType, run.started_at ?? null, run.completed_at ?? null]
      );
      extra = aeRows.rows.filter(r => !alreadyIds.has(r.id));
    }

    res.json([...rows.rows, ...extra]);
  } catch (err) { next(err); }
});

// PATCH /api/sequences/:seqId/runs/:runId/:action
router.patch("/sequences/:seqId/runs/:runId/:action", async (req, res, next): Promise<void> => {
  const seqId  = parseInt(req.params.seqId);
  const runId  = parseInt(req.params.runId);
  const action = req.params.action;
  if (isNaN(seqId) || isNaN(runId) || !["pause", "resume", "cancel"].includes(action)) {
    res.status(400).json({ error: "Invalid" }); return;
  }
  try {
    const user      = req.user as AuthUser;
    const newStatus = action === "pause" ? "paused" : action === "resume" ? "running" : "cancelled";
    const row = (await db.execute(sql`
      UPDATE sequence_runs SET status = ${newStatus}
      WHERE id = ${runId} AND sequence_id = ${seqId} AND tenant_id = ${user.tenantId}
      RETURNING *
    `)).rows[0];
    if (!row) { res.status(404).json({ error: "Not found" }); return; }
    res.json(row);

    // On cancel: mark any still-active enrollments from this run as completed so
    // those contacts are not blocked from being re-enrolled in future runs.
    if (action === "cancel") {
      pool.query(
        `UPDATE sequence_enrollments SET status='completed', completed_at=NOW()
         WHERE run_id=$1 AND status='active'`,
        [runId]
      ).catch(err => logger.warn({ err, runId }, "Failed to clean up active enrollments on run cancel"));
    }

    // On resume: reset status to 'pending' so the exclusive claim in runContactEnrollment
    // can succeed, then prefer BullMQ; fall back to in-process only when Redis is absent.
    if (action === "resume") {
      const r = row as {
        id: number; sequence_id: number; tenant_id: number;
        contact_list_ids: unknown; enrolled: number; skipped: number;
      };
      // Reset to 'pending' so the exclusive claim (pending/scheduled only) can fire
      await pool.query(
        `UPDATE sequence_runs SET status='pending' WHERE id=$1 AND tenant_id=$2`,
        [r.id, r.tenant_id]
      ).catch(() => {});

      const rawIds = r.contact_list_ids;
      let ids: number[] = [];
      if (Array.isArray(rawIds)) {
        ids = (rawIds as unknown[]).map(Number).filter(n => !isNaN(n));
      } else if (typeof rawIds === "string") {
        ids = (rawIds as string).replace(/[{}]/g, "").split(",").filter(Boolean).map(Number);
      }
      const offset    = (r.enrolled ?? 0) + (r.skipped ?? 0);
      const remaining = ids.slice(offset);
      if (remaining.length > 0) {
        const enqResult: EnqueueResult = await enqueueRunStart(
          { runId: r.id, sequenceId: r.sequence_id, tenantId: r.tenant_id }
        ).catch((): EnqueueResult => "error");
        if (enqResult === "unavailable" || enqResult === "error") {
          setImmediate(() => {
            runContactEnrollment(r.id, r.sequence_id, r.tenant_id, remaining)
              .catch(() => {
                pool.query(`UPDATE sequence_runs SET status='error' WHERE id=$1`, [r.id])
                  .catch(() => {});
              });
          });
        }
        // "enqueued" or "duplicate" → BullMQ has it, no in-process fallback needed
      }
    }
  } catch (err) { next(err); }
});

// POST aliases for canonical run controls — matches the documented API contract
// (POST /api/sequences/:seqId/runs/:runId/pause|resume|cancel)
// Delegates to a shared handler to keep logic in one place.
async function handleRunAction(
  seqId: number, runId: number, action: string,
  tenantId: number, res: import("express").Response, next: import("express").NextFunction
): Promise<void> {
  const newStatus = action === "pause" ? "paused" : action === "resume" ? "running" : "cancelled";
  const row = (await db.execute(sql`
    UPDATE sequence_runs SET status = ${newStatus}
    WHERE id = ${runId} AND sequence_id = ${seqId} AND tenant_id = ${tenantId}
    RETURNING *
  `)).rows[0];
  if (!row) { res.status(404).json({ error: "Not found" }); return; }
  res.json(row);

  // On cancel: free contacts so they can be re-enrolled in future runs.
  if (action === "cancel") {
    pool.query(
      `UPDATE sequence_enrollments SET status='completed', completed_at=NOW()
       WHERE run_id=$1 AND status='active'`,
      [runId]
    ).catch(err => logger.warn({ err, runId }, "Failed to clean up active enrollments on run cancel"));
  }

  if (action === "resume") {
    const r = row as { id: number; sequence_id: number; tenant_id: number; contact_list_ids: unknown; enrolled: number; skipped: number };
    await pool.query(`UPDATE sequence_runs SET status='pending' WHERE id=$1 AND tenant_id=$2`, [r.id, r.tenant_id]).catch(() => {});
    const rawIds = r.contact_list_ids;
    let ids: number[] = [];
    if (Array.isArray(rawIds)) ids = (rawIds as unknown[]).map(Number).filter(n => !isNaN(n));
    else if (typeof rawIds === "string") ids = (rawIds as string).replace(/[{}]/g, "").split(",").filter(Boolean).map(Number);
    const offset    = (r.enrolled ?? 0) + (r.skipped ?? 0);
    const remaining = ids.slice(offset);
    if (remaining.length > 0) {
      const enqResult: EnqueueResult = await enqueueRunStart({ runId: r.id, sequenceId: r.sequence_id, tenantId: r.tenant_id }).catch((): EnqueueResult => "error");
      if (enqResult === "unavailable" || enqResult === "error") {
        setImmediate(() => {
          runContactEnrollment(r.id, r.sequence_id, r.tenant_id, remaining).catch(() => {
            pool.query(`UPDATE sequence_runs SET status='error' WHERE id=$1`, [r.id]).catch(() => {});
          });
        });
      }
    }
  }
}

for (const action of ["pause", "resume", "cancel"] as const) {
  router.post(`/sequences/:seqId/runs/:runId/${action}`, async (req, res, next): Promise<void> => {
    const seqId = parseInt(req.params.seqId);
    const runId = parseInt(req.params.runId);
    if (isNaN(seqId) || isNaN(runId)) { res.status(400).json({ error: "Invalid" }); return; }
    try {
      const user = req.user as AuthUser;
      await handleRunAction(seqId, runId, action, user.tenantId, res, next);
    } catch (err) { next(err); }
  });
}

// POST /api/sequences/:seqId/runs/:runId/enrollments/:enrollmentId/retry
// Reset a permanently-errored enrollment back to active so the resume runner picks it up again.
router.post("/sequences/:seqId/runs/:runId/enrollments/:enrollmentId/retry", async (req, res, next): Promise<void> => {
  const seqId        = parseInt(req.params.seqId);
  const runId        = parseInt(req.params.runId);
  const enrollmentId = parseInt(req.params.enrollmentId);
  if (isNaN(seqId) || isNaN(runId) || isNaN(enrollmentId)) {
    res.status(400).json({ error: "Invalid id" }); return;
  }
  try {
    const user = req.user as AuthUser;

    // Verify the run belongs to this tenant and sequence, and is in a state
    // that allows retries. Cancelled runs must not have enrollments reactivated
    // — the admin explicitly stopped the campaign. Completed runs are done and
    // reactivating an enrollment would leave a stale run claiming to be finished
    // while the resume runner quietly processes work for it.
    const runRow = await pool.query<{ id: number; status: string }>(
      `SELECT id, status FROM sequence_runs WHERE id = $1 AND sequence_id = $2 AND tenant_id = $3`,
      [runId, seqId, user.tenantId]
    );
    if (!runRow.rows[0]) { res.status(404).json({ error: "Run not found" }); return; }
    const runStatus = runRow.rows[0].status;
    // Allow retry only when the run can safely execute work:
    //
    //  'running'   — resume runner is active; it picks up the reset enrollment
    //                on the next tick.
    //  'completed' — the run finished because maybeCompleteRun saw no more active
    //                enrollments (the errored one was excluded). Reactivating the
    //                enrollment AND the run together lets the resume runner send
    //                the remaining work. The run is atomically set back to
    //                'running' below after the enrollment is reset.
    //
    //  All other states are rejected:
    //    'paused'    — the resume runner does NOT check the parent run's status;
    //                  a reset enrollment would be processed immediately and send
    //                  emails despite the explicit pause.
    //    'cancelled' — admin explicitly stopped the campaign.
    //    'error'     — the run itself failed; re-sending from it is unsafe.
    //    'pending' / 'scheduled' — enrollment has not started; retry would race
    //                  with the initial enrollment process.
    const RETRY_ALLOWED_STATES = new Set(["running", "completed"]);
    if (!RETRY_ALLOWED_STATES.has(runStatus)) {
      res.status(409).json({ error: `Cannot retry enrollment on a ${runStatus} run` }); return;
    }

    // Reset the enrollment: clear error count, restore active status, set resume_at = NOW()
    // so the resume runner picks it up on the next tick.
    const updated = await pool.query<{ id: number }>(
      `UPDATE sequence_enrollments
       SET status = 'active',
           resume_at = NOW(),
           resume_error_count = 0
       WHERE id = $1
         AND run_id = $2
         AND status = 'errored'
       RETURNING id`,
      [enrollmentId, runId]
    );
    if (!updated.rows[0]) {
      res.status(404).json({ error: "Enrollment not found or not in errored state" }); return;
    }

    // When the run was completed (maybeCompleteRun fired because all other
    // enrollments finished while this one was stuck in errored state), reactivate
    // it so the resume runner can process the now-active enrollment.
    if (runStatus === "completed") {
      await pool.query(
        `UPDATE sequence_runs SET status = 'running' WHERE id = $1 AND status = 'completed'`,
        [runId]
      ).catch(err =>
        logger.warn({ err, runId }, "sequenceRuns: failed to reactivate completed run on enrollment retry")
      );
    }

    res.json({ ok: true, enrollmentId });
  } catch (err) { next(err); }
});

// ── Routes: /api/sequence-runs (legacy, kept for compatibility) ───────────────

// GET /api/sequence-runs
router.get("/sequence-runs", async (req, res, next): Promise<void> => {
  try {
    const user       = req.user as AuthUser;
    const sequenceId = req.query.sequenceId ? Number(req.query.sequenceId) : null;
    const rows = (await db.execute(sql`
      SELECT r.*,
        s.name AS sequence_name,
        j.name AS journey_name,
        cl.name AS client_name,
        u.first_name || ' ' || u.last_name AS started_by_name
      FROM sequence_runs r
      LEFT JOIN email_sequences s ON s.id = r.sequence_id
      LEFT JOIN journeys j ON j.id = r.journey_id
      LEFT JOIN clients cl ON cl.id = r.client_id
      LEFT JOIN users u ON u.id = r.started_by
      WHERE r.tenant_id = ${user.tenantId}
        ${sequenceId ? sql`AND r.sequence_id = ${sequenceId}` : sql``}
      ORDER BY r.created_at DESC
      LIMIT 50
    `)).rows;
    res.json(rows);
  } catch (err) { next(err); }
});

// POST /api/sequence-runs — legacy; uses same async lifecycle
router.post("/sequence-runs", async (req, res, next): Promise<void> => {
  const parsed = CreateRunBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  try {
    const user = req.user as AuthUser;
    const d    = parsed.data;

    if (!await verifyTenantOwnsEntity("email_sequences", d.sequenceId, user.tenantId)) {
      res.status(403).json({ error: "Sequence not found" }); return;
    }
    if (d.journeyId && !await verifyTenantOwnsEntity("journeys", d.journeyId, user.tenantId)) {
      res.status(403).json({ error: "Journey not found" }); return;
    }
    if (d.clientId && !await verifyTenantOwnsEntity("clients", d.clientId, user.tenantId)) {
      res.status(403).json({ error: "Client not found" }); return;
    }
    if (d.segmentId && !await verifyTenantOwnsEntity("segments", d.segmentId, user.tenantId)) {
      res.status(403).json({ error: "Segment not found" }); return;
    }

    let contactIds: number[];
    if (d.manualEmails && d.manualEmails.length > 0) {
      const emails = d.manualEmails.map(e => e.trim().toLowerCase()).filter(e => e.includes("@"));
      const r = await pool.query<{ id: number }>(
        `SELECT id FROM contacts WHERE LOWER(email) = ANY($1::text[]) AND tenant_id = $2`,
        [emails, user.tenantId]
      );
      contactIds = r.rows.map(x => x.id);
    } else if (d.contactIds && d.contactIds.length > 0) {
      const valid = await pool.query<{ id: number }>(
        `SELECT id FROM contacts WHERE id = ANY($1::int[]) AND tenant_id = $2`,
        [d.contactIds, user.tenantId]
      );
      contactIds = valid.rows.map(r => r.id);
    } else {
      contactIds = await resolveContactIds(user.tenantId, {
        journeyId:           d.journeyId,
        clientId:            d.clientId,
        segmentId:           d.segmentId,
        segmentIds:          d.segmentIds,
        sequenceId:          d.sequenceId,
        excludeActive:       d.excludeActive,
        excludeUnsubscribed: d.excludeUnsubscribed,
        minScore:            d.minScore,
      });
    }

    const totalContacts = contactIds.length;
    const isScheduledLegacy = !!d.scheduledAt && new Date(d.scheduledAt) > new Date();
    const runStatusLegacy   = isScheduledLegacy ? "scheduled" : "pending";

    const runRow = (await pool.query(
      `INSERT INTO sequence_runs
         (tenant_id, sequence_id, journey_id, client_id, segment_id,
          contact_list_ids, status, total_contacts, enrolled, skipped, started_by,
          scheduled_at, send_window_start, send_window_end, daily_cap, send_days)
       VALUES ($1,$2,$3,$4,$5,$6::integer[],$7,$8,0,0,$9,$10,$11,$12,$13,$14::integer[])
       RETURNING *`,
      [
        user.tenantId, d.sequenceId,
        d.journeyId ?? null, d.clientId ?? null, d.segmentId ?? null,
        totalContacts > 0 ? contactIds : null,
        runStatusLegacy, totalContacts, user.id,
        d.scheduledAt         ?? null,
        d.sendWindowStart     ?? "09:00",
        d.sendWindowEnd       ?? "18:00",
        d.dailyCap            ?? null,
        d.sendDays            ?? [1, 2, 3, 4, 5],
      ]
    )).rows[0] as { id: number };

    res.status(201).json({ ...runRow, enrolled: 0 });

    const runIdL    = runRow.id;
    const tenantIdL = user.tenantId;
    const seqIdL    = d.sequenceId;

    if (isScheduledLegacy) {
      const delayMs = Math.max(0, new Date(d.scheduledAt!).getTime() - Date.now());
      await enqueueRunStart({ runId: runIdL, sequenceId: seqIdL, tenantId: tenantIdL }, delayMs);
    } else {
      const cidsCap     = contactIds.slice();
      const enqResultL: EnqueueResult = await enqueueRunStart({ runId: runIdL, sequenceId: seqIdL, tenantId: tenantIdL });
      if (enqResultL === "unavailable" || enqResultL === "error") {
        setImmediate(() => {
          runContactEnrollment(runIdL, seqIdL, tenantIdL, cidsCap)
            .catch(() => {
              pool.query(`UPDATE sequence_runs SET status='error' WHERE id=$1`, [runIdL]).catch(() => {});
            });
        });
      }
      // "enqueued" or "duplicate" → BullMQ has it, no in-process fallback
    }
  } catch (err) { next(err); }
});

// GET /api/sequence-runs/:id — detail (legacy)
router.get("/sequence-runs/:id", async (req, res, next): Promise<void> => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  try {
    const user = req.user as AuthUser;
    const run = (await pool.query(
      `SELECT r.*,
         s.name AS sequence_name, s.nodes_json AS nodes,
         j.name AS journey_name,
         cl.name AS client_name,
         u.first_name || ' ' || u.last_name AS started_by_name
       FROM sequence_runs r
       LEFT JOIN email_sequences s ON s.id = r.sequence_id
       LEFT JOIN journeys j ON j.id = r.journey_id
       LEFT JOIN clients cl ON cl.id = r.client_id
       LEFT JOIN users u ON u.id = r.started_by
       WHERE r.id = $1 AND r.tenant_id = $2`,
      [id, user.tenantId]
    )).rows[0] as Record<string, unknown> | undefined;

    if (!run) { res.status(404).json({ error: "Not found" }); return; }

    const rawRunIds2 = run.contact_list_ids;
    const runContactIds2 = parseContactListIds(rawRunIds2);

    type ContactRow = {
      id: number; first_name: string; last_name: string; email: string; lead_score: number;
      enrollment_status: string; enrolled_at: string | null;
    };
    const legacySeqId = run.sequence_id as number;
    let enrolledContacts: ContactRow[] = [];
    if (runContactIds2.length > 0) {
      const r2 = await pool.query<ContactRow>(
        `SELECT c.id, c.first_name, c.last_name, c.email, COALESCE(c.lead_score, 0) AS lead_score,
                COALESCE(se.status, 'skipped') AS enrollment_status,
                se.enrolled_at::text AS enrolled_at,
                co.name AS company_name
         FROM contacts c
         LEFT JOIN sequence_enrollments se
           ON se.contact_id = c.id AND se.run_id = $1
         LEFT JOIN companies co ON co.id = c.company_id AND co.tenant_id = c.tenant_id
         WHERE c.id = ANY($2::int[]) AND c.tenant_id = $3
         ORDER BY c.lead_score DESC NULLS LAST`,
        [id, runContactIds2.slice(0, 1000), user.tenantId]
      );
      enrolledContacts = r2.rows;
    }
    const enrolledIds = enrolledContacts.filter(c => c.enrollment_status !== 'skipped').map(c => c.id);

    let nodesJson: NodesJson | null = null;
    if (run.nodes) {
      nodesJson = typeof run.nodes === "string"
        ? (JSON.parse(run.nodes) as NodesJson)
        : (run.nodes as NodesJson);
    }

    const stepStats = await getStepStats(
      nodesJson, legacySeqId, enrolledIds, user.tenantId,
      (run.started_at as string | null) ?? null,
      (run.completed_at as string | null) ?? null
    );

    res.json({ ...run, enrolledContacts, totalContacts: runContactIds2.length, stepStats });
  } catch (err) { next(err); }
});

// PATCH /api/sequence-runs/:id/:action (legacy)
router.patch("/sequence-runs/:id/:action", async (req, res, next): Promise<void> => {
  const id     = parseInt(req.params.id);
  const action = req.params.action;
  if (isNaN(id) || !["pause", "resume", "cancel"].includes(action)) {
    res.status(400).json({ error: "Invalid" }); return;
  }
  try {
    const user      = req.user as AuthUser;
    const newStatus = action === "pause" ? "paused" : action === "resume" ? "running" : "cancelled";
    const row = (await db.execute(sql`
      UPDATE sequence_runs SET status = ${newStatus}
      WHERE id = ${id} AND tenant_id = ${user.tenantId}
      RETURNING *
    `)).rows[0];
    if (!row) { res.status(404).json({ error: "Not found" }); return; }
    res.json(row);

    // On resume: reset to 'pending' so exclusive claim can succeed, then re-enqueue
    if (action === "resume") {
      const r = row as {
        id: number; sequence_id: number; tenant_id: number;
        contact_list_ids: unknown; enrolled: number; skipped: number;
      };
      await pool.query(
        `UPDATE sequence_runs SET status='pending' WHERE id=$1 AND tenant_id=$2`,
        [r.id, r.tenant_id]
      ).catch(() => {});

      const ids       = parseContactListIds(r.contact_list_ids);
      const offset    = (r.enrolled ?? 0) + (r.skipped ?? 0);
      const remaining = ids.slice(offset);
      if (remaining.length > 0) {
        const enqResult: EnqueueResult = await enqueueRunStart({
          runId: r.id, sequenceId: r.sequence_id, tenantId: r.tenant_id,
        }).catch((): EnqueueResult => "error");
        if (enqResult === "unavailable" || enqResult === "error") {
          setImmediate(() => {
            runContactEnrollment(r.id, r.sequence_id, r.tenant_id, remaining)
              .catch(() => {
                pool.query(`UPDATE sequence_runs SET status='error' WHERE id=$1`, [r.id]).catch(() => {});
              });
          });
        }
        // "enqueued" or "duplicate" → BullMQ has it, no in-process fallback needed
      }
    }
  } catch (err) { next(err); }
});

/**
 * Resume runs interrupted by a server restart, and promote any scheduled runs
 * whose `scheduled_at` has elapsed. Called on startup and every 60 s via setInterval.
 * Prefers BullMQ for durable re-enqueue; falls back to in-process setImmediate when
 * Redis is unavailable (e.g. dev environments without Upstash).
 */
export async function resumeInterruptedRuns(): Promise<void> {
  try {
    // Step 1: Reset stale 'running' runs back to 'pending' so the exclusive claim
    // in runContactEnrollment can pick them up again.  A run is considered stale
    // if it has been in 'running' state for more than 5 minutes without completing
    // (strongly indicative of a server crash mid-run rather than active processing).
    await pool.query(
      `UPDATE sequence_runs SET status='pending'
       WHERE status = 'running'
         AND started_at < NOW() - INTERVAL '5 minutes'`
    ).catch(() => {});

    // Step 1b: Expire runs whose background audience resolution never completed
    // (server crashed between create and resolve). After 15 minutes they become errors.
    await pool.query(
      `UPDATE sequence_runs SET status='error'
       WHERE status = 'pending' AND total_contacts = -1
         AND created_at < NOW() - INTERVAL '15 minutes'`
    ).catch(() => {});

    // Step 2: Pick up pending/scheduled runs (including those just reset above).
    // Skip runs still in background resolution (total_contacts = -1, sentinel value).
    const { rows } = await pool.query<{
      id: number; sequence_id: number; tenant_id: number;
      contact_list_ids: unknown; enrolled: number; skipped: number;
    }>(
      `SELECT id, sequence_id, tenant_id, contact_list_ids, enrolled, skipped
       FROM sequence_runs
       WHERE (status = 'pending' AND total_contacts <> -1)
          OR (status = 'scheduled' AND scheduled_at IS NOT NULL AND scheduled_at <= NOW())
       ORDER BY created_at
       LIMIT 20`
    );
    for (const run of rows) {
      const ids       = parseContactListIds(run.contact_list_ids);
      const offset    = (run.enrolled ?? 0) + (run.skipped ?? 0);
      const remaining = ids.slice(offset);

      if (remaining.length === 0) {
        // All contacts processed but run never transitioned to completed
        // (e.g. server crashed at final update, or run had no targetable contacts).
        await pool.query(
          `UPDATE sequence_runs SET status='completed', completed_at=COALESCE(completed_at, NOW())
           WHERE id=$1 AND status IN ('pending','scheduled')`,
          [run.id]
        ).catch(() => {});
        continue;
      }

      const enqResult: EnqueueResult = await enqueueRunStart({
        runId: run.id, sequenceId: run.sequence_id, tenantId: run.tenant_id,
      }).catch((): EnqueueResult => "error");
      if (enqResult === "unavailable" || enqResult === "error") {
        // Redis unavailable — fall back to in-process
        setImmediate(() => {
          runContactEnrollment(run.id, run.sequence_id, run.tenant_id, remaining)
            .catch(() => {
              pool.query(`UPDATE sequence_runs SET status='error' WHERE id=$1`, [run.id])
                .catch(() => {});
            });
        });
      }
      // "enqueued" or "duplicate" → BullMQ will handle it, no in-process fallback
    }
  } catch {
    // Non-fatal — do not block server start or periodic check
  }
}

export default router;
