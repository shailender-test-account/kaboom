import { Router, type IRouter } from "express";
import { and, eq, desc, asc, sql } from "drizzle-orm";
import { db, pool, emailSequencesTable, sequenceStepsTable, sequenceEnrollmentsTable, contactsTable, playsTable } from "@workspace/db";
import { requireAuth } from "../middlewares/requireAuth";
import { permittedClientIds, clientScopeSql } from "../lib/requestClientScope";
import { enqueueStep } from "../services/queue";
import { z } from "zod";
import { hpContactMayNurture, WARM_ONLY_ROUTING_MESSAGE } from "../lib/hpNurturePolicy";

const router: IRouter = Router();
router.use(requireAuth);

const CreateBody = z.object({
  name: z.string().min(1),
  playId: z.number().int().nullable().optional(),
  status: z.enum(["draft", "active", "paused"]).default("draft"),
  triggerType: z.string().default("MANUAL"),
  triggerConfig: z.record(z.unknown()).default({}),
  nodesJson: z.record(z.unknown()).default({ nodes: [], edges: [] }),
  senderEmail: z.string().nullable().optional(),
  senderName: z.string().nullable().optional(),
});
const UpdateBody = CreateBody.partial().extend({
  smtpAccountId: z.number().int().nullable().optional(),
  smtpRotationMode: z.enum(["round_robin"]).nullable().optional(),
});

const EnrollBody = z.object({ contactId: z.number().int() });
const BulkEnrollBody = z.object({
  contactIds: z.array(z.number().int()).min(1),
  reEnrollCompleted: z.boolean().default(false),
});

router.get("/email-sequences", async (req, res, next): Promise<void> => {
  try {
    const user = req.user as any;
    const seqs = await db.select().from(emailSequencesTable)
      .where(and(eq(emailSequencesTable.tenantId, user.tenantId),
        permittedClientIds(req) === null ? undefined :
          clientScopeSql(sql`COALESCE(email_sequences.client_id,(SELECT p.client_id FROM abm_plays p
            WHERE p.id=${emailSequencesTable.playId} AND p.tenant_id=${user.tenantId}))`, permittedClientIds(req))))
      .orderBy(desc(emailSequencesTable.createdAt));
    const result = await Promise.all(seqs.map(async s => {
      const steps = await db.select({ id: sequenceStepsTable.id }).from(sequenceStepsTable).where(eq(sequenceStepsTable.sequenceId, s.id));
      const enrollments = await db.select({ id: sequenceEnrollmentsTable.id, contactId: sequenceEnrollmentsTable.contactId }).from(sequenceEnrollmentsTable).where(eq(sequenceEnrollmentsTable.sequenceId, s.id));
      const enrolledCount = enrollments.length;
      const contactCount = new Set(enrollments.map(e => e.contactId)).size;
      let playName: string | null = null;
      if (s.playId) {
        const [play] = await db.select({ name: playsTable.name }).from(playsTable).where(eq(playsTable.id, s.playId));
        playName = play?.name ?? null;
      }
      return { ...s, stepCount: steps.length, enrolledCount, contactCount, playName };
    }));
    res.json(result);
  } catch (err) { next(err); }
});

router.post("/email-sequences", async (req, res, next): Promise<void> => {
  const parsed = CreateBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  try {
    const user = req.user as any;
    const [seq] = await db.insert(emailSequencesTable)
      .values({ ...parsed.data, tenantId: user.tenantId })
      .returning();
    res.status(201).json({ ...seq, stepCount: 0, enrolledCount: 0, playName: null });
  } catch (err) { next(err); }
});

router.get("/email-sequences/:id", async (req, res, next): Promise<void> => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  try {
    const user = req.user as any;
    const [seq] = await db.select().from(emailSequencesTable).where(eq(emailSequencesTable.id, id));
    if (!seq || seq.tenantId !== user.tenantId) { res.status(404).json({ error: "Not found" }); return; }
    const steps = await db.select().from(sequenceStepsTable).where(eq(sequenceStepsTable.sequenceId, id)).orderBy(asc(sequenceStepsTable.stepOrder));
    const enrollments = await db.select().from(sequenceEnrollmentsTable).where(eq(sequenceEnrollmentsTable.sequenceId, id));
    const { rows: smtpRows } = await pool.query<{ smtp_account_id: number | null; smtp_rotation_mode: string | null }>(
      `SELECT smtp_account_id, smtp_rotation_mode FROM email_sequences WHERE id = $1`, [id]
    );
    res.json({ ...seq, steps, enrolledCount: enrollments.length, smtpAccountId: smtpRows[0]?.smtp_account_id ?? null, smtpRotationMode: smtpRows[0]?.smtp_rotation_mode ?? null });
  } catch (err) { next(err); }
});

