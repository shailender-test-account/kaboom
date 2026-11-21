import { afterAll, beforeAll, describe, expect, it } from "vitest";
import supertest from "supertest";
import bcrypt from "bcryptjs";
import { randomUUID } from "node:crypto";
import { pool } from "@workspace/db";
import app from "../app";

let tenantId: number, adminId: number, memberId: number;
const suffix = randomUUID();
const email = `password-member-${suffix}@example.invalid`;
const adminEmail = `password-admin-${suffix}@example.invalid`;
const temporary = `Temp-${randomUUID()}`;
const replacement = `New-${randomUUID()}`;
const api = supertest.agent(app);

beforeAll(async () => {
  tenantId = (await pool.query("INSERT INTO tenants(name,slug) VALUES('Isolated password tests',$1) RETURNING id", [`password-${suffix}`])).rows[0].id;
  const hash = await bcrypt.hash(temporary, 4);
  adminId = (await pool.query(`INSERT INTO users(tenant_id,email,password_hash,first_name,last_name,role)
    VALUES($1,$2,$3,'Password','Admin','admin') RETURNING id`, [tenantId, adminEmail, hash])).rows[0].id;
  memberId = (await pool.query(`INSERT INTO users(tenant_id,email,password_hash,first_name,last_name,role,
    section_permissions,client_ids,must_change_password)
    VALUES($1,$2,$3,'Password','Member','viewer','{}'::jsonb,'[]'::jsonb,true) RETURNING id`, [tenantId, email, hash])).rows[0].id;
});
afterAll(async () => {
  await pool.query("DELETE FROM password_reset_tokens WHERE email IN (SELECT email FROM users WHERE tenant_id=$1)", [tenantId]);
  await pool.query("DELETE FROM users WHERE tenant_id=$1", [tenantId]);
  await pool.query("DELETE FROM tenants WHERE id=$1", [tenantId]);
});

describe("required temporary-password replacement", () => {
  it("returns the requirement on login and reload, and denies direct protected requests", async () => {
    expect((await api.post("/api/auth/login").send({ email, password: temporary }).expect(200)).body.mustChangePassword).toBe(true);
    expect((await api.get("/api/auth/me").expect(200)).body.mustChangePassword).toBe(true);
    for (const path of ["/api/clients", "/api/team-access", "/api/analytics/dashboard"]) {
      expect((await api.get(path).expect(403)).body.code).toBe("PASSWORD_CHANGE_REQUIRED");
    }
    await api.patch(`/api/users/${adminId}/access`).send({ role: "viewer", sectionPermissions: {} }).expect(403);
  });

  it("rejects wrong, unchanged, short and oversized passwords without clearing the restriction", async () => {
    await api.patch("/api/auth/password").send({ currentPassword: "incorrect", newPassword: replacement }).expect(401);
    await api.patch("/api/auth/password").send({ currentPassword: temporary, newPassword: temporary }).expect(400);
    await api.patch("/api/auth/password").send({ currentPassword: temporary, newPassword: "short" }).expect(400);
    await api.patch("/api/auth/password").send({ currentPassword: temporary, newPassword: "😀".repeat(24) }).expect(400);
    expect((await api.get("/api/auth/me").expect(200)).body.mustChangePassword).toBe(true);
  });

  it("changes the password despite no tab or client access, invalidates reset links and rejects the old password", async () => {
    await pool.query("INSERT INTO password_reset_tokens(email,token,expires_at) VALUES($1,$2,now()+interval '1 hour')",
      [email, `isolated-${suffix}`]);
    await api.patch("/api/auth/password").send({ currentPassword: temporary, newPassword: replacement }).expect(200);
    expect((await api.get("/api/auth/me").expect(200)).body.mustChangePassword).toBe(false);
    expect((await pool.query("SELECT used_at FROM password_reset_tokens WHERE token=$1", [`isolated-${suffix}`])).rows[0].used_at).not.toBeNull();
    // Existing section/client restrictions still apply after password replacement.
    const denied = await api.get("/api/clients").expect(403);
    expect(denied.body.code).not.toBe("PASSWORD_CHANGE_REQUIRED");
    await api.post("/api/auth/logout").expect(204);
    await api.post("/api/auth/login").send({ email, password: temporary }).expect(401);
    expect((await api.post("/api/auth/login").send({ email, password: replacement }).expect(200)).body.mustChangePassword).toBe(false);
    // The same self-service operation stays available for later changes.
    await api.patch("/api/auth/password").send({ currentPassword: replacement, newPassword: replacement + "-later" }).expect(200);
  });

  it("marks single and bulk-created accounts as temporary, but leaves existing users unchanged", async () => {
    const admin = supertest.agent(app);
    expect((await admin.post("/api/auth/login").send({ email: adminEmail, password: temporary }).expect(200)).body.mustChangePassword).toBe(false);
    const single = await admin.post("/api/users/invite").send({
      firstName: "Single", lastName: "Test", email: `single-${suffix}@example.invalid`,
      role: "viewer", sectionPermissions: {}, clientIds: [],
    }).expect(201);
    const bulk = await admin.post("/api/users/bulk").send({
      users: [{ firstName: "Bulk", lastName: "Test", email: `bulk-${suffix}@example.invalid` }],
      role: "viewer", sectionPermissions: {}, clientIds: [],
    }).expect(201);
    for (const id of [single.body.user.id, bulk.body[0].user.id]) {
      expect((await pool.query("SELECT must_change_password FROM users WHERE id=$1", [id])).rows[0].must_change_password).toBe(true);
    }
    await admin.patch(`/api/users/${memberId}/password`).send({ password: temporary }).expect(200);
    expect((await pool.query("SELECT must_change_password FROM users WHERE id=$1", [memberId])).rows[0].must_change_password).toBe(true);
    expect((await pool.query("SELECT must_change_password FROM users WHERE id=$1", [adminId])).rows[0].must_change_password).toBe(false);
  });

  it("requires authentication to change a password", async () => {
    await supertest(app).patch("/api/auth/password").send({ currentPassword: temporary, newPassword: replacement }).expect(401);
  });
});
