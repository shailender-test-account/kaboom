import { Router, type IRouter } from "express";
import { and, eq, desc, sql } from "drizzle-orm";
import { db, emailTemplatesTable, contactsTable } from "@workspace/db";
import { requireAuth } from "../middlewares/requireAuth";
import { z } from "zod";
import multer from "multer";
import AdmZip from "adm-zip";
import { BUILT_IN_TEMPLATES, loadTemplateHtml, renderTemplate, htmlToPlainText } from "../lib/email/templateRenderer";
import { sendEmail, injectJourneyTrackingLinks } from "../services/email";
import { ObjectStorageService } from "../lib/objectStorage";

const router: IRouter = Router();
router.use(requireAuth);

const zipUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB zip cap
});

const CreateBody = z.object({
  name: z.string().min(1),
  category: z.string().default("Outreach"),
  subject: z.string().min(1),
  bodyHtml: z.string().default(""),
  bodyText: z.string().default(""),
  variables: z.array(z.string()).default([]),
  blocksJson: z.unknown().optional(),
});
const UpdateBody = CreateBody.partial();

// ── Collection ────────────────────────────────────────────────────────────────

router.get("/templates", async (req, res, next): Promise<void> => {
  try {
    const user = req.user as any;
    const templates = await db.select().from(emailTemplatesTable)
      .where(eq(emailTemplatesTable.tenantId, user.tenantId))
      .orderBy(desc(emailTemplatesTable.createdAt));
    res.json(templates);
  } catch (err) { next(err); }
});

router.post("/templates", async (req, res, next): Promise<void> => {
  const parsed = CreateBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  try {
    const user = req.user as any;
    const { blocksJson, ...rest } = parsed.data;
    const [tpl] = await db.insert(emailTemplatesTable)
      .values({
        ...rest,
        tenantId: user.tenantId,
        variables: rest.variables,
        blocksJson: blocksJson !== undefined ? (blocksJson as any) : null,
      })
      .returning();
    res.status(201).json(tpl);
  } catch (err) { next(err); }
});

// ── POST /templates/import-zip ────────────────────────────────────────────────
// Upload a zipped HTML mailer (HTML file + images). Extracts the HTML, uploads
// every image to object storage, rewrites all image references in the HTML to
// their storage URLs, and creates a new template with everything intact.
// SVG deliberately excluded: it can carry executable script and is served
// same-origin by /storage/objects/* — a stored-XSS vector.
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|ico)$/i;
const MIME_BY_EXT: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  webp: "image/webp", bmp: "image/bmp", ico: "image/x-icon",
};

// Decompression-bomb guards
const MAX_ENTRIES = 200;
const MAX_IMAGES = 60;
const MAX_ENTRY_BYTES = 10 * 1024 * 1024;   // 10 MB per file, uncompressed
const MAX_TOTAL_BYTES = 60 * 1024 * 1024;   // 60 MB total, uncompressed

