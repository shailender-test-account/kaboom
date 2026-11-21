import { Router, type IRouter } from "express";
import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { db } from "@workspace/db";
import { requireAuth } from "../middlewares/requireAuth";
import { buildContactsWhereClause, type LogicOperator, type FilterCriterion } from "../utils/segmentFilter";
import { pool } from "@workspace/db";
import { hpClientNameSql } from "../lib/hpClientScope";
import { hpContactMayNurture, WARM_ONLY_ROUTING_MESSAGE } from "../lib/hpNurturePolicy";

interface SegmentRow {
  id: number;
  tenant_id: number;
  name: string;
  segment_type: "static" | "dynamic";
  filter_criteria: FilterCriterion[] | null;
  static_contact_ids: number[] | null;
  logic_operator: "AND" | "OR";
}

const router: IRouter = Router();
router.use(requireAuth);

// ── Ownership helper ──────────────────────────────────────────────────────────
async function requireJourneyOwner(journeyId: number, tenantId: number): Promise<boolean> {
  const res = await db.execute(sql`SELECT 1 FROM journeys WHERE id = ${journeyId} AND tenant_id = ${tenantId} LIMIT 1`);
  return res.rows.length > 0;
}

async function hpJourneyClient(journeyId: number, tenantId: number) {
  const result = await pool.query(`SELECT j.client_id FROM journeys j JOIN clients cl
    ON cl.id=j.client_id AND cl.tenant_id=j.tenant_id
    WHERE j.id=$1 AND j.tenant_id=$2 AND ${hpClientNameSql("cl.name")}`, [journeyId,tenantId]);
  return result.rows[0]?.client_id as number | undefined;
}

// ── Journey Contacts ──────────────────────────────────────────────────────────

// GET /api/journeys/:id/contacts — merged from all sources (segments, companies, manual)
// Single unified query with proper pagination: deduplicates contacts preferring direct assignments
router.get("/journeys/:id/contacts", async (req, res, next): Promise<void> => {
  const journeyId = parseInt(req.params.id);
  if (isNaN(journeyId)) { res.status(400).json({ error: "Invalid id" }); return; }
  try {
    const user = req.user as any;
    if (!await requireJourneyOwner(journeyId, user.tenantId)) { res.status(403).json({ error: "Forbidden" }); return; }
    const page = Math.max(1, parseInt(String(req.query.page || "1")));
    const limit = 50;
    const offset = (page - 1) * limit;

    // Single CTE-based query: deduplicates, prefers journey_contacts over company-derived rows
    const rows = (await db.execute(sql`
      WITH merged AS (
        SELECT DISTINCT ON (c.id)
          c.id, c.first_name, c.last_name, c.email, c.title, c.lead_score, c.stage, c.tags,
          co.name AS company_name,
          CASE WHEN jc.contact_id IS NOT NULL THEN jc.added_via ELSE 'company' END AS added_via,
          jc.segment_id,
          s.name AS segment_name,
          COALESCE(jc.added_at, jco.added_at) AS added_at
        FROM contacts c
        LEFT JOIN companies co ON co.id = c.company_id
        LEFT JOIN journey_contacts jc ON jc.contact_id = c.id AND jc.journey_id = ${journeyId}
        LEFT JOIN journey_companies jco ON jco.company_id = c.company_id AND jco.journey_id = ${journeyId}
        LEFT JOIN segments s ON s.id = jc.segment_id
        WHERE c.tenant_id = ${user.tenantId}
          AND (jc.contact_id IS NOT NULL OR jco.company_id IS NOT NULL)
        ORDER BY c.id, jc.contact_id NULLS LAST
      )
      SELECT
        m.*,
        (SELECT se.status FROM sequence_enrollments se WHERE se.contact_id = m.id ORDER BY se.enrolled_at DESC LIMIT 1) AS sequence_status,
        (SELECT COUNT(*)::int FROM activity_events ae WHERE ae.contact_id = m.id) AS activity_count
      FROM merged m
      ORDER BY m.lead_score DESC, m.id
      LIMIT ${limit} OFFSET ${offset}
    `)).rows;

    const countRes = (await db.execute(sql`
      SELECT COUNT(DISTINCT c.id)::int AS total
      FROM contacts c
      LEFT JOIN journey_contacts jc ON jc.contact_id = c.id AND jc.journey_id = ${journeyId}
      LEFT JOIN journey_companies jco ON jco.company_id = c.company_id AND jco.journey_id = ${journeyId}
      WHERE c.tenant_id = ${user.tenantId}
        AND (jc.contact_id IS NOT NULL OR jco.company_id IS NOT NULL)
    `)).rows[0] as { total: number };

    // Stats
    const stats = (await db.execute(sql`
      SELECT
        (SELECT COUNT(*)::int FROM journey_contacts WHERE journey_id = ${journeyId} AND added_via = 'manual') AS manual_count,
        (SELECT COUNT(DISTINCT c.id)::int FROM journey_companies jco
         JOIN contacts c ON c.company_id = jco.company_id
         WHERE jco.journey_id = ${journeyId} AND c.tenant_id = ${user.tenantId}) AS company_count,
        (SELECT COUNT(*)::int FROM journey_contacts WHERE journey_id = ${journeyId} AND added_via = 'segment') AS segment_contact_count,
        (SELECT COUNT(*)::int FROM journey_segments WHERE journey_id = ${journeyId}) AS attached_segment_count,
        (SELECT COUNT(DISTINCT se.contact_id)::int FROM sequence_enrollments se
         WHERE se.status = 'active'
           AND se.contact_id IN (
             SELECT contact_id FROM journey_contacts WHERE journey_id = ${journeyId}
             UNION
             SELECT c2.id FROM contacts c2
             JOIN journey_companies jco2 ON jco2.company_id = c2.company_id
             WHERE jco2.journey_id = ${journeyId} AND c2.tenant_id = ${user.tenantId}
           )) AS active_sequence_count,
        (SELECT COUNT(DISTINCT se.contact_id)::int FROM sequence_enrollments se
         WHERE se.status = 'completed'
           AND se.contact_id IN (
             SELECT contact_id FROM journey_contacts WHERE journey_id = ${journeyId}
             UNION
             SELECT c2.id FROM contacts c2
             JOIN journey_companies jco2 ON jco2.company_id = c2.company_id
             WHERE jco2.journey_id = ${journeyId} AND c2.tenant_id = ${user.tenantId}
           )) AS completed_sequence_count
    `)).rows[0] as { manual_count: number; company_count: number; segment_contact_count: number; attached_segment_count: number; active_sequence_count: number; completed_sequence_count: number };

    res.json({ rows, total: countRes.total, page, limit, stats });
  } catch (err) { next(err); }
});

