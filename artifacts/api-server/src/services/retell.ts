import { pool } from "@workspace/db";
import { logger } from "../lib/logger";
import { getIntegrationConfig } from "../lib/integrationCredentials";

export interface RetellCallConfig {
  contactId: number;
  campaignId: number;
  tenantId: number;
  agentConfig: {
    agentId?: string;
    fromNumber?: string;
    apiKey?: string;
    pitchTemplateId?: number;
  };
}

export type RetellCallResult =
  | { ok: true;  callId: string }
  | { ok: false; error: string };

async function getTenantRetellConfig(tenantId: number): Promise<Record<string, string>> {
  return (await getIntegrationConfig(tenantId, "retellai") ?? {}) as Record<string, string>;
}

async function getPitchTemplate(templateId: number, tenantId: number): Promise<Record<string, string | null> | null> {
  try {
    const rows = await pool.query(
      `SELECT * FROM pitch_templates WHERE id = $1 AND tenant_id = $2 LIMIT 1`,
      [templateId, tenantId],
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
    [contactId, tenantId],
  );
  const contact = contactRes.rows[0];
  if (!contact) throw new Error(`Contact ${contactId} not found`);

  const activityRes = await pool.query<{ description: string }>(
    `SELECT description FROM activity_events
     WHERE contact_id = $1 AND tenant_id = $2 AND COALESCE(is_bot, false) = false
     ORDER BY created_at DESC LIMIT 5`,
    [contactId, tenantId],
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

function normalizePhoneE164(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s) return null;
  if (s.startsWith("+")) {
    const digits = s.slice(1).replace(/\D/g, "");
    return digits.length >= 7 ? `+${digits}` : null;
  }
  let digits: string;
  if (/[Ee]/.test(s)) {
    const n = Number(s);
    if (!isFinite(n)) return null;
    digits = Math.round(n).toString();
  } else {
    digits = s.replace(/\D/g, "");
  }
  if (!digits) return null;
  if (digits.length === 10) return `+91${digits}`;
  if (digits.length === 12 && digits.startsWith("91")) return `+${digits}`;
  if (digits.length === 11 && digits.startsWith("0")) return `+91${digits.slice(1)}`;
  return `+${digits}`;
}

export async function initiateRetellCall(cfg: RetellCallConfig): Promise<RetellCallResult> {
  const { contactId, campaignId, tenantId, agentConfig } = cfg;

  const tenantCfg = await getTenantRetellConfig(tenantId);
  const apiKey    = agentConfig.apiKey    ?? tenantCfg.apiKey    ?? process.env.RETELL_API_KEY;
  const agentId   = agentConfig.agentId   ?? tenantCfg.agentId   ?? process.env.RETELL_AGENT_ID;
  const fromNumber = agentConfig.fromNumber ?? tenantCfg.fromNumber ?? process.env.RETELL_FROM_NUMBER;

  if (!apiKey)     return { ok: false, error: "Retell API key not configured. Add it in Settings → Integrations." };
  if (!agentId)    return { ok: false, error: "Retell Agent ID not configured. Add it in Settings → Integrations." };
  if (!fromNumber) return { ok: false, error: "Retell From Number not configured. Add it in Settings → Integrations." };

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

  const dynamicVariables: Record<string, string> = {
    contactFirstName: ctx.firstName,
    contactLastName:  ctx.lastName,
    contactName:      `${ctx.firstName} ${ctx.lastName}`.trim(),
    companyName:      ctx.companyName ?? "",
    leadScore:        String(ctx.leadScore),
    stage:            ctx.stage,
  };

  if (agentConfig.pitchTemplateId) {
    const pitchTemplate = await getPitchTemplate(agentConfig.pitchTemplateId, tenantId);
    if (!pitchTemplate) {
      return { ok: false, error: `Call blocked: pitchTemplateId=${agentConfig.pitchTemplateId} not found for tenantId=${tenantId}.` };
    }

    const t = pitchTemplate;
    if (t.campaign_first_message)         dynamicVariables.campaignFirstMessage        = t.campaign_first_message;
    if (t.product_key)                    dynamicVariables.campaignProductKey          = t.product_key;
    if (t.product_name)                   dynamicVariables.productName                 = t.product_name;
    if (t.language_mode)                  dynamicVariables.languageMode                = t.language_mode;
    if (t.campaign_first_message_hindi)   dynamicVariables.campaignFirstMessageHindi   = t.campaign_first_message_hindi;
    if (t.not_a_pitch_disclaimer)         dynamicVariables.notAPitchDisclaimer         = t.not_a_pitch_disclaimer;
    if (t.not_a_pitch_disclaimer_hindi)   dynamicVariables.notAPitchDisclaimerHindi    = t.not_a_pitch_disclaimer_hindi;
    if (t.hook_context)                   dynamicVariables.hookContext                  = t.hook_context;
    if (t.hook_context_hindi)             dynamicVariables.hookContextHindi             = t.hook_context_hindi;
    if (t.need_discovery_question)        dynamicVariables.needDiscoveryQuestion        = t.need_discovery_question;
    if (t.need_discovery_question_hindi)  dynamicVariables.needDiscoveryQuestionHindi   = t.need_discovery_question_hindi;
    if (t.bridge_statement)               dynamicVariables.bridgeStatement              = t.bridge_statement;
    if (t.bridge_statement_hindi)         dynamicVariables.bridgeStatementHindi         = t.bridge_statement_hindi;
    if (t.offer_name)                     dynamicVariables.offerName                    = t.offer_name;
    if (t.offer_name_hindi)               dynamicVariables.offerNameHindi               = t.offer_name_hindi;
    if (t.offer_duration)                 dynamicVariables.offerDuration                = t.offer_duration;
    if (t.offer_what_they_get)            dynamicVariables.offerWhatTheyGet             = t.offer_what_they_get;
    if (t.offer_free_statement)           dynamicVariables.offerFreeStatement           = t.offer_free_statement;
    if (t.value_bullets)                  dynamicVariables.valueBullets                 = t.value_bullets;
    if (t.cta)                            dynamicVariables.cta                          = t.cta;
  }

  const payload = {
    from_number: fromNumber,
    to_number:   ctx.phone,
    agent_id:    agentId,
    retell_llm_dynamic_variables: dynamicVariables,
    metadata: {
      contactId:  String(contactId),
      campaignId: String(campaignId),
      tenantId:   String(tenantId),
    },
  };

  try {
    const resp = await fetch("https://api.retellai.com/v2/create-phone-call", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!resp.ok) {
      const err = await resp.text().catch(() => "");
      logger.warn({ contactId, campaignId, status: resp.status, err }, "Retell call initiation failed");
      return { ok: false, error: `Retell API error ${resp.status}: ${err.slice(0, 200)}` };
    }

    const data = await resp.json() as { call_id: string; call_status?: string };
    logger.info({ callId: data.call_id, status: data.call_status, contactId, campaignId, fromNumber, toNumber: ctx.phone }, "Retell call initiated");
    return { ok: true, callId: data.call_id };
  } catch (err: any) {
    logger.warn({ err, contactId, campaignId }, "Retell call fetch failed");
    return { ok: false, error: `Network error: ${err.message}` };
  }
}

export const RETELL_CALL_SCORE_DELTAS: Record<string, number> = {
  interested:    15,
  callback:       8,
  no_answer:      0,
  not_interested: 0,
  dnc:           -5,
};

export async function fetchRetellCalls(apiKey: string, options?: { limit?: number; agentId?: string }): Promise<any[]> {
  try {
    const params = new URLSearchParams();
    if (options?.limit) params.set("limit", String(options.limit));
    if (options?.agentId) params.set("agent_id", options.agentId);

    const resp = await fetch(`https://api.retellai.com/v2/list-calls?${params}`, {
      method: "GET",
      headers: { "Authorization": `Bearer ${apiKey}` },
    });

    if (!resp.ok) return [];
    const data = await resp.json() as any;
    return Array.isArray(data) ? data : (data.calls ?? []);
  } catch {
    return [];
  }
}