router.patch("/email-sequences/:id", async (req, res, next): Promise<void> => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const parsed = UpdateBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  try {
    const user = req.user as any;
    const [existing] = await db.select().from(emailSequencesTable).where(eq(emailSequencesTable.id, id));
    if (!existing || existing.tenantId !== user.tenantId) { res.status(404).json({ error: "Not found" }); return; }

    // Extract raw-SQL columns (not in Drizzle schema) before passing to Drizzle
    const { smtpAccountId, smtpRotationMode, ...drizzleFields } = parsed.data;

    // Tenant-ownership check: ensure the SMTP account (if provided) belongs to this tenant
    if (smtpAccountId != null) {
      const { rows: smtpCheck } = await pool.query(
        `SELECT id FROM smtp_accounts WHERE id = $1 AND tenant_id = $2`,
        [smtpAccountId, user.tenantId]
      );
      if (!smtpCheck.length) { res.status(400).json({ error: "SMTP account not found or not accessible" }); return; }
    }

    const [seq] = await db.update(emailSequencesTable).set(drizzleFields).where(eq(emailSequencesTable.id, id)).returning();

    // Persist smtp_account_id and smtp_rotation_mode if provided (raw SQL — columns live outside Drizzle schema)
    if (smtpAccountId !== undefined || smtpRotationMode !== undefined) {
      const sets: string[] = [];
      const vals: any[] = [];
      if (smtpAccountId !== undefined) { sets.push(`smtp_account_id = $${vals.length + 1}`); vals.push(smtpAccountId); }
      if (smtpRotationMode !== undefined) { sets.push(`smtp_rotation_mode = $${vals.length + 1}`); vals.push(smtpRotationMode); }
      vals.push(id);
      await pool.query(`UPDATE email_sequences SET ${sets.join(", ")} WHERE id = $${vals.length}`, vals);
    }

    // Return the full row including smtp_account_id and smtp_rotation_mode
    const { rows } = await pool.query<{ smtp_account_id: number | null; smtp_rotation_mode: string | null }>(
      `SELECT smtp_account_id, smtp_rotation_mode FROM email_sequences WHERE id = $1`,
      [id]
    );
    res.json({ ...seq, smtpAccountId: rows[0]?.smtp_account_id ?? null, smtpRotationMode: rows[0]?.smtp_rotation_mode ?? null });
  } catch (err) { next(err); }
});

router.delete("/email-sequences/:id", async (req, res, next): Promise<void> => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  try {
    const user = req.user as any;
    const [existing] = await db.select().from(emailSequencesTable).where(eq(emailSequencesTable.id, id));
    if (!existing || existing.tenantId !== user.tenantId) { res.status(404).json({ error: "Not found" }); return; }
    await db.delete(emailSequencesTable).where(eq(emailSequencesTable.id, id));
    res.sendStatus(204);
  } catch (err) { next(err); }
});

