import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import supertest from "supertest";
import bcrypt from "bcryptjs";
import { randomBytes, randomUUID } from "node:crypto";
import { pool } from "@workspace/db";
import app from "../app";
import { welcomeTokenHash } from "../services/welcomeEmails";

const original = "Synthetic-original-123!";
const replacement = "Synthetic-replacement-456!";
let tenantId: number, memberId: number, otherId: number, email: string, otherEmail: string;
let current: ReturnType<typeof supertest.agent>, old: ReturnType<typeof supertest.agent>;
let other: ReturnType<typeof supertest.agent>;

beforeAll(async () => {
  tenantId = (await pool.query("INSERT INTO tenants(name,slug) VALUES('Session revocation tests',$1) RETURNING id",
    [`session-${randomUUID()}`])).rows[0].id;
});
beforeEach(async () => {
  email = `sessions-${randomUUID()}@example.invalid`;
  otherEmail = `sessions-admin-${randomUUID()}@example.invalid`;
  const hash = await bcrypt.hash(original, 4);
  memberId = (await pool.query(`INSERT INTO users(tenant_id,email,password_hash,first_name,last_name,role)
    VALUES($1,$2,$3,'Synthetic','Member','viewer') RETURNING id`, [tenantId, email, hash])).rows[0].id;
  otherId = (await pool.query(`INSERT INTO users(tenant_id,email,password_hash,first_name,last_name,role)
    VALUES($1,$2,$3,'Synthetic','Admin','admin') RETURNING id`, [tenantId, otherEmail, hash])).rows[0].id;
  current = supertest.agent(app); old = supertest.agent(app); other = supertest.agent(app);
  for (const device of [current, old]) {
    await device.post("/api/auth/login").send({ email, password: original }).expect(200);
  }
  await other.post("/api/auth/login").send({ email: otherEmail, password: original }).expect(200);
});
afterEach(async () => {
  // Delete only synthetic sessions, including pre-upgrade ID-only fixtures.
  await pool.query(`DELETE FROM user_sessions WHERE
    sess->'passport'->'user'->>'id' IN (SELECT id::text FROM users WHERE tenant_id=$1)
    OR sess->'passport'->>'user' IN (SELECT id::text FROM users WHERE tenant_id=$1)`, [tenantId]);
  await pool.query("DELETE FROM password_reset_tokens WHERE email IN (SELECT email FROM users WHERE tenant_id=$1)", [tenantId]);
  await pool.query("DELETE FROM users WHERE tenant_id=$1", [tenantId]);
});
afterAll(async () => { await pool.query("DELETE FROM tenants WHERE id=$1", [tenantId]); });

async function unaffectedAndNewLogin(password = replacement, mustChangePassword = false) {
  expect((await other.get("/api/auth/me").expect(200)).body.id).toBe(otherId);
  await supertest(app).post("/api/auth/login").send({ email, password: original }).expect(401);
  const fresh = supertest.agent(app);
  expect((await fresh.post("/api/auth/login").send({ email, password }).expect(200)).body.mustChangePassword).toBe(mustChangePassword);
  expect((await fresh.get("/api/auth/me").expect(200)).body.id).toBe(memberId);
}
async function token(welcome = false) {
  const raw = welcome ? `${memberId}.${randomBytes(32).toString("hex")}` : randomUUID();
  await pool.query("INSERT INTO password_reset_tokens(email,token,expires_at) VALUES($1,$2,now()+interval '1 hour')",
    [email, welcome ? welcomeTokenHash(raw) : raw]);
  return raw;
}
async function makeLegacySessions() {
  await pool.query(`UPDATE user_sessions SET sess=jsonb_set(sess::jsonb,'{passport,user}',to_jsonb($1::int))
    WHERE sess->'passport'->'user'->>'id'=$1::text`, [memberId]);
}

