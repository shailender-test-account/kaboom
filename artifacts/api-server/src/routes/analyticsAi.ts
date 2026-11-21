import { Router, type IRouter } from "express";
import { requireAuth } from "../middlewares/requireAuth";
import { db, contactsTable, playsTable, clientsTable, pool } from "@workspace/db";
import { eq, sql, and } from "drizzle-orm";
import { openai } from "@workspace/integrations-openai-ai-server";

// ── Tool execution (called after function-call detection in the stream) ─────
async function executeTool(
  name: string,
  args: Record<string, any>,
  tid: number,
  userId: number,
): Promise<{ output: any; actionCard?: any; followUps?: any[]; dataRows?: any[] }> {
  if (name === "resume_play") {
    const { play_id, play_name } = args;
    await pool.query(
      `UPDATE abm_plays SET status = 'active', updated_at = NOW() WHERE id = $1 AND tenant_id = $2`,
      [play_id, tid]
    );
    return {
      output: { success: true, message: `Play "${play_name}" has been resumed (status → active).` },
      actionCard: { type: "executed", action: "resume", playName: play_name, newStatus: "active" },
    };
  }

  if (name === "pause_play") {
    const { play_id, play_name } = args;
    await pool.query(
      `UPDATE abm_plays SET status = 'paused', updated_at = NOW() WHERE id = $1 AND tenant_id = $2`,
      [play_id, tid]
    );
    return {
      output: { success: true, message: `Play "${play_name}" has been paused.` },
      actionCard: { type: "executed", action: "pause", playName: play_name, newStatus: "paused" },
    };
  }

  if (name === "schedule_play_action") {
    const { play_id, play_name, action, delay_hours = 0, delay_minutes = 0 } = args;
    const totalMs = (Number(delay_hours) * 60 + Number(delay_minutes)) * 60_000;
    const executeAt = new Date(Date.now() + totalMs);
    const delayHuman =
      Number(delay_hours) > 0
        ? `${delay_hours}h${Number(delay_minutes) > 0 ? ` ${delay_minutes}m` : ""}`
        : `${delay_minutes}m`;
    await pool.query(
      `INSERT INTO scheduled_actions (tenant_id, action_type, payload, execute_at, created_by)
       VALUES ($1, $2, $3, $4, $5)`,
      [tid, `${action}_play`, JSON.stringify({ play_id, play_name }), executeAt.toISOString(), userId]
    );
    return {
      output: {
        success: true,
        message: `Scheduled: ${action} "${play_name}" in ${delayHuman} (at ${executeAt.toLocaleTimeString()}).`,
      },
      actionCard: {
        type: "scheduled",
        action,
        playName: play_name,
        executeAt: executeAt.toISOString(),
        delayHuman,
      },
    };
  }

  if (name === "get_follow_up_contacts") {
    const { play_name, limit = 10 } = args;
    // Find the play's client_id (fuzzy match)
    const playRes = await pool.query<{ id: number; client_id: number; name: string }>(
      `SELECT id, client_id, name FROM abm_plays
       WHERE tenant_id = $1 AND LOWER(name) LIKE LOWER($2) LIMIT 1`,
      [tid, `%${play_name}%`]
    );
    if (!playRes.rows.length) {
      return { output: { error: `No play found matching "${play_name}"` }, followUps: [] };
    }
    const { client_id, name: foundPlayName } = playRes.rows[0];
    const cRes = await pool.query(
      `SELECT c.first_name, c.last_name, c.email, c.phone, c.company_name,
              c.lead_score, c.stage,
              coalesce(v.pts_7d, 0)::int    AS pts_7d,
              coalesce(v.pts_30d, 0)::int   AS pts_30d,
              CASE
                WHEN coalesce(v.pts_per_day, 0) > 0 AND c.lead_score < 75
                THEN round((75 - c.lead_score)::numeric / v.pts_per_day, 0)
                ELSE NULL
              END AS est_days_to_75,
              CASE
                WHEN coalesce(v.pts_7d,0) > coalesce(v.pts_prior14,0)*0.5 AND coalesce(v.pts_7d,0)>0 THEN 'accelerating'
                WHEN coalesce(v.pts_7d,0) > 0 THEN 'active'
                WHEN coalesce(v.pts_30d,0) > 0 THEN 'slowing'
                ELSE 'stalled'
              END AS momentum
       FROM contacts c
       LEFT JOIN (
         SELECT ae.contact_id,
           sum(ae.score_delta) FILTER (WHERE ae.created_at >= NOW()-INTERVAL '7 days')  AS pts_7d,
           sum(ae.score_delta) FILTER (WHERE ae.created_at >= NOW()-INTERVAL '30 days') AS pts_30d,
           sum(ae.score_delta) FILTER (
             WHERE ae.created_at >= NOW()-INTERVAL '30 days'
               AND ae.created_at <  NOW()-INTERVAL '14 days') AS pts_prior14,
           round(sum(ae.score_delta) FILTER (
             WHERE ae.created_at >= NOW()-INTERVAL '30 days')::numeric / 30, 4) AS pts_per_day
         FROM activity_events ae WHERE ae.is_bot = false
         GROUP BY ae.contact_id
       ) v ON v.contact_id = c.id
       WHERE c.tenant_id = $1 AND c.client_id = $2
       ORDER BY c.lead_score DESC, coalesce(v.pts_7d,0) DESC
       LIMIT $3`,
      [tid, client_id, Number(limit)]
    );
    const followUps = cRes.rows.map((r: any) => ({
      name: `${r.first_name ?? ""} ${r.last_name ?? ""}`.trim(),
      company: r.company_name ?? "—",
      email: r.email ?? r.phone ?? "—",
      score: r.lead_score,
      stage: r.stage ?? "—",
      pts7d: r.pts_7d,
      momentum: r.momentum,
      est_days_to_75: r.est_days_to_75 ? Number(r.est_days_to_75) : null,
      reason:
        r.lead_score >= 75 ? "✅ Action-ready"
        : r.momentum === "accelerating" ? "🔥 Accelerating fast"
        : r.lead_score >= 50 ? "⚡ Hot lead"
        : r.pts_7d > 0 ? "📈 Active this week"
        : "⏸ Needs re-engagement",
    }));
    return {
      output: {
        success: true,
        contacts: followUps.map((f: any) => `${f.name} (${f.company}) score:${f.score} stage:${f.stage} ${f.reason}`),
        message: `${followUps.length} contacts to follow up in "${foundPlayName}".`,
      },
      followUps,
    };
  }

  if (name === "tag_contacts") {
    const { tag, call_outcome_filter, campaign_id, dry_run = false } = args;

    let contactQuery: string;
    let queryParams: any[];

    if (call_outcome_filter === "unanswered") {
      contactQuery = `
        SELECT DISTINCT c.id, c.first_name, c.last_name, c.company_name
        FROM contacts c
        JOIN call_logs cl ON cl.contact_id = c.id AND cl.tenant_id = c.tenant_id
        WHERE c.tenant_id = $1
          AND (cl.outcome IS NULL OR cl.outcome NOT IN ('answered'))
          ${campaign_id ? "AND cl.campaign_id = $2" : ""}
      `;
      queryParams = campaign_id ? [tid, campaign_id] : [tid];
    } else if (call_outcome_filter === "answered") {
      contactQuery = `
        SELECT DISTINCT c.id, c.first_name, c.last_name, c.company_name
        FROM contacts c
        JOIN call_logs cl ON cl.contact_id = c.id AND cl.tenant_id = c.tenant_id
        WHERE c.tenant_id = $1 AND cl.outcome = 'answered'
          ${campaign_id ? "AND cl.campaign_id = $2" : ""}
      `;
      queryParams = campaign_id ? [tid, campaign_id] : [tid];
    } else if (call_outcome_filter === "no_calls") {
      contactQuery = `
        SELECT c.id, c.first_name, c.last_name, c.company_name
        FROM contacts c
        WHERE c.tenant_id = $1
          AND NOT EXISTS (
            SELECT 1 FROM call_logs cl
            WHERE cl.contact_id = c.id AND cl.tenant_id = c.tenant_id
            ${campaign_id ? "AND cl.campaign_id = $2" : ""}
          )
      `;
      queryParams = campaign_id ? [tid, campaign_id] : [tid];
    } else {
      // "any" — all contacts with any call log
      contactQuery = `
        SELECT DISTINCT c.id, c.first_name, c.last_name, c.company_name
        FROM contacts c
        JOIN call_logs cl ON cl.contact_id = c.id AND cl.tenant_id = c.tenant_id
        WHERE c.tenant_id = $1
          ${campaign_id ? "AND cl.campaign_id = $2" : ""}
      `;
      queryParams = campaign_id ? [tid, campaign_id] : [tid];
    }

    const contactsRes = await pool.query(contactQuery, queryParams);
    const rows = contactsRes.rows as any[];
    const contactIds = rows.map((r) => r.id);

    if (contactIds.length === 0) {
      return {
        output: {
          success: true,
          count: 0,
          message: `No contacts matched the filter "${call_outcome_filter}"${campaign_id ? ` for campaign id:${campaign_id}` : ""}.`,
        },
      };
    }

    if (dry_run) {
      return {
        output: {
          dry_run: true,
          count: contactIds.length,
          preview: rows.slice(0, 10).map((r) => `${r.first_name ?? ""} ${r.last_name ?? ""}`.trim() + ` (${r.company_name ?? "—"})`),
          message: `Would tag ${contactIds.length} contact(s) with "${tag}". Confirm to apply (dry_run:false).`,
        },
      };
    }

    // Apply the tag — skip contacts that already have it
    const { rowCount } = await pool.query(
      `UPDATE contacts
       SET tags = array_append(tags, $1::text), updated_at = NOW()
       WHERE id = ANY($2::int[]) AND NOT ($1::text = ANY(tags))`,
      [tag, contactIds]
    );

    return {
      output: {
        success: true,
        tagged: rowCount ?? contactIds.length,
        skipped_already_tagged: contactIds.length - (rowCount ?? 0),
        tag,
        message: `✅ Tagged ${rowCount ?? contactIds.length} contact(s) with "${tag}"${campaign_id ? ` from campaign id:${campaign_id}` : ""}.`,
      },
    };
  }

  if (name === "start_call_campaign") {
    const { campaign_id, campaign_name } = args;
    // Set campaign active
    const { rowCount } = await pool.query(
      `UPDATE call_campaigns SET status = 'active', updated_at = NOW() WHERE id = $1 AND tenant_id = $2`,
      [campaign_id, tid]
    );
    if (!rowCount) {
      return { output: { error: `Call campaign id:${campaign_id} not found or not accessible.` } };
    }
    // Build waves if none exist yet
    const waveCheck = await pool.query(
      `SELECT count(*)::int AS cnt FROM call_campaign_waves WHERE campaign_id = $1`,
      [campaign_id]
    );
    const existingWaves = waveCheck.rows[0]?.cnt ?? 0;
    if (existingWaves === 0) {
      // Get batch config and contact count
      const cfg = await pool.query(
        `SELECT batch_size, wave_gap_minutes,
                (SELECT count(*)::int FROM call_campaign_contacts WHERE campaign_id = $1) AS contact_count
         FROM call_campaigns WHERE id = $1`,
        [campaign_id]
      );
      const { batch_size = 3, wave_gap_minutes = 6, contact_count = 0 } = cfg.rows[0] ?? {};
      if (contact_count > 0) {
        const waveCount = Math.ceil(contact_count / batch_size);
        for (let w = 0; w < waveCount; w++) {
          const schedAt = new Date(Date.now() + w * wave_gap_minutes * 60_000);
          await pool.query(
            `INSERT INTO call_campaign_waves (campaign_id, tenant_id, wave_number, status, batch_size, scheduled_at)
             VALUES ($1, $2, $3, 'scheduled', $4, $5)`,
            [campaign_id, tid, w + 1, batch_size, schedAt.toISOString()]
          );
        }
      }
    } else {
      // Resume paused waves
      await pool.query(
        `UPDATE call_campaign_waves SET status = 'scheduled', updated_at = NOW()
         WHERE campaign_id = $1 AND status = 'paused'`,
        [campaign_id]
      );
    }
    return {
      output: { success: true, message: `Call campaign "${campaign_name}" has been started (status → active).` },
      actionCard: { type: "executed", action: "resume", playName: `📞 ${campaign_name}`, newStatus: "active" },
    };
  }

  if (name === "pause_call_campaign") {
    const { campaign_id, campaign_name } = args;
    const { rowCount } = await pool.query(
      `UPDATE call_campaigns SET status = 'paused', updated_at = NOW() WHERE id = $1 AND tenant_id = $2`,
      [campaign_id, tid]
    );
    if (!rowCount) {
      return { output: { error: `Call campaign id:${campaign_id} not found or not accessible.` } };
    }
    await pool.query(
      `UPDATE call_campaign_waves SET status = 'paused', updated_at = NOW()
       WHERE campaign_id = $1 AND status IN ('active', 'scheduled', 'pending')`,
      [campaign_id]
    );
    return {
      output: { success: true, message: `Call campaign "${campaign_name}" has been paused.` },
      actionCard: { type: "executed", action: "pause", playName: `📞 ${campaign_name}`, newStatus: "paused" },
    };
  }

  // ── query_data: text-to-SQL, read-only, tenant-scoped ─────────────────────
  if (name === "query_data") {
    const { sql_query } = args as { sql_query: string };

    if (!sql_query?.trim()) {
      return { output: { error: "sql_query is required." } };
    }

    // Safety: allow only SELECT statements
    const normalized = sql_query.trim().replace(/\s+/g, " ").toUpperCase();
    const forbidden = ["INSERT", "UPDATE", "DELETE", "DROP", "CREATE", "ALTER", "TRUNCATE", "GRANT", "REVOKE"];
    for (const kw of forbidden) {
      // match keyword at word boundary to avoid false positives inside identifiers
      if (new RegExp(`\\b${kw}\\b`).test(normalized)) {
        return { output: { error: `Forbidden keyword "${kw}" detected. Only SELECT queries are allowed.` } };
      }
    }

    // Substitute the __tid__ placeholder with the actual tenant ID (number from session — not user input)
    const safeQuery = sql_query.replace(/__tid__/g, String(tid));

    // Wrap in a LIMIT guard so we never return huge result sets
    const limited = /\bLIMIT\b/i.test(safeQuery)
      ? safeQuery
      : `SELECT * FROM (${safeQuery}) _q LIMIT 100`;

    let rows: any[];
    try {
      const result = await pool.query(limited);
      rows = result.rows;
    } catch (err: any) {
      return { output: { error: `Query execution error: ${err?.message ?? String(err)}` } };
    }

    return {
      output: {
        success: true,
        row_count: rows.length,
        rows,
        message: `Query returned ${rows.length} row(s).`,
      },
      dataRows: rows,
    };
  }

  return { output: { error: `Unknown tool: ${name}` } };
}

