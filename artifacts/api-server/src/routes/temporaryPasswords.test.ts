import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import supertest from "supertest";
import bcrypt from "bcryptjs";
import { randomUUID, randomBytes } from "node:crypto";
import { pool } from "@workspace/db";
const mail = vi.hoisted(() => ({ send: vi.fn().mockResolvedValue({ id: "isolated-expiry-reset" }) }));
vi.mock("../services/email", async importOriginal => ({
  ...await importOriginal<typeof import("../services/email")>(),
  sendEmail: mail.send,
}));
import app from "../app";
import { temporaryPasswordDeadline, temporaryPasswordExpired } from "../lib/temporaryPasswords";
import { welcomeTokenHash } from "../services/welcomeEmails";

const suffix = randomUUID();
const password = `Isolated-${randomUUID()}`;
let tenantId: number, otherTenantId: number, adminId: number, memberId: number, foreignId: number;
const admin = supertest.agent(app);
const member = supertest.agent(app);
const emailFor = (name: string) => `${name}-${suffix}@example.invalid`;
const stored = async (id: number) => (await pool.query("SELECT * FROM users WHERE id=$1", [id])).rows[0];
const expire = (id: number) => pool.query("UPDATE users SET temporary_password_expires_at=now()-interval '1 second' WHERE id=$1", [id]);

beforeAll(async () => {
  tenantId = (await pool.query("INSERT INTO tenants(name,slug) VALUES('Isolated expiry',$1) RETURNING id", [`expiry-${suffix}`])).rows[0].id;
  otherTenantId = (await pool.query("INSERT INTO tenants(name,slug) VALUES('Isolated expiry foreign',$1) RETURNING id", [`expiry-other-${suffix}`])).rows[0].id;
  const hash = await bcrypt.hash(password, 4);
  for (const [name, role, tenant] of [["admin", "admin", tenantId], ["member", "viewer", tenantId], ["foreign", "viewer", otherTenantId]] as const) {
    const id = (await pool.query(`INSERT INTO users(tenant_id,email,password_hash,first_name,last_name,role)
      VALUES($1,$2,$3,'Expiry','Test',$4) RETURNING id`, [tenant, emailFor(name), hash, role])).rows[0].id;
    if (name === "admin") adminId = id;
    if (name === "member") memberId = id;
    if (name === "foreign") foreignId = id;
  }
  await admin.post("/api/auth/login").send({ email: emailFor("admin"), password }).expect(200);
  await member.post("/api/auth/login").send({ email: emailFor("member"), password }).expect(200);
});

afterAll(async () => {
  await pool.query(`DELETE FROM user_sessions WHERE COALESCE(
    sess::jsonb->'passport'->'user'->>'id', sess::jsonb->'passport'->>'user') IN
    (SELECT id::text FROM users WHERE tenant_id IN ($1,$2))`, [tenantId, otherTenantId]);
  await pool.query("DELETE FROM password_reset_tokens WHERE email IN (SELECT email FROM users WHERE tenant_id IN ($1,$2))", [tenantId, otherTenantId]);
  await pool.query("DELETE FROM users WHERE tenant_id IN ($1,$2)", [tenantId, otherTenantId]);
  await pool.query("DELETE FROM tenants WHERE id IN ($1,$2)", [tenantId, otherTenantId]);
});

async function create(name: string, hours?: number) {
  return (await admin.post("/api/users/invite").send({
    firstName: "Expiry", lastName: "Test", email: emailFor(name), role: "viewer",
    sectionPermissions: {}, clientIds: [], ...(hours === undefined ? {} : { temporaryPasswordHours: hours }),
  }).expect(201)).body;
}
function expectHours(deadline: string, hours: number) {
  expect(new Date(deadline).getTime() - Date.now()).toBeGreaterThan(hours * 3600000 - 30000);
  expect(new Date(deadline).getTime() - Date.now()).toBeLessThanOrEqual(hours * 3600000);
}

