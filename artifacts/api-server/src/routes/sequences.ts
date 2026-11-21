import { Router, type IRouter } from "express";
import { and, eq } from "drizzle-orm";
import { db, sequencesTable } from "@workspace/db";
import { requireAuth } from "../middlewares/requireAuth";
import {
  CreateSequenceBody,
  UpdateSequenceBody,
  GetSequenceParams,
  UpdateSequenceParams,
  DeleteSequenceParams,
  ListSequencesQueryParams,
} from "@workspace/api-zod";

const router: IRouter = Router();
router.use(requireAuth);

router.get("/sequences", async (req, res, next): Promise<void> => {
  const qp = ListSequencesQueryParams.safeParse(req.query);
  try {
    const user = req.user as any;
    const sequences = await db.select().from(sequencesTable).where(
      and(
        eq(sequencesTable.tenantId, user.tenantId),
        qp.success && qp.data.clientId ? eq(sequencesTable.clientId, qp.data.clientId) : undefined,
      ),
    );
    res.json(sequences);
  } catch (err) { next(err); }
});

router.post("/sequences", async (req, res, next): Promise<void> => {
  const parsed = CreateSequenceBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  try {
    const user = req.user as any;
    const [seq] = await db.insert(sequencesTable).values({ ...parsed.data, tenantId: user.tenantId, nodes: parsed.data.nodes ?? "[]", status: parsed.data.status ?? "draft" }).returning();
    res.status(201).json(seq);
  } catch (err) { next(err); }
});

router.get("/sequences/:id", async (req, res, next): Promise<void> => {
  const params = GetSequenceParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  try {
    const user = req.user as any;
    const [seq] = await db.select().from(sequencesTable).where(eq(sequencesTable.id, params.data.id));
    if (!seq || seq.tenantId !== user.tenantId) { res.status(404).json({ error: "Sequence not found" }); return; }
    res.json(seq);
  } catch (err) { next(err); }
});

router.patch("/sequences/:id", async (req, res, next): Promise<void> => {
  const params = UpdateSequenceParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const parsed = UpdateSequenceBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  try {
    const user = req.user as any;
    const [existing] = await db.select().from(sequencesTable).where(eq(sequencesTable.id, params.data.id));
    if (!existing || existing.tenantId !== user.tenantId) { res.status(404).json({ error: "Sequence not found" }); return; }
    const [seq] = await db.update(sequencesTable).set(parsed.data).where(eq(sequencesTable.id, params.data.id)).returning();
    res.json(seq);
  } catch (err) { next(err); }
});

router.delete("/sequences/:id", async (req, res, next): Promise<void> => {
  const params = DeleteSequenceParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  try {
    const user = req.user as any;
    const [existing] = await db.select().from(sequencesTable).where(eq(sequencesTable.id, params.data.id));
    if (!existing || existing.tenantId !== user.tenantId) { res.status(404).json({ error: "Sequence not found" }); return; }
    await db.delete(sequencesTable).where(eq(sequencesTable.id, params.data.id));
    res.sendStatus(204);
  } catch (err) { next(err); }
});

export default router;
