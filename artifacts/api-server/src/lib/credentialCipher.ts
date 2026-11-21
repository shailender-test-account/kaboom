import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export class CredentialStoreError extends Error {
  readonly status = 503;
  constructor() {
    super("Integration credentials unavailable. Ask an administrator to check the credential encryption key configuration.");
    this.name = "CredentialStoreError";
  }
}

// This module never logs input, ciphertext, key material, or crypto exceptions.
export const integrationProviders = ["apollo", "newsapi", "resend", "upstash", "vapi", "retellai", "elevenlabs", "tavily", "explorium", "perplexity"] as const;
const fields: Record<string, readonly string[]> = {
  apollo: ["apiKey"], newsapi: ["apiKey"], resend: ["apiKey"],
  upstash: ["redisUrl", "token"], vapi: ["apiKey", "webhookSecret"],
  retellai: ["apiKey", "webhookSecret"], elevenlabs: [],
  tavily: ["apiKey"], explorium: ["apiKey"], perplexity: ["apiKey"],
};
type Config = Record<string, any>;
type Envelope = { version: 1; keyId: string; iv: string; tag: string; ciphertext: string };
const slot = "_credentials";

function scope(tenantId: number, provider: string): Buffer {
  if (!Number.isSafeInteger(tenantId) || tenantId <= 0 || !integrationProviders.includes(provider as any)) {
    throw new CredentialStoreError();
  }
  return Buffer.from(JSON.stringify(["tenant-integrations", 1, tenantId, provider]));
}

function keyring(): { activeKeyId: string; keys: Map<string, Buffer> } {
  try {
    const parsed = JSON.parse(process.env.INTEGRATION_CREDENTIAL_KEYS ?? "");
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(parsed.activeKeyId) || !parsed.keys || typeof parsed.keys !== "object") throw 0;
    const keys = new Map<string, Buffer>();
    for (const [id, value] of Object.entries(parsed.keys)) {
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id) || typeof value !== "string" || !/^[A-Za-z0-9+/]{43}=$/.test(value)) throw 0;
      const key = Buffer.from(value, "base64");
      if (key.length !== 32 || key.toString("base64") !== value) throw 0;
      keys.set(id, key);
    }
    if (!keys.has(parsed.activeKeyId)) throw 0;
    return { activeKeyId: parsed.activeKeyId, keys };
  } catch {
    throw new CredentialStoreError();
  }
}

export function activeCredentialKeyId(): string {
  return keyring().activeKeyId;
}

export function encryptIntegrationConfig(tenantId: number, provider: string, config: Config): Config {
  const aad = scope(tenantId, provider);
  const publicConfig = { ...config };
  delete publicConfig[slot];
  const secrets: Config = {};
  for (const field of fields[provider]) {
    if (config[field] !== undefined) {
      if (typeof config[field] !== "string") throw new CredentialStoreError();
      secrets[field] = config[field];
    }
    delete publicConfig[field];
  }
  // Even empty credential-bearing writes require a valid key. Never downgrade to plaintext.
  if (!fields[provider].length) return publicConfig;
  const { activeKeyId, keys } = keyring();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keys.get(activeKeyId)!, iv);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(secrets), "utf8"), cipher.final()]);
  publicConfig[slot] = {
    version: 1, keyId: activeKeyId, iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64"),
  } satisfies Envelope;
  return publicConfig;
}

export function decryptIntegrationConfig(tenantId: number, provider: string, config: Config): Config {
  const aad = scope(tenantId, provider);
  if (!Object.hasOwn(config, slot)) return { ...config }; // Read-only legacy compatibility.
  try {
    const envelope = config[slot] as Envelope;
    if (envelope.version !== 1) throw 0;
    const key = keyring().keys.get(envelope.keyId);
    if (!key) throw 0;
    const iv = Buffer.from(envelope.iv, "base64"), tag = Buffer.from(envelope.tag, "base64");
    if (iv.length !== 12 || tag.length !== 16) throw 0;
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    const secrets = JSON.parse(Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "base64")), decipher.final(),
    ]).toString("utf8"));
    const result = { ...config };
    delete result[slot];
    for (const field of fields[provider]) delete result[field];
    for (const [field, value] of Object.entries(secrets)) {
      if (!fields[provider].includes(field) || typeof value !== "string") throw 0;
      result[field] = value;
    }
    return result;
  } catch {
    throw new CredentialStoreError();
  }
}

export function needsCredentialRewrite(config: Config, mode: "migrate" | "rotate"): boolean {
  const active = activeCredentialKeyId(); // Preflight even when there are no records.
  return !Object.hasOwn(config, slot) || (mode === "rotate" && config[slot]?.keyId !== active);
}