router.post("/email-sequences/:id/publish", async (req, res, next): Promise<void> => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  try {
    const user = req.user as any;
    const [existing] = await db.select().from(emailSequencesTable).where(eq(emailSequencesTable.id, id));
    if (!existing || existing.tenantId !== user.tenantId) { res.status(404).json({ error: "Not found" }); return; }

    const nodesJson = existing.nodesJson as { nodes: any[]; edges: any[] };
    const nodes = nodesJson?.nodes ?? [];
    const edges = nodesJson?.edges ?? [];

    await db.delete(sequenceStepsTable).where(eq(sequenceStepsTable.sequenceId, id));

    const stepNodes = nodes.filter((n: any) => n.type !== "trigger");
    const orderedNodes = stepNodes.sort((a: any, b: any) => (a.position?.y ?? 0) - (b.position?.y ?? 0));

    const insertedSteps: any[] = [];
    for (let i = 0; i < orderedNodes.length; i++) {
      const node = orderedNodes[i];
      const [step] = await db.insert(sequenceStepsTable).values({
        sequenceId: id,
        stepOrder: i,
        stepType: node.type,
        config: node.data ?? {},
        waitDuration: node.data?.duration ?? null,
        waitUnit: node.data?.unit ?? null,
        nodeId: node.id,
      }).returning();
      insertedSteps.push({ ...step, nodeId: node.id });
    }

    for (const step of insertedSteps) {
      const outEdges = edges.filter((e: any) => e.source === step.nodeId);
      if (outEdges.length === 2) {
        const trueEdge = outEdges.find((e: any) => e.sourceHandle === "true" || e.label === "Yes");
        const falseEdge = outEdges.find((e: any) => e.sourceHandle === "false" || e.label === "No");
        const trueTarget = insertedSteps.find(s => s.nodeId === trueEdge?.target);
        const falseTarget = insertedSteps.find(s => s.nodeId === falseEdge?.target);
        if (trueTarget || falseTarget) {
          await db.update(sequenceStepsTable)
            .set({ trueNextStepId: trueTarget?.id ?? null, falseNextStepId: falseTarget?.id ?? null })
            .where(eq(sequenceStepsTable.id, step.id));
        }
      }
    }

    const [seq] = await db.update(emailSequencesTable).set({ status: "active" }).where(eq(emailSequencesTable.id, id)).returning();
    res.json(seq);
  } catch (err) { next(err); }
});

router.post("/email-sequences/:id/enroll", async (req, res, next): Promise<void> => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const parsed = EnrollBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  try {
    const user = req.user as any;
    const [seq] = await db.select().from(emailSequencesTable).where(eq(emailSequencesTable.id, id));
    if (!seq || seq.tenantId !== user.tenantId) { res.status(404).json({ error: "Not found" }); return; }
    const [contact] = await db.select().from(contactsTable).where(
      and(eq(contactsTable.id, parsed.data.contactId), eq(contactsTable.tenantId, user.tenantId))
    );
    if (!contact) { res.status(404).json({ error: "Contact not found" }); return; }
    if (contact.dnc) { res.status(422).json({ error: "This contact is on the DNC list" }); return; }
    if(contact.clientId && !await hpContactMayNurture(user.tenantId,contact.clientId,contact.id)) {
      res.status(409).json({error:WARM_ONLY_ROUTING_MESSAGE});return;
    }

    // Block re-enrollment if contact already has an active enrollment
    const [activeEnrollment] = await db.select({ id: sequenceEnrollmentsTable.id })
      .from(sequenceEnrollmentsTable)
      .where(and(
        eq(sequenceEnrollmentsTable.sequenceId, id),
        eq(sequenceEnrollmentsTable.contactId, parsed.data.contactId),
        eq(sequenceEnrollmentsTable.status, "active"),
      ))
      .limit(1);
    if (activeEnrollment) {
      res.status(409).json({ error: "Contact already has an active enrollment in this sequence" });
      return;
    }

    const firstStep = await db.select().from(sequenceStepsTable)
      .where(eq(sequenceStepsTable.sequenceId, id))
      .orderBy(asc(sequenceStepsTable.stepOrder))
      .limit(1);

    const [enrollment] = await db.insert(sequenceEnrollmentsTable).values({
      sequenceId: id,
      contactId: parsed.data.contactId,
      status: "active",
      currentStepId: firstStep[0]?.id ?? null,
    }).returning();

    if (firstStep[0]) {
      await enqueueStep({
        enrollmentId: enrollment.id,
        stepId: firstStep[0].id,
        sequenceId: id,
        contactId: parsed.data.contactId,
        tenantId: user.tenantId,
      });
    }

    res.status(201).json(enrollment);
  } catch (err) { next(err); }
});