router.post("/templates/import-zip", zipUpload.single("file"), async (req, res, next): Promise<void> => {
  try {
    const user = req.user as any;
    if (!req.file) { res.status(400).json({ error: "No file uploaded. Send the zip as multipart field 'file'." }); return; }

    let zip: AdmZip;
    try { zip = new AdmZip(req.file.buffer); }
    catch { res.status(400).json({ error: "Invalid zip file" }); return; }

    const entries = zip.getEntries().filter(e => !e.isDirectory && !e.entryName.startsWith("__MACOSX/") && !e.name.startsWith("."));

    // ── Decompression-bomb guards (checked against zip headers, before any getData) ──
    if (entries.length > MAX_ENTRIES) {
      res.status(400).json({ error: `Zip has too many files (max ${MAX_ENTRIES})` }); return;
    }
    let totalUncompressed = 0;
    for (const e of entries) {
      const sz = e.header.size; // declared uncompressed size
      if (sz > MAX_ENTRY_BYTES) {
        res.status(400).json({ error: `"${e.entryName}" is too large (max 10 MB per file)` }); return;
      }
      totalUncompressed += sz;
    }
    if (totalUncompressed > MAX_TOTAL_BYTES) {
      res.status(400).json({ error: "Zip contents too large (max 60 MB uncompressed)" }); return;
    }

    // Locate the HTML file: prefer index.html, else the first .html/.htm
    const htmlEntries = entries.filter(e => /\.html?$/i.test(e.entryName));
    if (htmlEntries.length === 0) {
      res.status(400).json({ error: "No HTML file found in the zip" }); return;
    }
    const htmlEntry =
      htmlEntries.find(e => /(^|\/)index\.html?$/i.test(e.entryName)) ?? htmlEntries[0];
    let html = htmlEntry.getData().toString("utf-8");

    // Upload each image to object storage and build a lookup of
    // zip-path → serving URL (plus a basename fallback for loose references).
    const storage = new ObjectStorageService();
    const imageEntries = entries.filter(e => IMAGE_EXT_RE.test(e.entryName));
    const byPath = new Map<string, string>();   // full zip path → url
    const byBasename = new Map<string, string>(); // filename only → url

    for (const img of imageEntries) {
      const data = img.getData();
      const ext = img.entryName.split(".").pop()!.toLowerCase();
      const contentType = MIME_BY_EXT[ext] ?? "application/octet-stream";

      const uploadURL = await storage.getObjectEntityUploadURL();
      const putRes = await fetch(uploadURL, {
        method: "PUT",
        headers: { "Content-Type": contentType },
        body: new Uint8Array(data),
      });
      if (!putRes.ok) {
        req.log?.error({ status: putRes.status, entry: img.entryName }, "import-zip: image upload failed");
        res.status(502).json({ error: `Failed to upload image "${img.entryName}" to storage` });
        return;
      }
      const objectPath = storage.normalizeObjectEntityPath(uploadURL);
      const servingUrl = `/api/storage/objects/${objectPath.replace(/^\/objects\//, "")}`;
      byPath.set(img.entryName, servingUrl);
      const base = img.entryName.split("/").pop()!;
      if (!byBasename.has(base)) byBasename.set(base, servingUrl);

      // Register in the media library so the asset is visible/reusable
      await db.execute(sql`
        INSERT INTO media_assets (tenant_id, name, object_path, mime_type, file_size)
        VALUES (${user.tenantId}, ${base}, ${objectPath}, ${contentType}, ${data.length})
      `);
    }

    // Rewrite references. Handles src="...", href="..." (image links),
    // background="..." and CSS url(...) — matched against the zip path with any
    // leading ./ or path prefix, falling back to basename match.
    const resolveRef = (ref: string): string | null => {
      const clean = ref.replace(/^\.\//, "").replace(/^\//, "").split(/[?#]/)[0];
      if (byPath.has(clean)) return byPath.get(clean)!;
      // try progressively shorter suffixes (e.g. "images/logo.png" when zip has "mailer/images/logo.png")
      for (const [p, url] of byPath) if (p.endsWith("/" + clean)) return url;
      const base = clean.split("/").pop()!;
      return byBasename.get(base) ?? null;
    };

    html = html
      // src / href / background attributes (skip absolute http(s), data:, cid:)
      .replace(/(\b(?:src|href|background)\s*=\s*["'])(?!https?:|data:|cid:|\/\/|#|mailto:)([^"']+)(["'])/gi,
        (m, pre, ref, post) => {
          const url = resolveRef(ref);
          return url ? pre + url + post : m;
        })
      // CSS url(...) in inline styles / <style> blocks
      .replace(/url\(\s*(['"]?)(?!https?:|data:|\/\/)([^'")]+)\1\s*\)/gi,
        (m, q, ref) => {
          const url = resolveRef(ref);
          return url ? `url(${q}${url}${q})` : m;
        })
      // srcset attributes: rewrite each candidate URL, keep descriptors
      .replace(/(\bsrcset\s*=\s*["'])([^"']+)(["'])/gi,
        (m, pre, list, post) => {
          const rewritten = list.split(",").map((part: string) => {
            const seg = part.trim();
            if (!seg) return seg;
            const [ref, ...desc] = seg.split(/\s+/);
            if (/^(https?:|data:|\/\/)/i.test(ref)) return seg;
            const url = resolveRef(ref);
            return url ? [url, ...desc].join(" ") : seg;
          }).join(", ");
          return pre + rewritten + post;
        });

    // Derive name & subject
    const zipName = (req.file.originalname ?? "Imported mailer").replace(/\.zip$/i, "");
    const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
    const subject = (titleMatch?.[1] ?? "").trim() || zipName;

    const [tpl] = await db.insert(emailTemplatesTable)
      .values({
        tenantId: user.tenantId,
        name: zipName,
        category: "Outreach",
        subject,
        bodyHtml: html,
        bodyText: htmlToPlainText(html),
        variables: [],
        blocksJson: null, // raw-HTML template: opens in Code mode, not the block editor
      })
      .returning();

    res.status(201).json({ ...tpl, imagesImported: imageEntries.length });
  } catch (err) { next(err); }
});

// ── Built-in templates (must come BEFORE /:id routes) ─────────────────────────

router.get("/templates/built-in", (_req, res): void => {
  res.json(BUILT_IN_TEMPLATES.map(t => ({
    slug: t.slug, name: t.name, category: t.category,
    description: t.description, variables: t.variables, defaultSubject: t.defaultSubject,
  })));
});

router.get("/templates/built-in/:slug/preview", (req, res, next): void => {
  try {
    const { slug } = req.params;
    const vars: Record<string, unknown> = {
      firstName: "Alex", lastName: "Smith", companyName: "Acme Corp",
      journeyUrl: "#", playName: "Q3 ABM Launch",
      senderName: "Jordan Lee", senderTitle: "Account Executive",
      senderEmail: "jordan@acme.agency", unsubscribeUrl: "#",
      contentTitle: "The ABM Playbook 2025",
      contentTeaser: "Everything you need to run high-converting ABM at scale.",
      quoteText: "3× pipeline growth in 90 days — no extra headcount needed.",
      eventTitle: "ABM Mastery Live",
      eventDescription: "A 45-minute deep-dive into modern account-based marketing.",
      eventDate: "Thursday, June 12 2025", eventTime: "2:00 PM EST", eventDuration: "45 min",
      agendaItems: ["How to build and prioritise your target account list", "Live play-by-play of a 6-figure ABM campaign", "Q&A with our ABM strategists"],
      updateItem: "Fresh benchmark data for 2025 B2B outreach",
    };
    const html = renderTemplate(loadTemplateHtml(slug), vars);
    // Prevent any script execution when this HTML is loaded in a browser context
    res.setHeader("Content-Security-Policy", "script-src 'none'; object-src 'none';");
    res.type("html").send(html);
  } catch (err) { next(err); }
});

router.post("/templates/built-in/:slug/import", async (req, res, next): Promise<void> => {
  try {
    const user = req.user as any;
    const { slug } = req.params;
    const meta = BUILT_IN_TEMPLATES.find(t => t.slug === slug);
    if (!meta) { res.status(404).json({ error: "Unknown template slug" }); return; }
    const bodyHtml = loadTemplateHtml(slug);
    const bodyText = htmlToPlainText(bodyHtml);
    const [tpl] = await db.insert(emailTemplatesTable).values({
      tenantId: user.tenantId, name: meta.name, category: meta.category,
      subject: meta.defaultSubject, bodyHtml, bodyText, variables: [...meta.variables],
    }).returning();
    res.status(201).json(tpl);
  } catch (err) { next(err); }
});

// ── Single-template CRUD ──────────────────────────────────────────────────────

router.get("/templates/:id", async (req, res, next): Promise<void> => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  try {
    const user = req.user as any;
    const [tpl] = await db.select().from(emailTemplatesTable).where(eq(emailTemplatesTable.id, id));
    if (!tpl || tpl.tenantId !== user.tenantId) { res.status(404).json({ error: "Not found" }); return; }
    res.json(tpl);
  } catch (err) { next(err); }
});

router.patch("/templates/:id", async (req, res, next): Promise<void> => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const parsed = UpdateBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  try {
    const user = req.user as any;
    const [existing] = await db.select().from(emailTemplatesTable).where(eq(emailTemplatesTable.id, id));
    if (!existing || existing.tenantId !== user.tenantId) { res.status(404).json({ error: "Not found" }); return; }
    const { blocksJson, ...rest } = parsed.data;
    const updatePayload: Record<string, unknown> = { ...rest };
    if (blocksJson !== undefined) updatePayload.blocksJson = blocksJson as any;
    const [tpl] = await db.update(emailTemplatesTable)
      .set(updatePayload as any)
      .where(eq(emailTemplatesTable.id, id))
      .returning();
    res.json(tpl);
  } catch (err) { next(err); }
});

router.delete("/templates/:id", async (req, res, next): Promise<void> => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  try {
    const user = req.user as any;
    const [existing] = await db.select().from(emailTemplatesTable).where(eq(emailTemplatesTable.id, id));
    if (!existing || existing.tenantId !== user.tenantId) { res.status(404).json({ error: "Not found" }); return; }
    await db.delete(emailTemplatesTable).where(eq(emailTemplatesTable.id, id));
    res.sendStatus(204);
  } catch (err) { next(err); }
});

// ── Duplicate ─────────────────────────────────────────────────────────────────

router.post("/templates/:id/duplicate", async (req, res, next): Promise<void> => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  try {
    const user = req.user as any;
    const [original] = await db.select().from(emailTemplatesTable).where(eq(emailTemplatesTable.id, id));
    if (!original || original.tenantId !== user.tenantId) { res.status(404).json({ error: "Not found" }); return; }
    const [copy] = await db.insert(emailTemplatesTable).values({
      tenantId: user.tenantId,
      name: `${original.name} (Copy)`,
      category: original.category,
      subject: original.subject,
      bodyHtml: original.bodyHtml,
      bodyText: original.bodyText,
      variables: (original.variables as string[]) ?? [],
      blocksJson: original.blocksJson as any,
    }).returning();
    res.status(201).json(copy);
  } catch (err) { next(err); }
});

