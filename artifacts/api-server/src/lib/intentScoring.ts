/**
 * Intent Scoring Engine — composite multi-signal scoring model.
 *
 * Signals incorporated (v2):
 *  1. Engagement quality per session  — time, scroll depth, interactions, stage weight, recency decay
 *  2. Frequency-breadth multiplier    — log scale; rewards spread of activity over days
 *  3. Stage progression bonus         — additive; rewards reaching deeper funnel stages
 *  4. Email engagement signals        — email_click/email_open as lightweight intent micro-signals
 *  5. Velocity / momentum bonus       — accelerating activity (last 7d vs prior 7d) earns extra points
 *  6. Account-level ABM bonus         — active colleagues at same company amplify individual intent
 *
 * Formula:
 *   rawIntentScore = engagementSum × fbm + spb + emailSignal + velocityBonus + accountBonus
 *   intentScore    = min(100, rawIntentScore)
 *
 * Heat tag thresholds (calibrated for v2 score range):
 *   Very Hot  — Decision-Action state  OR intentScore ≥ 65
 *   Hot       — intentScore ≥ 40       OR (Evaluating/PreEngage/Re-engaging AND score ≥ 25)
 *   Warm      — intentScore ≥ 18       OR Stuck-Aware (any score)
 *   Cold      — everything else
 */

import { db, pool } from "@workspace/db";
import { sql } from "drizzle-orm";
import { evaluateRoutingRules } from "./scoringEngine";
import { logger } from "./logger";

/**
 * Named source tokens for score computation calls.
 *
 * Any call that passes one of these as `options.source` suppresses routing rule
 * evaluation inside `persistIntentResult`.  Use this instead of raw strings so
 * all callers stay in sync if the set of suppressed sources ever changes.
 *
 * - BACKFILL        — historical data corrections (Resend CSV / API backfill).
 * - ADMIN_RECOMPUTE — admin-triggered bulk recompute of all contact scores.
 */
export const SCORE_SOURCES = {
  BACKFILL:        "backfill",
  ADMIN_RECOMPUTE: "admin_recompute",
} as const;

export type ScoreSource = (typeof SCORE_SOURCES)[keyof typeof SCORE_SOURCES];

/** Sources for which routing rule evaluation must be suppressed. */
const NON_LIVE_SOURCES = new Set<string>([
  SCORE_SOURCES.BACKFILL,
  SCORE_SOURCES.ADMIN_RECOMPUTE,
]);

const STAGE_RANK: Record<string, number> = {
  "pre-aware": 0, "aware": 1, "pre-engage": 2,
  "engage": 3, "advance-engage": 4, "action": 5,
};

const STAGE_WEIGHT: Record<string, number> = {
  "aware": 10, "pre-engage": 15, "engage": 20,
  "advance-engage": 25, "action": 30,
};

function getStageFromTags(tags: string[]): string | null {
  let best: string | null = null;
  let bestRank = -1;
  for (const t of tags) {
    const rank = STAGE_RANK[t] ?? -1;
    if (rank > bestRank) { bestRank = rank; best = t; }
  }
  return best;
}

/**
 * Minimum number of email_open events required to qualify a contact for
 * 'aware' advancement when no email_click has ever been recorded.
 *
 * Some mail clients block image-tracking pixels and never deliver clicks, so a
 * contact who genuinely re-opened emails multiple times would otherwise be stuck
 * forever at pre-aware. 3+ opens is used as a softer, deliberate-engagement
 * proxy.  Set higher if your audience has many privacy-focused clients that
 * auto-load images (which would inflate open counts).
 */
const AWARE_OPEN_THRESHOLD = 3;

/**
 * Stage-consistency check: advance a pre-aware contact to 'aware' when either:
 *  (a) they have at least one email_click event (strong signal), OR
 *  (b) they have ≥ AWARE_OPEN_THRESHOLD email_open events and no clicks (soft
 *      fallback for mail clients that block tracking pixels/redirects).
 *
 * Calling this inside computeIntentScore ensures the check runs every time
 * scoring is re-evaluated, acting as a self-healing safety net without needing
 * a separate cron job.
 *
 * The `reason` written to contact_stage_history distinguishes how advancement
 * was triggered so it is visible in stage-history UIs.
 *
 * Idempotent: the UPDATE guard (stage = 'pre-aware') means re-runs are no-ops.
 */
