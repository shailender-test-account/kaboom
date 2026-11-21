import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
  records: new Map<string, Record<string, any>>(),
  query: vi.fn(), release: vi.fn(), emailCache: vi.fn(), queueCache: vi.fn(), warn: vi.fn(),
}));
vi.mock("@workspace/db", () => ({
  pool: {
    query: mock.query,
    connect: async () => ({ query: mock.query, release: mock.release }),
  },
}));
vi.mock("../services/email", () => ({ invalidateTenantEmailCache: mock.emailCache }));
vi.mock("../services/queue", () => ({ invalidateTenantQueueCache: mock.queueCache }));
vi.mock("../lib/logger", () => ({ logger: { warn: mock.warn } }));
vi.mock("../lib/hpBiImport", () => ({ isHpClient: vi.fn() }));

import {
  CredentialStoreError, decryptIntegrationConfig, encryptIntegrationConfig, integrationProviders,
} from "../lib/credentialCipher";
import { getIntegrationConfig, saveIntegrationConfig, rewriteIntegrationCredentials } from "../lib/integrationCredentials";
import { apolloCommitteeConfig } from "../lib/buyingCommittee";
import { providerConfigured, providerRequestLimit } from "../lib/intentProviders";
import router from "../routes/integrations";

const synthetic = "synthetic-test-provider-key-ABC123";
const keyA = Buffer.alloc(32, 17).toString("base64");
const keyB = Buffer.alloc(32, 28).toString("base64");
function ring(activeKeyId = "a", keys: Record<string, string> = { a: keyA }) {
  vi.stubEnv("INTEGRATION_CREDENTIAL_KEYS", JSON.stringify({ activeKeyId, keys }));
}
function app() {
  const server = express();
  server.use(express.json());
  server.use((req: any, _res, next) => {
    req.isAuthenticated = () => req.headers["x-role"] !== "anonymous";
    req.user = { role: req.headers["x-role"] ?? "admin", tenantId: Number(req.headers["x-tenant"] ?? 7), email: "synthetic@example.test" };
    next();
  });
  server.use(router);
  return server;
}