describe("password changes revoke only the intended user's sessions", () => {
  it("signs out both devices without changing credentials, reset links or another user's session", async () => {
    const before = (await pool.query("SELECT * FROM users WHERE id=$1", [memberId])).rows[0];
    const pending = await token();
    const login = await current.post("/api/auth/login").send({ email, password: original }).expect(200);
    const replayCookie = (login.headers["set-cookie"] as unknown as string[]).map(c => c.split(";")[0]).join("; ");
    const response = await current.post("/api/auth/logout-all").send({ currentPassword: original, confirm: true }).expect(204);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(String(response.headers["set-cookie"])).toContain("connect.sid=;");
    await current.get("/api/auth/me").expect(401);
    await old.get("/api/auth/me").expect(401);
    await supertest(app).get("/api/auth/me").set("Cookie", replayCookie).expect(401);
    expect((await other.get("/api/auth/me").expect(200)).body.id).toBe(otherId);
    const after = (await pool.query("SELECT * FROM users WHERE id=$1", [memberId])).rows[0];
    expect(after).toEqual({ ...before, session_version: before.session_version + 1, updated_at: expect.any(Date) });
    expect((await pool.query("SELECT used_at FROM password_reset_tokens WHERE token=$1", [pending])).rows[0].used_at).toBeNull();
    const fresh = supertest.agent(app);
    await fresh.post("/api/auth/login").send({ email, password: original }).expect(200);
    await fresh.get("/api/auth/me").expect(200);
    expect((await pool.query("SELECT session_version FROM users WHERE id=$1", [otherId])).rows[0].session_version).toBe(0);
  });

  it("requires sign-in, a correct password and explicit confirmation without accepting a target user", async () => {
    await supertest(app).post("/api/auth/logout-all").send({ currentPassword: original, confirm: true }).expect(401);
    for (const body of [
      {}, { currentPassword: original }, { currentPassword: original, confirm: false },
      { currentPassword: "", confirm: true }, { currentPassword: "x".repeat(257), confirm: true },
      { currentPassword: original, confirm: true, userId: otherId },
    ]) await current.post("/api/auth/logout-all").send(body).expect(400);
    await current.post("/api/auth/logout-all").send({ currentPassword: "wrong", confirm: true }).expect(401);
    for (const device of [current, old, other]) await device.get("/api/auth/me").expect(200);
    expect((await pool.query("SELECT session_version FROM users WHERE id=$1", [memberId])).rows[0].session_version).toBe(0);
  });

  it("allows restricted users with a required temporary password to revoke sessions without clearing that requirement", async () => {
    await pool.query("UPDATE users SET section_permissions='{}', client_ids='[]', must_change_password=true WHERE id=$1", [memberId]);
    await current.post("/api/auth/logout-all").send({ currentPassword: original, confirm: true }).expect(204);
    await old.get("/api/auth/me").expect(401);
    expect((await pool.query("SELECT must_change_password FROM users WHERE id=$1", [memberId])).rows[0].must_change_password).toBe(true);
    await other.get("/api/auth/me").expect(200);
  });

  it("revokes legacy sessions and rejects simultaneous revocation attempts without a second version advance", async () => {
    await makeLegacySessions();
    const statuses = await Promise.all([current, old].map(device =>
      device.post("/api/auth/logout-all").send({ currentPassword: original, confirm: true }).then(r => r.status)));
    expect(statuses.filter(status => status === 204)).toHaveLength(1);
    expect(statuses.some(status => status === 401 || status === 409)).toBe(true);
    expect((await pool.query("SELECT session_version FROM users WHERE id=$1", [memberId])).rows[0].session_version).toBe(1);
    await current.get("/api/auth/me").expect(401);
    await old.get("/api/auth/me").expect(401);
    await other.get("/api/auth/me").expect(200);
  });

  it("fails closed if the password changes during reauthentication", async () => {
    const compare = bcrypt.compare.bind(bcrypt);
    const spy = vi.spyOn(bcrypt, "compare").mockImplementationOnce(async (password: string, hash: string) => {
      const valid = await compare(password, hash);
      await pool.query("UPDATE users SET password_hash=$1, session_version=session_version+1 WHERE id=$2",
        [await bcrypt.hash(replacement, 4), memberId]);
      return valid;
    });
    try {
      await current.post("/api/auth/logout-all").send({ currentPassword: original, confirm: true }).expect(409);
    } finally { spy.mockRestore(); }
    expect((await pool.query("SELECT session_version FROM users WHERE id=$1", [memberId])).rows[0].session_version).toBe(1);
    await other.get("/api/auth/me").expect(200);
  });

  it("keeps only a rotated current session for self-service changes", async () => {
    const response = await current.post("/api/auth/login").send({ email, password: original }).expect(200);
    const oldCookie = (response.headers["set-cookie"] as unknown as string[]).map(c => c.split(";")[0]).join("; ");
    await current.patch("/api/auth/password").send({ currentPassword: original, newPassword: replacement }).expect(200);
    await current.get("/api/auth/me").expect(200);
    await old.get("/api/auth/me").expect(401);
    await supertest(app).get("/api/auth/me").set("Cookie", oldCookie).expect(401);
    await unaffectedAndNewLogin();
  });

  it("does not revoke sessions when a self-service change fails", async () => {
    await current.patch("/api/auth/password").send({ currentPassword: "wrong", newPassword: replacement }).expect(401);
    await current.get("/api/auth/me").expect(200);
    await old.get("/api/auth/me").expect(200);
    expect((await pool.query("SELECT session_version FROM users WHERE id=$1", [memberId])).rows[0].session_version).toBe(0);
  });

  it("revokes both target sessions for an admin reset without signing out the admin", async () => {
    const pending = await token();
    await other.patch(`/api/users/${memberId}/password`).send({ password: replacement }).expect(200);
    await current.get("/api/auth/me").expect(401);
    await old.get("/api/auth/me").expect(401);
    await unaffectedAndNewLogin(replacement, true);
    await supertest(app).post("/api/auth/reset-password").send({ token: pending, password: "Should-not-work-123!" }).expect(400);
  });

  it("revokes the admin's own session too when using the admin-reset path", async () => {
    await other.patch(`/api/users/${otherId}/password`).send({ password: replacement }).expect(200);
    await other.get("/api/auth/me").expect(401);
    await current.get("/api/auth/me").expect(200);
    await old.get("/api/auth/me").expect(200);
  });

  it.each([false, true])("revokes all target sessions when redeeming a link (welcome=%s)", async welcome => {
    const raw = await token(welcome);
    const sibling = await token(!welcome);
    const endpoint = welcome ? "/api/auth/setup-password" : "/api/auth/reset-password";
    // A redemption in an authenticated browser must not preserve its old session.
    await current.post(endpoint).send({ token: raw, password: replacement }).expect(200);
    await current.get("/api/auth/me").expect(401);
    await old.get("/api/auth/me").expect(401);
    await unaffectedAndNewLogin();
    await supertest(app).post(endpoint).send({ token: raw, password: replacement }).expect(400);
    await supertest(app).post(welcome ? "/api/auth/reset-password" : "/api/auth/setup-password")
      .send({ token: sibling, password: replacement }).expect(400);
  });

  it("allows an unchanged legacy session but never upgrades it across a reset", async () => {
    await makeLegacySessions();
    await current.get("/api/auth/me").expect(200);
    await old.get("/api/auth/me").expect(200);
    await other.patch(`/api/users/${memberId}/password`).send({ password: replacement }).expect(200);
    await current.get("/api/auth/me").expect(401);
    await old.get("/api/auth/me").expect(401);
    await unaffectedAndNewLogin(replacement, true);
  });

  it("upgrades only the current legacy session during a self-service change", async () => {
    await makeLegacySessions();
    await current.patch("/api/auth/password").send({ currentPassword: original, newPassword: replacement }).expect(200);
    await current.get("/api/auth/me").expect(200);
    await old.get("/api/auth/me").expect(401);
    await unaffectedAndNewLogin();
  });

  it("allows only one concurrent reset redemption to change the password", async () => {
    const raw = await token();
    const statuses = await Promise.all([replacement, "Competing-password-789!"].map(password =>
      supertest(app).post("/api/auth/reset-password").send({ token: raw, password }).then(r => r.status)));
    expect(statuses.sort()).toEqual([200, 400]);
    expect((await pool.query("SELECT session_version FROM users WHERE id=$1", [memberId])).rows[0].session_version).toBe(1);
    await old.get("/api/auth/me").expect(401);
    await other.get("/api/auth/me").expect(200);
  });

  it.each(["unknown", "expired", "used"])("rejects a %s reset token before hashing a password", async state => {
    const raw = state === "unknown" ? randomUUID() : await token();
    if (state === "expired") {
      await pool.query("UPDATE password_reset_tokens SET expires_at=now()-interval '1 hour' WHERE token=$1", [raw]);
    } else if (state === "used") {
      await pool.query("UPDATE password_reset_tokens SET used_at=now() WHERE token=$1", [raw]);
    }
    const hash = vi.spyOn(bcrypt, "hash");
    try {
      await supertest(app).post("/api/auth/reset-password").send({ token: raw, password: replacement }).expect(400);
      expect(hash).not.toHaveBeenCalled();
    } finally { hash.mockRestore(); }
    await current.get("/api/auth/me").expect(200);
    await old.get("/api/auth/me").expect(200);
    await other.get("/api/auth/me").expect(200);
  });
});