// ── Preview + send-test ───────────────────────────────────────────────────────

const SAMPLE_VARS: Record<string, unknown> = {
  firstName: "Alex", lastName: "Smith", companyName: "Acme Corp",
  journeyUrl: "#", playName: "Q3 ABM Launch",
  senderName: "Jordan Lee", senderTitle: "Account Executive",
  senderEmail: "jordan@acme.agency", unsubscribeUrl: "#",
  contentTitle: "The ABM Playbook 2025",
  contentTeaser: "Everything you need to run high-converting ABM at scale.",
  contentUrl: "#",
  quoteText: "3× pipeline growth in 90 days — no extra headcount needed.",
  eventTitle: "ABM Mastery Live",
  eventDescription: "A 45-minute deep-dive into modern account-based marketing.",
  eventDate: "Thursday, June 12 2025", eventTime: "2:00 PM EST", eventDuration: "45 min",
  agendaItems: [
    "How to build and prioritise your target account list",
    "Live play-by-play of a 6-figure ABM campaign",
    "Q&A with our ABM strategists",
  ],
  registrationUrl: "#",
  updateItem: "Fresh benchmark data for 2025 B2B outreach",
};

async function resolveVars(base: Record<string, unknown>, body: any, tenantId: number): Promise<Record<string, unknown>> {
  const vars = { ...base };
  const contactId = body?.contactId ? parseInt(body.contactId) : null;
  if (contactId && !isNaN(contactId)) {
    const [contact] = await db.select().from(contactsTable).where(eq(contactsTable.id, contactId));
    if (contact && contact.tenantId === tenantId) {
      vars.firstName = contact.firstName ?? "";
      vars.lastName = contact.lastName ?? "";
      vars.companyName = (body?.companyName as string | undefined)
        ?? contact.email?.split("@")[1]?.split(".")[0]
        ?? "Your Company";
    }
  }
  return vars;
}

