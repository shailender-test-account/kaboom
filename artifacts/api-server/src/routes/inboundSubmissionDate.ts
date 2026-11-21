import type { IRouter } from "express";
import { z } from "zod";
import { requireAuth } from "../middlewares/requireAuth";
import { editInboundSubmissionDate } from "../lib/inboundSubmissionDate";

export function registerInboundSubmissionDateRoute(router: IRouter) {
  router.patch("/intent/inbound/responses/:id/submission-date", requireAuth, async (req, res, next) => {
    const user = req.user as { tenantId: number; id: number; role: string };
    if (user.role !== "admin") { res.status(403).json({ error: "Forbidden" }); return; }
    const id = Number(req.params.id);
    const parsed = z.object({ submittedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).safeParse(req.body);
    if (!Number.isSafeInteger(id) || id <= 0 || !parsed.success) {
      res.status(400).json({ error: "Enter a valid submission date (YYYY-MM-DD)." }); return;
    }
    try {
      res.json(await editInboundSubmissionDate(user.tenantId, id, parsed.data.submittedDate, user.id));
    } catch (err: any) {
      if (err.status) { res.status(err.status).json({ error: err.message }); return; }
      next(err);
    }
  });
}