router.post("/email-sequences/:id/bulk-enroll", async (req, res, next): Promise<void> => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const parsed = BulkEnrollBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  try {
    const user = req.user as any;
    const [seq] = await db.select().from(emailSequencesTable).where(eq(emailSequencesTable.id, id));
    if (!seq || seq.tenantId !== user.tenantId) { res.status(404).json({ error: "Not found" }); return; }
    // Preflight the complete selection before enrolling anyone: no partial
    // batch may start outreach before a Hot or Cold HP contact is rejected.
    const selection = await pool.query(`SELECT id,client_id FROM contacts
      WHERE tenant_id=$1 AND id=ANY($2::int[])`,[user.tenantId,parsed.data.contactIds]);
    for(const person of selection.rows) if(person.client_id
      && !await hpContactMayNurture(user.tenantId,Number(person.client_id),Number(person.id))) {
      res.status(409).json({error:WARM_ONLY_ROUTING_MESSAGE});return;
    }

    const existingEnrollments = await db
      .select({ contactId: sequenceEnrollmentsTable.contactId, status: sequenceEnrollmentsTable.status })
      .from(sequenceEnrollmentsTable)
      .where(eq(sequenceEnrollmentsTable.sequenceId, id));

    // Separate active enrollments (hard block) from completed ones (soft block,
    // can be overridden with reEnrollCompleted=true)
    const activeIds = new Set(
      existingEnrollments.filter(e => e.status === "active").map(e => e.contactId)
    );
    const completedIds = new Set(
      existingEnrollments.filter(e => e.status === "completed").map(e => e.contactId)
    );

    const firstStep = await db.select().from(sequenceStepsTable)
      .where(eq(sequenceStepsTable.sequenceId, id))
      .orderBy(asc(sequenceStepsTable.stepOrder))
      .limit(1);

    const uniqueContactIds = [...new Set(parsed.data.contactIds)];
    const { reEnrollCompleted } = parsed.data;

    let enrolled = 0;
    let alreadyActive = 0;
    let skippedCompleted = 0;
    let notFound = 0;
    let skippedDnc = 0;

    for (const contactId of uniqueContactIds) {
      // Always skip contacts with an active enrollment
      if (activeIds.has(contactId)) { alreadyActive++; continue; }
      // Skip contacts who already completed, unless re-enroll is requested
      if (completedIds.has(contactId) && !reEnrollCompleted) { skippedCompleted++; continue; }

      const [contact] = await db.select({ id: contactsTable.id, dnc: contactsTable.dnc }).from(contactsTable).where(
        and(eq(contactsTable.id, contactId), eq(contactsTable.tenantId, user.tenantId))
      );
      if (!contact) { notFound++; continue; }
      if (contact.dnc) { skippedDnc++; continue; }

      const [enrollment] = await db.insert(sequenceEnrollmentsTable).values({
        sequenceId: id,
        contactId,
        status: "active",
        currentStepId: firstStep[0]?.id ?? null,
      }).returning();

      if (firstStep[0]) {
        await enqueueStep({
          enrollmentId: enrollment.id,
          stepId: firstStep[0].id,
          sequenceId: id,
          contactId,
          tenantId: user.tenantId,
        });
      }
      enrolled++;
    }

    res.json({
      enrolled,
      alreadyActive,
      skippedCompleted,
      notFound,
      skippedDnc,
      // Keep for backward compatibility with older clients
      alreadyEnrolled: alreadyActive + skippedCompleted,
    });
  } catch (err) { next(err); }
});

