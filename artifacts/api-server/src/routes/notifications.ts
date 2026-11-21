import { Router, type IRouter } from "express";
import { eq, desc } from "drizzle-orm";
import { db, notificationsTable } from "@workspace/db";
import { requireAuth } from "../middlewares/requireAuth";

const router: IRouter = Router();
router.use(requireAuth);

router.get("/notifications", async (req, res, next): Promise<void> => {
  try {
    const user = req.user as any;
    if (user.role !== "admin" && (user.sectionPermissions != null || Array.isArray(user.clientIds))) {
      res.json({ notifications: [], unreadCount: 0 }); return;
    }
    const tid = user.tenantId;

    const rows = await db
      .select()
      .from(notificationsTable)
      .where(eq(notificationsTable.tenantId, tid))
      .orderBy(desc(notificationsTable.createdAt))
      .limit(20);

    const unreadCount = rows.filter(n => !n.read).length;
    res.json({ notifications: rows, unreadCount });
  } catch (err) { next(err); }
});

router.post("/notifications/mark-read", async (req, res, next): Promise<void> => {
  try {
    const user = req.user as any;
    const tid = user.tenantId;
    await db
      .update(notificationsTable)
      .set({ read: true })
      .where(eq(notificationsTable.tenantId, tid));
    res.json({ ok: true });
  } catch (err) { next(err); }
});

export default router;
