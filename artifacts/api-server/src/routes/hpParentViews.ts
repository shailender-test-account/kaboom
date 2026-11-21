import type { IRouter } from "express";
import { pool } from "@workspace/db";
import { z } from "zod";
import {
  CreateHpParentViewBody, UpdateHpParentViewBody,
  UpdateHpParentViewResponse, ListHpParentViewsResponse,
} from "@workspace/api-zod";

const base = "/analytics/hp-bi/pivot/views";
const columns = `id,name,config,created_at AS "createdAt",updated_at AS "updatedAt"`;
// Generated contracts enforce fields/enums; these refinements enforce calendar semantics.
const configSchema = CreateHpParentViewBody.shape.config.strict().superRefine((config, ctx) => {
  for (const key of ["parents", "segments", "portfolios", "rads"] as const) {
    if (new Set(config[key]).size !== config[key].length)
      ctx.addIssue({ code: "custom", path: [key], message: "Selections must be unique." });
  }
  for (const [start, end] of [["currentStart", "currentEnd"], ["previousStart", "previousEnd"]] as const) {
    if (config.datePolicy !== "custom") {
      if (config[start] !== undefined || config[end] !== undefined)
        ctx.addIssue({ code: "custom", path: [start], message: "Relative presets must not contain fixed dates." });
      continue;
    }
    const s = config[start], e = config[end];
    const valid = (day?: string) => {
      if (!day) return false;
      const d = new Date(`${day}T00:00:00Z`);
      return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === day;
    };
    if (!valid(s) || !valid(e)) {
      ctx.addIssue({ code: "custom", path: [start], message: "Custom periods require four valid calendar dates." });
    } else {
      const length = (Date.parse(`${e}T00:00:00Z`) - Date.parse(`${s}T00:00:00Z`)) / 86400000;
      if (length < 0 || length >= 1096)
        ctx.addIssue({ code: "custom", path: [end], message: "End must follow start and the period cannot exceed three years." });
    }
  }
});
const nameSchema = z.string().trim().min(1).max(100);
export const parentViewInputSchema = CreateHpParentViewBody.strict().extend({ name: nameSchema, config: configSchema });
export const parentViewUpdateSchema = UpdateHpParentViewBody.strict().extend({ name: nameSchema.optional(), config: configSchema.optional() })
  .refine(b => b.name !== undefined || b.config !== undefined, "Supply a name or comparison configuration.");

export function registerHpParentViews(router: IRouter,
  scope: (req: any) => Promise<{ tenantId: number; filters: { clientId: number } }>,
  fail: (req: any, res: any, error: any) => void) {
  const error = (req: any, res: any, err: any) => {
    if (err.code === "23505") res.status(409).json({ error: "A saved view with this name already exists for this client." });
    else fail(req, res, err);
  };
  router.get(base, async (req, res): Promise<void> => {
    try {
      const s = await scope(req);
      const rows = (await pool.query(`SELECT ${columns} FROM hp_parent_views WHERE tenant_id=$1 AND client_id=$2 ORDER BY name,id`,
        [s.tenantId, s.filters.clientId])).rows;
      res.json(ListHpParentViewsResponse.parse(rows));
    } catch (err) { error(req, res, err); }
  });
  router.post(base, async (req, res): Promise<void> => {
    try {
      const s = await scope(req), b = parentViewInputSchema.parse(req.body);
      const row = (await pool.query(`INSERT INTO hp_parent_views(tenant_id,client_id,name,config)
        VALUES($1,$2,$3,$4::jsonb) RETURNING ${columns}`,
        [s.tenantId, s.filters.clientId, b.name, JSON.stringify(b.config)])).rows[0];
      res.status(201).json(UpdateHpParentViewResponse.parse(row));
    } catch (err) { error(req, res, err); }
  });
  router.patch(`${base}/:id`, async (req, res): Promise<void> => {
    try {
      const s = await scope(req), id = z.coerce.number().int().positive().parse(req.params.id);
      const b = parentViewUpdateSchema.parse(req.body);
      // Atomic partial update: a rename never overwrites another session's configuration.
      const row = (await pool.query(`UPDATE hp_parent_views SET name=COALESCE($4,name),config=COALESCE($5::jsonb,config),updated_at=now()
        WHERE id=$1 AND tenant_id=$2 AND client_id=$3 RETURNING ${columns}`,
        [id, s.tenantId, s.filters.clientId, b.name ?? null, b.config ? JSON.stringify(b.config) : null])).rows[0];
      if (!row) { res.status(404).json({ error: "Saved view not found in selected scope." }); return; }
      res.json(UpdateHpParentViewResponse.parse(row));
    } catch (err) { error(req, res, err); }
  });
  router.delete(`${base}/:id`, async (req, res): Promise<void> => {
    try {
      const s = await scope(req), id = z.coerce.number().int().positive().parse(req.params.id);
      const result = await pool.query("DELETE FROM hp_parent_views WHERE id=$1 AND tenant_id=$2 AND client_id=$3 RETURNING id",
        [id, s.tenantId, s.filters.clientId]);
      if (!result.rowCount) { res.status(404).json({ error: "Saved view not found in selected scope." }); return; }
      res.sendStatus(204);
    } catch (err) { error(req, res, err); }
  });
}
