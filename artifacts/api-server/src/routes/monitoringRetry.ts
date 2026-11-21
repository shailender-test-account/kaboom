import type { IRouter, Request, Response } from "express";
import {
  RetryMonitoringRunBody, RetryMonitoringRunParams,
  RetryMonitoringRunResponse, GetMonitoringRetryOptionsResponse,
} from "@workspace/api-zod";
import { MONITORING_ENGINES, MonitoringRetryError, retryMonitoringRun } from "../lib/monitoringRetry";
import { providerConfigured } from "../lib/intentProviders";
import { kickIntentResearchRunner } from "../intentResearchRunner";
import { monitoringResearchAllowed } from "../lib/monitoringResearchPolicy";
import { hasManageGrant, type SectionPermissions } from "@workspace/api-zod";

type Admin = { id: number; tenantId: number; role: string; sectionPermissions?: SectionPermissions | null };
function admin(req: Request, res: Response) {
  const user = req.user as Admin;
  if (!hasManageGrant(user, "monitoring")) { res.status(403).json({ error: "Manage access required" }); return null; }
  return user;
}

export function registerMonitoringRetryRoutes(router: IRouter) {
  router.get("/intent/monitoring-retry-options", async (req, res, next): Promise<void> => {
    try {
      const user = admin(req, res); if (!user) return;
      const engines = await Promise.all(MONITORING_ENGINES.map(async engine => ({
        ...engine, configured: await providerConfigured(user.tenantId, engine.provider),
      })));
      res.json(GetMonitoringRetryOptionsResponse.parse({ engines, safetyPaused: !monitoringResearchAllowed() }));
    } catch (error) { next(error); }
  });
  router.post("/intent/monitoring-configs/:id/retry", async (req, res, next): Promise<void> => {
    try {
      const user = admin(req, res); if (!user) return;
      const params = RetryMonitoringRunParams.safeParse(req.params);
      const body = RetryMonitoringRunBody.safeParse(req.body);
      if (!params.success || !body.success) { res.status(400).json({ error: "Select a valid source run and research engine." }); return; }
      const result = await retryMonitoringRun(user.tenantId, user.id, params.data.id, body.data.runId, body.data.provider);
      if (!result.duplicate) kickIntentResearchRunner();
      res.status(202).json(RetryMonitoringRunResponse.parse(result));
    } catch (error) {
      if (error instanceof MonitoringRetryError) { res.status(error.status).json({ error: error.message }); return; }
      next(error);
    }
  });
}
