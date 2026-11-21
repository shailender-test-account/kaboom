import { Router, type IRouter } from "express";
import { eq, inArray, and, sql } from "drizzle-orm";
import { db, clientsTable, playsTable, contactsTable } from "@workspace/db";
import { requireAuth } from "../middlewares/requireAuth";
import {
  CreateClientBody,
  UpdateClientBody,
  GetClientParams,
  UpdateClientParams,
  DeleteClientParams,
} from "@workspace/api-zod";

const router: IRouter = Router();
router.use(requireAuth);

router.get("/clients", async (req, res, next): Promise<void> => {
  try {
    const user = req.user as any;
    const clients = await db
      .select()
      .from(clientsTable)
      .where(and(eq(clientsTable.tenantId, user.tenantId),
        Array.isArray(user.clientIds) && user.role !== "admin"
          ? inArray(clientsTable.id, user.clientIds) : undefined));

    // Compute counts
    const result = await Promise.all(
      clients.map(async (c) => {
        const [playsResult] = await db
          .select({ count: sql<number>`count(*)::int` })
          .from(playsTable)
          .where(eq(playsTable.clientId, c.id));
        const [contactsResult] = await db
          .select({ count: sql<number>`count(*)::int` })
          .from(contactsTable)
          .where(eq(contactsTable.clientId, c.id));
        return {
          ...c,
          playsCount: playsResult?.count ?? 0,
          contactsCount: contactsResult?.count ?? 0,
        };
      }),
    );
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.post("/clients", async (req, res, next): Promise<void> => {
  const parsed = CreateClientBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  try {
    const user = req.user as any;
    const [client] = await db
      .insert(clientsTable)
      .values({ ...parsed.data, tenantId: user.tenantId })
      .returning();
    res.status(201).json({ ...client, playsCount: 0, contactsCount: 0 });
  } catch (err) {
    next(err);
  }
});

router.get("/clients/:id/journeys", async (req, res, next): Promise<void> => {
  try {
    const user = req.user as any;
    const clientId = parseInt(req.params.id);
    if (isNaN(clientId)) { res.status(400).json({ error: "Invalid id" }); return; }
    // Enforce tenant ownership of the client before exposing related journeys
    const [client] = await db
      .select({ tenantId: clientsTable.tenantId })
      .from(clientsTable)
      .where(eq(clientsTable.id, clientId));
    if (!client || client.tenantId !== user.tenantId) {
      res.status(404).json({ error: "Client not found" });
      return;
    }
    const result = await db.execute(sql`
      SELECT DISTINCT
        j.id, j.name, j.slug, j.status, j.theme,
        j.created_at AS "createdAt",
        p.id   AS "playId",
        p.name AS "playName"
      FROM journeys j
      JOIN journey_plays jp ON jp.journey_id = j.id
      JOIN abm_plays p      ON p.id = jp.play_id
      WHERE p.client_id = ${clientId}
        AND j.tenant_id = ${user.tenantId}
        AND p.tenant_id = ${user.tenantId}
      ORDER BY j.created_at DESC
    `);
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

router.get("/clients/:id", async (req, res, next): Promise<void> => {
  const params = GetClientParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  try {
    const user = req.user as any;
    const [client] = await db
      .select()
      .from(clientsTable)
      .where(eq(clientsTable.id, params.data.id));
    if (!client || client.tenantId !== user.tenantId) {
      res.status(404).json({ error: "Client not found" });
      return;
    }
    const [playsResult] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(playsTable)
      .where(eq(playsTable.clientId, client.id));
    const [contactsResult] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(contactsTable)
      .where(eq(contactsTable.clientId, client.id));
    res.json({
      ...client,
      playsCount: playsResult?.count ?? 0,
      contactsCount: contactsResult?.count ?? 0,
    });
  } catch (err) {
    next(err);
  }
});

router.patch("/clients/:id", async (req, res, next): Promise<void> => {
  const params = UpdateClientParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = UpdateClientBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  try {
    const user = req.user as any;
    const [existing] = await db
      .select()
      .from(clientsTable)
      .where(eq(clientsTable.id, params.data.id));
    if (!existing || existing.tenantId !== user.tenantId) {
      res.status(404).json({ error: "Client not found" });
      return;
    }
    const [client] = await db
      .update(clientsTable)
      .set(parsed.data)
      .where(eq(clientsTable.id, params.data.id))
      .returning();
    res.json({ ...client, playsCount: 0, contactsCount: 0 });
  } catch (err) {
    next(err);
  }
});

router.delete("/clients/:id", async (req, res, next): Promise<void> => {
  const params = DeleteClientParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  try {
    const user = req.user as any;
    const [existing] = await db
      .select()
      .from(clientsTable)
      .where(eq(clientsTable.id, params.data.id));
    if (!existing || existing.tenantId !== user.tenantId) {
      res.status(404).json({ error: "Client not found" });
      return;
    }
    await db.delete(clientsTable).where(eq(clientsTable.id, params.data.id));
    res.sendStatus(204);
  } catch (err) {
    next(err);
  }
});

export default router;
