import { createHmac, timingSafeEqual } from "crypto";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { logger } from "../lib/logger";
import { getMailConfig, requestResend } from "./resendTransport";
export { invalidateTenantEmailCache } from "./resendTransport";

const HMAC_SECRET = process.env.SESSION_SECRET ?? "dev-secret";

function getBaseUrl(): string {
  if (process.env.BASE_URL) return process.env.BASE_URL;
  const domains = (process.env.REPLIT_DOMAINS ?? "")
    .split(",").map(d => d.trim()).filter(Boolean);
  // Prefer a custom domain (not a *.repl.co / *.replit.app Replit subdomain) so that
  // links and image URLs in emails resolve to the user-facing custom domain.
  const custom = domains.find(
    d => !d.endsWith(".repl.co") && !d.endsWith(".replit.app") && !d.endsWith(".replit.dev")
  );
  return `https://${custom ?? domains[0] ?? "localhost"}`;
}

export function generateUnsubscribeToken(email: string): string {
  return createHmac("sha256", HMAC_SECRET).update(email.toLowerCase()).digest("hex");
}

// ── Email click-tracking tokens ───────────────────────────────────────────────
// Encodes contact identity in the URL *path* (not query params) so corporate
// email security proxies (Safe Links, Proofpoint, etc.) cannot strip it.
// Format (v3): base64url(contactId:tenantId:slug:exp:sentAt:templateId).hmac-hex
// Format (v2): base64url(contactId:tenantId:slug:exp:sentAt).hmac-hex  ← backward compat
// Format (v1): base64url(contactId:tenantId:slug:exp).hmac-hex        ← backward compat
// TTL: 7 days (recipients may delay clicking)
//
// v3 adds templateId so the click redirect route can write a proper per-step
// email_events row (event_type='clicked', template_id=X). Without this, clicks could
// only ever be recorded as a generic activity_events row with no way to attribute them
// to a specific sequence step — the run report had to crudely dump ALL click activity
// onto step 1, which is wrong for any sequence with more than one email step.

const CLICK_TOKEN_TTL_SEC = 60 * 60 * 24 * 7;

export interface ClickTokenPayload {
  contactId: number;
  tenantId: number;
  slug: string;
  /** Unix seconds when the email was sent (for bot timing detection). Null for v1 tokens. */
  sentAtSec: number | null;
  /** Template that was sent when this link was generated. Null for v1/v2 tokens. */
  templateId: number | null;
}

export function generateClickToken(
  contactId: number,
  tenantId: number,
  slug: string,
  /** Unix seconds when the email was sent. Defaults to now. */
  sentAtSec?: number,
  /** Template id of the email this link was embedded in — enables per-step click attribution. */
  templateId?: number | null,
): string {
  const exp = Math.floor(Date.now() / 1000) + CLICK_TOKEN_TTL_SEC;
  const sa  = sentAtSec ?? Math.floor(Date.now() / 1000);
  // v3 format: 6 colon-delimited fields (slugs are URL-safe, no colons)
  const tid = templateId ?? 0;
  const payload = `${contactId}:${tenantId}:${slug}:${exp}:${sa}:${tid}`;
  const encoded = Buffer.from(payload).toString("base64url");
  const sig = createHmac("sha256", HMAC_SECRET).update(encoded).digest("hex");
  return `${encoded}.${sig}`;
}

