import { Router, type IRouter } from "express";
import { and, eq } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { db, playsTable, clientsTable, journeysTable } from "@workspace/db";
import { requireAuth } from "../middlewares/requireAuth";
import { enrichJourney } from "./journeys";
import { enqueueStep, isTenantQueueAvailable } from "../services/queue";
import { processInlineEnrollments } from "../services/runEnrollmentService";
import { logger } from "../lib/logger";
import {
  CreatePlayBody,
  UpdatePlayBody,
  GetPlayParams,
  UpdatePlayParams,
  DeletePlayParams,
  ListPlaysQueryParams,
  DuplicatePlayParams,
} from "@workspace/api-zod";
import { z } from "zod";

const router: IRouter = Router();
router.use(requireAuth);

async function enrichPlay(play: typeof playsTable.$inferSelect) {
  const [client] = await db
    .select({ name: clientsTable.name, logoUrl: clientsTable.logoUrl })
    .from(clientsTable)
    .where(eq(clientsTable.id, play.clientId));
  const countResult = await db.execute(sql`
    SELECT COUNT(*)::int AS count
    FROM journey_plays jpl
    JOIN journeys j ON j.id = jpl.journey_id
    WHERE jpl.play_id = ${play.id}
      AND j.tenant_id = ${play.tenantId}
      AND j.client_id = ${play.clientId}
  `);
  const linkedJourneysCount = (countResult.rows[0] as { count: number } | undefined)?.count ?? 0;
  return {
    ...play,
    clientName: client?.name ?? null,
    clientLogoUrl: client?.logoUrl ?? null,
    linkedJourneysCount,
  };
}