router.get("/email-sequences/:id/enrollments", async (req, res, next): Promise<void> => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  try {
    const user = req.user as any;
    const [seq] = await db.select().from(emailSequencesTable).where(eq(emailSequencesTable.id, id));
    if (!seq || seq.tenantId !== user.tenantId) { res.status(404).json({ error: "Not found" }); return; }

    const { rows } = await pool.query<{
      id: number; sequence_id: number; contact_id: number; status: string;
      current_step_id: number | null; enrolled_at: string | null; completed_at: string | null;
      first_name: string | null; last_name: string | null; email: string | null; lead_score: number | null;
      re_enrollment_number: number;
    }>(
      `SELECT se.id, se.sequence_id, se.contact_id, se.status,
              se.current_step_id, se.enrolled_at, se.completed_at,
              c.first_name, c.last_name, c.email, c.lead_score,
              ROW_NUMBER() OVER (PARTITION BY se.contact_id ORDER BY se.enrolled_at ASC)::int AS re_enrollment_number
       FROM sequence_enrollments se
       LEFT JOIN contacts c ON c.id = se.contact_id
       WHERE se.sequence_id = $1
       ORDER BY se.enrolled_at DESC`,
      [id]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

/**
 * GET /api/email-sequences/:id/canvas-stats
 * Aggregate open/click/sent counts per email node in the canvas, derived from
 * email_events. Uses metadata.stepId when present (events written by the
 * sequence worker) and falls back to template_id + contact_id matched against
 * this sequence's enrollments (webhook-delivered open/click events).
 */
router.get("/email-sequences/:id/canvas-stats", async (req, res, next): Promise<void> => {
  const seqId = parseInt(req.params.id);
  if (isNaN(seqId)) { res.status(400).json({ error: "Invalid id" }); return; }
  try {
    const user = req.user as any;
    const [seq] = await db.select().from(emailSequencesTable).where(eq(emailSequencesTable.id, seqId));
    if (!seq || seq.tenantId !== user.tenantId) { res.status(404).json({ error: "Not found" }); return; }

    const nodesJson = (typeof seq.nodesJson === "string" ? JSON.parse(seq.nodesJson) : (seq.nodesJson ?? {})) as { nodes?: any[] };
    const allNodes = nodesJson.nodes ?? [];
    const emailNodes = allNodes
      .filter((n: any) => n.type === "email")
      .map((n: any) => ({ stepId: String(n.id), templateId: n.data?.templateId ? Number(n.data.templateId) : null }));

    const result: Record<string, { sent: number; opens: number; clicks: number; openRate: number; clickRate: number }> = {};
    for (const en of emailNodes) result[en.stepId] = { sent: 0, opens: 0, clicks: 0, openRate: 0, clickRate: 0 };

    // The sequence worker writes `metadata.stepId` as the numeric DB
    // `sequence_steps.id` — not the canvas node id. Build a map from
    // DB step id → canvas node id so we can attribute events back.
    const dbSteps = await db
      .select({ id: sequenceStepsTable.id, nodeId: sequenceStepsTable.nodeId })
      .from(sequenceStepsTable)
      .where(eq(sequenceStepsTable.sequenceId, seqId));
    const dbStepToNodeId: Record<string, string> = {};
    for (const s of dbSteps) {
      if (s.nodeId) dbStepToNodeId[String(s.id)] = s.nodeId;
    }

    // 1. Primary: events written by the worker carry metadata.stepId
    //    (numeric DB sequence_steps.id). Map back to canvas node id via
    //    dbStepToNodeId, scoped to enrollments of this sequence.
    const { rows: primary } = await pool.query<{
      step_id: string; event_type: string; cnt: number;
    }>(
      `SELECT metadata->>'stepId' AS step_id, event_type, COUNT(*)::int AS cnt
       FROM email_events
       WHERE tenant_id = $1
         AND metadata->>'stepId' IS NOT NULL
         AND (metadata->>'enrollmentId')::int IN (
           SELECT id FROM sequence_enrollments WHERE sequence_id = $2
         )
       GROUP BY 1, 2`,
      [seq.tenantId, seqId]
    );
    for (const r of primary) {
      const nodeId = dbStepToNodeId[r.step_id] ?? r.step_id;
      const bucket = result[nodeId];
      if (!bucket) continue;
      if (r.event_type === "sent") bucket.sent += r.cnt;
      else if (r.event_type === "opened") bucket.opens += r.cnt;
      else if (r.event_type === "clicked") bucket.clicks += r.cnt;
    }

    // 2. Fallback: webhook open/click events that arrived without a stepId
    //    (filtered by `metadata->>'stepId' IS NULL` so they are disjoint
    //    from the primary set and never double-counted). Attribute by
    //    template_id + contact enrolled in this sequence; if multiple
    //    email nodes share the same templateId, split evenly.
    const templateIds = [...new Set(emailNodes.map(n => n.templateId).filter((x): x is number => !!x))];
    if (templateIds.length > 0) {
      const { rows: fallback } = await pool.query<{ template_id: number; event_type: string; cnt: number }>(
        `SELECT template_id, event_type, COUNT(*)::int AS cnt
         FROM email_events
         WHERE tenant_id = $1
           AND event_type IN ('opened', 'clicked')
           AND (metadata->>'stepId') IS NULL
           AND template_id = ANY($2::int[])
           AND contact_id IN (
             SELECT contact_id FROM sequence_enrollments WHERE sequence_id = $3
           )
         GROUP BY 1, 2`,
        [seq.tenantId, templateIds, seqId]
      );
      for (const r of fallback) {
        const matchingNodes = emailNodes.filter(n => n.templateId === r.template_id);
        if (matchingNodes.length === 0) continue;
        const share = r.cnt / matchingNodes.length;
        for (const n of matchingNodes) {
          const bucket = result[n.stepId];
          if (!bucket) continue;
          if (r.event_type === "opened") bucket.opens += share;
          else if (r.event_type === "clicked") bucket.clicks += share;
        }
      }
    }

    const steps = Object.entries(result).map(([stepId, s]) => {
      const opens = Math.round(s.opens);
      const clicks = Math.round(s.clicks);
      return {
        stepId,
        sent: s.sent,
        opens,
        clicks,
        openRate: s.sent > 0 ? Math.round((opens / s.sent) * 1000) / 10 : 0,
        clickRate: s.sent > 0 ? Math.round((clicks / s.sent) * 1000) / 10 : 0,
      };
    });

    res.json({ sequenceId: seqId, steps });
  } catch (err) { next(err); }
});

/**
 * GET /api/email-sequences/:id/enrollments/:enrollmentId/steps
 * Returns per-step delivery status for a single enrollment, derived from email_events.
 */
router.get("/email-sequences/:id/enrollments/:enrollmentId/steps", async (req, res, next): Promise<void> => {
  const seqId = parseInt(req.params.id);
  const enrollmentId = parseInt(req.params.enrollmentId);
  if (isNaN(seqId) || isNaN(enrollmentId)) { res.status(400).json({ error: "Invalid id" }); return; }
  try {
    const user = req.user as any;
    const [seq] = await db.select().from(emailSequencesTable).where(eq(emailSequencesTable.id, seqId));
    if (!seq || seq.tenantId !== user.tenantId) { res.status(404).json({ error: "Not found" }); return; }

    const [enrollment] = await db.select().from(sequenceEnrollmentsTable)
      .where(eq(sequenceEnrollmentsTable.id, enrollmentId));
    if (!enrollment || enrollment.sequenceId !== seqId) { res.status(404).json({ error: "Enrollment not found" }); return; }

    const [contact] = await db.select({
      id: contactsTable.id, firstName: contactsTable.firstName,
      lastName: contactsTable.lastName, email: contactsTable.email,
    }).from(contactsTable).where(eq(contactsTable.id, enrollment.contactId));

    const steps = await db.select().from(sequenceStepsTable)
      .where(eq(sequenceStepsTable.sequenceId, seqId))
      .orderBy(asc(sequenceStepsTable.stepOrder));

    // ── Dual-strategy event correlation ──────────────────────────────────────
    //
    // 1. PRIMARY: events written by the sequence worker carry
    //    `metadata.stepId` + `metadata.enrollmentId` — exact match.
    //
    // 2. FALLBACK: webhook-delivered events (bounced, opened, clicked) only
    //    carry `tenantId/contactId/templateId` tags; they have no stepId or
    //    enrollmentId. We attribute them to the matching email step by
    //    contactId + templateId, scoped to [enrolledAt, completedAt/now].
    //    Status precedence (highest wins): bounced > opened/clicked > sent.

    // Primary: events that know their exact enrollment
    const { rows: primaryEvents } = await pool.query<{
      event_type: string; metadata: Record<string, unknown>; occurred_at: string;
      template_id: number | null;
    }>(
      `SELECT event_type, metadata, occurred_at, template_id
       FROM email_events
       WHERE (metadata->>'enrollmentId')::int = $1
       ORDER BY occurred_at ASC`,
      [enrollmentId]
    );

    // Fallback: webhook events for this contact scoped to enrollment window.
    // Upper bound uses completedAt + 2-day grace period (bounces/opens can arrive
    // minutes to hours after the email is sent, even after enrollment completes).
    const enrolledAt = enrollment.enrolledAt ?? new Date(0);
    const { rows: fallbackEvents } = await pool.query<{
      event_type: string; metadata: Record<string, unknown>; occurred_at: string;
      template_id: number | null;
    }>(
      `SELECT event_type, metadata, occurred_at, template_id
       FROM email_events
       WHERE contact_id = $1
         AND tenant_id  = $2
         AND occurred_at >= $3
         AND occurred_at <= COALESCE($4::timestamptz + interval '2 days', NOW())
         AND event_type IN ('bounced', 'opened', 'clicked')
         AND (metadata->>'enrollmentId' IS NULL OR (metadata->>'enrollmentId')::int = $5)
       ORDER BY occurred_at ASC`,
      [enrollment.contactId, seq.tenantId, enrolledAt, enrollment.completedAt, enrollmentId]
    );

    // Determine which step order the enrollment is currently at
    const currentStep = steps.find(s => s.id === enrollment.currentStepId);
    const currentOrder = currentStep?.stepOrder ?? (enrollment.status === "completed" ? 999 : 0);

    const stepStatuses = steps.map(step => {
      const cfg = step.config as Record<string, unknown>;
      const label =
        (cfg.subject as string | undefined) ||
        (cfg.label as string | undefined) ||
        (cfg.goalName as string | undefined) ||
        (cfg.tagName as string | undefined) ||
        step.stepType;

      if (step.stepType !== "email") {
        // Non-email steps: mark done if enrollment has progressed past them
        const done = enrollment.status === "completed" || step.stepOrder < currentOrder;
        return {
          stepId: step.id, stepOrder: step.stepOrder, stepType: step.stepType,
          label, status: done ? "done" : "pending",
          occurredAt: null, recipientEmail: null,
        };
      }

      // Email steps: try primary match first (exact stepId), then template fallback
      const stepTemplateId = (cfg.templateId as number | undefined) ?? null;
      const primaryMatches = primaryEvents.filter(
        e => e.metadata && Number(e.metadata.stepId) === step.id
      );
      const fallbackMatches = stepTemplateId
        ? fallbackEvents.filter(e => e.template_id === stepTemplateId)
        : [];

      // Merge primary + fallback, deduplicate by (event_type, occurred_at)
      const allMatches = [
        ...primaryMatches,
        ...fallbackMatches.filter(fb =>
          !primaryMatches.some(
            pm => pm.event_type === fb.event_type &&
                  pm.occurred_at === fb.occurred_at
          )
        ),
      ];

      // Status precedence: bounced > sent (opened/clicked also imply delivery)
      let status = "pending";
      let occurredAt: string | null = null;

      if (allMatches.some(e => e.event_type === "bounced")) {
        status = "bounced";
        occurredAt = allMatches.find(e => e.event_type === "bounced")?.occurred_at ?? null;
      } else if (allMatches.some(e => ["sent", "opened", "clicked"].includes(e.event_type))) {
        // opened/clicked are proof of delivery even if the "sent" event is missing
        status = "sent";
        const deliveryEvent = allMatches.find(e => e.event_type === "sent")
          ?? allMatches.find(e => e.event_type === "opened")
          ?? allMatches.find(e => e.event_type === "clicked");
        occurredAt = deliveryEvent?.occurred_at ?? null;
      } else if (enrollment.status === "completed" || step.stepOrder < currentOrder) {
        // Enrollment has passed this step but no send event — contact had no email
        status = "skipped";
      }

      // Count engagement events. Opens/clicks can fire multiple times per recipient
      // (e.g. email reopened in different clients). We expose total counts here;
      // since this view is per-enrollment (one contact), counts == unique-per-contact.
      const openCount = allMatches.filter(e => e.event_type === "opened").length;
      const clickCount = allMatches.filter(e => e.event_type === "clicked").length;
      const firstOpenedAt = allMatches.find(e => e.event_type === "opened")?.occurred_at ?? null;
      const firstClickedAt = allMatches.find(e => e.event_type === "clicked")?.occurred_at ?? null;

      return {
        stepId: step.id, stepOrder: step.stepOrder, stepType: step.stepType,
        label, status, occurredAt,
        recipientEmail: contact?.email ?? null,
        openCount, clickCount, firstOpenedAt, firstClickedAt,
      };
    });

    res.json({ enrollment, contact, steps: stepStatuses });
  } catch (err) { next(err); }
});

export default router;