describe("temporary credential expiry", () => {
  it("uses an inclusive deadline and never infers legacy eligibility", () => {
    expect(temporaryPasswordExpired({ mustChangePassword: true, temporaryPasswordExpiresAt: new Date(0) })).toBe(true);
    expect(temporaryPasswordExpired({ mustChangePassword: true, temporaryPasswordExpiresAt: null })).toBe(false);
    expect(temporaryPasswordExpired({ mustChangePassword: false, temporaryPasswordExpiresAt: new Date(0) })).toBe(false);
    for (const hours of [0, -1, 169, 1.5, NaN]) expect(() => temporaryPasswordDeadline(hours)).toThrow();
  });

  it("assigns configurable/default deadlines and clears tracking after a personal password is chosen", async () => {
    const first = await create("new", 1);
    expectHours(first.user.temporaryPasswordExpiresAt, 1);
    const defaults = await create("default");
    expectHours(defaults.user.temporaryPasswordExpiresAt, 72);
    const api = supertest.agent(app);
    expect((await api.post("/api/auth/login").send({ email: first.user.email, password: first.tempPassword }).expect(200)).body.mustChangePassword).toBe(true);
    await api.get("/api/clients").expect(403);
    await api.patch("/api/auth/password").send({ currentPassword: first.tempPassword, newPassword: password }).expect(200);
    const row = await stored(first.user.id);
    expect(row.must_change_password).toBe(false);
    expect(row.temporary_password_expires_at).toBeNull();
    await admin.post(`/api/users/${first.user.id}/reissue-temporary-password`).send({}).expect(409);
    expect((await stored(first.user.id)).password_hash).toBe(row.password_hash);
  });

  it("rejects expired logins and already-open setup sessions, then reissues safely", async () => {
    const first = await create("expired", 1);
    const api = supertest.agent(app);
    await api.post("/api/auth/login").send({ email: first.user.email, password: first.tempPassword }).expect(200);
    await expire(first.user.id);
    const failure = await supertest(app).post("/api/auth/login").send({ email: first.user.email, password: first.tempPassword }).expect(401);
    expect(failure.body.code).toBe("TEMPORARY_PASSWORD_EXPIRED");
    expect(failure.body.error).toContain("administrator");
    // Do not reveal account state without a matching credential.
    expect((await supertest(app).post("/api/auth/login").send({ email: first.user.email, password: "wrong" }).expect(401)).body.error).toBe("Invalid credentials");
    expect((await api.get("/api/auth/me").expect(401)).body.code).toBe("TEMPORARY_PASSWORD_EXPIRED");
    await api.patch("/api/auth/password").send({ currentPassword: first.tempPassword, newPassword: password }).expect(401);
    const reissued = await admin.post(`/api/users/${first.user.id}/reissue-temporary-password`).send({ temporaryPasswordHours: 24 }).expect(200);
    expect(reissued.headers["cache-control"]).toBe("no-store");
    expectHours(reissued.body.user.temporaryPasswordExpiresAt, 24);
    expect(reissued.body.tempPassword).not.toBe(first.tempPassword);
    // Reissue replaces the credential and must preserve main's device revocation.
    await api.get("/api/auth/me").expect(401);
    await supertest(app).post("/api/auth/login").send({ email: first.user.email, password: first.tempPassword }).expect(401);
    const renewed = supertest.agent(app);
    await renewed.post("/api/auth/login").send({ email: first.user.email, password: reissued.body.tempPassword }).expect(200);
    await renewed.patch("/api/auth/password").send({ currentPassword: reissued.body.tempPassword, newPassword: password }).expect(200);
    expect((await stored(first.user.id)).temporary_password_expires_at).toBeNull();
  });

  it("invalidates old reset and setup links atomically when a temporary password is reissued", async () => {
    const target = await create("reissue-links");
    const resetToken = randomUUID();
    const setupToken = `${target.user.id}.${randomBytes(32).toString("hex")}`;
    for (const token of [resetToken, welcomeTokenHash(setupToken)]) {
      await pool.query("INSERT INTO password_reset_tokens(email,token,expires_at) VALUES($1,$2,now()+interval '1 hour')", [target.user.email, token]);
    }
    const reissued = (await admin.post(`/api/users/${target.user.id}/reissue-temporary-password`).send({}).expect(200)).body;
    expect((await pool.query("SELECT used_at FROM password_reset_tokens WHERE email=$1", [target.user.email])).rows.every(row => row.used_at != null)).toBe(true);
    await supertest(app).post("/api/auth/reset-password").send({ token: resetToken, password }).expect(400);
    await supertest(app).post("/api/auth/setup-password").send({ token: setupToken, password }).expect(400);
    await supertest(app).post("/api/auth/login").send({ email: target.user.email, password: target.tempPassword }).expect(401);
    expect((await supertest(app).post("/api/auth/login").send({ email: target.user.email, password: reissued.tempPassword }).expect(200)).body.mustChangePassword).toBe(true);
    const row = await stored(target.user.id);
    expect(row.must_change_password).toBe(true);
    expect(row.temporary_password_expires_at).not.toBeNull();
  });

  it("covers bulk credentials, common deadlines, expiry and replacement", async () => {
    const batch = await admin.post("/api/users/bulk").send({
      users: ["bulk1", "bulk2"].map(name => ({ firstName: "Bulk", lastName: "Expiry", email: emailFor(name) })),
      role: "viewer", sectionPermissions: {}, clientIds: [], temporaryPasswordHours: 168,
    }).expect(201);
    expect(new Set(batch.body.map((item: any) => item.user.temporaryPasswordExpiresAt)).size).toBe(1);
    for (const item of batch.body) {
      expectHours(item.user.temporaryPasswordExpiresAt, 168);
      await supertest(app).post("/api/auth/login").send({ email: item.user.email, password: item.tempPassword }).expect(200);
      await expire(item.user.id);
      await supertest(app).post("/api/auth/login").send({ email: item.user.email, password: item.tempPassword }).expect(401);
      await admin.post(`/api/users/${item.user.id}/reissue-temporary-password`).send({}).expect(200);
    }
    const list = await admin.get("/api/team-access").expect(200);
    expect(JSON.stringify(list.body)).not.toContain("passwordHash");
    expect(JSON.stringify(list.body)).not.toContain("tempPassword");
  });

  it("leaves legacy credentials unchanged, but explicitly issued admin resets expire", async () => {
    const before = await stored(memberId);
    expect(before.temporary_password_expires_at).toBeNull();
    expect((await stored(adminId)).temporary_password_expires_at).toBeNull();
    await admin.post(`/api/users/${memberId}/reissue-temporary-password`).send({}).expect(409);
    expect((await stored(memberId)).password_hash).toBe(before.password_hash);
    await admin.patch(`/api/users/${memberId}/password`).send({ password, temporaryPasswordHours: 1 }).expect(200);
    expectHours((await stored(memberId)).temporary_password_expires_at, 1);
    await expire(memberId);
    await supertest(app).post("/api/auth/login").send({ email: emailFor("member"), password }).expect(401);
  });

  it("enforces admin, workspace, self and lifetime boundaries without altering targets", async () => {
    const target = await create("boundaries");
    const hash = (await stored(target.user.id)).password_hash;
    await supertest(app).post(`/api/users/${target.user.id}/reissue-temporary-password`).send({}).expect(401);
    // Fresh member because another test explicitly reset the original member.
    const viewer = supertest.agent(app);
    const viewerUser = await create("viewer");
    await viewer.post("/api/auth/login").send({ email: viewerUser.user.email, password: viewerUser.tempPassword }).expect(200);
    await viewer.patch("/api/auth/password").send({ currentPassword: viewerUser.tempPassword, newPassword: password }).expect(200);
    await viewer.post(`/api/users/${target.user.id}/reissue-temporary-password`).send({}).expect(403);
    await admin.post(`/api/users/${foreignId}/reissue-temporary-password`).send({}).expect(409);
    await admin.post(`/api/users/${adminId}/reissue-temporary-password`).send({}).expect(400);
    for (const hours of [0, 169, 1.2, "24", null]) {
      await admin.post(`/api/users/${target.user.id}/reissue-temporary-password`).send({ temporaryPasswordHours: hours }).expect(400);
      await admin.patch(`/api/users/${target.user.id}/password`).send({ password, temporaryPasswordHours: hours }).expect(400);
    }
    await admin.post("/api/users/bulk").send({
      users: [{ firstName: "Bad", lastName: "Lifetime", email: emailFor("bad-bulk") }],
      role: "viewer", sectionPermissions: {}, clientIds: [], temporaryPasswordHours: 0,
    }).expect(400);
    expect((await stored(target.user.id)).password_hash).toBe(hash);
  });

  it("keeps user-requested recovery links independent of expired temporary passwords", async () => {
    const target = await create("reset-link");
    await expire(target.user.id);
    const token = randomUUID();
    await pool.query("INSERT INTO password_reset_tokens(email,token,expires_at) VALUES($1,$2,now()+interval '1 hour')", [target.user.email, token]);
    await supertest(app).post("/api/auth/reset-password").send({ token, password }).expect(200);
    expect((await stored(target.user.id)).temporary_password_expires_at).toBeNull();
    expect((await supertest(app).post("/api/auth/login").send({ email: target.user.email, password }).expect(200)).body.mustChangePassword).toBe(false);
  });

  it("lets an expired open session request and redeem a recovery link without administrator intervention", async () => {
    const target = await create("expired-session-recovery");
    const api = supertest.agent(app);
    await api.post("/api/auth/login").send({ email: target.user.email, password: target.tempPassword }).expect(200);
    await expire(target.user.id);
    await api.get("/api/auth/me").expect(401);
    // The browser has returned to sign-in but still holds the session cookie.
    await api.post("/api/auth/forgot-password").send({ email: target.user.email }).expect(200);
    expect(mail.send).toHaveBeenCalledTimes(1);
    expect(mail.send.mock.calls[0][0].to).toBe(target.user.email);
    const token = (await pool.query("SELECT token FROM password_reset_tokens WHERE email=$1 AND used_at IS NULL", [target.user.email])).rows[0].token;
    await api.post("/api/auth/reset-password").send({ token, password }).expect(200);
    const row = await stored(target.user.id);
    expect(row.must_change_password).toBe(false);
    expect(row.temporary_password_expires_at).toBeNull();
    await api.post("/api/auth/login").send({ email: target.user.email, password }).expect(200);
  });
});
