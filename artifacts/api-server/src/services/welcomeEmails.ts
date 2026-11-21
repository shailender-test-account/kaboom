import { createHash, randomBytes, randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { pool } from "@workspace/db";
import { getMailConfig, requestResend, welcomeBaseUrl, welcomeSendingEnabled } from "./resendTransport";

type Recipient = { id: number; email: string; name: string };
export class WelcomeEmailError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export const welcomeTokenHash = (token: string) => `welcome:${createHash("sha256").update(token).digest("hex")}`;
const subject = "Welcome to KABOOM — set your password";
const emailText = (name: string, link: string) =>
  `Hello ${name},\n\nYour administrator has created access to KABOOM for you.\n\nSet your password: ${link}\n\nThis single-use link expires in one hour. Your email address is your sign-in name. Your assigned client and section permissions will apply when you sign in.\n\nIf you were not expecting this invitation, do not use the link and contact your administrator.`;

export async function welcomeRecipients(tenantId: number, ids: number[]): Promise<Recipient[]> {
  const result = await pool.query<Recipient>(
    `SELECT id, email, concat_ws(' ',first_name,last_name) AS name FROM users
     WHERE tenant_id=$1 AND id=ANY($2::int[]) ORDER BY id`, [tenantId, ids]);
  if (result.rows.length !== ids.length) throw new WelcomeEmailError(404, "One or more users are not in this workspace.");
  return result.rows;
}

export async function previewWelcomeEmails(tenantId: number, ids: number[]) {
  const recipients = await welcomeRecipients(tenantId, ids);
  return { recipients, subject, exampleText: emailText(recipients[0].name || "there",
    "[a secure, single-use password-setup link will be generated only when sending]") };
}

// No queue or retry runner: only an explicit, confirmed admin request can enter
// this function. Account creation and previewing never mint tokens or send mail.
export async function dispatchWelcomeEmails(tenantId: number, ids: number[], reviewed: { id: number; email: string }[]) {
  if (!welcomeSendingEnabled()) throw new WelcomeEmailError(409, "Welcome email sending is paused. No emails were sent.");
  const recipients = await welcomeRecipients(tenantId, ids);
  if (reviewed.length !== recipients.length || new Set(reviewed.map(r => r.id)).size !== recipients.length
    || recipients.some(user => !reviewed.some(r => r.id === user.id && r.email === user.email))) {
    throw new WelcomeEmailError(409, "The recipient addresses changed. Preview them again before sending.");
  }
  const config = await getMailConfig(tenantId);
  if (!config.fromEmail || (!config.apiKey && config.transport !== "connector")) {
    throw new WelcomeEmailError(409, "Configure Resend and its sender before sending.");
  }
  const prepared = recipients.map(user => {
    // Binding the opaque token to an immutable ID prevents reuse if an email
    // address is later assigned to a different user.
    const raw = `${user.id}.${randomBytes(32).toString("hex")}`;
    const url = new URL(`${welcomeBaseUrl()}/reset-password?welcome=1`);
    url.hash = `token=${raw}`; // Fragments do not reach HTTP/access logs.
    return { user, hash: welcomeTokenHash(raw), text: emailText(user.name || "there", url.href) };
  });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const locked = await client.query(
      "SELECT id,email FROM users WHERE tenant_id=$1 AND id=ANY($2::int[]) ORDER BY id FOR UPDATE", [tenantId, ids]);
    if (locked.rows.length !== prepared.length || locked.rows.some(row =>
      !prepared.some(item => item.user.id === row.id && item.user.email === row.email))) {
      throw new WelcomeEmailError(409, "The user list changed. Preview the recipients again.");
    }
    const recent = await client.query(
      `SELECT id FROM password_reset_tokens WHERE email=ANY($1::text[]) AND token LIKE 'welcome:%'
       AND created_at>now()-interval '1 minute' LIMIT 1`, [recipients.map(r => r.email)]);
    if (recent.rowCount) throw new WelcomeEmailError(409, "Please wait one minute before sending another setup link.");
    for (const item of prepared) {
      await client.query(`INSERT INTO password_reset_tokens(email,token,expires_at)
        VALUES($1,$2,now()+interval '1 hour')`, [item.user.email, item.hash]);
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally { client.release(); }

  const hashes = prepared.map(p => p.hash);
  try {
    const response = await requestResend(config, "/emails/batch", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": `welcome-${randomUUID()}` },
      body: JSON.stringify(prepared.map(item => ({
        from: `${config.fromName.replace(/[\r\n<>]/g, "")} <${config.fromEmail}>`,
        to: [item.user.email], subject, text: item.text,
      }))),
    });
    const result = await response.json() as { data?: { id: string }[] };
    if (!response.ok || result.data?.length !== prepared.length || result.data.some(r => !r.id)) {
      throw new Error("Provider acceptance was not confirmed");
    }
    // A replacement is valid only after the provider accepted it.
    await pool.query(`UPDATE password_reset_tokens SET used_at=now()
      WHERE email=ANY($1::text[]) AND token LIKE 'welcome:%' AND NOT(token=ANY($2::text[]))
      AND used_at IS NULL`, [recipients.map(r => r.email), hashes]);
    return { accepted: prepared.length };
  } catch {
    await pool.query("UPDATE password_reset_tokens SET used_at=now() WHERE token=ANY($1::text[])", [hashes]);
    throw new WelcomeEmailError(502, "Email acceptance was not confirmed. These setup links were invalidated; no automatic retry will run.");
  }
}

export async function redeemWelcomeToken(token: string, password: string) {
  const userId = Number(token.split(".")[0]);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Consistent user-before-token lock order across every password writer.
    await client.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [userId]);
    const { rows } = await client.query<{ id: number; email: string }>(
      `SELECT p.id,p.email FROM password_reset_tokens p JOIN users u ON u.email=p.email AND u.id=$2
       WHERE p.token=$1 AND p.used_at IS NULL AND p.expires_at>now() FOR UPDATE OF p,u`,
      [welcomeTokenHash(token), userId]);
    if (!rows[0]) throw new WelcomeEmailError(400, "Invalid, expired or already used setup link.");
    const passwordHash = await bcrypt.hash(password, 12);
    await client.query("UPDATE users SET password_hash=$1, must_change_password=false, temporary_password_expires_at=NULL, session_version=session_version+1 WHERE id=$2 AND email=$3", [passwordHash, userId, rows[0].email]);
    // Invalidate all outstanding setup/reset links for this user on success.
    await client.query("UPDATE password_reset_tokens SET used_at=now() WHERE email=$1 AND used_at IS NULL", [rows[0].email]);
    await client.query("COMMIT");
    return { ok: true };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally { client.release(); }
}
