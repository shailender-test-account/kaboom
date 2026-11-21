import { Router, type IRouter } from "express";
import { z } from "zod";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { requireAuth } from "../middlewares/requireAuth";

const router: IRouter = Router();
router.use(requireAuth);

function objectPathToServingUrl(objectPath: string): string {
  // objectPath = "/objects/uploads/<uuid>"
  // served by storage.ts at GET /storage/objects/*path
  return `/api/storage/objects/${objectPath.slice("/objects/".length)}`;
}

function getFormat(mimeType: string): string {
  if (!mimeType) return "FILE";
  const parts = mimeType.split("/");
  const sub = parts[1] ?? parts[0] ?? "file";
  const map: Record<string, string> = {
    jpeg: "JPG", jpg: "JPG", png: "PNG", gif: "GIF", webp: "WEBP",
    svg: "SVG", "svg+xml": "SVG", pdf: "PDF", mp4: "MP4", webm: "WEBM",
    mov: "MOV", mp3: "MP3", wav: "WAV", "vnd.openxmlformats-officedocument.wordprocessingml.document": "DOCX",
  };
  return map[sub] ?? sub.toUpperCase();
}

function formatBytes(bytes: number | null): string {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const SaveMediaBody = z.object({
  name: z.string().min(1),
  objectPath: z.string().startsWith("/objects/"),
  mimeType: z.string().default("application/octet-stream"),
  fileSize: z.number().optional(),
});

// GET /api/media — list all assets + journeys used count + download count
router.get("/media", async (req, res, next): Promise<void> => {
  try {
    const user = req.user as any;
    const rows = await db.execute(sql`
      SELECT
        m.id,
        m.name,
        m.object_path    AS "objectPath",
        m.mime_type      AS "mimeType",
        m.file_size      AS "fileSize",
        m.created_at     AS "createdAt",
        COUNT(DISTINCT jp.journey_id)::int  AS "journeysUsed",
        COUNT(DISTINCT ad.id)::int          AS "downloadCount"
      FROM media_assets m
      LEFT JOIN journey_pages jp
        ON jp.content ILIKE '%' || m.object_path || '%'
      LEFT JOIN asset_downloads ad
        ON ad.asset_id = m.id
      WHERE m.tenant_id = ${user.tenantId}
      GROUP BY m.id
      ORDER BY m.created_at DESC
    `);
    const assets = (rows.rows as any[]).map((r) => ({
      ...r,
      url: objectPathToServingUrl(r.objectPath),
      format: getFormat(r.mimeType),
      fileSizeLabel: formatBytes(r.fileSize),
    }));
    res.json(assets);
  } catch (err) {
    next(err);
  }
});

// GET /api/media/:id/usage — list journey pages that reference this asset
router.get("/media/:id/usage", async (req, res, next): Promise<void> => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid ID" }); return; }
  try {
    const user = req.user as any;
    // First get the objectPath for this asset
    const assetRows = await db.execute(sql`
      SELECT object_path AS "objectPath"
      FROM media_assets
      WHERE id = ${id} AND tenant_id = ${user.tenantId}
    `);
    if (!assetRows.rows.length) { res.status(404).json({ error: "Not found" }); return; }
    const { objectPath } = assetRows.rows[0] as any;
    // Find journey pages whose content references this object path
    const usageRows = await db.execute(sql`
      SELECT
        j.id    AS "journeyId",
        j.name  AS "journeyName",
        jp.id   AS "pageId",
        jp.title AS "pageTitle",
        jp.sort_order AS "sortOrder"
      FROM journey_pages jp
      JOIN journeys j ON j.id = jp.journey_id
      WHERE jp.content ILIKE '%' || ${objectPath} || '%'
        AND j.tenant_id = ${user.tenantId}
      ORDER BY j.name, jp.sort_order
    `);
    res.json(usageRows.rows);
  } catch (err) {
    next(err);
  }
});

// POST /api/media — save metadata after client-side upload
router.post("/media", async (req, res, next): Promise<void> => {
  const parsed = SaveMediaBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  try {
    const user = req.user as any;
    const { name, objectPath, mimeType, fileSize } = parsed.data;
    const rows = await db.execute(sql`
      INSERT INTO media_assets (tenant_id, name, object_path, mime_type, file_size)
      VALUES (${user.tenantId}, ${name}, ${objectPath}, ${mimeType}, ${fileSize ?? null})
      RETURNING
        id, name,
        object_path  AS "objectPath",
        mime_type    AS "mimeType",
        file_size    AS "fileSize",
        created_at   AS "createdAt"
    `);
    const asset = rows.rows[0] as any;
    res.status(201).json({
      ...asset,
      url: objectPathToServingUrl(asset.objectPath),
      format: getFormat(asset.mimeType),
      fileSizeLabel: formatBytes(asset.fileSize),
      journeysUsed: 0,
    });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/media/:id — rename
router.patch("/media/:id", async (req, res, next): Promise<void> => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid ID" }); return; }
  const parsed = z.object({ name: z.string().min(1) }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "name required" }); return; }
  try {
    const user = req.user as any;
    const rows = await db.execute(sql`
      UPDATE media_assets
      SET name = ${parsed.data.name}
      WHERE id = ${id} AND tenant_id = ${user.tenantId}
      RETURNING id, name, object_path AS "objectPath", mime_type AS "mimeType",
                file_size AS "fileSize", created_at AS "createdAt"
    `);
    if (!rows.rows.length) { res.status(404).json({ error: "Not found" }); return; }
    const asset = rows.rows[0] as any;
    res.json({
      ...asset,
      url: objectPathToServingUrl(asset.objectPath),
      format: getFormat(asset.mimeType),
      fileSizeLabel: formatBytes(asset.fileSize),
    });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/media/:id
router.delete("/media/:id", async (req, res, next): Promise<void> => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid ID" });
    return;
  }
  try {
    const user = req.user as any;
    await db.execute(sql`
      DELETE FROM media_assets WHERE id = ${id} AND tenant_id = ${user.tenantId}
    `);
    res.sendStatus(204);
  } catch (err) {
    next(err);
  }
});

export default router;
