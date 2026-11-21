import { Router, type IRouter } from "express";
import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { db } from "@workspace/db";
import { requireAuth } from "../middlewares/requireAuth";
import { buildContactsWhereClause, type FilterCriterion } from "../utils/segmentFilter";

/** Build a parameterised IN(...) list of ints — avoids ANY(${arr}::int[]) which breaks Drizzle */
function sqlInInt(ids: number[]): SQL {
  return sql.join(ids.map(id => sql`${id}`), sql`, `);
}

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

/**
 * Computes the live member count for a segment and persists it to
 * last_computed_count/last_computed_at. Previously this only happened when
 * someone opened the segment's detail page (GET /segments/:id/contacts) —
 * freshly created/edited segments showed a stale "0" everywhere else
 * (e.g. the sequence run wizard's segment picker) until then.
 */
async function recomputeSegmentCount(id: number, tenantId: number, seg: SegmentRow): Promise<number> {
  let count = 0;
  if (seg.segment_type === "static") {
    count = (seg.static_contact_ids ?? []).length;
  } else if (seg.filter_criteria?.length) {
    const logicOp = seg.logic_operator === "OR" ? "OR" : "AND";
    const whereExpr = await buildContactsWhereClause(tenantId, seg.filter_criteria, logicOp);
    const countRes = (await db.execute(sql`
      SELECT COUNT(*)::int AS total FROM contacts c LEFT JOIN companies co ON co.id = c.company_id WHERE ${whereExpr}
    `)).rows[0] as { total: number };
    count = countRes.total;
  } else {
    const countRes = (await db.execute(sql`SELECT COUNT(*)::int AS total FROM contacts WHERE tenant_id = ${tenantId}`)).rows[0] as { total: number };
    count = countRes.total;
  }
  await db.execute(sql`
    UPDATE segments SET last_computed_count = ${count}, last_computed_at = NOW() WHERE id = ${id}
  `);
  return count;
}

const SegmentBody = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  segmentType: z.enum(["dynamic","static"]).default("dynamic"),
  filterCriteria: z.array(z.any()).default([]),
  staticContactIds: z.array(z.number()).optional(),
  logicOperator: z.enum(["AND","OR"]).default("AND"),
});

// GET /api/segments
router.get("/segments", async (req, res, next): Promise<void> => {
  try {
    const user = req.user as any;
    const result = (await db.execute(sql`
      SELECT id, name, description, segment_type, filter_criteria, logic_operator,
             static_contact_ids, last_computed_count, last_computed_at,
             created_at, updated_at
      FROM segments WHERE tenant_id = ${user.tenantId}
      ORDER BY created_at DESC
    `)).rows as unknown as (SegmentRow & { last_computed_count: number | null; last_computed_at: string | null })[];

    // Self-heal: segments with no computed count yet get recomputed in the
    // background so the GET /segments response is never blocked by recomputation.
    const stale = result.filter(r => r.last_computed_at === null);
    if (stale.length > 0) {
      // Fire-and-forget — result already sent; DB is updated for next request
      Promise.all(stale.map(r => recomputeSegmentCount(r.id, user.tenantId, r))).catch(() => {});
    }

    res.json(result);
  } catch (err) { next(err); }
});

// POST /api/segments
router.post("/segments", async (req, res, next): Promise<void> => {
  const parsed = SegmentBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  try {
    const user = req.user as any;
    const d = parsed.data;
    const row = (await db.execute(sql`
      INSERT INTO segments (tenant_id, name, description, segment_type, filter_criteria, static_contact_ids, logic_operator)
      VALUES (${user.tenantId}, ${d.name}, ${d.description ?? null}, ${d.segmentType},
              ${JSON.stringify(d.filterCriteria)}::jsonb,
              ${d.staticContactIds ? `{${d.staticContactIds.join(",")}}` : null},
              ${d.logicOperator})
      RETURNING *
    `)).rows[0] as unknown as SegmentRow;
    const count = await recomputeSegmentCount(row.id, user.tenantId, row);
    res.status(201).json({ ...row, last_computed_count: count });
  } catch (err) { next(err); }
});

