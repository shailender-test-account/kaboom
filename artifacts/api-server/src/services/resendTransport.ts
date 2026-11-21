import { ReplitConnectors } from "@replit/connectors-sdk";
import { getIntegrationConfig } from "../lib/integrationCredentials";

export interface MailConfig {
  apiKey: string | null;
  transport: "connector" | "api_key";
  fromEmail: string;
  fromName: string;
}

const cache = new Map<number, { config: MailConfig; expires: number }>();
export function invalidateTenantEmailCache(tenantId: number) { cache.delete(tenantId); }

// An explicit tenant credential remains authoritative. A connector is never a
// fallback for a failed credential-store read or a rejected tenant credential.
export async function getMailConfig(tenantId?: number): Promise<MailConfig> {
  const cached = tenantId ? cache.get(tenantId) : null;
  if (cached && cached.expires > Date.now()) return cached.config;
  const saved = tenantId ? await getIntegrationConfig(tenantId, "resend") : null;
  const config: MailConfig = {
    apiKey: saved?.apiKey || process.env.RESEND_API_KEY || null,
    transport: saved?.apiKey ? "api_key"
      : process.env.RESEND_TRANSPORT === "connector" ? "connector" : "api_key",
    fromEmail: saved?.fromEmail || process.env.FROM_EMAIL || "",
    fromName: saved?.fromName || process.env.FROM_NAME || "KABOOM",
  };
  if (tenantId) cache.set(tenantId, { config, expires: Date.now() + 60_000 });
  return config;
}

export async function requestResend(config: MailConfig, path: string, init: RequestInit = {}) {
  const options = { ...init, headers: Object.fromEntries(new Headers(init.headers).entries()), signal: AbortSignal.timeout(15_000) };
  if (config.transport === "connector") {
    return new ReplitConnectors().proxy("resend", path, options);
  }
  if (!config.apiKey) throw new Error("Resend is not configured");
  return fetch(`https://api.resend.com${path}`, {
    ...options,
    headers: { ...init.headers, Authorization: `Bearer ${config.apiKey}`, "User-Agent": "KABOOM" },
  });
}

export function welcomeBaseUrl(): string | null {
  try {
    const url = new URL(process.env.USER_WELCOME_BASE_URL ?? "");
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return null;
    return url.href.replace(/\/$/, "");
  } catch { return null; }
}

export function welcomeSendingEnabled() {
  return process.env.USER_WELCOME_EMAIL_ENABLED === "true"
    && process.env.COPIED_DATA_SAFE_MODE !== "true"
    && !!welcomeBaseUrl();
}

export async function resendReadiness(tenantId: number) {
  const base = {
    transport: "api_key" as MailConfig["transport"],
    configured: false, authentication: "unverified", senderVerified: false as boolean | null,
    senderConfigured: false, detail: "", welcomeSendingEnabled: welcomeSendingEnabled(),
    welcomeBaseUrlConfigured: !!welcomeBaseUrl(),
    copiedDataSafeMode: process.env.COPIED_DATA_SAFE_MODE === "true",
  };
  try {
    const config = await getMailConfig(tenantId);
    base.transport = config.transport;
    base.configured = config.transport === "connector" || !!config.apiKey;
    base.senderConfigured = /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(config.fromEmail);
    if (!base.configured) return { ...base, detail: "No Resend connection or API key is configured." };
    const response = await requestResend(config, "/domains?limit=100");
    const body = await response.json() as any;
    if (body.name === "restricted_api_key" && (response.status === 401 || response.status === 403)) {
      return { ...base, authentication: "sending_only", senderVerified: null,
        detail: "Sending-only key recognized. Domain verification and delivery cannot be confirmed without a test email. No email was sent." };
    }
    if (!response.ok) {
      return { ...base, authentication: response.status === 401 ? "rejected" : "unverified",
        senderVerified: null, detail: `Resend read-only check returned HTTP ${response.status}. No email was sent.` };
    }
    const senderDomain = config.fromEmail.split("@")[1]?.toLowerCase();
    const domains = Array.isArray(body.data) ? body.data : [];
    const verified = domains.some((d: any) => d.name?.toLowerCase() === senderDomain && d.status === "verified");
    return { ...base, authentication: "authenticated",
      senderVerified: verified ? true : body.has_more ? null : false,
      detail: verified
        ? "Connection authenticated and sender domain verified. Inbox delivery has not been tested. No email was sent."
        : "Connection authenticated; configured sender domain could not be verified. No email was sent." };
  } catch {
    return { ...base, senderVerified: null,
      detail: "The connection or secure settings could not be read. No fallback credentials were used and no email was sent." };
  }
}