// POST /api/journeys/:id/contacts — add individual contacts manually
router.post("/journeys/:id/contacts", async (req, res, next): Promise<void> => {
  const journeyId = parseInt(req.params.id);
  if (isNaN(journeyId)) { res.status(400).json({ error: "Invalid id" }); return; }
  const parsed = z.object({ contactIds: z.array(z.number().int().positive()).min(1) }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  try {
    const user = req.user as any;
    if (!await requireJourneyOwner(journeyId, user.tenantId)) { res.status(403).json({ error: "Forbidden" }); return; }

    // Verify every submitted contactId belongs to this tenant before inserting.
    // Also fetch dnc flag so we can skip DNC contacts.
    const ids = parsed.data.contactIds;
    const ownedRows = (await db.execute(sql`
      SELECT id, dnc FROM contacts WHERE id IN (${sql.join(ids.map(id => sql`${id}`), sql`, `)}) AND tenant_id = ${user.tenantId}
    `)).rows as { id: number; dnc: boolean }[];
    const ownedSet = new Set(ownedRows.map(r => r.id));
    const foreign = ids.filter((id) => !ownedSet.has(id));
    if (foreign.length > 0) { res.status(403).json({ error: "One or more contactIds not found in this tenant" }); return; }

    const allowedIds = ownedRows.filter(r => !r.dnc).map(r => r.id);
    const dncSkipped = ownedRows.filter(r => r.dnc).length;
    const hpClient = await hpJourneyClient(journeyId,user.tenantId);
    if(hpClient) for(const cid of allowedIds) {
      if(!await hpContactMayNurture(user.tenantId,hpClient,cid)) {
        res.status(409).json({error:WARM_ONLY_ROUTING_MESSAGE});
        return;
      }
    }

    let added = 0;
    for (const cid of allowedIds) {
      const r = await db.execute(sql`
        INSERT INTO journey_contacts (journey_id, contact_id, added_via)
        VALUES (${journeyId}, ${cid}, 'manual')
        ON CONFLICT (journey_id, contact_id) DO NOTHING
      `);
      if ((r as { rowCount?: number | null }).rowCount ?? 0) added++;
    }
    res.json({ added, dncSkipped });
  } catch (err) { next(err); }
});

// DELETE /api/journeys/:id/contacts/:contactId
router.delete("/journeys/:id/contacts/:contactId", async (req, res, next): Promise<void> => {
  const journeyId = parseInt(req.params.id);
  const contactId = parseInt(req.params.contactId);
  if (isNaN(journeyId) || isNaN(contactId)) { res.status(400).json({ error: "Invalid id" }); return; }
  try {
    const user = req.user as any;
    if (!await requireJourneyOwner(journeyId, user.tenantId)) { res.status(403).json({ error: "Forbidden" }); return; }
    await db.execute(sql`DELETE FROM journey_contacts WHERE journey_id = ${journeyId} AND contact_id = ${contactId}`);
    res.sendStatus(204);
  } catch (err) { next(err); }
});

// ── Journey Companies ─────────────────────────────────────────────────────────

router.get("/journeys/:id/companies", async (req, res, next): Promise<void> => {
  const journeyId = parseInt(req.params.id);
  if (isNaN(journeyId)) { res.status(400).json({ error: "Invalid id" }); return; }
  try {
    const user = req.user as any;
    if (!await requireJourneyOwner(journeyId, user.tenantId)) { res.status(403).json({ error: "Forbidden" }); return; }
    const rows = (await db.execute(sql`
      SELECT jco.id, jco.added_at, co.id AS company_id, co.name, co.industry,
             COUNT(c.id)::int AS contact_count
      FROM journey_companies jco
      JOIN companies co ON co.id = jco.company_id
      LEFT JOIN contacts c ON c.company_id = co.id
      WHERE jco.journey_id = ${journeyId}
      GROUP BY jco.id, jco.added_at, co.id, co.name, co.industry
      ORDER BY jco.added_at DESC
    `)).rows;
    res.json(rows);
  } catch (err) { next(err); }
});

router.post("/journeys/:id/companies", async (req, res, next): Promise<void> => {
  const journeyId = parseInt(req.params.id);
  if (isNaN(journeyId)) { res.status(400).json({ error: "Invalid id" }); return; }
  const parsed = z.object({ companyIds: z.array(z.number().int().positive()).min(1) }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  try {
    const user = req.user as any;
    if (!await requireJourneyOwner(journeyId, user.tenantId)) { res.status(403).json({ error: "Forbidden" }); return; }
    if(await hpJourneyClient(journeyId,user.tenantId)){
      res.status(409).json({error:"HP journeys accept individual Warm contacts only. Select eligible contacts instead of attaching an entire account."});return;
    }

    // Verify every submitted companyId belongs to this tenant before inserting
    const ids = parsed.data.companyIds;
    const owned = (await db.execute(sql`
      SELECT id FROM companies WHERE id IN (${sql.join(ids.map(id => sql`${id}`), sql`, `)}) AND tenant_id = ${user.tenantId}
    `)).rows.map((r) => (r as { id: number }).id);
    const ownedSet = new Set(owned);
    const foreign = ids.filter((id) => !ownedSet.has(id));
    if (foreign.length > 0) { res.status(403).json({ error: "One or more companyIds not found in this tenant" }); return; }

    let added = 0;
    for (const cid of owned) {
      const r = await db.execute(sql`
        INSERT INTO journey_companies (journey_id, company_id)
        VALUES (${journeyId}, ${cid})
        ON CONFLICT (journey_id, company_id) DO NOTHING
      `);
      if ((r as { rowCount?: number | null }).rowCount ?? 0) added++;
    }
    res.json({ added });
  } catch (err) { next(err); }
});

router.delete("/journeys/:id/companies/:companyId", async (req, res, next): Promise<void> => {
  const journeyId = parseInt(req.params.id);
  const companyId = parseInt(req.params.companyId);
  if (isNaN(journeyId) || isNaN(companyId)) { res.status(400).json({ error: "Invalid id" }); return; }
  try {
    const user = req.user as any;
    if (!await requireJourneyOwner(journeyId, user.tenantId)) { res.status(403).json({ error: "Forbidden" }); return; }
    await db.execute(sql`DELETE FROM journey_companies WHERE journey_id = ${journeyId} AND company_id = ${companyId}`);
    res.sendStatus(204);
  } catch (err) { next(err); }
});

// ── Journey Segments ──────────────────────────────────────────────────────────

router.get("/journeys/:id/segments", async (req, res, next): Promise<void> => {
  const journeyId = parseInt(req.params.id);
  if (isNaN(journeyId)) { res.status(400).json({ error: "Invalid id" }); return; }
  try {
    const user = req.user as any;
    if (!await requireJourneyOwner(journeyId, user.tenantId)) { res.status(403).json({ error: "Forbidden" }); return; }
    const rows = (await db.execute(sql`
      SELECT js.*, s.name AS segment_name, s.segment_type, s.filter_criteria, s.last_computed_count
      FROM journey_segments js
      JOIN segments s ON s.id = js.segment_id
      WHERE js.journey_id = ${journeyId}
      ORDER BY js.added_at DESC
    `)).rows;
    res.json(rows);
  } catch (err) { next(err); }
});

router.post("/journeys/:id/segments", async (req, res, next): Promise<void> => {
  const journeyId = parseInt(req.params.id);
  if (isNaN(journeyId)) { res.status(400).json({ error: "Invalid id" }); return; }
  const parsed = z.object({
    segmentId: z.number().int().positive(),
    snapshotMode: z.boolean().default(false),
    duplicateHandling: z.enum(["skip", "update"]).default("skip"),
  }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  try {
    const user = req.user as any;
    if (!await requireJourneyOwner(journeyId, user.tenantId)) { res.status(403).json({ error: "Forbidden" }); return; }
    if(await hpJourneyClient(journeyId,user.tenantId)){
      res.status(409).json({error:"HP journeys accept individual Warm contacts only. Route eligible contacts through the saved Warm rules instead of attaching a whole segment."});return;
    }
    const { segmentId, snapshotMode, duplicateHandling } = parsed.data;

    // Fetch segment — verifies segment belongs to this tenant
    const seg = (await db.execute(sql`
      SELECT * FROM segments WHERE id = ${segmentId} AND tenant_id = ${user.tenantId}
    `)).rows[0] as unknown as SegmentRow | undefined;
    if (!seg) { res.status(404).json({ error: "Segment not found" }); return; }

    // Empty static segment: no contacts to assign — return immediately, do not fall back to full-tenant scan
    if (seg.segment_type === "static" && !seg.static_contact_ids?.length) {
      await db.execute(sql`
        INSERT INTO journey_segments (journey_id, segment_id, snapshot_mode, snapshot_contact_ids)
        VALUES (${journeyId}, ${segmentId}, ${snapshotMode}, NULL)
        ON CONFLICT (journey_id, segment_id) DO UPDATE SET
          snapshot_mode = EXCLUDED.snapshot_mode,
          snapshot_contact_ids = EXCLUDED.snapshot_contact_ids,
          last_synced_at = NOW()
      `);
      res.status(201).json({ ok: true, added: 0, alreadyInJourney: 0, total: 0, duplicateHandling });
      return;
    }

    // Build WHERE clause from actual segment criteria — fully parameterized
    const typedSeg = seg as SegmentRow;
    const logicOp: LogicOperator = typedSeg.logic_operator === "OR" ? "OR" : "AND";
    let whereExpr: SQL;
    if (typedSeg.segment_type === "static") {
      const safeIds = (typedSeg.static_contact_ids ?? []).map(id => parseInt(String(id), 10)).filter(n => !isNaN(n));
      whereExpr = safeIds.length > 0 ? sql`c.tenant_id = ${user.tenantId} AND c.id IN (${sql.join(safeIds.map(id => sql`${id}`), sql`, `)})` : sql`FALSE`;
    } else if (typedSeg.filter_criteria?.length) {
      whereExpr = await buildContactsWhereClause(user.tenantId, typedSeg.filter_criteria, logicOp);
    } else {
      whereExpr = sql`c.tenant_id = ${user.tenantId}`;
    }

    // Evaluate matching contacts — no LIMIT, process all (excluding DNC)
    const allMatchingContacts = (await db.execute(sql`
      SELECT c.id, c.dnc FROM contacts c
      LEFT JOIN companies co ON co.id = c.company_id
      WHERE ${whereExpr}
    `)).rows as { id: unknown; dnc: unknown }[];

    const matchingContacts = allMatchingContacts
      .filter(r => !r.dnc)
      .map(r => parseInt(String(r.id), 10))
      .filter(n => !isNaN(n));
    const dncSkipped = allMatchingContacts.filter(r => r.dnc).length;

    // For snapshot mode, freeze the matching ids; for dynamic, null (re-evaluated on sync)
    const snapshotContactIds = snapshotMode ? matchingContacts : null;

    await db.execute(sql`
      INSERT INTO journey_segments (journey_id, segment_id, snapshot_mode, snapshot_contact_ids)
      VALUES (${journeyId}, ${segmentId}, ${snapshotMode}, ${snapshotContactIds ? `{${snapshotContactIds.join(",")}}` : null})
      ON CONFLICT (journey_id, segment_id) DO UPDATE SET
        snapshot_mode = EXCLUDED.snapshot_mode,
        snapshot_contact_ids = EXCLUDED.snapshot_contact_ids,
        last_synced_at = NOW()
    `);

    // Batch INSERT all matching contacts — no per-row loop
    let added = 0;
    let alreadyInJourney = 0;
    if (matchingContacts.length > 0) {
      const arrayStr = `{${matchingContacts.join(",")}}`;
      if (duplicateHandling === "update") {
        const r = await db.execute(sql`
          INSERT INTO journey_contacts (journey_id, contact_id, added_via, segment_id)
          SELECT ${journeyId}, unnest(${arrayStr}::int[]), 'segment', ${segmentId}
          ON CONFLICT (journey_id, contact_id) DO UPDATE SET
            added_via = 'segment', segment_id = ${segmentId}
        `);
        // rowCount includes both new inserts and updates; approximate alreadyInJourney
        added = (r as { rowCount?: number | null }).rowCount ?? matchingContacts.length;
        alreadyInJourney = matchingContacts.length - added;
      } else {
        const r = await db.execute(sql`
          INSERT INTO journey_contacts (journey_id, contact_id, added_via, segment_id)
          SELECT ${journeyId}, unnest(${arrayStr}::int[]), 'segment', ${segmentId}
          ON CONFLICT (journey_id, contact_id) DO NOTHING
        `);
        added = (r as { rowCount?: number | null }).rowCount ?? 0;
        alreadyInJourney = matchingContacts.length - added;
      }
    }

    res.status(201).json({ ok: true, added, alreadyInJourney, dncSkipped, total: matchingContacts.length + dncSkipped, duplicateHandling });
  } catch (err) { next(err); }
});

router.delete("/journeys/:id/segments/:segmentId", async (req, res, next): Promise<void> => {
  const journeyId = parseInt(req.params.id);
  const segmentId = parseInt(req.params.segmentId);
  if (isNaN(journeyId) || isNaN(segmentId)) { res.status(400).json({ error: "Invalid id" }); return; }
  try {
    const user = req.user as any;
    if (!await requireJourneyOwner(journeyId, user.tenantId)) { res.status(403).json({ error: "Forbidden" }); return; }
    await db.execute(sql`DELETE FROM journey_segments WHERE journey_id = ${journeyId} AND segment_id = ${segmentId}`);
    res.sendStatus(204);
  } catch (err) { next(err); }
});

// POST /api/journeys/:id/segments/:segmentId/sync
router.post("/journeys/:id/segments/:segmentId/sync", async (req, res, next): Promise<void> => {
  const journeyId = parseInt(req.params.id);
  const segmentId = parseInt(req.params.segmentId);
  if (isNaN(journeyId) || isNaN(segmentId)) { res.status(400).json({ error: "Invalid id" }); return; }
  try {
    const user = req.user as any;
    if (!await requireJourneyOwner(journeyId, user.tenantId)) { res.status(403).json({ error: "Forbidden" }); return; }
    if(await hpJourneyClient(journeyId,user.tenantId)){
      res.status(409).json({error:"Whole-segment sync is disabled for HP journeys. Only individually qualified Warm contacts may be routed."});return;
    }
    const { removeNonMatching = false } = req.body;

    // Get segment — verifies segment belongs to this tenant
    const seg = (await db.execute(sql`SELECT * FROM segments WHERE id = ${segmentId} AND tenant_id = ${user.tenantId}`)).rows[0] as unknown as SegmentRow | undefined;
    if (!seg) { res.status(404).json({ error: "Segment not found" }); return; }

    // Empty static segment: no contacts to sync — return immediately
    if (seg.segment_type === "static" && !seg.static_contact_ids?.length) {
      await db.execute(sql`UPDATE journey_segments SET last_synced_at = NOW() WHERE journey_id = ${journeyId} AND segment_id = ${segmentId}`);
      res.json({ added: 0, removed: 0, total: 0 });
      return;
    }

    // Build WHERE clause — fully parameterized
    const typedSegSync = seg as SegmentRow;
    const logicOp: LogicOperator = typedSegSync.logic_operator === "OR" ? "OR" : "AND";
    let whereExpr: SQL;
    if (typedSegSync.segment_type === "static") {
      const safeIds = (typedSegSync.static_contact_ids ?? []).map(id => parseInt(String(id), 10)).filter(n => !isNaN(n));
      whereExpr = safeIds.length > 0 ? sql`c.tenant_id = ${user.tenantId} AND c.id IN (${sql.join(safeIds.map(id => sql`${id}`), sql`, `)})` : sql`FALSE`;
    } else if (typedSegSync.filter_criteria?.length) {
      whereExpr = await buildContactsWhereClause(user.tenantId, typedSegSync.filter_criteria, logicOp);
    } else {
      whereExpr = sql`c.tenant_id = ${user.tenantId}`;
    }

    // Get matching contacts — no LIMIT, process all (excluding DNC)
    const allSyncContacts = (await db.execute(sql`
      SELECT c.id, c.dnc FROM contacts c
      LEFT JOIN companies co ON co.id = c.company_id
      WHERE ${whereExpr}
    `)).rows as { id: unknown; dnc: unknown }[];

    const matchingContacts = allSyncContacts
      .filter(r => !r.dnc)
      .map(r => parseInt(String(r.id), 10))
      .filter(n => !isNaN(n));
    const dncSkipped = allSyncContacts.filter(r => r.dnc).length;

    // Batch INSERT all matching contacts
    let added = 0;
    if (matchingContacts.length > 0) {
      const arrayStr = `{${matchingContacts.join(",")}}`;
      const r = await db.execute(sql`
        INSERT INTO journey_contacts (journey_id, contact_id, added_via, segment_id)
        SELECT ${journeyId}, unnest(${arrayStr}::int[]), 'segment', ${segmentId}
        ON CONFLICT (journey_id, contact_id) DO NOTHING
      `);
      added = (r as { rowCount?: number | null }).rowCount ?? 0;
    }

    let removed = 0;
    if (removeNonMatching) {
      const matchingSet = new Set(matchingContacts);
      const existing = (await db.execute(sql`
        SELECT contact_id FROM journey_contacts WHERE journey_id = ${journeyId} AND segment_id = ${segmentId}
      `)).rows.map((r: any) => parseInt(String(r.contact_id), 10));
      // Batch delete non-matching contacts
      const toRemove = existing.filter(cid => !matchingSet.has(cid));
      if (toRemove.length > 0) {
        const delResult = await db.execute(sql`
          DELETE FROM journey_contacts
          WHERE journey_id = ${journeyId}
            AND segment_id = ${segmentId}
            AND contact_id IN (${sql.join(toRemove.map(id => sql`${id}`), sql`, `)})
        `);
        removed = (delResult as { rowCount?: number | null }).rowCount ?? 0;
      }
    }

    // Update last_synced_at
    await db.execute(sql`UPDATE journey_segments SET last_synced_at = NOW() WHERE journey_id = ${journeyId} AND segment_id = ${segmentId}`);

    res.json({ added, removed, dncSkipped, total: matchingContacts.length + dncSkipped });
  } catch (err) { next(err); }
});

// ── Journey Routing Rules ─────────────────────────────────────────────────────

const RoutingRuleBody = z.object({
  name: z.string().min(1),
  conditionType: z.enum(["score_above","score_below","score_range","tag_added","tag_removed"]),
  conditionValue: z.record(z.any()),
  applyTo: z.enum(["all","client","segment"]).default("all"),
  applyClientId: z.number().optional(),
  applySegmentId: z.number().optional(),
  ifAlreadyInJourney: z.enum(["skip","move","re_enroll"]).default("skip"),
  enrollSequenceId: z.number().optional(),
  isActive: z.boolean().default(true),
});

// GET /api/journeys/:id/routing-rules
router.get("/journeys/:id/routing-rules", async (req, res, next): Promise<void> => {
  const journeyId = parseInt(req.params.id);
  if (isNaN(journeyId)) { res.status(400).json({ error: "Invalid id" }); return; }
  try {
    const user = req.user as any;
    if (!await requireJourneyOwner(journeyId, user.tenantId)) { res.status(403).json({ error: "Forbidden" }); return; }
    const rows = (await db.execute(sql`
      SELECT r.*,
        s.name AS sequence_name,
        cl.name AS client_name,
        seg.name AS segment_filter_name
      FROM journey_routing_rules r
      LEFT JOIN email_sequences s ON s.id = r.enroll_sequence_id
      LEFT JOIN clients cl ON cl.id = r.apply_client_id
      LEFT JOIN segments seg ON seg.id = r.apply_segment_id
      WHERE r.journey_id = ${journeyId} AND r.tenant_id = ${user.tenantId}
      ORDER BY r.id ASC
    `)).rows;
    res.json(rows);
  } catch (err) { next(err); }
});

// POST /api/journeys/:id/routing-rules
router.post("/journeys/:id/routing-rules", async (req, res, next): Promise<void> => {
  const journeyId = parseInt(req.params.id);
  if (isNaN(journeyId)) { res.status(400).json({ error: "Invalid id" }); return; }
  const parsed = RoutingRuleBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  try {
    const user = req.user as any;
    if (!await requireJourneyOwner(journeyId, user.tenantId)) { res.status(403).json({ error: "Forbidden" }); return; }
    const d = parsed.data;
    const row = (await db.execute(sql`
      INSERT INTO journey_routing_rules
        (tenant_id, name, condition_type, condition_value, journey_id,
         enroll_sequence_id, apply_to, apply_client_id, apply_segment_id,
         if_already_in_journey, is_active)
      VALUES (${user.tenantId}, ${d.name}, ${d.conditionType},
              ${JSON.stringify(d.conditionValue)}::jsonb, ${journeyId},
              ${d.enrollSequenceId ?? null}, ${d.applyTo},
              ${d.applyClientId ?? null}, ${d.applySegmentId ?? null},
              ${d.ifAlreadyInJourney}, ${d.isActive})
      RETURNING *
    `)).rows[0];
    res.status(201).json(row);
  } catch (err) { next(err); }
});

// PATCH /api/journey-routing-rules/:id
router.patch("/journey-routing-rules/:id", async (req, res, next): Promise<void> => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const parsed = RoutingRuleBody.partial().safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  try {
    const user = req.user as any;
    const d = parsed.data;
    const row = (await db.execute(sql`
      UPDATE journey_routing_rules SET
        name                 = COALESCE(${d.name ?? null}, name),
        condition_type       = COALESCE(${d.conditionType ?? null}, condition_type),
        condition_value      = COALESCE(${d.conditionValue ? JSON.stringify(d.conditionValue) + '::jsonb' : null}, condition_value),
        apply_to             = COALESCE(${d.applyTo ?? null}, apply_to),
        if_already_in_journey = COALESCE(${d.ifAlreadyInJourney ?? null}, if_already_in_journey),
        is_active            = COALESCE(${d.isActive ?? null}, is_active),
        enroll_sequence_id   = COALESCE(${d.enrollSequenceId ?? null}, enroll_sequence_id)
      WHERE id = ${id} AND tenant_id = ${user.tenantId}
      RETURNING *
    `)).rows[0];
    if (!row) { res.status(404).json({ error: "Not found" }); return; }
    res.json(row);
  } catch (err) { next(err); }
});

// DELETE /api/journey-routing-rules/:id
router.delete("/journey-routing-rules/:id", async (req, res, next): Promise<void> => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  try {
    const user = req.user as any;
    await db.execute(sql`
      DELETE FROM journey_routing_rules WHERE id = ${id} AND tenant_id = ${user.tenantId}
    `);
    res.sendStatus(204);
  } catch (err) { next(err); }
});

export default router;
