import { eq } from "drizzle-orm";
import {
  db, pool, sequenceEnrollmentsTable, sequenceStepsTable,
  emailTemplatesTable, contactsTable, emailEventsTable, emailSequencesTable,
} from "@workspace/db";
import { sendEmail, sendEmailViaSMTP, renderTemplate, injectAllEmailTrackingLinks, generateClickToken, injectHoneypotLink } from "../services/email";
import { getSmtpAccountCredentials, reserveDailySlot, releaseDailySlot } from "../routes/smtpAccounts";
import {
  enqueueStep, getConnection, getWorkerClass, getRunQueue, registerWorker,
  type SequenceJob, type RunEnrollmentJob,
} from "../services/queue";
import { runContactEnrollment, parseContactListIds } from "../services/runEnrollmentService";
import { logger } from "../lib/logger";
import { withLiveEnrollment } from "../services/liveEnrollmentGuard";

async function processStep(job: SequenceJob): Promise<void> {
  const { enrollmentId, stepId, contactId, tenantId, runId } = job;

  const [step] = await db.select().from(sequenceStepsTable).where(eq(sequenceStepsTable.id, stepId));
  const [enrollment] = await db.select().from(sequenceEnrollmentsTable).where(eq(sequenceEnrollmentsTable.id, enrollmentId));
  const [contact] = await db.select().from(contactsTable).where(eq(contactsTable.id, contactId));

  if (!step || !enrollment || enrollment.status !== "active") return;

  if (step.stepType === "email") {
    const cfg = step.config as any;
    if (cfg.templateId && contact) {
      // Skip sending if contact has no email (e.g. imported via CSV without email)
      if (!contact.email) return;
      const [template] = await db.select().from(emailTemplatesTable).where(eq(emailTemplatesTable.id, cfg.templateId));

      // Resolve per-sequence sender overrides + optional SMTP account / rotation mode
      const seqRows = await pool.query<{
        sender_email: string | null;
        sender_name: string | null;
        smtp_account_id: number | null;
        smtp_rotation_mode: string | null;
      }>(
        `SELECT sender_email, sender_name, smtp_account_id, smtp_rotation_mode FROM email_sequences WHERE id=$1`,
        [enrollment.sequenceId]
      );
      const seqMeta = seqRows.rows[0] ?? null;

      if (template) {
        // Resolve journey URL via sequence → play → client → journey
        // NOTE: sequence_enrollments has NO play_id column — must join via email_sequences
        let journeyUrl = "";
        try {
          const seqRow = await pool.query<{ slug: string }>(
            `SELECT j.slug
             FROM sequence_enrollments se
             JOIN email_sequences s ON s.id = se.sequence_id
             LEFT JOIN abm_plays p ON p.id = s.play_id
             LEFT JOIN journeys j ON j.client_id = p.client_id AND j.status = 'published'
             WHERE se.id = $1
             ORDER BY j.id ASC LIMIT 1`,
            [enrollmentId]
          );
          const slug = seqRow.rows[0]?.slug;
          if (slug) {
            const domains = (process.env.REPLIT_DOMAINS ?? "").split(",");
            const base = process.env.BASE_URL ?? (domains[0] ? `https://${domains[0]}` : "");
            // Use path-based click token so corporate email proxies cannot strip ?cid= params
            const clickToken = generateClickToken(contact.id, tenantId, slug, undefined, template.id);
            journeyUrl = `${base}/api/public/click/${clickToken}`;
          }
        } catch { /* journey URL optional — email still sends */ }

        const vars: Record<string, string> = {
          firstName: contact.firstName ?? "",
          lastName: contact.lastName ?? "",
          companyName: cfg.companyName ?? "",
          playName: cfg.playName ?? "",
          journeyUrl,
        };
        const renderedSubject = renderTemplate(template.subject, vars);
        const rawHtml = renderTemplate(template.bodyHtml, vars);
        // Inject click-tracking links into every hardcoded /j/ href in the template
        const domains2 = (process.env.REPLIT_DOMAINS ?? "").split(",");
        const base2 = process.env.BASE_URL ?? (domains2[0] ? `https://${domains2[0]}` : "");
        // Load the tenant's published journey slugs so the link-injection guard
        // can route dead-slug /j/ links through the external click token rather
        // than a journey click token that would 404 at redirect time.
        let knownSlugs: Set<string> | undefined;
        try {
          const { rows: slugRows } = await pool.query<{ slug: string }>(
            `SELECT slug FROM journeys WHERE tenant_id = $1 AND status = 'published'`,
            [tenantId]
          );
          knownSlugs = new Set(slugRows.map(r => r.slug));
        } catch {
          // If the lookup fails, proceed without the guard — the click handler
          // will return a 404 page for dead tokens at redirect time.
        }
        const trackedHtml = injectAllEmailTrackingLinks(rawHtml, contact.id, {
          tenantId, baseUrl: base2, templateId: template.id, enrollmentId, knownSlugs,
        });
        const html = injectHoneypotLink(trackedHtml, contact.id, tenantId, base2, enrollmentId);
        const text = renderTemplate(template.bodyText, vars);
        const emailOpts = {
          to: contact.email,
          subject: renderedSubject,
          html,
          text,
          tenantId,
          contactId,
          templateId: template.id,
          enrollmentId,
          fromEmail: seqMeta?.sender_email ?? undefined,
          fromName: seqMeta?.sender_name ?? undefined,
          tags: [
            { name: "tenantId",    value: String(tenantId) },
            { name: "contactId",   value: String(contactId) },
            { name: "templateId",  value: String(template.id) },
            { name: "enrollmentId", value: String(enrollmentId) },
            { name: "sequenceId",   value: String(job.sequenceId ?? "") },
          ],
        };

        // Resolve which SMTP account to use (rotation > specific > Resend fallback)
        let resolvedSmtpId: number | null = null;
        let resolvedSmtpName: string | null = null;
        if (seqMeta?.smtp_rotation_mode === "round_robin") {
          // Pick an account deterministically from all tenant SMTP accounts using enrollment id
          const { rows: allAccounts } = await pool.query<{ id: number; name: string }>(
            `SELECT id, name FROM smtp_accounts WHERE tenant_id = $1 ORDER BY id ASC`,
            [tenantId]
          );
          if (allAccounts.length > 0) {
            const picked = allAccounts[enrollmentId % allAccounts.length];
            resolvedSmtpId = picked.id;
            resolvedSmtpName = picked.name;
            logger.info({ enrollmentId, resolvedSmtpId, accountCount: allAccounts.length }, "Round-robin SMTP account selected");
          }
        } else if (seqMeta?.smtp_account_id) {
          resolvedSmtpId = seqMeta.smtp_account_id;
          // Fetch the account name for attribution
          const { rows: nameRows } = await pool.query<{ name: string }>(
            `SELECT name FROM smtp_accounts WHERE id = $1 AND tenant_id = $2`,
            [resolvedSmtpId, tenantId]
          );
          resolvedSmtpName = nameRows[0]?.name ?? null;
        }

        const delivery=await withLiveEnrollment(tenantId,contactId,enrollmentId,contact.email,async()=>{
        let sent: boolean;
        let sendingPath: "smtp" | "resend" = "resend";
        if (resolvedSmtpId) {
          const smtpCreds = await getSmtpAccountCredentials(resolvedSmtpId, tenantId);
          if (smtpCreds) {
            // Reserve a slot before sending; slot is released on SMTP failure so
            // the daily counter reflects delivered mail, not failed attempts.
            const slotReserved = await reserveDailySlot(resolvedSmtpId);
            if (!slotReserved) {
              logger.warn(
                { smtpAccountId: resolvedSmtpId, enrollmentId, contactId },
                "SMTP daily limit exhausted — skipping email step"
              );
              return;
            }
            sent = await sendEmailViaSMTP(emailOpts, smtpCreds);
            if (!sent) {
              // SMTP send failed — release the reserved slot so it isn't counted
              await releaseDailySlot(resolvedSmtpId);
            } else {
              sendingPath = "smtp";
            }
          } else {
            logger.warn({ resolvedSmtpId, enrollmentId }, "SMTP account not found or decryption failed — falling back to Resend");
            sent = await sendEmail(emailOpts);
          }
        } else {
          sent = await sendEmail(emailOpts);
        }
        if (sent) {
          // email_events: step-stats attribution (join via template_id)
          await db.insert(emailEventsTable).values({
            tenantId, contactId, templateId: template.id,
            eventType: "sent", sendingPath,
            metadata: { stepId, enrollmentId, runId: runId ?? null, subject: renderedSubject },
          }).catch(err => logger.warn({ err }, "Failed to insert email_event"));

          // For SMTP sends, nodemailer returning true means the remote server accepted
          // the message (SMTP 250 OK). Record a synthetic "delivered" event immediately
          // so deliverability stats are accurate. Resend sends get "delivered" via webhook.
          if (sendingPath === "smtp") {
            await pool.query(
              `INSERT INTO email_events (tenant_id, contact_id, template_id, event_type, metadata)
               VALUES ($1, $2, $3, 'delivered', $4)`,
              [tenantId, contactId, template.id, JSON.stringify({ stepId, enrollmentId, runId: runId ?? null, source: "smtp_accepted" })]
            ).catch(err => logger.warn({ err }, "Failed to insert smtp delivered event"));
          }

          // activity_events: contact timeline row
          await pool.query(
            `INSERT INTO activity_events
               (tenant_id, contact_id, event_type, description, metadata, created_at)
             VALUES ($1, $2, 'email_sent', $3, $4, NOW())`,
            [
              tenantId, contactId,
              `Email sent: ${renderedSubject}`,
              JSON.stringify({
                templateId: template.id,
                subject: renderedSubject,
                stepId,
                enrollmentId,
                runId: runId ?? null,
                ...(resolvedSmtpId ? { smtpAccountId: resolvedSmtpId } : {}),
                ...(resolvedSmtpName ? { smtpAccountName: resolvedSmtpName } : {}),
              }),
            ]
          ).catch(err => logger.warn({ err }, "Failed to insert activity_event for email_sent"));
        }
        });
        if(!delivery.allowed)return;
      }
    }
    await advanceToNextStep(enrollment, step, enrollmentId, job);

  } else if (step.stepType === "wait") {
    const cfg = step.config as any;
    const duration = Number(cfg.duration ?? 0);
    const unit = cfg.unit ?? "hours";
    const delayMs = duration * (unit === "days" ? 86_400_000 : 3_600_000);
    const nextStep = await getNextLinearStep(step);
    if (nextStep) {
      await db.update(sequenceEnrollmentsTable).set({ currentStepId: nextStep.id }).where(eq(sequenceEnrollmentsTable.id, enrollmentId));
      await enqueueStep({ ...job, stepId: nextStep.id }, delayMs);
    } else {
      await complete(enrollmentId, runId);
    }

  } else if (step.stepType === "condition") {
    const cfg = step.config as any;
    let passed = false;
    if (cfg.conditionType === "EMAIL_OPENED" && contact) {
      // Scope to opens that occurred AFTER this enrollment started, preventing stale
      // opens from previous runs of the same sequence from incorrectly firing the condition.
      const openedRows = await pool.query(
        `SELECT 1 FROM email_events
         WHERE contact_id = $1 AND event_type = 'opened' AND tenant_id = $2
           AND ($3::timestamptz IS NULL OR occurred_at >= $3::timestamptz)
         LIMIT 1`,
        [contactId, tenantId, enrollment.enrolledAt ?? null]
      );
      passed = openedRows.rows.length > 0;
    } else if (cfg.conditionType === "LEAD_SCORE_GT" && contact) {
      passed = (contact.leadScore ?? 0) > Number(cfg.value ?? 0);
    } else if (cfg.conditionType === "TAG_EXISTS" && contact) {
      passed = (contact.tags ?? []).includes(cfg.value ?? "");
    }
    const nextStepId = passed ? step.trueNextStepId : step.falseNextStepId;
    if (nextStepId) {
      await db.update(sequenceEnrollmentsTable).set({ currentStepId: nextStepId }).where(eq(sequenceEnrollmentsTable.id, enrollmentId));
      await enqueueStep({ ...job, stepId: nextStepId });
    } else {
      await complete(enrollmentId, runId);
    }

  } else if (step.stepType === "tag" && contact) {
    const cfg = step.config as any;
    const tag = cfg.tagName ?? "";
    let tags = contact.tags ?? [];
    if (cfg.operation === "add" && tag && !tags.includes(tag)) tags = [...tags, tag];
    else if (cfg.operation === "remove") tags = tags.filter((t: string) => t !== tag);
    await db.update(contactsTable).set({ tags }).where(eq(contactsTable.id, contactId));
    await advanceToNextStep(enrollment, step, enrollmentId, job);

  } else {
    await advanceToNextStep(enrollment, step, enrollmentId, job);
  }
}

