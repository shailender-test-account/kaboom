import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import express from "express";
import supertest from "supertest";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { pool } from "@workspace/db";
const mock = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("./resendTransport", async importOriginal => ({
  ...await importOriginal<typeof import("./resendTransport")>(),
  getMailConfig: vi.fn(async () => ({ transport: "connector", apiKey: null, fromEmail: "welcome@example.invalid", fromName: "KABOOM" })),
  requestResend: mock.request,
}));
import { dispatchWelcomeEmails, previewWelcomeEmails, redeemWelcomeToken, welcomeTokenHash } from "./welcomeEmails";
import teamRouter from "../routes/team";
import authRouter from "../routes/auth";
let tenant: number, admin: number, member: number;
let email: string;
beforeAll(async () => {
  tenant = (await pool.query("INSERT INTO tenants(name,slug) VALUES('Welcome tests',$1) RETURNING id", [`welcome-${randomUUID()}`])).rows[0].id;
  email = `welcome-${randomUUID()}@example.invalid`;
  admin = (await pool.query(`INSERT INTO users(tenant_id,email,password_hash,first_name,last_name,role)
    VALUES($1,$2,'not-a-password','Test','Admin','admin') RETURNING id`, [tenant, `admin-${randomUUID()}@example.invalid`])).rows[0].id;
  member = (await pool.query(`INSERT INTO users(tenant_id,email,password_hash,first_name,last_name,role)
    VALUES($1,$2,'not-a-password','Test','Member','viewer') RETURNING id`, [tenant, email])).rows[0].id;
});
beforeEach(async () => {
  vi.clearAllMocks();
  vi.stubEnv("USER_WELCOME_EMAIL_ENABLED", "false");
  vi.stubEnv("USER_WELCOME_BASE_URL", "https://app.example.invalid");
  vi.stubEnv("COPIED_DATA_SAFE_MODE", "true");
  await pool.query("DELETE FROM password_reset_tokens WHERE email=$1", [email]);
});
afterEach(() => vi.unstubAllEnvs());
afterAll(async () => {
  await pool.query("DELETE FROM password_reset_tokens WHERE email=$1", [email]);
  await pool.query("DELETE FROM users WHERE tenant_id=$1", [tenant]);
  await pool.query("DELETE FROM tenants WHERE id=$1", [tenant]);
});
function api(role = "admin") {
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => {
    req.isAuthenticated = (() => true) as any;
    req.user = { id: role === "admin" ? admin : member, tenantId: tenant, role } as any;
    next();
  });
  app.use("/api", teamRouter); app.use("/api", authRouter);
  app.use((_err: any, _req: any, res: any, _next: any) => res.status(500).json({ error: "Unexpected error" }));
  return supertest(app);
}
const enableOnlyInTest = () => {
  vi.stubEnv("USER_WELCOME_EMAIL_ENABLED", "true");
  vi.stubEnv("COPIED_DATA_SAFE_MODE", "false");
};
const reviewed = () => [{ id: member, email }];
async function acceptedSyntheticEmail() {
  enableOnlyInTest();
  mock.request.mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: "synthetic-id" }] })));
  await dispatchWelcomeEmails(tenant, [member], reviewed());
  const body = JSON.parse(mock.request.mock.calls[0][2].body);
  const link = body[0].text.match(/https:\/\/\S+/)[0];
  return { token: new URLSearchParams(new URL(link).hash.slice(1)).get("token")!, text: body[0].text };
}
it("previews without sending mail, exposing a usable link or minting a token", async () => {
  const response = await api().post("/api/users/welcome-email/preview").send({ userIds: [member] });
  expect(response.status).toBe(200);
  expect(response.body.recipients).toEqual([{ id: member, email, name: "Test Member" }]);
  expect(response.body.exampleText).not.toContain("https://");
  expect(mock.request).not.toHaveBeenCalled();
  expect((await pool.query("SELECT count(*)::int AS n FROM password_reset_tokens WHERE email=$1", [email])).rows[0].n).toBe(0);
});
it("blocks sends server-side while paused even with confirmation", async () => {
  expect((await api().post("/api/users/welcome-email/send").send({ userIds: [member], confirmed: true, expectedRecipients: reviewed() })).status).toBe(409);
  vi.stubEnv("USER_WELCOME_EMAIL_ENABLED", "true");
  expect((await api().post("/api/users/welcome-email/send").send({ userIds: [member], confirmed: true, expectedRecipients: reviewed() })).status).toBe(409);
  expect(mock.request).not.toHaveBeenCalled();
});
it("requires administrator access, explicit confirmation and unique user IDs", async () => {
  expect((await api("viewer").post("/api/users/welcome-email/preview").send({ userIds: [member] })).status).toBe(403);
  expect((await api().post("/api/users/welcome-email/send").send({ userIds: [member] })).status).toBe(400);
  expect((await api().post("/api/users/welcome-email/preview").send({ userIds: [member, member] })).status).toBe(400);
  await expect(previewWelcomeEmails(tenant + 1, [member])).rejects.toMatchObject({ status: 404 });
  expect(mock.request).not.toHaveBeenCalled();
});
it("stores only a hashed token, sends no password and accepts the token only once", async () => {
  await pool.query("UPDATE users SET must_change_password=true, temporary_password_expires_at=now()-interval '1 hour' WHERE id=$1", [member]);
  const { token, text } = await acceptedSyntheticEmail();
  expect(text).not.toContain("not-a-password");
  const stored = (await pool.query("SELECT token FROM password_reset_tokens WHERE email=$1", [email])).rows[0].token;
  expect(stored).toBe(welcomeTokenHash(token)); expect(stored).not.toContain(token);
  expect((await api().post("/api/auth/reset-password").send({ token: stored, password: "Synthetic-password-123!" })).status).toBe(400);
  const body = { token, password: "Synthetic-password-123!" };
  expect((await api().post("/api/auth/setup-password").send(body)).status).toBe(200);
  const hash = (await pool.query("SELECT password_hash FROM users WHERE id=$1", [member])).rows[0].password_hash;
  expect(await bcrypt.compare(body.password, hash)).toBe(true);
  const user = (await pool.query("SELECT must_change_password, temporary_password_expires_at FROM users WHERE id=$1", [member])).rows[0];
  expect(user.must_change_password).toBe(false);
  expect(user.temporary_password_expires_at).toBeNull();
  expect((await api().post("/api/auth/setup-password").send(body)).status).toBe(400);
});
it("retains the legacy forgot-password redemption path without accepting welcome digests", async () => {
  const token = randomUUID();
  await pool.query("INSERT INTO password_reset_tokens(email,token,expires_at) VALUES($1,$2,now()+interval '1 hour')", [email, token]);
  expect((await api().post("/api/auth/reset-password").send({ token, password: "Synthetic-password-123!" })).status).toBe(200);
  expect((await api().post("/api/auth/reset-password").send({ token, password: "Synthetic-password-123!" })).status).toBe(400);
});
it("rejects expired, mismatched and concurrent token reuse", async () => {
  const { token } = await acceptedSyntheticEmail();
  await expect(redeemWelcomeToken(token.replace(/^\d+/, String(admin)), "Synthetic-password-123!")) .rejects.toMatchObject({ status: 400 });
  await pool.query("UPDATE password_reset_tokens SET expires_at=now()-interval '1 minute' WHERE email=$1", [email]);
  await expect(redeemWelcomeToken(token, "Synthetic-password-123!")).rejects.toMatchObject({ status: 400 });
  await pool.query("UPDATE password_reset_tokens SET expires_at=now()+interval '1 hour' WHERE email=$1", [email]);
  const results = await Promise.allSettled([redeemWelcomeToken(token, "Synthetic-password-123!"), redeemWelcomeToken(token, "Synthetic-password-456!")]);
  expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
});
it("revokes pending links if provider acceptance is not confirmed and does not retry", async () => {
  enableOnlyInTest();
  mock.request.mockResolvedValueOnce(new Response(JSON.stringify({ name: "validation_error" }), { status: 422 }));
  await expect(dispatchWelcomeEmails(tenant, [member], reviewed())).rejects.toMatchObject({ status: 502 });
  expect(mock.request).toHaveBeenCalledTimes(1);
  expect((await pool.query("SELECT used_at FROM password_reset_tokens WHERE email=$1", [email])).rows[0].used_at).not.toBeNull();
});
it("prevents rapid duplicate invitation requests", async () => {
  await acceptedSyntheticEmail();
  await expect(dispatchWelcomeEmails(tenant, [member], reviewed())).rejects.toMatchObject({ status: 409 });
  expect(mock.request).toHaveBeenCalledTimes(1);
});
it("refuses an address that changed after the administrator previewed it", async () => {
  enableOnlyInTest();
  await expect(dispatchWelcomeEmails(tenant, [member], [{ id: member, email: "stale@example.invalid" }])).rejects.toMatchObject({ status: 409 });
  expect(mock.request).not.toHaveBeenCalled();
});
