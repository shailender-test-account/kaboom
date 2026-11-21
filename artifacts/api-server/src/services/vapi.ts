import { pool } from "@workspace/db";
import { logger } from "../lib/logger";
import { getIntegrationConfig } from "../lib/integrationCredentials";

export interface VapiCallConfig {
  contactId: number;
  campaignId: number;
  tenantId: number;
  agentConfig: {
    assistantId?: string;
    personaName?: string;
    goal?: string;
    keyTalkingPoints?: string;
    voiceId?: string;
    phoneNumberId?: string;
    apiKey?: string;
    pitchTemplateId?: number;
  };
}

export type VapiCallResult =
  | { ok: true;  callId: string }
  | { ok: false; error: string };

async function getTenantVapiConfig(tenantId: number): Promise<Record<string, string>> {
  return (await getIntegrationConfig(tenantId, "vapi") ?? {}) as Record<string, string>;
}

async function getPitchTemplate(templateId: number, tenantId: number): Promise<Record<string, string | null> | null> {
  try {
    const rows = await pool.query(
      `SELECT * FROM pitch_templates WHERE id = $1 AND tenant_id = $2 LIMIT 1`,
      [templateId, tenantId]
    );
    return rows.rows[0] ?? null;
  } catch {
    return null;
  }
}

async function getContactContext(contactId: number, tenantId: number): Promise<{
  firstName: string; lastName: string; email: string; phone: string | null;
  companyName: string | null; leadScore: number; stage: string;
  recentActivity: string[];
}> {
  const contactRes = await pool.query<{
    first_name: string; last_name: string; email: string; phone: string | null;
    company_name: string | null; lead_score: number; stage: string;
  }>(
    `SELECT c.first_name, c.last_name, c.email, c.phone,
            co.name AS company_name, c.lead_score, c.stage
     FROM contacts c
     LEFT JOIN companies co ON co.id = c.company_id AND co.tenant_id = c.tenant_id
     WHERE c.id = $1 AND c.tenant_id = $2`,
    [contactId, tenantId]
  );
  const contact = contactRes.rows[0];
  if (!contact) throw new Error(`Contact ${contactId} not found`);

  const activityRes = await pool.query<{ description: string }>(
    `SELECT description FROM activity_events
     WHERE contact_id = $1 AND tenant_id = $2 AND COALESCE(is_bot, false) = false
     ORDER BY created_at DESC LIMIT 5`,
    [contactId, tenantId]
  );
  const recentActivity = activityRes.rows.map(r => r.description).filter(Boolean);

  return {
    firstName: contact.first_name ?? "",
    lastName: contact.last_name ?? "",
    email: contact.email ?? "",
    phone: contact.phone ?? null,
    companyName: contact.company_name ?? null,
    leadScore: contact.lead_score ?? 0,
    stage: contact.stage ?? "pre-aware",
    recentActivity,
  };
}

function buildSystemPrompt(ctx: Awaited<ReturnType<typeof getContactContext>>, agentConfig: VapiCallConfig["agentConfig"]): string {
  const persona = agentConfig.personaName ?? "Alex";
  const goal = agentConfig.goal ?? "Introduce our solution and qualify interest";
  const talkingPoints = agentConfig.keyTalkingPoints ?? "";

  const activitySummary = ctx.recentActivity.length
    ? `Recent activity: ${ctx.recentActivity.slice(0, 3).join("; ")}.`
    : "No recent activity on record.";

  return `You are ${persona}, a professional sales development representative.

CONTACT:
- Name: ${ctx.firstName} ${ctx.lastName}
- Company: ${ctx.companyName ?? "Unknown"}
- Stage: ${ctx.stage} (lead score: ${ctx.leadScore})
- ${activitySummary}

GOAL: ${goal}

KEY TALKING POINTS:
${talkingPoints || "- Introduce yourself and the company\n- Ask about their current challenges\n- Qualify interest and schedule a follow-up"}

INSTRUCTIONS:
- Be conversational, warm, and professional
- Listen actively and acknowledge what the contact says
- If they are interested, try to schedule a follow-up meeting
- If they ask to be removed from calls (DNC), acknowledge it politely and end the call
- If they don't answer or go to voicemail, leave a brief friendly voicemail
- NEVER be pushy or aggressive
- Keep the call under 5 minutes unless the contact is very engaged

OUTCOME CLASSIFICATION (use these exactly in your end-of-call summary):
- "interested" — contact expressed clear interest and wants to continue
- "callback" — contact wants to be called back or scheduled for a demo
- "no_answer" — no answer or voicemail only
- "not_interested" — contact declined politely
- "dnc" — contact explicitly asked to not be called again`;
}

/**
 * Normalize a raw phone value to E.164 format (+countrycode digits).
 * Handles:
 *  - Already-valid E.164 (+91XXXXXXXXXX)
 *  - Scientific notation stored as string ("9.12226E+11") — common when
 *    phone was imported as a number and serialized by Excel/CSV
 *  - Raw 10-digit Indian mobile (9XXXXXXXXX → +919XXXXXXXXX)
 *  - Raw 12-digit with country code but no + (91XXXXXXXXXX → +91XXXXXXXXXX)
 *  - Other lengths: prepend "+" so the Vapi reject message is accurate
 */