export function verifyClickToken(token: string): ClickTokenPayload | null {
  try {
    const dotIdx = token.lastIndexOf(".");
    if (dotIdx === -1) return null;
    const encoded = token.slice(0, dotIdx);
    const sig = token.slice(dotIdx + 1);
    const expectedSig = createHmac("sha256", HMAC_SECRET).update(encoded).digest("hex");
    if (expectedSig !== sig) return null;
    const payload = Buffer.from(encoded, "base64url").toString("utf8");
    // Split on all colons. Slugs are URL-safe (no colons), so field count determines version.
    const parts = payload.split(":");
    if (parts.length < 4) return null;
    const contactId = parseInt(parts[0], 10);
    const tenantId  = parseInt(parts[1], 10);
    if (isNaN(contactId) || isNaN(tenantId)) return null;

    let slug: string, exp: number, sentAtSec: number | null, templateId: number | null;
    if (parts.length >= 6) {
      // v3: contactId:tenantId:slug:exp:sentAt:templateId
      slug = parts.slice(2, parts.length - 3).join(":");
      exp  = parseInt(parts[parts.length - 3], 10);
      sentAtSec = parseInt(parts[parts.length - 2], 10);
      if (isNaN(sentAtSec)) sentAtSec = null;
      const parsedTid = parseInt(parts[parts.length - 1], 10);
      templateId = (!isNaN(parsedTid) && parsedTid > 0) ? parsedTid : null;
    } else if (parts.length >= 5) {
      // v2: contactId:tenantId:slug:exp:sentAt
      slug = parts.slice(2, parts.length - 2).join(":");
      exp  = parseInt(parts[parts.length - 2], 10);
      sentAtSec = parseInt(parts[parts.length - 1], 10);
      if (isNaN(sentAtSec)) sentAtSec = null;
      templateId = null;
    } else {
      // v1 (backward compat): contactId:tenantId:slug:exp
      slug = parts.slice(2, parts.length - 1).join(":");
      exp  = parseInt(parts[parts.length - 1], 10);
      sentAtSec = null;
      templateId = null;
    }
    if (isNaN(exp)) return null;
    if (Date.now() / 1000 > exp) return null;
    return { contactId, tenantId, slug, sentAtSec, templateId };
  } catch {
    return null;
  }
}

// ── Honeypot token ────────────────────────────────────────────────────────────
// Invisible link injected into every email. If a scanner or bot follows it,
// we flag future events for that contact+send as bot traffic.

// Honeypot token v2 format: hp2:contactId:tenantId:enrollmentId:exp
// enrollmentId=0 means unknown (backward compat).
export function generateHoneypotToken(contactId: number, tenantId: number, enrollmentId = 0): string {
  const exp = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30; // 30 days
  const payload = `hp2:${contactId}:${tenantId}:${enrollmentId}:${exp}`;
  const encoded = Buffer.from(payload).toString("base64url");
  const sig = createHmac("sha256", HMAC_SECRET).update(encoded).digest("hex");
  return `${encoded}.${sig}`;
}