async function getNextLinearStep(step: any) {
  const allSteps = await db.select().from(sequenceStepsTable)
    .where(eq(sequenceStepsTable.sequenceId, step.sequenceId));
  return allSteps.find(s => s.stepOrder === step.stepOrder + 1) ?? null;
}

async function advanceToNextStep(enrollment: any, step: any, enrollmentId: number, job: SequenceJob) {
  const nextStep = await getNextLinearStep(step);
  if (nextStep) {
    await db.update(sequenceEnrollmentsTable).set({ currentStepId: nextStep.id }).where(eq(sequenceEnrollmentsTable.id, enrollmentId));
    await enqueueStep({ ...job, stepId: nextStep.id });
  } else {
    await complete(enrollmentId, job.runId);
  }
}

/**
 * Mark an enrollment completed.
 * If runId is provided, checks whether all enrollments for that run are now
 * in a terminal state and, if so, marks the run itself as 'completed'.
 */
async function complete(enrollmentId: number, runId?: number) {
  await db.update(sequenceEnrollmentsTable)
    .set({ status: "completed", completedAt: new Date() })
    .where(eq(sequenceEnrollmentsTable.id, enrollmentId));

  if (runId) {
    await maybeCompleteRun(runId);
  }
}

/**
 * Check if all enrollments for a run are in a terminal state.
 * If so, transition the run from 'running' → 'completed'.
 */
