/**
 * LLM-powered transcript analyser.
 * Calls the configured model via Replit AI Integrations to produce a structured
 * JSON analysis of a Vapi call, then persists the result to `call_analysis`.
 *
 * Prompt and routing rules are loaded from:
 *   - callAnalysisPrompt.json  — system prompt text (edit to tune without redeploy)
 *   - callAnalysisRules.json   — model settings, score bands, valid enums
 *
 * Designed to run fire-and-forget (non-blocking) from the Vapi webhook or
 * the manual /analyse endpoint. The caller never awaits this function.
 */

import { pool } from "@workspace/db";
import { logger } from "./logger";

// ── Config loading ────────────────────────────────────────────────────────────
// JSON configs are imported statically so esbuild bundles them inline —
// no fs.readFileSync required (which would fail in the compiled dist/).
// To tune the LLM behaviour, edit callAnalysisPrompt.json / callAnalysisRules.json
// and redeploy (or restart the dev server to pick up HMR changes).

import promptConfigJson from "../config/callAnalysisPrompt.json";
import rulesConfigJson  from "../config/callAnalysisRules.json";

interface PromptConfig {
  systemPrompt: string;
}

interface TeamRouting {
  salesMinScore: number;
  marketingMaxScore: number;
}

interface RulesConfig {
  model: string;
  maxCompletionTokens: number;
  teamRouting: TeamRouting;
  validSentiments: string[];
  validOwningTeams: string[];
  actionTimings: string[];
}

const PROMPT_CONFIG: PromptConfig = promptConfigJson as PromptConfig;
const RULES_CONFIG:  RulesConfig  = rulesConfigJson  as RulesConfig;

/**
 * Build the final system prompt by injecting operative thresholds from
 * callAnalysisRules.json into the template placeholders.
 * This ensures changing rules.json (without touching TS code) materially
 * changes the LLM's routing and timing behaviour.
 */