export function verifyHoneypotToken(token: string): { contactId: number; tenantId: number; enrollmentId: number } | null {
  try {
    const dotIdx = token.lastIndexOf(".");
    if (dotIdx === -1) return null;
    const encoded = token.slice(0, dotIdx);
    const sig = token.slice(dotIdx + 1);
    const expectedSig = createHmac("sha256", HMAC_SECRET).update(encoded).digest("hex");
    if (expectedSig !== sig) return null;
    const payload = Buffer.from(encoded, "base64url").toString("utf8");
    const parts = payload.split(":");
    // v2: hp2:contactId:tenantId:enrollmentId:exp (5 parts)
    // v1 legacy: hp:contactId:tenantId:exp (4 parts) — still accepted, enrollmentId defaults to 0
    if (parts[0] === "hp2" && parts.length === 5) {
      const contactId    = parseInt(parts[1], 10);
      const tenantId     = parseInt(parts[2], 10);
      const enrollmentId = parseInt(parts[3], 10);
      const exp          = parseInt(parts[4], 10);
      if (isNaN(contactId) || isNaN(tenantId) || isNaN(exp)) return null;
      if (Date.now() / 1000 > exp) return null;
      return { contactId, tenantId, enrollmentId };
    }
    if (parts[0] === "hp" && parts.length === 4) {
      const contactId = parseInt(parts[1], 10);
      const tenantId  = parseInt(parts[2], 10);
      const exp       = parseInt(parts[3], 10);
      if (isNaN(contactId) || isNaN(tenantId) || isNaN(exp)) return null;
      if (Date.now() / 1000 > exp) return null;
      return { contactId, tenantId, enrollmentId: 0 };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Injects an invisible honeypot link just before </body>.
 * enrollmentId is encoded into the token so a honeypot hit permanently flags
 * that specific send (contact + enrollment) as bot in bot_sessions.
 */
export function injectHoneypotLink(
  html: string,
  contactId: number,
  tenantId: number,
  baseUrl: string,
  enrollmentId = 0,
): string {
  const token = generateHoneypotToken(contactId, tenantId, enrollmentId);
  const url = `${baseUrl}/api/public/honeypot/${token}`;
  const link = `<a href="${url}" style="display:none;font-size:0;line-height:0;color:transparent;visibility:hidden;" tabindex="-1" aria-hidden="true"> </a>`;
  if (html.includes("</body>")) return html.replace("</body>", link + "</body>");
  return html + link;
}

export function verifyUnsubscribeToken(email: string, token: string): boolean {
  return generateUnsubscribeToken(email) === token;
}

// ── Form preview link tokens ──────────────────────────────────────────────────

const PREVIEW_TOKEN_TTL_SEC = 60 * 60 * 24; // 24 hours

/**
 * Generates a time-limited HMAC token for unauthenticated access to the
 * confirmation-email preview for a specific form.
 * Format: <base64url(formId:tenantId:exp)>.<hmac-hex>
 */
export function generateFormPreviewToken(formId: number, tenantId: number): string {
  const exp = Math.floor(Date.now() / 1000) + PREVIEW_TOKEN_TTL_SEC;
  const payload = `${formId}:${tenantId}:${exp}`;
  const encoded = Buffer.from(payload).toString("base64url");
  const sig = createHmac("sha256", HMAC_SECRET).update(encoded).digest("hex");
  return `${encoded}.${sig}`;
}

/**
 * Verifies a preview token.  Returns the tenantId on success, or null on failure.
 */
export function verifyFormPreviewToken(formId: number, token: string): number | null {
  try {
    const dotIdx = token.lastIndexOf(".");
    if (dotIdx === -1) return null;
    const encoded = token.slice(0, dotIdx);
    const sig = token.slice(dotIdx + 1);

    const expectedSig = createHmac("sha256", HMAC_SECRET).update(encoded).digest();
    const actualSig = Buffer.from(sig, "hex");
    if (expectedSig.length !== actualSig.length || !timingSafeEqual(expectedSig, actualSig)) return null;

    const payload = Buffer.from(encoded, "base64url").toString("utf8");
    const parts = payload.split(":");
    if (parts.length !== 3) return null;

    const [fid, tid, expStr] = parts;
    const exp = parseInt(expStr, 10);
    if (isNaN(exp) || Date.now() / 1000 > exp) return null;
    if (parseInt(fid, 10) !== formId) return null;

    return parseInt(tid, 10);
  } catch {
    return null;
  }
}

/**
 * Post-process rendered email HTML to inject contact-identity tracking into
 * every /j/<slug> URL found in href attributes.
 *
 * When opts (tenantId + baseUrl) are provided the link is replaced with a
 * server-side click-redirect URL:
 *   /api/public/click/<token>
 * The token encodes contact identity in the URL *path* so corporate email
 * security proxies (Safe Links, Proofpoint) cannot strip it.  The server
 * decodes the token, sets a cookie, then redirects to the journey.
 *
 * When opts are absent (legacy / test callers) we fall back to query params.
 * URLs that already contain /api/public/click/ or cid= are left untouched.
 */
// ── External click token ──────────────────────────────────────────────────────
// Used to wrap non-journey links in sequence emails through KABOOM's own
// click-tracking redirect so Path A fires for ALL links, not just /j/ ones.
// Format (inner payload before outer base64url): ext1:<contactId>:<tenantId>:<exp>:<tid>:<destB64>
// destB64 is the destination URL encoded as base64url (no colons in output).

const EXT_CLICK_TOKEN_TTL_SEC = 60 * 60 * 24 * 30; // 30 days

// Token format ext2: ext2:<contactId>:<tenantId>:<exp>:<templateId>:<enrollmentId>:<destB64>
// destB64 = base64url(destinationUrl) — base64url contains no colons so split(":") is safe.
// enrollmentId=0 means unknown (no enrollment context).

export function generateExternalClickToken(
  contactId: number,
  tenantId: number,
  destinationUrl: string,
  templateId?: number | null,
  enrollmentId?: number | null,
): string {
  const exp  = Math.floor(Date.now() / 1000) + EXT_CLICK_TOKEN_TTL_SEC;
  const tid  = templateId   ?? 0;
  const eid  = enrollmentId ?? 0;
  const dest = Buffer.from(destinationUrl).toString("base64url");
  const payload = `ext2:${contactId}:${tenantId}:${exp}:${tid}:${eid}:${dest}`;
  const encoded = Buffer.from(payload).toString("base64url");
  const sig = createHmac("sha256", HMAC_SECRET).update(encoded).digest("hex");
  return `${encoded}.${sig}`;
}

export function verifyExternalClickToken(token: string): {
  contactId: number; tenantId: number; destinationUrl: string;
  templateId: number | null; enrollmentId: number | null;
  sentAtSec: number;
} | null {
  try {
    const dotIdx = token.lastIndexOf(".");
    if (dotIdx === -1) return null;
    const encoded = token.slice(0, dotIdx);
    const sig = token.slice(dotIdx + 1);
    const expectedSig = createHmac("sha256", HMAC_SECRET).update(encoded).digest("hex");
    if (expectedSig !== sig) return null;
    const payload = Buffer.from(encoded, "base64url").toString("utf8");
    const parts = payload.split(":");
    if (parts.length !== 7 || parts[0] !== "ext2") return null;
    const contactId    = parseInt(parts[1], 10);
    const tenantId     = parseInt(parts[2], 10);
    const exp          = parseInt(parts[3], 10);
    const parsedTid    = parseInt(parts[4], 10);
    const parsedEid    = parseInt(parts[5], 10);
    const templateId   = (!isNaN(parsedTid) && parsedTid > 0) ? parsedTid   : null;
    const enrollmentId = (!isNaN(parsedEid) && parsedEid > 0) ? parsedEid   : null;
    const destB64      = parts[6];
    if (isNaN(contactId) || isNaN(tenantId) || isNaN(exp)) return null;
    if (Date.now() / 1000 > exp) return null;
    const destinationUrl = Buffer.from(destB64, "base64url").toString("utf8");
    if (!destinationUrl) return null;
    // Derive sentAtSec from exp — token was created at (exp - TTL).
    // Used by classifyRequest to separate pre-scan bot clicks (arrive within seconds
    // of send) from real user clicks proxied through Safe Links (arrive much later).
    const sentAtSec = exp - EXT_CLICK_TOKEN_TTL_SEC;
    return { contactId, tenantId, destinationUrl, templateId, enrollmentId, sentAtSec };
  } catch {
    return null;
  }
}

export function injectJourneyTrackingLinks(
  html: string,
  contactId: number,
  contactEmail: string,
  opts?: { tenantId: number; baseUrl: string; templateId?: number | null },
): string {
  if (!html) return html;
  return html.replace(
    /href="([^"]*\/j\/([^/"?#]+)[^"]*)"/g,
    (match, url: string, slug: string) => {
      if (url.includes("/api/public/click/")) return match; // already a click URL
      if (url.includes("cid=")) return match;               // already has tracking
      if (opts) {
        const token = generateClickToken(contactId, opts.tenantId, slug, undefined, opts.templateId ?? null);
        return `href="${opts.baseUrl}/api/public/click/${token}"`;
      }
      // Fallback: query params (used when tenantId/baseUrl are unavailable)
      const sep = url.includes("?") ? "&" : "?";
      const params = new URLSearchParams({
        cid: String(contactId),
        utm_source: "email",
        contact: contactEmail,
      });
      return `href="${url}${sep}${params.toString()}"`;
    },
  );
}

/**
 * Wraps ALL anchor links in the rendered email HTML through KABOOM's own
 * click-tracking redirect, ensuring Path A fires for every click regardless
 * of whether Resend's own click tracking is active.
 *
 * - /j/<slug> links → /api/public/click/<token>  (journey click-redirect)
 * - other http/https links → /api/public/click-ext/<token>  (external click-redirect)
 * - mailto: / unsubscribe / already-wrapped links → left untouched
 */
export function injectAllEmailTrackingLinks(
  html: string,
  contactId: number,
  opts: {
    tenantId: number;
    baseUrl: string;
    templateId?: number | null;
    enrollmentId?: number | null;
    /**
     * Optional set of journey slugs that are known to exist in this tenant.
     * When provided, any /j/<slug> link whose slug is NOT in this set is routed
     * through the external click token (preserving the original destination URL)
     * rather than a journey click token that would silently fall back to / if the
     * journey has since been deleted.
     * When omitted, slug validation is skipped and all /j/ links get a journey
     * click token (the click redirect handler will return a 404 page for dead slugs).
     */
    knownSlugs?: Set<string>;
  },
): string {
  if (!html) return html;
  return html.replace(
    /href="([^"]+)"/g,
    (match, url: string) => {
      // Skip already-wrapped, mailto, unsubscribe, and anchor-only links
      if (url.includes("/api/public/click")) return match;
      if (url.includes("cid=")) return match;
      if (url.startsWith("mailto:")) return match;
      if (url.startsWith("#")) return match;
      if (url.includes("/unsubscribe")) return match;
      if (url.includes("/honeypot/")) return match;

      // Resolve protocol-relative (//example.com) and server-relative (/path) URLs
      // to absolute URLs so they can be embedded in a click-tracking token.
      let absoluteUrl = url;
      if (url.startsWith("//")) {
        absoluteUrl = `https:${url}`;
      } else if (url.startsWith("/") && opts.baseUrl) {
        absoluteUrl = `${opts.baseUrl}${url}`;
      }

      // Journey links: /j/<slug> — use the existing click token (redirects to /j/<slug>)
      const journeyMatch = absoluteUrl.match(/\/j\/([^/"?#]+)/);
      if (journeyMatch) {
        // Guard: if the URL is absolute and its domain differs from our own baseUrl, the
        // slug belongs to a foreign system and may not exist in this tenant's journeys.
        // Routing through a journey click token would cause the redirect to silently
        // land on "/" instead of the intended page.  Use the external click token instead
        // so the original URL is preserved and the click is still tracked.
        if (absoluteUrl.startsWith("http://") || absoluteUrl.startsWith("https://")) {
          try {
            const linkOrigin = new URL(absoluteUrl).origin;
            const baseOrigin = opts.baseUrl ? new URL(opts.baseUrl).origin : null;
            if (baseOrigin && linkOrigin !== baseOrigin) {
              logger.warn(
                { url: absoluteUrl, slug: journeyMatch[1], tenantId: opts.tenantId },
                "injectAllEmailTrackingLinks: absolute /j/ URL with unrecognized domain — routing through external click token to preserve original destination"
              );
              const extToken = generateExternalClickToken(
                contactId, opts.tenantId, absoluteUrl,
                opts.templateId ?? null, opts.enrollmentId ?? null,
              );
              return `href="${opts.baseUrl}/api/public/click-ext/${extToken}"`;
            }
          } catch {
            // URL parsing failed — fall through to journey token (best effort)
          }
        }
        const slug = journeyMatch[1];
        // Guard: if the caller supplied a knownSlugs set and this slug is not in it,
        // the journey has likely been deleted. Route through the external click token
        // so the original /j/<slug> URL is preserved in the token payload — at least
        // the click is tracked and the redirect is explicit rather than silent.
        if (opts.knownSlugs && !opts.knownSlugs.has(slug)) {
          logger.warn(
            { url: absoluteUrl, slug, tenantId: opts.tenantId },
            "injectAllEmailTrackingLinks: /j/ slug not in knownSlugs set — routing through external click token"
          );
          const extToken = generateExternalClickToken(
            contactId, opts.tenantId, absoluteUrl,
            opts.templateId ?? null, opts.enrollmentId ?? null,
          );
          return `href="${opts.baseUrl}/api/public/click-ext/${extToken}"`;
        }
        const token = generateClickToken(contactId, opts.tenantId, slug, undefined, opts.templateId ?? null);
        return `href="${opts.baseUrl}/api/public/click/${token}"`;
      }

      // Absolute http(s) links (including resolved protocol-relative and server-relative)
      if (absoluteUrl.startsWith("http://") || absoluteUrl.startsWith("https://")) {
        const token = generateExternalClickToken(
          contactId, opts.tenantId, absoluteUrl,
          opts.templateId ?? null, opts.enrollmentId ?? null,
        );
        return `href="${opts.baseUrl}/api/public/click-ext/${token}"`;
      }

      // Anything else (data:, javascript:, etc.) — leave untouched
      return match;
    },
  );
}

export function buildUnsubscribeFooter(toEmail: string): string {
  const token = generateUnsubscribeToken(toEmail);
  const url = `${getBaseUrl()}/api/unsubscribe?email=${encodeURIComponent(toEmail)}&token=${token}`;
  return `
<div style="margin-top:40px;padding-top:16px;border-top:1px solid #e5e7eb;text-align:center;font-size:12px;color:#9ca3af;">
  <p>You received this email because you are part of an ABM campaign.</p>
  <p><a href="${url}" style="color:#6366f1;">Unsubscribe</a></p>
</div>`;
}

export interface EmailAttachment {
  filename: string;
  content: Buffer;
}

export interface SendEmailOptions {
  to: string;
  subject: string;
  html: string;
  text?: string;
  tags?: { name: string; value: string }[];
  tenantId?: number;
  contactId?: number;
  templateId?: number;
  enrollmentId?: number;
  attachments?: EmailAttachment[];
  fromEmail?: string | null;
  fromName?: string | null;
  /**
   * When true, the standard KABOOM "ABM campaign" unsubscribe footer is NOT
   * appended.  Use for transactional emails (e.g. contest confirmations) that
   * carry their own context-appropriate footer.
   */
  skipUnsubscribeFooter?: boolean;
}

function injectTrackingPixel(html: string, opts: SendEmailOptions): string {
  if (!opts.tenantId || !opts.contactId) return html;
  const base = getBaseUrl();
  const params = new URLSearchParams({
    cid:  String(opts.contactId),
    tid:  String(opts.tenantId),
    // sa = sent-at unix seconds; used by bot detection for timing checks
    sa:   String(Math.floor(Date.now() / 1000)),
    ...(opts.templateId   ? { tmpl: String(opts.templateId)   } : {}),
    ...(opts.enrollmentId ? { enr:  String(opts.enrollmentId) } : {}),
  });
  const pixelUrl = `${base}/api/track/open?${params.toString()}`;
  const pixel = `<img src="${pixelUrl}" width="1" height="1" style="display:none;border:0;width:1px;height:1px;" alt="" />`;
  if (html.includes("</body>")) return html.replace("</body>", pixel + "</body>");
  return html + pixel;
}

/**
 * Replace relative src/href paths (starting with /) with absolute URLs.
 * Required so email clients can load images/assets that are served from our
 * app — email clients cannot resolve relative URLs.
 */
function makeAbsoluteUrls(html: string): string {
  const base = getBaseUrl();
  // Replace src="/..." and href="/..." (but not href="https://..." etc.)
  return html
    .replace(/\bsrc="(\/[^"]+)"/gi, `src="${base}$1"`)
    .replace(/\bhref="(\/[^"]+)"/gi, (_, path) => `href="${base}${path}"`);
}

export interface SmtpCredentials {
  host: string;
  port: number;
  username: string;
  password: string;
  useTls: boolean;
  fromEmail: string;
  fromName: string;
}

/**
 * Send an email via a pre-warmed SMTP account (Google Workspace, M365, etc.).
 * Bypasses Resend entirely — useful for sequences that need to avoid bulk-ESP
 * filtering by enterprise email security gateways.
 */
export async function sendEmailViaSMTP(
  opts: SendEmailOptions,
  smtp: SmtpCredentials,
): Promise<boolean> {
  const absoluteHtml = makeAbsoluteUrls(opts.html);
  const htmlWithPixel = injectTrackingPixel(absoluteHtml, opts);
  const fullHtml = opts.skipUnsubscribeFooter
    ? htmlWithPixel
    : htmlWithPixel + buildUnsubscribeFooter(opts.to);

  const fromName  = opts.fromName  || smtp.fromName  || "KABOOM";
  const fromEmail = opts.fromEmail || smtp.fromEmail;

  try {
    const nodemailer = require("nodemailer");
    const transporter = nodemailer.createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.useTls && smtp.port === 465,
      requireTLS: smtp.useTls && smtp.port !== 465,
      auth: { user: smtp.username, pass: smtp.password },
    });
    await transporter.sendMail({
      from: `${fromName} <${fromEmail}>`,
      to: opts.to,
      subject: opts.subject,
      html: fullHtml,
      text: opts.text,
    });
    return true;
  } catch (err) {
    logger.error({ err, to: opts.to }, "SMTP send failed");
    return false;
  }
}

