import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = join(__dirname, "templates");

export const BUILT_IN_TEMPLATES = [
  {
    slug: "clean-outreach",
    name: "Clean Outreach",
    category: "Outreach",
    description: "Minimal, text-heavy cold email with a single clear CTA",
    variables: ["firstName","companyName","journeyUrl","senderName","senderTitle","senderEmail","unsubscribeUrl"],
    defaultSubject: "Quick question about {{companyName}}'s go-to-market",
  },
  {
    slug: "content-spotlight",
    name: "Content Spotlight",
    category: "Nurture",
    description: "Feature a resource or asset with a hero gradient and stats strip",
    variables: ["firstName","companyName","contentTitle","contentTeaser","journeyUrl","senderName","senderTitle","unsubscribeUrl"],
    defaultSubject: "{{firstName}}, this was built for you",
  },
  {
    slug: "personal-followup",
    name: "Personal Follow-up",
    category: "Follow-up",
    description: "Conversational follow-up with a pull-quote to re-engage",
    variables: ["firstName","companyName","playName","quoteText","journeyUrl","senderName","senderTitle","senderEmail","unsubscribeUrl"],
    defaultSubject: "Did you get a chance to review this, {{firstName}}?",
  },
  {
    slug: "event-webinar-invite",
    name: "Event / Webinar Invite",
    category: "Event",
    description: "Dark-hero invitation email for webinars and live events",
    variables: ["firstName","companyName","eventTitle","eventDescription","eventDate","eventTime","eventDuration","agendaItems","journeyUrl","senderName","senderTitle","unsubscribeUrl"],
    defaultSubject: "You're invited: {{eventTitle}}",
  },
  {
    slug: "reengagement-winback",
    name: "Re-engagement / Win-back",
    category: "Re-engagement",
    description: "Re-activate lapsed contacts with a friendly \'we missed you\' message",
    variables: ["firstName","companyName","playName","updateItem","journeyUrl","senderName","senderTitle","unsubscribeUrl"],
    defaultSubject: "{{firstName}}, we haven't heard from you in a while",
  },
] as const;

export type BuiltInTemplateSlug = (typeof BUILT_IN_TEMPLATES)[number]["slug"];

/**
 * Load raw HTML for a built-in template slug.
 */
export function loadTemplateHtml(slug: string): string {
  const filePath = join(TEMPLATES_DIR, `${slug}.html`);
  try {
    return readFileSync(filePath, "utf-8");
  } catch {
    throw new Error(`Template file not found: ${slug}.html`);
  }
}

/**
 * Replace all {{variable}} tokens in an HTML string.
 * Supports dot-notation paths and array iteration for simple {{#each}} blocks.
 */
export function renderTemplate(html: string, vars: Record<string, unknown>): string {
  // Handle {{#each arrayVar}} ... {{this}} ... {{/each}}
  html = html.replace(
    /\{\{#each\s+(\w+)\}\}([\s\S]*?)\{\{\/each\}\}/g,
    (_match, key: string, block: string) => {
      const arr = vars[key];
      if (!Array.isArray(arr)) return "";
      return arr.map((item: unknown) =>
        block.replace(/\{\{this\}\}/g, String(item))
      ).join("");
    }
  );

  // Replace {{key}} and {{key|fallback}} tokens
  return html.replace(/\{\{(\w+(?:\.\w+)*)(?:\|([^}]*))?\}\}/g, (_match, key: string, fallback: string | undefined) => {
    const val = key.split(".").reduce((o: unknown, k: string) => {
      if (o && typeof o === "object") return (o as Record<string, unknown>)[k];
      return undefined;
    }, vars as unknown);
    if (val === undefined || val === null) return fallback ?? "";
    return String(val);
  });
}

/**
 * Convert an HTML email to readable plain text.
 * Strips all tags, preserves link text (with URL in parentheses),
 * decodes common HTML entities, and normalises whitespace.
 */
export function htmlToPlainText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<a\s[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, url, text) => {
      const t = text.replace(/<[^>]+>/g, "").trim();
      return url && url !== "#" ? `${t} (${url})` : t;
    })
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/tr>/gi, "\n")
    .replace(/<\/th>|<\/td>/gi, "  ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&rarr;/gi, "→")
    .replace(/&mdash;/gi, "—")
    .replace(/&ndash;/gi, "–")
    .replace(/&#\d+;/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/ {2,}/g, " ")
    .trim();
}

/**
 * Full pipeline: load template HTML by slug, render with vars, return rendered HTML + plain text.
 */
export function renderBuiltInTemplate(
  slug: string,
  vars: Record<string, unknown>
): { html: string; text: string; subject: string } {
  const meta = BUILT_IN_TEMPLATES.find(t => t.slug === slug);
  if (!meta) throw new Error(`Unknown template slug: ${slug}`);

  const rawHtml = loadTemplateHtml(slug);
  const html = renderTemplate(rawHtml, vars);
  const subject = renderTemplate(
    (vars.subject as string | undefined) ?? meta.defaultSubject,
    vars
  );
  return { html, text: htmlToPlainText(html), subject };
}

/**
 * Render a raw HTML body (custom template, not a built-in slug) with vars.
 */
export function renderCustomTemplate(
  bodyHtml: string,
  subjectTemplate: string,
  vars: Record<string, unknown>
): { html: string; text: string; subject: string } {
  const html = renderTemplate(bodyHtml, vars);
  const subject = renderTemplate(subjectTemplate, vars);
  return { html, text: htmlToPlainText(html), subject };
}
