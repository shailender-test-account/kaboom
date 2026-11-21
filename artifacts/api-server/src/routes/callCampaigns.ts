import { Router, type IRouter } from "express";
import { z } from "zod";
import { pool } from "@workspace/db";
import { requireAuth } from "../middlewares/requireAuth";
import { logger } from "../lib/logger";
import { initiateCall, CALL_SCORE_DELTAS } from "../services/vapi";
import { initiateRetellCall } from "../services/retell";
import { analyseTranscript } from "../lib/transcriptAnalyser";

const router: IRouter = Router();
router.use(requireAuth);

const CampaignBody = z.object({
  name:             z.string().min(1),
  pitchTemplateId:  z.number().int().positive().optional().nullable(),
  provider:         z.enum(["vapi","retell"]).optional().default("vapi"),
  agentConfig: z.object({
    personaName:      z.string().optional(),
    goal:             z.string().optional(),
    keyTalkingPoints: z.string().optional(),
    voiceId:          z.string().optional(),
    phoneNumberId:    z.string().optional(),
    assistantId:      z.string().optional(),
    agentId:          z.string().optional(),
    fromNumber:       z.string().optional(),
  }).optional().default({}),
  scheduleAt:      z.string().datetime().optional().nullable(),
  status:          z.enum(["draft","active","paused","completed"]).optional(),
  batchSize:       z.number().int().min(1).max(50).optional(),
  waveGapMinutes:  z.number().int().min(1).max(1440).optional(),
});

// ── Wave helpers ────────────────────────────────────────────────────────────

/**
 * Dial a single contact within a campaign wave.
 * Updates call_campaign_contacts status and inserts a call_logs row on success.
 */
async function dialContact(
  contactId: number, campaignId: number, tenantId: number,
  waveId: number | null, agentConfig: any, provider: string = "vapi",
): Promise<{ ok: boolean; blocked: boolean; callId?: string; error?: string }> {
  // ── DNC guard — never call a contact on the negative list ────────────────
  // Check both: the call_dnc_contacts table (call-specific) and contacts.dnc (unified flag)
  const dncCheck = await pool.query<{ id: number; reason: string | null; contact_dnc: boolean }>(
    `SELECT d.id, d.reason, COALESCE(c.dnc, false) AS contact_dnc
     FROM call_dnc_contacts d
     FULL OUTER JOIN contacts c ON c.id = $2 AND c.tenant_id = $1
     WHERE d.tenant_id = $1 AND d.contact_id = $2
     LIMIT 1`,
    [tenantId, contactId],
  );
  // Also check contacts.dnc directly if not in call_dnc_contacts
  const contactDncCheck = await pool.query<{ dnc: boolean }>(
    `SELECT dnc FROM contacts WHERE id=$1 AND tenant_id=$2 LIMIT 1`,
    [contactId, tenantId],
  );
  const isContactDnc = contactDncCheck.rows[0]?.dnc === true;
  if (dncCheck.rows[0] || isContactDnc) {
    const reason = dncCheck.rows[0]
      ? `Call blocked: contact is on the Do Not Call list${dncCheck.rows[0].reason ? ` (${dncCheck.rows[0].reason})` : ""}`
      : `Call blocked: contact is marked as DNC`;
    await pool.query(
      `UPDATE call_campaign_contacts SET status='blocked', failure_reason=$3 WHERE campaign_id=$1 AND contact_id=$2`,
      [campaignId, contactId, reason],
    );
    await pool.query(
      `INSERT INTO call_logs (tenant_id, campaign_id, contact_id, status, ended_reason, created_at)
       VALUES ($1, $2, $3, 'blocked', $4, NOW())`,
      [tenantId, campaignId, contactId, reason],
    ).catch(() => {});
    return { ok: false, blocked: true, error: reason };
  }
  // ── Duplicate-phone guard ────────────────────────────────────────────────
  // If another contact with the same phone number has already been called
  // (or is being called) in this campaign, skip this contact to avoid
  // redialing the same number twice within the same campaign run.
  const phoneCheck = await pool.query<{ phone: string | null }>(
    `SELECT phone FROM contacts WHERE id=$1 AND tenant_id=$2 LIMIT 1`,
    [contactId, tenantId],
  );
  const thisPhone = phoneCheck.rows[0]?.phone?.trim() || null;
  if (thisPhone) {
    const dupCheck = await pool.query<{ id: number }>(
      `SELECT cl.id
       FROM call_logs cl
       JOIN contacts c ON c.id = cl.contact_id AND c.tenant_id = cl.tenant_id
       WHERE cl.campaign_id = $1
         AND cl.tenant_id   = $2
         AND cl.contact_id <> $3
         AND c.phone        = $4
       LIMIT 1`,
      [campaignId, tenantId, contactId, thisPhone],
    );
    if (dupCheck.rows[0]) {
      const reason = `Call blocked: duplicate phone ${thisPhone} already called in this campaign`;
      await pool.query(
        `UPDATE call_campaign_contacts SET status='blocked', failure_reason=$3 WHERE campaign_id=$1 AND contact_id=$2`,
        [campaignId, contactId, reason],
      );
      await pool.query(
        `INSERT INTO call_logs (tenant_id, campaign_id, contact_id, status, ended_reason, created_at)
         VALUES ($1, $2, $3, 'blocked', $4, NOW())`,
        [tenantId, campaignId, contactId, reason],
      ).catch(() => {});
      return { ok: false, blocked: true, error: reason };
    }
  }
  // ────────────────────────────────────────────────────────────────────────

  await pool.query(
    `UPDATE call_campaign_contacts
     SET status='calling', last_attempted_at=NOW(), attempt_count=attempt_count+1
     WHERE campaign_id=$1 AND contact_id=$2`,
    [campaignId, contactId],
  );

  let result: { ok: boolean; callId?: string; error?: string };
  try {
    if (provider === "retell") {
      result = await initiateRetellCall({ contactId, campaignId, tenantId, agentConfig: agentConfig ?? {} });
    } else {
      result = await initiateCall({ contactId, campaignId, tenantId, agentConfig: agentConfig ?? {} });
    }
  } catch (err: any) {
    await pool.query(
      `UPDATE call_campaign_contacts SET status='failed', failure_reason=$3 WHERE campaign_id=$1 AND contact_id=$2`,
      [campaignId, contactId, err?.message ?? "Unexpected error"],
    ).catch(() => {});
    return { ok: false, blocked: false, error: err?.message ?? "Unexpected error" };
  }

  if (result.ok && result.callId) {
    if (provider === "retell") {
      await pool.query(
        `UPDATE call_campaign_contacts SET retell_call_id=$3 WHERE campaign_id=$1 AND contact_id=$2`,
        [campaignId, contactId, result.callId],
      );
      await pool.query(
        `INSERT INTO call_logs (tenant_id, campaign_id, contact_id, retell_call_id, provider, status)
         VALUES ($1, $2, $3, $4, 'retell', 'queued') ON CONFLICT (retell_call_id) WHERE retell_call_id IS NOT NULL DO NOTHING`,
        [tenantId, campaignId, contactId, result.callId],
      );
    } else {
      await pool.query(
        `UPDATE call_campaign_contacts SET vapi_call_id=$3 WHERE campaign_id=$1 AND contact_id=$2`,
        [campaignId, contactId, result.callId],
      );
      await pool.query(
        `INSERT INTO call_logs (tenant_id, campaign_id, contact_id, vapi_call_id, provider, status)
         VALUES ($1, $2, $3, $4, 'vapi', 'queued') ON CONFLICT (vapi_call_id) DO NOTHING`,
        [tenantId, campaignId, contactId, result.callId],
      );
    }
    return { ok: true, blocked: false, callId: result.callId };
  }

  const isBlocked = (result.error ?? "").startsWith("Call blocked:");
  await pool.query(
    `UPDATE call_campaign_contacts SET status=$3, failure_reason=$4 WHERE campaign_id=$1 AND contact_id=$2`,
    [campaignId, contactId, isBlocked ? "blocked" : "failed", result.error],
  );
  if (isBlocked) {
    await pool.query(
      `INSERT INTO call_logs (tenant_id, campaign_id, contact_id, status, ended_reason, created_at)
       VALUES ($1, $2, $3, 'blocked', $4, NOW())`,
      [tenantId, campaignId, contactId, result.error],
    ).catch(() => {});
  }
  return { ok: false, blocked: isBlocked, error: result.error };
}

