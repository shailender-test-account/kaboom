import { Router, type Request } from "express";
import { z } from "zod";
import { pool } from "@workspace/db";
import { requireAuth } from "../middlewares/requireAuth";
import { applyResearchCorrection, proposeResearchCorrection, refreshCorrectedResearch, ResearchCorrectionError } from "../lib/researchFindingCorrection";

const router = Router();
router.use(requireAuth);
type Actor = { id: number; tenantId: number; role: string };
const accountId = (req: Request) => z.coerce.number().int().positive().safeParse(req.params.accountId);
const approval = z.object({
  proposalId: z.string().uuid(), evidenceId: z.number().int().positive(),
  sourceVersion: z.string().regex(/^[a-f0-9]{64}$/), approved: z.literal(true),
  reason: z.string().trim().min(8).max(1000),
}).strict();

router.use("/intent/accounts/:accountId/research-corrections", (req, res, next) => {
  if ((req.user as Actor).role !== "admin") { res.status(403).json({ error: "Admins only" }); return; }
  next();
});
router.get("/intent/accounts/:accountId/research-corrections", async (req, res, next) => {
  try {
    const actor = req.user as Actor, parsed = accountId(req);
    const cursor = z.coerce.number().int().positive().optional().safeParse(req.query.cursor);
    if (!parsed.success || !cursor.success) { res.status(400).json({ error: "Invalid account or cursor" }); return; }
    if (!(await pool.query("SELECT id FROM companies WHERE tenant_id=$1 AND id=$2", [actor.tenantId, parsed.data])).rows.length) {
      res.status(404).json({ error: "Account not found" }); return;
    }
    const findings = (await pool.query(`SELECT id,event_type AS "eventType",source_url AS "sourceUrl",excerpt,
      COALESCE(raw_evidence->>'excerpt',context->>'originalExcerpt','') AS "originalExcerpt"
      FROM intent_evidence WHERE tenant_id=$1 AND account_id=$2 AND evidence_kind='public_event'
      AND review_status='approved' AND ($3::int IS NULL OR id<$3) ORDER BY id DESC LIMIT 26`,
    [actor.tenantId, parsed.data, cursor.data ?? null])).rows;
    const history = (await pool.query(`SELECT id AS "proposalId",evidence_id AS "evidenceId",proposal,reason,
      approved_by AS "approvedBy",applied_at AS "appliedAt",applied_delta AS delta
      FROM intent_research_corrections WHERE tenant_id=$1 AND account_id=$2 AND status='applied'
      ORDER BY applied_at DESC,id LIMIT 100`, [actor.tenantId, parsed.data])).rows;
    res.json({ items: findings.slice(0, 25), nextCursor: findings.length > 25 ? findings[24].id : null, history });
  } catch (error) { next(error); }
});
router.post("/intent/accounts/:accountId/research-corrections/preview", async (req, res, next) => {
  try {
    const parsed = accountId(req), body = z.object({ evidenceId: z.number().int().positive() }).strict().safeParse(req.body);
    if (!parsed.success || !body.success) { res.status(400).json({ error: "Account and one finding are required" }); return; }
    res.json(await proposeResearchCorrection(req.user as Actor, parsed.data, body.data.evidenceId));
  } catch (error) { next(error); }
});
router.post("/intent/accounts/:accountId/research-corrections/apply", async (req, res, next) => {
  try {
    const parsed = accountId(req), body = approval.safeParse(req.body);
    if (!parsed.success || !body.success) { res.status(400).json({ error: "Explicit per-finding approval, server proposal, source version and reason are required" }); return; }
    const actor = req.user as Actor;
    const applied = await applyResearchCorrection(actor, parsed.data, body.data);
    try {
      await refreshCorrectedResearch(actor.tenantId, parsed.data);
      res.json({ ...applied, refreshPending: false });
    } catch (error) {
      req.log.error({ err: error, proposalId: body.data.proposalId }, "Research correction saved; research-view refresh needs retry");
      // Apply committed. Never misrepresent this as a failed approval or encourage replay.
      res.json({ ...applied, refreshPending: true });
    }
  } catch (error) { next(error); }
});
router.post("/intent/accounts/:accountId/research-corrections/refresh", async (req, res, next) => {
  try {
    const parsed = accountId(req), actor = req.user as Actor;
    if (!parsed.success) { res.status(400).json({ error: "Invalid account" }); return; }
    const saved = await pool.query(`SELECT id FROM intent_research_corrections
      WHERE tenant_id=$1 AND account_id=$2 AND status='applied' LIMIT 1`, [actor.tenantId, parsed.data]);
    if (!saved.rows.length) { res.status(404).json({ error: "No applied corrections for this account" }); return; }
    await refreshCorrectedResearch(actor.tenantId, parsed.data);
    res.json({ refreshed: true });
  } catch (error) { next(error); }
});
router.use((error: unknown, _req: Request, res: import("express").Response, next: import("express").NextFunction) => {
  if (error instanceof ResearchCorrectionError) { res.status(error.status).json({ error: error.message }); return; }
  next(error);
});
export default router;
