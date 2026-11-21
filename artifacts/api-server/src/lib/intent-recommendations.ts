import { pool } from "@workspace/db";
import { z } from "zod/v4";
import type { PoolClient } from "pg";

export interface IntentRecommendationOption {
  title: string;
  channel: string;
  cadence: string;
  rationale: string;
  evidence: string[];
}

export interface RecommendationContext {
  tenantId: number;
  accountId: number | null;
  contactId: number | null;
  tier: string;
  fingerprint: string;
  contributions: unknown[];
  contact?: { email: string | null; phone: string | null; title: string | null } | null;
  company?: { name: string | null } | null;
}

const optionSchema = z.object({
  title: z.string().min(1).max(160),
  channel: z.string().min(1).max(60),
  cadence: z.string().min(1).max(100),
  rationale: z.string().min(1).max(800),
  evidence: z.array(z.string().min(1).max(300)).max(8),
}).strict();
const optionsSchema = z.array(optionSchema).min(2).max(3);

function deterministicOptions(context: RecommendationContext): IntentRecommendationOption[] {
  const missing = [
    !context.contact?.email && "email",
    !context.contact?.phone && "phone",
    !context.contact?.title && "title",
    !context.company?.name && "company",
  ].filter(Boolean).join(", ");

  if (context.tier === "hot") {
    return [
      { title: "Enrich and hand off", channel: "sales", cadence: "today", rationale: missing ? `Verify missing ${missing} before assigning an owner.` : "Assign an owner while the intent is fresh.", evidence: ["High intent tier"] },
      { title: "Schedule a relevant conversation", channel: "phone", cadence: "within 24 hours", rationale: "Use the strongest recent signals to personalize outreach.", evidence: ["Recent intent signals"] },
    ];
  }
  return [
    { title: "Light re-engagement", channel: "email", cadence: "monthly", rationale: "Maintain awareness without high-pressure outreach.", evidence: ["Cold intent tier"] },
    { title: "Monitor for fresh activity", channel: "review", cadence: "monthly", rationale: "Escalate only when new signals materially change intent.", evidence: ["Decayed signal profile"] },
  ];
}

function cleanError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\r\n\t]+/g, " ").slice(0, 500);
}

async function warmOptions(context: RecommendationContext): Promise<IntentRecommendationOption[]> {
  const prompt = `Return JSON only: an array of exactly 2 or 3 outreach options. Each option must have title, channel, cadence, rationale, evidence (array of strings). Do not invent facts. Tier: warm. Contact has email=${Boolean(context.contact?.email)}, phone=${Boolean(context.contact?.phone)}, title=${Boolean(context.contact?.title)}. Company=${context.company?.name ?? "unknown"}. Signals=${JSON.stringify(context.contributions).slice(0, 5000)}`;
  const { openai } = await import("@workspace/integrations-openai-ai-server");
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await openai.chat.completions.create({
        model: "gpt-5-mini",
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: "You are a careful B2B outreach assistant. Return a JSON object with an options field only." },
          { role: "user", content: attempt ? `${prompt}\nYour prior output was invalid. Repair it to the required JSON schema.` : prompt },
        ],
      }, { timeout: 5_000, maxRetries: 0 });
      const parsed = JSON.parse(response.choices[0]?.message?.content ?? "{}");
      return optionsSchema.parse(parsed.options);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Warm recommendation generation failed");
}

/** Persists guidance only; recommendation errors never escape to scoring. */
export async function createIntentRecommendation(context: RecommendationContext, existingClient?: PoolClient): Promise<void> {
  const client = existingClient ?? await pool.connect();
  const ownsClient = !existingClient;
  try {
    await client.query("BEGIN");
    const entityKey = context.accountId ? `account:${context.accountId}` : `contact:${context.contactId}`;
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`intent-recommendation:${context.tenantId}:${entityKey}`]);
    const prior = await client.query<{ id: number; evidence: { fingerprint?: string } }>(
      `SELECT id, evidence FROM intent_recommendations
       WHERE tenant_id=$1 AND account_id IS NOT DISTINCT FROM $2 AND contact_id IS NOT DISTINCT FROM $3
          AND status='pending' ORDER BY id DESC LIMIT 1 FOR UPDATE`,
      [context.tenantId, context.accountId, context.contactId],
    );
    if (prior.rows[0]?.evidence?.fingerprint === context.fingerprint) {
      await client.query("COMMIT");
      return;
    }
    if (prior.rows[0]) {
      await client.query(
        `UPDATE intent_recommendations SET status='superseded', updated_at=NOW()
         WHERE tenant_id=$1 AND account_id IS NOT DISTINCT FROM $2 AND contact_id IS NOT DISTINCT FROM $3 AND status='pending'`,
        [context.tenantId, context.accountId, context.contactId],
      );
    }

    let options = deterministicOptions(context);
    let generationStatus = "deterministic";
    let error: string | null = null;
    if (context.tier === "warm") {
      try {
        options = await warmOptions(context);
        generationStatus = "generated";
      } catch (generationError) {
        generationStatus = "fallback";
        error = cleanError(generationError);
      }
    }
    await client.query(
      `INSERT INTO intent_recommendations
       (tenant_id, account_id, contact_id, tier, play_type, title, summary, options, evidence, generation_status, error, generated_at)
       VALUES ($1,$2,$3,$4,'guidance',$5,$6,$7,$8,$9,$10,NOW())`,
      [context.tenantId, context.accountId, context.contactId, context.tier, options[0].title,
        options[0].rationale, JSON.stringify(options), JSON.stringify({ fingerprint: context.fingerprint, contributions: context.contributions }),
        generationStatus, error],
    );
    await client.query("COMMIT");
  } catch {
    await client.query("ROLLBACK").catch(() => undefined);
    // Guidance is explicitly best-effort and must not prevent score persistence.
  } finally {
    if (ownsClient) client.release();
  }
}