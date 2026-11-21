import { Router, type IRouter } from "express";
import { z } from "zod";
import { pool } from "@workspace/db";
import { requireRole } from "../middlewares/requireAuth";
import { logger } from "../lib/logger";
import { sendEmail } from "../services/email";

// ── Abuse protection ───────────────────────────────────────────────────────────
//
// Two independent guards protect the unauthenticated POST route from being used
// as an email spam relay:
//
// 1. IP rate limit (in-memory) — at most IP_MAX_SUBMISSIONS per window per IP.
//    Uses ONLY the TCP socket address (req.socket.remoteAddress) so that
//    client-controlled X-Forwarded-For headers cannot bypass the limit.
//    Buckets are evicted after 2× the window to bound memory growth.
//
// 2. DB-backed per-email deduplication — one confirmation email per normalized
//    address per EMAIL_DEDUP_MIN window.  Because it reads from the database it
//    survives server restarts and works across multiple instances.  The email is
//    normalized to lowercase before the check so that case variants hit the same
//    bucket (per RFC 5321 the local part is technically case-sensitive but no
//    real provider treats it that way).

// NOTE: the socket IP is shared by MANY real users — the dev/preview proxy in
// this workspace, and venue WiFi NAT at a live event — so this must be sized
// for a whole audience behind one address, not a single visitor. 5/window
// locked out legitimate entrants once a few people (or tests) had submitted.
const IP_MAX_SUBMISSIONS = 100;             // max entries per IP per window
const IP_WINDOW_MS       = 15 * 60 * 1000; // 15 minutes
const IP_EVICT_MS        = 30 * 60 * 1000; // evict stale buckets after 30 min
const EMAIL_DEDUP_MIN    = 10;              // minutes between confirmation sends

interface IpBucket { count: number; windowStart: number }
const ipBuckets = new Map<string, IpBucket>();

/** Exposed only for test isolation — never call in production code. */
export function _resetIpBucketsForTesting(): void {
  ipBuckets.clear();
}

/**
 * Check and increment the per-IP submission counter.
 * Uses ONLY the socket-level remote address — not X-Forwarded-For — so
 * clients cannot forge a different IP by crafting the header.
 */
function checkIpRateLimit(socketIp: string): boolean {
  const now = Date.now();

  // Evict stale buckets before checking to bound map growth.
  if (ipBuckets.size > 50_000) {
    for (const [ip, b] of ipBuckets) {
      if (now - b.windowStart >= IP_EVICT_MS) ipBuckets.delete(ip);
    }
  }

  const bucket = ipBuckets.get(socketIp);
  if (!bucket || now - bucket.windowStart >= IP_WINDOW_MS) {
    ipBuckets.set(socketIp, { count: 1, windowStart: now });
    return true;
  }
  if (bucket.count >= IP_MAX_SUBMISSIONS) return false;
  bucket.count++;
  return true;
}

/**
 * Atomically claim the right to send a confirmation email to this address for
 * the current 10-minute window.  Uses INSERT … ON CONFLICT DO NOTHING so that
 * exactly one concurrent caller wins the claim; all others are suppressed.
 *
 * Returns true when this call wins the claim (email should be sent).
 * Returns false when another call already holds the claim (suppress the send).
 *
 * The email is lowercased before the DB write so case variants resolve to the
 * same claim row.  The window_bucket is a BIGINT epoch-divided by 600 so claims
 * automatically expire at the next window boundary.
 */
async function claimConfirmationSend(rawEmail: string): Promise<boolean> {
  try {
    const { rows } = await pool.query<{ email_normalized: string }>(
      `INSERT INTO contest_confirmation_claims (email_normalized, window_bucket)
       VALUES (LOWER($1), FLOOR(EXTRACT(EPOCH FROM NOW()) / $2)::bigint)
       ON CONFLICT DO NOTHING
       RETURNING email_normalized`,
      [rawEmail, String(EMAIL_DEDUP_MIN * 60)],
    );
    // Non-empty result → INSERT succeeded → this caller won the claim.
    return rows.length > 0;
  } catch (err) {
    // Fail-open: a DB error should not silently block the confirmation email.
    logger.warn({ err }, "contest email claim failed — allowing send");
    return true;
  }
}