export async function maybeCompleteRun(runId: number): Promise<void> {
  try {
    const { rows } = await pool.query<{ active_cnt: string }>(
      `SELECT COUNT(*) FILTER (WHERE status = 'active') AS active_cnt
       FROM sequence_enrollments
       WHERE run_id = $1`,
      [runId]
    );
    if (rows[0] && Number(rows[0].active_cnt) === 0) {
      await pool.query(
        `UPDATE sequence_runs
         SET status = 'completed', completed_at = NOW()
         WHERE id = $1 AND status = 'running'`,
        [runId]
      );
      logger.info({ runId }, "Sequence run marked completed — all enrollments finished");
    }
  } catch (err) {
    logger.warn({ err, runId }, "maybeCompleteRun check failed — run status not updated");
  }
}

export async function startWorker(): Promise<void> {
  const connection = getConnection();
  const Worker = getWorkerClass();
  if (!connection || !Worker) {
    logger.warn("Sequence worker not started — Redis connection unavailable");
    return;
  }
  const worker = new Worker(
    "sequence-steps",
    async (job: any) => processStep(job.data as SequenceJob),
    { connection, concurrency: 5 },
  );
  worker.on("completed", (job: any) => logger.info({ jobId: job.id }, "Sequence step completed"));
  worker.on("failed", (job: any, err: Error) => logger.error({ jobId: job?.id, err }, "Sequence step failed"));
  registerWorker(worker);
  logger.info("Sequence worker started");
}