beforeEach(() => {
  vi.clearAllMocks();
  ring();
  mock.records.clear();
  let snapshot: Map<string, Record<string, any>> | undefined;
  mock.query.mockImplementation(async (sql: string, params: any[] = []) => {
    const id = `${params[0]}:${params[1]}`;
    if (sql === "BEGIN") snapshot = structuredClone(mock.records);
    if (sql === "ROLLBACK" && snapshot) {
      mock.records.clear();
      for (const [key, record] of snapshot) mock.records.set(key, record);
    }
    if (sql.startsWith("SELECT config FROM tenant_integrations")) {
      const config = mock.records.get(id);
      return { rows: config ? [{ config: structuredClone(config) }] : [] };
    }
    if (sql.startsWith("INSERT INTO tenant_integrations") || sql.startsWith("UPDATE tenant_integrations")) {
      mock.records.set(id, JSON.parse(params[2]));
    }
    return { rows: [] };
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("credential encryption", () => {
  it.each(integrationProviders.filter(p => p !== "elevenlabs"))("protects sensitive fields for %s", provider => {
    const config = provider === "upstash" ? { redisUrl: synthetic, token: "synthetic-token" }
      : { apiKey: synthetic, ...(["vapi", "retellai"].includes(provider) ? { webhookSecret: "synthetic-webhook" } : {}) };
    const stored = encryptIntegrationConfig(7, provider, { ...config, enabled: true });
    expect(JSON.stringify(stored)).not.toContain(synthetic);
    expect(stored.apiKey).toBeUndefined();
    expect(stored.webhookSecret).toBeUndefined();
    expect(stored.redisUrl).toBeUndefined();
    expect(stored.token).toBeUndefined();
    expect(decryptIntegrationConfig(7, provider, stored)).toEqual({ ...config, enabled: true });
    expect(encryptIntegrationConfig(7, provider, config)._credentials.iv).not.toEqual(stored._credentials.iv);
  });

  it("authenticates tenant, provider, ciphertext and envelope version", () => {
    const encrypted = encryptIntegrationConfig(7, "apollo", { apiKey: synthetic });
    expect(() => decryptIntegrationConfig(8, "apollo", encrypted)).toThrow(CredentialStoreError);
    expect(() => decryptIntegrationConfig(7, "newsapi", encrypted)).toThrow(CredentialStoreError);
    const damaged = structuredClone(encrypted);
    damaged._credentials.ciphertext = Buffer.from("synthetic-corruption").toString("base64");
    expect(() => decryptIntegrationConfig(7, "apollo", damaged)).toThrow(CredentialStoreError);
    damaged._credentials.version = 2;
    expect(() => decryptIntegrationConfig(7, "apollo", damaged)).toThrow(CredentialStoreError);
  });

  it("does not fall back to coexisting legacy plaintext after encrypted read failure", () => {
    const encrypted = encryptIntegrationConfig(7, "apollo", { apiKey: synthetic });
    encrypted.apiKey = "synthetic-stale-key";
    vi.stubEnv("INTEGRATION_CREDENTIAL_KEYS", "");
    expect(() => decryptIntegrationConfig(7, "apollo", encrypted)).toThrow(CredentialStoreError);
    expect(() => encryptIntegrationConfig(7, "apollo", { apiKey: synthetic })).toThrow(CredentialStoreError);
  });

  it.each(["", "{}", "not-json", '{"activeKeyId":"a","keys":{"a":"short"}}'])("fails closed on invalid key configuration %j", value => {
    vi.stubEnv("INTEGRATION_CREDENTIAL_KEYS", value);
    expect(() => encryptIntegrationConfig(7, "apollo", { apiKey: synthetic })).toThrow(CredentialStoreError);
  });

  it("fails if a key ID is reused with different bytes", () => {
    const encrypted = encryptIntegrationConfig(7, "apollo", { apiKey: synthetic });
    ring("a", { a: keyB });
    expect(() => decryptIntegrationConfig(7, "apollo", encrypted)).toThrow(CredentialStoreError);
  });
});

describe("shared server-managed storage", () => {
  it("reads legacy without writing or requiring an encryption key", async () => {
    vi.stubEnv("INTEGRATION_CREDENTIAL_KEYS", "");
    mock.records.set("7:apollo", { apiKey: synthetic, enabled: true });
    expect(await getIntegrationConfig(7, "apollo")).toEqual({ apiKey: synthetic, enabled: true });
    expect(mock.query).toHaveBeenCalledTimes(1);
    expect(await getIntegrationConfig(8, "apollo")).toBeNull();
  });

  it("shares encrypted Apollo configuration with committee and legacy discovery", async () => {
    await saveIntegrationConfig(7, "apollo", { apiKey: synthetic, enabled: true, maxRequestsPerRun: 13 });
    expect(await apolloCommitteeConfig(7)).toEqual({ configured: true, apiKey: synthetic, maxRequests: 13 });
    expect(await providerConfigured(7, "apollo")).toBe(true);
    expect(await providerConfigured(8, "apollo")).toBe(false);
    await saveIntegrationConfig(7, "newsapi", { apiKey: synthetic, maxRequestsPerRun: 12 });
    expect(await providerRequestLimit(7, "newsapi")).toBe(12);
    for (const [, params] of mock.query.mock.calls) {
      if (params?.[2]) expect(params[2]).not.toContain(synthetic);
    }
  });

  it("prevents any write without an encryption key and redacts storage exceptions", async () => {
    vi.stubEnv("INTEGRATION_CREDENTIAL_KEYS", "");
    await expect(saveIntegrationConfig(7, "apollo", { apiKey: synthetic })).rejects.toThrow(CredentialStoreError);
    expect(mock.query).not.toHaveBeenCalled();
    mock.query.mockRejectedValueOnce(new Error(`synthetic-driver-error ${synthetic}`));
    await expect(getIntegrationConfig(7, "apollo")).rejects.not.toThrow(synthetic);
  });

  it("dry-runs, migrates once and preserves non-secret settings", async () => {
    const legacy = { apiKey: synthetic, enabled: false, maxRequestsPerRun: 23 };
    mock.records.set("7:apollo", legacy);
    expect(await rewriteIntegrationCredentials(7, "apollo", "migrate")).toBe("would-change");
    expect(mock.records.get("7:apollo")).toEqual(legacy);
    expect(await rewriteIntegrationCredentials(7, "apollo", "migrate", true)).toBe("changed");
    const once = structuredClone(mock.records.get("7:apollo"));
    expect(await rewriteIntegrationCredentials(7, "apollo", "migrate", true)).toBe("unchanged");
    expect(mock.records.get("7:apollo")).toEqual(once);
    expect(await getIntegrationConfig(7, "apollo")).toEqual(legacy);
    expect(await rewriteIntegrationCredentials(8, "apollo", "migrate", true)).toBe("absent");
  });

  it("supports mixed-key rotation and recovery from a missing old key", async () => {
    await saveIntegrationConfig(7, "apollo", { apiKey: synthetic });
    ring("b", { b: keyB });
    await expect(rewriteIntegrationCredentials(7, "apollo", "rotate", true)).rejects.toThrow(CredentialStoreError);
    expect(mock.records.get("7:apollo")?._credentials.keyId).toBe("a");
    ring("b", { a: keyA, b: keyB });
    expect(await getIntegrationConfig(7, "apollo")).toEqual({ apiKey: synthetic });
    expect(await rewriteIntegrationCredentials(7, "apollo", "rotate", true)).toBe("changed");
    const rotated = structuredClone(mock.records.get("7:apollo"));
    expect(await rewriteIntegrationCredentials(7, "apollo", "rotate", true)).toBe("unchanged");
    expect(mock.records.get("7:apollo")).toEqual(rotated);
    ring("b", { b: keyB });
    expect(await getIntegrationConfig(7, "apollo")).toEqual({ apiKey: synthetic });
  });

  it("rolls back failed migration without exposing driver details", async () => {
    mock.records.set("7:apollo", { apiKey: synthetic });
    const original = mock.query.getMockImplementation()!;
    mock.query.mockImplementation(async (sql, params) => {
      if (sql.startsWith("UPDATE tenant_integrations")) throw new Error(synthetic);
      return original(sql, params);
    });
    await expect(rewriteIntegrationCredentials(7, "apollo", "migrate", true)).rejects.toThrow(CredentialStoreError);
    expect(mock.records.get("7:apollo")).toEqual({ apiKey: synthetic });
    expect(mock.query).toHaveBeenCalledWith("ROLLBACK");
    expect(mock.release).toHaveBeenCalled();
  });
});

describe("admin integration routes", () => {
  it.each(["anonymous", "member", "viewer"])("blocks %s before storage or network access", async role => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    for (const method of ["get", "put", "post"] as const) {
      const path = `/integrations/apollo${method === "post" ? "/test" : ""}`;
      const response = await request(app())[method](path).set("x-role", role).send({ apiKey: synthetic });
      expect(response.status).toBe(role === "anonymous" ? 401 : 403);
    }
    expect(mock.query).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("encrypts a saved key, masks readbacks and ignores body tenant identity", async () => {
    const response = await request(app()).put("/integrations/apollo").send({ apiKey: synthetic, tenantId: 8, maxRequestsPerRun: 9 });
    expect(response.status).toBe(200);
    expect(JSON.stringify(response.body)).not.toContain(synthetic);
    expect(mock.records.has("7:apollo")).toBe(true);
    expect(mock.records.has("8:apollo")).toBe(false);
    expect(mock.records.get("7:apollo")?.apiKey).toBeUndefined();
    const read = await request(app()).get("/integrations/apollo");
    expect(read.body).toMatchObject({ configured: true, maxRequestsPerRun: 9, maskedKey: "••••••••C123" });
    expect(JSON.stringify(read.body)).not.toContain("_credentials");
    const other = await request(app()).get("/integrations/apollo").set("x-tenant", "8");
    expect(other.body.configured).toBe(false);
    await request(app()).put("/integrations/apollo").send({ enabled: false });
    expect(await getIntegrationConfig(7, "apollo")).toMatchObject({ apiKey: synthetic, enabled: false });
  });

  it("migrates only an explicitly saved legacy record", async () => {
    mock.records.set("7:apollo", { apiKey: synthetic, maxRequestsPerRun: 11 });
    await request(app()).get("/integrations/apollo");
    expect(mock.records.get("7:apollo")?.apiKey).toBe(synthetic);
    await request(app()).put("/integrations/apollo").send({ enabled: false });
    expect(mock.records.get("7:apollo")?.apiKey).toBeUndefined();
    expect(await getIntegrationConfig(7, "apollo")).toMatchObject({ apiKey: synthetic, enabled: false, maxRequestsPerRun: 11 });
  });

  it("fully masks short keys and redacts Redis user info, path and query", async () => {
    const saved = await request(app()).put("/integrations/apollo").send({ apiKey: "xyz" });
    expect(saved.body.maskedKey).toBe("••••••••");
    mock.records.set("7:upstash", { redisUrl: `rediss://synthetic-user:${synthetic}@redis.example.test/${synthetic}?token=${synthetic}`, token: synthetic });
    const read = await request(app()).get("/integrations/upstash");
    expect(read.body.maskedUrl).toBe("rediss://redis.example.test/••••");
    expect(JSON.stringify(read.body)).not.toContain(synthetic);
  });

  it("returns a redacted 503 rather than silently writing plaintext", async () => {
    vi.stubEnv("INTEGRATION_CREDENTIAL_KEYS", "");
    const response = await request(app()).put("/integrations/apollo").send({ apiKey: synthetic });
    expect(response.status).toBe(503);
    expect(mock.records.size).toBe(0);
    expect(JSON.stringify(response.body)).not.toContain(synthetic);
    expect(JSON.stringify(mock.warn.mock.calls)).not.toContain(synthetic);
  });

  it("uses decrypted keys in provider calls but redacts echoed network failures", async () => {
    await saveIntegrationConfig(7, "apollo", { apiKey: synthetic });
    const fetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetch);
    expect((await request(app()).post("/integrations/apollo/test").send({})).status).toBe(200);
    expect(fetch.mock.calls[0][1].headers["X-Api-Key"]).toBe(synthetic);
    fetch.mockRejectedValueOnce(new Error(synthetic));
    const response = await request(app()).post("/integrations/apollo/test").send({});
    expect(response.status).toBe(502);
    expect(JSON.stringify(response.body)).not.toContain(synthetic);
    expect(JSON.stringify(mock.warn.mock.calls)).not.toContain(synthetic);
  });
});
