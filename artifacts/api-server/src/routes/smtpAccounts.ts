import { Router } from "express";
import { createCipheriv, createDecipheriv, randomBytes, createHash } from "crypto";
import { pool } from "@workspace/db";
import { requireAuth } from "../middlewares/requireAuth";
import { logger } from "../lib/logger";

const router = Router();
router.use(requireAuth);

// ── Encryption helpers (AES-256-GCM, key derived from SESSION_SECRET) ────────

function getDerivedKey(): Buffer {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error("SESSION_SECRET is not set — cannot encrypt/decrypt SMTP credentials");
  return createHash("sha256").update(secret).digest();
}

function encryptPassword(plain: string): string {
  const key = getDerivedKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString("base64");
}

function decryptPassword(encoded: string): string {
  const key = getDerivedKey();
  const buf = Buffer.from(encoded, "base64");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const enc = buf.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(enc).toString("utf8") + decipher.final("utf8");
}

function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!domain) return email;
  return `${local.slice(0, 2)}***@${domain}`;
}

// ── GET /api/smtp-accounts — list all accounts for the tenant ────────────────

router.get("/smtp-accounts", async (req, res) => {
  const user = (req as any).user;
  try {
    const { rows } = await pool.query(
      `SELECT sa.id, sa.name, sa.host, sa.port, sa.username, sa.use_tls,
              sa.from_email, sa.from_name, sa.daily_limit, sa.created_at,
              COUNT(es.id) AS used_in,
              COALESCE(du.send_count, 0) AS today_sent
       FROM smtp_accounts sa
       LEFT JOIN email_sequences es ON es.smtp_account_id = sa.id AND es.tenant_id = sa.tenant_id
       LEFT JOIN smtp_daily_usage du
         ON du.smtp_account_id = sa.id AND du.send_date = CURRENT_DATE
       WHERE sa.tenant_id = $1
       GROUP BY sa.id, du.send_count
       ORDER BY sa.created_at DESC`,
      [user.tenantId]
    );
    const accounts = rows.map(r => ({
      id: r.id,
      name: r.name,
      host: r.host,
      port: r.port,
      username: r.username,
      maskedUsername: maskEmail(r.username),
      useTls: r.use_tls,
      fromEmail: r.from_email,
      fromName: r.from_name,
      dailyLimit: r.daily_limit ?? null,
      todaySent: parseInt(r.today_sent ?? "0", 10),
      createdAt: r.created_at,
      usedIn: parseInt(r.used_in ?? "0", 10),
    }));
    res.json(accounts);
  } catch (err) {
    logger.error({ err }, "GET /smtp-accounts failed");
    res.status(500).json({ error: "Failed to list SMTP accounts" });
  }
});

// ── POST /api/smtp-accounts — create ─────────────────────────────────────────

router.post("/smtp-accounts", async (req, res, next): Promise<void> => {
  const user = (req as any).user;
  const { name, host, port, username, password, useTls, fromEmail, fromName, dailyLimit } = req.body;

  if (!name || !host || !port || !username || !password || !fromEmail) {
    res.status(400).json({ error: "name, host, port, username, password, fromEmail are required" });
    return;
  }

  // Validate dailyLimit when provided
  let limitVal: number | null = null;
  if (dailyLimit != null && dailyLimit !== "") {
    const parsed = Number(dailyLimit);
    if (!Number.isInteger(parsed) || parsed < 1) {
      res.status(400).json({ error: "dailyLimit must be a positive integer" });
      return;
    }
    limitVal = parsed;
  }

  try {
    const encryptedPassword = encryptPassword(password);
    const { rows } = await pool.query(
      `INSERT INTO smtp_accounts
         (tenant_id, name, host, port, username, encrypted_password, use_tls, from_email, from_name, daily_limit)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING id, name, host, port, username, use_tls, from_email, from_name, daily_limit, created_at`,
      [user.tenantId, name, host, parseInt(port), username, encryptedPassword, useTls !== false, fromEmail, fromName ?? "", limitVal]
    );
    const r = rows[0];
    res.status(201).json({
      id: r.id, name: r.name, host: r.host, port: r.port,
      username: r.username, maskedUsername: maskEmail(r.username),
      useTls: r.use_tls, fromEmail: r.from_email, fromName: r.from_name,
      dailyLimit: r.daily_limit ?? null, todaySent: 0, createdAt: r.created_at,
    });
  } catch (err) {
    logger.error({ err }, "POST /smtp-accounts failed");
    next(err);
  }
});

// ── PATCH /api/smtp-accounts/:id — update ────────────────────────────────────