/**
 * BullMQ worker for run enrollment jobs ("sequence-runs" queue).
 * Reads contact_list_ids from the DB so the job payload stays small,
 * then delegates to the shared runContactEnrollment function.
 */
export async function startRunEnrollmentWorker(): Promise<void> {
  const connection = getConnection();
  const Worker     = getWorkerClass();
  const runQueue   = getRunQueue();
  if (!connection || !Worker || !runQueue) {
    logger.warn("Run enrollment worker not started — Redis connection unavailable");
    return;
  }
  const worker = new Worker(
    "sequence-runs",
    async (job: any) => {
      const { runId, sequenceId, tenantId } = job.data as RunEnrollmentJob;
      const { rows } = await pool.query<{
        contact_list_ids: unknown; enrolled: number; skipped: number; play_id: number | null;
      }>(
        `SELECT contact_list_ids, enrolled, skipped, play_id FROM sequence_runs WHERE id = $1`,
        [runId]
      );
      if (!rows[0]) {
        logger.warn({ runId }, "Run not found in DB — skipping enrollment job");
        return;
      }
      const ids = parseContactListIds(rows[0].contact_list_ids);
      const offset = (rows[0].enrolled ?? 0) + (rows[0].skipped ?? 0);
      const remaining = ids.slice(offset);
      if (remaining.length > 0) {
        await runContactEnrollment(runId, sequenceId, tenantId, remaining, rows[0].play_id ?? undefined);
      }
    },
    { connection, concurrency: 3 },
  );
  worker.on("completed", (job: any) => logger.info({ jobId: job.id }, "Run enrollment completed"));
  worker.on("failed", (job: any, err: Error) => logger.error({ jobId: job?.id, err }, "Run enrollment failed"));
  registerWorker(worker);
  logger.info("Run enrollment worker started");
}