/**
 * Group all unassigned pending contacts (wave_id IS NULL) into waves, insert
 * wave rows, and link contacts to their wave via wave_id. Wave 1 is left as
 * 'pending' (activated immediately by the caller); waves 2-N are 'scheduled'.
 *
 * Returns { waveCount, contactCount, firstWaveId }.
 */
export async function buildWaves(
  campaignId: number, tenantId: number, batchSize: number, waveGapMinutes: number,
): Promise<{ waveCount: number; contactCount: number; firstWaveId: number | null }> {
  const { rows: contacts } = await pool.query<{ id: number; contact_id: number }>(
    `SELECT id, contact_id FROM call_campaign_contacts
     WHERE campaign_id=$1 AND status='pending' AND wave_id IS NULL
     ORDER BY created_at ASC`,
    [campaignId],
  );

  if (contacts.length === 0) return { waveCount: 0, contactCount: 0, firstWaveId: null };

  const { rows: [maxRow] } = await pool.query<{ max_wave: number }>(
    `SELECT COALESCE(MAX(wave_number), 0) AS max_wave FROM call_campaign_waves WHERE campaign_id=$1`,
    [campaignId],
  );
  let waveNum = Number(maxRow.max_wave);

  const chunks: typeof contacts[number][][] = [];
  for (let i = 0; i < contacts.length; i += batchSize) {
    chunks.push(contacts.slice(i, i + batchSize));
  }

  const now = new Date();
  let firstWaveId: number | null = null;

  for (let i = 0; i < chunks.length; i++) {
    waveNum++;
    const isFirst = i === 0;
    const scheduledAt = isFirst ? null : new Date(now.getTime() + i * waveGapMinutes * 60 * 1000);

    const { rows: [wave] } = await pool.query<{ id: number }>(
      `INSERT INTO call_campaign_waves
       (campaign_id, tenant_id, wave_number, status, batch_size, scheduled_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
       RETURNING id`,
      [campaignId, tenantId, waveNum, isFirst ? "pending" : "scheduled", batchSize, scheduledAt],
    );

    if (isFirst) firstWaveId = wave.id;

    // Bulk update contacts for this chunk
    const chunkIds = chunks[i].map(c => c.id);
    await pool.query(
      `UPDATE call_campaign_contacts SET wave_id=$1 WHERE id = ANY($2::int[])`,
      [wave.id, chunkIds],
    );
  }

  return { waveCount: chunks.length, contactCount: contacts.length, firstWaveId };
}

/**
 * Execute all pending contacts in a wave, respecting batchSize concurrency.
 * Checks wave + campaign status before each batch so a pause/stop mid-run
 * actually halts un-dialled contacts. Only marks 'completed' when the full
 * contact list is exhausted without interruption.
 */
export async function executeWave(
  waveId: number, campaignId: number, tenantId: number,
  agentConfig: any, batchSize: number, provider: string = "vapi",
): Promise<{ initiated: number; failed: number; blocked: number }> {
  // Atomically claim the wave (guard against double-fire).
  // Preserve started_at if already set (resume case).
  const claim = await pool.query<{ id: number }>(
    `UPDATE call_campaign_waves
     SET status='active',
         started_at=COALESCE(started_at, NOW()),
         updated_at=NOW()
     WHERE id=$1 AND status IN ('pending','scheduled','paused')
     RETURNING id`,
    [waveId],
  );
  if (!claim.rows[0]) return { initiated: 0, failed: 0, blocked: 0 };

  const { rows: contacts } = await pool.query<{ contact_id: number }>(
    `SELECT contact_id FROM call_campaign_contacts
     WHERE wave_id=$1 AND status='pending'
     ORDER BY created_at ASC`,
    [waveId],
  );

  let initiated = 0, failed = 0, blocked = 0;
  const CONCURRENCY = Math.max(1, batchSize);
  let interrupted = false;

  for (let i = 0; i < contacts.length; i += CONCURRENCY) {
    // Re-check wave and campaign status before every batch chunk.
    const [waveCheck, campCheck] = await Promise.all([
      pool.query<{ status: string }>(`SELECT status FROM call_campaign_waves WHERE id=$1`, [waveId]),
      pool.query<{ status: string }>(`SELECT status FROM call_campaigns WHERE id=$1`, [campaignId]),
    ]);
    const waveStatus = waveCheck.rows[0]?.status;
    const campStatus = campCheck.rows[0]?.status;

    if (!waveStatus || waveStatus !== "active" || campStatus !== "active") {
      interrupted = true;
      logger.info({ waveId, campaignId, waveStatus, campStatus }, "Wave execution interrupted — stopping un-dialled contacts");
      break;
    }

    const slice = contacts.slice(i, i + CONCURRENCY);
    await Promise.allSettled(slice.map(async ({ contact_id }) => {
      try {
        const r = await dialContact(contact_id, campaignId, tenantId, waveId, agentConfig, provider);
        if (r.ok)           initiated++;
        else if (r.blocked) blocked++;
        else                failed++;
      } catch (err) {
        failed++;
        logger.warn({ err, contact_id, waveId, campaignId }, "Error dialling contact in wave");
      }
    }));

    if (!interrupted && i + CONCURRENCY < contacts.length) {
      await new Promise(r => setTimeout(r, 300));
    }
  }

  if (!interrupted) {
    // All contacts processed without interruption → completed.
    await pool.query(
      `UPDATE call_campaign_waves SET status='completed', completed_at=NOW(), updated_at=NOW() WHERE id=$1`,
      [waveId],
    );
    logger.info({ waveId, campaignId, initiated, failed, blocked }, "Wave execution complete");
  } else {
    // Interrupted — ensure the wave is not stranded as 'active'.
    // A pause/cancel endpoint may have already set a new status; only fall back to
    // 'paused' if the wave is still 'active' (i.e. no endpoint changed it yet).
    const { rows: [cur] } = await pool.query<{ status: string }>(
      `SELECT status FROM call_campaign_waves WHERE id=$1`,
      [waveId],
    );
    if (cur?.status === "active") {
      await pool.query(
        `UPDATE call_campaign_waves SET status='paused', updated_at=NOW() WHERE id=$1`,
        [waveId],
      );
    }
    logger.info({ waveId, campaignId, initiated, failed, blocked, waveEndStatus: cur?.status ?? "paused" }, "Wave execution halted by interruption");
  }

  return { initiated, failed, blocked };
}

