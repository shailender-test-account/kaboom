/**
 * Bot detection for email tracking endpoints.
 *
 * Corporate email security gateways (Microsoft Safe Links, Proofpoint,
 * Mimecast, Barracuda) automatically follow every URL in every email within
 * seconds of delivery.  We detect them using three signals:
 *
 * 1. Timing  — request arrives within BOT_TIMING_WINDOW_SEC of send time
 * 2. IP CIDR — known scanner IP ranges
 * 3. User-Agent — known scanner UA substrings
 *
 * A request is flagged as a bot when ANY signal fires.
 */
import type { Request } from "express";

// Pixel opens: scanners fire within 1–5 s; 15 s catches them without penalising
// a push-notification open. Applies to tracking pixels only.
const BOT_TIMING_WINDOW_SEC = 15;

// Click redirects: Safe Links / Proofpoint / Mimecast pre-scan links within
// 15 s–2 min of delivery. 300 s (5 min) catches the full scanner window while
// still passing real users who click minutes-to-hours after opening.
// In a bulk sequence context the probability that a real human clicks within
// 5 minutes of a sequence email landing is extremely low — scanner behaviour
// dominates that window across all major corporate gateways.
export const CLICK_BOT_TIMING_WINDOW_SEC = 300;

// Known corporate email scanner CIDR ranges.
// Each entry: [baseIp as 32-bit uint, maskBits]
const BOT_CIDRS: Array<[number, number]> = [
  // Microsoft Safe Links
  [ipToInt("40.94.0.0"),    16],
  [ipToInt("52.0.0.0"),      8],
  [ipToInt("57.128.0.0"),    9],
  [ipToInt("104.40.0.0"),   14],
  // Proofpoint
  [ipToInt("148.163.0.0"),  16],
  [ipToInt("67.231.144.0"), 20],
  // Mimecast
  [ipToInt("91.220.40.0"),  22],
  [ipToInt("195.130.217.0"),24],
  // Barracuda
  [ipToInt("209.222.80.0"), 21],
  // Generic Microsoft cloud scanners
  [ipToInt("20.0.0.0"),      8],
  [ipToInt("13.64.0.0"),    11],
];

// Known scanner User-Agent substrings (case-insensitive)
//
// googleimageproxy / googlebot — Gmail pre-fetches every image through Google's
// proxy the moment an email arrives in the inbox (before the user opens it).
// The cached image is served on actual open, so no second request reaches us.
// Flagging these as bot prevents inflated open rates from proxy pre-fetches.
//
// apple-mail-privacy / icloud-privacy — iOS 15+ Mail Privacy Protection routes
// all image loads through Apple's relay servers (17.0.0.0/8) to hide user IPs.
// Pre-fetching happens at delivery, not at real open time — same effect as Gmail.
const BOT_UA_SUBSTRINGS = [
  "mimecast", "barracuda", "proofpoint", "mailscanner",
  "msexch", "safebrowsing", "outlook-link-preview",
  "emailsecuri", "linkchecker", "mail-safety",
  // Google Image Proxy (Gmail mobile & desktop pre-fetch)
  "googleimageproxy", "googlebot", "google-read-aloud",
  // Apple Mail Privacy Protection relay
  "icloud-privacy", "apple-mail-privacy",
];

function ipToInt(ip: string): number {
  const parts = ip.split(".").map(Number);
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function isInCidr(ip: string, [base, bits]: [number, number]): boolean {
  try {
    const ipInt = ipToInt(ip);
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (ipInt & mask) === (base & mask);
  } catch {
    return false;
  }
}

function extractIp(req: Request): string | null {
  const forwarded = req.headers["x-forwarded-for"];
  if (forwarded) {
    const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded).split(",")[0].trim();
    if (first) return first;
  }
  return req.ip ?? req.socket?.remoteAddress ?? null;
}

export interface BotClassification {
  isBot: boolean;
  reason: string | null;
}

export interface UAParsed {
  emailClient: string;
  deviceType: "desktop" | "mobile" | "tablet" | "unknown";
  os: string;
}

/**
 * Parse a real (non-bot) User-Agent string into email client, device type, and OS.
 * Called only after classifyRequest returns isBot=false.
 */