// ── OpenAI tool definitions ────────────────────────────────────────────────
const AI_TOOLS: any[] = [
  {
    type: "function",
    function: {
      name: "resume_play",
      description: "Resume (activate) a paused or draft play/campaign. Use when the user asks to resume, start, activate, or un-pause a play.",
      parameters: {
        type: "object",
        properties: {
          play_id:   { type: "number", description: "Numeric ID of the play from the ALL PLAYS section of the context" },
          play_name: { type: "string", description: "Full display name of the play for the confirmation message" },
        },
        required: ["play_id", "play_name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "pause_play",
      description: "Pause an active play/campaign. Use when the user asks to pause, stop, or deactivate a play.",
      parameters: {
        type: "object",
        properties: {
          play_id:   { type: "number" },
          play_name: { type: "string" },
        },
        required: ["play_id", "play_name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "schedule_play_action",
      description: "Schedule a play to be paused or resumed after a delay. Use when user says things like 'pause after 2 hours', 'resume it in 30 minutes', 'stop it tonight'.",
      parameters: {
        type: "object",
        properties: {
          play_id:       { type: "number" },
          play_name:     { type: "string" },
          action:        { type: "string", enum: ["pause", "resume"], description: "What to do when the timer fires" },
          delay_hours:   { type: "number", description: "Hours from now (0 if less than 1 hour)", default: 0 },
          delay_minutes: { type: "number", description: "Additional minutes on top of delay_hours", default: 0 },
        },
        required: ["play_id", "play_name", "action", "delay_hours"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_follow_up_contacts",
      description: "Return a prioritized list of contacts to follow up in a specific ABM play/campaign. Use when the user asks 'who should I follow up', 'which contacts to reach out to', 'give me a contact list', 'who to prioritize' for an ABM play.",
      parameters: {
        type: "object",
        properties: {
          play_name: { type: "string", description: "Name (or partial name) of the ABM play" },
          limit:     { type: "number", description: "Maximum contacts to return (default 10)", default: 10 },
        },
        required: ["play_name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "start_call_campaign",
      description: "Start (activate) a call campaign so it begins dialling contacts. Use when the user says 'start call campaign', 'activate call campaign', 'begin calling', 'launch call campaign', or 'run call campaign'. This is for CALL campaigns only — not ABM plays.",
      parameters: {
        type: "object",
        properties: {
          campaign_id:   { type: "number", description: "Numeric ID of the call campaign from the CALL CAMPAIGNS section" },
          campaign_name: { type: "string", description: "Display name of the call campaign" },
        },
        required: ["campaign_id", "campaign_name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "pause_call_campaign",
      description: "Pause an active call campaign, stopping further dialling. Use when the user says 'pause call campaign', 'stop call campaign', 'halt calling', 'suspend call campaign'. For CALL campaigns only — not ABM plays.",
      parameters: {
        type: "object",
        properties: {
          campaign_id:   { type: "number" },
          campaign_name: { type: "string" },
        },
        required: ["campaign_id", "campaign_name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "query_data",
      description: `Run a read-only SQL SELECT against the live database to answer precise data questions. Use this whenever the user asks for a specific list of contacts, emails, events, or any question requiring exact rows — e.g. "names of people who opened the email in the last 7 days", "contacts who re-engaged after a gap", "who submitted a form this week", "show me hot contacts at TechNova". Always use __tid__ as the placeholder for the tenant ID. Write clean, safe SQL — no writes, no DDL.`,
      parameters: {
        type: "object",
        properties: {
          sql_query: {
            type: "string",
            description: `A PostgreSQL SELECT query. RULES: (1) Use __tid__ wherever you need the tenant_id value. (2) Always include tenant_id = __tid__ in WHERE clauses on every table you query. (3) No INSERT/UPDATE/DELETE/DROP/CREATE. (4) Cap large result sets with LIMIT (max 100). (5) Use snake_case column aliases for readability.

SCHEMA:
contacts (id, tenant_id, first_name, last_name, email, phone, company_name, designation, title, lead_score, intent_score, stage, tags text[], created_at, updated_at, last_activity)
  stage values: 'pre-aware','aware','pre-engage','engage','advance-engage','action'

activity_events (id, tenant_id, contact_id, event_type, score_delta, page_name, page_url, journey_id, sequence_id, run_id, created_at, is_bot)
  event_type values: 'email_open','email_click','email_sent','page_view','scroll_depth','form_submit','asset_download','call_completed'

sequence_enrollments (id, tenant_id, contact_id, sequence_id, run_id, status, enrolled_at, completed_at)
email_sequences (id, tenant_id, name, play_id)
journeys (id, tenant_id, name, slug)
companies (id, tenant_id, name, industry, domain, size)
abm_plays (id, tenant_id, client_id, name, status, contacts_enrolled, emails_sent, page_views, created_at)
clients (id, tenant_id, name)
call_logs (id, tenant_id, campaign_id, contact_id, outcome, duration_seconds, started_at, ended_at)

EXAMPLE QUERIES:
-- Contacts who opened an email in the last 7 days
SELECT DISTINCT c.first_name, c.last_name, c.email, c.company_name, c.stage, c.lead_score, MAX(ae.created_at) AS last_open
FROM activity_events ae JOIN contacts c ON c.id = ae.contact_id AND c.tenant_id = __tid__
WHERE ae.tenant_id = __tid__ AND ae.event_type = 'email_open' AND ae.created_at >= NOW() - INTERVAL '7 days' AND ae.is_bot = false
GROUP BY c.id, c.first_name, c.last_name, c.email, c.company_name, c.stage, c.lead_score
ORDER BY last_open DESC LIMIT 50;

-- Contacts who re-engaged after a gap of at least 10 days
WITH ranked AS (
  SELECT contact_id, created_at,
         LAG(created_at) OVER (PARTITION BY contact_id ORDER BY created_at) AS prev_activity
  FROM activity_events WHERE tenant_id = __tid__ AND is_bot = false
), gaps AS (
  SELECT DISTINCT r.contact_id FROM ranked r WHERE r.prev_activity IS NOT NULL AND (r.created_at - r.prev_activity) >= INTERVAL '10 days'
)
SELECT c.first_name, c.last_name, c.email, c.company_name, c.stage, c.lead_score FROM contacts c JOIN gaps g ON g.contact_id = c.id WHERE c.tenant_id = __tid__ ORDER BY c.lead_score DESC LIMIT 50;`,
          },
        },
        required: ["sql_query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "tag_contacts",
      description: "Apply a tag to contacts in the database matching a call-outcome filter. Use when the user asks to 'create a segment', 'tag contacts', 'mark contacts who didn't answer', 'segment unanswered calls', 'tag no-answers from campaign X', 'create a list of contacts who were not reached', etc. Use dry_run:true first to preview the contacts, then dry_run:false to apply. Tags are stored on the contact record and visible in the CRM.",
      parameters: {
        type: "object",
        properties: {
          tag: {
            type: "string",
            description: "The tag string to add to matching contacts (e.g. 'unanswered-q3', 'no-answer-june', 'needs-retry'). Use kebab-case, no spaces.",
          },
          call_outcome_filter: {
            type: "string",
            enum: ["unanswered", "answered", "no_calls", "any"],
            description: "unanswered = contacts with at least one call where outcome is not 'answered' (includes silence/no-pickup); answered = contacts with at least one answered call; no_calls = contacts who have never been called; any = all contacts with any call record.",
          },
          campaign_id: {
            type: "number",
            description: "Optional: restrict to contacts in a specific call campaign (use the numeric id from CALL CAMPAIGNS section). Omit to match across all campaigns.",
          },
          dry_run: {
            type: "boolean",
            description: "If true, returns a preview of which contacts would be tagged without making any changes. Always run with dry_run:true first, then confirm with dry_run:false. Default: false.",
            default: false,
          },
        },
        required: ["tag", "call_outcome_filter"],
      },
    },
  },
];

const router: IRouter = Router();
router.use(requireAuth);

router.post("/analytics/ai-chat", async (req, res, next): Promise<void> => {
  try {
    const user = req.user as any;
    const tid = user.tenantId;
    const { question, history = [] } = req.body as {
      question: string;
      history?: { role: string; content: string }[];
    };

    if (!question?.trim()) {
      res.status(400).json({ error: "Question is required." });
      return;
    }

    const now = new Date();
    const d30 = new Date(now.getTime() - 30 * 86_400_000);

    // ── Fetch ONLY lightweight aggregate data ────────────────────────────────
    // Per-row data is fetched on-demand via the query_data tool
    const [
      kpiRows,
      stageDist,
      scoreDistribution,
      entityLists,
    ] = await Promise.all([

      // ── KPIs ─────────────────────────────────────────────────────────────────
      Promise.all([
        db.select({ count: sql<number>`count(*)::int` }).from(clientsTable).where(eq(clientsTable.tenantId, tid)),
        db.select({ count: sql<number>`count(*)::int` }).from(playsTable).where(and(eq(playsTable.tenantId, tid), eq(playsTable.status, "active"))),
        db.select({ count: sql<number>`count(*)::int` }).from(contactsTable).where(eq(contactsTable.tenantId, tid)),
        db.select({ count: sql<number>`count(*)::int` }).from(contactsTable).where(and(eq(contactsTable.tenantId, tid), sql`lead_score >= 50`)),
        db.select({ count: sql<number>`count(*)::int` }).from(contactsTable).where(and(eq(contactsTable.tenantId, tid), sql`lead_score >= 75`)),
        db.select({ avg: sql<number>`coalesce(avg(lead_score),0)::float` }).from(contactsTable).where(eq(contactsTable.tenantId, tid)),
        db.select({ sum: sql<number>`coalesce(sum(emails_sent),0)::int` }).from(playsTable).where(eq(playsTable.tenantId, tid)),
        db.select({ sum: sql<number>`coalesce(sum(page_views),0)::int` }).from(playsTable).where(eq(playsTable.tenantId, tid)),
        db.select({ count: sql<number>`count(*)::int` }).from(contactsTable).where(and(eq(contactsTable.tenantId, tid), sql`created_at >= ${d30.toISOString()}`)),
      ]),

      // ── Stage distribution ────────────────────────────────────────────────────
      db.execute(sql`
        SELECT stage, count(*)::int as count,
               round(avg(lead_score)::numeric,1) as avg_score
        FROM contacts WHERE tenant_id = ${tid} AND stage IS NOT NULL
        GROUP BY stage ORDER BY count DESC
      `),

      // ── Score distribution ────────────────────────────────────────────────────
      db.execute(sql`
        SELECT
          count(*) FILTER (WHERE lead_score = 0)::int                  AS score_zero,
          count(*) FILTER (WHERE lead_score BETWEEN 1 AND 24)::int     AS score_cold,
          count(*) FILTER (WHERE lead_score BETWEEN 25 AND 49)::int    AS score_warm,
          count(*) FILTER (WHERE lead_score BETWEEN 50 AND 74)::int    AS score_hot,
          count(*) FILTER (WHERE lead_score >= 75)::int                AS score_very_hot
        FROM contacts WHERE tenant_id = ${tid}
      `),

      // ── Entity name lists (plays, clients, journeys, sequences, companies, call campaigns) ─
      Promise.all([
        // Plays
        pool.query(`
          SELECT p.id, p.name, p.status, p.contacts_enrolled, p.emails_sent,
                 cl.name AS client_name
          FROM abm_plays p
          LEFT JOIN clients cl ON cl.id = p.client_id
          WHERE p.tenant_id = $1
          ORDER BY p.contacts_enrolled DESC NULLS LAST
          LIMIT 30
        `, [tid]),
        // Clients
        pool.query(`
          SELECT cl.id, cl.name, cl.industry,
                 count(c.id)::int AS total_contacts,
                 count(DISTINCT p.id)::int AS total_plays
          FROM clients cl
          LEFT JOIN contacts c ON c.client_id = cl.id AND c.tenant_id = cl.tenant_id
          LEFT JOIN abm_plays p ON p.client_id = cl.id AND p.tenant_id = cl.tenant_id
          WHERE cl.tenant_id = $1
          GROUP BY cl.id, cl.name, cl.industry
          ORDER BY total_contacts DESC
        `, [tid]),
        // Journeys
        pool.query(`
          SELECT id, name, status, slug
          FROM journeys WHERE tenant_id = $1
          ORDER BY name LIMIT 30
        `, [tid]),
        // Email sequences
        pool.query(`
          SELECT id, name, status FROM email_sequences
          WHERE tenant_id = $1 ORDER BY name LIMIT 20
        `, [tid]),
        // Top 20 contacts by score
        pool.query(`
          SELECT first_name, last_name, email, company_name, lead_score, stage
          FROM contacts WHERE tenant_id = $1
          ORDER BY lead_score DESC LIMIT 20
        `, [tid]),
        // Call campaigns
        pool.query(`
          SELECT cc.id, cc.name, cc.status,
                 count(DISTINCT ccc.id)::int AS total_contacts
          FROM call_campaigns cc
          LEFT JOIN call_campaign_contacts ccc ON ccc.campaign_id = cc.id
          WHERE cc.tenant_id = $1
          GROUP BY cc.id, cc.name, cc.status
          ORDER BY cc.created_at DESC LIMIT 20
        `, [tid]),
      ]),

      // (per-row data is fetched on-demand via the query_data tool — see below)

    ]);

    // ── Unpack ────────────────────────────────────────────────────────────────
    const [
      [clientsRow], [activePlaysRow], [contactsRow],
      [hotRow], [veryHotRow], [avgScoreRow],
      [emailsRow], [pvRow], [newContactsRow],
    ] = kpiRows;

    const stages      = (stageDist as any).rows ?? [];
    const scoreBucket = ((scoreDistribution as any).rows ?? [])[0] ?? {};
    const [playsData, clientsData, journeysData, seqData, topContactsData, callCampaignData] = entityLists as any[];
    const plays         = playsData?.rows ?? [];
    const clients       = clientsData?.rows ?? [];
    const journeys      = journeysData?.rows ?? [];
    const sequences     = seqData?.rows ?? [];
    const topContacts   = topContactsData?.rows ?? [];
    const callCampaigns = callCampaignData?.rows ?? [];

    // ── Lean system prompt — specific data comes from query_data tool ─────────
    const systemPrompt = `You are KABOOM AI, an expert B2B ABM analytics assistant. Today is ${now.toDateString()}.

## LIVE DATABASE SUMMARY

**KPIs**
- Clients: ${clientsRow?.count ?? 0} | Active Plays: ${activePlaysRow?.count ?? 0} | Total Contacts: ${contactsRow?.count ?? 0}
- Hot (score ≥50): ${hotRow?.count ?? 0} | Very Hot (score ≥75): ${veryHotRow?.count ?? 0} | Avg Score: ${Math.round(((avgScoreRow?.avg ?? 0) as number) * 10) / 10}
- Emails Sent: ${emailsRow?.sum ?? 0} | Page Views: ${pvRow?.sum ?? 0} | New Contacts last 30d: ${newContactsRow?.count ?? 0}

**Score Distribution**
Zero: ${scoreBucket.score_zero ?? 0} | Cold (1–24): ${scoreBucket.score_cold ?? 0} | Warm (25–49): ${scoreBucket.score_warm ?? 0} | Hot (50–74): ${scoreBucket.score_hot ?? 0} | Very Hot (75+): ${scoreBucket.score_very_hot ?? 0}

**Stage Distribution**
${stages.map((r: any) => `  ${r.stage}: ${r.count} contacts (avg score ${r.avg_score})`).join("\n") || "  No data"}

**ABM Plays** (${plays.length} plays)
${plays.map((p: any) => `  • [id:${p.id}] "${p.name}" (${p.status}) [client: ${p.client_name ?? "—"}] — ${p.contacts_enrolled ?? 0} enrolled, ${p.emails_sent ?? 0} emails sent`).join("\n") || "  No plays"}

**Clients** (${clients.length} clients)
${clients.map((c: any) => `  • [id:${c.id}] "${c.name}" (${c.industry ?? "—"}) — ${c.total_contacts} contacts, ${c.total_plays} plays`).join("\n") || "  No clients"}

**Journeys** (${journeys.length} journeys)
${journeys.map((j: any) => `  • [id:${j.id}] "${j.name}" (${j.status ?? "—"}) slug:${j.slug}`).join("\n") || "  No journeys"}

**Email Sequences** (${sequences.length} sequences)
${sequences.map((s: any) => `  • [id:${s.id}] "${s.name}" (${s.status ?? "—"})`).join("\n") || "  No sequences"}

**Call Campaigns** (${callCampaigns.length} campaigns)
${callCampaigns.map((c: any) => `  • [id:${c.id}] "${c.name}" (${c.status}) — ${c.total_contacts} contacts`).join("\n") || "  No call campaigns"}

**Top 20 Contacts by Score**
${topContacts.map((c: any) => `  ${c.first_name ?? ""} ${c.last_name ?? ""} | ${c.company_name ?? "—"} | score:${c.lead_score} | stage:${c.stage ?? "—"} | ${c.email ?? "—"}`).join("\n") || "  No contacts"}

---

## HOW TO ANSWER

**ALWAYS use the \`query_data\` tool** for any question that requires a specific list of contacts, companies, email events, activity events, deals, form submissions, call outcomes, velocity data, or any other row-level data. The tool runs live SQL against the full database and returns precise results.

Use the KPI summary above only for quick aggregate answers ("how many hot contacts", "how many active plays", etc.). For everything else, write SQL.

**query_data SQL rules:**
- Use \`__tid__\` as the placeholder for tenant_id (it is substituted server-side)
- Always add \`WHERE tenant_id = __tid__\` on every table
- Add \`AND is_bot = false\` on activity_events and email_events
- No writes (INSERT/UPDATE/DELETE/DROP). SELECT only.
- Max 100 rows per query; use ORDER BY to get the most relevant rows first
- Return clear column aliases

**Database schema (key tables):**
\`\`\`
contacts (id, tenant_id, first_name, last_name, email, phone, company_name, title, lead_score, stage, tags text[], created_at, updated_at)
  stage values: 'pre-aware','aware','pre-engage','engage','advance-engage','action'

activity_events (id, tenant_id, contact_id, event_type, score_delta, page_name, journey_id, created_at, is_bot)
  event_type: 'email_open','email_click','email_sent','page_view','form_submit','asset_download','call_completed'

email_events (id, tenant_id, contact_id, template_id, event_type, occurred_at, is_bot)
  event_type: 'sent','opened','clicked','bounced','unsubscribed'

sequence_enrollments (id, tenant_id, contact_id, sequence_id, run_id, status, enrolled_at, completed_at)
email_sequences (id, tenant_id, name, status, play_id)
journeys (id, tenant_id, name, slug, status)
journey_pages (id, journey_id, title, page_type, sort_order, page_stage, score, is_published)
companies (id, tenant_id, name, industry, domain, size)
abm_plays (id, tenant_id, client_id, name, status, contacts_enrolled, emails_sent, page_views, created_at)
clients (id, tenant_id, name, industry)
call_logs (id, tenant_id, campaign_id, contact_id, outcome, duration_seconds, started_at, ended_at, ai_summary, ai_next_steps)
call_analysis (id, tenant_id, call_log_id, contact_id, sentiment, interest_score, recommended_action, follow_up_message)
call_campaigns (id, tenant_id, name, status, batch_size, created_at)
call_campaign_contacts (id, tenant_id, campaign_id, contact_id, status)
deals (id, tenant_id, title, value, stage, priority, company_id, contact_id, client_id, expected_close_date, notes, created_at)
form_submissions (id, tenant_id, contact_id, form_id, journey_id, submitted_at, field_values jsonb, action_type)
journey_forms (id, journey_id, name)
contact_notes (id, tenant_id, contact_id, content, created_at)
email_templates (id, tenant_id, name)
\`\`\`

**Example queries:**
\`\`\`sql
-- Contacts who opened an email in last 7 days
SELECT DISTINCT c.first_name, c.last_name, c.email, c.company_name, c.stage, c.lead_score,
       MAX(ae.created_at) AS last_open
FROM activity_events ae JOIN contacts c ON c.id = ae.contact_id
WHERE ae.tenant_id = __tid__ AND c.tenant_id = __tid__
  AND ae.event_type = 'email_open' AND ae.is_bot = false
  AND ae.created_at >= NOW() - INTERVAL '7 days'
GROUP BY c.id, c.first_name, c.last_name, c.email, c.company_name, c.stage, c.lead_score
ORDER BY last_open DESC LIMIT 50;

-- Top scoring accounts (company-level rollup)
SELECT c.company_name, COUNT(c.id) AS contacts, MAX(c.lead_score) AS max_score,
       ROUND(AVG(c.lead_score)::numeric, 1) AS avg_score,
       MAX(c.stage) AS furthest_stage
FROM contacts c
WHERE c.tenant_id = __tid__
GROUP BY c.company_name
ORDER BY max_score DESC, avg_score DESC LIMIT 20;

-- Contacts who re-engaged after a 10-day gap
WITH ranked AS (
  SELECT contact_id, created_at,
         LAG(created_at) OVER (PARTITION BY contact_id ORDER BY created_at) AS prev_activity
  FROM activity_events WHERE tenant_id = __tid__ AND is_bot = false
), gaps AS (
  SELECT DISTINCT contact_id FROM ranked
  WHERE prev_activity IS NOT NULL AND (created_at - prev_activity) >= INTERVAL '10 days'
    AND created_at >= NOW() - INTERVAL '7 days'
)
SELECT c.first_name, c.last_name, c.email, c.company_name, c.stage, c.lead_score
FROM contacts c JOIN gaps g ON g.contact_id = c.id
WHERE c.tenant_id = __tid__ ORDER BY c.lead_score DESC LIMIT 50;
\`\`\`

**Terminology mapping:**
- "campaign" / "play" → abm_plays table; use play id/name from the Plays list above
- "call campaign" / "dialler campaign" → call_campaigns table
- "journey" → journeys table
- "account" → company (company_name on contacts, or companies table)
- "sequence" / "email sequence" → email_sequences table

**General rules:**
- Always use query_data for specific names, lists, or counts. Never guess from the summary above.
- After query_data returns rows, present them as a clear table or list.
- For actions (pause/resume play, tag contacts, start call campaign), use the appropriate action tool.
- NEVER ask the user for the schema — you already have it.`;



    // ── Stream ─────────────────────────────────────────────────────────────────
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    const userId = (req.user as any).id;

    const chatMessages: any[] = [
      { role: "system", content: systemPrompt },
      ...(history as any[]).slice(-6).map((m: any) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      })),
      { role: "user", content: question },
    ];

    // ── First streaming pass — may produce tool_calls ─────────────────────────
    const stream1 = await openai.chat.completions.create({
      model: "gpt-5.1",
      max_completion_tokens: 8192,
      messages: chatMessages,
      tools: AI_TOOLS,
      tool_choice: "auto",
      stream: true,
    });

    // Accumulate tool_calls deltas and any immediate text
    const toolCallsMap: Record<number, { id: string; name: string; arguments: string }> = {};
    let textSoFar = "";

    for await (const chunk of stream1) {
      const choice = chunk.choices[0];
      if (!choice) continue;
      const delta = choice.delta as any;

      if (delta?.content) {
        textSoFar += delta.content;
        res.write(`data: ${JSON.stringify({ content: delta.content })}\n\n`);
      }

      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls as any[]) {
          const idx: number = tc.index ?? 0;
          if (!toolCallsMap[idx]) {
            toolCallsMap[idx] = { id: "", name: "", arguments: "" };
          }
          if (tc.id) toolCallsMap[idx].id = tc.id;
          if (tc.function?.name) toolCallsMap[idx].name += tc.function.name;
          if (tc.function?.arguments) toolCallsMap[idx].arguments += tc.function.arguments;
        }
      }
    }

    // ── Execute any tool calls, then do a second streaming pass ──────────────
    const toolCallsList = Object.values(toolCallsMap);
    if (toolCallsList.length > 0) {
      const toolResultMessages: any[] = [];

      for (const tc of toolCallsList) {
        let args: Record<string, any> = {};
        try { args = JSON.parse(tc.arguments); } catch { /* use empty */ }

        const result = await executeTool(tc.name, args, tid, userId);

        // Emit structured events for the UI
        if (result.actionCard) {
          res.write(`data: ${JSON.stringify({ action_card: result.actionCard })}\n\n`);
        }
        if (result.followUps?.length) {
          res.write(`data: ${JSON.stringify({ follow_up_contacts: result.followUps })}\n\n`);
        }
        if (result.dataRows !== undefined) {
          res.write(`data: ${JSON.stringify({ data_rows: result.dataRows })}\n\n`);
        }

        toolResultMessages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: JSON.stringify(result.output),
        });
      }

      // Second streaming pass — model commentary / summary after execution
      const assistantMsg: any = {
        role: "assistant",
        content: textSoFar || null,
        tool_calls: toolCallsList.map(tc => ({
          id: tc.id,
          type: "function",
          function: { name: tc.name, arguments: tc.arguments },
        })),
      };

      const stream2 = await openai.chat.completions.create({
        model: "gpt-5.1",
        max_completion_tokens: 4096,
        messages: [...chatMessages, assistantMsg, ...toolResultMessages],
        stream: true,
      });

      for await (const chunk of stream2) {
        const content = chunk.choices[0]?.delta?.content;
        if (content) {
          res.write(`data: ${JSON.stringify({ content })}\n\n`);
        }
      }
    }

    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    res.end();
  } catch (err) {
    next(err);
  }
});

export default router;