function normalizePhoneE164(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s) return null;

  // Already valid E.164
  if (s.startsWith("+")) {
    const digits = s.slice(1).replace(/\D/g, "");
    return digits.length >= 7 ? `+${digits}` : null;
  }

  // Scientific notation (e.g. "9.12226E+11" or "9.12226e11")
  let digits: string;
  if (/[Ee]/.test(s)) {
    const n = Number(s);
    if (!isFinite(n)) return null;
    digits = Math.round(n).toString();
  } else {
    digits = s.replace(/\D/g, "");
  }

  if (!digits) return null;

  // 10-digit Indian mobile (no country code)
  if (digits.length === 10) return `+91${digits}`;
  // 12-digit with Indian country code but no +
  if (digits.length === 12 && digits.startsWith("91")) return `+${digits}`;
  // 11-digit (some formats include a leading 0 before the 10-digit number)
  if (digits.length === 11 && digits.startsWith("0")) return `+91${digits.slice(1)}`;

  // Unknown length — add + and let Vapi validate
  return `+${digits}`;
}

export async function initiateCall(cfg: VapiCallConfig): Promise<VapiCallResult> {
  const { contactId, campaignId, tenantId, agentConfig } = cfg;

  const tenantCfg = await getTenantVapiConfig(tenantId);
  const apiKey        = agentConfig.apiKey        ?? tenantCfg.apiKey        ?? process.env.VAPI_API_KEY;
  const phoneNumberId = agentConfig.phoneNumberId ?? tenantCfg.phoneNumberId ?? process.env.VAPI_PHONE_NUMBER_ID;
  const voiceProvider = (agentConfig as any).voiceProvider ?? tenantCfg.voiceProvider ?? "vapi";
  const voiceId       = agentConfig.voiceId ?? tenantCfg.voiceId ?? "";

  if (!apiKey) return { ok: false, error: "Vapi API key not configured. Add it in Settings → Integrations." };
  if (!phoneNumberId) return { ok: false, error: "Vapi phone number ID not configured. Add it in Settings → Integrations." };

  let ctx: Awaited<ReturnType<typeof getContactContext>>;
  try {
    ctx = await getContactContext(contactId, tenantId);
  } catch (err: any) {
    return { ok: false, error: err.message };
  }

  if (!ctx.phone) {
    return { ok: false, error: `Contact ${ctx.firstName} ${ctx.lastName} has no phone number on file.` };
  }

  const normalizedPhone = normalizePhoneE164(ctx.phone);
  if (!normalizedPhone) {
    return { ok: false, error: `Contact ${ctx.firstName} ${ctx.lastName} has no phone number on file.` };
  }
  if (!normalizedPhone.startsWith("+")) {
    return {
      ok: false,
      error: `Phone number "${normalizedPhone}" is missing a country code. Use E.164 format, e.g. +1… (US), +44… (UK), +91… (India).`,
    };
  }
  ctx = { ...ctx, phone: normalizedPhone };

  // ── Load pitch template (REQUIRED) ────────────────────────────────────────
  if (!agentConfig.pitchTemplateId) {
    return { ok: false, error: "Call blocked: pitchTemplateId is required for this campaign." };
  }

  const pitchTemplate = await getPitchTemplate(agentConfig.pitchTemplateId, tenantId);

  if (!pitchTemplate) {
    return { ok: false, error: `Call blocked: pitchTemplateId=${agentConfig.pitchTemplateId} not found for tenantId=${tenantId}.` };
  }

  // ── Validate required template fields (hard fail) ──────────────────────────
  const REQUIRED_FIELDS = [
    "campaign_first_message",
    "need_discovery_question",
    "bridge_statement",
    "offer_name",
    "offer_duration",
  ] as const;

  const missing = REQUIRED_FIELDS.filter(k => {
    const v = pitchTemplate[k];
    return typeof v !== "string" || v.trim().length === 0;
  });

  if (missing.length) {
    return { ok: false, error: `Call blocked: pitchTemplateId=${agentConfig.pitchTemplateId} missing required fields: ${missing.join(", ")}` };
  }

  // ── Base contact variables (always sent) ───────────────────────────────────
  const contactVars: Record<string, string> = {
    contactFirstName: ctx.firstName,
    contactLastName:  ctx.lastName,
    contactName:      `${ctx.firstName} ${ctx.lastName}`.trim(),
    companyName:      ctx.companyName ?? "",
    leadScore:        String(ctx.leadScore),
    stage:            ctx.stage,
  };

  // ── Template variables ─────────────────────────────────────────────────────
  // campaignFirstMessage → assistantOverrides.firstMessage only (not a variableValue)
  // campaignFirstMessageHindi → variableValues so the prompt can ref {{campaignFirstMessageHindi}}
  const t = pitchTemplate;
  const templateVars: Record<string, string> = {};
  if (t.product_key)                    templateVars.campaignProductKey        = t.product_key;
  if (t.product_name)                   templateVars.productName               = t.product_name;
  if (t.language_mode)                  templateVars.languageMode              = t.language_mode;
  if (t.campaign_first_message_hindi)   templateVars.campaignFirstMessageHindi = t.campaign_first_message_hindi;
  if (t.not_a_pitch_disclaimer)         templateVars.notAPitchDisclaimer       = t.not_a_pitch_disclaimer;
  if (t.not_a_pitch_disclaimer_hindi)   templateVars.notAPitchDisclaimerHindi  = t.not_a_pitch_disclaimer_hindi;
  if (t.hook_context)                   templateVars.hookContext               = t.hook_context;
  if (t.hook_context_hindi)             templateVars.hookContextHindi          = t.hook_context_hindi;
  if (t.need_discovery_question)        templateVars.needDiscoveryQuestion     = t.need_discovery_question;
  if (t.need_discovery_question_hindi)  templateVars.needDiscoveryQuestionHindi = t.need_discovery_question_hindi;
  if (t.bridge_statement)               templateVars.bridgeStatement           = t.bridge_statement;
  if (t.bridge_statement_hindi)         templateVars.bridgeStatementHindi      = t.bridge_statement_hindi;
  if (t.offer_name)                     templateVars.offerName                 = t.offer_name;
  if (t.offer_name_hindi)               templateVars.offerNameHindi            = t.offer_name_hindi;
  if (t.offer_duration)                 templateVars.offerDuration             = t.offer_duration;
  if (t.offer_what_they_get)            templateVars.offerWhatTheyGet          = t.offer_what_they_get;
  if (t.offer_free_statement)           templateVars.offerFreeStatement        = t.offer_free_statement;
  if (t.value_bullets)                  templateVars.valueBullets              = t.value_bullets;
  if (t.cta)                            templateVars.cta                       = t.cta;

  const variableValues = { ...contactVars, ...templateVars };

  // Resolve assistant ID: campaign-level override → tenant default → fall back to inline build
  const assistantId = agentConfig.assistantId || tenantCfg.assistantId || null;

  let payload: Record<string, unknown>;

  if (assistantId) {
    const overrides: Record<string, unknown> = { variableValues };
    // Set firstMessage override from template (each product/campaign has its own opener)
    if (pitchTemplate?.campaign_first_message) {
      overrides.firstMessage = pitchTemplate.campaign_first_message;
    }

    payload = {
      type: "outboundPhoneCall",
      phoneNumberId,
      customer: { number: ctx.phone, name: `${ctx.firstName} ${ctx.lastName}` },
      assistantId,
      assistantOverrides: overrides,
      metadata: {
        contactId:  String(contactId),
        campaignId: String(campaignId),
        tenantId:   String(tenantId),
      },
    };
  } else {
    // Fallback: build an inline assistant from the campaign's agent script
    const systemPrompt = buildSystemPrompt(ctx, agentConfig);
    payload = {
      type: "outboundPhoneCall",
      phoneNumberId,
      customer: { number: ctx.phone, name: `${ctx.firstName} ${ctx.lastName}` },
      assistant: {
        name: agentConfig.personaName ?? "Alex",
        model: {
          provider: "openai",
          model: "gpt-4o-mini",
          messages: [{ role: "system", content: systemPrompt }],
          temperature: 0.7,
        },
        voice: voiceProvider === "11labs" && voiceId
          ? { provider: "11labs", voiceId }
          : voiceId
            ? { provider: "vapi", voiceId }
            : { provider: "vapi", voiceId: "Abby" },
        firstMessage: pitchTemplate?.campaign_first_message
          ?? `Hello, may I speak with ${ctx.firstName}? This is ${agentConfig.personaName ?? "Alex"} calling.`,
        endCallMessage: "Thank you for your time. Have a great day!",
        transcriber: { provider: "deepgram", model: "nova-2" },
      },
      metadata: {
        contactId:  String(contactId),
        campaignId: String(campaignId),
        tenantId:   String(tenantId),
      },
    };
  }

  try {
    const resp = await fetch("https://api.vapi.ai/call", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!resp.ok) {
      const err = await resp.text().catch(() => "");
      logger.warn({ contactId, campaignId, status: resp.status, err }, "Vapi call initiation failed");
      return { ok: false, error: `Vapi API error ${resp.status}: ${err.slice(0, 200)}` };
    }

    const data = await resp.json() as { id: string; status?: string; endedReason?: string };
    logger.info({ callId: data.id, status: data.status, endedReason: data.endedReason, contactId, campaignId, phoneNumberId, toNumber: ctx.phone }, "Vapi call initiated");
    return { ok: true, callId: data.id };
  } catch (err: any) {
    logger.warn({ err, contactId, campaignId }, "Vapi call fetch failed");
    return { ok: false, error: `Network error: ${err.message}` };
  }
}

export const CALL_SCORE_DELTAS: Record<string, number> = {
  interested:    15,
  callback:       8,
  no_answer:      0,
  not_interested: 0,
  dnc:           -5,
};
