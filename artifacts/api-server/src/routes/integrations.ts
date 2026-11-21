import { Router, type IRouter } from "express";
import { z } from "zod";
import { requireAuth } from "../middlewares/requireAuth";
import { logger } from "../lib/logger";
import { invalidateTenantEmailCache } from "../services/email";
import { invalidateTenantQueueCache } from "../services/queue";
import { getIntegrationConfig, saveIntegrationConfig, CredentialStoreError } from "../lib/integrationCredentials";
import { getMailConfig, requestResend, resendReadiness } from "../services/resendTransport";

const router: IRouter = Router();
router.use(requireAuth);
router.use("/integrations", (req, res, next) => {
  const user = req.user as any;
  if (user?.role !== "admin") {
    res.status(403).json({ error: "Only workspace admins can manage integrations" });
    return;
  }
  if (!Number.isSafeInteger(user.tenantId) || user.tenantId <= 0) {
    res.status(403).json({ error: "Invalid workspace" });
    return;
  }
  next();
});

const ResendConfigSchema = z.object({
  apiKey:    z.string().min(1).optional(),
  fromEmail: z.string().email().optional(),
  fromName:  z.string().optional(),
});

// Explicitly read-only: unlike /test this endpoint never sends an email.
router.get("/integrations/resend/readiness", async (req, res): Promise<void> => {
  res.setHeader("Cache-Control", "no-store");
  res.json(await resendReadiness((req.user as any).tenantId));
});

const UpstashConfigSchema = z.object({
  redisUrl: z.string().min(1).optional(),
  token:    z.string().optional(),
});

const IntentProviderConfigSchema = z.object({
  apiKey: z.string().trim().min(1).optional(),
  maxRequestsPerRun: z.number().int().min(1).max(500).optional(),
  enabled: z.boolean().optional(),
});

function maskKey(key: string): string {
  if (key.length <= 4) return "••••";
  return "re_" + "•".repeat(Math.max(key.length - 7, 8)) + key.slice(-4);
}

function maskProviderKey(key: string): string {
  return "•".repeat(8) + (key.length > 4 ? key.slice(-4) : "");
}

function maskRedisUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}/••••`;
  } catch {
    return "••••";
  }
}

/**
 * Validate a Redis URL to prevent SSRF attacks.
 * Allows only redis:// and rediss:// schemes and blocks private/loopback ranges.
 * Returns an error string if invalid, undefined if safe.
 */
function validateRedisUrl(raw: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return "Invalid URL format";
  }
  if (!["redis:", "rediss:"].includes(parsed.protocol)) {
    return "Only redis:// and rediss:// URLs are supported";
  }
  const hostname = parsed.hostname.toLowerCase();
  const blocked = [
    /^localhost$/,
    /^127\./,
    /^10\./,
    /^172\.(1[6-9]|2\d|3[01])\./,
    /^192\.168\./,
    /^::1$/,
    /^0\.0\.0\.0$/,
    /^fd[0-9a-f]{2}:/i,
    /^fe80:/i,
  ];
  for (const re of blocked) {
    if (re.test(hostname)) {
      return "Connections to private/loopback addresses are not allowed";
    }
  }
  return undefined;
}

// ── Per-tenant integration config helpers ──────────────────────────────────
// Both Resend and Upstash are stored in tenant_integrations, scoped by tenantId.
// The queue service resolves the tenant's Upstash URL at enqueue time.

// ── Routes ─────────────────────────────────────────────────────────────────

router.get("/integrations/:provider", async (req, res, next): Promise<void> => {
  try {
    const user = req.user as any;
    const { provider } = req.params;

    if (provider === "newsapi" || provider === "apollo") {
      const config = await getIntegrationConfig(user.tenantId, provider);
      res.json({
        provider,
        configured: !!config?.apiKey,
        maskedKey: config?.apiKey ? maskProviderKey(config.apiKey) : null,
        enabled: config?.enabled !== false,
        maxRequestsPerRun: Number(config?.maxRequestsPerRun) || (provider === "newsapi" ? 100 : 20),
      });
      return;
    }

    if (provider === "resend") {
      const config = await getMailConfig(user.tenantId);
      res.json({
        provider,
        configured: config.transport === "connector" || !!config.apiKey,
        transport: config.transport,
        maskedKey: config.transport === "api_key" && config.apiKey ? maskKey(config.apiKey) : null,
        fromEmail: config.fromEmail ?? null,
        fromName:  config.fromName  ?? null,
      });
      return;
    }

    if (provider === "upstash") {
      // Stored per-tenant in tenant_integrations. Falls back to env var so the
      // GET response accurately reflects the active queue URL for this tenant.
      const config = await getIntegrationConfig(user.tenantId, provider);
      if (!config || !config.redisUrl) {
        const hasEnvFallback = !!process.env.UPSTASH_REDIS_URL;
        res.json({
          provider,
          configured: false,
          maskedUrl: hasEnvFallback ? maskRedisUrl(process.env.UPSTASH_REDIS_URL!) : null,
          hasToken: false,
          source: hasEnvFallback ? "env" : "none",
        });
        return;
      }
      res.json({
        provider,
        configured: true,
        maskedUrl: maskRedisUrl(config.redisUrl),
        hasToken: !!config.token,
        source: "db",
      });
      return;
    }

    if (provider === "vapi") {
      const config = await getIntegrationConfig(user.tenantId, provider);
      // Build assistants list: prefer stored array, fall back to legacy single assistantId
      const assistants: { name: string; id: string }[] =
        Array.isArray(config?.assistants) && config.assistants.length > 0
          ? config.assistants
          : config?.assistantId
            ? [{ name: "Default", id: config.assistantId }]
            : [];
      res.json({
        provider,
        configured:       !!(config?.apiKey),
        maskedKey:        config?.apiKey ? maskProviderKey(config.apiKey) : null,
        assistants,
        assistantId:      assistants[0]?.id ?? null,  // compat: first entry as default
        phoneNumberId:    config?.phoneNumberId ?? null,
        voiceProvider:    config?.voiceProvider ?? "vapi",
        voiceId:          config?.voiceId ?? null,
        hasWebhookSecret: !!(config?.webhookSecret),
      });
      return;
    }

    if (provider === "elevenlabs") {
      const config = await getIntegrationConfig(user.tenantId, provider);
      res.json({
        provider,
        configured: !!(config?.voiceId),
        voiceId:   config?.voiceId ?? null,
        voiceName: config?.voiceName ?? null,
      });
      return;
    }

    if (provider === "retellai") {
      const config = await getIntegrationConfig(user.tenantId, provider);
      res.json({
        provider,
        configured:       !!(config?.apiKey),
        maskedKey:        config?.apiKey ? maskProviderKey(config.apiKey) : null,
        agentId:          config?.agentId ?? null,
        fromNumber:       config?.fromNumber ?? null,
        hasWebhookSecret: !!(config?.webhookSecret),
      });
      return;
    }

    res.status(400).json({ error: "Unsupported provider" });
  } catch (err) { next(err); }
});

router.put("/integrations/:provider", async (req, res, next): Promise<void> => {
  try {
    const user = req.user as any;
    const { provider } = req.params;

    if (provider === "newsapi" || provider === "apollo") {
      if (user.role !== "admin") {
        res.status(403).json({ error: "Only workspace admins can configure intent providers" });
        return;
      }
      const parsed = IntentProviderConfigSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid input", details: parsed.error.issues });
        return;
      }
      const existing = await getIntegrationConfig(user.tenantId, provider);
      const newConfig = {
        apiKey: parsed.data.apiKey ?? existing?.apiKey ?? "",
        enabled: parsed.data.enabled ?? existing?.enabled ?? true,
        maxRequestsPerRun: parsed.data.maxRequestsPerRun ?? existing?.maxRequestsPerRun ?? (provider === "newsapi" ? 100 : 20),
      };
      if (!newConfig.apiKey && process.env.RESEND_TRANSPORT !== "connector") {
        res.status(400).json({ error: "apiKey is required" });
        return;
      }
      await saveIntegrationConfig(user.tenantId, provider, newConfig);
      res.json({
        provider, configured: true, maskedKey: maskProviderKey(newConfig.apiKey),
        enabled: newConfig.enabled, maxRequestsPerRun: newConfig.maxRequestsPerRun,
      });
      return;
    }

    if (provider === "resend") {
      const parsed = ResendConfigSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid input", details: parsed.error.issues });
        return;
      }

      const existing = await getIntegrationConfig(user.tenantId, provider);
      const existingKey = existing?.apiKey ?? null;

      const newConfig: Record<string, any> = {
        apiKey:    parsed.data.apiKey    ?? existingKey ?? "",
        fromEmail: parsed.data.fromEmail ?? existing?.fromEmail ?? "noreply@kaboom.app",
        fromName:  parsed.data.fromName  ?? existing?.fromName  ?? "KABOOM",
      };

      if (!newConfig.apiKey) {
        res.status(400).json({ error: "apiKey is required" });
        return;
      }

      await saveIntegrationConfig(user.tenantId, provider, newConfig);

      invalidateTenantEmailCache(user.tenantId);

      res.json({
        provider,
        configured: true,
        maskedKey: maskKey(newConfig.apiKey),
        fromEmail: newConfig.fromEmail,
        fromName:  newConfig.fromName,
      });
      return;
    }

    if (provider === "upstash") {
      // BullMQ workers are process-global infrastructure — only admins may change the queue config.
      if (user.role !== "admin") {
        res.status(403).json({ error: "Only workspace admins can configure the Redis queue" });
        return;
      }

      const parsed = UpstashConfigSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid input", details: parsed.error.issues });
        return;
      }

      const existing = await getIntegrationConfig(user.tenantId, provider);
      const redisUrl = parsed.data.redisUrl ?? existing?.redisUrl ?? "";

      if (!redisUrl) {
        res.status(400).json({ error: "redisUrl is required" });
        return;
      }

      // Validate before storing — blocks SSRF-capable connections to private ranges.
      if (parsed.data.redisUrl) {
        const urlErr = validateRedisUrl(parsed.data.redisUrl);
        if (urlErr) {
          res.status(400).json({ error: urlErr });
          return;
        }
      }

      // token is optional — keep existing when not provided in request
      const token = parsed.data.token !== undefined
        ? (parsed.data.token || undefined)
        : (existing?.token ?? undefined);

      const newConfig: Record<string, any> = { redisUrl, ...(token ? { token } : {}) };

      await saveIntegrationConfig(user.tenantId, provider, newConfig);

      // Invalidate the tenant's cached queue set so the next enqueue re-reads from
      // tenant_integrations and picks up the new URL immediately — no restart needed.
      invalidateTenantQueueCache(user.tenantId);

      res.json({
        provider,
        configured: true,
        maskedUrl: maskRedisUrl(redisUrl),
        hasToken: !!token,
        source: "db",
      });
      return;
    }

    if (provider === "vapi") {
      const parsed = z.object({
        apiKey:             z.string().min(1).optional(),
        assistants:         z.array(z.object({ name: z.string(), id: z.string() })).optional(),
        assistantId:        z.string().optional(),  // legacy single-ID compat
        phoneNumberId:      z.string().optional(),
        voiceProvider:      z.enum(["vapi", "11labs"]).optional(),
        voiceId:            z.string().optional(),
        webhookSecret:      z.string().optional(),
        clearWebhookSecret: z.boolean().optional(),
      }).safeParse(req.body);
      if (!parsed.success) { res.status(400).json({ error: "Invalid input" }); return; }
      const existing = await getIntegrationConfig(user.tenantId, provider);
      const resolvedSecret = parsed.data.clearWebhookSecret
        ? ""
        : (parsed.data.webhookSecret ?? existing?.webhookSecret ?? "");
      // Resolve assistants list: prefer new array, fall back to legacy single assistantId
      const resolvedAssistants: { name: string; id: string }[] =
        parsed.data.assistants !== undefined
          ? parsed.data.assistants
          : (Array.isArray(existing?.assistants) ? existing.assistants : (existing?.assistantId ? [{ name: "Default", id: existing.assistantId }] : []));
      const newConfig: Record<string, any> = {
        apiKey:        parsed.data.apiKey        ?? existing?.apiKey        ?? "",
        assistants:    resolvedAssistants,
        assistantId:   resolvedAssistants[0]?.id ?? "",  // compat field: first assistant is default
        phoneNumberId: parsed.data.phoneNumberId ?? existing?.phoneNumberId ?? "",
        voiceProvider: parsed.data.voiceProvider ?? existing?.voiceProvider ?? "vapi",
        voiceId:       parsed.data.voiceId       ?? existing?.voiceId       ?? "",
        webhookSecret: resolvedSecret,
      };
      if (!newConfig.apiKey) { res.status(400).json({ error: "apiKey is required" }); return; }
      await saveIntegrationConfig(user.tenantId, provider, newConfig);
      const assistants = newConfig.assistants as { name: string; id: string }[];
      res.json({
        provider, configured: true,
        maskedKey:        maskProviderKey(newConfig.apiKey),
        assistants,
        assistantId:      assistants[0]?.id || null,
        phoneNumberId:    newConfig.phoneNumberId || null,
        voiceProvider:    newConfig.voiceProvider,
        voiceId:          newConfig.voiceId       || null,
        hasWebhookSecret: !!(newConfig.webhookSecret),
      });
      return;
    }

    if (provider === "retellai") {
      const parsed = z.object({
        apiKey:             z.string().min(1).optional(),
        agentId:            z.string().optional(),
        fromNumber:         z.string().optional(),
        webhookSecret:      z.string().optional(),
        clearWebhookSecret: z.boolean().optional(),
      }).safeParse(req.body);
      if (!parsed.success) { res.status(400).json({ error: "Invalid input" }); return; }
      const existing = await getIntegrationConfig(user.tenantId, provider);
      const resolvedSecret = parsed.data.clearWebhookSecret
        ? ""
        : (parsed.data.webhookSecret ?? existing?.webhookSecret ?? "");
      const newConfig: Record<string, any> = {
        apiKey:        parsed.data.apiKey        ?? existing?.apiKey        ?? "",
        agentId:       parsed.data.agentId       ?? existing?.agentId       ?? "",
        fromNumber:    parsed.data.fromNumber    ?? existing?.fromNumber    ?? "",
        webhookSecret: resolvedSecret,
      };
      if (!newConfig.apiKey) { res.status(400).json({ error: "apiKey is required" }); return; }
      await saveIntegrationConfig(user.tenantId, provider, newConfig);
      res.json({
        provider, configured: true,
        maskedKey:        maskProviderKey(newConfig.apiKey),
        agentId:          newConfig.agentId       || null,
        fromNumber:       newConfig.fromNumber    || null,
        hasWebhookSecret: !!(newConfig.webhookSecret),
      });
      return;
    }

    if (provider === "elevenlabs") {
      const parsed = z.object({
        voiceId:   z.string().min(1).optional(),
        voiceName: z.string().optional(),
      }).safeParse(req.body);
      if (!parsed.success) { res.status(400).json({ error: "Invalid input" }); return; }
      const existing = await getIntegrationConfig(user.tenantId, provider);
      const newConfig: Record<string, any> = {
        voiceId:   parsed.data.voiceId   ?? existing?.voiceId   ?? "",
        voiceName: parsed.data.voiceName ?? existing?.voiceName ?? "",
      };
      await saveIntegrationConfig(user.tenantId, provider, newConfig);
      res.json({ provider, configured: !!(newConfig.voiceId), voiceId: newConfig.voiceId, voiceName: newConfig.voiceName });
      return;
    }

    res.status(400).json({ error: "Unsupported provider" });
  } catch (err) { next(err); }
});

router.post("/integrations/:provider/test", async (req, res, next): Promise<void> => {
  try {
    const user = req.user as any;
    const { provider } = req.params;

    if (provider === "newsapi" || provider === "apollo") {
      if (user.role !== "admin") {
        res.status(403).json({ error: "Only workspace admins can test intent providers" });
        return;
      }
      const parsed = IntentProviderConfigSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid input" });
        return;
      }
      const existing = await getIntegrationConfig(user.tenantId, provider);
      const apiKey = parsed.data.apiKey ?? existing?.apiKey;
      if (!apiKey) {
        res.status(400).json({ error: "No API key configured" });
        return;
      }
      const target = provider === "newsapi"
        ? "https://newsapi.org/v2/top-headlines?country=us&pageSize=1"
        : "https://api.apollo.io/v1/auth/health";
      const response = await fetch(target, {
        headers: { "X-Api-Key": apiKey },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        res.status(400).json({ error: `${provider === "newsapi" ? "NewsAPI" : "Apollo"} returned HTTP ${response.status}` });
        return;
      }
      res.json({ ok: true });
      return;
    }

    if (provider === "resend") {
      const parsed = ResendConfigSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid input" });
        return;
      }

      try {
        const config = { ...await getMailConfig(user.tenantId) };
        if (parsed.data.apiKey) { config.apiKey = parsed.data.apiKey; config.transport = "api_key"; }
        const fromEmail = parsed.data.fromEmail || config.fromEmail;
        const fromName = parsed.data.fromName || config.fromName;
        const response = await requestResend(config, "/emails", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
          from:    `${fromName.replace(/[\r\n<>]/g, "")} <${fromEmail}>`,
          to:      [user.email],
          subject: "KABOOM — Resend integration test",
          text:    "This is the Resend test email you requested from KABOOM. Its arrival confirms delivery to this inbox only.",
          }),
        });
        const result = await response.json() as { id?: string };
        if (!response.ok || !result.id) {
          logger.warn("Resend test email failed");
          res.status(400).json({ error: "Resend returned an error. Check the key and sender settings." });
          return;
        }
        res.json({ ok: true, sentTo: user.email });
      } catch (err: any) {
        logger.warn("Resend test email exception");
        res.status(400).json({ error: "Failed to send test email" });
      }
      return;
    }

    if (provider === "upstash") {
      // Admin-only: test opens outbound network connections using a user-supplied URL.
      if (user.role !== "admin") {
        res.status(403).json({ error: "Only workspace admins can test the Redis connection" });
        return;
      }

      const parsed = UpstashConfigSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid input" });
        return;
      }

      // Resolve URL: body URL (for testing before saving) → stored tenant config → env fallback.
      let redisUrl = parsed.data.redisUrl;
      if (!redisUrl) {
        const existing = await getIntegrationConfig(user.tenantId, provider);
        redisUrl = existing?.redisUrl ?? process.env.UPSTASH_REDIS_URL ?? "";
      }

      if (!redisUrl) {
        res.status(400).json({ error: "No Redis URL configured" });
        return;
      }

      // Validate URL to prevent SSRF — scheme and private-range checks.
      const urlErr = validateRedisUrl(redisUrl);
      if (urlErr) {
        res.status(400).json({ error: urlErr });
        return;
      }

      try {
        const { default: IORedis } = await import("ioredis");
        const client = new IORedis(redisUrl, {
          maxRetriesPerRequest: 1,
          enableReadyCheck: false,
          connectTimeout: 5000,
          tls: redisUrl.startsWith("rediss://") ? {} : undefined,
        });
        // Prevent the driver's default unhandled-error logger from printing
        // connection details, and close failed test connections as well.
        client.on("error", () => {});
        try {
          await client.ping();
        } finally {
          client.disconnect();
        }
        res.json({ ok: true });
      } catch (err: any) {
        logger.warn("Upstash Redis test connection failed");
        res.status(400).json({ error: "Failed to connect to Redis" });
      }
      return;
    }

    res.status(400).json({ error: "Unsupported provider" });
  } catch (err) { next(err); }
});

// Credential and transport failures must not reach a generic handler that might
// serialize a third-party exception containing request headers or connection URLs.
router.use((err: unknown, _req: any, res: any, _next: any) => {
  const credentialFailure = err instanceof CredentialStoreError;
  logger.warn("Integration operation failed");
  res.status(credentialFailure ? 503 : 502).json({
    error: credentialFailure ? err.message : "Integration operation failed. Check the connection settings.",
  });
});

export default router;