// GET /api/segments/:id
router.get("/segments/:id", async (req, res, next): Promise<void> => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  try {
    const user = req.user as any;
    const rows = (await db.execute(sql`SELECT * FROM segments WHERE id = ${id} AND tenant_id = ${user.tenantId}`)).rows;
    if (!rows[0]) { res.status(404).json({ error: "Not found" }); return; }
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// PUT /api/segments/:id
router.put("/segments/:id", async (req, res, next): Promise<void> => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const parsed = SegmentBody.partial().safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  try {
    const user = req.user as any;
    const d = parsed.data;
    // Build per-field updates to avoid string-concatenated jsonb
    const row = (await db.execute(
      d.filterCriteria !== undefined
        ? sql`
            UPDATE segments SET
              name               = COALESCE(${d.name ?? null}, name),
              description        = COALESCE(${d.description ?? null}, description),
              segment_type       = COALESCE(${d.segmentType ?? null}, segment_type),
              filter_criteria    = ${JSON.stringify(d.filterCriteria)}::jsonb,
              static_contact_ids = ${d.staticContactIds ? `{${d.staticContactIds.join(",")}}` : null},
              logic_operator     = COALESCE(${d.logicOperator ?? null}, logic_operator),
              updated_at         = NOW()
            WHERE id = ${id} AND tenant_id = ${user.tenantId}
            RETURNING *
          `
        : sql`
            UPDATE segments SET
              name               = COALESCE(${d.name ?? null}, name),
              description        = COALESCE(${d.description ?? null}, description),
              segment_type       = COALESCE(${d.segmentType ?? null}, segment_type),
              logic_operator     = COALESCE(${d.logicOperator ?? null}, logic_operator),
              updated_at         = NOW()
            WHERE id = ${id} AND tenant_id = ${user.tenantId}
            RETURNING *
          `
    )).rows[0] as unknown as SegmentRow | undefined;
    if (!row) { res.status(404).json({ error: "Not found" }); return; }
    const count = await recomputeSegmentCount(row.id, user.tenantId, row);
    res.json({ ...row, last_computed_count: count });
  } catch (err) { next(err); }
});

// DELETE /api/segments/:id?deleteContacts=true
router.delete("/segments/:id", async (req, res, next): Promise<void> => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  try {
    const user = req.user as any;
    const deleteContacts = req.query.deleteContacts === "true";
    const linked = await db.execute(sql`SELECT 1 FROM contact_databases WHERE tenant_id=${user.tenantId} AND segment_id=${id}
      UNION ALL SELECT 1 FROM contact_datasets WHERE tenant_id=${user.tenantId} AND segment_id=${id} LIMIT 1`);
    if (linked.rows.length) {
      res.status(409).json({ error: "This segment belongs to a named database or a recorded dataset. Remove the database association before deleting it; contacts were not deleted." });
      return;
    }

    if (deleteContacts) {
      const seg = (await db.execute(
        sql`SELECT * FROM segments WHERE id = ${id} AND tenant_id = ${user.tenantId}`,
      )).rows[0] as unknown as SegmentRow | undefined;

      if (seg) {
        const typedSeg = seg as SegmentRow;
        const logicOp = typedSeg.logic_operator === "OR" ? "OR" : "AND";
        let whereExpr: SQL;
        if (typedSeg.segment_type === "static") {
          const safeIds = (typedSeg.static_contact_ids ?? [])
            .map((sid) => parseInt(String(sid), 10))
            .filter(n => !isNaN(n));
          whereExpr = safeIds.length > 0
            ? sql`tenant_id = ${user.tenantId} AND id IN (${sqlInInt(safeIds)})`
            : sql`FALSE`;
        } else if (typedSeg.filter_criteria?.length) {
          // buildContactsWhereClause uses alias "c." — wrap with a subquery
          const innerWhere = await buildContactsWhereClause(user.tenantId, typedSeg.filter_criteria, logicOp);
          const ids = (await db.execute(
            sql`SELECT c.id FROM contacts c LEFT JOIN companies co ON co.id = c.company_id WHERE ${innerWhere}`,
          )).rows.map((r: any) => r.id as number);
          whereExpr = ids.length > 0
            ? sql`tenant_id = ${user.tenantId} AND id IN (${sqlInInt(ids)})`
            : sql`FALSE`;
        } else {
          whereExpr = sql`tenant_id = ${user.tenantId}`;
        }

        await db.execute(sql`DELETE FROM contacts WHERE ${whereExpr}`);
      }
    }

    await db.execute(sql`DELETE FROM segments WHERE id = ${id} AND tenant_id = ${user.tenantId}`);
    res.sendStatus(204);
  } catch (err) { next(err); }
});

