/**
 * POST /api/admin/resend-backfill
 *
 * One-shot (and idempotent) backfill of historical Resend email events into
 * KABOOM's activity_events + scoring system.
 *
 * Resend's list-emails API returns one record per sent email with a `last_event`
 * field showing the highest-priority event that occurred (clicked > opened >
 * delivered > sent).  We translate that into KABOOM activity + score updates.
 *
 * Dedup: each processed Resend email ID is stored in email_events.metadata so
 * re-running the backfill is safe — already-processed emails are skipped.
 *
 * Usage:
 *   POST /api/admin/resend-backfill          — process last 30 days, max 500 emails
 *   POST /api/admin/resend-backfill?days=60  — extend look-back window
 *   POST /api/admin/resend-backfill?limit=1000 — raise email cap
 */

import { Router, type IRouter } from "express";
import { getIntegrationConfig } from "../lib/integrationCredentials";
import { pool, db } from "@workspace/db";
import { requireAuth, requireRole } from "../middlewares/requireAuth";
import { logger } from "../lib/logger";
import { computeIntentScore, SCORE_SOURCES } from "../lib/intentScoring";

const router: IRouter = Router();
router.use(requireAuth);

type AuthUser = { tenantId: number; id: number; role: string };

// ── Audit log helper ───────────────────────────────────────────────────────────

export async function recordBackfillRun(opts: {
  tenantId: number;
  triggeredBy: number;
  source: string;
  totalRows: number;
  updated: number;
  skipped: number;
  unmatched: number;
  extra?: Record<string, unknown>;
}): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO backfill_runs
         (tenant_id, triggered_by, source, total_rows, updated, skipped, unmatched, extra)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        opts.tenantId,
        opts.triggeredBy,
        opts.source,
        opts.totalRows,
        opts.updated,
        opts.skipped,
        opts.unmatched,
        JSON.stringify(opts.extra ?? {}),
      ]
    );
  } catch (err) {
    logger.warn({ err }, "recordBackfillRun: failed to insert audit row");
  }
}

// ── GET /admin/backfill-runs ───────────────────────────────────────────────────