export async function sendEmail(opts: SendEmailOptions): Promise<boolean> {
  const absoluteHtml = makeAbsoluteUrls(opts.html);
  const htmlWithPixel = injectTrackingPixel(absoluteHtml, opts);
  const fullHtml = opts.skipUnsubscribeFooter
    ? htmlWithPixel
    : htmlWithPixel + buildUnsubscribeFooter(opts.to);

  try {
    const config = await getMailConfig(opts.tenantId);
    if ((!config.apiKey && config.transport !== "connector") || (!opts.fromEmail && !config.fromEmail)) {
      logger.error("Email was not sent: Resend or the sender is not configured");
      return false;
    }
    const fromEmail = opts.fromEmail || config.fromEmail;
    const fromName = opts.fromName || config.fromName;
    const attachments = opts.attachments?.map(a => ({
      filename: a.filename,
      content: a.content.toString("base64"),
    }));

    const response = await requestResend(config, "/emails", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
      from: `${fromName} <${fromEmail}>`,
      to: [opts.to],
      subject: opts.subject,
      html: fullHtml,
      text: opts.text,
      tags: opts.tags,
      ...(attachments && attachments.length > 0 ? { attachments } : {}),
      }),
    });
    const result = await response.json() as { id?: string };
    if (!response.ok || !result.id) {
      logger.error({ status: response.status }, "Resend did not confirm email acceptance");
      return false;
    }
    return true;
  } catch (err) {
    // Provider/connector errors can include request headers or message bodies.
    logger.error("Failed to send email; provider acceptance was not confirmed");
    return false;
  }
}