export function parseUserAgent(ua: string): UAParsed {
  const s = ua.toLowerCase();

  // ── Email client detection ────────────────────────────────────────────────
  let emailClient = "Unknown";
  if (s.includes("googleimageproxy") || s.includes("gmail") || s.includes("google")) {
    emailClient = "Gmail";
  } else if (
    s.includes("applemail") ||
    s.includes("apple mail") ||
    (s.includes("darwin") && /\bmail\/\d/.test(s))
  ) {
    emailClient = "Apple Mail";
  } else if (s.includes("microsoft outlook") || s.includes("msoffice") || s.includes("outlook")) {
    emailClient = "Outlook";
  } else if (s.includes("yahoo")) {
    emailClient = "Yahoo Mail";
  } else if (s.includes("thunderbird")) {
    emailClient = "Thunderbird";
  } else if (s.includes("samsung")) {
    emailClient = "Samsung Mail";
  } else if (s.includes("hey.com") || s.includes("hey/")) {
    emailClient = "HEY";
  } else if (s.includes("superhuman")) {
    emailClient = "Superhuman";
  } else if (s.includes("spark")) {
    emailClient = "Spark";
  } else if (s.includes("mozilla") || s.includes("webkit") || s.includes("chrome") || s.includes("safari")) {
    emailClient = "Web Browser";
  }

  // ── Device type ──────────────────────────────────────────────────────────
  let deviceType: "desktop" | "mobile" | "tablet" | "unknown" = "unknown";
  if (s.includes("ipad") || (s.includes("tablet") && !s.includes("iphone"))) {
    deviceType = "tablet";
  } else if (
    s.includes("mobile") ||
    s.includes("iphone") ||
    (s.includes("android") && !s.includes("tablet"))
  ) {
    deviceType = "mobile";
  } else if (
    s.includes("windows") ||
    s.includes("macintosh") ||
    s.includes("linux") ||
    s.includes("x11") ||
    s.includes("darwin")
  ) {
    deviceType = "desktop";
  }

  // ── OS ───────────────────────────────────────────────────────────────────
  let os = "Unknown";
  if (s.includes("iphone") || (s.includes("ipad") && s.includes("cpu os"))) {
    os = "iOS";
  } else if (s.includes("android")) {
    os = "Android";
  } else if (s.includes("macintosh") || s.includes("mac os x")) {
    os = "macOS";
  } else if (s.includes("darwin")) {
    os = "macOS";
  } else if (s.includes("windows")) {
    os = "Windows";
  } else if (s.includes("linux") || s.includes("x11")) {
    os = "Linux";
  }

  return { emailClient, deviceType, os };
}

export function classifyRequest(
  req: Request,
  sentAtSec?: number | null,
  /** Override the timing window. Defaults to BOT_TIMING_WINDOW_SEC (15 s).
   *  Pass CLICK_BOT_TIMING_WINDOW_SEC (300 s) for click-redirect routes. */
  timingWindowSec?: number,
): BotClassification {
  // 1. Timing check
  if (sentAtSec && sentAtSec > 0) {
    const window = timingWindowSec ?? BOT_TIMING_WINDOW_SEC;
    const elapsedSec = Math.floor(Date.now() / 1000) - sentAtSec;
    if (elapsedSec >= 0 && elapsedSec < window) {
      return { isBot: true, reason: `timing:${elapsedSec}s` };
    }
  }

  // 2. IP CIDR check
  const ip = extractIp(req);
  if (ip) {
    for (const cidr of BOT_CIDRS) {
      if (isInCidr(ip, cidr)) {
        return { isBot: true, reason: `ip_cidr:${ip}` };
      }
    }
  }

  // 3. User-Agent check
  const ua = (req.headers["user-agent"] ?? "").toLowerCase();
  if (!ua) {
    return { isBot: true, reason: "ua:empty" };
  }
  for (const substr of BOT_UA_SUBSTRINGS) {
    if (ua.includes(substr)) {
      return { isBot: true, reason: `ua:${substr}` };
    }
  }

  return { isBot: false, reason: null };
}
