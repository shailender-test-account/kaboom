import { beforeEach, afterEach, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ proxy: vi.fn(), stored: vi.fn() }));
vi.mock("@replit/connectors-sdk", () => ({ ReplitConnectors: class { proxy = mock.proxy; } }));
vi.mock("../lib/integrationCredentials", () => ({ getIntegrationConfig: mock.stored }));
import { getMailConfig, invalidateTenantEmailCache, resendReadiness } from "./resendTransport";
import { sendEmail } from "./email";

beforeEach(() => {
  vi.clearAllMocks(); invalidateTenantEmailCache(1);
  vi.stubEnv("RESEND_TRANSPORT", "connector");
  vi.stubEnv("RESEND_API_KEY", "");
  vi.stubEnv("FROM_EMAIL", "welcome@example.invalid");
  vi.stubEnv("USER_WELCOME_EMAIL_ENABLED", "false");
  vi.stubEnv("COPIED_DATA_SAFE_MODE", "true");
  mock.stored.mockResolvedValue(null);
});
afterEach(() => vi.unstubAllEnvs());
it("recognizes a sending-only key without treating it as an invalid credential", async () => {
  mock.proxy.mockResolvedValue(new Response(JSON.stringify({ name: "restricted_api_key" }), { status: 401 }));
  expect(await resendReadiness(1)).toMatchObject({
    authentication: "sending_only", senderVerified: null, welcomeSendingEnabled: false,
  });
  expect(mock.proxy).toHaveBeenCalledWith("resend", "/domains?limit=100", expect.objectContaining({ signal: expect.any(AbortSignal) }));
  expect(mock.proxy.mock.calls).toHaveLength(1);
});
it("distinguishes a rejected key from restricted permissions", async () => {
  mock.proxy.mockResolvedValue(new Response(JSON.stringify({ name: "validation_error" }), { status: 401 }));
  expect(await resendReadiness(1)).toMatchObject({ authentication: "rejected", senderVerified: null });
});
it("checks only the configured sender domain and makes no send request", async () => {
  mock.proxy.mockResolvedValue(new Response(JSON.stringify({ data: [{ name: "example.invalid", status: "verified" }] })));
  expect(await resendReadiness(1)).toMatchObject({ authentication: "authenticated", senderVerified: true });
  expect(mock.proxy.mock.calls.every(call => call[1].startsWith("/domains"))).toBe(true);
});
it("preserves explicit tenant credentials rather than overriding them with the shared connector", async () => {
  mock.stored.mockResolvedValue({ apiKey: "synthetic-tenant-key", fromEmail: "tenant@example.invalid" });
  expect(await getMailConfig(1)).toMatchObject({ transport: "api_key", fromEmail: "tenant@example.invalid" });
  expect(mock.proxy).not.toHaveBeenCalled();
});
it("does not fall back if secure tenant configuration cannot be read", async () => {
  mock.stored.mockRejectedValue(new Error("synthetic unavailable store"));
  expect(await resendReadiness(1)).toMatchObject({ authentication: "unverified", configured: false });
  expect(mock.proxy).not.toHaveBeenCalled();
});
const message = { to: "recipient@example.invalid", subject: "Synthetic email", html: "<p>Example</p>", skipUnsubscribeFooter: true };
it("returns failure instead of pretend-success when no provider is configured", async () => {
  vi.stubEnv("RESEND_TRANSPORT", "api_key");
  expect(await sendEmail(message)).toBe(false);
  expect(mock.proxy).not.toHaveBeenCalled();
});
it("requires a provider message ID before reporting acceptance", async () => {
  mock.proxy.mockResolvedValueOnce(new Response("{}")).mockResolvedValueOnce(new Response(JSON.stringify({ id: "synthetic-message-id" })));
  expect(await sendEmail(message)).toBe(false);
  expect(await sendEmail(message)).toBe(true);
  expect(mock.proxy.mock.calls.every(call => call[1] === "/emails" && call[2].method === "POST")).toBe(true);
});