router.post("/templates/:id/preview", async (req, res, next): Promise<void> => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  try {
    const user = req.user as any;
    const [tpl] = await db.select().from(emailTemplatesTable).where(eq(emailTemplatesTable.id, id));
    if (!tpl || tpl.tenantId !== user.tenantId) { res.status(404).json({ error: "Not found" }); return; }
    const vars = await resolveVars(SAMPLE_VARS, req.body, user.tenantId);
    // Prevent any script execution in the preview — templates may contain
    // untrusted HTML (e.g. imported mailer zips with <script> or event handlers)
    res.setHeader("Content-Security-Policy", "script-src 'none'; object-src 'none';");
    res.type("html").send(renderTemplate(tpl.bodyHtml, vars));
  } catch (err) { next(err); }
});

router.post("/templates/:id/send-test", async (req, res, next): Promise<void> => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  try {
    const user = req.user as any;
    const [tpl] = await db.select().from(emailTemplatesTable).where(eq(emailTemplatesTable.id, id));
    if (!tpl || tpl.tenantId !== user.tenantId) { res.status(404).json({ error: "Not found" }); return; }
    const base: Record<string, unknown> = {
      ...SAMPLE_VARS,
      firstName: user.firstName ?? "There", lastName: user.lastName ?? "",
      companyName: "Your Company",
      senderName: `${user.firstName ?? ""} ${user.lastName ?? ""}`.trim() || "KABOOM",
      senderEmail: user.email,
    };
    const vars = await resolveVars(base, req.body, user.tenantId);
    const html = renderTemplate(tpl.bodyHtml, vars);
    const subject = renderTemplate(tpl.subject, vars);

    // Support sending to up to 5 custom recipients; fallback to current user
    const rawEmails: unknown = req.body.emails;
    const recipients: string[] = Array.isArray(rawEmails)
      ? (rawEmails as string[]).map(e => String(e).trim()).filter(e => e.includes("@")).slice(0, 5)
      : [];
    if (recipients.length === 0) recipients.push(user.email as string);

    // Base URL for click-tracking redirect links (same pattern as sequence worker)
    const domains = (process.env.REPLIT_DOMAINS ?? "").split(",");
    const baseUrl = process.env.BASE_URL ?? (domains[0] ? `https://${domains[0]}` : "");

    const results = await Promise.all(
      recipients.map(async (to) => {
        // Look up the recipient as a contact so we can inject real per-contact
        // click-tracking tokens (the /api/public/click/:token redirect path).
        // Without this, every /j/slug link in the email is a plain link that
        // bypasses the click handler entirely — clicks never reach activity_events.
        const contacts = await db.select({ id: contactsTable.id })
          .from(contactsTable)
          .where(and(eq(contactsTable.tenantId, user.tenantId), eq(contactsTable.email, to)))
          .limit(1);
        const contact = contacts[0];

        const trackedHtml = contact
          ? injectJourneyTrackingLinks(html, contact.id, to, {
              tenantId: user.tenantId,
              baseUrl,
              templateId: tpl.id,
            })
          : html;

        return sendEmail({
          to,
          subject: `[Test] ${subject}`,
          html: trackedHtml,
          tenantId: user.tenantId,
          ...(contact ? { contactId: contact.id, templateId: tpl.id } : {}),
        });
      })
    );
    const sent = results.some(Boolean);
    res.json({ sent, to: recipients.join(", "), recipients });
  } catch (err) { next(err); }
});

export default router;