async function maybeAdvanceToAware(
  contactId: number,
  tenantId: number,
  currentStage: string | null,
  evtRows: Array<{ event_type: string }>,
): Promise<void> {
  if ((currentStage ?? "pre-aware") !== "pre-aware") return;

  const hasEmailClick = evtRows.some(e => e.event_type === "email_click");
  const openCount     = evtRows.filter(e => e.event_type === "email_open").length;

  const advanceViaClick          = hasEmailClick;
  const advanceViaOpenThreshold  = !hasEmailClick && openCount >= AWARE_OPEN_THRESHOLD;

  if (!advanceViaClick && !advanceViaOpenThreshold) return;

  const reason = advanceViaClick
    ? "advanced via click (consistency check)"
    : `advanced via open threshold (${openCount} opens, no clicks)`;

  // Look up the most recent activity_event that triggered this advance so the
  // stage history row can link back to it. This is what lets the Stage History
  // UI show "Email link click" / "Email open" for scoring-engine advances.
  const triggerEventType = advanceViaClick ? "email_click" : "email_open";
  const { rows: triggerRows } = await pool.query<{ id: number }>(
    `SELECT id FROM activity_events
     WHERE contact_id = $1 AND tenant_id = $2 AND event_type = $3
     ORDER BY created_at DESC LIMIT 1`,
    [contactId, tenantId, triggerEventType],
  );
  const triggerActivityEventId: number | null = triggerRows[0]?.id ?? null;

  // Atomic CTE: UPDATE + INSERT in a single statement.
  // If the UPDATE matches 0 rows (stage already advanced by a concurrent call),
  // the INSERT inserts 0 rows — no duplicate history records can be created
  // even when two scoring runs fire simultaneously for the same contact.
  const { rowCount } = await pool.query(
    `WITH advanced AS (
       UPDATE contacts
       SET stage = 'aware',
           tags  = CASE
                     WHEN 'aware' = ANY(COALESCE(tags, '{}'))
                     THEN tags
                     ELSE array_append(COALESCE(tags, '{}'), 'aware')
                   END
       WHERE id        = $1
         AND tenant_id = $2
         AND COALESCE(stage, 'pre-aware') = 'pre-aware'
       RETURNING id, tenant_id, lead_score
     )
     INSERT INTO contact_stage_history
       (tenant_id, contact_id, from_stage, to_stage, score_at_transition, activity_event_id, reason, created_at)
     SELECT tenant_id, id, 'pre-aware', 'aware', lead_score, $3, $4, NOW()
     FROM advanced`,
    [contactId, tenantId, triggerActivityEventId, reason],
  );

  if ((rowCount ?? 0) > 0) {
    if (advanceViaClick) {
      logger.info(
        { contactId, tenantId },
        "Contact advanced to aware via scoring consistency check (email_click bypassed tracking)",
      );
    } else {
      logger.info(
        { contactId, tenantId, openCount, threshold: AWARE_OPEN_THRESHOLD },
        "Contact advanced to aware via email open threshold (no clicks recorded)",
      );
    }
  }
}

export type IntentResult = {
  intentScore: number;
  rawIntentScore: number;
  intentState: string;
  suggestedNextAction: string;
  heatTag: string;
  distinctActiveDays: number;
  freqScore: number;
  maxStageScore: number;
  engagementScore: number;
  velocityBonus: number;
  accountBonus: number;
  accountColleagues: number;
  /** True when called from a backfill path and routing rules were suppressed
   *  (intent state changed so rules would have fired under normal evaluation). */
  routingRulesSuppressed: boolean;
};

