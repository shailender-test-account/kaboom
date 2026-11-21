import { Router, type IRouter } from "express";
import passport from "passport";
import { and, eq, sql } from "drizzle-orm";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { z } from "zod";
import { db, pool, usersTable, tenantsTable } from "@workspace/db";
import { requireAuth } from "../middlewares/requireAuth";
import { sendEmail } from "../services/email";
import { logger } from "../lib/logger";
import { redeemWelcomeToken, WelcomeEmailError } from "../services/welcomeEmails";
import { LogoutAllDevicesBody } from "@workspace/api-zod";

const router: IRouter = Router();

router.post("/auth/setup-password", async (req, res, next): Promise<void> => {
  const parsed = z.object({
    token: z.string().regex(/^[1-9]\d{0,12}\.[a-f0-9]{64}$/),
    password: z.string().min(8).max(72).refine(value => Buffer.byteLength(value, "utf8") <= 72),
  }).strict().safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Use a valid setup link and a password of 8–72 bytes." }); return; }
  res.setHeader("Cache-Control", "no-store");
  try { res.json(await redeemWelcomeToken(parsed.data.token, parsed.data.password)); }
  catch (err) {
    if (err instanceof WelcomeEmailError) { res.status(err.status).json({ error: err.message }); return; }
    next(err);
  }
});

router.post("/auth/login", (req, res, next) => {
  passport.authenticate("local", async (err: any, user: any, info: any) => {
    if (err) return next(err);
    if (!user) {
      res.status(401).json({ error: info?.message ?? "Invalid credentials", ...(info?.code ? { code: info.code } : {}) });
      return;
    }
    req.logIn(user, async (loginErr) => {
      if (loginErr) return next(loginErr);
      try {
        const [tenant] = await db
          .select()
          .from(tenantsTable)
          .where(eq(tenantsTable.id, user.tenantId));
        res.json({
          id: user.id,
          tenantId: user.tenantId,
          tenantName: tenant?.name ?? "",
          email: user.email,
          firstName: user.firstName,
          lastName: user.lastName,
          role: user.role,
          mustChangePassword: user.mustChangePassword === true,
          sectionPermissions: user.sectionPermissions ?? null,
          clientIds: user.role === "admin" ? null : user.clientIds ?? null,
          avatarUrl: user.avatarUrl ?? null,
        });
      } catch (e) {
        next(e);
      }
    });
  })(req, res, next);
});