// POST /api/segments/:id/contacts — append contacts to a static segment
router.post("/segments/:id/contacts", async (req, res, next): Promise<void> => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const parsed = z.object({ contactIds: z.array(z.number().int().positive()).min(1) }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "contactIds must be a non-empty array of positive integers" }); return; }
  try {
    const user = req.user as any;
    const seg = (await db.execute(sql`SELECT * FROM segments WHERE id = ${id} AND tenant_id = ${user.tenantId}`)).rows[0] as unknown as SegmentRow | undefined;
    if (!seg) { res.status(404).json({ error: "Not found" }); return; }
    if (seg.segment_type !== "static") { res.status(400).json({ error: "Can only add contacts manually to static segments" }); return; }
    const existing = (seg.static_contact_ids ?? []).map((n: unknown) => parseInt(String(n), 10)).filter((n: number) => !isNaN(n));
    const merged = Array.from(new Set([...existing, ...parsed.data.contactIds]));
    const pgArray = `{${merged.join(",")}}`;
    const updated = (await db.execute(sql`
      UPDATE segments SET static_contact_ids = ${pgArray}::int[], updated_at = NOW()
      WHERE id = ${id} AND tenant_id = ${user.tenantId}
      RETURNING *
    `)).rows[0] as unknown as SegmentRow;
    const count = await recomputeSegmentCount(updated.id, user.tenantId, updated as any);
    res.json({ ...updated, last_computed_count: count });
  } catch (err) { next(err); }
});

// GET /api/segments/:id/contacts — evaluate live
router.get("/segments/:id/contacts", async (req, res, next): Promise<void> => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  try {
    const user = req.user as any;
    const page = Math.max(1, parseInt(String(req.query.page || "1")));
    const limit = Math.min(1000, Math.max(1, parseInt(String(req.query.limit || "20"))));
    const offset = (page - 1) * limit;

    const seg = (await db.execute(sql`SELECT * FROM segments WHERE id = ${id} AND tenant_id = ${user.tenantId}`)).rows[0] as unknown as SegmentRow | undefined;
    if (!seg) { res.status(404).json({ error: "Not found" }); return; }

    // Empty static segment: no contacts selected → always zero results
    if (seg.segment_type === "static" && !seg.static_contact_ids?.length) {
      res.json({ contacts: [], total: 0, page, limit });
      return;
    }

    const typedSeg = seg as SegmentRow;
    const logicOp = typedSeg.logic_operator === "OR" ? "OR" : "AND";
    let whereExpr: SQL;
    if (typedSeg.segment_type === "static") {
      const safeIds = (typedSeg.static_contact_ids ?? []).map((sid) => parseInt(String(sid), 10)).filter(n => !isNaN(n));
      whereExpr = safeIds.length > 0
        ? sql`c.tenant_id = ${user.tenantId} AND c.id IN (${sqlInInt(safeIds)})`
        : sql`FALSE`;
    } else if (typedSeg.filter_criteria?.length) {
      whereExpr = await buildContactsWhereClause(user.tenantId, typedSeg.filter_criteria, logicOp);
    } else {
      whereExpr = sql`c.tenant_id = ${user.tenantId}`;
    }

    const contacts = (await db.execute(sql`
      SELECT c.id, c.first_name, c.last_name, c.email, c.phone, c.title,
             c.lead_score, c.stage, c.tags,
             c.city, c.state, c.country,
             c.employee_size, c.designation, c.function,
             COALESCE(c.company_name, co.name) AS company_name,
             co.industry, co.size AS company_size
      FROM contacts c
      LEFT JOIN companies co ON co.id = c.company_id
      WHERE ${whereExpr}
      ORDER BY c.lead_score DESC
      LIMIT ${limit} OFFSET ${offset}
    `)).rows;

    const countRes = (await db.execute(sql`
      SELECT COUNT(*)::int AS total FROM contacts c LEFT JOIN companies co ON co.id = c.company_id WHERE ${whereExpr}
    `)).rows[0] as { total: number };

    await db.execute(sql`
      UPDATE segments SET last_computed_count = ${countRes.total}, last_computed_at = NOW()
      WHERE id = ${id}
    `);

    res.json({ contacts, total: countRes.total, page, limit });
  } catch (err) { next(err); }
});