// ── Scenario metadata for the confirmation email ──────────────────────────────

const SCENARIO_META: Record<string, {
  title: string;
  products: [string, string];
  taglines: [string, string];
}> = {
  airport: {
    title: "Busy Airport Lounge",
    products: ["HP Poly Focus 6", "Voyager Free 60"],
    taglines: [
      "Hybrid ANC engineered for focus in any environment",
      "Compact true-wireless for discreet mobile executives",
    ],
  },
  support: {
    title: "Noisy Customer Support Floor",
    products: ["Mission 800 USB", "EncorePro 700"],
    taglines: [
      "AI noise reduction built for the contact-centre floor",
      "All-day clarity and comfort for professional agents",
    ],
  },
  home: {
    title: "Two-Device Meeting at Home",
    products: ["Voyager 4300 UC", "HP Poly Focus 6"],
    taglines: [
      "Multi-device wireless for seamless home-to-office calls",
      "Hybrid ANC engineered for focus in any environment",
    ],
  },
};

function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function buildContestConfirmationEmail(opts: {
  name: string;
  scenario: string;
}): string {
  const scenarioKey = opts.scenario.toLowerCase();
  // Static SCENARIO_META values are trusted (hardcoded); user-supplied name and any
  // fallback scenario string must be escaped before interpolation into HTML.
  const meta = SCENARIO_META[scenarioKey] ?? {
    title: escapeHtml(opts.scenario),
    products: ["HP Poly Focus 6", "Voyager Free 60"] as [string, string],
    taglines: [
      "Hybrid ANC engineered for focus in any environment",
      "Compact true-wireless for discreet mobile executives",
    ] as [string, string],
  };
  // Escape the user-supplied name; only take the first word for the greeting.
  const firstName = escapeHtml(opts.name.split(" ")[0] ?? opts.name);

  return `<!DOCTYPE html>
<html lang="en" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<!--[if !mso]><!-->
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<!--<![endif]-->
<title>Your HP Poly entry is confirmed</title>
<style type="text/css">
  /* Reset */
  body, table, td, p, a { -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%; }
  table, td { mso-table-lspace: 0pt; mso-table-rspace: 0pt; border-collapse: collapse !important; }
  img { -ms-interpolation-mode: bicubic; border: 0; }

  /* Mobile: stack the two-column product cards */
  @media screen and (max-width: 600px) {
    .wrapper-table { width: 100% !important; }
    .content-cell  { padding-left: 20px !important; padding-right: 20px !important; }
    .product-col   {
      display: block !important;
      width: 100% !important;
      max-width: 100% !important;
      box-sizing: border-box;
    }
    .product-spacer { display: none !important; height: 0 !important; }
    /* Second card gets top margin when stacked; class used because the spacer
       td sits between them, making the + sibling selector unreliable. */
    .product-col-alt { margin-top: 12px !important; }
    .cta-btn { padding: 14px 20px !important; font-size: 14px !important; }
  }
</style>
<!--[if mso]>
<style type="text/css">
  /* Outlook-specific resets */
  .product-col { width: 48% !important; }
</style>
<![endif]-->
</head>
<body style="margin:0;padding:0;background:#f0f4f8;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">

<!-- Full-width outer wrapper -->
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
       style="background:#f0f4f8;">
  <tr>
    <td align="center" style="padding:32px 16px;">

      <!--[if mso]>
      <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="580"><tr><td>
      <![endif]-->
      <!-- Card table: fixed 580 px in Outlook via MSO comment; fluid via CSS elsewhere -->
      <table role="presentation" class="wrapper-table" cellpadding="0" cellspacing="0" border="0"
             style="max-width:580px;width:100%;background:#ffffff;border-radius:12px;">

        <!-- ═══ HEADER ════════════════════════════════════════════════════════════ -->
        <!--
          Gradient background technique:
          - bgcolor="#003087"  → solid-colour fallback for Outlook and legacy clients
          - background: linear-gradient(...)  → modern clients
          - VML v:rect below → Outlook-rendered gradient (rendered inside MSO conditionals)
        -->
        <tr>
          <td align="center" bgcolor="#003087"
              style="background:linear-gradient(135deg,#003087 0%,#0096D6 100%);border-radius:12px 12px 0 0;padding:0;">
            <!--[if mso]>
            <v:rect xmlns:v="urn:schemas-microsoft-com:vml" fill="true" stroke="false"
                    style="width:580px;">
              <v:fill type="gradient" color="#003087" color2="#0096D6" angle="135" focus="100%"/>
              <v:textbox style="mso-fit-shape-to-text:true" inset="0,0,0,0">
            <![endif]-->
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td align="center" style="padding:36px 40px 32px;">
                  <!-- rgba() replaced with solid hex equivalents for Outlook (Word engine ignores rgba).
                       #b3ccec ≈ rgba(255,255,255,0.70) blended on #003087.
                       #d9ebf7 ≈ rgba(255,255,255,0.85) blended on the gradient midpoint. -->
                  <p style="margin:0 0 12px;font-size:13px;font-weight:700;letter-spacing:3px;text-transform:uppercase;color:#b3ccec;mso-line-height-rule:exactly;">HP POLY</p>
                  <h1 style="margin:0 0 10px;font-size:26px;font-weight:800;color:#ffffff;line-height:1.25;mso-line-height-rule:exactly;">You&#8217;re in the draw! &#127911;</h1>
                  <p style="margin:0;font-size:15px;color:#d9ebf7;line-height:1.5;mso-line-height-rule:exactly;">The 2-Minute Meeting Rescue contest</p>
                </td>
              </tr>
            </table>
            <!--[if mso]>
              </v:textbox>
            </v:rect>
            <![endif]-->
          </td>
        </tr>

        <!-- ═══ GREETING ══════════════════════════════════════════════════════════ -->
        <tr>
          <td class="content-cell" style="padding:36px 40px 0;">
            <p style="margin:0 0 16px;font-size:16px;color:#1a202c;line-height:1.6;mso-line-height-rule:exactly;word-break:break-word;overflow-wrap:break-word;">Hi ${firstName},</p>
            <p style="margin:0 0 16px;font-size:15px;color:#4a5568;line-height:1.7;mso-line-height-rule:exactly;">
              Thanks for entering the <strong style="color:#003087;">HP Poly 2-Minute Meeting Rescue</strong> contest.
              Your entry has been received and you&#8217;re now in the prize draw.
            </p>
          </td>
        </tr>

        <!-- ═══ SCENARIO BADGE ════════════════════════════════════════════════════ -->
        <tr>
          <td class="content-cell" style="padding:24px 40px 0;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
                   style="background:#f7f9fc;border:1px solid #e2e8f0;">
              <tr>
                <td style="padding:16px 20px;">
                  <p style="margin:0 0 4px;font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:#0096D6;mso-line-height-rule:exactly;">Your Scenario</p>
                  <p style="margin:0;font-size:16px;font-weight:700;color:#1a202c;word-break:break-word;overflow-wrap:break-word;">${meta.title}</p>
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- ═══ RECOMMENDED PRODUCTS (two-column → stacked on mobile) ════════════ -->
        <tr>
          <td class="content-cell" style="padding:28px 40px 0;">
            <p style="margin:0 0 16px;font-size:13px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#718096;">Recommended for Your Workstyle</p>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <!-- Product 1 -->
                <td class="product-col" width="48%" valign="top"
                    style="background:#f7f9fc;border:1px solid #e2e8f0;padding:18px 16px;vertical-align:top;">
                  <p style="margin:0 0 4px;font-size:10px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:#0096D6;">TOP PICK</p>
                  <p style="margin:0 0 6px;font-size:15px;font-weight:800;color:#003087;word-break:break-word;overflow-wrap:break-word;">${meta.products[0]}</p>
                  <p style="margin:0;font-size:12px;color:#718096;line-height:1.5;">${meta.taglines[0]}</p>
                </td>
                <!-- Spacer column — hidden on mobile -->
                <td class="product-spacer" width="4%" style="font-size:0;line-height:0;">&nbsp;</td>
                <!-- Product 2 -->
                <td class="product-col product-col-alt" width="48%" valign="top"
                    style="background:#f7f9fc;border:1px solid #e2e8f0;padding:18px 16px;vertical-align:top;">
                  <p style="margin:0 0 4px;font-size:10px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:#6B46C1;">ALTERNATIVE</p>
                  <p style="margin:0 0 6px;font-size:15px;font-weight:800;color:#003087;word-break:break-word;overflow-wrap:break-word;">${meta.products[1]}</p>
                  <p style="margin:0;font-size:12px;color:#718096;line-height:1.5;">${meta.taglines[1]}</p>
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- ═══ PRIZE DRAW SUMMARY ════════════════════════════════════════════════ -->
        <tr>
          <td class="content-cell" style="padding:28px 40px 0;">
            <!--
              Same gradient technique as the header: bgcolor solid fallback + VML for Outlook.
            -->
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td bgcolor="#003087"
                    style="background:linear-gradient(135deg,#003087 0%,#0096D6 100%);padding:0;">
                  <!--[if mso]>
                  <v:rect xmlns:v="urn:schemas-microsoft-com:vml" fill="true" stroke="false"
                          style="width:500px;">
                    <v:fill type="gradient" color="#003087" color2="#0096D6" angle="135" focus="100%"/>
                    <v:textbox style="mso-fit-shape-to-text:true" inset="0,0,0,0">
                  <![endif]-->
                  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                    <tr>
                      <td style="padding:20px 24px;">
                        <p style="margin:0 0 8px;font-size:13px;font-weight:700;color:#ffffff;mso-line-height-rule:exactly;">&#127942; Prize Draw</p>
                        <p style="margin:0;font-size:14px;color:#ffffff;line-height:1.6;mso-line-height-rule:exactly;">
                          3 lucky winners will receive a complete HP Poly audio solution for their workplace.
                          The draw closes at the end of the campaign &#8212; we&#8217;ll contact the winner directly.
                        </p>
                      </td>
                    </tr>
                  </table>
                  <!--[if mso]>
                    </v:textbox>
                  </v:rect>
                  <![endif]-->
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- ═══ CTA ═══════════════════════════════════════════════════════════════ -->
        <tr>
          <td class="content-cell" style="padding:32px 40px 0;text-align:center;">
            <p style="margin:0 0 20px;font-size:15px;color:#4a5568;line-height:1.7;mso-line-height-rule:exactly;">
              Want to experience HP Poly audio before the draw? Book a free 30-minute demo and our team will show you the difference.
            </p>
            <!--
              CTA button: table-based for Outlook (MSO conditional) + inline-block link for
              other clients. Both render identically; the MSO version uses bgcolor for
              the button background since Outlook ignores background on <a>.
            -->
            <!--[if mso]>
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center">
              <tr>
                <!-- Padding on the td, not the a — Word engine ignores link padding -->
                <td bgcolor="#003087" style="border-radius:6px;padding:14px 32px;">
                  <a href="https://www.hp.com/us-en/poly/contact-us.html"
                     style="display:block;color:#ffffff;text-decoration:none;font-size:15px;font-weight:700;font-family:Arial,sans-serif;mso-line-height-rule:exactly;">
                    Book a Free Demo
                  </a>
                </td>
              </tr>
            </table>
            <![endif]-->
            <!--[if !mso]><!-->
            <a href="https://www.hp.com/us-en/poly/contact-us.html" class="cta-btn"
               style="display:inline-block;background:#003087;background:linear-gradient(135deg,#003087 0%,#0096D6 100%);color:#ffffff;text-decoration:none;font-size:15px;font-weight:700;padding:14px 32px;border-radius:6px;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
              Book a Free Demo
            </a>
            <!--<![endif]-->
          </td>
        </tr>

        <!-- ═══ FOOTER ════════════════════════════════════════════════════════════ -->
        <tr>
          <td class="content-cell" style="padding:36px 40px 32px;text-align:center;">
            <p style="margin:0;font-size:12px;color:#a0aec0;line-height:1.7;mso-line-height-rule:exactly;">
              This email confirms your contest entry. You received it because you submitted an entry at the HP Poly 2-Minute Meeting Rescue event.<br>
              &#169; HP Development Company, L.P. All rights reserved.
            </p>
          </td>
        </tr>

      </table>
      <!--[if mso]>
      </td></tr></table>
      <![endif]-->

    </td>
  </tr>
</table>
</body>
</html>`;
}