export async function computeIntentScore(
  contactId: number,
  tenantId: number,
  options?: { source?: string },
): Promise<IntentResult> {
  // Load all activity_events for this contact
  const evtRows = (await db.execute(sql`
    SELECT
      event_type,
      score_delta,
      stage,
      created_at,
      duration_seconds,
      metadata
    FROM activity_events
    WHERE contact_id = ${contactId}
      AND tenant_id  = ${tenantId}
    ORDER BY created_at ASC
  `)).rows as Array<{
    event_type: string;
    score_delta: number | null;
    stage: string | null;
    created_at: string;
    duration_seconds: number | null;
    metadata: Record<string, unknown> | null;
  }>;

  // Load current contact tags + company_id
  const contactRows = (await db.execute(sql`
    SELECT tags, stage, company_id FROM contacts
    WHERE id = ${contactId} AND tenant_id = ${tenantId} LIMIT 1
  `)).rows as Array<{ tags: string[] | null; stage: string | null; company_id: number | null }>;
  const contactTags: string[] = contactRows[0]?.tags ?? [];
  const companyId: number | null = contactRows[0]?.company_id ?? null;
  const currentStage: string | null = contactRows[0]?.stage ?? null;

  // ── Stage-consistency check ────────────────────────────────────────────────
  // If the contact has email_click events but is still at pre-aware, advance
  // them now. This catches cases where tracking was bypassed (mail client
  // preloads/strips links) so neither Path A (click-redirect) nor Path B
  // (webhook) fired the stage advancement. The scoring engine is the last line
  // of defence — running the check here means no manual backfills are needed.
  await maybeAdvanceToAware(contactId, tenantId, currentStage, evtRows);

  const now = new Date();

  if (evtRows.length === 0) {
    const result: IntentResult = {
      intentScore: 0, rawIntentScore: 0,
      intentState: "Browsing",
      suggestedNextAction: "No action; continue monitoring",
      heatTag: "Cold",
      distinctActiveDays: 0,
      freqScore: 1.0,
      maxStageScore: 0,
      engagementScore: 0,
      velocityBonus: 0,
      accountBonus: 0,
      accountColleagues: 0,
      routingRulesSuppressed: false,
    };
    result.routingRulesSuppressed = await persistIntentResult(contactId, tenantId, result, options);
    return result;
  }

  // ── Session grouping (30-min inactivity gap = new session) ───────────────
  type Session = {
    events: typeof evtRows;
    startTime: Date;
    stage: string;
    isReturning: boolean;
  };

  const sessions: Session[] = [];
  let currentSession: typeof evtRows = [];
  let lastEventTime: Date | null = null;

  for (const evt of evtRows) {
    const evtTime = new Date(evt.created_at);
    if (lastEventTime === null || (evtTime.getTime() - lastEventTime.getTime()) > 30 * 60 * 1000) {
      if (currentSession.length > 0) {
        sessions.push(buildSession(currentSession, sessions.length > 0));
      }
      currentSession = [evt];
    } else {
      currentSession.push(evt);
    }
    lastEventTime = evtTime;
  }
  if (currentSession.length > 0) {
    sessions.push(buildSession(currentSession, sessions.length > 0));
  }

  function buildSession(evts: typeof evtRows, isReturning: boolean): Session {
    let highestStage = "pre-aware";
    let highestRank = STAGE_RANK["pre-aware"] ?? 0;
    for (const e of evts) {
      const s = e.stage;
      if (s && (STAGE_RANK[s] ?? -1) > highestRank) {
        highestRank = STAGE_RANK[s] ?? -1;
        highestStage = s;
      }
    }
    return {
      events: evts,
      startTime: new Date(evts[0].created_at),
      stage: highestStage,
      isReturning,
    };
  }

  // ── Distinct active days (total + per-stage) ──────────────────────────────
  const daySet = new Set<string>();
  const preEngageDaySet = new Set<string>();
  const engageDaySet    = new Set<string>();
  for (const evt of evtRows) {
    const d = new Date(evt.created_at).toISOString().slice(0, 10);
    daySet.add(d);
    const evtStageRank = STAGE_RANK[evt.stage ?? ""] ?? -1;
    if (evtStageRank >= (STAGE_RANK["pre-engage"] ?? 2)) preEngageDaySet.add(d);
    if (evtStageRank >= (STAGE_RANK["engage"]     ?? 3)) engageDaySet.add(d);
  }
  const distinctActiveDays    = daySet.size;
  const distinctPreEngageDays = preEngageDaySet.size;

  // ── Max stage from event history ──────────────────────────────────────────
  let maxStageFromEvents = "pre-aware";
  let maxStageRank = STAGE_RANK["pre-aware"] ?? 0;

  const stageFromTags = getStageFromTags(contactTags);
  if (stageFromTags && (STAGE_RANK[stageFromTags] ?? -1) > maxStageRank) {
    maxStageRank = STAGE_RANK[stageFromTags] ?? 0;
    maxStageFromEvents = stageFromTags;
  }

  for (const s of sessions) {
    if ((STAGE_RANK[s.stage] ?? -1) > maxStageRank) {
      maxStageRank = STAGE_RANK[s.stage] ?? -1;
      maxStageFromEvents = s.stage;
    }
  }

  // ── Per-session engagement quality × stage weight × recency decay ─────────
  let engagementSum = 0;

  for (const session of sessions) {
    const sw = STAGE_WEIGHT[session.stage] ?? 0;
    if (sw === 0) continue;

    const hasPositivePageView = session.events.some(
      e => e.event_type === "page_view" && Number(e.score_delta ?? 0) > 0,
    );
    const timeSec = session.events.reduce((sum, e) => sum + (e.duration_seconds ?? 0), 0)
      || (hasPositivePageView ? 60 : 0);

    const scrollEvt = session.events.find(e => e.event_type === "scroll_depth");
    const scrollDepthPct = scrollEvt
      ? (typeof (scrollEvt.metadata as any)?.depth === "number"
          ? Math.min(100, Math.max(0, Number((scrollEvt.metadata as any).depth)))
          : 50)
      : 0;

    const interactions = session.events.filter(
      e => e.event_type.startsWith("video_") || e.event_type === "asset_download" || e.event_type === "form_submit",
    ).length;

    let eq = 0.2
      + 0.4 * Math.min(timeSec / 120, 1)
      + 0.4 * (scrollDepthPct / 100)
      + 0.1 * Math.min(interactions / 3, 1)
      + (session.isReturning ? 0.4 : 0);
    eq = Math.min(eq, 1.5);

    const daysSince = (now.getTime() - session.startTime.getTime()) / (1000 * 60 * 60 * 24);
    const recencyDecay = Math.exp(-0.033 * daysSince);

    engagementSum += sw * eq * recencyDecay;
  }

  // ── [NEW] Email engagement signals ────────────────────────────────────────
  // email_click and email_open contribute as lightweight intent micro-signals,
  // separate from page sessions. Clicks carry more weight than opens because
  // they represent deliberate action; opens can be scanner/preview artifacts.
  // Both are subject to the same recency decay as page sessions.
  const EMAIL_WEIGHT: Record<string, number> = {
    "email_click": 8,
    "email_open":  3,
  };
  const EMAIL_EQ: Record<string, number> = {
    "email_click": 0.40,
    "email_open":  0.15,
  };

  for (const evt of evtRows) {
    const ew = EMAIL_WEIGHT[evt.event_type];
    if (!ew) continue;
    const eq = EMAIL_EQ[evt.event_type] ?? 0;
    const daysSince = (now.getTime() - new Date(evt.created_at).getTime()) / (1000 * 60 * 60 * 24);
    const recencyDecay = Math.exp(-0.033 * daysSince);
    engagementSum += ew * eq * recencyDecay;
  }

  // ── Frequency-breadth multiplier ─────────────────────────────────────────
  const fbm = 1 + 0.5 * Math.log(1 + distinctActiveDays);

  // ── Stage progression bonus ───────────────────────────────────────────────
  const spb = 5 * (maxStageRank - 1);

  // ── [NEW] Velocity / momentum bonus ──────────────────────────────────────
  // Contacts whose activity is accelerating (more events in last 7d than prior
  // 7d) earn extra points. This rewards contacts who are heating up RIGHT NOW,
  // not just ones who were once active.
  const recentCutoffMs = now.getTime() - 7  * 24 * 60 * 60 * 1000;
  const priorCutoffMs  = now.getTime() - 14 * 24 * 60 * 60 * 1000;

  const recentCount = evtRows.filter(e => new Date(e.created_at).getTime() >= recentCutoffMs).length;
  const priorCount  = evtRows.filter(e => {
    const t = new Date(e.created_at).getTime();
    return t >= priorCutoffMs && t < recentCutoffMs;
  }).length;

  let velocityBonus = 0;
  if (recentCount > 0) {
    if (priorCount === 0) {
      velocityBonus = 10;   // fresh surge after a quiet period
    } else {
      const accelRatio = recentCount / priorCount;
      if      (accelRatio >= 2.0) velocityBonus = 15;  // strong acceleration
      else if (accelRatio >= 1.3) velocityBonus = 8;   // moderate acceleration
      // deceleration earns 0 — we don't penalise; recency decay handles fade
    }
  }

  // ── [NEW] Account-level ABM signal ───────────────────────────────────────
  // When multiple people at the same company are actively engaging, that is a
  // buying-committee signal. Each active colleague in the last 30 days adds
  // 5 points (capped at 4 colleagues = max +20 pts).
  let accountBonus = 0;
  let accountColleagues = 0;

  if (companyId) {
    // Count colleagues who are GENUINELY engaged with the SAME campaign as this contact.
    // Requirements (all must hold):
    //   1. Real (non-anonymous) contact at the same company.
    //   2. Enrolled in at least one of the same sequences as this contact in the last 30d.
    //      Sequence scoping prevents colleagues from unrelated campaigns inflating the count.
    //   3. Has at least one page_view in a journey this contact also visited in the last 30d.
    //      Page_view is the only reliable human-presence signal — email_sent / sequence_enrolled
    //      are server-side events; email_click / email_open can be Safe Links bot scans.
    //
    // Previous bug: counting ALL activity_events (including email_sent, sequence_enrolled)
    // inflated counts to the full sequence batch size (e.g. 73 = every State Street contact
    // in a 200-contact run), not actual buying-committee engagement.
    const accRows = (await db.execute(sql`
      SELECT COUNT(DISTINCT ae.contact_id)::int AS active_colleagues
      FROM activity_events ae
      JOIN contacts c ON c.id = ae.contact_id
      WHERE c.company_id  = ${companyId}
        AND ae.contact_id != ${contactId}
        AND ae.tenant_id  = ${tenantId}
        AND ae.event_type = 'page_view'
        AND ae.created_at >= NOW() - INTERVAL '30 days'
        AND c.is_anonymous IS NOT TRUE
        AND ae.journey_id IN (
          SELECT DISTINCT pv.journey_id
          FROM activity_events pv
          WHERE pv.contact_id  = ${contactId}
            AND pv.journey_id IS NOT NULL
            AND pv.event_type  = 'page_view'
            AND pv.created_at >= NOW() - INTERVAL '30 days'
        )
        AND ae.contact_id IN (
          SELECT DISTINCT se.contact_id
          FROM sequence_enrollments se
          WHERE se.sequence_id IN (
            SELECT DISTINCT my_se.sequence_id
            FROM sequence_enrollments my_se
            WHERE my_se.contact_id  = ${contactId}
              AND my_se.enrolled_at >= NOW() - INTERVAL '30 days'
          )
          AND se.enrolled_at >= NOW() - INTERVAL '30 days'
          AND se.tenant_id   = ${tenantId}
        )
    `)).rows[0] as { active_colleagues: number | null } | undefined;

    accountColleagues = Number(accRows?.active_colleagues ?? 0);
    accountBonus = 5 * Math.min(accountColleagues, 4);
  }

  // ── Final scores ──────────────────────────────────────────────────────────
  const rawIntentScoreFloat = engagementSum * fbm + spb + velocityBonus + accountBonus;
  const rawIntentScore = Math.max(0, Math.round(rawIntentScoreFloat));
  const intentScore = Math.min(rawIntentScore, 100);

  // ── Intent state classification ───────────────────────────────────────────
  // System-generated bookkeeping events are excluded from the "last user
  // activity" calculation. Including them would make a contact that visited 35
  // days ago look recently active simply because the scoring engine wrote a
  // housekeeping row (e.g. sequence_enrollment_skipped) during a recompute run.
  const SYSTEM_EVENT_TYPES = new Set([
    "sequence_enrollment_skipped",
    "email_sent",
    "sequence_enrolled",
  ]);
  const userEvtRows = evtRows.filter(e => !SYSTEM_EVENT_TYPES.has(e.event_type));
  // Fall back to the full list only if there are no user-activity events at all.
  const lastEvt = (userEvtRows.length > 0 ? userEvtRows : evtRows)[
    (userEvtRows.length > 0 ? userEvtRows : evtRows).length - 1
  ];
  const lastEvtTime = new Date(lastEvt.created_at);
  const daysSinceLastEvent = (now.getTime() - lastEvtTime.getTime()) / (1000 * 60 * 60 * 24);

  let intentState = "Browsing";

  if (daysSinceLastEvent > 30) {
    intentState = "Dormant";
  } else if (daysSinceLastEvent <= 7 && userEvtRows.length >= 2) {
    const prevEvt = userEvtRows[userEvtRows.length - 2];
    const gapDays = (lastEvtTime.getTime() - new Date(prevEvt.created_at).getTime()) / (1000 * 60 * 60 * 24);
    if (gapDays >= 14) intentState = "Re-engaging";
  }

  if (intentState === "Browsing") {
    if (maxStageFromEvents === "action") {
      intentState = "Decision-Action";
    } else if (maxStageFromEvents === "engage" || maxStageFromEvents === "advance-engage") {
      if (distinctActiveDays >= 2) intentState = "Evaluating-Engage";
    } else if (maxStageFromEvents === "pre-engage") {
      if (distinctPreEngageDays >= 2) intentState = "Stuck-PreEngage";
    } else if (maxStageFromEvents === "aware") {
      if (distinctActiveDays >= 2) intentState = "Stuck-Aware";
    }
  }

  if (daysSinceLastEvent > 30 && intentState !== "Dormant") {
    intentState = "Dormant";
  }

  // ── Suggested next action ─────────────────────────────────────────────────
  const SUGGESTED: Record<string, string> = {
    "Stuck-Aware":       "Send educational nurture sequence; introduce a problem-framing piece",
    "Stuck-PreEngage":   "Share comparison content, case study, or 'why us' material",
    "Evaluating-Engage": "Trigger sales outreach with a specific hook based on visited content",
    "Decision-Action":   "Route to AE immediately; high-priority follow-up",
    "Re-engaging":       "Re-engagement campaign referencing previously viewed content",
    "Dormant":           "Quarterly re-activation or remove from active list",
    "Browsing":          "No action; continue monitoring",
  };
  const suggestedNextAction = SUGGESTED[intentState] ?? "No action; continue monitoring";

  // ── [UPDATED] Heat tag — recalibrated for v2 score range ─────────────────
  // Very Hot: Decision-Action state OR score ≥ 65 (previously required score=100)
  // Hot:      score ≥ 40, or engaged states with score ≥ 25
  // Warm:     score ≥ 18, or Stuck-Aware (any score — they're consistently returning)
  let heatTag = "Cold";
  if (intentState === "Decision-Action" || intentScore >= 65) {
    heatTag = "Very Hot";
  } else if (
    intentScore >= 40 ||
    (["Evaluating-Engage", "Stuck-PreEngage", "Re-engaging"].includes(intentState) && intentScore >= 25)
  ) {
    heatTag = "Hot";
  } else if (intentScore >= 18 || intentState === "Stuck-Aware") {
    heatTag = "Warm";
  }

  const result: IntentResult = {
    intentScore,
    rawIntentScore,
    intentState,
    suggestedNextAction,
    heatTag,
    distinctActiveDays,
    freqScore:       Math.round(fbm       * 10000) / 10000,
    maxStageScore:   Math.round(spb       * 10000) / 10000,
    engagementScore: Math.round(engagementSum * 10000) / 10000,
    velocityBonus,
    accountBonus,
    accountColleagues,
    routingRulesSuppressed: false,
  };

  result.routingRulesSuppressed = await persistIntentResult(contactId, tenantId, result, options);
  return result;
}