function buildSystemPrompt(): string {
  const timings = RULES_CONFIG.actionTimings.join("|");
  return PROMPT_CONFIG.systemPrompt
    .replace(/\{\{SALES_MIN_SCORE\}\}/g,    String(RULES_CONFIG.teamRouting.salesMinScore))
    .replace(/\{\{MARKETING_MAX_SCORE\}\}/g, String(RULES_CONFIG.teamRouting.marketingMaxScore))
    .replace(/\{\{ACTION_TIMINGS\}\}/g,      timings);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildUserMessage(params: {
  transcript: string;
  outcome: string | null;
  durationSeconds: number | null;
  contactName: string;
  companyName: string | null;
}): string {
  const { transcript, outcome, durationSeconds, contactName, companyName } = params;
  const lines: string[] = [];
  lines.push(`Contact: ${contactName}${companyName ? ` at ${companyName}` : ""}`);
  if (outcome) lines.push(`Call outcome: ${outcome}`);
  if (durationSeconds != null) lines.push(`Duration: ${durationSeconds}s`);
  lines.push("");
  lines.push("TRANSCRIPT:");
  lines.push(transcript);
  return lines.join("\n");
}

function sanitise(raw: Record<string, unknown>): {
  call_summary: string;
  prospect_profile: Record<string, unknown>;
  key_highlights: string[];
  sentiment: "positive" | "neutral" | "negative";
  sentiment_justification: string;
  interest_score: number;
  interest_justification: string;
  recommended_action: string;
  owning_team: "sales" | "marketing";
  action_reason: string;
  action_timing: string;
  follow_up_message: string;
} {
  const rules = RULES_CONFIG;

  const sentiment = rules.validSentiments.includes(String(raw.sentiment))
    ? (raw.sentiment as "positive" | "neutral" | "negative")
    : "neutral";

  const owning_team = rules.validOwningTeams.includes(String(raw.owning_team))
    ? (raw.owning_team as "sales" | "marketing")
    : "sales";

  const action_timing = rules.actionTimings.includes(String(raw.action_timing))
    ? String(raw.action_timing)
    : "this_week";

  const raw_score = Number(raw.interest_score);
  const interest_score = Number.isFinite(raw_score)
    ? Math.max(1, Math.min(10, Math.round(raw_score)))
    : 5;

  return {
    call_summary: String(raw.call_summary ?? ""),
    prospect_profile: (typeof raw.prospect_profile === "object" && raw.prospect_profile)
      ? raw.prospect_profile as Record<string, unknown>
      : {},
    key_highlights: Array.isArray(raw.key_highlights)
      ? (raw.key_highlights as unknown[]).map(String).slice(0, 5)
      : [],
    sentiment,
    sentiment_justification: String(raw.sentiment_justification ?? ""),
    interest_score,
    interest_justification: String(raw.interest_justification ?? ""),
    recommended_action: String(raw.recommended_action ?? ""),
    owning_team,
    action_reason: String(raw.action_reason ?? ""),
    action_timing,
    follow_up_message: String(raw.follow_up_message ?? ""),
  };
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function analyseTranscriptLLM(params: {
  callLogId: number;
  tenantId: number;
  contactId: number | null;
  transcript: string;
  outcome: string | null;
  durationSeconds: number | null;
  contactName: string;
  companyName: string | null;
}): Promise<void> {
  const { callLogId, tenantId, contactId, transcript, outcome, durationSeconds, contactName, companyName } = params;

  const rules = RULES_CONFIG;

  // Always create a call_analysis row — even for voicemails / dropped calls.
  // Truly empty transcripts receive a synthetic "too_short" result so the row
  // exists and can be retried later when a recording becomes available.
  if (!transcript || transcript.trim().length === 0) {
    await pool.query(
      `INSERT INTO call_analysis
         (tenant_id, call_log_id, contact_id,
          call_summary, sentiment, interest_score,
          recommended_action, owning_team, action_timing,
          status, processed_at, created_at)
       VALUES ($1,$2,$3, $4,'neutral',1,$5,'marketing','no_action','completed',NOW(),NOW())
       ON CONFLICT (call_log_id) DO NOTHING`,
      [
        tenantId, callLogId, contactId,
        "Call ended with no transcript (voicemail, dropped call, or silent).",
        "No transcript available — schedule a retry or attempt via a different channel.",
      ],
    );
    logger.info({ callLogId }, "call_analysis created with synthetic empty-transcript result");
    return;
  }

  // Mark as processing (upsert so re-trigger works)
  await pool.query(
    `INSERT INTO call_analysis (tenant_id, call_log_id, contact_id, status, created_at)
     VALUES ($1, $2, $3, 'processing', NOW())
     ON CONFLICT (call_log_id) DO UPDATE SET status = 'processing', error_message = NULL`,
    [tenantId, callLogId, contactId],
  );

  try {
    const { openai } = await import("@workspace/integrations-openai-ai-server");

    // Build prompt with operative thresholds injected from rules.json
    const systemPrompt = buildSystemPrompt();
    const userMsg = buildUserMessage({ transcript, outcome, durationSeconds, contactName, companyName });

    const response = await openai.chat.completions.create({
      model: rules.model,
      max_completion_tokens: rules.maxCompletionTokens,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMsg },
      ],
      response_format: { type: "json_object" },
    });

    const rawContent = response.choices[0]?.message?.content ?? "{}";

    // Strip markdown code fences if present (some models wrap despite instructions)
    const cleanContent = rawContent
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```\s*$/, "")
      .trim();

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(cleanContent);
    } catch {
      throw new Error(`LLM returned non-JSON: ${rawContent.slice(0, 200)}`);
    }

    const a = sanitise(parsed);

    await pool.query(
      `UPDATE call_analysis SET
         call_summary            = $1,
         prospect_profile        = $2::jsonb,
         key_highlights          = $3::jsonb,
         sentiment               = $4,
         sentiment_justification = $5,
         interest_score          = $6,
         interest_justification  = $7,
         recommended_action      = $8,
         owning_team             = $9,
         action_reason           = $10,
         action_timing           = $11,
         follow_up_message       = $12,
         raw_llm_response        = $13::jsonb,
         status                  = 'completed',
         processed_at            = NOW()
       WHERE call_log_id = $14 AND tenant_id = $15`,
      [
        a.call_summary,
        JSON.stringify(a.prospect_profile),
        JSON.stringify(a.key_highlights),
        a.sentiment,
        a.sentiment_justification,
        a.interest_score,
        a.interest_justification,
        a.recommended_action,
        a.owning_team,
        a.action_reason,
        a.action_timing,
        a.follow_up_message,
        // Store the validated, cleaned JSON — not the raw (possibly truncated) string
        JSON.stringify(parsed),
        callLogId,
        tenantId,
      ],
    );

    // Backward-compat: write structured output back to call_logs so legacy
    // ai_summary / ai_next_steps fields remain populated for older UI paths.
    await pool.query(
      `UPDATE call_logs
         SET ai_summary    = $1,
             ai_next_steps = $2
       WHERE id = $3 AND tenant_id = $4`,
      [a.call_summary, a.recommended_action, callLogId, tenantId],
    ).catch(() => {}); // non-fatal

    logger.info(
      { callLogId, tenantId, interestScore: a.interest_score, sentiment: a.sentiment },
      "LLM call analysis complete",
    );
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    logger.warn({ err, callLogId, tenantId }, "LLM transcript analysis failed");
    await pool.query(
      `UPDATE call_analysis SET status = 'failed', error_message = $1
       WHERE call_log_id = $2 AND tenant_id = $3`,
      [msg.slice(0, 500), callLogId, tenantId],
    ).catch(() => {});
  }
}