/**
 * Start both step and run-enrollment workers for an arbitrary IORedis connection.
 * Used as the workerFactory for per-tenant queue sets created lazily in queue.ts.
 * Returns the created worker instances so queue.ts can push them into the tenant
 * set's workers array and close them cleanly on cache invalidation.
 * index.ts registers this via setWorkerFactory() — queue.ts never imports workers directly.
 */
export async function startWorkersForConnection(connection: any): Promise<any[]> {
  const { Worker } = await import("bullmq");

  const stepWorker = new Worker(
    "sequence-steps",
    async (job: any) => processStep(job.data as SequenceJob),
    { connection, concurrency: 5 },
  );
  stepWorker.on("completed", (job: any) => logger.info({ jobId: job.id }, "Sequence step completed (tenant worker)"));
  stepWorker.on("failed", (job: any, err: Error) => logger.error({ jobId: job?.id, err }, "Sequence step failed (tenant worker)"));

  const runWorker = new Worker(
    "sequence-runs",
    async (job: any) => {
      const { runId, sequenceId, tenantId } = job.data as RunEnrollmentJob;
      const { rows } = await pool.query<{
        contact_list_ids: unknown; enrolled: number; skipped: number; play_id: number | null;
      }>(
        `SELECT contact_list_ids, enrolled, skipped, play_id FROM sequence_runs WHERE id = $1`,
        [runId]
      );
      if (!rows[0]) {
        logger.warn({ runId }, "Run not found in DB — skipping enrollment job (tenant worker)");
        return;
      }
      const ids = parseContactListIds(rows[0].contact_list_ids);
      const offset = (rows[0].enrolled ?? 0) + (rows[0].skipped ?? 0);
      const remaining = ids.slice(offset);
      if (remaining.length > 0) {
        await runContactEnrollment(runId, sequenceId, tenantId, remaining, rows[0].play_id ?? undefined);
      }
    },
    { connection, concurrency: 3 },
  );
  runWorker.on("completed", (job: any) => logger.info({ jobId: job.id }, "Run enrollment completed (tenant worker)"));
  runWorker.on("failed", (job: any, err: Error) => logger.error({ jobId: job?.id, err }, "Run enrollment failed (tenant worker)"));

  logger.info("Tenant-specific sequence workers started");
  return [stepWorker, runWorker];
}
