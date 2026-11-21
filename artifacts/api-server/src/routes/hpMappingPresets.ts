import type { IRouter } from "express";
import { z } from "zod";
import { pool } from "@workspace/db";
import { CreateHpMappingPresetBody, UpdateHpMappingPresetBody } from "@workspace/api-zod";
import { requireRole } from "../middlewares/requireAuth";
import { mappingErrors, type HpImportKind } from "../lib/hpMappingValidation";

const base = "/analytics/hp-bi/mapping-presets";
const columns = `id,name,kind,headers,mappings,created_at AS "createdAt",updated_at AS "updatedAt"`;
function validate(kind: HpImportKind, headers: string[], mappings: Record<string, string>) {
  if (new Set(headers).size !== headers.length || headers.some(h => !h.trim() || h !== h.trim()))
    throw Object.assign(new Error("Headings must be unique and nonblank, without surrounding whitespace."), { status: 400 });
  if (Object.keys(mappings).length > 256)
    throw Object.assign(new Error("At most 256 mappings are supported."), { status: 400 });
  const errors = mappingErrors(kind, headers, mappings);
  if (errors.length) throw Object.assign(new Error(errors.join("\n")), { status: 400 });
}
export function registerHpMappingPresets(router: IRouter, scope: (req: any) => Promise<any>, fail: (req: any, res: any, err: any) => void) {
  const handleError = (req: any, res: any, err: any) => {
    if (err.code === "23505") res.status(409).json({ error: "A preset with this name already exists for this import kind." });
    else fail(req, res, err);
  };
  router.get(base, requireRole("admin"), async (req, res) => {
    try {
      const s = await scope(req), kind = z.enum(["accounts", "activities"]).parse(req.query.kind);
      res.json((await pool.query(`SELECT ${columns} FROM hp_mapping_presets WHERE tenant_id=$1 AND client_id=$2 AND kind=$3 ORDER BY name,id`,
        [s.tenantId, s.filters.clientId, kind])).rows);
    } catch (err) { handleError(req, res, err); }
  });
  router.post(base, requireRole("admin"), async (req, res) => {
    try {
      const s = await scope(req);
      const parsed = CreateHpMappingPresetBody.strict().safeParse(req.body);
      if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
      const b = parsed.data, name = z.string().trim().min(1).max(100).parse(b.name);
      validate(b.kind, b.headers, b.mappings);
      res.status(201).json((await pool.query(`INSERT INTO hp_mapping_presets(tenant_id,client_id,kind,name,headers,mappings)
        VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb) RETURNING ${columns}`,
        [s.tenantId, s.filters.clientId, b.kind, name, JSON.stringify(b.headers), JSON.stringify(b.mappings)])).rows[0]);
    } catch (err) { handleError(req, res, err); }
  });
  router.patch(`${base}/:id`, requireRole("admin"), async (req, res) => {
    let client;
    try {
      const s = await scope(req), id = z.coerce.number().int().positive().parse(req.params.id);
      const parsed = UpdateHpMappingPresetBody.strict().safeParse(req.body);
      if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
      const b = parsed.data;
      if (!Object.keys(b).length) { res.status(400).json({ error: "Supply a name or updated mappings." }); return; }
      client = await pool.connect(); await client.query("BEGIN");
      const old = (await client.query(`SELECT * FROM hp_mapping_presets WHERE id=$1 AND tenant_id=$2 AND client_id=$3 FOR UPDATE`,
        [id, s.tenantId, s.filters.clientId])).rows[0];
      if (!old) { await client.query("ROLLBACK"); res.status(404).json({ error: "Preset not found in selected scope." }); return; }
      const headers = b.headers ?? old.headers, mappings = b.mappings ?? old.mappings;
      const name = z.string().trim().min(1).max(100).parse(b.name ?? old.name);
      validate(old.kind, headers, mappings);
      const result = await client.query(`UPDATE hp_mapping_presets SET name=$4,headers=$5::jsonb,mappings=$6::jsonb,updated_at=now()
        WHERE id=$1 AND tenant_id=$2 AND client_id=$3 RETURNING ${columns}`,
        [id, s.tenantId, s.filters.clientId, name, JSON.stringify(headers), JSON.stringify(mappings)]);
      await client.query("COMMIT"); res.json(result.rows[0]);
    } catch (err) { if (client) await client.query("ROLLBACK"); handleError(req, res, err); }
    finally { client?.release(); }
  });
  router.delete(`${base}/:id`, requireRole("admin"), async (req, res) => {
    try {
      const s = await scope(req), id = z.coerce.number().int().positive().parse(req.params.id);
      const result = await pool.query("DELETE FROM hp_mapping_presets WHERE id=$1 AND tenant_id=$2 AND client_id=$3 RETURNING id",
        [id, s.tenantId, s.filters.clientId]);
      if (!result.rowCount) { res.status(404).json({ error: "Preset not found in selected scope." }); return; }
      res.sendStatus(204);
    } catch (err) { handleError(req, res, err); }
  });
}