export function renderTemplate(html: string, vars: Record<string, string>): string {
  return html.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? `{{${key}}}`);
}

export interface ConfirmationEmailTokens {
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  formName: string;
  thankYouTitle?: string;
  thankYouBody?: string;
}

export interface ConfirmationEmailParts {
  subject: string;
  bodyHtml: string;
}

/**
 * Builds the subject line and inner body HTML for a confirmation email.
 * Used by both the test-send endpoint and the full-preview endpoint so that
 * both paths always produce identical output.
 */
export function buildConfirmationEmailParts(opts: {
  rawSubjectSrc: string;
  rawBodySrc: string;
  tokens: ConfirmationEmailTokens;
  deliveryAssetId?: number | null;
}): ConfirmationEmailParts {
  const { rawSubjectSrc, rawBodySrc, tokens, deliveryAssetId } = opts;

  function resolveTokens(text: string): string {
    return text.replace(/\{\{(\w+)(?:\|([^}]*))?\}\}/g, (_: string, key: string, fallback?: string) => {
      const value = (tokens as unknown as Record<string, string | undefined>)[key] ?? "";
      return value || (fallback ?? "");
    });
  }

  const rawSubject = rawSubjectSrc.trim() || `${tokens.formName}: submission confirmed`;
  const rawBody = rawBodySrc.trim() ||
    `Hi {{firstName|there}},\n\nThank you for submitting <strong>${tokens.formName}</strong>. We'll be in touch shortly.`;

  const subject = resolveTokens(rawSubject);
  const bodyResolved = resolveTokens(rawBody);
  const htmlBody = bodyResolved.includes("<") ? bodyResolved : bodyResolved.replace(/\n/g, "<br/>");

  let downloadSection = "";
  if (deliveryAssetId) {
    downloadSection = `
<div style="margin-top:24px;padding:16px;background:#f0f4ff;border-radius:8px;text-align:center;">
  <p style="margin:0 0 12px;font-size:14px;color:#374151;">Your file is ready to download:</p>
  <a href="#" style="display:inline-block;padding:10px 20px;background:#4f46e5;color:#fff;border-radius:6px;text-decoration:none;font-size:14px;font-weight:600;">Download your file</a>
  <p style="margin:8px 0 0;font-size:11px;color:#9ca3af;">Link expires in 1 hour</p>
</div>`;
  }

  const bodyHtml = `
<div style="font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;padding:32px 24px;color:#111827;">
  ${htmlBody}
  ${downloadSection}
</div>`;

  return { subject, bodyHtml };
}
