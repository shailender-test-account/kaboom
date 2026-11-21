import { Router, type IRouter } from "express";
import { permittedClientIds } from "../lib/requestClientScope";
import { pool } from "@workspace/db";
import { GetMonitoringHistoryAccountsResponse } from "@workspace/api-zod";
import { z } from "zod/v4";
import { requireRole } from "../middlewares/requireAuth";
import { monitoringHistoryAccounts } from "../lib/monitoringHistory";
import { monitoringBatchAccounts } from "../lib/monitoringBatchAccounts";
import { GetMonitoringBatchAccountsResponse } from "@workspace/api-zod";

const router: IRouter = Router();
const calendarDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value && value >= "0001-01-01";
});
router.get("/intent/monitoring-history/batch-accounts", requireRole("admin"), async (req, res, next): Promise<void> => {
  try {
    const parsed = z.object({
      configId: z.coerce.number().int().positive(),
      runId: z.coerce.number().int().positive(),
      status: z.enum(["all", "processed", "completed", "failed", "remaining"]),
      lane: z.enum(["warm", "prospect"]).optional(),
      page: z.coerce.number().int().min(1).max(1000000).default(1),
      pageSize: z.coerce.number().int().min(1).max(100).default(20),
    }).safeParse(req.query);
    if (!parsed.success) { res.status(400).json({error: "Choose a valid monitoring batch, status and page"}); return; }
    const tenantId = (req.user as Express.User & {tenantId: number}).tenantId;
    const {configId, runId, status, page, pageSize, lane} = parsed.data;
    const owned = await pool.query(`SELECT 1 FROM intent_monitoring_configs c
      JOIN intent_research_runs r ON r.tenant_id=c.tenant_id AND r.id=$3
      WHERE c.tenant_id=$1 AND c.id=$2 AND (
        (split_part(r.idempotency_key,':',1)='monitoring-activation' AND split_part(r.idempotency_key,':',2)=$2::text)
        OR (split_part(r.idempotency_key,':',1)='daily-monitoring' AND split_part(r.idempotency_key,':',3)=$2::text))`,
    [tenantId, configId, runId]);
    if (!owned.rowCount) { res.status(404).json({error: "Monitoring batch not found"}); return; }
    res.json(GetMonitoringBatchAccountsResponse.parse(
      await monitoringBatchAccounts(tenantId, configId, runId, status, page, pageSize, lane, permittedClientIds(req))));
  } catch (error) { next(error); }
});
router.get("/intent/monitoring-history/accounts", requireRole("admin"), async (req, res, next): Promise<void> => {
  try {
    // Keep calendar strings intact: JS Date and PostgreSQL can normalize invalid days.
    const parsed = z.object({
      date: calendarDay,
      endDate: calendarDay.optional(),
      status: z.enum(["completed", "failed"]),
      configId: z.coerce.number().int().positive().optional(),
      page: z.coerce.number().int().min(1).max(1000000).default(1),
      pageSize: z.coerce.number().int().min(1).max(100).default(20),
    }).refine(value => !value.endDate || (value.endDate >= value.date &&
      Date.parse(value.endDate) - Date.parse(value.date) <= 89 * 86400000), "Choose an inclusive range of at most 90 days.").safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "Choose a valid IST date, status, schedule and page" }); return;
    }
    const tenantId = (req.user as Express.User & { tenantId: number }).tenantId;
    const { date, endDate, status, page, pageSize, configId } = parsed.data;
    if (configId && !(await pool.query("SELECT 1 FROM intent_monitoring_configs WHERE tenant_id=$1 AND id=$2", [tenantId, configId])).rowCount) {
      res.status(404).json({ error: "Monitoring schedule not found" }); return;
    }
    res.json(GetMonitoringHistoryAccountsResponse.parse(
      await monitoringHistoryAccounts(tenantId, date, status, page, pageSize, configId, endDate, permittedClientIds(req))));
  } catch (error) { next(error); }
});
export default router;