/**
 * Heartbeat function: activate any waves whose scheduled_at has passed and
 * whose campaign is still active. Called every 30 s from index.ts.
 */
export async function activateScheduledWaves(): Promise<void> {
  const { rows: due } = await pool.query<{ id: number; campaign_id: number; tenant_id: number; batch_size: number }>(
    `SELECT ccw.id, ccw.campaign_id, ccw.tenant_id, ccw.batch_size
     FROM call_campaign_waves ccw
     JOIN call_campaigns cc ON cc.id = ccw.campaign_id
     WHERE ccw.status = 'scheduled'
       AND ccw.scheduled_at <= NOW()
       AND cc.status = 'active'
     ORDER BY ccw.scheduled_at ASC
     LIMIT 10`,
  );

  if (due.length === 0) return;

  await Promise.allSettled(due.map(async (wave) => {
    try {
      // ── Concurrency gate ────────────────────────────────────────────────────
      // Count calls for this campaign still marked 'calling' (live on SIP trunk).
      // Use a 45-minute staleness cutoff so a stuck status can't block forever.
      // If active calls >= batch_size, defer this wave to the next heartbeat cycle
      // rather than piling more calls onto the SIP trunk and exceeding VoBiz's
      // concurrent-call limit.
      const { rows: [concRow] } = await pool.query<{ active: string }>(
        `SELECT COUNT(*) AS active
         FROM call_campaign_contacts
         WHERE campaign_id = $1
           AND status = 'calling'
           AND last_attempted_at > NOW() - INTERVAL '45 minutes'`,
        [wave.campaign_id],
      );
      const activeCalls = parseInt(concRow?.active ?? "0", 10);
      if (activeCalls >= wave.batch_size) {
        logger.info(
          { waveId: wave.id, campaignId: wave.campaign_id, activeCalls, batchSize: wave.batch_size },
          "Wave deferred — previous wave still has live calls on SIP trunk",
        );
        return;
      }
      // ────────────────────────────────────────────────────────────────────────

      const { rows: [camp] } = await pool.query<{ agent_config: any; pitch_template_id: number | null; provider: string }>(
        `SELECT agent_config, pitch_template_id, provider FROM call_campaigns WHERE id=$1`,
        [wave.campaign_id],
      );
      if (!camp) return;
      const agentConfig = {
        ...(camp.agent_config ?? {}),
        ...(camp.pitch_template_id ? { pitchTemplateId: camp.pitch_template_id } : {}),
      };
      const campProvider = camp.provider ?? "vapi";
      await executeWave(wave.id, wave.campaign_id, wave.tenant_id, agentConfig, wave.batch_size, campProvider);
    } catch (err) {
      logger.warn({ err, waveId: wave.id, campaignId: wave.campaign_id }, "Wave heartbeat execution error");
    }
  }));
}

// ── GET /call-campaigns ────────────────────────────────────────────────────────
router.get("/call-campaigns", async (req, res, next): Promise<void> => {
  try {
    const user = req.user as any;
    const rows = await pool.query(
      `SELECT cc.*,
              pt.name AS pitch_template_name, pt.product_key AS pitch_template_product_key,
              COUNT(ccc.id)::int                          AS total_contacts,
              COUNT(ccc.id) FILTER (WHERE ccc.status='done')::int AS done_contacts,
              COUNT(ccc.id) FILTER (WHERE ccc.status='calling')::int AS calling_contacts,
              COUNT(ccc.id) FILTER (WHERE ccc.status='failed')::int AS failed_contacts
       FROM call_campaigns cc
       LEFT JOIN pitch_templates pt ON pt.id = cc.pitch_template_id
       LEFT JOIN call_campaign_contacts ccc ON ccc.campaign_id = cc.id
       WHERE cc.tenant_id = $1
       GROUP BY cc.id, pt.name, pt.product_key
       ORDER BY cc.created_at DESC`,
      [user.tenantId],
    );
    res.json(rows.rows);
  } catch (err) { next(err); }
});

// ── POST /call-campaigns ───────────────────────────────────────────────────────
router.post("/call-campaigns", async (req, res, next): Promise<void> => {
  try {
    const user = req.user as any;
    const parsed = CampaignBody.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
    const { name, pitchTemplateId, provider, agentConfig, scheduleAt, status, batchSize, waveGapMinutes } = parsed.data;

    const result = await pool.query<{ id: number }>(
      `INSERT INTO call_campaigns (tenant_id, name, pitch_template_id, provider, agent_config, schedule_at, status, batch_size, wave_gap_minutes, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, NOW(), NOW())
       RETURNING id`,
      [user.tenantId, name, pitchTemplateId ?? null, provider ?? "vapi", JSON.stringify(agentConfig ?? {}), scheduleAt ?? null, status ?? "draft", batchSize ?? 3, waveGapMinutes ?? 6],
    );
    const campaign = await pool.query(`SELECT * FROM call_campaigns WHERE id = $1`, [result.rows[0].id]);
    res.status(201).json(campaign.rows[0]);
  } catch (err) { next(err); }
});

// ── DNC (Negative List) endpoints — MUST be before /:id routes ────────────────

router.get("/call-campaigns/dnc", async (req, res, next): Promise<void> => {
  try {
    const user = req.user as any;
    const { rows } = await pool.query(
      `SELECT d.id, d.contact_id, d.reason, d.source, d.campaign_id, d.added_at,
              c.first_name, c.last_name, c.email, c.phone, c.company_name,
              cc.name AS campaign_name
         FROM call_dnc_contacts d
         LEFT JOIN contacts      c  ON c.id  = d.contact_id
         LEFT JOIN call_campaigns cc ON cc.id = d.campaign_id
        WHERE d.tenant_id = $1
        ORDER BY d.added_at DESC`,
      [user.tenantId],
    );
    res.json(rows);
  } catch (err) { next(err); }
});

router.post("/call-campaigns/dnc", async (req, res, next): Promise<void> => {
  try {
    const user = req.user as any;
    const { contactId, reason } = z.object({
      contactId: z.number().int(),
      reason:    z.string().max(500).optional(),
    }).parse(req.body);
    const { rows } = await pool.query(
      `INSERT INTO call_dnc_contacts (tenant_id, contact_id, reason, source, added_at)
       VALUES ($1, $2, $3, 'manual', NOW())
       ON CONFLICT (tenant_id, contact_id) DO UPDATE SET reason=$3, source='manual', added_at=NOW()
       RETURNING id`,
      [user.tenantId, contactId, reason ?? null],
    );
    res.json({ ok: true, id: rows[0].id });
  } catch (err) { next(err); }
});