router.get("/plays", async (req, res, next): Promise<void> => {
  const qp = ListPlaysQueryParams.safeParse(req.query);
  try {
    const user = req.user as any;
    const plays = await db.select().from(playsTable).where(
      and(
        eq(playsTable.tenantId, user.tenantId),
        qp.success && qp.data.clientId ? eq(playsTable.clientId, qp.data.clientId) : undefined,
        qp.success && qp.data.status ? eq(playsTable.status, qp.data.status) : undefined,
      ),
    );
    const result = await Promise.all(plays.map(enrichPlay));
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.post("/plays", async (req, res, next): Promise<void> => {
  const parsed = CreatePlayBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  try {
    const user = req.user as any;
    const [play] = await db
      .insert(playsTable)
      .values({
        ...parsed.data,
        tenantId: user.tenantId,
        status: parsed.data.status ?? "draft",
        createdBy: user.id,
      })
      .returning();
    res.status(201).json(await enrichPlay(play));
  } catch (err) {
    next(err);
  }
});

router.post("/plays/:id/duplicate", async (req, res, next): Promise<void> => {
  const params = DuplicatePlayParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  try {
    const user = req.user as any;
    const [existing] = await db.select().from(playsTable).where(eq(playsTable.id, params.data.id));
    if (!existing || existing.tenantId !== user.tenantId) {
      res.status(404).json({ error: "Play not found" });
      return;
    }
    const { id, createdAt, updatedAt, ...rest } = existing;
    const [play] = await db
      .insert(playsTable)
      .values({ ...rest, name: `${existing.name} (Copy)`, status: "draft", createdBy: user.id })
      .returning();
    res.status(201).json(await enrichPlay(play));
  } catch (err) {
    next(err);
  }
});

router.get("/plays/:id", async (req, res, next): Promise<void> => {
  const params = GetPlayParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  try {
    const user = req.user as any;
    const [play] = await db.select().from(playsTable).where(eq(playsTable.id, params.data.id));
    if (!play || play.tenantId !== user.tenantId) {
      res.status(404).json({ error: "Play not found" });
      return;
    }
    res.json(await enrichPlay(play));
  } catch (err) {
    next(err);
  }
});

router.get("/plays/:id/journeys", async (req, res, next): Promise<void> => {
  const params = GetPlayParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  try {
    const user = req.user as any;
    const [play] = await db.select().from(playsTable).where(eq(playsTable.id, params.data.id));
    if (!play || play.tenantId !== user.tenantId) {
      res.status(404).json({ error: "Play not found" });
      return;
    }
    const result = await db.execute(sql`
      SELECT
        j.id,
        j.name,
        j.status,
        j.slug,
        c.name AS client_name,
        COUNT(DISTINCT jp2.id)::int AS page_count,
        COALESCE(SUM(jp2.view_count), 0)::int AS total_views
      FROM journey_plays jpl
      JOIN journeys j ON j.id = jpl.journey_id
      LEFT JOIN clients c ON c.id = j.client_id
      LEFT JOIN journey_pages jp2 ON jp2.journey_id = j.id
      WHERE jpl.play_id = ${params.data.id}
        AND j.tenant_id = ${user.tenantId}
      GROUP BY j.id, j.name, j.status, j.slug, c.name
      ORDER BY j.name ASC
    `);
    type Row = { id: number; name: string; status: string; slug: string; client_name: string | null; page_count: number; total_views: number };
    const journeys = (result.rows as Row[]).map(r => ({
      id: r.id,
      name: r.name,
      status: r.status,
      slug: r.slug,
      clientName: r.client_name,
      pageCount: r.page_count,
      totalViews: r.total_views,
    }));
    res.json(journeys);
  } catch (err) {
    next(err);
  }
});

const CreateAndLinkJourneyBody = z.object({
  name: z.string().min(1),
  status: z.enum(["draft", "published", "archived"]).optional(),
});

router.post("/plays/:id/journeys", async (req, res, next): Promise<void> => {
  const params = GetPlayParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = CreateAndLinkJourneyBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  try {
    const user = req.user as any;
    const [play] = await db.select().from(playsTable).where(eq(playsTable.id, params.data.id));
    if (!play || play.tenantId !== user.tenantId) {
      res.status(404).json({ error: "Play not found" });
      return;
    }
    const slug = parsed.data.name.toLowerCase().replace(/[^a-z0-9]+/g, "-") + "-" + Date.now();
    const journey = await db.transaction(async (tx) => {
      const [newJourney] = await tx
        .insert(journeysTable)
        .values({
          name: parsed.data.name,
          clientId: play.clientId,
          tenantId: user.tenantId,
          slug,
          status: parsed.data.status ?? "draft",
        })
        .returning();
      await tx.execute(sql`
        INSERT INTO journey_plays (journey_id, play_id)
        VALUES (${newJourney.id}, ${params.data.id})
      `);
      return newJourney;
    });
    const enriched = await enrichJourney(journey);
    res.status(201).json(enriched);
  } catch (err) {
    next(err);
  }
});

router.patch("/plays/:id", async (req, res, next): Promise<void> => {
  const params = UpdatePlayParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = UpdatePlayBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  try {
    const user = req.user as any;
    const [existing] = await db.select().from(playsTable).where(eq(playsTable.id, params.data.id));
    if (!existing || existing.tenantId !== user.tenantId) {
      res.status(404).json({ error: "Play not found" });
      return;
    }
    const [play] = await db
      .update(playsTable)
      .set(parsed.data)
      .where(eq(playsTable.id, params.data.id))
      .returning();
    res.json(await enrichPlay(play));
  } catch (err) {
    next(err);
  }
});

// ── Play Contacts ─────────────────────────────────────────────────────────────

router.get("/plays/:id/contacts", async (req, res, next): Promise<void> => {
  const params = GetPlayParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  try {
    const user = req.user as any;
    const [play] = await db.select().from(playsTable).where(eq(playsTable.id, params.data.id));
    if (!play || play.tenantId !== user.tenantId) { res.status(404).json({ error: "Play not found" }); return; }
    const rows = await db.execute(sql`
      SELECT c.id, c.first_name AS "firstName", c.last_name AS "lastName",
             c.email, c.title, c.lead_score AS "leadScore", c.stage, c.status, c.tags,
             pc.enrolled_at AS "enrolledAt"
      FROM play_contacts pc
      JOIN contacts c ON c.id = pc.contact_id AND c.tenant_id = ${user.tenantId}
      WHERE pc.play_id = ${params.data.id} AND pc.tenant_id = ${user.tenantId}
      ORDER BY c.lead_score DESC, pc.enrolled_at DESC
    `);
    res.json(rows.rows);
  } catch (err) { next(err); }
});

const BulkEnrollBody = z.object({ contactIds: z.array(z.number().int().positive()).min(1) });

router.post("/plays/:id/contacts", async (req, res, next): Promise<void> => {
  const params = GetPlayParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const parsed = BulkEnrollBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  try {
    const user = req.user as any;
    const [play] = await db.select().from(playsTable).where(eq(playsTable.id, params.data.id));
    if (!play || play.tenantId !== user.tenantId) { res.status(404).json({ error: "Play not found" }); return; }

    const { contactIds } = parsed.data;
    const contactIdsArr = sql`ARRAY[${sql.join(contactIds.map(id => sql`${id}`), sql`, `)}]::int[]`;

    // Count how many of the requested contacts are DNC so we can report the skip.
    const dncCountResult = await db.execute(sql`
      SELECT COUNT(*)::int AS cnt
      FROM contacts c
      WHERE c.id = ANY(${contactIdsArr})
        AND c.tenant_id = ${user.tenantId}
        AND c.client_id = ${play.clientId}
        AND c.dnc = true
    `);
    const dncSkipped: number = (dncCountResult.rows[0] as any)?.cnt ?? 0;

    // Insert only contacts that belong to this tenant AND this play's client,
    // and that are not on the DNC list.
    // The SELECT enforces tenant/client scoping server-side, so crafted requests
    // cannot enroll contacts from another tenant or a different client.
    await db.execute(sql`
      INSERT INTO play_contacts (tenant_id, play_id, contact_id, enrolled_by)
      SELECT ${user.tenantId}, ${params.data.id}, c.id, ${user.id}
      FROM contacts c
      WHERE c.id = ANY(${contactIdsArr})
        AND c.tenant_id = ${user.tenantId}
        AND c.client_id = ${play.clientId}
        AND c.dnc = false
      ON CONFLICT (play_id, contact_id) DO NOTHING
    `);

    // Recount and update contacts_enrolled
    await db.execute(sql`
      UPDATE abm_plays
      SET contacts_enrolled = (
        SELECT count(*)::int FROM play_contacts WHERE play_id = ${params.data.id}
      )
      WHERE id = ${params.data.id}
    `);

    // Auto-enroll newly added contacts into the play's linked active sequence.
    // The play↔sequence link is stored as email_sequences.play_id.
    // We pick the most recently-updated active sequence for this play.
    let enrolled = 0;
    try {
      // Pick the most recently-updated non-archived sequence linked to this
      // play. We accept 'draft' as well as 'active' because adding contacts to
      // a play is itself an explicit signal the user wants the sequence to run.
      const seqResult = await db.execute(sql`
        SELECT id FROM email_sequences
        WHERE play_id = ${params.data.id}
          AND tenant_id = ${user.tenantId}
          AND status IN ('active', 'draft')
        ORDER BY (status = 'active') DESC, updated_at DESC
        LIMIT 1
      `);
      const seq = (seqResult.rows as any[])[0];
      if (seq) {
        const stepResult = await db.execute(sql`
          SELECT id FROM sequence_steps
          WHERE sequence_id = ${seq.id}
          ORDER BY step_order ASC
          LIMIT 1
        `);
        const firstStep = (stepResult.rows as any[])[0];

        // Only enroll contacts we just inserted into play_contacts (and that
        // are not already enrolled in this sequence).
        const newEnrolls = await db.execute(sql`
          INSERT INTO sequence_enrollments (sequence_id, contact_id, status, current_step_id, enrolled_at)
          SELECT ${seq.id}, pc.contact_id, 'active', ${firstStep?.id ?? null}, NOW()
          FROM play_contacts pc
          WHERE pc.play_id = ${params.data.id}
            AND pc.tenant_id = ${user.tenantId}
            AND pc.contact_id = ANY(${sql`ARRAY[${sql.join(contactIds.map(id => sql`${id}`), sql`, `)}]::int[]`})
          ON CONFLICT (sequence_id, contact_id) WHERE status = 'active' DO NOTHING
          RETURNING id, contact_id
        `);
        const rows = newEnrolls.rows as any[];
        enrolled = rows.length;

        if (rows.length > 0) {
          const queueOk = await isTenantQueueAvailable(user.tenantId);
          const fallbackRefs: { enrollmentId: number; contactId: number }[] = [];
          if (queueOk && firstStep) {
            for (const r of rows) {
              try {
                await enqueueStep({
                  enrollmentId: r.id,
                  stepId: firstStep.id,
                  sequenceId: seq.id,
                  contactId: r.contact_id,
                  tenantId: user.tenantId,
                });
              } catch (e) {
                logger.warn({ err: e, enrollmentId: r.id }, "enqueueStep failed — falling back to inline");
                fallbackRefs.push({ enrollmentId: r.id, contactId: r.contact_id });
              }
            }
          } else {
            // No Redis/queue available — process all inline.
            for (const r of rows) {
              fallbackRefs.push({ enrollmentId: r.id, contactId: r.contact_id });
            }
          }
          if (fallbackRefs.length > 0) {
            // Fire-and-forget so the HTTP response isn't blocked by SMTP latency.
            processInlineEnrollments(seq.id, user.tenantId, fallbackRefs).catch(err =>
              logger.error({ err, sequenceId: seq.id }, "Inline enrollment processing failed")
            );
          }
        }
      }
    } catch (e) {
      logger.error({ err: e, playId: params.data.id }, "Auto-enrollment into play's sequence failed");
    }

    res.json({ ok: true, autoEnrolled: enrolled, dncSkipped });
  } catch (err) { next(err); }
});

router.delete("/plays/:id/contacts/:contactId", async (req, res, next): Promise<void> => {
  const params = z.object({ id: z.coerce.number().int().positive(), contactId: z.coerce.number().int().positive() }).safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  try {
    const user = req.user as any;
    const [play] = await db.select().from(playsTable).where(eq(playsTable.id, params.data.id));
    if (!play || play.tenantId !== user.tenantId) { res.status(404).json({ error: "Play not found" }); return; }

    await db.execute(sql`
      DELETE FROM play_contacts
      WHERE play_id = ${params.data.id} AND contact_id = ${params.data.contactId} AND tenant_id = ${user.tenantId}
    `);

    // Recount and update contacts_enrolled
    await db.execute(sql`
      UPDATE abm_plays
      SET contacts_enrolled = (
        SELECT count(*)::int FROM play_contacts WHERE play_id = ${params.data.id}
      )
      WHERE id = ${params.data.id}
    `);

    res.sendStatus(204);
  } catch (err) { next(err); }
});

router.delete("/plays/:id", async (req, res, next): Promise<void> => {
  const params = DeletePlayParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  try {
    const user = req.user as any;
    const [existing] = await db.select().from(playsTable).where(eq(playsTable.id, params.data.id));
    if (!existing || existing.tenantId !== user.tenantId) {
      res.status(404).json({ error: "Play not found" });
      return;
    }
    await db.delete(playsTable).where(eq(playsTable.id, params.data.id));
    res.sendStatus(204);
  } catch (err) {
    next(err);
  }
});

export default router;
