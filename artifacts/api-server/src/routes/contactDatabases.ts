import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";
import { requireAuth } from "../middlewares/requireAuth";
import { permittedClientIds } from "../lib/requestClientScope";

const router: IRouter = Router();
router.use("/contact-databases", requireAuth);

router.get("/contact-databases", async (req, res, next) => {
  try {
    const tenantId = (req.user as { tenantId: number }).tenantId;
    const allowed=permittedClientIds(req);
    if(allowed!==null){
      // Database containers and saved segments are shared tenant resources.
      // Keep them hidden while still reporting the member's own contact scope.
      const coverage=await pool.query(`SELECT count(*)::int total,count(*) FILTER(WHERE NOT EXISTS(
        SELECT 1 FROM contact_dataset_members m JOIN contact_datasets ds ON ds.id=m.dataset_id
        WHERE m.contact_id=c.id AND ds.tenant_id=$1))::int unassigned
        FROM contacts c WHERE c.tenant_id=$1 AND c.client_id=ANY($2::int[]) AND c.is_anonymous=FALSE`,[tenantId,allowed]);
      res.json({databases:[],segments:[],unassignedCount:coverage.rows[0].unassigned,totalContacts:coverage.rows[0].total});
      return;
    }
    const [databases, segments, coverage] = await Promise.all([
      pool.query(`
        SELECT d.id,d.name,d.segment_id AS "segmentId",
          (SELECT count(DISTINCT m.contact_id)::int FROM contact_datasets ds
            JOIN contact_dataset_members m ON m.dataset_id=ds.id WHERE ds.database_id=d.id) AS "contactCount",
          (SELECT count(*)::int FROM contact_datasets ds WHERE ds.database_id=d.id) AS "datasetCount",
          (SELECT max(ds.added_at) FROM contact_datasets ds WHERE ds.database_id=d.id) AS "lastDatasetAddedAt",
          COALESCE((SELECT jsonb_agg(DISTINCT jsonb_build_object('id',c.id,'name',c.name))
            FROM contact_datasets ds JOIN contact_dataset_members m ON m.dataset_id=ds.id
            JOIN contacts ct ON ct.id=m.contact_id AND ct.tenant_id=d.tenant_id
            JOIN clients c ON c.id=ct.client_id AND c.tenant_id=d.tenant_id
            WHERE ds.database_id=d.id),'[]'::jsonb) AS clients,
          COALESCE((SELECT jsonb_agg(DISTINCT jsonb_build_object('id',s.id,'name',s.name))
            FROM segments s WHERE s.tenant_id=d.tenant_id AND (s.id=d.segment_id OR s.id IN (
              SELECT ds.segment_id FROM contact_datasets ds WHERE ds.database_id=d.id
            ))),'[]'::jsonb) AS segments,
          COALESCE((SELECT jsonb_agg(DISTINCT jsonb_build_object('id',q.id,'name',q.name))
            FROM sequence_runs r JOIN sequences q ON q.id=r.sequence_id AND q.tenant_id=d.tenant_id
            WHERE r.tenant_id=d.tenant_id AND r.started_at IS NOT NULL AND r.total_contacts>0
            AND EXISTS (SELECT 1 FROM unnest(r.contact_list_ids) used(contact_id)
              JOIN contact_dataset_members m ON m.contact_id=used.contact_id
              JOIN contact_datasets ds ON ds.id=m.dataset_id
              WHERE ds.database_id=d.id)
            ),'[]'::jsonb) AS sequences,
          (SELECT max(r.started_at) FROM sequence_runs r
            WHERE r.tenant_id=d.tenant_id AND r.started_at IS NOT NULL AND r.total_contacts>0
            AND EXISTS (SELECT 1 FROM unnest(r.contact_list_ids) used(contact_id)
              JOIN contact_dataset_members m ON m.contact_id=used.contact_id
              JOIN contact_datasets ds ON ds.id=m.dataset_id
              WHERE ds.database_id=d.id)
            ) AS "lastUsedAt"
        FROM contact_databases d WHERE d.tenant_id=$1 ORDER BY d.name`, [tenantId]),
      pool.query(`SELECT id,name,segment_type AS "segmentType" FROM segments
        WHERE tenant_id=$1 ORDER BY name`, [tenantId]),
      pool.query(`SELECT count(*)::int AS total,
        count(*) FILTER (WHERE NOT EXISTS (
          SELECT 1 FROM contact_dataset_members m JOIN contact_datasets ds ON ds.id=m.dataset_id
          WHERE m.contact_id=c.id AND ds.tenant_id=$1
        ))::int AS unassigned FROM contacts c
        WHERE c.tenant_id=$1 AND c.is_anonymous=FALSE`, [tenantId]),
    ]);
    res.json({ databases: databases.rows, segments: segments.rows,
      unassignedCount: coverage.rows[0].unassigned, totalContacts: coverage.rows[0].total });
  } catch (error) { next(error); }
});

router.get("/contact-databases/:id/datasets", async (req, res, next) => {
  try {
    const tenantId = (req.user as { tenantId: number }).tenantId;
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) { res.status(400).json({ error: "Invalid database" }); return; }
    const own = await pool.query("SELECT 1 FROM contact_databases WHERE id=$1 AND tenant_id=$2", [id, tenantId]);
    if (!own.rowCount) { res.status(404).json({ error: "Database not found" }); return; }
    const page = Math.max(1, Math.min(100000, Number(req.query.page) || 1));
    const [items, count] = await Promise.all([
      pool.query(`SELECT ds.id,ds.name,ds.added_at AS "addedAt",c.name AS "clientName",s.name AS "segmentName",
        count(m.contact_id)::int AS "contactCount"
        FROM contact_datasets ds
        LEFT JOIN contact_dataset_members m ON m.dataset_id=ds.id
        LEFT JOIN clients c ON c.id=ds.client_id AND c.tenant_id=ds.tenant_id
        LEFT JOIN segments s ON s.id=ds.segment_id AND s.tenant_id=ds.tenant_id
        WHERE ds.database_id=$1 AND ds.tenant_id=$2 GROUP BY ds.id,c.name,s.name
        ORDER BY ds.created_at DESC,ds.id DESC LIMIT 20 OFFSET $3`, [id, tenantId, (page-1)*20]),
      pool.query<{total:number}>("SELECT count(*)::int total FROM contact_datasets WHERE database_id=$1 AND tenant_id=$2", [id, tenantId]),
    ]);
    res.json({ datasets: items.rows, total: count.rows[0].total, page });
  } catch (error) { next(error); }
});

export default router;