// ── POST /auth/forgot-password — public, sends reset link by email ───────────
router.post("/auth/forgot-password", async (req, res, next): Promise<void> => {
  const parsed = z.object({ email: z.string().email() }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Valid email required" }); return; }
  try {
    const { email } = parsed.data;
    // Always respond OK — never reveal whether the email exists
    const [user] = await db.select({ id: usersTable.id, email: usersTable.email })
      .from(usersTable).where(eq(usersTable.email, email.toLowerCase().trim()));
    if (!user) { res.json({ ok: true }); return; }

    const token = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
    await pool.query(
      `INSERT INTO password_reset_tokens (email, token, expires_at) VALUES ($1, $2, $3)`,
      [email.toLowerCase().trim(), token, expiresAt],
    );

    // Build reset URL from request headers (works behind Replit proxy)
    const proto = (req.headers["x-forwarded-proto"] as string) || "https";
    const host = (req.headers["x-forwarded-host"] as string) || (req.headers["host"] as string) || "";
    const resetUrl = `${proto}://${host}/reset-password?token=${token}`;

    await sendEmail({
      to: email,
      subject: "Reset your KABOOM password",
      html: `
        <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px 24px">
          <h2 style="font-size:20px;font-weight:700;margin-bottom:8px">Reset your password</h2>
          <p style="color:#555;margin-bottom:24px">Click the button below to set a new password. This link expires in <strong>1 hour</strong>.</p>
          <a href="${resetUrl}" style="display:inline-block;background:#4f46e5;color:#fff;text-decoration:none;padding:10px 24px;border-radius:6px;font-weight:600;font-size:14px">Reset password</a>
          <p style="color:#999;font-size:12px;margin-top:24px">If you didn't request this, ignore this email — your password won't change.</p>
          <hr style="border:none;border-top:1px solid #eee;margin:24px 0"/>
          <p style="color:#bbb;font-size:11px">KABOOM ABM Platform</p>
        </div>`,
      text: `Reset your KABOOM password\n\nClick this link (expires in 1 hour):\n${resetUrl}\n\nIf you didn't request this, ignore this email.`,
    });

    logger.info({ email }, "Password reset email sent");
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ── POST /auth/reset-password — public, validates token + sets new password ──
router.post("/auth/reset-password", async (req, res, next): Promise<void> => {
  const parsed = z.object({
    token: z.string().min(1),
    password: z.string().min(8),
  }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Token and password (min 8 chars) required" }); return; }
  try {
    const { token, password } = parsed.data;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // Lock the user before tokens, matching self-service/admin changes and
      // welcome redemption. Recheck token validity after obtaining the lock.
      const { rows: users } = await client.query<{ id: number; email: string }>(
        `SELECT id,email FROM users WHERE email=(
          SELECT email FROM password_reset_tokens WHERE token=$1 AND token NOT LIKE 'welcome:%' LIMIT 1
        ) FOR UPDATE`, [token]);
      const user = users[0];
      const { rows } = await client.query(
        `SELECT id FROM password_reset_tokens WHERE token=$1 AND token NOT LIKE 'welcome:%'
          AND email=$2 AND used_at IS NULL AND expires_at>now() FOR UPDATE`, [token, user?.email ?? ""]);
      if (!user || !rows.length) {
        await client.query("ROLLBACK");
        res.status(400).json({ error: "Invalid, expired or already used reset link" }); return;
      }
      // Unknown/expired/used tokens must never trigger expensive hashing.
      // Keep the user/token locks through hashing and the atomic update.
      const hash = await bcrypt.hash(password, 12);
      await client.query(`UPDATE users SET password_hash=$1, must_change_password=false,
        temporary_password_expires_at=NULL, session_version=session_version+1 WHERE id=$2`, [hash, user.id]);
      await client.query("UPDATE password_reset_tokens SET used_at=now() WHERE email=$1 AND used_at IS NULL", [user.email]);
      await client.query("COMMIT");
      logger.info({ userId: user.id }, "Password reset completed");
    } catch (err) {
      await client.query("ROLLBACK"); throw err;
    } finally { client.release(); }
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ── PATCH /auth/password — any logged-in user can change their own password ──
router.patch("/auth/password", requireAuth, async (req, res, next): Promise<void> => {
  const parsed = z.object({
    currentPassword: z.string().min(1).max(256),
    newPassword: z.string().min(8).max(72).refine(value => Buffer.byteLength(value, "utf8") <= 72),
  }).strict().safeParse(req.body);
  res.setHeader("Cache-Control", "no-store");
  if (!parsed.success) { res.status(400).json({ error: "New password must be at least 8 characters and at most 72 bytes." }); return; }
  try {
    const actor = req.user as any;
    const [row] = await db.select({ passwordHash: usersTable.passwordHash }).from(usersTable).where(eq(usersTable.id, actor.id));
    if (!row) { res.status(404).json({ error: "User not found" }); return; }
    const valid = await bcrypt.compare(parsed.data.currentPassword, row.passwordHash);
    if (!valid) { res.status(401).json({ error: "Current password is incorrect" }); return; }
    if (await bcrypt.compare(parsed.data.newPassword, row.passwordHash)) {
      res.status(400).json({ error: "Choose a password different from your current password." }); return;
    }
    const hash = await bcrypt.hash(parsed.data.newPassword, 12);
    const changed = await db.transaction(async tx => {
      const updated = await tx.update(usersTable).set({
        passwordHash: hash, mustChangePassword: false, temporaryPasswordExpiresAt: null,
        sessionVersion: sql`${usersTable.sessionVersion} + 1`,
      })
        .where(and(eq(usersTable.id, actor.id), eq(usersTable.passwordHash, row.passwordHash),
          eq(usersTable.sessionVersion, actor.sessionVersion),
          sql`(NOT ${usersTable.mustChangePassword} OR ${usersTable.temporaryPasswordExpiresAt} IS NULL OR ${usersTable.temporaryPasswordExpiresAt} > clock_timestamp())`
        )).returning();
      if (!updated.length) return null;
      await tx.execute(sql`UPDATE password_reset_tokens SET used_at=now() WHERE email=${updated[0].email} AND used_at IS NULL`);
      return updated[0];
    });
    if (!changed) { res.status(409).json({ error: "Your password changed in another request. Sign in again and retry." }); return; }
    // Passport rotates the session ID and persists the exact committed version.
    // Do not reread the version: a concurrent admin reset must still revoke us.
    await new Promise<void>((resolve, reject) => req.logIn(changed, err => err ? reject(err) : resolve()));
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.post("/auth/logout-all", requireAuth, async (req, res, next): Promise<void> => {
  res.setHeader("Cache-Control", "no-store");
  const parsed = LogoutAllDevicesBody.strict().safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Enter your current password and confirm signing out every device." }); return;
  }
  try {
    const actor = req.user as typeof usersTable.$inferSelect;
    const [row] = await db.select({ passwordHash: usersTable.passwordHash })
      .from(usersTable).where(eq(usersTable.id, actor.id));
    if (!row || !await bcrypt.compare(parsed.data.currentPassword, row.passwordHash)) {
      res.status(401).json({ error: "Current password is incorrect" }); return;
    }
    // Compare-and-swap prevents reauthentication against an obsolete password
    // or an already revoked session from authorizing another version change.
    const updated = await db.update(usersTable)
      .set({ sessionVersion: sql`${usersTable.sessionVersion} + 1` })
      .where(and(eq(usersTable.id, actor.id), eq(usersTable.passwordHash, row.passwordHash),
        eq(usersTable.sessionVersion, actor.sessionVersion)))
      .returning({ id: usersTable.id });
    if (!updated.length) {
      res.status(409).json({ error: "Your credentials or sessions changed. Sign in again and retry." }); return;
    }
    // Never preserve the initiating session on this path.
    await new Promise<void>((resolve, reject) => req.logout(err => err ? reject(err) : resolve()));
    await new Promise<void>((resolve, reject) => req.session.destroy(err => err ? reject(err) : resolve()));
    res.clearCookie("connect.sid", { path: "/" });
    res.sendStatus(204);
  } catch (err) { next(err); }
});

router.post("/auth/logout", (req, res, next) => {
  req.logout((err) => {
    if (err) return next(err);
    res.sendStatus(204);
  });
});

router.get("/auth/me", requireAuth, async (req, res, next): Promise<void> => {
  try {
    const user = req.user as any;
    const [tenant] = await db
      .select()
      .from(tenantsTable)
      .where(eq(tenantsTable.id, user.tenantId));
    res.json({
      id: user.id,
      tenantId: user.tenantId,
      tenantName: tenant?.name ?? "",
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      role: user.role,
      mustChangePassword: user.mustChangePassword === true,
      sectionPermissions: user.sectionPermissions ?? null,
      clientIds: user.role === "admin" ? null : user.clientIds ?? null,
      avatarUrl: user.avatarUrl ?? null,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