router.delete("/call-campaigns/dnc/:contactId", async (req, res, next): Promise<void> => {
  try {
    const user = req.user as any;
    const contactId = parseInt(req.params.contactId);
    if (isNaN(contactId)) { res.status(400).json({ error: "Invalid contactId" }); return; }
    await pool.query(
      `DELETE FROM call_dnc_contacts WHERE tenant_id=$1 AND contact_id=$2`,
      [user.tenantId, contactId],
    );
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ── GET /call-campaigns/:id ────────────────────────────────────────────────────
router.get("/call-campaigns/:id", async (req, res, next): Promise<void> => {
  try {
    const user = req.user as any;
    const id = parseInt(req.params.id);
    if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
    const row = await pool.query(
      `SELECT cc.*,
              pt.name AS pitch_template_name, pt.product_key AS pitch_template_product_key,
              COUNT(ccc.id)::int                          AS total_contacts,
              COUNT(ccc.id) FILTER (WHERE ccc.status='done')::int AS done_contacts,
              COUNT(ccc.id) FILTER (WHERE ccc.status='calling')::int AS calling_contacts,
              COUNT(ccc.id) FILTER (WHERE ccc.status='failed')::int AS failed_contacts
       FROM call_campaigns cc
       LEFT JOIN pitch_templates pt ON pt.id = cc.pitch_template_id
       LEFT JOIN call_campaign_contacts ccc ON ccc.campaign_id = cc.id
       WHERE cc.id = $1 AND cc.tenant_id = $2
       GROUP BY cc.id, pt.name, pt.product_key`,
      [id, user.tenantId],
    );
    if (!row.rows[0]) { res.status(404).json({ error: "Campaign not found" }); return; }
    res.json(row.rows[0]);
  } catch (err) { next(err); }
});

// ── PATCH /call-campaigns/:id ──────────────────────────────────────────────────
router.patch("/call-campaigns/:id", async (req, res, next): Promise<void> => {
  try {
    const user = req.user as any;
    const id = parseInt(req.params.id);
    if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
    const parsed = CampaignBody.partial().safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
    const { name, pitchTemplateId, provider, agentConfig, scheduleAt, status, batchSize, waveGapMinutes } = parsed.data;

    const existing = await pool.query(`SELECT id FROM call_campaigns WHERE id=$1 AND tenant_id=$2`, [id, user.tenantId]);
    if (!existing.rows[0]) { res.status(404).json({ error: "Campaign not found" }); return; }

    await pool.query(
      `UPDATE call_campaigns
       SET name              = COALESCE($2, name),
           pitch_template_id = CASE WHEN $3::int IS NOT NULL THEN $3::int ELSE pitch_template_id END,
           provider          = COALESCE($4, provider),
           agent_config      = COALESCE($5::jsonb, agent_config),
           schedule_at       = COALESCE($6, schedule_at),
           status            = COALESCE($7, status),
           batch_size        = COALESCE($8, batch_size),
           wave_gap_minutes  = COALESCE($9, wave_gap_minutes),
           updated_at        = NOW()
       WHERE id = $1`,
      [id, name ?? null, pitchTemplateId ?? null, provider ?? null, agentConfig ? JSON.stringify(agentConfig) : null, scheduleAt ?? null, status ?? null, batchSize ?? null, waveGapMinutes ?? null],
    );

    // Cascade wave status changes:
    // paused   → pause all unstarted (pending/scheduled) waves so heartbeat skips them
    // completed → cancel all unstarted waves — they will never fire
    if (status === "paused") {
      await pool.query(
        `UPDATE call_campaign_waves SET status='paused', updated_at=NOW()
         WHERE campaign_id=$1 AND status IN ('pending','scheduled')`,
        [id],
      );
    } else if (status === "completed") {
      await pool.query(
        `UPDATE call_campaign_waves SET status='cancelled', updated_at=NOW()
         WHERE campaign_id=$1 AND status IN ('pending','scheduled')`,
        [id],
      );
    }

    const updated = await pool.query(`SELECT * FROM call_campaigns WHERE id=$1`, [id]);
    res.json(updated.rows[0]);
  } catch (err) { next(err); }
});

// ── DELETE /call-campaigns/:id ─────────────────────────────────────────────────
router.delete("/call-campaigns/:id", async (req, res, next): Promise<void> => {
  try {
    const user = req.user as any;
    const id = parseInt(req.params.id);
    if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
    const existing = await pool.query(`SELECT id FROM call_campaigns WHERE id=$1 AND tenant_id=$2`, [id, user.tenantId]);
    if (!existing.rows[0]) { res.status(404).json({ error: "Campaign not found" }); return; }
    await pool.query(`DELETE FROM call_campaigns WHERE id=$1`, [id]);
    res.sendStatus(204);
  } catch (err) { next(err); }
});

// ── GET /call-campaigns/:id/contacts ──────────────────────────────────────────
router.get("/call-campaigns/:id/contacts", async (req, res, next): Promise<void> => {
  try {
    const user = req.user as any;
    const id = parseInt(req.params.id);
    if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
    const existing = await pool.query(`SELECT id FROM call_campaigns WHERE id=$1 AND tenant_id=$2`, [id, user.tenantId]);
    if (!existing.rows[0]) { res.status(404).json({ error: "Campaign not found" }); return; }

    const rows = await pool.query(
      `SELECT ccc.*,
              c.first_name, c.last_name, c.email, c.phone,
              co.name AS company_name,
              cl.outcome, cl.duration_seconds, cl.started_at, cl.ended_at,
              cl.transcript, cl.recording_url,
              ca.recommended_action,
              ca.interest_score,
              ca.sentiment,
              ca.follow_up_message,
              ccw.wave_number
       FROM call_campaign_contacts ccc
       JOIN contacts c ON c.id = ccc.contact_id AND c.tenant_id = ccc.tenant_id
       LEFT JOIN companies co ON co.id = c.company_id
       LEFT JOIN call_logs cl ON (
         (ccc.vapi_call_id IS NOT NULL AND cl.vapi_call_id = ccc.vapi_call_id) OR
         (ccc.retell_call_id IS NOT NULL AND cl.retell_call_id = ccc.retell_call_id)
       )
       LEFT JOIN call_analysis ca ON ca.call_log_id = cl.id AND ca.tenant_id = ccc.tenant_id
       LEFT JOIN call_campaign_waves ccw ON ccw.id = ccc.wave_id
       WHERE ccc.campaign_id = $1
       ORDER BY ccc.created_at DESC`,
      [id],
    );
    res.json(rows.rows);
  } catch (err) { next(err); }
});

// ── POST /call-campaigns/:id/contacts/re-enroll ────────────────────────────────
// Reset selected contacts back to "pending" so they are dialled again in the next wave.
router.post("/call-campaigns/:id/contacts/re-enroll", async (req, res, next): Promise<void> => {
  try {
    const user = req.user as any;
    const id = parseInt(req.params.id);
    if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
    const existing = await pool.query(`SELECT id FROM call_campaigns WHERE id=$1 AND tenant_id=$2`, [id, user.tenantId]);
    if (!existing.rows[0]) { res.status(404).json({ error: "Campaign not found" }); return; }

    const { contactIds } = z.object({ contactIds: z.array(z.number()).min(1) }).parse(req.body);

    const result = await pool.query(
      `UPDATE call_campaign_contacts
          SET status          = 'pending',
              wave_id         = NULL,
              vapi_call_id    = NULL,
              retell_call_id  = NULL,
              failure_reason  = NULL
        WHERE campaign_id = $1
          AND tenant_id   = $2
          AND contact_id  = ANY($3::int[])
        RETURNING id`,
      [id, user.tenantId, contactIds],
    );

    res.json({ reEnrolled: result.rowCount ?? 0 });
  } catch (err) { next(err); }
});

// ── POST /call-campaigns/:id/contacts (add contacts to campaign) ───────────────
router.post("/call-campaigns/:id/contacts", async (req, res, next): Promise<void> => {
  try {
    const user = req.user as any;
    const id = parseInt(req.params.id);
    if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
    const { contactIds } = z.object({ contactIds: z.array(z.number()) }).parse(req.body);

    const existing = await pool.query(`SELECT id FROM call_campaigns WHERE id=$1 AND tenant_id=$2`, [id, user.tenantId]);
    if (!existing.rows[0]) { res.status(404).json({ error: "Campaign not found" }); return; }

    if (contactIds.length === 0) {
      res.json({ ok: true, added: 0, skippedDnc: 0 });
      return;
    }

    // ── DNC guard — identify which contacts are on the do-not-call list ───────
    // A contact is DNC if contacts.dnc = true OR they appear in call_dnc_contacts.
    const dncResult = await pool.query<{ contact_id: number }>(
      `SELECT c.id AS contact_id
       FROM contacts c
       WHERE c.id = ANY($1::int[])
         AND c.tenant_id = $2
         AND (
           c.dnc = true
           OR EXISTS (
             SELECT 1 FROM call_dnc_contacts d
             WHERE d.contact_id = c.id AND d.tenant_id = $2
           )
         )`,
      [contactIds, user.tenantId],
    );
    const dncSet = new Set(dncResult.rows.map(r => r.contact_id));
    const allowedIds = contactIds.filter(cid => !dncSet.has(cid));
    const skippedDnc = contactIds.length - allowedIds.length;

    let added = 0;
    for (const cid of allowedIds) {
      const r = await pool.query(
        `INSERT INTO call_campaign_contacts (campaign_id, contact_id, tenant_id, status)
         VALUES ($1, $2, $3, 'pending')
         ON CONFLICT (campaign_id, contact_id) DO NOTHING
         RETURNING id`,
        [id, cid, user.tenantId],
      );
      if (r.rows[0]) added++;
    }
    res.json({ ok: true, added, skippedDnc });
  } catch (err) { next(err); }
});

// ── DELETE /call-campaigns/:id/contacts/:contactId ────────────────────────────
router.delete("/call-campaigns/:id/contacts/:contactId", async (req, res, next): Promise<void> => {
  try {
    const user = req.user as any;
    const id = parseInt(req.params.id);
    const contactId = parseInt(req.params.contactId);
    if (isNaN(id) || isNaN(contactId)) { res.status(400).json({ error: "Invalid id" }); return; }
    const existing = await pool.query(`SELECT id FROM call_campaigns WHERE id=$1 AND tenant_id=$2`, [id, user.tenantId]);
    if (!existing.rows[0]) { res.status(404).json({ error: "Campaign not found" }); return; }
    await pool.query(`DELETE FROM call_campaign_contacts WHERE campaign_id=$1 AND contact_id=$2`, [id, contactId]);
    res.sendStatus(204);
  } catch (err) { next(err); }
});

// ── POST /call-campaigns/:id/start ────────────────────────────────────────────
// Groups all pending contacts into waves and fires wave 1 immediately.
// Subsequent waves are scheduled for auto-activation by the heartbeat.
router.post("/call-campaigns/:id/start", async (req, res, next): Promise<void> => {
  try {
    const user = req.user as any;
    const id = parseInt(req.params.id);
    if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

    const campRow = await pool.query<{
      id: number; agent_config: any; status: string;
      pitch_template_id: number | null; batch_size: number; wave_gap_minutes: number;
    }>(
      `SELECT id, agent_config, status, pitch_template_id, batch_size, wave_gap_minutes
       FROM call_campaigns WHERE id=$1 AND tenant_id=$2`,
      [id, user.tenantId],
    );
    if (!campRow.rows[0]) { res.status(404).json({ error: "Campaign not found" }); return; }

    const camp = campRow.rows[0];
    const agentConfig = {
      ...(camp.agent_config as any),
      ...(camp.pitch_template_id ? { pitchTemplateId: camp.pitch_template_id } : {}),
    };
    const batchSize = camp.batch_size ?? 3;
    const waveGapMinutes = camp.wave_gap_minutes ?? 6;

    await pool.query(`UPDATE call_campaigns SET status='active', updated_at=NOW() WHERE id=$1`, [id]);

    // Resume any waves that were paused when the campaign was previously paused.
    // The first paused wave becomes 'pending' (fires immediately);
    // subsequent ones are rescheduled relative to now.
    const { rows: pausedWaves } = await pool.query<{ id: number; wave_number: number }>(
      `SELECT id, wave_number FROM call_campaign_waves WHERE campaign_id=$1 AND status='paused' ORDER BY wave_number ASC`,
      [id],
    );
    if (pausedWaves.length > 0) {
      const resumeNow = new Date();
      await pool.query(
        `UPDATE call_campaign_waves SET status='pending', scheduled_at=NULL, updated_at=NOW() WHERE id=$1`,
        [pausedWaves[0].id],
      );
      for (let i = 1; i < pausedWaves.length; i++) {
        const newAt = new Date(resumeNow.getTime() + i * waveGapMinutes * 60 * 1000);
        await pool.query(
          `UPDATE call_campaign_waves SET status='scheduled', scheduled_at=$1, updated_at=NOW() WHERE id=$2`,
          [newAt, pausedWaves[i].id],
        );
      }
    }

    // Build waves for any newly added contacts (wave_id IS NULL)
    const { waveCount, contactCount } = await buildWaves(id, user.tenantId, batchSize, waveGapMinutes);

    // Execute the first pending wave (resumed or newly built, whichever comes first)
    const { rows: [waveToRun] } = await pool.query<{ id: number }>(
      `SELECT id FROM call_campaign_waves WHERE campaign_id=$1 AND status='pending' ORDER BY wave_number ASC LIMIT 1`,
      [id],
    );

    if (!waveToRun) {
      const hasScheduled = await pool.query(
        `SELECT 1 FROM call_campaign_waves WHERE campaign_id=$1 AND status='scheduled' LIMIT 1`,
        [id],
      );
      if (hasScheduled.rows[0]) {
        res.json({ ok: true, initiated: 0, failed: 0, blocked: 0, waveCount, contactCount, message: "Campaign resumed — scheduled waves will fire via the heartbeat." });
      } else {
        res.json({ ok: false, initiated: 0, failed: 0, blocked: 0, waveCount: 0, message: "No pending contacts found." });
      }
      return;
    }

    const { initiated, failed, blocked } = await executeWave(waveToRun.id, id, user.tenantId, agentConfig, batchSize);

    logger.info({ campaignId: id, waveCount, contactCount, initiated, failed, blocked }, "Campaign started with waves");

    const parts: string[] = [];
    if (waveCount > 1) parts.push(`${contactCount} contacts split into ${waveCount} waves of ${batchSize} each`);
    if (initiated > 0) parts.push(`${initiated} call${initiated !== 1 ? "s" : ""} initiated (wave 1)`);
    if (blocked > 0)   parts.push(`${blocked} blocked`);
    if (failed > 0)    parts.push(`${failed} failed`);
    if (waveCount > 1) parts.push(`waves 2–${waveCount} scheduled ~${waveGapMinutes} min apart`);
    const message = parts.length ? parts.join(" · ") + "." : "No pending contacts found.";

    res.json({ ok: initiated > 0 || (failed === 0 && blocked === 0), initiated, failed, blocked, waveCount, contactCount, message });
  } catch (err) { next(err); }
});

// ── GET /call-campaigns/:id/waves ─────────────────────────────────────────────
router.get("/call-campaigns/:id/waves", async (req, res, next): Promise<void> => {
  try {
    const user = req.user as any;
    const id = parseInt(req.params.id);
    if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
    const existing = await pool.query(`SELECT id FROM call_campaigns WHERE id=$1 AND tenant_id=$2`, [id, user.tenantId]);
    if (!existing.rows[0]) { res.status(404).json({ error: "Campaign not found" }); return; }

    const rows = await pool.query(
      `SELECT ccw.*,
              COUNT(ccc.id)::int AS contact_count,
              COUNT(ccc.id) FILTER (WHERE ccc.status='pending')::int AS pending_count,
              COUNT(ccc.id) FILTER (WHERE ccc.status='calling')::int AS calling_count,
              COUNT(ccc.id) FILTER (WHERE ccc.status='done')::int AS done_count,
              COUNT(ccc.id) FILTER (WHERE ccc.status='failed')::int AS failed_count,
              COUNT(ccc.id) FILTER (WHERE ccc.status='blocked')::int AS blocked_count,
              COALESCE(
                ARRAY_AGG(
                  TRIM(CONCAT_WS(' ', c.first_name, c.last_name))
                  ORDER BY ccc.last_attempted_at DESC NULLS LAST
                ) FILTER (WHERE ccc.status='calling'),
                ARRAY[]::text[]
              ) AS calling_contact_names
       FROM call_campaign_waves ccw
       LEFT JOIN call_campaign_contacts ccc ON ccc.wave_id = ccw.id
       LEFT JOIN contacts c ON c.id = ccc.contact_id AND c.tenant_id = ccw.tenant_id
       WHERE ccw.campaign_id = $1
       GROUP BY ccw.id
       ORDER BY ccw.wave_number ASC`,
      [id],
    );
    res.json(rows.rows);
  } catch (err) { next(err); }
});

// ── POST /call-campaigns/:id/waves/:waveId/start ──────────────────────────────
// Manually trigger a pending/scheduled wave immediately.
// Reschedules all subsequent scheduled waves relative to now.
router.post("/call-campaigns/:id/waves/:waveId/start", async (req, res, next): Promise<void> => {
  try {
    const user = req.user as any;
    const id = parseInt(req.params.id);
    const waveId = parseInt(req.params.waveId);
    if (isNaN(id) || isNaN(waveId)) { res.status(400).json({ error: "Invalid id" }); return; }

    const campRow = await pool.query<{
      id: number; agent_config: any; pitch_template_id: number | null;
      batch_size: number; wave_gap_minutes: number; status: string;
    }>(
      `SELECT id, agent_config, pitch_template_id, batch_size, wave_gap_minutes, status
       FROM call_campaigns WHERE id=$1 AND tenant_id=$2`,
      [id, user.tenantId],
    );
    if (!campRow.rows[0]) { res.status(404).json({ error: "Campaign not found" }); return; }
    const camp = campRow.rows[0];

    // Reject if campaign is not active — a paused/completed campaign's waves should not fire.
    if (camp.status !== "active") {
      res.status(409).json({ error: `Campaign must be active to start a wave (current status: ${camp.status})` });
      return;
    }

    const waveRow = await pool.query<{ id: number; wave_number: number; status: string }>(
      `SELECT id, wave_number, status FROM call_campaign_waves WHERE id=$1 AND campaign_id=$2`,
      [waveId, id],
    );
    if (!waveRow.rows[0]) { res.status(404).json({ error: "Wave not found" }); return; }
    if (!["pending", "scheduled"].includes(waveRow.rows[0].status)) {
      res.status(409).json({ error: `Wave is already ${waveRow.rows[0].status}` }); return;
    }

    const agentConfig = {
      ...(camp.agent_config ?? {}),
      ...(camp.pitch_template_id ? { pitchTemplateId: camp.pitch_template_id } : {}),
    };
    const batchSize = camp.batch_size ?? 3;
    const waveGapMinutes = camp.wave_gap_minutes ?? 6;

    // Reschedule all later scheduled waves relative to now
    const now = new Date();
    const { rows: laterWaves } = await pool.query<{ id: number; wave_number: number }>(
      `SELECT id, wave_number FROM call_campaign_waves
       WHERE campaign_id=$1 AND wave_number > $2 AND status='scheduled'
       ORDER BY wave_number ASC`,
      [id, waveRow.rows[0].wave_number],
    );
    for (let i = 0; i < laterWaves.length; i++) {
      const newScheduledAt = new Date(now.getTime() + (i + 1) * waveGapMinutes * 60 * 1000);
      await pool.query(
        `UPDATE call_campaign_waves SET scheduled_at=$1, updated_at=NOW() WHERE id=$2`,
        [newScheduledAt, laterWaves[i].id],
      );
    }

    const { initiated, failed, blocked } = await executeWave(waveId, id, user.tenantId, agentConfig, batchSize);

    const message = `Wave ${waveRow.rows[0].wave_number} started: ${initiated} initiated, ${blocked} blocked, ${failed} failed.`;
    res.json({ ok: true, initiated, failed, blocked, message });
  } catch (err) { next(err); }
});

// ── POST /call-campaigns/:id/waves/:waveId/pause ──────────────────────────────
router.post("/call-campaigns/:id/waves/:waveId/pause", async (req, res, next): Promise<void> => {
  try {
    const user = req.user as any;
    const id = parseInt(req.params.id);
    const waveId = parseInt(req.params.waveId);
    if (isNaN(id) || isNaN(waveId)) { res.status(400).json({ error: "Invalid id" }); return; }

    const existing = await pool.query(`SELECT id FROM call_campaigns WHERE id=$1 AND tenant_id=$2`, [id, user.tenantId]);
    if (!existing.rows[0]) { res.status(404).json({ error: "Campaign not found" }); return; }

    const result = await pool.query<{ id: number }>(
      `UPDATE call_campaign_waves SET status='paused', updated_at=NOW()
       WHERE id=$1 AND campaign_id=$2 AND status IN ('active','scheduled','pending')
       RETURNING id`,
      [waveId, id],
    );
    if (!result.rows[0]) { res.status(409).json({ error: "Wave cannot be paused in its current state" }); return; }

    res.json({ ok: true, message: "Wave paused. Pending contacts in this wave will not be dialled until resumed." });
  } catch (err) { next(err); }
});

// ── POST /call-campaigns/:id/waves/:waveId/resume ─────────────────────────────
router.post("/call-campaigns/:id/waves/:waveId/resume", async (req, res, next): Promise<void> => {
  try {
    const user = req.user as any;
    const id = parseInt(req.params.id);
    const waveId = parseInt(req.params.waveId);
    if (isNaN(id) || isNaN(waveId)) { res.status(400).json({ error: "Invalid id" }); return; }

    const campRow = await pool.query<{ agent_config: any; pitch_template_id: number | null; batch_size: number; provider: string }>(
      `SELECT agent_config, pitch_template_id, batch_size, provider FROM call_campaigns WHERE id=$1 AND tenant_id=$2`,
      [id, user.tenantId],
    );
    if (!campRow.rows[0]) { res.status(404).json({ error: "Campaign not found" }); return; }
    const camp = campRow.rows[0];

    const waveRow = await pool.query<{ id: number; status: string }>(
      `SELECT id, status FROM call_campaign_waves WHERE id=$1 AND campaign_id=$2`,
      [waveId, id],
    );
    if (!waveRow.rows[0]) { res.status(404).json({ error: "Wave not found" }); return; }
    if (waveRow.rows[0].status !== "paused") {
      res.status(409).json({ error: `Wave is not paused (current status: ${waveRow.rows[0].status})` }); return;
    }

    const agentConfig = {
      ...(camp.agent_config ?? {}),
      ...(camp.pitch_template_id ? { pitchTemplateId: camp.pitch_template_id } : {}),
    };
    const batchSize = camp.batch_size ?? 3;

    const resumeProvider = camp.provider ?? "vapi";
    const { initiated, failed, blocked } = await executeWave(waveId, id, user.tenantId, agentConfig, batchSize, resumeProvider);
    res.json({ ok: true, initiated, failed, blocked, message: `Wave resumed: ${initiated} initiated.` });
  } catch (err) { next(err); }
});

// ── GET /call-campaigns/:id/logs ──────────────────────────────────────────────
router.get("/call-campaigns/:id/logs", async (req, res, next): Promise<void> => {
  try {
    const user = req.user as any;
    const id = parseInt(req.params.id);
    if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
    const existing = await pool.query(`SELECT id FROM call_campaigns WHERE id=$1 AND tenant_id=$2`, [id, user.tenantId]);
    if (!existing.rows[0]) { res.status(404).json({ error: "Campaign not found" }); return; }

    const rows = await pool.query(
      `SELECT cl.*,
              c.first_name, c.last_name, c.email, c.phone,
              co.name AS company_name,
              ca.recommended_action,
              ca.interest_score,
              ca.sentiment,
              ca.action_timing,
              ca.follow_up_message,
              ca.owning_team
       FROM call_logs cl
       LEFT JOIN contacts c   ON c.id  = cl.contact_id AND c.tenant_id = cl.tenant_id
       LEFT JOIN companies co ON co.id = c.company_id
       LEFT JOIN call_analysis ca ON ca.call_log_id = cl.id AND ca.tenant_id = cl.tenant_id
       WHERE cl.campaign_id = $1 AND cl.tenant_id = $2
       ORDER BY cl.created_at DESC`,
      [id, user.tenantId],
    );
    res.json(rows.rows);
  } catch (err) { next(err); }
});

// ── POST /call-campaigns/:id/logs/:logId/analyse ──────────────────────────
router.post("/call-campaigns/:id/logs/:logId/analyse", async (req, res, next): Promise<void> => {
  try {
    const user = req.user as any;
    const campaignId = parseInt(req.params.id);
    const logId      = parseInt(req.params.logId);
    if (isNaN(campaignId) || isNaN(logId)) { res.status(400).json({ error: "Invalid id" }); return; }

    const logRows = await pool.query(
      `SELECT cl.*, c.first_name, c.last_name, co.name AS company_name
       FROM call_logs cl
       LEFT JOIN contacts c  ON c.id  = cl.contact_id AND c.tenant_id = cl.tenant_id
       LEFT JOIN companies co ON co.id = c.company_id
       WHERE cl.id = $1 AND cl.campaign_id = $2 AND cl.tenant_id = $3`,
      [logId, campaignId, user.tenantId],
    );
    const log = logRows.rows[0];
    if (!log) { res.status(404).json({ error: "Log not found" }); return; }

    const transcriptText: string =
      typeof log.transcript === "string"
        ? (() => { try { return JSON.parse(log.transcript)?.text ?? log.transcript; } catch { return log.transcript; } })()
        : (log.transcript as any)?.text ?? "";

    if (!transcriptText) {
      res.status(422).json({ error: "No transcript available for this call" });
      return;
    }

    const contactName = [log.first_name, log.last_name].filter(Boolean).join(" ") || "The contact";
    res.json({ ok: true, message: "LLM analysis queued" });

    const { analyseTranscriptLLM } = await import("../lib/transcriptAnalyserLLM");
    analyseTranscriptLLM({
      callLogId: logId,
      tenantId: user.tenantId,
      contactId: log.contact_id ?? null,
      transcript: transcriptText,
      outcome: log.outcome ?? null,
      durationSeconds: log.duration_seconds != null ? Number(log.duration_seconds) : null,
      contactName,
      companyName: log.company_name ?? null,
    }).catch(() => {});
  } catch (err) { next(err); }
});

// ── GET /call-campaigns/:id/logs/:logId/analysis ───────────────────────────
router.get("/call-campaigns/:id/logs/:logId/analysis", async (req, res, next): Promise<void> => {
  try {
    const user = req.user as any;
    const campaignId = parseInt(req.params.id);
    const logId      = parseInt(req.params.logId);
    if (isNaN(campaignId) || isNaN(logId)) { res.status(400).json({ error: "Invalid id" }); return; }

    const logCheck = await pool.query(
      `SELECT id FROM call_logs WHERE id = $1 AND campaign_id = $2 AND tenant_id = $3`,
      [logId, campaignId, user.tenantId],
    );
    if (!logCheck.rows[0]) { res.status(404).json({ error: "Log not found" }); return; }

    const rows = await pool.query(
      `SELECT * FROM call_analysis WHERE call_log_id = $1 AND tenant_id = $2`,
      [logId, user.tenantId],
    );
    if (!rows.rows[0]) { res.status(404).json({ error: "No analysis found" }); return; }
    res.json(rows.rows[0]);
  } catch (err) { next(err); }
});

// ── GET /call-campaigns/:id/analytics ─────────────────────────────────────
router.get("/call-campaigns/:id/analytics", async (req, res, next): Promise<void> => {
  try {
    const user = req.user as any;
    const id = parseInt(req.params.id);
    if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

    const check = await pool.query(
      `SELECT id FROM call_campaigns WHERE id=$1 AND tenant_id=$2`,
      [id, user.tenantId],
    );
    if (!check.rows[0]) { res.status(404).json({ error: "Campaign not found" }); return; }

    const BASE_CTE = `
      WITH calls AS (
        SELECT
          cl.id,
          cl.outcome,
          cl.duration_seconds,
          cl.ended_reason,
          cl.started_at,
          CASE
            WHEN cl.outcome = 'answered'
              AND (cl.duration_seconds IS NULL OR cl.duration_seconds >= 60)
              AND cl.ended_reason NOT IN ('silence','customer-did-not-answer','customer-busy','no-answer')
            THEN 'positive'
            WHEN cl.outcome = 'answered'
            THEN 'negative'
            ELSE 'no_contact'
          END AS sentiment,
          EXTRACT(DOW   FROM cl.started_at AT TIME ZONE 'UTC') AS dow,
          EXTRACT(HOUR  FROM cl.started_at AT TIME ZONE 'UTC') AS hour
        FROM call_logs cl
        WHERE cl.campaign_id = $1
          AND cl.tenant_id   = $2
          AND cl.status IN ('completed','blocked')
          AND cl.started_at IS NOT NULL
      )
    `;

    const [summaryRes, dowRes, hourRes] = await Promise.all([
      pool.query(
        `${BASE_CTE}
         SELECT
           COUNT(*)                                              AS total_calls,
           COUNT(*) FILTER (WHERE outcome = 'answered')         AS answered,
           ROUND(
             COUNT(*) FILTER (WHERE outcome = 'answered') * 100.0 / NULLIF(COUNT(*),0), 1
           )                                                     AS answer_rate,
           ROUND(AVG(duration_seconds) FILTER (WHERE outcome = 'answered'))
                                                                AS avg_duration_seconds,
           COUNT(*) FILTER (WHERE sentiment = 'positive')       AS positive_count,
           COUNT(*) FILTER (WHERE sentiment = 'negative')       AS negative_count,
           ROUND(
             COUNT(*) FILTER (WHERE sentiment = 'positive') * 100.0
               / NULLIF(COUNT(*) FILTER (WHERE outcome = 'answered'), 0), 1
           )                                                     AS positive_rate
         FROM calls`,
        [id, user.tenantId],
      ),
      pool.query(
        `${BASE_CTE}
         SELECT
           dow,
           TO_CHAR(
             DATE_TRUNC('week', NOW()) + (dow || ' days')::INTERVAL,
             'Dy'
           )                                                     AS day_label,
           COUNT(*)                                              AS total_calls,
           COUNT(*) FILTER (WHERE outcome = 'answered')         AS answered,
           ROUND(
             COUNT(*) FILTER (WHERE outcome = 'answered') * 100.0 / NULLIF(COUNT(*),0), 1
           )                                                     AS answer_rate,
           ROUND(AVG(duration_seconds) FILTER (WHERE outcome = 'answered'))
                                                                AS avg_duration_seconds,
           COUNT(*) FILTER (WHERE sentiment = 'positive')       AS positive_count,
           COUNT(*) FILTER (WHERE sentiment = 'negative')       AS negative_count
         FROM calls
         GROUP BY dow
         ORDER BY dow`,
        [id, user.tenantId],
      ),
      pool.query(
        `${BASE_CTE}
         SELECT
           hour,
           COUNT(*)                                              AS total_calls,
           COUNT(*) FILTER (WHERE outcome = 'answered')         AS answered,
           ROUND(
             COUNT(*) FILTER (WHERE outcome = 'answered') * 100.0 / NULLIF(COUNT(*),0), 1
           )                                                     AS answer_rate,
           ROUND(AVG(duration_seconds) FILTER (WHERE outcome = 'answered'))
                                                                AS avg_duration_seconds,
           COUNT(*) FILTER (WHERE sentiment = 'positive')       AS positive_count,
           COUNT(*) FILTER (WHERE sentiment = 'negative')       AS negative_count
         FROM calls
         GROUP BY hour
         ORDER BY hour`,
        [id, user.tenantId],
      ),
    ]);

    const s = summaryRes.rows[0];
    res.json({
      summary: {
        totalCalls:         Number(s.total_calls),
        answeredCalls:      Number(s.answered),
        answerRate:         Number(s.answer_rate ?? 0),
        avgDurationSeconds: Number(s.avg_duration_seconds ?? 0),
        positiveCount:      Number(s.positive_count),
        negativeCount:      Number(s.negative_count),
        positiveRate:       Number(s.positive_rate ?? 0),
      },
      byDayOfWeek: dowRes.rows.map(r => ({
        dow:               Number(r.dow),
        dayLabel:          r.day_label as string,
        totalCalls:        Number(r.total_calls),
        answered:          Number(r.answered),
        answerRate:        Number(r.answer_rate ?? 0),
        avgDurationSeconds: Number(r.avg_duration_seconds ?? 0),
        positiveCount:     Number(r.positive_count),
        negativeCount:     Number(r.negative_count),
      })),
      byHourOfDay: hourRes.rows.map(r => ({
        hour:               Number(r.hour),
        totalCalls:         Number(r.total_calls),
        answered:           Number(r.answered),
        answerRate:         Number(r.answer_rate ?? 0),
        avgDurationSeconds: Number(r.avg_duration_seconds ?? 0),
        positiveCount:      Number(r.positive_count),
        negativeCount:      Number(r.negative_count),
      })),
    });
  } catch (err) { next(err); }
});

// ── POST /call-campaigns/:id/logs/:logId/summarize ────────────────────────
router.post("/call-campaigns/:id/logs/:logId/summarize", async (req, res, next): Promise<void> => {
  try {
    const user = req.user as any;
    const campaignId = parseInt(req.params.id);
    const logId      = parseInt(req.params.logId);
    if (isNaN(campaignId) || isNaN(logId)) { res.status(400).json({ error: "Invalid id" }); return; }

    const logRows = await pool.query(
      `SELECT cl.*, c.first_name, c.last_name, co.name AS company_name
       FROM call_logs cl
       LEFT JOIN contacts c  ON c.id  = cl.contact_id AND c.tenant_id = cl.tenant_id
       LEFT JOIN companies co ON co.id = c.company_id
       WHERE cl.id = $1 AND cl.campaign_id = $2 AND cl.tenant_id = $3`,
      [logId, campaignId, user.tenantId],
    );
    const log = logRows.rows[0];
    if (!log) { res.status(404).json({ error: "Log not found" }); return; }

    if (log.ai_summary) {
      res.json({ aiSummary: log.ai_summary, aiNextSteps: log.ai_next_steps });
      return;
    }

    const transcriptText: string =
      typeof log.transcript === "string"
        ? JSON.parse(log.transcript)?.text ?? log.transcript
        : (log.transcript as any)?.text ?? "";

    if (!transcriptText) {
      res.json({ aiSummary: "No transcript available for this call.", aiNextSteps: "" });
      return;
    }

    const contactName = [log.first_name, log.last_name].filter(Boolean).join(" ") || "The contact";
    const { aiSummary, aiNextSteps } = analyseTranscript(
      transcriptText,
      log.outcome ?? null,
      log.duration_seconds != null ? Number(log.duration_seconds) : null,
      contactName,
      log.company_name ?? null,
    );

    await pool.query(
      `UPDATE call_logs SET ai_summary = $1, ai_next_steps = $2 WHERE id = $3 AND tenant_id = $4`,
      [aiSummary, aiNextSteps, logId, user.tenantId],
    );

    res.json({ aiSummary, aiNextSteps });
  } catch (err) { next(err); }
});

export default router;

// Re-export for type use in vapi service
type VapiCallConfig = import("../services/vapi").VapiCallConfig;
export { CALL_SCORE_DELTAS };