// ── CSV helpers ───────────────────────────────────────────────────────────────
function csvEscape(value: string): string {
  // Neutralize spreadsheet formula injection: prefix cells that start with
  // =, +, -, or @ with a tab so Excel/Sheets never interpret them as formulas.
  const safe = /^[=+\-@\t]/.test(value) ? `\t${value}` : value;
  if (safe.includes(",") || safe.includes('"') || safe.includes("\n") || safe.includes("\t")) {
    return `"${safe.replace(/"/g, '""')}"`;
  }
  return safe;
}

// GET /api/segments/:id/export.csv
router.get("/segments/:id/export.csv", async (req, res, next): Promise<void> => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  try {
    const user = req.user as any;
    const seg = (await db.execute(sql`SELECT * FROM segments WHERE id = ${id} AND tenant_id = ${user.tenantId}`)).rows[0] as unknown as SegmentRow | undefined;
    if (!seg) { res.status(404).json({ error: "Not found" }); return; }

    const safeName = (seg.name as string).replace(/[^a-z0-9]/gi, "_").slice(0, 40);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="segment-${id}-${safeName}.csv"`);
    res.write("First Name,Last Name,Email,Company,Score,Stage,Tags,Added Date\n");

    if (seg.segment_type === "static" && !(seg.static_contact_ids as number[] | null)?.length) {
      res.end();
      return;
    }

    const typedSeg = seg as SegmentRow;
    const logicOp = typedSeg.logic_operator === "OR" ? "OR" : "AND";
    let whereExpr: SQL;
    if (typedSeg.segment_type === "static") {
      const safeIds = (typedSeg.static_contact_ids ?? []).map((sid) => parseInt(String(sid), 10)).filter(n => !isNaN(n));
      whereExpr = safeIds.length > 0
        ? sql`c.tenant_id = ${user.tenantId} AND c.id IN (${sqlInInt(safeIds)})`
        : sql`FALSE`;
    } else if (typedSeg.filter_criteria?.length) {
      whereExpr = await buildContactsWhereClause(user.tenantId, typedSeg.filter_criteria, logicOp);
    } else {
      whereExpr = sql`c.tenant_id = ${user.tenantId}`;
    }

    const PAGE_SIZE = 500;
    let offset = 0;
    let hasMore = true;

    while (hasMore) {
      const rows = (await db.execute(sql`
        SELECT c.first_name, c.last_name, c.email, c.lead_score, c.stage, c.tags, c.created_at,
               co.name AS company_name
        FROM contacts c
        LEFT JOIN companies co ON co.id = c.company_id
        WHERE ${whereExpr}
        ORDER BY c.lead_score DESC, c.id DESC
        LIMIT ${PAGE_SIZE} OFFSET ${offset}
      `)).rows as Array<{
        first_name: string; last_name: string; email: string;
        lead_score: number; stage: string | null; tags: string[] | null;
        created_at: string; company_name: string | null;
      }>;

      for (const row of rows) {
        const tags = Array.isArray(row.tags) ? row.tags.join(";") : "";
        const addedDate = row.created_at ? new Date(row.created_at).toISOString().split("T")[0] : "";
        const line = [
          csvEscape(row.first_name ?? ""),
          csvEscape(row.last_name ?? ""),
          csvEscape(row.email ?? ""),
          csvEscape(row.company_name ?? ""),
          String(row.lead_score ?? 0),
          csvEscape(row.stage ?? ""),
          csvEscape(tags),
          addedDate,
        ].join(",");
        res.write(line + "\n");
      }

      offset += PAGE_SIZE;
      hasMore = rows.length === PAGE_SIZE;
    }

    res.end();
  } catch (err) { next(err); }
});

// POST /api/segments/preview — evaluate for unsaved/draft segment
router.post("/segments/preview", async (req, res, next): Promise<void> => {
  try {
    const user = req.user as any;
    // Validate all inputs before using in SQL
    const PreviewBody = z.object({
      filterCriteria: z.array(z.any()).default([]),
      segmentType: z.enum(["dynamic", "static"]).default("dynamic"),
      staticContactIds: z.array(z.number().int().positive()).default([]),
      logicOperator: z.enum(["AND", "OR"]).default("AND"),
    });
    const parsed = PreviewBody.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
    const { filterCriteria, segmentType, staticContactIds, logicOperator } = parsed.data;

    // Empty static segment: return zero results — never fall back to full-tenant scan
    if (segmentType === "static" && staticContactIds.length === 0) {
      res.json({
        contacts: [], total: 0,
        scoreDistribution: { Cold: 0, Warm: 0, Hot: 0, "Very Hot": 0, Champion: 0 },
        topCompanies: [],
      });
      return;
    }

    const logicOp = logicOperator === "OR" ? "OR" : "AND";
    let whereExpr: SQL;
    if (segmentType === "static") {
      const safeStaticIds = (staticContactIds ?? []).map((id: unknown) => parseInt(String(id), 10)).filter((n: number) => !isNaN(n));
      whereExpr = safeStaticIds.length > 0
        ? sql`c.tenant_id = ${user.tenantId} AND c.id IN (${sqlInInt(safeStaticIds)})`
        : sql`FALSE`;
    } else {
      whereExpr = await buildContactsWhereClause(user.tenantId, filterCriteria, logicOp);
    }

    const contacts = (await db.execute(sql`
      SELECT c.id, c.first_name, c.last_name, c.email, c.title, c.lead_score, c.stage, c.tags,
             co.name AS company_name
      FROM contacts c
      LEFT JOIN companies co ON co.id = c.company_id
      WHERE ${whereExpr}
      ORDER BY c.lead_score DESC
      LIMIT 20
    `)).rows;

    const countRes = (await db.execute(sql`
      SELECT COUNT(*)::int AS total FROM contacts c LEFT JOIN companies co ON co.id = c.company_id WHERE ${whereExpr}
    `)).rows[0] as { total: number };

    const dist = (await db.execute(sql`
      SELECT
        SUM(CASE WHEN c.lead_score BETWEEN 0   AND 24  THEN 1 ELSE 0 END) AS "Cold",
        SUM(CASE WHEN c.lead_score BETWEEN 25  AND 49  THEN 1 ELSE 0 END) AS "Warm",
        SUM(CASE WHEN c.lead_score BETWEEN 50  AND 74  THEN 1 ELSE 0 END) AS "Hot",
        SUM(CASE WHEN c.lead_score BETWEEN 75  AND 119 THEN 1 ELSE 0 END) AS "Very Hot",
        SUM(CASE WHEN c.lead_score >= 120               THEN 1 ELSE 0 END) AS "Champion"
      FROM contacts c LEFT JOIN companies co ON co.id = c.company_id WHERE ${whereExpr}
    `)).rows[0] as Record<string, number | null>;

    const companies = (await db.execute(sql`
      SELECT co.name, COUNT(c.id)::int AS contact_count
      FROM contacts c
      JOIN companies co ON co.id = c.company_id
      WHERE ${whereExpr}
      GROUP BY co.id, co.name
      ORDER BY contact_count DESC
      LIMIT 5
    `)).rows;

    res.json({ contacts, total: countRes.total, scoreDistribution: dist, topCompanies: companies });
  } catch (err) { next(err); }
});

export default router;