const router: IRouter = Router();

// ── Campaign deadline gate ─────────────────────────────────────────────────────
//
// Set CONTEST_END_DATE to an ISO-8601 timestamp (e.g. "2026-09-30T23:59:59Z")
// to close the contest at a specific moment.  If the env var is absent or
// unparseable, the gate is disabled and all submissions are accepted.
//
// Exposed as a function (rather than a module-level constant) so that tests
// can set/clear process.env.CONTEST_END_DATE between cases without needing
// a server restart.

export function isCampaignClosed(): boolean {
  const raw = process.env.CONTEST_END_DATE;
  if (!raw) return false;
  const deadline = new Date(raw);
  if (isNaN(deadline.getTime())) {
    logger.warn(
      { CONTEST_END_DATE: raw },
      "CONTEST_END_DATE is set but not a valid ISO date — campaign deadline gate disabled",
    );
    return false;
  }
  return Date.now() > deadline.getTime();
}

// ── Validation schema ──────────────────────────────────────────────────────────
const SubmitEntryBody = z.object({
  // Registration fields
  name:        z.string().min(1).max(200),
  org:         z.string().min(1).max(200),
  designation: z.string().max(200).optional().default(''),
  email:       z.string().email().max(320),
  // Gift form fields
  mobile:       z.string().min(1).max(50),
  currentBrand: z.string().max(100).optional().nullable(),
  demoInterest: z.enum(["yes", "no"]).optional().nullable(),
  marketingConsent: z.boolean().optional().default(false),
  // Contest data
  scenario:   z.string().min(1).max(50),
  // Up to 4 items: 2 Q1 challenge picks + optional "mobility:X" + optional "wearingStyle:X"
  challenges: z.array(z.string().max(50)).min(1).max(4),
  // UTM / tracking (optional)
  utmSource:   z.string().max(200).optional().nullable(),
  utmMedium:   z.string().max(200).optional().nullable(),
  utmCampaign: z.string().max(200).optional().nullable(),
  // Persona routing — constrained to the three valid values
  persona: z.enum(["executive", "itmanager", "none"]).optional().default("none"),
});