async function persistIntentResult(
  contactId: number,
  tenantId: number,
  r: IntentResult,
  options?: { source?: string },
): Promise<boolean> {
  const heatTagMap: Record<string, string> = {
    "Very Hot": "very-hot",
    "Hot": "hot",
    "Warm": "warm",
    "Cold": "cold",
  };
  const heatTagSlug = heatTagMap[r.heatTag] ?? "cold";
  const allHeatSlugs = Object.values(heatTagMap);

  const oldRow = (await db.execute(sql`
    SELECT intent_state, intent_score FROM contacts
    WHERE id = ${contactId} AND tenant_id = ${tenantId}
    LIMIT 1
  `)).rows[0] as { intent_state: string | null; intent_score: number | null } | undefined;

  const oldIntentState = oldRow?.intent_state ?? undefined;
  const oldScore       = oldRow?.intent_score  ?? undefined;
  const oldScoreNum    = oldScore !== undefined ? Number(oldScore) : 0;

  await db.execute(sql`
    UPDATE contacts SET
      intent_score          = ${r.intentScore},
      raw_intent_score      = ${r.rawIntentScore},
      intent_state          = ${r.intentState},
      suggested_next_action = ${r.suggestedNextAction},
      distinct_active_days  = ${r.distinctActiveDays},
      freq_score            = ${r.freqScore},
      max_stage_score       = ${r.maxStageScore},
      engagement_score      = ${r.engagementScore},
      velocity_bonus        = ${r.velocityBonus},
      account_colleagues    = ${r.accountColleagues},
      account_bonus         = ${r.accountBonus},
      tags = (
        SELECT ARRAY(
          SELECT DISTINCT unnest(
            array_append(
              ARRAY(SELECT t FROM unnest(COALESCE(tags, '{}')) AS t
                    WHERE t NOT IN (${sql.join(allHeatSlugs.map(s => sql`${s}`), sql`, `)})),
              ${heatTagSlug}
            )
          )
        )
      )
    WHERE id = ${contactId} AND tenant_id = ${tenantId}
  `);

  // Record a score history entry whenever the intent score actually changes.
  if (r.intentScore !== oldScoreNum) {
    await pool.query(
      `INSERT INTO score_history (tenant_id, contact_id, old_score, new_score, delta, source)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [tenantId, contactId, oldScoreNum, r.intentScore, r.intentScore - oldScoreNum, options?.source ?? null],
    ).catch(err => logger.warn({ err, contactId }, "Failed to insert score_history row"));
  }

  // Snapshot the formula-computed score onto the most recent activity event for
  // this contact that doesn't already have a snapshot, but only for live scoring
  // runs triggered by a real-time event (not bulk admin recomputes or backfills).
  // We also restrict to events created in the last 60 seconds to ensure we only
  // stamp the event that actually triggered this scoring run — not an old event
  // that happens to be the most recent one in the table.
  const isLiveRun = !options?.source || !NON_LIVE_SOURCES.has(options.source);
  if (isLiveRun) {
    await pool.query(
      `UPDATE activity_events
       SET intent_score_at = $1
       WHERE id = (
         SELECT id FROM activity_events
         WHERE contact_id = $2 AND tenant_id = $3
           AND intent_score_at IS NULL
           AND created_at >= NOW() - INTERVAL '60 seconds'
         ORDER BY created_at DESC
         LIMIT 1
       )`,
      [r.intentScore, contactId, tenantId],
    ).catch(err => logger.warn({ err, contactId }, "Failed to snapshot intent_score_at on activity event"));
  }

  // Skip routing rule evaluation for any non-live (admin / retroactive) source.
  //
  // Non-live sources include:
  //   • "backfill"        — historical data corrections (Resend CSV / API import)
  //   • "admin_recompute" — admin-triggered bulk recompute of all contact scores
  //
  // Firing routing rules during these operations can enroll contacts in journeys
  // or sequences they should not enter yet, or — for rules with
  // if_already_in_journey="re_add" — silently reset the added_at timestamp for
  // contacts already mid-sequence, causing them to lose their place.
  // The intent score and heat tag are still persisted normally; only the
  // side-effecting rule evaluation is suppressed.
  if (options?.source && NON_LIVE_SOURCES.has(options.source)) {
    const wouldHaveFired = r.intentState !== oldIntentState;
    if (wouldHaveFired) {
      // Record a timeline event so admins can see that routing rules were
      // intentionally suppressed for this contact during the non-live run.
      // Dedup is handled application-side: the SELECT check below looks for an
      // existing event with the same (source, contact_id, new_intent_state) before
      // inserting. The source is parameterised — this covers both 'backfill' and
      // 'admin_recompute' (and any future NON_LIVE_SOURCE added to the set).
      // Concurrent runs that race past the check will produce at most one extra
      // row, which is acceptable; the goal is to prevent the bulk-insert fan-out
      // that occurs when hundreds of contacts are recomputed simultaneously.
      //
      // Use the new_intent_state from the most recent same-source event for this
      // contact today as old_intent_state, rather than the live contacts row.
      // This prevents misleading audit trails (e.g. "Cold → Very Hot") when
      // a contact transitions multiple times in one day (Warm→Hot, Hot→Very Hot)
      // and the contacts row was already updated to reflect the latest state
      // by the time the second event is written.
      const activeSource = options.source; // known non-null inside this block
      const prevEventRes = await pool.query(
        `SELECT (metadata::jsonb)->>'new_intent_state' AS prev_new_intent_state
           FROM activity_events
          WHERE tenant_id  = $1
            AND contact_id = $2
            AND event_type = 'sequence_enrollment_skipped'
            AND source     = $3
            AND date_trunc('day', created_at AT TIME ZONE 'UTC') = date_trunc('day', NOW() AT TIME ZONE 'UTC')
          ORDER BY created_at DESC
          LIMIT 1`,
        [tenantId, contactId, activeSource],
      ).catch(() => ({ rows: [] as { prev_new_intent_state: string | null }[] }));

      const resolvedOldIntentState =
        (prevEventRes.rows as { prev_new_intent_state: string | null }[])[0]
          ?.prev_new_intent_state ?? oldIntentState ?? null;

      // Check for an existing event (same source) with the same new_intent_state
      // before inserting to avoid duplicates from concurrent backfill/recompute runs.
      // The source is parameterised so this guard covers both 'backfill' and
      // 'admin_recompute' (and any future NON_LIVE_SOURCE added to the set).
      const existingCheck = await pool.query(
        `SELECT 1 FROM activity_events
          WHERE tenant_id  = $1
            AND contact_id = $2
            AND event_type = 'sequence_enrollment_skipped'
            AND source     = $3
            AND (metadata::jsonb)->>'new_intent_state' = $4
          LIMIT 1`,
        [tenantId, contactId, activeSource, r.intentState],
      ).catch(() => ({ rows: [] }));

      if (existingCheck.rows.length === 0) {
        await pool.query(
          `INSERT INTO activity_events
             (tenant_id, contact_id, event_type, description, source, score_delta, created_at, metadata)
           VALUES ($1, $2, 'sequence_enrollment_skipped',
                   'Routing rules suppressed during non-live scoring run — intent state changed but enrollment was skipped',
                   $3, 0, NOW(), $4::jsonb)
           ON CONFLICT DO NOTHING`,
          [
            tenantId,
            contactId,
            activeSource,
            JSON.stringify({
              reason: "backfill_suppressed",
              old_intent_state: resolvedOldIntentState,
              new_intent_state: r.intentState,
            }),
          ],
        ).catch(err =>
          logger.warn({ err, contactId }, "Failed to insert sequence_enrollment_skipped event"),
        );
      }
    }
    return wouldHaveFired;
  }

  if (r.intentState !== oldIntentState) {
    await evaluateRoutingRules({
      tenantId,
      contactId,
      newScore:       r.intentScore,
      oldScore:       oldScore !== undefined ? Number(oldScore) : undefined,
      newIntentState: r.intentState,
      oldIntentState,
    }).catch(() => {});
  }
  return false;
}
