import { Router, type IRouter } from "express";
import { captureHpJourneyForm, linkHpJourneyIdentity } from "../lib/hpBiLeads";
import { isHpClient } from "../lib/hpBiImport";
import { hpPageContext, snapshotHpActivity } from "../lib/hpBiContext";
import { eq, sql, asc } from "drizzle-orm";
import {
  db, pool, journeysTable, clientsTable,
  sequenceEnrollmentsTable, sequenceStepsTable, emailSequencesTable,
} from "@workspace/db";
import { ObjectStorageService } from "../lib/objectStorage";
import { logger } from "../lib/logger";
import { evaluateRoutingRules } from "../lib/scoringEngine";
import { computeIntentScore } from "../lib/intentScoring";
import { getIntegrationConfig } from "../lib/integrationCredentials";
import { sendEmail, buildUnsubscribeFooter, buildConfirmationEmailParts, verifyFormPreviewToken, verifyClickToken, verifyExternalClickToken, verifyHoneypotToken } from "../services/email";
import { classifyRequest, CLICK_BOT_TIMING_WINDOW_SEC } from "../lib/botDetection";
import { STAGE_RANK, computeSequentialStageAdvancement } from "../lib/stageUtils";

const router: IRouter = Router();
const objectStorageService = new ObjectStorageService();

export type SitemapJourney = { slug: string; updatedAt: Date | string | null };

/** Serialize only server-selected public journeys into a standards-compliant sitemap. */
export function buildPublicJourneySitemap(origin: string, journeys: SitemapJourney[]): string {
  const escapeXml = (value: string) => value.replace(/[<>&'"]/g, char => ({
    "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;",
  })[char]!);
  const urls = journeys.map(journey => {
    const loc = new URL(`/j/${encodeURIComponent(journey.slug)}`, origin).toString();
    const lastmod = journey.updatedAt ? `<lastmod>${new Date(journey.updatedAt).toISOString()}</lastmod>` : "";
    return `<url><loc>${escapeXml(loc)}</loc>${lastmod}</url>`;
  }).join("");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`;
}

function sitemapOrigin(req: { protocol: string; get(name: string): string | undefined }): string | null {
  const host = req.get("host");
  if (!host || /[\s/\\]/.test(host)) return null;
  const forwardedProtocol = req.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const protocol = forwardedProtocol === "https" || forwardedProtocol === "http" ? forwardedProtocol : req.protocol;
  return `${protocol}://${host}`;
}

// Kept unauthenticated: it exposes only public slugs, never personalized content.
router.get("/public/sitemap.xml", async (req, res, next): Promise<void> => {
  try {
    const origin = sitemapOrigin(req);
    if (!origin) {
      res.status(400).type("text/plain").send("A valid Host header is required.");
      return;
    }
    const result = await db.execute(sql`
      SELECT slug, updated_at AS "updatedAt"
      FROM journeys
      WHERE status = 'published'
        AND (start_date IS NULL OR start_date <= NOW())
        AND (end_date IS NULL OR end_date >= NOW())
      ORDER BY updated_at DESC
    `);
    res
      .set("Cache-Control", "public, max-age=300, s-maxage=300")
      .type("application/xml")
      .send(buildPublicJourneySitemap(origin, result.rows as SitemapJourney[]));
  } catch (err) { next(err); }
});

// ── Sequential stage advancement DB helper ───────────────────────────────────
// Enforces that a contact cannot skip stages (e.g. pre-aware → engage must pass
// through aware and pre-engage first). Each intermediate transition is written to
// contact_stage_history so the timeline correctly shows every step.
//
// `currentTags` and `currentStage` may be passed in from an already-fetched
// contact row to avoid a redundant DB round-trip; when omitted they are fetched.
//
// Returns the list of stage tags that were actually added (empty when the
// contact was already at or past targetStage).
export async function advanceStageInDB(
  contactId: number,
  tenantId: number,
  targetStage: string,
  opts?: {
    currentTags?: string[];
    currentStage?: string | null;
    scoreAtTransition?: number;
    activityEventId?: number | null;
  },
): Promise<{ stagesToAdd: string[] }> {
  let currentTags = opts?.currentTags;
  let currentStage = opts?.currentStage;
  let scoreAtTransition = opts?.scoreAtTransition ?? 0;
  const activityEventId = opts?.activityEventId ?? null;

  if (currentTags === undefined || currentStage === undefined) {
    const rows = await pool.query<{ tags: string[] | null; stage: string | null; lead_score: number | null }>(
      `SELECT tags, stage, lead_score FROM contacts WHERE id = $1 AND tenant_id = $2 LIMIT 1`,
      [contactId, tenantId],
    );
    const row = rows.rows[0];
    if (!row) return { stagesToAdd: [] };
    currentTags = row.tags ?? [];
    currentStage = row.stage ?? null;
    if (opts?.scoreAtTransition === undefined) {
      scoreAtTransition = Number(row.lead_score ?? 0);
    }
  }

  const { stagesToAdd } = computeSequentialStageAdvancement(currentTags, targetStage);
  if (stagesToAdd.length === 0) return { stagesToAdd: [] };

  let fromStage = currentStage ?? "pre-aware";
  for (const stage of stagesToAdd) {
    // Atomic CTE: tag append + history INSERT in one statement.
    // If a concurrent request already added this stage tag, the UPDATE matches
    // 0 rows so the INSERT inserts 0 rows — no duplicate history records.
    await pool.query(
      `WITH advanced AS (
         UPDATE contacts
         SET tags = array_append(COALESCE(tags, '{}'), $3)
         WHERE id = $1 AND tenant_id = $2
           AND NOT ($3 = ANY(COALESCE(tags, '{}')))
         RETURNING id, tenant_id
       )
       INSERT INTO contact_stage_history
         (tenant_id, contact_id, from_stage, to_stage, score_at_transition, activity_event_id, created_at)
       SELECT tenant_id, id, $4, $3, $5, $6, NOW()
       FROM advanced`,
      [contactId, tenantId, stage, fromStage, scoreAtTransition, activityEventId],
    ).catch(() => {});
    fromStage = stage;
  }

  const finalStage = stagesToAdd[stagesToAdd.length - 1]!;
  const finalRank  = STAGE_RANK[finalStage] ?? 0;
  await pool.query(
    `UPDATE contacts SET stage = $3
     WHERE id = $1 AND tenant_id = $2
       AND CASE COALESCE(stage, 'pre-aware')
             WHEN 'action'         THEN 5
             WHEN 'advance-engage' THEN 4
             WHEN 'engage'         THEN 3
             WHEN 'pre-engage'     THEN 2
             WHEN 'aware'          THEN 1
             ELSE 0 END < $4`,
    [contactId, tenantId, finalStage, finalRank],
  );

  return { stagesToAdd };
}

function normalizePages(pages: any[]) {
  return pages.map(p => ({ ...p, ctaEnabled: p.ctaEnabled === "true" || p.ctaEnabled === true }));
}

// Resolve {{token|fallback}} placeholders with contact data (camelCase + snake_case)
export function resolveTokens(text: string | undefined | null, tokenMap: Record<string, string>): string {
  if (!text) return text ?? "";
  return text.replace(/\{\{(\w+)(?:\|([^}]*))?\}\}/g, (_, key, fallback) => {
    const value = tokenMap[key] ?? "";
    if (value) return value;
    return fallback ?? "";
  });
}

/**
 * Apply personalization tokens to a journey page's title, ctaText, and primary
 * content (HTML string or blocks JSON).  Returns a new page object — never mutates.
 */
export function resolvePageContent(page: any, tokenMap: Record<string, string>): any {
  // Always run substitution — even when tokenMap is empty (anonymous visitor)
  // so that {{token|fallback}} placeholders are replaced with their fallback
  // text rather than left as raw literals in the response.
  const result: any = {
    ...page,
    title:   resolveTokens(page.title,   tokenMap),
    ctaText: resolveTokens(page.ctaText, tokenMap),
  };
  if (page.pageType === "html" && page.content) {
    result.content = resolveTokens(page.content, tokenMap);
  } else if (page.pageType === "blocks" && page.content) {
    try {
      const bc = JSON.parse(page.content);
      if (bc && typeof bc === "object") {
        if (bc.header) {
          bc.header = {
            ...bc.header,
            title:    resolveTokens(bc.header.title,    tokenMap),
            subtitle: resolveTokens(bc.header.subtitle, tokenMap),
          };
        }
        if (bc.footer) {
          bc.footer = { ...bc.footer, text: resolveTokens(bc.footer.text, tokenMap) };
        }
        if (Array.isArray(bc.blocks)) {
          bc.blocks = bc.blocks.map((b: any) => {
            switch (b.type) {
              case "headline":
              case "text":
              case "button":
                return { ...b, text: resolveTokens(b.text, tokenMap) };
              case "list":
                return { ...b, items: (b.items ?? []).map((it: string) => resolveTokens(it, tokenMap)) };
              case "html":
                return { ...b, html: resolveTokens(b.html, tokenMap) };
              default:
                return b;
            }
          });
        }
        result.content = JSON.stringify(bc);
      }
    } catch { /* leave raw on JSON parse error */ }
  }
  return result;
}

function passesTagTargeting(
  targeting: { mode: string; tag?: string } | null | undefined,
  contactTags: string[],
  isIdentified: boolean,
): boolean {
  if (!targeting || targeting.mode === "everyone") return true;
  if (!isIdentified) return false;
  if (targeting.mode === "with_tag") return contactTags.includes(targeting.tag ?? "");
  if (targeting.mode === "without_tag") return !contactTags.includes(targeting.tag ?? "");
  return true;
}

function bannerVisibleForContact(bannerConfig: any, contactTags: string[], isIdentified: boolean): boolean {
  const target: string[] = bannerConfig.targetTags ?? [];
  if (target.length === 0) return true;
  if (!isIdentified) return true;
  return bannerConfig.tagMatch === "all"
    ? target.every(t => contactTags.includes(t))
    : target.some(t => contactTags.includes(t));
}

async function resolveVisitor(
  tenantId: number,
  opts: { cid?: string; email?: string; visitorToken?: string },
): Promise<{ contact: Record<string, any> | null; tokenMap: Record<string, string>; tags: string[] }> {
  const cidInt = opts.cid ? parseInt(opts.cid, 10) : null;
  const hasVisitorToken = !!(opts.visitorToken);
  const hasEmail = !!(opts.email);
  const hasCid = cidInt !== null && !isNaN(cidInt);

  if (!hasCid && !hasEmail && !hasVisitorToken) {
    return { contact: null, tokenMap: {}, tags: [] };
  }

  // Step 1: try visitor_token lookup (fastest path for returning visitors)
  let rows;
  if (hasVisitorToken) {
    rows = await db.execute(sql`
      SELECT
        c.id, c.first_name AS "firstName", c.last_name AS "lastName",
        c.email, c.title, c.tags, c.tenant_id AS "tenantId",
        c.is_anonymous AS "isAnonymous",
        comp.name AS "companyName", comp.industry
      FROM visitor_tokens vt
      JOIN contacts c ON c.id = vt.contact_id AND c.tenant_id = ${tenantId}
      LEFT JOIN companies comp ON comp.id = c.company_id
      WHERE vt.token = ${opts.visitorToken!} AND vt.tenant_id = ${tenantId}
      LIMIT 1
    `);
  } else {
    rows = { rows: [] };
  }

  // Step 2: if visitor_token lookup failed (new visitor or token not yet linked),
  // fall back to cid/email and immediately link the token so future requests are fast.
  // Also handles the case where the token IS already linked but to an anonymous shadow
  // contact — in that case we still need to fall through here when hasCid/hasEmail are
  // present so we can merge the shadow into the real contact.
  const tokenLinkedToAnonymous =
    (rows.rows as any[]).length > 0 &&
    (rows.rows[0] as any).is_anonymous === true;

  if (((rows.rows as any[]).length === 0 || tokenLinkedToAnonymous) && (hasCid || hasEmail)) {
    // Re-fetch including is_anonymous so we can detect the shadow case above
    const identRows = await db.execute(sql`
      SELECT
        c.id, c.first_name AS "firstName", c.last_name AS "lastName",
        c.email, c.title, c.tags, c.tenant_id AS "tenantId", c.is_anonymous AS "isAnonymous",
        comp.name AS "companyName", comp.industry
      FROM contacts c
      LEFT JOIN companies comp ON comp.id = c.company_id
      WHERE c.tenant_id = ${tenantId}
        AND (
          ${hasCid ? sql`c.id = ${cidInt!}` : sql`FALSE`}
          OR ${hasEmail ? sql`c.email = ${opts.email!}` : sql`FALSE`}
        )
        AND (c.is_anonymous IS NULL OR c.is_anonymous = FALSE)
      LIMIT 1
    `);

    if ((identRows.rows as any[]).length > 0 && hasVisitorToken) {
      const realContact = identRows.rows[0] as { id: number; tenantId: number };

      // If the visitor_token was previously linked to an anonymous shadow, merge
      // that shadow into the real contact now (transfers score + activity history).
      // This fires on the very first cid-identified request (e.g. the journey GET
      // fetch), not just the /track POST, so no points are ever silently discarded.
      if (tokenLinkedToAnonymous) {
        const shadowId = (rows.rows[0] as any).id as number;
        if (shadowId !== realContact.id) {
          await mergeAnonymousContact(tenantId, shadowId, realContact.id);
        }
      }

      // Eagerly link (or re-link) the visitor_token to the real contact so all
      // subsequent requests can identify the visitor without cid/email.
      db.execute(sql`
        INSERT INTO visitor_tokens (token, contact_id, tenant_id)
        VALUES (${opts.visitorToken!}, ${realContact.id}, ${tenantId})
        ON CONFLICT (token) DO UPDATE SET contact_id = EXCLUDED.contact_id, tenant_id = EXCLUDED.tenant_id
      `).catch(() => {});
    }

    rows = identRows;
  }

  const contact = (rows.rows[0] as Record<string, any>) ?? null;
  const tags: string[] = contact?.tags ?? [];
  const tokenMap: Record<string, string> = contact
    ? {
        firstName: String(contact.firstName ?? ""),
        lastName: String(contact.lastName ?? ""),
        companyName: String(contact.companyName ?? ""),
        industry: String(contact.industry ?? ""),
        email: String(contact.email ?? ""),
        jobTitle: String(contact.title ?? ""),
        first_name: String(contact.firstName ?? ""),
        last_name: String(contact.lastName ?? ""),
        company_name: String(contact.companyName ?? ""),
        title: String(contact.title ?? ""),
      }
    : {};

  return { contact, tokenMap, tags };
}

// ── Anonymous visitor identity ────────────────────────────────────────────────
// Unidentified visitors still generate real activity (page views, scroll depth,
// etc). Rather than dropping that activity on the floor, we give them a
// lightweight "shadow" contact (is_anonymous = true) keyed off their
// visitor_token so their score/stage accumulate normally. When they're later
// identified (cid/email arrives, e.g. via an email click or form submit), the
// shadow contact is merged into the real one and removed.

async function getOrCreateAnonymousContact(
  tenantId: number,
  visitorToken: string,
): Promise<Record<string, any> | null> {
  if (!visitorToken) return null;

  // Already linked to a (possibly anonymous) contact?
  const existing = await db.execute(sql`
    SELECT c.id, c.lead_score, c.tags, c.stage, c.is_anonymous
    FROM visitor_tokens vt
    JOIN contacts c ON c.id = vt.contact_id AND c.tenant_id = ${tenantId}
    WHERE vt.token = ${visitorToken} AND vt.tenant_id = ${tenantId}
    LIMIT 1
  `);
  const found = existing.rows[0] as Record<string, any> | undefined;
  if (found) return found;

  // Create a new shadow contact + link the token, guarding against a
  // concurrent request racing to create the same visitor's contact.
  try {
    const inserted = await db.execute(sql`
      INSERT INTO contacts (tenant_id, first_name, last_name, tags, stage, source, is_anonymous)
      VALUES (${tenantId}, 'Anonymous', 'Visitor', ARRAY[]::text[], 'pre-aware', 'anonymous_tracking', TRUE)
      RETURNING id, lead_score, tags, stage, is_anonymous
    `);
    const contact = inserted.rows[0] as Record<string, any>;
    await db.execute(sql`
      INSERT INTO visitor_tokens (token, contact_id, tenant_id)
      VALUES (${visitorToken}, ${contact.id}, ${tenantId})
      ON CONFLICT (token) DO UPDATE SET contact_id = EXCLUDED.contact_id, tenant_id = EXCLUDED.tenant_id
    `);
    return contact;
  } catch (err) {
    logger.warn({ err, visitorToken, tenantId }, "Failed to create anonymous contact");
    // Someone else may have just created/linked it — try the lookup once more.
    const retry = await db.execute(sql`
      SELECT c.id, c.lead_score, c.tags, c.stage, c.is_anonymous
      FROM visitor_tokens vt
      JOIN contacts c ON c.id = vt.contact_id AND c.tenant_id = ${tenantId}
      WHERE vt.token = ${visitorToken} AND vt.tenant_id = ${tenantId}
      LIMIT 1
    `);
    return (retry.rows[0] as Record<string, any>) ?? null;
  }
}