// ── POST /contest/entries — public (no auth required) ─────────────────────────
// Called by the contest page when the visitor submits their entry.
router.post("/contest/entries", async (req, res, next): Promise<void> => {
  // ── Campaign deadline gate ─────────────────────────────────────────────────
  // Checked before everything else so closed-campaign requests are rejected
  // immediately — no DB write, no email, no IP-bucket increment.
  if (isCampaignClosed()) {
    logger.info("contest entry rejected — campaign has ended");
    res.status(410).json({
      error: "This contest has ended. Thank you for your interest in HP Poly.",
    });
    return;
  }

  // ── IP rate limiting (socket address — not the spoofable XFF header) ────────
  const socketIp = req.socket.remoteAddress ?? "unknown";
  if (!checkIpRateLimit(socketIp)) {
    logger.warn({ ip: socketIp }, "contest entry rate-limited by IP");
    res.status(429).json({ error: "Too many submissions. Please try again later." });
    return;
  }

  const parsed = SubmitEntryBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid entry data", details: parsed.error.flatten() });
    return;
  }

  const {
    name, org, designation, email,
    mobile, currentBrand, demoInterest, marketingConsent,
    scenario, challenges,
    utmSource, utmMedium, utmCampaign,
    persona,
  } = parsed.data;

  try {
    const result = await pool.query<{ id: number; submitted_at: string }>(
      `INSERT INTO contest_entries
         (name, org, designation, email, mobile, current_brand, demo_interest,
          marketing_consent, scenario, challenges, utm_source, utm_medium, utm_campaign,
          persona)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING id, submitted_at`,
      [
        name, org, designation, email,
        mobile,
        currentBrand  ?? null,
        demoInterest  ?? null,
        marketingConsent ?? false,
        scenario,
        JSON.stringify(challenges),
        utmSource  ?? null,
        utmMedium  ?? null,
        utmCampaign ?? null,
        persona,
      ],
    );

    const row = result.rows[0];
    logger.info({ entryId: row.id, scenario, demoInterest }, "contest_entry_submitted");

    // ── Fire-and-forget confirmation email ────────────────────────────────────
    // Entry is already saved; an email failure must never affect the 201 response.
    // Atomic per-email claim: INSERT ... ON CONFLICT DO NOTHING ensures exactly
    // one concurrent caller wins the right to send per 10-minute window — even
    // across multiple server instances.
    void claimConfirmationSend(email).then(doSend => {
      if (!doSend) {
        logger.info({ entryId: row.id, to: email }, "contest confirmation email suppressed (dedup window)");
        return;
      }
      return sendEmail({
        to: email,
        fromName: "HP Poly",
        subject: "Your HP Poly 2-Minute Meeting Rescue entry is confirmed 🎧",
        html: buildContestConfirmationEmail({ name, scenario }),
        // Transactional contest email — carries its own context-appropriate footer;
        // do not append the standard KABOOM ABM-campaign unsubscribe footer.
        skipUnsubscribeFooter: true,
      }).then(sent => {
        if (!sent) {
          logger.warn({ entryId: row.id, to: email }, "contest confirmation email failed to send");
        } else {
          logger.info({ entryId: row.id, to: email }, "contest confirmation email sent");
        }
      });
    }).catch(err => {
      logger.error({ err, entryId: row.id, to: email }, "contest confirmation email threw");
    });

    res.status(201).json({ ok: true, id: row.id, submittedAt: row.submitted_at });
  } catch (err) {
    next(err);
  }
});