router.patch("/smtp-accounts/:id", async (req, res, next): Promise<void> => {
  const user = (req as any).user;
  const id = parseInt(req.params.id);
  const { name, host, port, username, password, useTls, fromEmail, fromName, dailyLimit } = req.body;

  try {
    const { rows: existing } = await pool.query(
      `SELECT id FROM smtp_accounts WHERE id=$1 AND tenant_id=$2`,
      [id, user.tenantId]
    );
    if (!existing.length) { res.status(404).json({ error: "Not found" }); return; }

    const sets: string[] = [];
    const vals: any[] = [];
    let i = 1;

    if (name !== undefined)       { sets.push(`name=$${i++}`);               vals.push(name); }
    if (host !== undefined)       { sets.push(`host=$${i++}`);               vals.push(host); }
    if (port !== undefined)       { sets.push(`port=$${i++}`);               vals.push(parseInt(port)); }
    if (username !== undefined)   { sets.push(`username=$${i++}`);           vals.push(username); }
    if (password)                 { sets.push(`encrypted_password=$${i++}`); vals.push(encryptPassword(password)); }
    if (useTls !== undefined)     { sets.push(`use_tls=$${i++}`);            vals.push(useTls); }
    if (fromEmail !== undefined)  { sets.push(`from_email=$${i++}`);         vals.push(fromEmail); }
    if (fromName !== undefined)   { sets.push(`from_name=$${i++}`);          vals.push(fromName); }
    if ("dailyLimit" in req.body) {
      let patchLimit: number | null = null;
      if (dailyLimit != null && dailyLimit !== "") {
        const parsed = Number(dailyLimit);
        if (!Number.isInteger(parsed) || parsed < 1) {
          res.status(400).json({ error: "dailyLimit must be a positive integer" });
          return;
        }
        patchLimit = parsed;
      }
      sets.push(`daily_limit=$${i++}`);
      vals.push(patchLimit);
    }

    if (!sets.length) { res.status(400).json({ error: "No fields to update" }); return; }

    sets.push(`updated_at=NOW()`);
    vals.push(id, user.tenantId);

    const { rows } = await pool.query(
      `UPDATE smtp_accounts SET ${sets.join(",")} WHERE id=$${i++} AND tenant_id=$${i++}
       RETURNING id, name, host, port, username, use_tls, from_email, from_name, daily_limit, created_at`,
      vals
    );
    const r = rows[0];
    // fetch today_sent so the response matches the list shape
    const usage = await pool.query<{ send_count: number }>(
      `SELECT COALESCE(send_count, 0) AS send_count FROM smtp_daily_usage WHERE smtp_account_id=$1 AND send_date=CURRENT_DATE`,
      [id]
    );
    res.json({
      id: r.id, name: r.name, host: r.host, port: r.port,
      username: r.username, maskedUsername: maskEmail(r.username),
      useTls: r.use_tls, fromEmail: r.from_email, fromName: r.from_name,
      dailyLimit: r.daily_limit ?? null,
      todaySent: usage.rows[0]?.send_count ?? 0,
      createdAt: r.created_at,
    });
  } catch (err) {
    logger.error({ err }, "PATCH /smtp-accounts/:id failed");
    next(err);
  }
});

// ── DELETE /api/smtp-accounts/:id ────────────────────────────────────────────

router.delete("/smtp-accounts/:id", async (req, res, next): Promise<void> => {
  const user = (req as any).user;
  const id = parseInt(req.params.id);
  try {
    const { rowCount } = await pool.query(
      `DELETE FROM smtp_accounts WHERE id=$1 AND tenant_id=$2`,
      [id, user.tenantId]
    );
    if (!rowCount) { res.status(404).json({ error: "Not found" }); return; }
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, "DELETE /smtp-accounts/:id failed");
    next(err);
  }
});

// ── POST /api/smtp-accounts/:id/test — send a test email ─────────────────────

router.post("/smtp-accounts/:id/test", async (req, res, next): Promise<void> => {
  const user = (req as any).user;
  const id = parseInt(req.params.id);
  const { toEmail } = req.body;
  if (!toEmail) { res.status(400).json({ error: "toEmail is required" }); return; }

  try {
    const { rows } = await pool.query(
      `SELECT * FROM smtp_accounts WHERE id=$1 AND tenant_id=$2`,
      [id, user.tenantId]
    );
    if (!rows.length) { res.status(404).json({ error: "Not found" }); return; }

    const acct = rows[0];
    let plainPassword: string;
    try {
      plainPassword = decryptPassword(acct.encrypted_password);
    } catch {
      res.status(500).json({ error: "Failed to decrypt password" });
      return;
    }

    const nodemailer = require("nodemailer");
    const transporter = nodemailer.createTransport({
      host: acct.host,
      port: acct.port,
      secure: acct.use_tls && acct.port === 465,
      requireTLS: acct.use_tls && acct.port !== 465,
      auth: { user: acct.username, pass: plainPassword },
    });

    try {
      await transporter.verify();
    } catch (verifyErr: any) {
      res.status(400).json({ error: `Connection failed: ${verifyErr.message}` });
      return;
    }

    await transporter.sendMail({
      from: `${acct.from_name || "KABOOM"} <${acct.from_email}>`,
      to: toEmail,
      subject: "KABOOM SMTP test",
      text: "This is a test email from your KABOOM SMTP sending account. Everything is working correctly!",
      html: "<p>This is a test email from your KABOOM SMTP sending account. <strong>Everything is working correctly!</strong></p>",
    });

    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, "SMTP test send failed");
    next(err);
  }
});