// Merge a shadow contact's activity into the now-identified real contact, then
// remove the shadow row. All accumulated score from the shadow is summed into
// the real contact so no points are lost. Activity events, stage history, and
// visitor_token links are all re-attributed before the shadow row is deleted.
//
// The entire operation runs inside a serializable transaction that begins with
// a SELECT … FOR UPDATE on the shadow contacts row.  This row-level lock blocks
// any concurrent advanceStageInDB CTE that targets the same shadow contact_id
// until the transaction commits (at which point the shadow is already deleted).
// Without the lock, an advanceStageInDB INSERT that lands between the history
// re-attribution UPDATE and the DELETE would create an orphaned history row
// attributed to the now-deleted shadow contact.
export async function mergeAnonymousContact(
  tenantId: number,
  anonymousContactId: number,
  realContactId: number,
): Promise<void> {
  if (anonymousContactId === realContactId) return;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Lock the shadow row for the duration of the transaction.  Any concurrent
    // UPDATE contacts WHERE id = anonymousContactId (e.g. advanceStageInDB's
    // tag-append CTE) will block here until we COMMIT and the shadow is gone.
    const lockResult = await client.query<{ id: number }>(
      `SELECT id FROM contacts
       WHERE id = $1 AND tenant_id = $2 AND is_anonymous = TRUE
       FOR UPDATE`,
      [anonymousContactId, tenantId],
    );
    if (lockResult.rows.length === 0) {
      // Shadow already deleted by a concurrent merge — nothing to do.
      await client.query("ROLLBACK");
      return;
    }

    await client.query(
      `UPDATE activity_events SET contact_id = $1
       WHERE tenant_id = $2 AND contact_id = $3`,
      [realContactId, tenantId, anonymousContactId],
    );
    // Add the shadow contact's accumulated score to the real contact BEFORE
    // deleting it so no points earned while anonymous are lost.
    await client.query(
      `UPDATE contacts
       SET lead_score = COALESCE(lead_score, 0) + (
         SELECT COALESCE(lead_score, 0) FROM contacts
         WHERE id = $1 AND tenant_id = $2
       )
       WHERE id = $3 AND tenant_id = $2`,
      [anonymousContactId, tenantId, realContactId],
    );
    await client.query(
      `UPDATE visitor_tokens SET contact_id = $1
       WHERE tenant_id = $2 AND contact_id = $3`,
      [realContactId, tenantId, anonymousContactId],
    );
    await client.query(
      `UPDATE contact_stage_history SET contact_id = $1
       WHERE tenant_id = $2 AND contact_id = $3`,
      [realContactId, tenantId, anonymousContactId],
    );
    await client.query(
      `DELETE FROM contacts WHERE id = $1 AND tenant_id = $2 AND is_anonymous = TRUE`,
      [anonymousContactId, tenantId],
    );

    await client.query("COMMIT");
    logger.info({ anonymousContactId, realContactId, tenantId }, "Merged anonymous shadow contact into real contact");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    logger.warn({ err, anonymousContactId, realContactId }, "Failed to merge anonymous contact");
  } finally {
    client.release();
  }
}

async function promoteAnonymousContactWithEmail(
  tenantId: number,
  anonymousContactId: number,
  normalizedEmail: string,
): Promise<Record<string, any> | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Serialize promotions for the same tenant/email before taking a fresh
    // snapshot in the following statements. This prevents two shadows from
    // both becoming real contacts for one email.
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
      [`contest-contact:${tenantId}:${normalizedEmail}`],
    );

    const shadowResult = await client.query(
      `SELECT id, email, lead_score, tags, stage, is_anonymous
       FROM contacts
       WHERE id = $1 AND tenant_id = $2
       FOR UPDATE`,
      [anonymousContactId, tenantId],
    );
    const shadow = shadowResult.rows[0] as Record<string, any> | undefined;

    if (!shadow?.is_anonymous) {
      const resolvedResult = await client.query(
        `SELECT id, lead_score, tags, stage, is_anonymous
         FROM contacts
         WHERE tenant_id = $1
           AND is_anonymous IS DISTINCT FROM TRUE
           AND LOWER(BTRIM(COALESCE(email, ''))) = $2
         ORDER BY id ASC
         LIMIT 1`,
        [tenantId, normalizedEmail],
      );
      await client.query("COMMIT");
      return (resolvedResult.rows[0] as Record<string, any> | undefined) ?? null;
    }

    const existingResult = await client.query(
      `SELECT id, lead_score, tags, stage, is_anonymous
       FROM contacts
       WHERE tenant_id = $1
         AND id <> $2
         AND is_anonymous IS DISTINCT FROM TRUE
         AND LOWER(BTRIM(COALESCE(email, ''))) = $3
       ORDER BY id ASC
       LIMIT 1
       FOR UPDATE`,
      [tenantId, anonymousContactId, normalizedEmail],
    );
    const existingContact = existingResult.rows[0] as Record<string, any> | undefined;

    if (existingContact) {
      // Release the email lock only after recording which real contact owns the
      // address. The merge has its own serializable row-locked transaction.
      await client.query("COMMIT");
      await mergeAnonymousContact(tenantId, anonymousContactId, existingContact.id);
      return existingContact;
    }

    const promotedResult = await client.query(
      `UPDATE contacts
       SET email = $1,
           is_anonymous = FALSE,
           source = CASE
             WHEN source = 'anonymous_tracking' THEN 'contest_registration'
             ELSE source
           END,
           updated_at = NOW()
       WHERE id = $2
         AND tenant_id = $3
         AND is_anonymous = TRUE
       RETURNING id, lead_score, tags, stage, is_anonymous`,
      [normalizedEmail, anonymousContactId, tenantId],
    );
    await client.query("COMMIT");
    return (promotedResult.rows[0] as Record<string, any> | undefined) ?? null;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    logger.warn(
      { err, anonymousContactId, tenantId },
      "Failed to promote anonymous contest contact",
    );
    return null;
  } finally {
    client.release();
  }
}

// ── GET /public/journeys/:slug ────────────────────────────────────────────────
router.get("/public/journeys/:slug", async (req, res, next): Promise<void> => {
  try {
    const [journey] = await db
      .select()
      .from(journeysTable)
      .where(eq(journeysTable.slug, req.params.slug));
    if (!journey || journey.status !== "published") {
      res.status(404).json({ error: "Journey not found" }); return;
    }
    const now = new Date();
    if (journey.startDate && new Date(journey.startDate) > now) {
      res.status(404).json({ error: "Journey not available yet" }); return;
    }
    if (journey.endDate && new Date(journey.endDate) < now) {
      res.status(404).json({ error: "Journey has ended" }); return;
    }

    const visitorToken = req.headers["x-visitor-token"] as string | undefined;
    const { contact, tokenMap, tags: contactTags } = await resolveVisitor(journey.tenantId, {
      cid: req.query.cid as string | undefined,
      email: req.query.contact as string | undefined,
      visitorToken,
    });

    // Renew pf_vt on every successful resolution so the cookie stays alive
    // even when the user returns months after their last email click.
    // Max-age 1 year — resets on every visit where we know who they are.
    if (contact && visitorToken) {
      res.cookie("pf_vt", visitorToken, {
        maxAge: 365 * 24 * 60 * 60 * 1000,
        path: "/",
        sameSite: "lax",
        httpOnly: false,
      });
    }

    const rawPages = await db.execute(sql`
      SELECT
        p.id, p.title, p.page_type AS "pageType",
        p.content, p.sort_order AS "sortOrder", p.cta_text AS "ctaText",
        p.cta_enabled AS "ctaEnabled", p.view_count AS "viewCount",
        p.is_published AS "isPublished",
        p.cta_type AS "ctaType", p.cta_asset_url AS "ctaAssetUrl",
        p.gating_action AS "gatingAction"
      FROM journey_pages p
      WHERE p.journey_id = ${journey.id}
      ORDER BY p.sort_order ASC
    `);

    const pages = normalizePages(rawPages.rows as any[])
      .filter((p: any) => p.isPublished !== false)
      .map((p: any) => resolvePageContent(p, tokenMap));

    const [client] = await db
      .select({ name: clientsTable.name, logoUrl: clientsTable.logoUrl })
      .from(clientsTable)
      .where(eq(clientsTable.id, journey.clientId));

    // ── Zone banners (active + within schedule) ────────────────────────────────
    const zoneBannerRows = await db.execute(sql`
      SELECT
        id, name, zone, config,
        original_width AS "originalWidth",
        original_height AS "originalHeight",
        file_size AS "fileSize",
        start_date AS "startDate",
        end_date AS "endDate"
      FROM banners
      WHERE tenant_id = ${journey.tenantId}
        AND zone IS NOT NULL
        AND (status = 'active' OR status = 'scheduled')
        AND (start_date IS NULL OR start_date <= NOW())
        AND (end_date   IS NULL OR end_date   >= NOW())
      ORDER BY id ASC
    `);
    const allZoneBanners = zoneBannerRows.rows as any[];

    // Group by zone and apply tag targeting
    const zoneBanners: Record<string, any[]> = { top: [], bottom: [], sidebar: [] };
    for (const b of allZoneBanners) {
      const z = b.zone as string;
      if (!zoneBanners[z]) zoneBanners[z] = [];
      const cfg = b.config ?? {};
      const passes = passesTagTargeting(cfg.tagTargeting, contactTags, !!contact);
      if (passes) zoneBanners[z].push(b);
    }

    // ── Zone settings ──────────────────────────────────────────────────────────
    const zoneSettingsRows = await db.execute(sql`
      SELECT zone, rotation_interval_seconds AS "rotationIntervalSeconds", mobile_behavior AS "mobileBehavior"
      FROM banner_zone_settings
      WHERE tenant_id = ${journey.tenantId}
    `);
    const zoneSettings: Record<string, { rotationIntervalSeconds: number; mobileBehavior: string }> = {};
    for (const row of zoneSettingsRows.rows as any[]) {
      zoneSettings[row.zone] = { rotationIntervalSeconds: row.rotationIntervalSeconds, mobileBehavior: row.mobileBehavior };
    }
    for (const z of ["top", "bottom", "sidebar"]) {
      if (!zoneSettings[z]) zoneSettings[z] = { rotationIntervalSeconds: 5, mobileBehavior: "hide" };
    }

    // Personalization can vary by cid/contact/visitor token and must never be
    // served from a shared browser or CDN cache.
    res.set("Cache-Control", "private, no-store, max-age=0");
    res.json({
      ...journey,
      clientName: client?.name ?? null,
      clientLogoUrl: client?.logoUrl ?? null,
      visitorContact: contact
        ? { firstName: contact.firstName, lastName: contact.lastName, tags: contactTags }
        : null,
      pages,
      zoneBanners,
      zoneSettings,
    });
  } catch (err) { next(err); }
});

