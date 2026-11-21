import { Router, type IRouter } from "express";
import { and, eq, desc } from "drizzle-orm";
import { z } from "zod";
import { db, contactNotesTable } from "@workspace/db";
import { requireAuth } from "../middlewares/requireAuth";

const router: IRouter = Router();
router.use(requireAuth);

const NoteBody = z.object({ body: z.string().min(1) });

router.get("/contacts/:id/notes", async (req, res, next): Promise<void> => {
  const contactId = parseInt(req.params.id);
  if (isNaN(contactId)) { res.status(400).json({ error: "Invalid id" }); return; }
  try {
    const user = req.user as any;
    const notes = await db
      .select()
      .from(contactNotesTable)
      .where(and(eq(contactNotesTable.contactId, contactId), eq(contactNotesTable.tenantId, user.tenantId)))
      .orderBy(desc(contactNotesTable.createdAt));
    res.json(notes);
  } catch (err) { next(err); }
});

router.post("/contacts/:id/notes", async (req, res, next): Promise<void> => {
  const contactId = parseInt(req.params.id);
  if (isNaN(contactId)) { res.status(400).json({ error: "Invalid id" }); return; }
  const parsed = NoteBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  try {
    const user = req.user as any;
    const [note] = await db
      .insert(contactNotesTable)
      .values({ body: parsed.data.body, contactId, tenantId: user.tenantId, authorId: user.id })
      .returning();
    res.status(201).json(note);
  } catch (err) { next(err); }
});

router.delete("/contacts/:contactId/notes/:noteId", async (req, res, next): Promise<void> => {
  const contactId = parseInt(req.params.contactId);
  const noteId = parseInt(req.params.noteId);
  if (isNaN(contactId) || isNaN(noteId)) { res.status(400).json({ error: "Invalid id" }); return; }
  try {
    const user = req.user as any;
    await db
      .delete(contactNotesTable)
      .where(and(eq(contactNotesTable.id, noteId), eq(contactNotesTable.tenantId, user.tenantId)));
    res.sendStatus(204);
  } catch (err) { next(err); }
});

export default router;