// ── Exported helpers for the sequence worker ──────────────────────────────────

/**
 * Atomically reserve one send slot for today on the given SMTP account.
 * Uses a single conditional upsert (CTE) so concurrent workers cannot race
 * past the daily_limit: the increment only happens when under-limit, in one
 * round-trip with no separate check query.
 *
 * Returns true if a slot was reserved, false if the limit is exhausted.
 * When daily_limit IS NULL the account is treated as unlimited.
 *
 * Call this BEFORE the actual send.  If the send subsequently fails, call
 * decrementDailyUsage() to release the reserved slot so it isn't wasted.
 */
export async function reserveDailySlot(smtpAccountId: number): Promise<boolean> {
  try {
    // Single CTE: insert the first row of the day (send_count = 1) or increment
    // the existing row — but ONLY when under limit.  The RETURNING clause is
    // non-empty iff the increment actually happened, making the result definitive.
    const { rows } = await pool.query<{ allowed: boolean }>(
      `WITH upsert AS (
         INSERT INTO smtp_daily_usage (smtp_account_id, send_date, send_count)
         VALUES ($1, CURRENT_DATE, 1)
         ON CONFLICT (smtp_account_id, send_date) DO UPDATE
           SET send_count = smtp_daily_usage.send_count + 1
           WHERE (
             (SELECT daily_limit FROM smtp_accounts WHERE id = $1) IS NULL
             OR smtp_daily_usage.send_count < (SELECT daily_limit FROM smtp_accounts WHERE id = $1)
           )
         RETURNING 1 AS incremented
       )
       SELECT EXISTS (SELECT 1 FROM upsert) AS allowed`,
      [smtpAccountId]
    );

    const allowed: boolean = rows[0]?.allowed ?? false;

    if (!allowed) {
      // Log the current limit for context
      const limitRow = await pool.query<{ daily_limit: number | null }>(
        `SELECT daily_limit FROM smtp_accounts WHERE id = $1`,
        [smtpAccountId]
      );
      logger.warn(
        { smtpAccountId, daily_limit: limitRow.rows[0]?.daily_limit ?? null },
        "SMTP daily limit exhausted — skipping send"
      );
    }

    return allowed;
  } catch (err) {
    logger.error({ err, smtpAccountId }, "reserveDailySlot failed — allowing send");
    return true; // fail-open: a DB hiccup should not silently block all emails
  }
}

/**
 * Release a previously reserved daily slot when the corresponding send failed.
 * Decrements by 1 without going below 0.  Errors are swallowed — a lost
 * decrement is minor compared to the cost of crashing the worker.
 */
export async function releaseDailySlot(smtpAccountId: number): Promise<void> {
  try {
    await pool.query(
      `UPDATE smtp_daily_usage
       SET send_count = GREATEST(send_count - 1, 0)
       WHERE smtp_account_id = $1 AND send_date = CURRENT_DATE`,
      [smtpAccountId]
    );
  } catch (err) {
    logger.warn({ err, smtpAccountId }, "releaseDailySlot failed — slot not released");
  }
}

// ── GET /api/smtp-accounts/:id/decrypt — internal use by worker ──────────────
// Returns the plaintext password for a given account (auth-protected, no external exposure).

export async function getSmtpAccountCredentials(id: number, tenantId: number): Promise<{
  host: string; port: number; username: string; password: string;
  useTls: boolean; fromEmail: string; fromName: string;
} | null> {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM smtp_accounts WHERE id=$1 AND tenant_id=$2`,
      [id, tenantId]
    );
    if (!rows.length) return null;
    const r = rows[0];
    const password = decryptPassword(r.encrypted_password);
    return {
      host: r.host, port: r.port, username: r.username, password,
      useTls: r.use_tls, fromEmail: r.from_email, fromName: r.from_name,
    };
  } catch (err) {
    logger.error({ err, id }, "getSmtpAccountCredentials failed");
    return null;
  }
}

export default router;