router.get("/admin/backfill-runs/:id/contacts", requireRole("admin"), async (req, res, next): Promise<void> => {
  const user = req.user as AuthUser;
  const runId = parseInt(String(req.params.id), 10);
  if (isNaN(runId)) { res.status(400).json({ error: "Invalid run id" }); return; }
  try {
    const { rows: runRows } = await pool.query<{ extra: Record<string, unknown> }>(
      `SELECT extra FROM backfill_runs WHERE id = $1 AND tenant_id = $2 LIMIT 1`,
      [runId, user.tenantId]
    );
    if (!runRows[0]) { res.status(404).json({ error: "Run not found" }); return; }

    const rawContacts: Array<{ id: number; action: string; email?: string }> =
      Array.isArray((runRows[0].extra as any)?.contacts)
        ? ((runRows[0].extra as any).contacts as any[])
        : [];

    if (rawContacts.length === 0) { res.json([]); return; }

    const ids = rawContacts.filter(c => c.id > 0).map(c => c.id);
    const nameMap = new Map<number, { first_name: string; last_name: string; email: string }>();

    if (ids.length > 0) {
      const { rows: cRows } = await pool.query<{ id: number; first_name: string; last_name: string; email: string }>(
        `SELECT id, COALESCE(first_name, '') AS first_name, COALESCE(last_name, '') AS last_name, email
         FROM contacts WHERE id = ANY($1::int[]) AND tenant_id = $2`,
        [ids, user.tenantId]
      );
      for (const c of cRows) nameMap.set(c.id, c);
    }

    const result = rawContacts.map(c => {
      if (c.id > 0) {
        const info = nameMap.get(c.id);
        return {
          id: c.id,
          action: c.action,
          email: info?.email ?? c.email ?? "",
          name: info ? `${info.first_name} ${info.last_name}`.trim() || info.email : (c.email ?? ""),
        };
      }
      return { id: 0, action: c.action, email: c.email ?? "", name: "—" };
    });

    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.get("/admin/backfill-runs", requireRole("admin"), async (req, res, next): Promise<void> => {
  const user = req.user as AuthUser;
  try {
    const { from, to, source } = req.query as Record<string, string | undefined>;

    const conditions: string[] = ["br.tenant_id = $1"];
    const params: unknown[] = [user.tenantId];
    let idx = 2;

    if (from) {
      conditions.push(`br.created_at >= $${idx++}::timestamptz`);
      params.push(from);
    }
    if (to) {
      // inclusive upper bound: treat the "to" date as end-of-day
      conditions.push(`br.created_at < ($${idx++}::date + INTERVAL '1 day')`);
      params.push(to);
    }
    if (source && source !== "all") {
      conditions.push(`br.source = $${idx++}`);
      params.push(source);
    }

    const where = conditions.join(" AND ");

    const { rows } = await pool.query<{
      id: number;
      triggered_by: number | null;
      triggered_by_email: string | null;
      source: string;
      total_rows: number;
      updated: number;
      skipped: number;
      unmatched: number;
      extra: Record<string, unknown>;
      created_at: string;
    }>(
      `SELECT br.id, br.triggered_by, u.email AS triggered_by_email,
              br.source, br.total_rows, br.updated, br.skipped, br.unmatched,
              br.extra, br.created_at
       FROM backfill_runs br
       LEFT JOIN users u ON u.id = br.triggered_by
       WHERE ${where}
       ORDER BY br.created_at DESC
       LIMIT 50`,
      params
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// ── helpers ────────────────────────────────────────────────────────────────────

async function getResendApiKey(tenantId: number): Promise<string | null> {
  const config = await getIntegrationConfig(tenantId, "resend");
  const key = config?.apiKey;
  if (typeof key === "string" && key) return key;
  return process.env.RESEND_API_KEY ?? null;
}

async function getOrCreateContactId(
  email: string,
  tenantId: number
): Promise<number | null> {
  const norm = email.toLowerCase().trim();
  const { rows } = await pool.query<{ id: number }>(
    `SELECT id FROM contacts WHERE LOWER(email) = $1 AND tenant_id = $2 LIMIT 1`,
    [norm, tenantId]
  );
  if (rows[0]) return rows[0].id;

  // Auto-create a minimal contact so opens/clicks/journey visits are attributed.
  // Derive first name from the local-part (e.g. "arindam" from "arindam@domain.in").
  const localPart = norm.split("@")[0] ?? "";
  const firstName = localPart
    .split(/[._\-+]/)
    .filter(Boolean)
    .map(s => s.charAt(0).toUpperCase() + s.slice(1))
    .join(" ");
  const companyHint = norm.split("@")[1]?.split(".")[0] ?? "";

  const ins = await pool.query<{ id: number }>(
    `INSERT INTO contacts
       (tenant_id, email, first_name, company_name, source,
        status, stage, tags, lead_score, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'resend_backfill',
             'active', 'pre-aware', '{}', 0, NOW(), NOW())
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [tenantId, norm, firstName || localPart, companyHint]
  );
  if (ins.rows[0]) {
    logger.info({ email: norm, contactId: ins.rows[0].id }, "Resend backfill: auto-created contact");
    return ins.rows[0].id;
  }
  // Race: re-fetch if another request created it first
  const retry = await pool.query<{ id: number }>(
    `SELECT id FROM contacts WHERE LOWER(email) = $1 AND tenant_id = $2 LIMIT 1`,
    [norm, tenantId]
  );
  return retry.rows[0]?.id ?? null;
}

/**
 * Link anonymous visitor_tokens from journey_events to a contact.
 * When someone clicks a tracked email link and browses the journey,
 * their visitor_token is unlinked (anonymous). If journey_events fall
 * within a ±4 h window of the email event, it's almost certainly them.
 */
async function linkJourneyVisits(
  contactId: number,
  tenantId: number,
  occurredAt: Date
): Promise<number> {
  const res = await pool.query<{ count: string }>(
    `WITH inserted AS (
       INSERT INTO visitor_tokens (token, contact_id, tenant_id, created_at)
       SELECT DISTINCT je.visitor_token, $1::int, $2::int, NOW()
       FROM journey_events je
       WHERE je.tenant_id = $2::int
         AND je.visitor_token IS NOT NULL
         AND je.visitor_token <> ''
         AND je.created_at BETWEEN $3::timestamptz - INTERVAL '2 hours'
                                AND $3::timestamptz + INTERVAL '48 hours'
         AND NOT EXISTS (
           SELECT 1 FROM visitor_tokens vt WHERE vt.token = je.visitor_token
         )
       LIMIT 1
       ON CONFLICT (token) DO NOTHING
       RETURNING 1
     )
     SELECT COUNT(*)::text AS count FROM inserted`,
    [contactId, tenantId, occurredAt]
  );
  // Note: LIMIT 1 in the SELECT ensures only one token is claimed per call,
  // leaving remaining unlinked tokens for other contacts in the same batch.
  return parseInt(res.rows[0]?.count ?? "0", 10);
}

/**
 * If a contact has email open/click events but no journey visits yet,
 * check whether another contact was over-attributed (got >1 token from the
 * same time window) and reassign one of their tokens to this contact.
 * This handles the case where multiple recipients receive the same batch email
 * and visit the same journey at nearly the same time.
 */
async function rebalanceTokenForContact(
  contactId: number,
  tenantId: number,
  occurredAt: Date
): Promise<number> {
  const hasVisits = await pool.query(
    `SELECT 1 FROM visitor_tokens vt
     JOIN journey_events je ON je.visitor_token = vt.token
     WHERE vt.contact_id = $1 LIMIT 1`,
    [contactId]
  );
  if (hasVisits.rows.length > 0) return 0;

  const res = await pool.query<{ token: string }>(
    `UPDATE visitor_tokens
     SET contact_id = $1::int
     WHERE token = (
       SELECT vt.token
       FROM visitor_tokens vt
       WHERE vt.contact_id != $1::int
         AND vt.tenant_id = $2::int
         AND vt.contact_id IN (
           SELECT DISTINCT ae.contact_id FROM activity_events ae
           WHERE ae.event_type IN ('email_open','email_click')
             AND ae.created_at BETWEEN $3::timestamptz - INTERVAL '2 hours'
                                   AND $3::timestamptz + INTERVAL '48 hours'
             AND ae.tenant_id = $2::int
             AND ae.contact_id != $1::int
         )
         AND (
           SELECT COUNT(*) FROM visitor_tokens vt2
           WHERE vt2.contact_id = vt.contact_id
             AND EXISTS (SELECT 1 FROM journey_events je WHERE je.visitor_token = vt2.token)
         ) > 1
       ORDER BY (
         SELECT COUNT(*) FROM journey_events je WHERE je.visitor_token = vt.token
       ) ASC
       LIMIT 1
     )
     RETURNING token`,
    [contactId, tenantId, occurredAt]
  );
  return res.rows.length;
}

/**
 * Retroactively score page_view events using each page's own score value
 * (journey_pages.score), exactly as the live public API does.
 * Falls back to scoring_rules only if the page has no score set.
 */
async function scoreLinkedPageViews(
  contactId: number,
  tenantId: number
): Promise<void> {
  const { rows: pageViews } = await pool.query<{
    created_at: Date;
    page_title: string;
    page_stage: string | null;
    score: number;
  }>(
    `SELECT DISTINCT ON (je.page_id) je.created_at,
            COALESCE(jp.title, 'Journey Page') AS page_title,
            jp.page_stage,
            COALESCE(jp.score, 0) AS score
     FROM journey_events je
     JOIN journey_pages jp ON jp.id = je.page_id
     WHERE je.visitor_token IN (
       SELECT token FROM visitor_tokens WHERE contact_id = $1
     )
     AND je.event_type = 'page_view'
     AND je.tenant_id = $2::int
     AND NOT EXISTS (
       SELECT 1 FROM activity_events ae
       WHERE ae.contact_id = $1
         AND ae.event_type = 'page_view'
         AND ABS(EXTRACT(EPOCH FROM ae.created_at - je.created_at)) < 300
     )
     ORDER BY je.page_id, je.created_at`,
    [contactId, tenantId]
  );

  for (const pv of pageViews) {
    const pts = pv.score ?? 0;
    const description = pv.page_stage
      ? `Page viewed — stage: ${pv.page_stage}`
      : `Page viewed: ${pv.page_title}`;

    if (pts !== 0) {
      await pool.query(
        `UPDATE contacts
         SET lead_score = GREATEST(0, COALESCE(lead_score, 0) + $1),
             last_activity = $2
         WHERE id = $3 AND tenant_id = $4`,
        [pts, pv.created_at, contactId, tenantId]
      );
    }

    await pool.query(
      `INSERT INTO activity_events
         (tenant_id, contact_id, event_type, description, source, score_delta, created_at)
       VALUES ($1, $2, 'page_view', $3, 'backfill', $4, $5)`,
      [tenantId, contactId, description, pts, pv.created_at]
    );
  }
}

async function alreadyProcessed(
  resendEmailId: string,
  tenantId: number
): Promise<boolean> {
  const { rows } = await pool.query<{ id: number }>(
    `SELECT id FROM email_events
     WHERE tenant_id = $1
       AND metadata->>'resendEmailId' = $2
     LIMIT 1`,
    [tenantId, resendEmailId]
  );
  return rows.length > 0;
}

async function recordBackfillActivity(opts: {
  tenantId: number;
  contactId: number;
  activityEventType: string;
  description: string;
  occurredAt: Date;
}): Promise<void> {
  const { tenantId, contactId, activityEventType, description, occurredAt } = opts;

  const { rows: ruleRows } = await pool.query<{ points: number }>(
    `SELECT points FROM scoring_rules
     WHERE event_type = $1 AND is_active = 'true'
     ORDER BY id LIMIT 1`,
    [activityEventType]
  );
  const points: number = ruleRows[0]?.points ?? 0;

  const { rows: contactRows } = await pool.query<{ lead_score: number }>(
    `SELECT lead_score FROM contacts WHERE id = $1 AND tenant_id = $2 LIMIT 1`,
    [contactId, tenantId]
  );
  const oldScore = Number(contactRows[0]?.lead_score ?? 0);
  const newScore = Math.max(0, oldScore + points);

  if (points !== 0) {
    await pool.query(
      `UPDATE contacts SET lead_score = GREATEST(0, COALESCE(lead_score, 0) + $1),
                           last_activity = $2
       WHERE id = $3 AND tenant_id = $4`,
      [points, occurredAt, contactId, tenantId]
    );
  }

  await pool.query(
    `INSERT INTO activity_events
       (tenant_id, contact_id, event_type, description, source, score_delta, created_at)
     VALUES ($1, $2, $3, $4, 'email', $5, $6)`,
    [tenantId, contactId, activityEventType, description, points, occurredAt]
  );

  // Pass source:BACKFILL so computeIntentScore skips routing rule evaluation.
  // recordBackfillActivity is always called from a historical correction path —
  // firing routing rules here could enroll contacts in journeys or sequences
  // they are not ready for, or reset added_at for contacts already mid-sequence.
  computeIntentScore(contactId, tenantId, { source: SCORE_SOURCES.BACKFILL })
    .catch(err => logger.warn({ err }, "computeIntentScore failed during backfill"));
}

// ── row-based CSV backfill helper ───────────────────────────────────────────────

type CsvInputRow = { email: string; clickedAt?: string | null };

function isPreAwareStage(stage: string | null): boolean {
  const STAGE_RANK: Record<string, number> = {
    "pre-aware": 0, aware: 1, engaged: 2, "sales-ready": 3, customer: 4,
  };
  const rank = STAGE_RANK[stage ?? "pre-aware"] ?? 0;
  return rank < STAGE_RANK["aware"];
}

async function handleRowsBackfill(
  tenantId: number,
  inputRows: CsvInputRow[],
  isDryRun: boolean
): Promise<Record<string, unknown>> {
  const emails = inputRows.map(r => r.email.toLowerCase().trim());
  const uniqueEmails = [...new Set(emails)];

  const { rows: contactRows } = await pool.query<{
    id: number; email: string; stage: string | null; lead_score: number;
  }>(
    `SELECT id, LOWER(email) AS email, stage, COALESCE(lead_score, 0) AS lead_score
     FROM contacts
     WHERE tenant_id = $1 AND LOWER(email) = ANY($2::text[])`,
    [tenantId, uniqueEmails]
  );

  const contactByEmail = new Map<string, typeof contactRows[0]>();
  for (const c of contactRows) contactByEmail.set(c.email, c);

  const matched: number[] = [];
  const skippedAlreadyAware: number[] = [];
  const unmatched: string[] = [];

  for (const email of uniqueEmails) {
    const contact = contactByEmail.get(email);
    if (!contact) { unmatched.push(email); continue; }
    if (!isPreAwareStage(contact.stage)) { skippedAlreadyAware.push(contact.id); continue; }
    matched.push(contact.id);
  }

  if (isDryRun) {
    return {
      preview: true,
      total_rows: uniqueEmails.length,
      matched: matched.length,
      skipped_already_aware: skippedAlreadyAware.length,
      unmatched: unmatched.length,
      unmatched_emails: unmatched.slice(0, 20),
    };
  }

  const emailToRow = new Map<string, CsvInputRow>();
  for (const r of inputRows) emailToRow.set(r.email.toLowerCase().trim(), r);

  const summary = {
    updated: 0,
    skipped: skippedAlreadyAware.length + unmatched.length,
    unmatched: unmatched.length,
    event_skipped_duplicate: 0,
  };

  const details: Array<{ email: string; contactId: number; action: string; reason?: string }> = [];
  for (const email of unmatched) details.push({ email, contactId: 0, action: "unmatched" });
  for (const cid of skippedAlreadyAware) {
    const email = [...contactByEmail.entries()].find(([, c]) => c.id === cid)?.[0] ?? "";
    details.push({ email, contactId: cid, action: "skipped", reason: "already_aware_or_beyond" });
  }

  for (const contactId of matched) {
    const contact = contactRows.find(c => c.id === contactId)!;
    const email = contact.email;
    const inputRow = emailToRow.get(email);
    const occurredAt = inputRow?.clickedAt ? new Date(inputRow.clickedAt) : new Date();
    const safeOccurredAt = isNaN(occurredAt.getTime()) ? new Date() : occurredAt;

    try {
      // Atomic CTE: UPDATE and INSERT happen in one statement — if the contact was
      // already advanced (or this runs twice), the WHERE guard produces 0 RETURNING rows
      // and the INSERT inserts nothing, preventing duplicate history entries.
      await pool.query(
        `WITH advanced AS (
           UPDATE contacts
           SET tags = (SELECT ARRAY(SELECT DISTINCT unnest(COALESCE(tags, '{}') || ARRAY['aware']))),
               stage = 'aware',
               updated_at = NOW()
           WHERE id = $1 AND tenant_id = $2
             AND COALESCE(stage, 'pre-aware') = 'pre-aware'
           RETURNING id, COALESCE(lead_score, 0) AS score_at_transition
         )
         INSERT INTO contact_stage_history
           (tenant_id, contact_id, from_stage, to_stage, score_at_transition, created_at)
         SELECT $2, id, 'pre-aware', 'aware', score_at_transition, $3
         FROM advanced`,
        [contactId, tenantId, safeOccurredAt]
      );

      const dayStr = safeOccurredAt.toISOString().slice(0, 10);
      const { rows: existingClick } = await pool.query<{ id: number }>(
        `SELECT id FROM activity_events
         WHERE contact_id = $1 AND tenant_id = $2
           AND event_type = 'email_click'
           AND created_at::date = $3::date
         LIMIT 1`,
        [contactId, tenantId, dayStr]
      );

      if (existingClick.length === 0) {
        const { rows: ruleRows } = await pool.query<{ points: number }>(
          `SELECT points FROM scoring_rules
           WHERE event_type = 'email_click' AND is_active = 'true'
           ORDER BY id LIMIT 1`
        );
        const points = ruleRows[0]?.points ?? 0;

        await pool.query(
          `INSERT INTO activity_events
             (tenant_id, contact_id, event_type, description, source, score_delta, created_at)
           VALUES ($1, $2, 'email_click', 'Backfilled from Resend export', 'resend_csv_backfill', $3, $4)`,
          [tenantId, contactId, points, safeOccurredAt]
        );

        if (points !== 0) {
          await pool.query(
            `UPDATE contacts SET lead_score = GREATEST(0, COALESCE(lead_score, 0) + $1),
                                 last_activity = $2
             WHERE id = $3 AND tenant_id = $4`,
            [points, safeOccurredAt, contactId, tenantId]
          );
        }
      } else {
        summary.event_skipped_duplicate++;
      }

      // Pass source:BACKFILL so routing rules are suppressed — this is a
      // retroactive stage/score correction, not a live behaviour signal.
      computeIntentScore(contactId, tenantId, { source: SCORE_SOURCES.BACKFILL }).catch(err =>
        logger.warn({ err, contactId }, "computeIntentScore failed after csv backfill")
      );

      summary.updated++;
      details.push({ email, contactId, action: "updated" });
    } catch (err) {
      logger.warn({ err, contactId, email }, "resend-backfill rows: failed to process contact");
      details.push({ email, contactId, action: "skipped", reason: "error" });
      summary.skipped++;
    }
  }

  logger.info({
    tenantId, total_rows: uniqueEmails.length, updated: summary.updated,
    skipped: summary.skipped, unmatched: summary.unmatched,
    event_skipped_duplicate: summary.event_skipped_duplicate,
  }, "resend-backfill rows-mode complete");

  return {
    ok: true,
    total_rows: uniqueEmails.length,
    updated: summary.updated,
    skipped: summary.skipped,
    unmatched: summary.unmatched,
    event_skipped_duplicate: summary.event_skipped_duplicate,
    details: details.slice(0, 200),
    contacts_for_audit: details.slice(0, 500).map(d => ({ id: d.contactId, action: d.action, email: d.email })),
  };
}

// ── route ──────────────────────────────────────────────────────────────────────

router.post("/admin/resend-backfill", requireRole("admin"), async (req, res, next): Promise<void> => {
  const user = req.user as AuthUser;
  const tenantId = user.tenantId;

  // ── Branch A: row-based CSV backfill (body contains { rows: [...] }) ─────────
  if (Array.isArray(req.body?.rows)) {
    const inputRows = (req.body.rows as CsvInputRow[]).filter(
      r => typeof r.email === "string" && r.email.includes("@")
    );
    if (inputRows.length === 0) {
      res.status(400).json({ error: "No valid email rows provided" });
      return;
    }
    if (inputRows.length > 5000) {
      res.status(400).json({ error: "Too many rows (max 5,000 per request)" });
      return;
    }
    try {
      const isDryRun = req.query.dry_run === "true";
      const result = await handleRowsBackfill(tenantId, inputRows, isDryRun);
      if (!isDryRun && result.ok) {
        recordBackfillRun({
          tenantId,
          triggeredBy: user.id,
          source: "csv",
          totalRows: (result.total_rows as number) ?? inputRows.length,
          updated: (result.updated as number) ?? 0,
          skipped: (result.skipped as number) ?? 0,
          unmatched: (result.unmatched as number) ?? 0,
          extra: { contacts: (result.contacts_for_audit as unknown[]) ?? [] },
        });
      }
      res.json(result);
    } catch (err) {
      next(err);
    }
    return;
  }

  // ── Branch B: Resend API pull (no rows in body) ───────────────────────────────
  const days  = Math.min(365, Math.max(1, parseInt(String(req.query.days  ?? "30"))));
  const limit = Math.min(5000, Math.max(1, parseInt(String(req.query.limit ?? "500"))));

  try {
    const apiKey = await getResendApiKey(tenantId);
    if (!apiKey) {
      res.status(400).json({ error: "No Resend API key configured. Add it in Settings → Integrations." });
      return;
    }

    // ── Paginate through Resend emails list via REST API ─────────────────────
    // SDK v6 does not expose emails.list(); use the REST endpoint directly.
    const sinceMs  = Date.now() - days * 24 * 60 * 60 * 1000;
    const pageSize = 100; // Resend's max per-page
    let   cursor: string | undefined;
    const emails: any[] = [];

    while (emails.length < limit) {
      const url = new URL("https://api.resend.com/emails");
      url.searchParams.set("limit", String(pageSize));
      if (cursor) url.searchParams.set("after", cursor);

      const resp = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      });

      if (!resp.ok) {
        const body = await resp.text();
        logger.warn({ status: resp.status, body }, "Resend /emails list error during backfill");
        break;
      }

      const page: any = await resp.json();
      const pageEmails: any[] = Array.isArray(page.data) ? page.data : [];

      // Log the raw structure of the first email so we can see all fields
      if (pageEmails.length > 0 && emails.length === 0) {
        logger.info({ sample: pageEmails[0] }, "Resend backfill first email sample");
      }

      // Count last_event distribution to understand what values are coming back
      const eventDist: Record<string, number> = {};
      for (const e of pageEmails) {
        const ev = e.last_event ?? e.lastEvent ?? e.status ?? "none";
        eventDist[ev] = (eventDist[ev] ?? 0) + 1;
      }
      logger.info({ fetched: pageEmails.length, cursor, eventDist }, "Resend backfill page");
      if (pageEmails.length === 0) break;

      for (const e of pageEmails) {
        const createdAt = new Date(e.created_at ?? e.createdAt ?? Date.now());
        if (createdAt.getTime() < sinceMs) { cursor = undefined; break; }
        emails.push(e);
        if (emails.length >= limit) break;
      }

      const nextCursor = page.cursor ?? page.next_cursor;
      if (!nextCursor || emails.length >= limit) break;
      cursor = nextCursor;
    }

    // ── Process each email ──────────────────────────────────────────────────────
    const summary = {
      total: emails.length,
      skipped_no_contact: 0,
      skipped_already_done: 0,
      skipped_no_event: 0,
      processed_open: 0,
      processed_click: 0,
      processed_bounce: 0,
      journey_visits_linked: 0,
      contacts_scored: new Set<number>(),
    };
    const contactsForAudit: Array<{ id: number; action: string; email: string }> = [];

    // Map Resend last_event priority → which activity events to record
    // clicked → both open + click (you must open to click)
    // opened  → open only
    // bounced → bounce record only (no score change unless a bounce rule exists)
    const EVENT_PRIORITY = ["clicked", "opened", "bounced", "complained"];

    for (const email of emails) {
      const lastEvent: string = email.last_event ?? email.lastEvent ?? "";
      if (!EVENT_PRIORITY.includes(lastEvent)) {
        summary.skipped_no_event++;
        continue;
      }

      const resendEmailId: string = email.id ?? "";
      const toAddresses: string[] = Array.isArray(email.to)
        ? email.to
        : typeof email.to === "string"
          ? [email.to]
          : [];
      const subject: string = email.subject ?? "";
      const occurredAt = new Date(email.created_at ?? email.createdAt ?? Date.now());

      for (const toEmail of toAddresses) {
        const contactId = await getOrCreateContactId(toEmail, tenantId);
        if (!contactId) {
          summary.skipped_no_contact++;
          continue;
        }

        if (resendEmailId && await alreadyProcessed(resendEmailId, tenantId)) {
          summary.skipped_already_done++;
          // Still try to link new journey visits that may have happened since
          // the last backfill run — don't skip the window scan entirely.
          if (lastEvent === "clicked" || lastEvent === "opened") {
            let linked = await linkJourneyVisits(contactId, tenantId, occurredAt);
            if (linked === 0) {
              linked = await rebalanceTokenForContact(contactId, tenantId, occurredAt);
            }
            summary.journey_visits_linked += linked;
            if (linked > 0) {
              await scoreLinkedPageViews(contactId, tenantId);
            }
          }
          continue;
        }

        // ── Insert email_events anchor row (dedup key) ─────────────────────────
        const eventTypeForRecord =
          lastEvent === "clicked"   ? "clicked"  :
          lastEvent === "opened"    ? "opened"   :
          lastEvent === "bounced"   ? "bounced"  : lastEvent;

        await pool.query(
          `INSERT INTO email_events (tenant_id, contact_id, event_type, metadata)
           VALUES ($1, $2, $3, $4)`,
          [
            tenantId,
            contactId,
            eventTypeForRecord,
            JSON.stringify({ source: "resend_backfill", resendEmailId, subject, to: toEmail }),
          ]
        );

        // ── Record activity events and update score ────────────────────────────
        if (lastEvent === "clicked" || lastEvent === "opened") {
          // For clicked: always record open first (click implies open)
          const alreadyHasOpen = await pool.query<{ id: number }>(
            `SELECT id FROM activity_events
             WHERE contact_id = $1 AND event_type = 'email_open'
               AND created_at BETWEEN $2::timestamptz - INTERVAL '1 hour' AND $2::timestamptz + INTERVAL '1 hour'
             LIMIT 1`,
            [contactId, occurredAt]
          );
          if (alreadyHasOpen.rows.length === 0) {
            await recordBackfillActivity({
              tenantId, contactId,
              activityEventType: "email_open",
              description: `Email opened: ${subject}`,
              occurredAt,
            });
            summary.processed_open++;
          }

          if (lastEvent === "clicked") {
            const alreadyHasClick = await pool.query<{ id: number }>(
              `SELECT id FROM activity_events
               WHERE contact_id = $1 AND event_type = 'email_click'
                 AND created_at BETWEEN $2::timestamptz - INTERVAL '1 hour' AND $2::timestamptz + INTERVAL '1 hour'
               LIMIT 1`,
              [contactId, occurredAt]
            );
            if (alreadyHasClick.rows.length === 0) {
              await recordBackfillActivity({
                tenantId, contactId,
                activityEventType: "email_click",
                description: `Email link clicked: ${subject}`,
                occurredAt,
              });
              summary.processed_click++;
            }
          }

          // Link anonymous journey_events that happened around this email event
          // to the contact — retroactively de-anonymises their page views.
          let linked = await linkJourneyVisits(contactId, tenantId, occurredAt);
          if (linked === 0) {
            linked = await rebalanceTokenForContact(contactId, tenantId, occurredAt);
          }
          summary.journey_visits_linked += linked;
          if (linked > 0) {
            await scoreLinkedPageViews(contactId, tenantId);
          }

          summary.contacts_scored.add(contactId);
          if (contactsForAudit.length < 500) {
            contactsForAudit.push({ id: contactId, action: "updated", email: toEmail });
          }
        } else if (lastEvent === "bounced") {
          // Still try to link journey visits for bounced emails
          // (they may have previewed a page despite the bounce)
          await linkJourneyVisits(contactId, tenantId, occurredAt)
            .then(n => { summary.journey_visits_linked += n; })
            .catch(() => {/* non-fatal */});
          summary.processed_bounce++;
        }
      }
    }

    logger.info({
      emails_fetched: emails.length,
      opens: summary.processed_open,
      clicks: summary.processed_click,
      bounces: summary.processed_bounce,
      journey_visits_linked: summary.journey_visits_linked,
      contacts_updated: summary.contacts_scored.size,
      skipped_no_contact: summary.skipped_no_contact,
      skipped_already_done: summary.skipped_already_done,
    }, "Resend backfill complete");

    recordBackfillRun({
      tenantId,
      triggeredBy: user.id,
      source: "api",
      totalRows: emails.length,
      updated: summary.contacts_scored.size,
      skipped: summary.skipped_already_done + summary.skipped_no_contact + summary.skipped_no_event,
      unmatched: summary.skipped_no_contact,
      extra: {
        opens: summary.processed_open,
        clicks: summary.processed_click,
        bounces: summary.processed_bounce,
        journey_visits_linked: summary.journey_visits_linked,
        days_back: days,
        contacts: contactsForAudit,
      },
    });

    res.json({
      ok: true,
      days_back: days,
      emails_fetched: emails.length,
      processed: {
        opens: summary.processed_open,
        clicks: summary.processed_click,
        bounces: summary.processed_bounce,
        journey_visits_linked: summary.journey_visits_linked,
      },
      skipped: {
        no_contact: summary.skipped_no_contact,
        already_processed: summary.skipped_already_done,
        no_trackable_event: summary.skipped_no_event,
      },
      contacts_updated: summary.contacts_scored.size,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