// ── POST /public/banners/:id/event ────────────────────────────────────────────
router.post("/public/banners/:id/event", async (req, res, next): Promise<void> => {
  try {
    const bannerId = parseInt(req.params.id);
    if (isNaN(bannerId)) { res.status(400).json({ error: "Invalid banner id" }); return; }
    const { event_type, journey_id, visitor_token } = req.body as {
      event_type?: string;
      journey_id?: number | null;
      visitor_token?: string | null;
    };
    if (!["impression", "click", "dismiss"].includes(event_type ?? "")) {
      res.status(400).json({ error: "Invalid event_type. Must be impression, click, or dismiss." }); return;
    }

    // Validate the banner exists and is active/scheduled; capture tenant_id for cross-tenant check
    const bannerCheck = await db.execute(sql`
      SELECT id, tenant_id AS "tenantId" FROM banners
      WHERE id = ${bannerId}
        AND (status = 'active' OR status = 'scheduled')
        AND (start_date IS NULL OR start_date <= NOW())
        AND (end_date IS NULL OR end_date >= NOW())
      LIMIT 1
    `);
    if ((bannerCheck.rows as any[]).length === 0) {
      res.status(404).json({ error: "Banner not found or not active" }); return;
    }
    const bannerTenantId: number = (bannerCheck.rows[0] as any).tenantId;

    // Optionally validate journey: must be published AND belong to the same tenant as the banner
    if (journey_id != null) {
      const journeyCheck = await db.execute(sql`
        SELECT id FROM journeys
        WHERE id = ${journey_id}
          AND status = 'published'
          AND tenant_id = ${bannerTenantId}
        LIMIT 1
      `);
      if ((journeyCheck.rows as any[]).length === 0) {
        res.status(404).json({ error: "Journey not found" }); return;
      }
    }

    await db.execute(sql`
      INSERT INTO banner_events (banner_id, event_type, visitor_token, journey_id, occurred_at)
      VALUES (
        ${bannerId},
        ${event_type!},
        ${visitor_token ?? null},
        ${journey_id ?? null},
        NOW()
      )
    `);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ── GET /public/click/:token ──────────────────────────────────────────────────
// Server-side click-tracking redirect for email links.
// The contact identity is encoded in the URL *path* (not query params) so
// corporate email security proxies (Safe Links, Proofpoint, etc.) cannot strip it.
// Flow: email link → bot check → (human) sets cookies → redirects to /j/:slug
//                              → (bot)   logs event with is_bot=true, skips cookies
router.get("/public/click/:token", async (req, res): Promise<void> => {
  const payload = verifyClickToken(req.params.token);
  if (!payload) {
    res.redirect("/");
    return;
  }
  const { contactId, tenantId, slug, sentAtSec, templateId } = payload;

  // ── Journey existence check ───────────────────────────────────────────────
  // Verify the slug still points to a published journey BEFORE bot detection
  // and any side-effects (cookies, stage advancement, score, events).
  // A journey can be deleted or unpublished after emails are sent; the token
  // remains cryptographically valid but the destination is gone. Returning a
  // clear 404 here prevents the silent fallback-to-/ that the SPA would
  // otherwise show when the /api/public/journeys/:slug fetch returned 404.
  // This check runs for both human and bot paths so scanners also see the 404
  // rather than following a redirect to a non-existent page.
  const journeyCheck = await pool.query<{ id: number }>(
    `SELECT id FROM journeys WHERE slug = $1 AND tenant_id = $2 AND status = 'published' LIMIT 1`,
    [slug, tenantId]
  ).catch(() => ({ rows: [] as { id: number }[] }));

  if (journeyCheck.rows.length === 0) {
    logger.warn({ slug, tenantId, contactId }, "Click redirect: journey slug not found or unpublished — returning 404");
    res.status(404).send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Page not found</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
           display: flex; align-items: center; justify-content: center; min-height: 100vh;
           margin: 0; background: #f9fafb; color: #111827; }
    .card { background: #fff; border-radius: 12px; padding: 48px 40px; max-width: 420px;
            text-align: center; box-shadow: 0 1px 3px rgba(0,0,0,.1); }
    h1 { font-size: 1.5rem; font-weight: 700; margin: 0 0 12px; }
    p  { color: #6b7280; margin: 0; line-height: 1.6; }
  </style>
</head>
<body>
  <div class="card">
    <h1>This page is no longer available</h1>
    <p>The link you followed leads to a page that has been removed or is no longer published. Please contact the sender for an updated link.</p>
  </div>
</body>
</html>`);
    return;
  }

  // Bot detection: IP/UA + timing.
  //
  // WHY timing matters for clicks:
  // Corporate email security (Microsoft Safe Links, Proofpoint, Mimecast) proxies BOTH
  // the automated pre-scan AND real user clicks through the same IP range. IP/UA alone
  // cannot tell them apart — both requests look identical at the network level.
  //
  // The only reliable signal is elapsed time since send:
  //   • Pre-scan fires within ~5 s of delivery (scanner checks every URL immediately)
  //   • Real user click comes when the user actually reads the email — minutes to hours later
  //
  // BOT_TIMING_WINDOW_SEC = 15 s. A pre-scan arriving within 15 s of the encoded
  // sentAtSec is classified as a bot. A real Wipro/Outlook user clicking 30 minutes
  // later passes cleanly even though their click is proxied through Safe Links IPs.
  //
  // Edge case: a user who taps a push notification within 15 s of send will be
  // mis-classified. In practice bulk mailers are delivered asynchronously and this
  // window is acceptable; for 1:1 transactional sends sentAtSec could be omitted.
  let { isBot, reason } = classifyRequest(req, sentAtSec ?? null, CLICK_BOT_TIMING_WINDOW_SEC);

  // Honeypot enforcement: per-send scope — check bot_sessions for this contact
  // scoped to enrollments that were sent within ±48h of this click token's sentAtSec.
  // Only fire if there is an enrollment-level OR contact-level (enrollment_id IS NULL) bot flag.
  if (!isBot && contactId) {
    const pool2 = (await import("@workspace/db")).pool;
    const hpRow = await pool2.query<{ id: number }>(
      `SELECT bs.id FROM bot_sessions bs
       WHERE bs.contact_id = $1
         AND (
           -- contact-level flag (no specific enrollment): affects all sends for this contact
           bs.enrollment_id IS NULL
           OR
           -- enrollment-scoped flag: only when the enrollment's enrolled_at is within 48h of this click's sentAt
           (bs.enrollment_id IS NOT NULL AND $2::bigint IS NOT NULL AND EXISTS(
             SELECT 1 FROM sequence_enrollments se
             WHERE se.id = bs.enrollment_id
               AND ABS(EXTRACT(EPOCH FROM (se.enrolled_at - to_timestamp($2::bigint)))) < 172800
           ))
         )
       LIMIT 1`,
      [contactId, sentAtSec ?? null]
    ).catch(() => ({ rows: [] }));
    if (hpRow.rows.length > 0) {
      isBot = true;
      reason = "honeypot_flagged";
    }
  }

  if (isBot) {
    // Redirect to the journey (so scanners don't flag the URL as broken)
    // but do NOT set identity cookies or link visitor_tokens
    logger.info({ contactId, tenantId, slug, reason }, "Bot click redirect detected — skipping identity cookie");
    // Log the bot click for audit
    db.execute(sql`
      INSERT INTO journey_events (tenant_id, journey_id, event_type, visitor_token, ip_address, is_bot, created_at)
      SELECT ${tenantId}, j.id, 'email_click_bot', NULL, ${(req.headers["x-forwarded-for"] as string ?? req.ip ?? "")}, TRUE, NOW()
      FROM journeys j WHERE j.slug = ${slug} LIMIT 1
    `).catch(() => {});
    res.redirect(`/j/${slug}?utm_source=email`);
    return;
  }

  // Eagerly link the visitor_token (from cookie if already set) to this contact
  // so the journey viewer resolves identity even before the useEffect fires.
  // NOTE: the viewer sets the cookie as "pf_vt" (persistent visitor token).
  const existingVt = req.cookies?.pf_vt as string | undefined;
  if (existingVt) {
    db.execute(sql`
      INSERT INTO visitor_tokens (token, contact_id, tenant_id)
      VALUES (${existingVt}, ${contactId}, ${tenantId})
      ON CONFLICT (token) DO UPDATE SET contact_id = EXCLUDED.contact_id, tenant_id = EXCLUDED.tenant_id
    `).catch(() => {});
  }

  // Set / reinforce pf_vt as a server-side cookie (30 days) so personalisation
  // survives return visits even in mobile WebViews where client JS cookies can be
  // blocked. If there's no existing pf_vt we mint a new token and link it to the
  // contact immediately so the very next direct visit is already identified.
  const vtToSet = existingVt || (Math.random().toString(36).slice(2) + Date.now().toString(36));
  if (!existingVt && contactId && tenantId) {
    db.execute(sql`
      INSERT INTO visitor_tokens (token, contact_id, tenant_id)
      VALUES (${vtToSet}, ${contactId}, ${tenantId})
      ON CONFLICT (token) DO UPDATE SET contact_id = EXCLUDED.contact_id, tenant_id = EXCLUDED.tenant_id
    `).catch(() => {});
  }
  res.cookie("pf_vt", vtToSet, {
    maxAge: 365 * 24 * 60 * 60 * 1000, // 1 year — renewed on every successful visit too
    path: "/",
    sameSite: "lax",
    httpOnly: false, // must be readable by viewer JS
  });

  // Set a readable (non-HttpOnly) cookie so the viewer JS can pick up the contact id
  // even when URL query params were stripped by corporate email security.
  res.cookie("kaboom_cid", String(contactId), {
    maxAge: 24 * 60 * 60 * 1000, // 24 h
    path: "/",
    sameSite: "lax",
    httpOnly: false,
  });
  res.cookie("kaboom_tid", String(tenantId), {
    maxAge: 24 * 60 * 60 * 1000,
    path: "/",
    sameSite: "lax",
    httpOnly: false,
  });

  // Advance contact to 'aware' stage sequentially BEFORE sending the redirect.
  // A deliberate link click is an unambiguous awareness signal — awaiting this
  // ensures the DB is consistent before the viewer loads and resolves identity.
  // The activity_event row is inserted first so its id can be linked to the
  // stage_history row — this lets the Stage History UI show "Email link click"
  // as the triggering event for real contacts (not just seed data).
  // advanceStageInDB enforces no stage-skipping and logs each step atomically.
  if (contactId && tenantId) {
    try {
      // Resolve click points synchronously — needed for both the activity_events row
      // and (indirectly) to ensure score is correct before intent recompute.
      const { rows: ptRows } = await pool.query<{ points: number }>(
        `SELECT points FROM scoring_rules WHERE event_type = 'email_click' AND is_active = 'true' ORDER BY id LIMIT 1`
      );
      const points = ptRows[0]?.points ?? 0;

      // Insert activity_event first so its id is available for the stage history row.
      // NOTE: for Resend sends the webhook also fires an email_click — we intentionally
      // do NOT deduplicate here because the webhook may not arrive (SMTP sends have no
      // Resend webhook). Duplicate suppression is acceptable via the 10-minute window on
      // the webhook side; the click route is the authoritative source of truth.
      const { rows: aeRows } = await pool.query<{ id: number }>(
        `INSERT INTO activity_events
           (tenant_id, contact_id, event_type, description, source, score_delta, page_url, created_at)
         VALUES ($1, $2, 'email_click', 'Email link clicked', 'email', $3, $4, NOW())
         RETURNING id`,
        [tenantId, contactId, points, `/j/${slug}`]
      );
      const activityEventId = aeRows[0]?.id ?? null;

      // advanceStageInDB enforces no stage-skipping; links activity_event_id to each history row.
      const { stagesToAdd } = await advanceStageInDB(contactId, tenantId, "aware", { activityEventId });
      if (stagesToAdd.length > 0) {
        logger.info({ contactId, tenantId, slug }, "Contact advanced to aware stage via email click redirect (Path A)");
      }

      // Fire-and-forget: email_events row (per-step click attribution), score update, intent recompute.
      // v3+ click tokens carry templateId, letting us write a properly attributed
      // email_events row (like 'sent'/'opened' already get). This is what makes per-step
      // click counts in the sequence run report accurate — without it, the report has
      // no way to know WHICH email a click belongs to and has to fall back to a
      // catch-all guess. Older (v1/v2) tokens have templateId=null and simply skip this.
      const sideEffects: Promise<unknown>[] = [];
      if (templateId) {
        sideEffects.push(
          pool.query(
            `INSERT INTO email_events (tenant_id, contact_id, template_id, event_type, metadata)
             SELECT $1, $2, t.id, 'clicked', $4
             FROM email_templates t WHERE t.id=$3 AND t.tenant_id=$1`,
            [tenantId, contactId, templateId, JSON.stringify({ activityEventId, destinationUrl: `/j/${slug}`, source: "redirect" })]
          )
        );
      }
      if (points !== 0) {
        sideEffects.push(pool.query(
          `UPDATE contacts SET lead_score = GREATEST(0, COALESCE(lead_score, 0) + $1)
           WHERE id = $2 AND tenant_id = $3`,
          [points, contactId, tenantId]
        ));
      }
      Promise.all(sideEffects)
        .then(() => {
          computeIntentScore(contactId, tenantId)
            .catch(err => logger.warn({ err, contactId, tenantId }, "computeIntentScore failed after click redirect"));
        })
        .catch(err => {
          logger.warn({ err, contactId, tenantId }, "Failed to record email side effects in click redirect");
        });
    } catch (err) {
      logger.warn({ err, contactId, tenantId }, "Stage advancement failed in click redirect — continuing with redirect");
    }
  }

  // Include cid in the URL so the viewer can resolve identity even when
  // cookies are blocked (mobile WebViews, Outlook, Gmail apps).
  // The viewer's visitorQs useState captures this at first render and passes
  // it to both the identity POST and the track endpoint.
  res.redirect(`/j/${slug}?utm_source=email&cid=${contactId}`);
});

// ── GET /public/click-ext/:token ─────────────────────────────────────────────
// Server-side click-tracking redirect for external (non-journey) links in
// sequence emails. Advances stage to 'aware', sets identity cookies, then
// redirects to the original destination URL encoded in the token.
router.get("/public/click-ext/:token", async (req, res): Promise<void> => {
  const payload = verifyExternalClickToken(req.params.token);
  if (!payload) {
    // Fallback to homepage — never show a broken link
    res.redirect("/");
    return;
  }
  const { contactId, tenantId, destinationUrl, templateId, enrollmentId, sentAtSec } = payload;

  // Bot detection: IP/UA + timing (same reasoning as /public/click/:token above).
  // Safe Links proxies both the pre-scan AND real user clicks through the same IPs;
  // elapsed time since send is the only reliable way to tell them apart.
  const { isBot, reason } = classifyRequest(req, sentAtSec ?? null, CLICK_BOT_TIMING_WINDOW_SEC);
  if (isBot) {
    logger.info({ contactId, tenantId, destinationUrl, reason }, "Bot ext-click redirect detected — skipping stage update");
    res.redirect(destinationUrl);
    return;
  }

  // Set identity cookies so the journey viewer can resolve contact
  const existingVt = req.cookies?.pf_vt as string | undefined;
  if (existingVt) {
    db.execute(sql`
      INSERT INTO visitor_tokens (token, contact_id, tenant_id)
      VALUES (${existingVt}, ${contactId}, ${tenantId})
      ON CONFLICT (token) DO UPDATE SET contact_id = EXCLUDED.contact_id, tenant_id = EXCLUDED.tenant_id
    `).catch(() => {});
  }
  // Reinforce / mint pf_vt with a 30-day server-set cookie (same logic as /public/click/:token)
  const vtToSetExt = existingVt || (Math.random().toString(36).slice(2) + Date.now().toString(36));
  if (!existingVt && contactId && tenantId) {
    db.execute(sql`
      INSERT INTO visitor_tokens (token, contact_id, tenant_id)
      VALUES (${vtToSetExt}, ${contactId}, ${tenantId})
      ON CONFLICT (token) DO UPDATE SET contact_id = EXCLUDED.contact_id, tenant_id = EXCLUDED.tenant_id
    `).catch(() => {});
  }
  res.cookie("pf_vt", vtToSetExt, { maxAge: 365 * 24 * 60 * 60 * 1000, path: "/", sameSite: "lax", httpOnly: false });
  res.cookie("kaboom_cid", String(contactId), { maxAge: 24 * 60 * 60 * 1000, path: "/", sameSite: "lax", httpOnly: false });
  res.cookie("kaboom_tid", String(tenantId),  { maxAge: 24 * 60 * 60 * 1000, path: "/", sameSite: "lax", httpOnly: false });

  // Advance stage BEFORE redirect (same pattern as /public/click/:token).
  // The activity_event row is inserted first so its id can be linked to the
  // stage_history row — this lets the Stage History UI show "Email link click"
  // as the triggering event for real contacts (not just seed data).
  // advanceStageInDB enforces no stage-skipping and logs each intermediate step.
  if (contactId && tenantId) {
    try {
      // Resolve click points synchronously — needed for the activity_events row.
      const { rows: ptRows } = await pool.query<{ points: number }>(
        `SELECT points FROM scoring_rules WHERE event_type = 'email_click' AND is_active = 'true' ORDER BY id LIMIT 1`
      );
      const points = ptRows[0]?.points ?? 0;

      // Insert activity_event first so its id is available for the stage history row.
      const { rows: aeRows } = await pool.query<{ id: number }>(
        `INSERT INTO activity_events
           (tenant_id, contact_id, event_type, description, source, score_delta, page_url, created_at)
         VALUES ($1, $2, 'email_click', 'Email link clicked (external)', 'email', $3, $4, NOW())
         RETURNING id`,
        [tenantId, contactId, points, destinationUrl]
      );
      const activityEventId = aeRows[0]?.id ?? null;

      // advanceStageInDB enforces no stage-skipping; links activity_event_id to each history row.
      const { stagesToAdd } = await advanceStageInDB(contactId, tenantId, "aware", { activityEventId });
      if (stagesToAdd.length > 0) {
        logger.info({ contactId, tenantId, destinationUrl }, "Contact advanced to aware stage via external click redirect (Path A ext)");
      }

      // Fire-and-forget: email_events row (per-step click attribution), score update, intent recompute.
      const sideEffects: Promise<unknown>[] = [];
      if (templateId) {
        // Link the exact activity row to its message and destination. Legacy rows
        // without this id can only be matched when the timing is unambiguous.
        const meta = JSON.stringify({
          activityEventId, destinationUrl, source: "redirect",
          ...(enrollmentId ? { enrollmentId } : {}),
        });
        sideEffects.push(pool.query(
          `INSERT INTO email_events (tenant_id, contact_id, template_id, event_type, metadata)
           SELECT $1, $2, t.id, 'clicked', $4
           FROM email_templates t WHERE t.id=$3 AND t.tenant_id=$1`,
          [tenantId, contactId, templateId, meta]
        ));
      }
      if (points !== 0) {
        sideEffects.push(pool.query(
          `UPDATE contacts SET lead_score = GREATEST(0, COALESCE(lead_score, 0) + $1)
           WHERE id = $2 AND tenant_id = $3`,
          [points, contactId, tenantId]
        ));
      }
      Promise.all(sideEffects)
        .then(() => {
          computeIntentScore(contactId, tenantId)
            .catch(err => logger.warn({ err, contactId, tenantId }, "computeIntentScore failed after ext-click redirect"));
        })
        .catch(err => {
          logger.warn({ err, contactId, tenantId }, "Failed to record email side effects in ext-click redirect");
        });
    } catch (err) {
      logger.warn({ err, contactId, tenantId }, "Stage advancement failed in ext-click redirect — continuing with redirect");
    }
  }

  // Redirect to the original destination — append cid so the destination
  // page can resolve identity even when cookies are blocked (mobile WebViews).
  try {
    const destUrl = new URL(destinationUrl);
    destUrl.searchParams.set("cid", String(contactId));
    destUrl.searchParams.set("utm_source", "email");
    res.redirect(destUrl.toString());
  } catch {
    res.redirect(destinationUrl);
  }
});

// ── GET /public/honeypot/:token ───────────────────────────────────────────────
// Invisible link injected into every email. When a scanner follows it, we flag
// the contact+send (enrollmentId) as bot, preventing future false positives for
// that specific send. The bot_sessions row lets pixel and click endpoints check
// per-send bot status regardless of timing.
router.get("/public/honeypot/:token", async (req, res): Promise<void> => {
  res.status(200).end();
  const identity = verifyHoneypotToken(req.params.token);
  if (!identity) return;
  const { contactId, tenantId, enrollmentId } = identity;
  try {
    // Record the honeypot hit with enrollment context for per-send enforcement
    await db.execute(sql`
      INSERT INTO bot_sessions (tenant_id, contact_id, enrollment_id, reason, detected_at)
      VALUES (${tenantId}, ${contactId}, ${enrollmentId || null}, 'honeypot', NOW())
    `);
    // Mark email_events for this specific enrollment (or recent events if unknown) as bot
    if (enrollmentId) {
      await db.execute(sql`
        UPDATE email_events
        SET is_bot = TRUE
        WHERE tenant_id = ${tenantId} AND contact_id = ${contactId}
          AND (metadata->>'enrollmentId')::int = ${enrollmentId}
          AND is_bot = FALSE
      `);
    } else {
      // Fallback: mark recent events within 72h for this contact
      await db.execute(sql`
        UPDATE email_events
        SET is_bot = TRUE
        WHERE tenant_id = ${tenantId} AND contact_id = ${contactId}
          AND occurred_at > NOW() - INTERVAL '72 hours'
          AND is_bot = FALSE
      `);
    }
    logger.info({ contactId, tenantId, enrollmentId }, "Honeypot triggered — send flagged as bot");
  } catch (err) {
    logger.warn({ err, contactId, tenantId }, "Honeypot handler error");
  }
});

// ── POST /public/journeys/:slug/track ─────────────────────────────────────────
router.post("/public/journeys/:slug/track", async (req, res, next): Promise<void> => {
  try {
    const [journey] = await db
      .select({
        id: journeysTable.id,
        tenantId: journeysTable.tenantId,
        clientId: journeysTable.clientId,
        slug: journeysTable.slug,
        name: journeysTable.name,
      })
      .from(journeysTable)
      .where(eq(journeysTable.slug, req.params.slug));
    if (!journey) { res.status(404).json({ error: "Journey not found" }); return; }

    const { event = "page_view", cid, contact: email, pageId, visitorToken, referrer, utmSource, duration, pageUrl, props } = req.body as {
      event?: string; cid?: string; contact?: string;
      pageId?: number | string; visitorToken?: string;
      referrer?: string; utmSource?: string;
      duration?: number; pageUrl?: string;
      props?: Record<string, unknown>;
    };
    const normalizedEmail =
      typeof email === "string" &&
      /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())
        ? email.trim().toLowerCase()
        : null;

    // Classify traffic source from UTM or referrer
    function classifySource(utm?: string, ref?: string): string {
      if (utm) {
        const u = utm.toLowerCase();
        if (u === "email" || u.startsWith("email")) return "email";
        if (u.includes("linkedin")) return "linkedin";
        if (u.includes("google")) return "google";
        if (u.includes("facebook") || u.includes("meta") || u.includes("instagram")) return "meta";
        if (u.includes("twitter") || u.includes("x.com")) return "twitter";
        return utm;
      }
      if (ref) {
        const r = ref.toLowerCase();
        if (r.includes("linkedin.com")) return "linkedin";
        if (r.includes("google.com") || r.includes("google.co")) return "google";
        if (r.includes("facebook.com") || r.includes("instagram.com") || r.includes("meta.com")) return "meta";
        if (r.includes("twitter.com") || r.includes("x.com")) return "twitter";
        if (r.includes("mail") || r.includes("email")) return "email";
      }
      return `journey:${journey.slug}`;
    }
    // Also accept Referer header as fallback
    const httpReferer = req.headers.referer ?? req.headers.referrer as string | undefined;
    const resolvedSource = classifySource(utmSource, referrer ?? httpReferer);

    // ── Resolve contact ──────────────────────────────────────────────────────
    // Priority: explicit cid/email → visitor token → give up
    const cidInt = cid ? parseInt(cid, 10) : null;
    let contactRow: Record<string, any> | null = null;

    if (cidInt && !isNaN(cidInt) || normalizedEmail) {
      const rows = await db.execute(sql`
        SELECT id, lead_score, tags, stage, is_anonymous FROM contacts
        WHERE tenant_id = ${journey.tenantId}
          AND (
            ${cidInt && !isNaN(cidInt) ? sql`id = ${cidInt}` : sql`FALSE`}
            OR ${normalizedEmail
              ? sql`LOWER(BTRIM(COALESCE(email, ''))) = ${normalizedEmail}`
              : sql`FALSE`}
          )
        LIMIT 1
      `);
      contactRow = (rows.rows[0] as Record<string, any>) ?? null;
    }

    // When contact was identified from cid/email, auto-link the browser's visitor token
    // so future page views (without cid in URL) still resolve correctly. If that
    // token was previously tracking an anonymous shadow contact, merge its history
    // into the now-identified real contact.
    if (contactRow && visitorToken) {
      const priorLink = await db.execute(sql`
        SELECT c.id, c.is_anonymous
        FROM visitor_tokens vt
        JOIN contacts c ON c.id = vt.contact_id AND c.tenant_id = ${journey.tenantId}
        WHERE vt.token = ${visitorToken} AND vt.tenant_id = ${journey.tenantId}
        LIMIT 1
      `);
      const prior = priorLink.rows[0] as { id: number; is_anonymous: boolean } | undefined;
      if (prior?.is_anonymous && prior.id !== (contactRow as any).id) {
        await mergeAnonymousContact(journey.tenantId, prior.id, (contactRow as any).id);
      }

      // DO UPDATE so an email-link click always wins and re-links the token to this contact
      // (covers the case where a new browser session or re-identified contact arrives)
      db.execute(sql`
        INSERT INTO visitor_tokens (token, contact_id, tenant_id)
        VALUES (${visitorToken}, ${(contactRow as any).id}, ${journey.tenantId})
        ON CONFLICT (token) DO UPDATE SET contact_id = EXCLUDED.contact_id, tenant_id = EXCLUDED.tenant_id
      `).catch(() => {});
    }

    if (!contactRow && visitorToken) {
      const rows = await db.execute(sql`
        SELECT c.id, c.lead_score, c.tags, c.stage, c.is_anonymous
        FROM visitor_tokens vt
        JOIN contacts c ON c.id = vt.contact_id AND c.tenant_id = ${journey.tenantId}
        WHERE vt.token = ${visitorToken} AND vt.tenant_id = ${journey.tenantId}
        LIMIT 1
      `);
      contactRow = (rows.rows[0] as Record<string, any>) ?? null;
    }

    // ── Anonymous visitor fallback ────────────────────────────────────────────
    // No cid/email and no existing contact link at all — give this visitor a
    // lightweight shadow identity so their activity still counts (instead of
    // silently dropping it). Skipped for time_spent, which is handled below and
    // only ever updates an existing row.
    if (!contactRow && visitorToken && event !== "time_spent") {
      contactRow = await getOrCreateAnonymousContact(journey.tenantId, visitorToken);
    }
    if (contactRow && !(contactRow as any).is_anonymous) await linkHpJourneyIdentity(journey.tenantId, journey.clientId, Number((contactRow as any).id));

    // Registration can be the first moment an anonymous contest visitor gives us
    // an email. If no real contact already owns it, promote the existing shadow
    // contact instead of leaving the contest entry permanently unmatched.
    if (contactRow?.is_anonymous && normalizedEmail) {
      contactRow = await promoteAnonymousContactWithEmail(
        journey.tenantId,
        contactRow.id,
        normalizedEmail,
      );

      if (contactRow && visitorToken) {
        await db.execute(sql`
          INSERT INTO visitor_tokens (token, contact_id, tenant_id)
          VALUES (${visitorToken}, ${contactRow.id}, ${journey.tenantId})
          ON CONFLICT (token) DO UPDATE
          SET contact_id = EXCLUDED.contact_id,
              tenant_id = EXCLUDED.tenant_id
        `);
      }
    }

    // ── Handle time_spent: SET duration_seconds (when no heartbeat has fired yet) ─
    if (event === "time_spent" && duration && duration > 0) {
      const pageIdInt2 = pageId ? parseInt(String(pageId), 10) : null;
      const hasToken = !!visitorToken;
      const hasContact = !!contactRow && !!pageIdInt2 && !isNaN(pageIdInt2 as number);
      if ((hasToken || hasContact) && pageIdInt2 && !isNaN(pageIdInt2)) {
        await db.execute(sql`
          UPDATE activity_events
          SET duration_seconds = ${Math.round(duration)}
          WHERE id = (
            SELECT ae.id FROM activity_events ae
            WHERE ae.tenant_id  = ${journey.tenantId}
              AND ae.journey_id = ${journey.id}
              AND ae.event_type = 'page_view'
              AND ae.duration_seconds IS NULL
              AND (
                ${hasToken ? sql`ae.visitor_token = ${visitorToken}` : sql`FALSE`}
                OR
                (
                  ${hasContact ? sql`ae.contact_id = ${(contactRow as any).id}` : sql`FALSE`}
                  AND ae.page_name = (SELECT title FROM journey_pages WHERE id = ${pageIdInt2} LIMIT 1)
                )
              )
            ORDER BY ae.created_at DESC LIMIT 1
          )
        `).catch(() => {});
      }
      res.json({ ok: true });
      return;
    }

    // ── Handle heartbeat: INCREMENT duration_seconds (mobile-WebView-safe) ────────
    // Fired every 15 s from the viewer; does not depend on beforeunload/sendBeacon.
    // Uses += so multiple heartbeats accumulate correctly.
    if (event === "heartbeat") {
      const deltaRaw = (req.body as any).delta;
      const delta = deltaRaw != null ? parseInt(String(deltaRaw), 10) : 0;
      const pageIdInt2 = pageId ? parseInt(String(pageId), 10) : null;
      if (visitorToken && delta > 0 && pageIdInt2 && !isNaN(pageIdInt2)) {
        await db.execute(sql`
          UPDATE activity_events
          SET duration_seconds = COALESCE(duration_seconds, 0) + ${delta}
          WHERE id = (
            SELECT ae.id FROM activity_events ae
            WHERE ae.tenant_id  = ${journey.tenantId}
              AND ae.journey_id = ${journey.id}
              AND ae.event_type = 'page_view'
              AND ae.visitor_token = ${visitorToken}
              AND ae.page_name = (SELECT title FROM journey_pages WHERE id = ${pageIdInt2} LIMIT 1)
            ORDER BY ae.created_at DESC LIMIT 1
          )
        `).catch(() => {});
      }
      res.json({ ok: true });
      return;
    }

    if (!contactRow) { res.json({ ok: true, tracked: false }); return; }

    // ── Look up page stage + score ───────────────────────────────────────────
    // Page score and page_stage are set by the user per-page in the journey builder.
    // The page's score is authoritative — if the page was found, use its exact score
    // (even if 0, meaning "this page awards no points"). Only fall back to scoring_rules
    // when no pageId was provided or the page record doesn't exist.
    const pageIdInt = pageId ? parseInt(String(pageId), 10) : null;
    let pageStage: string | null = null;
    let pageScore: number | null = null;  // null = page not found / no pageId → use scoring_rules
    let pageName: string | null = null;

    if (pageIdInt && !isNaN(pageIdInt)) {
      const pageRows = await db.execute(sql`
        SELECT page_stage, score, title AS page_name FROM journey_pages WHERE id = ${pageIdInt} LIMIT 1
      `);
      const pr = pageRows.rows[0] as any;
      if (pr) {
        pageStage = pr.page_stage ?? null;
        pageScore = typeof pr.score === "number" ? pr.score : 0;  // 0 is valid — page explicitly awards no pts
        pageName  = pr.page_name ?? null;
      }
    }
    // The standalone HP Poly contest is not rendered through a journey_pages
    // route, so it has no pageId to send. Give its page_view a stable page name
    // so the existing Content Analytics popularity query can include embeds.
    if (
      event === "page_view" &&
      !pageName &&
      (journey.slug === "poly-contest" || journey.slug === "2-minute-meeting-rescue-1786861832577")
    ) {
      pageName = journey.name || "HP Poly 2-Minute Meeting Rescue";
    }

    // ── Calculate points ─────────────────────────────────────────────────────
    // pageScore=null → page not found → fall back to scoring_rules for the event type
    // pageScore=0    → page found, explicitly awards 0 pts → no fallback
    // pageScore>0    → page found, awards that many pts
    let points: number;
    if (pageScore !== null) {
      points = pageScore;
    } else {
      const ruleRows = await db.execute(sql`
        SELECT points FROM scoring_rules
        WHERE event_type = ${event} AND is_active = 'true'
        ORDER BY id LIMIT 1
      `);
      points = (ruleRows.rows[0] as any)?.points ?? 0;
    }

    // ── Score arithmetic (needed by stage logic below) ────────────────────────
    // Use Number() to guard against Drizzle returning numeric columns as strings
    const oldScore = Number(contactRow.lead_score ?? 0);
    const newScore = Math.max(0, oldScore + points);

    // ── Sequential stage advancement + tags (Path C — page view) ────────────
    // Stage-tagged page: advance the contact sequentially through every
    // intermediate stage between their current stage and the page's stage.
    // This prevents contacts from jumping stages (e.g. pre-aware → engage
    // without passing through aware and pre-engage first).
    // advanceStageInDB writes one history row per intermediate step, appends
    // each stage tag, and updates contacts.stage to the final target.
    // Non-stage-tagged events: no stage/tag mutation — intent engine handles heat.
    const currentTags: string[] = contactRow.tags ?? [];

    // ── Persist score change ──────────────────────────────────────────────────
    const description = pageStage
      ? `Page viewed — stage: ${pageStage}`
      : event === "asset_download" ? "Asset downloaded" : `Page viewed`;

    // Update score — COALESCE protects against null lead_score in DB
    await db.execute(sql`
      UPDATE contacts
      SET lead_score = GREATEST(0, COALESCE(lead_score, 0) + ${points})
      WHERE id = ${contactRow.id}
    `);

    // Extract visitor IP — trust X-Forwarded-For when behind a proxy
    const rawIp = (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim() ?? req.ip ?? null;

    // Insert the activity_event FIRST so its id is available to link from the stage
    // history row — this lets the Stage History UI show "Journey page view"
    // as the triggering event for real contacts (not just seed data).
    const aeResult = await db.execute(sql`
      INSERT INTO activity_events
        (tenant_id, contact_id, event_type, description, source, score_delta,
         journey_id, client_id, page_name, stage, ip_address, visitor_token, page_url, created_at)
      VALUES (
        ${journey.tenantId}, ${contactRow.id}, ${event},
        ${description}, ${resolvedSource}, ${points},
        ${journey.id},
        (SELECT p.client_id FROM journey_plays jp
           JOIN abm_plays p ON p.id = jp.play_id
          WHERE jp.journey_id = ${journey.id} AND p.client_id IS NOT NULL LIMIT 1),
        ${pageName},
        ${pageStage},
        ${rawIp},
        ${visitorToken ?? null},
        ${pageUrl ?? null},
        NOW()
      )
      RETURNING id
    `);
    if (aeResult.rows[0]) await snapshotHpActivity(journey.tenantId, journey.id, pageId, Number((aeResult.rows[0] as any).id));
    const pageViewActivityEventId: number | null = (aeResult.rows[0] as any)?.id ?? null;

    // ── Also write to journey_events for custom contest event types ───────────
    // These events are fired from the contest page and need to appear in the
    // journey analytics event log (GET /analytics/journeys/:id/events).
    // page_view is already written by the /public/events endpoint; custom types
    // are only routed through this track endpoint.
    const CONTEST_EVENT_TYPES = new Set([
      // Terminal / conversion events
      "scenario_selected", "registration_completed", "challenges_selected", "entry_submitted",
      // Intermediate funnel events — needed for drop-off analysis in the Event Log
      "step_viewed", "play_now_cover_clicked", "play_now_clicked", "challenge_started", "solutions_viewed",
      "gift_claim_clicked", "demo_interest_selected", "linkedin_share_clicked",
    ]);
    if (CONTEST_EVENT_TYPES.has(event)) {
      const pageIdInt2 = pageId ? parseInt(String(pageId), 10) : null;
      const propsJson = props && typeof props === "object" ? JSON.stringify(props) : null;
      db.execute(sql`
        INSERT INTO journey_events
          (tenant_id, journey_id, page_id, event_type, visitor_token, ip_address, page_url, props, created_at)
        VALUES (
          ${journey.tenantId}, ${journey.id},
          ${pageIdInt2 && !isNaN(pageIdInt2) ? pageIdInt2 : null},
          ${event}, ${visitorToken ?? null}, ${rawIp},
          ${pageUrl ?? null}, ${propsJson}::jsonb, NOW()
        )
      `).catch((err) => { logger.warn({ err, event }, "Failed to write contest event to journey_events"); });
    }

    // Advance stage sequentially; tags and history (with activity_event_id) are written by the helper.
    // advanceStageInDB enforces no stage-skipping: each intermediate step gets its own history row.
    // Non-stage-tagged events produce no stage/tag mutation — intent engine handles heat.
    let tagsAdded: string[] = [];
    if (pageStage && STAGE_RANK[pageStage] !== undefined) {
      const result = await advanceStageInDB(
        (contactRow as any).id,
        journey.tenantId,
        pageStage,
        {
          currentTags,
          currentStage: (contactRow as any).stage ?? null,
          scoreAtTransition: newScore,
          activityEventId: pageViewActivityEventId,
        },
      );
      tagsAdded = result.stagesToAdd;
    }

    // Auto-link identified contact to this journey so journey counts reflect reality
    await db.execute(sql`
      INSERT INTO journey_contacts (journey_id, contact_id, added_via)
      VALUES (${journey.id}, ${contactRow.id}, 'page_view')
      ON CONFLICT (journey_id, contact_id) DO NOTHING
    `).catch(() => {});

    evaluateRoutingRules({
      tenantId: journey.tenantId,
      contactId: contactRow.id,
      newScore,
      oldScore,
      tagsAdded,
    }).catch((err) => { logger.warn({ err }, "evaluateRoutingRules failed after track"); });

    computeIntentScore(contactRow.id, journey.tenantId)
      .catch((err) => { logger.warn({ err }, "computeIntentScore failed after track"); });

    res.json({ ok: true, tracked: true, points, newScore, pageStage, tagsAdded });
  } catch (err) { next(err); }
});

// ── POST /public/visitor-identity ─────────────────────────────────────────────
// Associates the browser's persistent visitor token with a known contact.
// Called immediately when a contact arrives via an email link (?cid=).
// Enables recognition on all future visits even without the ?cid= param.
router.post("/public/visitor-identity", async (req, res): Promise<void> => {
  try {
    const { visitorToken, cid, contact: email } = req.body as {
      visitorToken?: string; cid?: string; contact?: string;
    };
    if (!visitorToken) { res.json({ ok: false }); return; }

    const cidInt = cid ? parseInt(cid, 10) : null;
    if (!cidInt && !email) { res.json({ ok: false }); return; }

    // Look up the contact — no tenant scoping needed since cid/email are trusted
    // from the signed email link (anyone who has the link is the contact)
    const rows = await db.execute(sql`
      SELECT id, tenant_id FROM contacts
      WHERE (
        ${cidInt && !isNaN(cidInt) ? sql`id = ${cidInt}` : sql`FALSE`}
        OR ${email ? sql`email = ${email}` : sql`FALSE`}
      )
      LIMIT 1
    `);
    const contact = rows.rows[0] as { id: number; tenant_id: number } | undefined;
    if (!contact) { res.json({ ok: false }); return; }

    // DO UPDATE so a fresh email-link click always wins and re-links the token
    await db.execute(sql`
      INSERT INTO visitor_tokens (token, contact_id, tenant_id)
      VALUES (${visitorToken}, ${contact.id}, ${contact.tenant_id})
      ON CONFLICT (token) DO UPDATE SET contact_id = EXCLUDED.contact_id, tenant_id = EXCLUDED.tenant_id
    `);

    res.json({ ok: true, contactId: contact.id });
  } catch {
    res.json({ ok: false });
  }
});

// ── GET /public/journey/:journeyId/page/:pageId/components ───────────────────
router.get("/public/journey/:journeyId/page/:pageId/components", async (req, res, next): Promise<void> => {
  try {
    const journeyId = parseInt(req.params.journeyId);
    const pageId = parseInt(req.params.pageId);
    if (isNaN(journeyId) || isNaN(pageId)) {
      res.status(400).json({ error: "Invalid ids" }); return;
    }

    const [journey] = await db.select().from(journeysTable).where(eq(journeysTable.id, journeyId));
    if (!journey) { res.status(404).json({ error: "Journey not found" }); return; }

    // Enforce pageId belongs to this journeyId — prevents cross-journey/cross-tenant IDOR
    const pageCheck = await db.execute(sql`
      SELECT id FROM journey_pages WHERE id = ${pageId} AND journey_id = ${journeyId} LIMIT 1
    `);
    if ((pageCheck.rows as any[]).length === 0) {
      res.status(404).json({ error: "Page not found in this journey" }); return;
    }

    const visitorToken = (req.headers["x-visitor-token"] as string | undefined)
      ?? (req.cookies?.visitor_token as string | undefined);

    const { contact, tokenMap, tags: contactTags } = await resolveVisitor(journey.tenantId, {
      cid: req.query.cid as string | undefined,
      email: req.query.contact as string | undefined,
      visitorToken,
    });
    const isIdentified = contact !== null;

    const result = await db.execute(sql`
      SELECT
        pc.id,
        pc.journey_page_id  AS "journeyPageId",
        pc.component_type   AS "componentType",
        pc.component_id     AS "componentId",
        pc.position,
        pc.sort_order       AS "sortOrder",
        pc.override_config  AS "overrideConfig",
        pc.created_at       AS "createdAt",
        cb.name             AS "ctaName",
        cb.label            AS "ctaLabel",
        cb.action_type      AS "ctaActionType",
        cb.action_config    AS "ctaActionConfig",
        cb.style_config     AS "ctaStyleConfig",
        jf.name             AS "formName",
        jf.config           AS "formConfig",
        b.name              AS "bannerName",
        b.position          AS "bannerDefaultPosition",
        b.config            AS "bannerConfig"
      FROM page_components pc
      JOIN journey_pages jp ON jp.id = pc.journey_page_id AND jp.journey_id = ${journeyId}
      LEFT JOIN cta_buttons cb   ON cb.id = pc.component_id AND pc.component_type = 'cta'
      LEFT JOIN journey_forms jf ON jf.id = pc.component_id AND pc.component_type = 'form'
      LEFT JOIN banners b        ON b.id  = pc.component_id AND pc.component_type = 'banner'
      WHERE pc.journey_page_id = ${pageId}
      ORDER BY pc.sort_order ASC, pc.created_at ASC
    `);

    const components = (result.rows as any[])
      .filter(comp => {
        if (comp.componentType === "banner" && comp.bannerConfig) {
          const cfg = comp.bannerConfig;
          if (cfg.tagTargeting) return passesTagTargeting(cfg.tagTargeting, contactTags, isIdentified);
          return bannerVisibleForContact(cfg, contactTags, isIdentified);
        }
        if (comp.componentType === "form" && comp.formConfig) {
          const cfg = comp.formConfig;
          if (cfg.tagTargeting) return passesTagTargeting(cfg.tagTargeting, contactTags, isIdentified);
        }
        return true;
      })
      .map(comp => {
        if (!contact) return comp;
        if (comp.componentType === "banner" && comp.bannerConfig) {
          const cfg = comp.bannerConfig;
          return {
            ...comp,
            bannerConfig: {
              ...cfg,
              heading: resolveTokens(cfg.heading, tokenMap),
              overlayText: resolveTokens(cfg.overlayText, tokenMap),
              overlaySubtext: resolveTokens(cfg.overlaySubtext, tokenMap),
              body: resolveTokens(cfg.body, tokenMap),
              ctaText: resolveTokens(cfg.ctaText, tokenMap),
            },
          };
        }
        if (comp.componentType === "cta") {
          return {
            ...comp,
            ctaLabel: resolveTokens(comp.ctaLabel, tokenMap),
          };
        }
        if (comp.componentType === "form" && comp.formConfig) {
          const cfg = comp.formConfig as Record<string, any>;
          const resolvedHeaderElements = (cfg.headerElements ?? []).map((el: any) => ({
            ...el,
            text: resolveTokens(el.text, tokenMap),
          }));
          const resolvedSubmitButton = cfg.submitButton
            ? { ...cfg.submitButton, label: resolveTokens(cfg.submitButton.label, tokenMap) }
            : cfg.submitButton;
          const resolvedOnSubmit = cfg.onSubmit
            ? {
                ...cfg.onSubmit,
                thankYouTitle: resolveTokens(cfg.onSubmit.thankYouTitle, tokenMap),
                thankYouBody: resolveTokens(cfg.onSubmit.thankYouBody, tokenMap),
              }
            : cfg.onSubmit;
          return {
            ...comp,
            formConfig: {
              ...cfg,
              headerElements: resolvedHeaderElements,
              submitButton: resolvedSubmitButton,
              onSubmit: resolvedOnSubmit,
            },
          };
        }
        return comp;
      });

    // ── Zone banners for this journey (active + within schedule, tag-targeted) ──
    const zoneBannerRows = await db.execute(sql`
      SELECT
        id, name, zone, config,
        original_width AS "originalWidth",
        original_height AS "originalHeight",
        start_date AS "startDate",
        end_date AS "endDate"
      FROM banners
      WHERE tenant_id = ${journey.tenantId}
        AND zone IS NOT NULL
        AND (status = 'active' OR status = 'scheduled')
        AND (start_date IS NULL OR start_date <= NOW())
        AND (end_date   IS NULL OR end_date   >= NOW())
      ORDER BY id ASC
    `);
    const zoneBanners: Record<string, any[]> = { top: [], bottom: [], sidebar: [] };
    for (const b of zoneBannerRows.rows as any[]) {
      const z = b.zone as string;
      if (!zoneBanners[z]) zoneBanners[z] = [];
      const cfg = b.config ?? {};
      if (passesTagTargeting(cfg.tagTargeting, contactTags, isIdentified)) {
        zoneBanners[z].push(b);
      }
    }

    // ── Zone settings for this journey's tenant ────────────────────────────────
    const zoneSettingsRows = await db.execute(sql`
      SELECT zone, rotation_interval_seconds AS "rotationIntervalSeconds", mobile_behavior AS "mobileBehavior"
      FROM banner_zone_settings
      WHERE tenant_id = ${journey.tenantId}
    `);
    const zoneSettings: Record<string, { rotationIntervalSeconds: number; mobileBehavior: string }> = {};
    for (const row of zoneSettingsRows.rows as any[]) {
      zoneSettings[(row as any).zone] = {
        rotationIntervalSeconds: (row as any).rotationIntervalSeconds,
        mobileBehavior: (row as any).mobileBehavior,
      };
    }
    for (const z of ["top", "bottom", "sidebar"]) {
      if (!zoneSettings[z]) zoneSettings[z] = { rotationIntervalSeconds: 5, mobileBehavior: "hide" };
    }

    res.json({ components, zoneBanners, zoneSettings });
  } catch (err) { next(err); }
});

// ── POST /public/forms/:formId/submit ────────────────────────────────────────
router.post("/public/forms/:formId/submit", async (req, res, next): Promise<void> => {
  try {
    const formId = parseInt(req.params.formId);
    if (isNaN(formId)) { res.status(400).json({ error: "Invalid formId" }); return; }

    const { visitorToken, data = {}, pageId, journeyId, deliveryAssetId } = req.body as {
      visitorToken?: string;
      data?: Record<string, string>;
      pageId?: number;
      journeyId?: number;
      deliveryAssetId?: number;
    };

    if (!journeyId) {
      res.status(400).json({ error: "journeyId is required" }); return;
    }

    // Resolve journey to get tenantId + clientId
    const journeyRows = await db.execute(sql`
      SELECT id, tenant_id AS "tenantId", client_id AS "clientId"
      FROM journeys WHERE id = ${journeyId} LIMIT 1
    `);
    const journeyRow = journeyRows.rows[0] as any;
    if (!journeyRow) { res.status(404).json({ error: "Journey not found" }); return; }

    const tenantId: number = journeyRow.tenantId;
    const clientId: number = journeyRow.clientId;
    const hpFormClient = Boolean(await isHpClient(tenantId, clientId));

    // Get form — must belong to the resolved tenant
    const formResult = await db.execute(sql`
      SELECT id, name, config FROM journey_forms
      WHERE id = ${formId} AND tenant_id = ${tenantId}
      LIMIT 1
    `);
    const form = (formResult.rows[0] as any) ?? null;
    if (!form) { res.status(404).json({ error: "Form not found" }); return; }

    const config = form.config ?? {};
    const fields: any[] = config.fields ?? [];
    const onSubmit = config.onSubmit ?? {};

    // Map submitted data to contact fields via mapToContactField
    const contactFieldMap: Record<string, string> = {};
    for (const field of fields) {
      const val = data[field.id];
      if (val !== undefined && field.mapToContactField) {
        contactFieldMap[field.mapToContactField] = val;
      }
    }

    // Try mapped fields first, then direct key match, then scan all submitted values
    // for any that looks like an email — this handles forms where the email field
    // doesn't have mapToContactField set.
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const emailFallback = Object.values(data).find(
      (v): v is string => typeof v === "string" && emailRegex.test(v)
    ) ?? "";
    const emailVal = contactFieldMap["email"] ?? data["email"] ?? emailFallback;
    const firstNameVal = contactFieldMap["firstName"] ?? contactFieldMap["first_name"] ?? data["first_name"] ?? data["firstName"] ?? "";
    const lastNameVal = contactFieldMap["lastName"] ?? contactFieldMap["last_name"] ?? data["last_name"] ?? data["lastName"] ?? "";
    const phoneVal = contactFieldMap["phone"] ?? data["phone"] ?? "";
    const titleVal = contactFieldMap["jobTitle"] ?? contactFieldMap["title"] ?? data["title"] ?? data["jobTitle"] ?? "";

    let contactId: number | null = null;
    let hpNewContact = false;

    if (emailVal) {
      const existing = await db.execute(sql`
        SELECT id,client_id FROM contacts WHERE lower(btrim(email)) = lower(btrim(${emailVal})) AND tenant_id = ${tenantId} LIMIT 2
      `);
      const existingRow = existing.rows[0] as any;

      if (hpFormClient && existingRow && (existing.rows.length > 1 || existingRow.client_id !== null && Number(existingRow.client_id) !== clientId)) {
        contactId = null;
      } else if (existingRow) {
        contactId = existingRow.id;
        await db.execute(sql`
          UPDATE contacts SET
            first_name = CASE WHEN ${firstNameVal} <> '' THEN ${firstNameVal} ELSE first_name END,
            last_name  = CASE WHEN ${lastNameVal}  <> '' THEN ${lastNameVal}  ELSE last_name  END,
            phone      = CASE WHEN ${phoneVal}      <> '' THEN ${phoneVal}      ELSE phone      END,
            title      = CASE WHEN ${titleVal}     <> '' THEN ${titleVal}     ELSE title      END,
            updated_at = now()
          WHERE id = ${contactId}
        `);
      } else {
        const inserted = await db.execute(sql`
          INSERT INTO contacts
            (tenant_id, client_id, first_name, last_name, email, phone, title)
          VALUES
            (${tenantId}, ${clientId},
             ${firstNameVal}, ${lastNameVal}, ${emailVal}, ${phoneVal}, ${titleVal})
          RETURNING id
        `);
        contactId = (inserted.rows[0] as any)?.id ?? null;
        hpNewContact = Boolean(contactId);
      }

      // Associate visitorToken → contact for future session identification
      if (visitorToken && contactId) {
        await db.execute(sql`
          INSERT INTO visitor_tokens (token, contact_id, tenant_id)
          VALUES (${visitorToken}, ${contactId}, ${tenantId})
          ON CONFLICT (token) DO UPDATE SET contact_id = ${contactId}
        `);
      }
    }

    // Fallback: if the form had no email field (or it was left blank), try to
    // resolve the contact from a prior visitor_token session so that form_submissions
    // records the correct contact_id rather than null.
    if (!contactId && visitorToken) {
      const vtRow = (await db.execute(sql`
        SELECT contact_id FROM visitor_tokens
        WHERE token = ${visitorToken} AND tenant_id = ${tenantId}
          AND (${!hpFormClient} OR EXISTS(SELECT 1 FROM contacts c WHERE c.id=visitor_tokens.contact_id
            AND c.tenant_id=${tenantId} AND c.client_id=${clientId})) LIMIT 1
      `)).rows[0] as { contact_id: number | null } | undefined;
      if (vtRow?.contact_id) contactId = vtRow.contact_id;
    }

    // Snapshot score + tags BEFORE any mutations so routing rules see the correct delta
    let formOldScore = 0;
    let formOldTags: string[] = [];
    if (contactId) {
      const preRow = (await db.execute(sql`
        SELECT lead_score, tags FROM contacts WHERE id = ${contactId} LIMIT 1
      `)).rows[0] as { lead_score: number; tags: string[] } | undefined;
      formOldScore = preRow?.lead_score ?? 0;
      formOldTags = preRow?.tags ?? [];
    }

    // Handle consent field tag storage
    for (const field of fields) {
      if (field.type === "consent" && field.storeAsTag && data[field.id] === "true" && contactId) {
        const consentTag = `consented:form-${formId}`;
        await db.execute(sql`
          UPDATE contacts
          SET tags = array_append(tags, ${consentTag})
          WHERE id = ${contactId}
            AND NOT (tags @> ARRAY[${consentTag}])
        `);
      }
    }

    // Score for form_submitted
    if (contactId) {
      const ruleRows = await db.execute(sql`
        SELECT points FROM scoring_rules WHERE event_type = 'form_submitted' LIMIT 1
      `);
      const points: number = (ruleRows.rows[0] as any)?.points ?? 0;

      if (points !== 0) {
        await db.execute(sql`
          UPDATE contacts SET lead_score = GREATEST(0, lead_score + ${points}) WHERE id = ${contactId}
        `);
      }
      await db.execute(sql`
        INSERT INTO activity_events
          (tenant_id, contact_id, event_type, description, source, score_delta,
           journey_id, client_id, page_name, created_at)
        VALUES
          (${tenantId}, ${contactId}, 'form_submitted',
           ${`Submitted form: ${form.name}`}, ${`form:${formId}`}, ${points},
           ${journeyId},
           ${clientId ?? null},
           ${form.name},
           now())
      `);

      // Compute tags added since pre-submission snapshot (covers consent tags + any other mutations above)
      const tagsAfterRow = (await db.execute(sql`SELECT tags FROM contacts WHERE id = ${contactId} LIMIT 1`)).rows[0] as { tags: string[] } | undefined;
      const tagsAfter: string[] = tagsAfterRow?.tags ?? [];
      const formTagsAdded = tagsAfter.filter(t => !formOldTags.includes(t));

      evaluateRoutingRules({
        tenantId,
        contactId,
        newScore: Math.max(0, formOldScore + points),
        oldScore: formOldScore,
        tagsAdded: formTagsAdded,
      }).catch((err) => { logger.warn({ err }, "evaluateRoutingRules failed after form submit"); });

      computeIntentScore(contactId, tenantId)
        .catch((err) => { logger.warn({ err }, "computeIntentScore failed after form submit"); });
    }

    // Resolve delivery asset — must belong to the same tenant
    const assetIdToDeliver: number | null = deliveryAssetId ?? onSubmit.deliveryAssetId ?? null;
    let downloadUrl: string | null = null;
    let downloadFilename: string | null = null;
    let deliveryObjectPath: string | null = null;

    if (assetIdToDeliver) {
      interface AssetRow { objectPath: string; name: string }
      const assetRows = await db.execute(sql`
        SELECT id, name, object_path AS "objectPath"
        FROM media_assets
        WHERE id = ${assetIdToDeliver} AND tenant_id = ${tenantId}
        LIMIT 1
      `);
      const asset = assetRows.rows[0] as unknown as AssetRow | undefined;
      if (asset?.objectPath) {
        deliveryObjectPath = asset.objectPath;
        downloadUrl = await objectStorageService.generateSignedDownloadUrl(asset.objectPath, 3600);
        downloadFilename = asset.name;
        await db.execute(sql`
          INSERT INTO asset_downloads (tenant_id, asset_id, visitor_token, page_id, downloaded_at)
          VALUES (${tenantId}, ${assetIdToDeliver}, ${visitorToken ?? null}, ${pageId ?? null}, now())
        `);
      }
    }

    // Sequence enrollment using email_sequences + sequence_enrollments tables
    if (onSubmit.enrollSequenceId && contactId) {
      const [seq] = await db
        .select({ id: emailSequencesTable.id })
        .from(emailSequencesTable)
        .where(eq(emailSequencesTable.id, onSubmit.enrollSequenceId));

      if (seq) {
        const firstSteps = await db
          .select({ id: sequenceStepsTable.id })
          .from(sequenceStepsTable)
          .where(eq(sequenceStepsTable.sequenceId, seq.id))
          .orderBy(asc(sequenceStepsTable.stepOrder))
          .limit(1);

        const firstStep = firstSteps[0] ?? null;

        const enrollResult = await db.execute(sql`
          INSERT INTO sequence_enrollments (sequence_id, contact_id, status, current_step_id, enrolled_at)
          VALUES (${seq.id}, ${contactId}, 'active', ${firstStep?.id ?? null}, NOW())
          ON CONFLICT (sequence_id, contact_id) WHERE status = 'active' DO NOTHING
          RETURNING id
        `);
        const enrollment = enrollResult.rows[0] as { id: number } | undefined;

        if (firstStep && enrollment) {
          const { enqueueStep } = await import("../services/queue");
          await enqueueStep({
            enrollmentId: enrollment.id,
            stepId: firstStep.id,
            sequenceId: seq.id,
            contactId,
            tenantId,
          });
        }
      }
    }

    // ── Notify team if form has notifyOnSubmit enabled ────────────────────────
    if (config.notifyOnSubmit === true) {
      const contactName = [firstNameVal, lastNameVal].filter(Boolean).join(" ") || emailVal || "A visitor";
      const notifTitle = `${contactName} submitted "${form.name}"`;
      const notifBody = emailVal ? `Email: ${emailVal}` : null;
      db.execute(sql`
        INSERT INTO notifications (tenant_id, type, title, body, contact_id, read, created_at)
        VALUES (${tenantId}, 'form_submitted', ${notifTitle}, ${notifBody}, ${contactId ?? null}, false, now())
      `).catch((err: unknown) => { logger.warn({ err }, "Failed to create form_submitted notification"); });
    }

    // ── Always persist full field values to form_submissions ──────────────────
    const hpSubmission = await db.execute(sql`
      INSERT INTO form_submissions
        (tenant_id, form_id, contact_id, journey_id, page_id, visitor_token, field_values, action_type)
      VALUES
        (${tenantId}, ${formId}, ${contactId ?? null}, ${journeyId ?? null}, ${pageId ?? null},
         ${visitorToken ?? null}, ${JSON.stringify(data ?? {})}::jsonb,
         ${downloadUrl ? "gated_download" : "just_submit"})
      RETURNING id,submitted_at
    `);
    const hpSaved = hpSubmission.rows[0] as any;
    if (hpSaved) await captureHpJourneyForm({ tenantId, clientId, contactId, newContact: hpNewContact,
      submissionId: Number(hpSaved.id), fields, data, occurredAt: new Date(hpSaved.submitted_at),
      configuredLead: Boolean(config.biLead || config.onSubmit?.createLead) });

    // ── Send confirmation email if configured ─────────────────────────────────
    const confirmationEmail = config.confirmationEmail as
      | { enabled?: boolean; subject?: string; body?: string; attachAsset?: boolean }
      | undefined;

    if (confirmationEmail?.enabled && emailVal) {
      const tokenMap: Record<string, string> = {
        firstName: firstNameVal,
        lastName: lastNameVal,
        email: emailVal,
        phone: phoneVal,
        formName: form.name ?? "",
        thankYouTitle: onSubmit.thankYouTitle ?? "Thank you!",
        thankYouBody: onSubmit.thankYouBody ?? "",
      };

      const resolveTokens = (text: string) =>
        text.replace(/\{\{(\w+)(?:\|([^}]*))?\}\}/g, (_, key: string, fallback?: string) => {
          const value = tokenMap[key] ?? "";
          return value || (fallback ?? "");
        });

      const rawSubject = confirmationEmail.subject?.trim() || `${form.name}: submission confirmed`;
      const rawBody = confirmationEmail.body?.trim() || `Hi {{firstName|there}},\n\nThank you for submitting <strong>${form.name}</strong>. We'll be in touch shortly.`;

      const subject = resolveTokens(rawSubject);
      const bodyResolved = resolveTokens(rawBody);

      // Wrap plain-ish text or HTML in a minimal styled container
      const htmlBody = bodyResolved.includes("<") ? bodyResolved : bodyResolved.replace(/\n/g, "<br/>");

      let downloadSection = "";
      if (downloadUrl && downloadFilename) {
        downloadSection = `
<div style="margin-top:24px;padding:16px;background:#f0f4ff;border-radius:8px;text-align:center;">
  <p style="margin:0 0 12px;font-size:14px;color:#374151;">Your file is ready to download:</p>
  <a href="${downloadUrl}" style="display:inline-block;padding:10px 20px;background:#4f46e5;color:#fff;border-radius:6px;text-decoration:none;font-size:14px;font-weight:600;">${downloadFilename}</a>
  <p style="margin:8px 0 0;font-size:11px;color:#9ca3af;">Link expires in 1 hour</p>
</div>`;
      }

      const fullHtml = `
<div style="font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;padding:32px 24px;color:#111827;">
  ${htmlBody}
  ${downloadSection}
</div>`;

      // Optionally attach the delivery asset as a file attachment
      const shouldAttach = confirmationEmail.attachAsset === true && deliveryObjectPath !== null && downloadFilename !== null;
      const attachmentPromise: Promise<import("../services/email").EmailAttachment | null> = shouldAttach
        ? (async () => {
            try {
              const bytes = await objectStorageService.getObjectBytes(deliveryObjectPath!);
              return { filename: downloadFilename!, content: bytes };
            } catch (attachErr) {
              logger.warn({ attachErr, assetId: assetIdToDeliver }, "Failed to fetch asset bytes for email attachment");
              return null;
            }
          })()
        : Promise.resolve(null);

      attachmentPromise.then((attachment) => {
        const emailOpts: import("../services/email").SendEmailOptions = {
          to: emailVal,
          subject,
          html: fullHtml,
          tenantId,
          ...(attachment ? { attachments: [attachment] } : {}),
        };
        return sendEmail(emailOpts);
      }).catch((err) => {
        logger.warn({ err, formId, to: emailVal }, "Failed to send form confirmation email");
      });
    }

    res.json({
      success: true,
      thankYouTitle: onSubmit.thankYouTitle ?? config.heading ?? "Thank you!",
      thankYouBody: onSubmit.thankYouBody ?? config.successMessage ?? "",
      downloadUrl,
      downloadFilename,
      redirectUrl: onSubmit.redirectUrl ?? null,
      redirectDelay: onSubmit.redirectDelay ?? 3,
    });
  } catch (err) { next(err); }
});

// ── GET /public/assets/:assetId/request-download ─────────────────────────────
// journeyId is REQUIRED to establish tenant context and validate asset ownership.
router.get("/public/assets/:assetId/request-download", async (req, res, next): Promise<void> => {
  try {
    const assetId = parseInt(req.params.assetId);
    if (isNaN(assetId)) { res.status(400).json({ error: "Invalid assetId" }); return; }

    const journeyIdParam = req.query.journeyId as string | undefined;
    if (!journeyIdParam) {
      res.status(400).json({ error: "journeyId query param is required" }); return;
    }
    const journeyId = parseInt(journeyIdParam);
    if (isNaN(journeyId)) {
      res.status(400).json({ error: "Invalid journeyId" }); return;
    }

    // Resolve tenant from journey — all asset access is tenant-scoped via journey context
    const jRows = await db.execute(sql`
      SELECT tenant_id AS "tenantId" FROM journeys WHERE id = ${journeyId} LIMIT 1
    `);
    const tenantId = (jRows.rows[0] as any)?.tenantId as number | undefined;
    if (tenantId === undefined) {
      res.status(404).json({ error: "Journey not found" }); return;
    }

    // Fetch asset — enforce asset.tenant_id === journey.tenant_id
    const rows = await db.execute(sql`
      SELECT id, name, object_path AS "objectPath", mime_type AS "mimeType"
      FROM media_assets
      WHERE id = ${assetId} AND tenant_id = ${tenantId}
      LIMIT 1
    `);
    const asset = rows.rows[0] as any;
    if (!asset) { res.status(404).json({ error: "Asset not found" }); return; }

    // Generate signed download URL — no fallback; signing failure is a hard error
    const signedUrl = await objectStorageService.generateSignedDownloadUrl(asset.objectPath, 3600);

    // Log download
    const { visitorToken, pageId: pageIdStr } = req.query as { visitorToken?: string; pageId?: string };
    const pageId = pageIdStr ? parseInt(pageIdStr) : null;
    await db.execute(sql`
      INSERT INTO asset_downloads (tenant_id, asset_id, visitor_token, page_id, downloaded_at)
      VALUES (${tenantId}, ${assetId}, ${visitorToken ?? null}, ${pageId ?? null}, now())
    `);

    // Score contact via visitorToken if provided
    if (visitorToken) {
      const vtRows = await db.execute(sql`
        SELECT contact_id AS "contactId" FROM visitor_tokens
        WHERE token = ${visitorToken} AND tenant_id = ${tenantId} LIMIT 1
      `);
      const contactId = (vtRows.rows[0] as any)?.contactId ?? null;
      if (contactId) {
        const ruleRows = await db.execute(sql`
          SELECT points FROM scoring_rules WHERE event_type = 'asset_download' LIMIT 1
        `);
        const points: number = (ruleRows.rows[0] as any)?.points ?? 0;
        if (points !== 0) {
          const dlScoreRow = (await db.execute(sql`SELECT lead_score FROM contacts WHERE id = ${contactId} LIMIT 1`)).rows[0] as { lead_score: number } | undefined;
          const dlOldScore: number = dlScoreRow?.lead_score ?? 0;
          await db.execute(sql`
            UPDATE contacts SET lead_score = GREATEST(0, lead_score + ${points}) WHERE id = ${contactId}
          `);
          await db.execute(sql`
            INSERT INTO activity_events
              (tenant_id, contact_id, event_type, description, source, score_delta,
               journey_id, client_id, page_name, created_at)
            VALUES
              (${tenantId}, ${contactId}, 'asset_download',
               ${`Downloaded: ${asset.name}`}, 'public', ${points},
               ${journeyId},
               (SELECT p.client_id FROM journey_plays jp
                  JOIN abm_plays p ON p.id = jp.play_id
                 WHERE jp.journey_id = ${journeyId} AND p.client_id IS NOT NULL LIMIT 1),
               ${asset.name},
               now())
          `);
          evaluateRoutingRules({
            tenantId,
            contactId,
            newScore: Math.max(0, dlOldScore + points),
            oldScore: dlOldScore,
          }).catch((err) => { logger.warn({ err }, "evaluateRoutingRules failed after asset download"); });
          computeIntentScore(contactId, tenantId)
            .catch((err) => { logger.warn({ err, contactId, tenantId }, "computeIntentScore failed after asset download"); });
        }
      }
    }

    res.json({ signedUrl, filename: asset.name, mimeType: asset.mimeType });
  } catch (err) { next(err); }
});

// ── POST /public/events ───────────────────────────────────────────────────────
// Lightweight event ingestion: page_view, cta_click, banner_dismiss, form_start,
// and contest-specific events (scenario_selected, registration_completed,
// challenges_selected, entry_submitted).
const ALLOWED_EVENT_TYPES = new Set([
  "page_view", "cta_click", "banner_dismiss", "form_start",
  "scenario_selected", "registration_completed", "challenges_selected", "entry_submitted",
]);

router.post("/public/events", async (req, res) => {
  try {
    const { journeyId, pageId, componentId, eventType, visitorToken, pageUrl, ctaUrl, props } = req.body as {
      journeyId?: number; pageId?: number; componentId?: number;
      eventType?: string; visitorToken?: string; pageUrl?: string; ctaUrl?: string;
      props?: Record<string, unknown>;
    };
    if (!journeyId || !eventType) { res.json({ ok: true }); return; }
    if (!ALLOWED_EVENT_TYPES.has(eventType)) { res.json({ ok: true }); return; }

    const rows = (await db.execute(sql`SELECT tenant_id FROM journeys WHERE id = ${journeyId} LIMIT 1`)).rows as { tenant_id: number }[];
    const tenantId = rows[0]?.tenant_id;
    if (!tenantId) { res.json({ ok: true }); return; }

    const rawIp = (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim() ?? req.ip ?? null;
    const biContext = await hpPageContext(tenantId, journeyId, pageId);
    const propsJson = JSON.stringify({ ...(props && typeof props === "object" ? props : {}), biContext });

    await db.execute(sql`
      INSERT INTO journey_events (tenant_id, journey_id, page_id, component_id, event_type, visitor_token, ip_address, page_url, cta_url, props, created_at)
      VALUES (${tenantId}, ${journeyId}, ${pageId ?? null}, ${componentId ?? null}, ${eventType}, ${visitorToken ?? null}, ${rawIp}, ${pageUrl ?? null}, ${ctaUrl ?? null}, ${propsJson}::jsonb, now())
    `);
    res.json({ ok: true });
  } catch {
    res.json({ ok: true });
  }
});

// ── POST /public/track/scroll-depth ──────────────────────────────────────────
router.post("/public/track/scroll-depth", async (req, res) => {
  try {
    const { journeyId, pageId, pageTitle, depth, visitorToken } = req.body as {
      journeyId?: number; pageId?: number; pageTitle?: string;
      depth?: number; visitorToken?: string;
    };
    if (!journeyId || !depth) { res.json({ ok: true }); return; }
    const rows = (await db.execute(sql`SELECT tenant_id FROM journeys WHERE id = ${journeyId} LIMIT 1`)).rows as { tenant_id: number }[];
    const tenantId = rows[0]?.tenant_id;
    if (!tenantId) { res.json({ ok: true }); return; }

    // Resolve contact from visitor token so scroll events are attributed
    let contactId: number | null = null;
    if (visitorToken) {
      const vtRows = (await db.execute(sql`
        SELECT contact_id FROM visitor_tokens
        WHERE token = ${visitorToken} AND tenant_id = ${tenantId} LIMIT 1
      `)).rows as { contact_id: number }[];
      contactId = vtRows[0]?.contact_id ?? null;
    }

    await db.execute(sql`
      INSERT INTO activity_events
        (tenant_id, contact_id, journey_id, event_type, description, source, metadata, created_at)
      VALUES (
        ${tenantId}, ${contactId}, ${journeyId}, 'scroll_depth',
        ${`Scroll depth: ${depth}% on "${pageTitle ?? pageId}"`},
        'public',
        ${JSON.stringify({ depth, visitorToken: visitorToken ?? "anon", pageId, pageTitle })},
        now()
      )
    `);
    res.json({ ok: true });
  } catch { res.json({ ok: true }); }
});

// ── GET /public/journey-forms/:id ────────────────────────────────────────────
// Returns just the form name + config so blocks-page forms can be rendered on
// the public viewer without auth. Tenant scoping is intentionally omitted —
// forms here are public-facing artifacts already exposed via journey pages.
router.get("/public/journey-forms/:id", async (req, res, next): Promise<void> => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  try {
    const result = await db.execute(sql`
      SELECT id, name, config FROM journey_forms WHERE id = ${id}
    `);
    const row = (result.rows as any[])[0];
    if (!row) { res.status(404).json({ error: "Form not found" }); return; }
    res.json(row);
  } catch (err) { next(err); }
});

// ── GET /public/journey-forms/:id/preview-confirmation-email ─────────────────
// Unauthenticated access via HMAC token; used for sharing preview links.

router.get("/public/journey-forms/:id/preview-confirmation-email", async (req, res, next): Promise<void> => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).send("<p>Invalid id</p>"); return; }

  const token = req.query.token as string | undefined;
  if (!token) { res.status(401).send("<p>Missing preview token</p>"); return; }

  const tenantId = verifyFormPreviewToken(id, token);
  if (tenantId === null) {
    res.status(403).send(`<!DOCTYPE html><html><head><meta charset="UTF-8"/></head><body style="font-family:system-ui,sans-serif;padding:48px;text-align:center;color:#374151;">
<h2 style="color:#dc2626;">Preview link expired</h2>
<p>This preview link is no longer valid. Ask the form owner to generate a new one.</p>
</body></html>`);
    return;
  }

  try {
    const formRow = await db.execute(sql`
      SELECT name, config FROM journey_forms WHERE id = ${id} AND tenant_id = ${tenantId}
    `);
    const form = (formRow.rows as any[])[0];
    if (!form) { res.status(404).send("<p>Form not found</p>"); return; }

    const config = form.config as any;
    const formName = form.name as string;
    const confirmationEmail = config?.confirmationEmail as { subject?: string; body?: string } | undefined;

    const { subject: subjectResolved, bodyHtml: bodyBlock } = buildConfirmationEmailParts({
      rawSubjectSrc: confirmationEmail?.subject ?? "",
      rawBodySrc: confirmationEmail?.body ?? "",
      tokens: {
        firstName: "Alex",
        lastName: "Smith",
        email: "alex@example.com",
        phone: "+1 555 0100",
        formName,
        thankYouTitle: config?.onSubmit?.thankYouTitle ?? "Thank you!",
        thankYouBody: config?.onSubmit?.thankYouBody ?? "",
      },
      deliveryAssetId: config?.onSubmit?.deliveryAssetId as number | null | undefined,
    });

    const footer = buildUnsubscribeFooter("preview@example.com");

    const fullHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${subjectResolved}</title>
<style>
  body { margin: 0; padding: 0; background: #f3f4f6; }
  .email-preview-subject-bar {
    background: #1f2937;
    color: #f9fafb;
    font-family: system-ui, sans-serif;
    font-size: 12px;
    padding: 8px 24px;
  }
  .email-preview-subject-bar strong { color: #fff; }
  .email-wrapper {
    background: #ffffff;
    max-width: 600px;
    margin: 0 auto;
  }
</style>
</head>
<body>
<div class="email-preview-subject-bar">
  <strong>Subject:</strong> ${subjectResolved.replace(/</g, "&lt;").replace(/>/g, "&gt;")}
</div>
<div class="email-wrapper">
  ${bodyBlock}
  <div style="font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;padding:0 24px 16px;">
    ${footer}
  </div>
</div>
</body>
</html>`;

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.send(fullHtml);
  } catch (err) { next(err); }
});

// ── POST /public/track — component-interaction analytics event ──────────────
// Currently only used for banner_click. Attributes the click to a contact
// (creating/reusing an anonymous shadow contact when the visitor isn't
// identified yet, same as the page-view /track route) so banner engagement
// contributes to score instead of being dropped as an unattributed log line.
router.post("/public/track", async (req, res) => {
  try {
    const { journeyId, pageId, componentId, eventType, visitorToken } = req.body as {
      journeyId?: number; pageId?: number; componentId?: number;
      eventType?: string; visitorToken?: string;
    };
    if (!journeyId || !eventType) { res.json({ ok: true }); return; }

    // Look up tenant from journey
    const rows = (await db.execute(sql`SELECT tenant_id FROM journeys WHERE id = ${journeyId} LIMIT 1`)).rows as { tenant_id: number }[];
    const tenantId = rows[0]?.tenant_id;
    if (!tenantId) { res.json({ ok: true }); return; }

    // Resolve (or create) the contact behind this visitor token so the event
    // has a real contact_id to attribute score to.
    let contactId: number | null = null;
    if (visitorToken) {
      const anon = await getOrCreateAnonymousContact(tenantId, visitorToken);
      contactId = anon?.id ?? null;
    }

    const j = (await db.execute(sql`SELECT client_id FROM journeys WHERE tenant_id=${tenantId} AND id=${journeyId}`)).rows[0] as any;
    if (contactId && j?.client_id) await linkHpJourneyIdentity(tenantId, Number(j.client_id), contactId);
    // Only banner_click carries score today — other component event types
    // still get logged for the timeline, just with 0 points.
    let points = 0;
    if (eventType === "banner_click") {
      const ptRows = (await db.execute(sql`
        SELECT points FROM scoring_rules WHERE event_type = 'link_click' AND is_active = 'true' ORDER BY id LIMIT 1
      `)).rows as { points: number }[];
      points = ptRows[0]?.points ?? 0;
    }

    const activity = await db.execute(sql`
      INSERT INTO activity_events (tenant_id, contact_id, event_type, description, source, score_delta, created_at)
      VALUES (
        ${tenantId}, ${contactId}, ${eventType},
        ${`Component ${componentId ?? "?"} ${eventType} on page ${pageId ?? "?"}`},
        'public', ${points}, now()
      )
      RETURNING id
    `);
    if (activity.rows[0]) await snapshotHpActivity(tenantId, journeyId, pageId, Number((activity.rows[0] as any).id));

    if (contactId && points !== 0) {
      await db.execute(sql`
        UPDATE contacts SET lead_score = GREATEST(0, COALESCE(lead_score, 0) + ${points})
        WHERE id = ${contactId} AND tenant_id = ${tenantId}
      `);
      computeIntentScore(contactId, tenantId)
        .catch(err => logger.warn({ err, contactId, tenantId }, "computeIntentScore failed after banner_click track"));
    }

    res.json({ ok: true });
  } catch (err) {
    logger.warn({ err }, "Failed to record /public/track event");
    res.json({ ok: true });
  }
});

// ── POST /public/vapi-webhook/:tenantId ───────────────────────────────────────
// Receives end-of-call reports from Vapi.ai and updates call_logs + contact scores.
// tenantId is embedded in the URL (e.g. /api/public/vapi-webhook/1) so we don't
// rely on VAPI echoing back call metadata, which can be null for SIP trunk calls.
router.post("/public/vapi-webhook/:tenantId", async (req, res): Promise<void> => {
  try {
    // ── Step 0: Resolve tenantId — URL param is authoritative; payload metadata is fallback ─
    const rawMsg = (req.body as any)?.message;
    const rawMeta = rawMsg?.call?.metadata ?? rawMsg?.metadata ?? {};
    // Debug: log key fields from every incoming webhook
    logger.info({
      webhookType: rawMsg?.type,
      endedReason: rawMsg?.endedReason ?? rawMsg?.call?.endedReason,
      callId: rawMsg?.call?.id,
      callStatus: rawMsg?.call?.status,
      callMetadata: rawMsg?.call?.metadata,
      durationSeconds: rawMsg?.durationSeconds,
    }, "Vapi webhook received");
    const earlyTenantId =
      req.params.tenantId ? parseInt(req.params.tenantId) :
      rawMeta.tenantId   ? parseInt(rawMeta.tenantId)     : null;

    // ── Step 1: Verify Vapi webhook secret (optional — timing-safe when configured) ──
    const incomingSecret = (req.headers["x-vapi-secret"] as string | undefined) ?? "";
    if (!earlyTenantId) {
      res.status(401).json({ error: "Missing tenantId — use /api/public/vapi-webhook/:tenantId URL" });
      return;
    }
    const vapiCfg = await getIntegrationConfig(earlyTenantId, "vapi");
    const storedSecret: string = vapiCfg?.webhookSecret ?? "";
    // If a secret is configured, enforce it with timing-safe compare.
    // If no secret is configured (e.g. VAPI "No authentication"), allow through.
    if (storedSecret) {
      const { timingSafeEqual } = await import("crypto");
      const a = Buffer.from(incomingSecret.padEnd(storedSecret.length, "\0"));
      const b = Buffer.from(storedSecret);
      const lengthsMatch = incomingSecret.length === storedSecret.length;
      const contentsMatch = timingSafeEqual(a, b);
      if (!lengthsMatch || !contentsMatch) {
        res.status(401).json({ error: "Invalid webhook secret" });
        return;
      }
    }

    const body = req.body as {
      message?: {
        type?: string;
        call?: {
          id?: string;
          status?: string;
          startedAt?: string;
          endedAt?: string;
          recordingUrl?: string;
          analysis?: { summary?: string; successEvaluation?: string };
          artifact?: { transcript?: string; recordingUrl?: string };
        };
        transcript?: string;
        endedReason?: string;
        durationSeconds?: number;
        metadata?: { contactId?: string; campaignId?: string; tenantId?: string };
      };
    };

    const msg = body.message;
    if (!msg || msg.type !== "end-of-call-report") {
      res.json({ ok: true });
      return;
    }

    const call    = msg.call ?? {};
    const callId  = call.id;
    const meta    = (msg.call as any)?.metadata ?? (msg as any).metadata ?? {};

    // ── tenantId: URL param is authoritative; metadata is fallback ─────────────
    // earlyTenantId (from URL) was already validated above. Use it as primary.
    const tenantId   = earlyTenantId;
    const contactId  = meta.contactId  ? parseInt(meta.contactId)  : null;
    const campaignId = meta.campaignId ? parseInt(meta.campaignId) : null;

    if (!callId) { res.json({ ok: true }); return; }

    // ── If metadata didn't supply contactId, try looking it up by vapi_call_id ──
    let resolvedContactId = contactId;
    let resolvedCampaignId = campaignId;
    if ((!resolvedContactId || !resolvedCampaignId) && callId) {
      const ccRow = await db.execute(sql`
        SELECT contact_id, campaign_id FROM call_campaign_contacts
        WHERE vapi_call_id = ${callId} LIMIT 1
      `);
      const ccData = ccRow.rows?.[0] as any;
      if (ccData) {
        resolvedContactId  = resolvedContactId  ?? (ccData.contact_id  ? parseInt(ccData.contact_id)  : null);
        resolvedCampaignId = resolvedCampaignId ?? (ccData.campaign_id ? parseInt(ccData.campaign_id) : null);
      }
    }

    const analysis      = call.analysis ?? {};
    const successEval   = analysis.successEvaluation ?? "";
    const transcript    = msg.transcript ?? call.artifact?.transcript ?? "";
    const recordingUrl  = call.recordingUrl ?? call.artifact?.recordingUrl ?? null;
    const startedAt     = call.startedAt  ?? null;
    const endedAt       = call.endedAt    ?? null;

    // ── durationSeconds: prefer explicit field, compute from timestamps as fallback ──
    const durationSecs: number | null =
      (msg.durationSeconds != null)                          ? Math.round(Number(msg.durationSeconds)) :
      (call as any).durationSeconds != null                  ? Math.round(Number((call as any).durationSeconds)) :
      (startedAt && endedAt)                                 ? Math.round((new Date(endedAt).getTime() - new Date(startedAt).getTime()) / 1000) :
      null;

    // ── endedReason: use as primary outcome signal ──────────────────────────────
    // Vapi sends "no-answer", "voicemail", "busy", "failed" for unanswered calls.
    // "silence", "assistant-ended-call", "customer-ended-call", "hangup" all
    // mean the call was actually picked up and a conversation occurred.
    const endedReason: string = msg.endedReason ?? (call as any).endedReason ?? "";
    const UNANSWERED_REASONS = new Set(["no-answer", "voicemail", "busy", "failed", "machine-detected-speech", "machine-detected-greeting"]);
    const ANSWERED_REASONS   = new Set(["silence", "assistant-ended-call", "customer-ended-call", "hangup", "pipeline-error", "exceeded-max-duration"]);
    const calledWasAnswered  = ANSWERED_REASONS.has(endedReason) || (durationSecs !== null && durationSecs >= 10);
    const calledWasUnanswered = UNANSWERED_REASONS.has(endedReason);

    // ── Classify outcome — endedReason first, then keyword signals ──────────────
    const lowerEval = successEval.toLowerCase();
    const lowerTx   = transcript.toLowerCase();
    let outcome = calledWasUnanswered ? "no_answer" : (calledWasAnswered ? "answered" : "no_answer");
    if (calledWasAnswered) {
      // Upgrade "answered" to a more specific outcome based on keyword signals
      if (lowerTx.includes("do not call") || lowerTx.includes("remove me") || lowerTx.includes("stop calling") || lowerEval.includes("dnc")) {
        outcome = "dnc";
      } else if (lowerEval.includes("not_interested") || lowerEval.includes("not interested") || (lowerTx.includes("not interested") && !lowerTx.includes("interested in"))) {
        outcome = "not_interested";
      } else if (lowerEval.includes("interested") || lowerTx.includes("interested") || lowerTx.includes("send me more") || lowerTx.includes("tell me more")) {
        outcome = "interested";
      } else if (lowerEval.includes("callback") || lowerTx.includes("call me back") || lowerTx.includes("call back") || lowerTx.includes("schedule") || lowerTx.includes("follow up") || lowerTx.includes("book a")) {
        outcome = "callback";
      }
      // else remains "answered" — call was picked up but no strong keyword matched
    }

    const transcriptJson = transcript ? JSON.stringify({ text: transcript }) : null;

    // ── Auto-run transcript analysis so summary is available immediately ────────
    let aiSummary: string | null = null;
    let aiNextSteps: string | null = null;
    if (transcript) {
      const { analyseTranscript } = await import("../lib/transcriptAnalyser");
      // Fetch contact name for the summary (best-effort — may be null if not found)
      let contactName = "The contact";
      let companyName: string | null = null;
      if (resolvedContactId) {
        const cRow = await db.execute(sql`
          SELECT c.first_name, c.last_name, co.name AS company_name
          FROM contacts c
          LEFT JOIN companies co ON co.id = c.company_id
          WHERE c.id = ${resolvedContactId} AND c.tenant_id = ${tenantId}
          LIMIT 1
        `);
        const cd = cRow.rows?.[0] as any;
        if (cd) {
          contactName = [cd.first_name, cd.last_name].filter(Boolean).join(" ") || "The contact";
          companyName = cd.company_name ?? null;
        }
      }
      const result = analyseTranscript(transcript, outcome, durationSecs, contactName, companyName);
      aiSummary   = result.aiSummary;
      aiNextSteps = result.aiNextSteps;
    }

    // Upsert call_log
    await db.execute(sql`
      INSERT INTO call_logs (tenant_id, campaign_id, contact_id, vapi_call_id, status, outcome,
                             duration_seconds, transcript, recording_url, started_at, ended_at,
                             ended_reason, ai_summary, ai_next_steps, created_at)
      VALUES (${tenantId}, ${resolvedCampaignId}, ${resolvedContactId}, ${callId}, 'completed', ${outcome},
              ${durationSecs}, ${transcriptJson}::jsonb, ${recordingUrl},
              ${startedAt}::timestamptz, ${endedAt}::timestamptz,
              ${endedReason || null}, ${aiSummary}, ${aiNextSteps}, NOW())
      ON CONFLICT (vapi_call_id) DO UPDATE SET
        status           = 'completed',
        outcome          = EXCLUDED.outcome,
        duration_seconds = EXCLUDED.duration_seconds,
        transcript       = EXCLUDED.transcript,
        recording_url    = EXCLUDED.recording_url,
        started_at       = EXCLUDED.started_at,
        ended_at         = EXCLUDED.ended_at,
        ended_reason     = EXCLUDED.ended_reason,
        ai_summary       = COALESCE(call_logs.ai_summary, EXCLUDED.ai_summary),
        ai_next_steps    = COALESCE(call_logs.ai_next_steps, EXCLUDED.ai_next_steps)
    `);

    // Update campaign contact status
    if (resolvedCampaignId && resolvedContactId) {
      await db.execute(sql`
        UPDATE call_campaign_contacts
        SET status = 'done', vapi_call_id = ${callId}
        WHERE campaign_id = ${resolvedCampaignId} AND contact_id = ${resolvedContactId}
      `);
    }

    // Score delta based on outcome
    const SCORE_DELTAS: Record<string, number> = {
      interested: 15, callback: 8, answered: 5, no_answer: 0, not_interested: 0, dnc: -5,
    };
    const outcomeDelta = SCORE_DELTAS[outcome] ?? 0;

    // Pickup bonus: +10 for any call where the person answered and spoke for ≥ 10 seconds.
    // Excluded for DNC — they explicitly asked not to be called again, so net score stays negative.
    const pickedUp = calledWasAnswered && outcome !== "dnc";
    const pickupBonus = pickedUp ? 10 : 0;

    const scoreDelta = outcomeDelta + pickupBonus;

    if (resolvedContactId && scoreDelta !== 0) {
      await db.execute(sql`
        UPDATE contacts SET lead_score = GREATEST(0, LEAST(200, lead_score + ${scoreDelta}))
        WHERE id = ${resolvedContactId} AND tenant_id = ${tenantId}
      `);
    }

    // Log activity event
    if (resolvedContactId) {
      const callParts: string[] = [`Outbound call ${outcome.replace(/_/g, " ")}`];
      if (durationSecs) callParts.push(`${Math.round(durationSecs)}s`);
      if (pickupBonus > 0) callParts.push(`+${pickupBonus} pickup bonus`);
      if (endedReason) callParts.push(`(${endedReason})`);
      const description = callParts.join(" · ");
      await db.execute(sql`
        INSERT INTO activity_events (tenant_id, contact_id, event_type, description, score_delta, source, created_at)
        VALUES (${tenantId}, ${resolvedContactId}, 'call_completed', ${description}, ${scoreDelta}, 'vapi', NOW())
      `);
    }

    res.json({ ok: true, outcome });

    // ── Auto-add to DNC list for negative/opt-out outcomes ────────────────────
    if (resolvedContactId && resolvedCampaignId) {
      const isDnc         = outcome === "dnc";
      const isNotInterested = outcome === "not_interested";
      // Argumentative/hostile: negative sentiment + very low interest
      const isArgumentative = false; // filled after LLM analysis; handled in analyseTranscriptLLM callback

      if (isDnc || isNotInterested) {
        const dncReason = isDnc
          ? "Explicitly asked not to be called (do not call / remove me)"
          : "AI classified as not interested";
        await db.execute(sql`
          INSERT INTO call_dnc_contacts (tenant_id, contact_id, reason, source, campaign_id, added_at)
          VALUES (${tenantId}, ${resolvedContactId}, ${dncReason}, 'auto_ai', ${resolvedCampaignId}, NOW())
          ON CONFLICT (tenant_id, contact_id) DO NOTHING
        `).catch(() => {});
      }
    }

    // ── Fire LLM analysis non-blocking after responding ───────────────────────
    // ── Fire LLM analysis for every completed call — no transcript gate ──────
    // analyseTranscriptLLM handles empty/null transcripts internally by creating
    // a synthetic completed row (low score, neutral). Removing the gate here
    // ensures a call_analysis row is always created for every completed call.
    {
      const callLogIdQuery = await db.execute(sql`
        SELECT id, contact_id FROM call_logs
        WHERE vapi_call_id = ${callId} AND tenant_id = ${tenantId}
        LIMIT 1
      `).catch(() => ({ rows: [] }));
      const logRow = (callLogIdQuery.rows[0] as any);
      if (logRow?.id) {
        let contactName = "The contact";
        let companyName: string | null = null;
        const cid = logRow.contact_id ?? resolvedContactId;
        if (cid) {
          const cRow = await db.execute(sql`
            SELECT c.first_name, c.last_name, co.name AS company_name
            FROM contacts c
            LEFT JOIN companies co ON co.id = c.company_id
            WHERE c.id = ${cid} AND c.tenant_id = ${tenantId}
            LIMIT 1
          `).catch(() => ({ rows: [] }));
          const cd = (cRow.rows[0] as any);
          if (cd) {
            contactName = [cd.first_name, cd.last_name].filter(Boolean).join(" ") || "The contact";
            companyName = cd.company_name ?? null;
          }
        }
        import("../lib/transcriptAnalyserLLM").then(({ analyseTranscriptLLM }) => {
          analyseTranscriptLLM({
            callLogId:       parseInt(logRow.id),
            tenantId,
            contactId:       cid ?? null,
            transcript:      transcript ?? "",  // pass empty string — service creates synthetic row
            outcome,
            durationSeconds: durationSecs,
            contactName,
            companyName,
          }).then(async () => {
            // Auto-DNC if LLM detects strongly negative/argumentative sentiment with low interest.
            // Query the freshly-written call_analysis row rather than relying on the return value.
            if (cid) {
              const aRow = await db.execute(sql`
                SELECT sentiment, interest_score FROM call_analysis
                WHERE call_log_id = ${parseInt(logRow.id)} AND tenant_id = ${tenantId}
                LIMIT 1
              `).catch(() => ({ rows: [] }));
              const a = aRow.rows[0] as any;
              if (a && a.sentiment === "negative" && (a.interest_score ?? 10) <= 2) {
                const dncReason = "AI detected strongly negative / argumentative call (interest score ≤ 2)";
                await db.execute(sql`
                  INSERT INTO call_dnc_contacts (tenant_id, contact_id, reason, source, campaign_id, added_at)
                  VALUES (${tenantId}, ${cid}, ${dncReason}, 'auto_ai', ${resolvedCampaignId ?? null}, NOW())
                  ON CONFLICT (tenant_id, contact_id) DO NOTHING
                `).catch(() => {});
              }
            }
          }).catch(err => logger.warn({ err, callId }, "Background LLM analysis after webhook failed"));
        }).catch(() => {});
      }
    }
  } catch (err) {
    // Return 500 after auth so Vapi will retry the webhook delivery.
    // Only swallow errors before auth (non-call-report events handled above with early returns).
    logger.warn({ err }, "Vapi webhook processing error — returning 500 for retry");
    res.status(500).json({ error: "Webhook processing failed" });
  }
});

// ── POST /public/retell-webhook/:tenantId ─────────────────────────────────────
// Receives call_ended / call_analyzed events from RetellAI and updates
// call_logs + contact scores. tenantId is embedded in the URL.
router.post("/public/retell-webhook/:tenantId", async (req, res): Promise<void> => {
  try {
    const tenantId = req.params.tenantId ? parseInt(req.params.tenantId) : null;
    if (!tenantId) { res.status(401).json({ error: "Missing tenantId in URL" }); return; }

    // Optional HMAC verification via stored webhookSecret
    const retellCfg = await getIntegrationConfig(tenantId, "retellai");
    const storedSecret: string = retellCfg?.webhookSecret ?? "";
    if (storedSecret) {
      const sigHeader = (req.headers["x-retell-signature"] as string | undefined) ?? "";
      const { createHmac } = await import("crypto");
      const rawBody = JSON.stringify(req.body);
      const expected = createHmac("sha256", storedSecret).update(rawBody).digest("hex");
      if (sigHeader !== expected) {
        res.status(401).json({ error: "Invalid webhook signature" });
        return;
      }
    }

    const body = req.body as {
      event?: string;
      call?: {
        call_id?: string;
        start_timestamp?: number;
        end_timestamp?: number;
        recording_url?: string;
        transcript?: string;
        disconnection_reason?: string;
        call_analysis?: {
          call_summary?: string;
          user_sentiment?: string;
          call_successful?: boolean;
          in_voicemail?: boolean;
        };
        metadata?: {
          contactId?: string;
          campaignId?: string;
          tenantId?: string;
        };
      };
    };

    const { event, call } = body;
    if (!call?.call_id) { res.json({ ok: true }); return; }

    // Only process end-of-call events
    if (event !== "call_ended" && event !== "call_analyzed") {
      res.json({ ok: true }); return;
    }

    const retellCallId = call.call_id;
    const meta = call.metadata ?? {};

    // Resolve contactId / campaignId from metadata or call_logs lookup
    let contactId  = meta.contactId  ? parseInt(meta.contactId)  : null;
    let campaignId = meta.campaignId ? parseInt(meta.campaignId) : null;
    if (!contactId || !campaignId) {
      const ccRow = await db.execute(sql`
        SELECT contact_id, campaign_id FROM call_campaign_contacts
        WHERE retell_call_id = ${retellCallId} LIMIT 1
      `);
      const cc = ccRow.rows?.[0] as any;
      if (cc) {
        contactId  = contactId  ?? (cc.contact_id  ? parseInt(cc.contact_id)  : null);
        campaignId = campaignId ?? (cc.campaign_id ? parseInt(cc.campaign_id) : null);
      }
    }

    const durationSec = call.start_timestamp && call.end_timestamp
      ? Math.round((call.end_timestamp - call.start_timestamp) / 1000)
      : null;

    const transcript    = call.transcript ?? null;
    const recordingUrl  = call.recording_url ?? null;
    const endedReason   = call.disconnection_reason ?? null;

    logger.info({
      tenantId, retellCallId, event, contactId, campaignId, durationSec,
    }, "Retell webhook received");

    // Upsert call_logs
    const logResult = await db.execute(sql`
      INSERT INTO call_logs (
        tenant_id, campaign_id, contact_id, retell_call_id, provider,
        status, duration_seconds, transcript, recording_url, ended_reason,
        started_at, ended_at, created_at
      )
      VALUES (
        ${tenantId}, ${campaignId ?? null}, ${contactId ?? null}, ${retellCallId}, 'retell',
        'done', ${durationSec ?? null}, ${transcript ?? null}, ${recordingUrl ?? null}, ${endedReason ?? null},
        ${call.start_timestamp ? new Date(call.start_timestamp).toISOString() : null},
        ${call.end_timestamp   ? new Date(call.end_timestamp).toISOString()   : null},
        NOW()
      )
      ON CONFLICT (retell_call_id) WHERE retell_call_id IS NOT NULL DO UPDATE SET
        status           = 'done',
        duration_seconds = COALESCE(EXCLUDED.duration_seconds, call_logs.duration_seconds),
        transcript       = COALESCE(EXCLUDED.transcript,       call_logs.transcript),
        recording_url    = COALESCE(EXCLUDED.recording_url,    call_logs.recording_url),
        ended_reason     = COALESCE(EXCLUDED.ended_reason,     call_logs.ended_reason),
        started_at       = COALESCE(EXCLUDED.started_at,       call_logs.started_at),
        ended_at         = COALESCE(EXCLUDED.ended_at,         call_logs.ended_at)
      RETURNING id
    `);
    const logRow = logResult.rows?.[0] as any;

    // Mark campaign contact as done
    if (contactId && campaignId) {
      await db.execute(sql`
        UPDATE call_campaign_contacts
        SET status = 'done', last_attempted_at = NOW()
        WHERE retell_call_id = ${retellCallId}
          AND tenant_id = ${tenantId}
      `).catch(() => {});
    }

    // Award scoring points for completed call
    if (contactId) {
      const analysis = call.call_analysis;
      const voicemail = analysis?.in_voicemail ?? (endedReason === "voicemail_reached");
      if (!voicemail) {
        await db.execute(sql`
          UPDATE contacts
          SET score = LEAST(score + 15, 100), last_activity_at = NOW()
          WHERE id = ${contactId} AND tenant_id = ${tenantId}
        `).catch(() => {});
      }

      // Store call analysis if available
      if (logRow?.id && analysis) {
        const sentiment = analysis.user_sentiment ?? "neutral";
        const successful = analysis.call_successful ?? false;
        await db.execute(sql`
          INSERT INTO call_analysis (
            call_log_id, tenant_id, summary, sentiment, call_successful, in_voicemail,
            interest_score, created_at
          )
          VALUES (
            ${parseInt(logRow.id)}, ${tenantId},
            ${analysis.call_summary ?? null},
            ${sentiment},
            ${successful},
            ${voicemail},
            ${successful ? 8 : sentiment === "negative" ? 2 : 5},
            NOW()
          )
          ON CONFLICT (call_log_id) DO UPDATE SET
            summary        = COALESCE(EXCLUDED.summary,        call_analysis.summary),
            sentiment      = COALESCE(EXCLUDED.sentiment,      call_analysis.sentiment),
            call_successful= COALESCE(EXCLUDED.call_successful,call_analysis.call_successful),
            in_voicemail   = COALESCE(EXCLUDED.in_voicemail,   call_analysis.in_voicemail),
            interest_score = COALESCE(EXCLUDED.interest_score, call_analysis.interest_score)
        `).catch(() => {});

        // Auto-DNC on strongly negative calls
        if (sentiment === "negative" && !successful) {
          await db.execute(sql`
            INSERT INTO call_dnc_contacts (tenant_id, contact_id, reason, source, campaign_id, added_at)
            VALUES (${tenantId}, ${contactId}, 'Retell AI: negative sentiment / call unsuccessful', 'auto_ai', ${campaignId ?? null}, NOW())
            ON CONFLICT (tenant_id, contact_id) DO NOTHING
          `).catch(() => {});
        }
      }
    }

    res.json({ ok: true });
  } catch (err) {
    logger.warn({ err }, "Retell webhook processing error");
    res.status(500).json({ error: "Webhook processing failed" });
  }
});

export default router;