// ── Shared filter builder ──────────────────────────────────────────────────────
//
// Both the list and export endpoints accept the same filter params.
// Returns { filterParams, where } — params are numbered $1..$N, ready to be
// used as-is for the count/export query; the list query appends limit/offset
// at positions $N+1 and $N+2.

interface ContestFilters {
  scenario: string | null;
  demoInterest: string | null;
  persona: string | null;
  search: string | null;
}

function parseContestFilters(query: Record<string, unknown>): ContestFilters {
  return {
    scenario:     typeof query.scenario     === "string" && query.scenario     ? query.scenario.toLowerCase()     : null,
    demoInterest: typeof query.demoInterest === "string" && query.demoInterest ? query.demoInterest.toLowerCase() : null,
    persona:      typeof query.persona      === "string" && query.persona      ? query.persona.toLowerCase()      : null,
    search:       typeof query.search       === "string" && query.search       ? query.search.trim()              : null,
  };
}

function buildContestWhere(filters: ContestFilters): { where: string; filterParams: unknown[] } {
  const conditions: string[] = [];
  const filterParams: unknown[] = [];

  if (filters.scenario) {
    filterParams.push(filters.scenario);
    conditions.push(`LOWER(scenario) = $${filterParams.length}`);
  }
  if (filters.demoInterest === "yes" || filters.demoInterest === "no") {
    filterParams.push(filters.demoInterest);
    conditions.push(`demo_interest = $${filterParams.length}`);
  } else if (filters.demoInterest === "none") {
    conditions.push(`demo_interest IS NULL`);
  }
  if (filters.persona) {
    if (filters.persona === "none") {
      // Match entries with no persona set: either the literal 'none' value or NULL
      // (rows created before the persona column was populated may be NULL).
      conditions.push(`(persona IS NULL OR LOWER(persona) = 'none')`);
    } else {
      filterParams.push(filters.persona);
      conditions.push(`LOWER(persona) = $${filterParams.length}`);
    }
  }
  if (filters.search) {
    filterParams.push(`%${filters.search}%`);
    const p = `$${filterParams.length}`;
    conditions.push(
      `(name ILIKE ${p} OR org ILIKE ${p} OR email ILIKE ${p} OR designation ILIKE ${p})`,
    );
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  return { where, filterParams };
}

// ── Sanitize + quote a CSV cell ────────────────────────────────────────────────
// Neutralize spreadsheet-formula injection: prefix any value whose first
// character is =, +, -, @, TAB, or CR with a single-quote so Excel/Sheets
// treats it as text, then double-quote the whole cell.
function contestCsvCell(v: unknown): string {
  let s: string;
  if (v === null || v === undefined) {
    s = "";
  } else if (Array.isArray(v)) {
    s = v.join("; ");
  } else if (typeof v === "object") {
    s = JSON.stringify(v);
  } else {
    s = String(v);
  }
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return `"${safe.replace(/"/g, '""')}"`;
}

// ── GET /contest/entries/preview-email — admin only ──────────────────────────
// Returns the rendered HTML for the contest confirmation email so admins can
// review branding, copy, and layout before the campaign launches.
//
// Query params:
//   scenario  (required) — one of: airport | support | home
//   name      (optional) — personalise the greeting; defaults to "there"
router.get("/contest/entries/preview-email", requireRole("admin"), (req, res): void => {
  const VALID_SCENARIOS = new Set(["airport", "support", "home"]);
  const rawScenario = typeof req.query.scenario === "string" ? req.query.scenario.toLowerCase() : "";
  if (!rawScenario || !VALID_SCENARIOS.has(rawScenario)) {
    res.status(400).json({
      error: "Missing or invalid ?scenario= param. Must be one of: airport, support, home.",
    });
    return;
  }

  const name = typeof req.query.name === "string" && req.query.name.trim()
    ? req.query.name.trim()
    : "there";

  const html = buildContestConfirmationEmail({ name, scenario: rawScenario });
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(html);
});

// ── GET /contest/entries — admin only ─────────────────────────────────────────
// Returns entries (up to 1 000) with server-side filtering, newest-first.
router.get("/contest/entries", requireRole("admin"), async (req, res, next): Promise<void> => {
  try {
    const limit  = Math.min(Number(req.query.limit)  || 200, 1000);
    const offset = Math.max(Number(req.query.offset) || 0,   0);

    const filters = parseContestFilters(req.query as Record<string, unknown>);
    const { where, filterParams } = buildContestWhere(filters);

    // List query appends tenantId + limit/offset after filter params so their
    // placeholder numbers don't collide with the filter placeholders.
    const tenantId     = (req.user as { tenantId: number }).tenantId;
    const listParams   = [...filterParams, tenantId, limit, offset];
    const tenantPh     = `$${filterParams.length + 1}`;
    const limitPh      = `$${filterParams.length + 2}`;
    const offsetPh     = `$${filterParams.length + 3}`;

    const [result, countResult] = await Promise.all([
      pool.query(
        `SELECT ce.id, ce.name, ce.org, ce.designation, ce.email, ce.mobile,
                ce.current_brand, ce.demo_interest, ce.marketing_consent,
                ce.scenario, ce.challenges,
                ce.utm_source, ce.utm_medium, ce.utm_campaign,
                ce.persona, ce.submitted_at,
                c.id          AS contact_id,
                c.stage       AS contact_stage,
                c.lead_score  AS contact_lead_score,
                cv.visit_count   AS contest_page_visits,
                cv.first_visit_at,
                sr.stage_reached_at
         FROM contest_entries ce
         LEFT JOIN LATERAL (
           -- Tenant-scoped: without the tenant predicate an admin could see
           -- another tenant's contact id/stage/score when identifiers overlap.
           --
           -- Email is authoritative and normalized for legacy whitespace/case.
           -- Phone is only a fallback and is accepted when exactly one contact
           -- in this tenant has the same digits, preventing ambiguous linkage.
           WITH entry_keys AS (
             SELECT
               LOWER(BTRIM(COALESCE(ce.email, ''))) AS email_key,
               REGEXP_REPLACE(COALESCE(ce.mobile, ''), '[^0-9]', '', 'g') AS phone_key
           ),
           candidates AS (
             SELECT
               ct.id,
               ct.stage,
               ct.lead_score,
               (
                 ek.email_key <> ''
                 AND LOWER(BTRIM(COALESCE(ct.email, ''))) = ek.email_key
               ) AS email_match,
               (
                 ek.phone_key <> ''
                 AND REGEXP_REPLACE(COALESCE(ct.phone, ''), '[^0-9]', '', 'g') = ek.phone_key
               ) AS phone_match
             FROM contacts ct
             CROSS JOIN entry_keys ek
             WHERE ct.tenant_id = ${tenantPh}
           )
           SELECT id, stage, lead_score
           FROM candidates
           WHERE email_match
              OR (
                NOT EXISTS (SELECT 1 FROM candidates em WHERE em.email_match)
                AND phone_match
                AND (SELECT COUNT(*) FROM candidates pm WHERE pm.phone_match) = 1
              )
           ORDER BY email_match DESC, id ASC
           LIMIT 1
         ) c ON TRUE
         -- Count how many times this contact viewed the poly-contest journey page
         LEFT JOIN LATERAL (
           SELECT COUNT(*)::int        AS visit_count,
                  MIN(je.created_at)   AS first_visit_at
           FROM journey_events je
           JOIN journeys jj ON jj.id = je.journey_id
                            AND jj.slug = 'poly-contest'
                            AND jj.tenant_id = ${tenantPh}
           WHERE je.event_type  = 'page_view'
             AND je.tenant_id   = ${tenantPh}
             AND je.visitor_token IN (
               SELECT token FROM visitor_tokens
               WHERE contact_id = c.id AND tenant_id = ${tenantPh}
             )
         ) cv ON c.id IS NOT NULL
         -- When did this contact last reach their current stage?
         LEFT JOIN LATERAL (
           SELECT created_at AS stage_reached_at
           FROM contact_stage_history
           WHERE contact_id = c.id
             AND tenant_id  = ${tenantPh}
             AND to_stage   = c.stage
           ORDER BY created_at DESC
           LIMIT 1
         ) sr ON c.id IS NOT NULL
         ${where}
         ORDER BY ce.submitted_at DESC
         LIMIT ${limitPh} OFFSET ${offsetPh}`,
        listParams,
      ),
      pool.query<{ total: string }>(
        `SELECT COUNT(*) AS total FROM contest_entries ${where}`,
        filterParams,
      ),
    ]);

    res.json({
      entries: result.rows,
      total:   parseInt(countResult.rows[0]?.total ?? "0", 10),
      limit,
      offset,
    });
  } catch (err) {
    next(err);
  }
});

// ── GET /contest/entries/export — admin only, full CSV download ────────────────
// Exports ALL matching entries (no row cap) with the same filters as the list.
router.get("/contest/entries/export", requireRole("admin"), async (req, res, next): Promise<void> => {
  try {
    const filters = parseContestFilters(req.query as Record<string, unknown>);
    const { where, filterParams } = buildContestWhere(filters);

    const result = await pool.query(
      `SELECT id, name, org, designation, email, mobile,
              current_brand, demo_interest, marketing_consent,
              scenario, challenges,
              utm_source, utm_medium, utm_campaign,
              persona, submitted_at
       FROM contest_entries
       ${where}
       ORDER BY submitted_at DESC`,
      filterParams,
    );

    const HEADERS = [
      "id","name","org","designation","email","mobile",
      "scenario","challenges","demo_interest","current_brand","marketing_consent",
      "utm_source","utm_medium","utm_campaign","persona","submitted_at",
    ];

    const rows = result.rows.map(r => {
      let challenges = r.challenges;
      if (typeof challenges === "string") {
        try { challenges = JSON.parse(challenges); } catch { /* leave as-is */ }
      }
      return [
        r.id, r.name, r.org, r.designation, r.email, r.mobile,
        r.scenario, Array.isArray(challenges) ? challenges.join("; ") : challenges,
        r.demo_interest, r.current_brand, r.marketing_consent,
        r.utm_source, r.utm_medium, r.utm_campaign,
        r.persona,
        r.submitted_at ? new Date(r.submitted_at).toISOString() : "",
      ].map(contestCsvCell).join(",");
    });

    const csv      = [HEADERS.join(","), ...rows].join("\r\n");
    const filename = `contest-entries-${new Date().toISOString().slice(0, 10)}.csv`;
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(csv);
  } catch (err) {
    next(err);
  }
});

export default router;
