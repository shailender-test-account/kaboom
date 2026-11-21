import type { Request, Response, NextFunction } from "express";
import { canAccess, type SectionKey } from "@workspace/api-zod";
import { pool } from "@workspace/db";

export function apiSection(path: string): SectionKey | null {
  if (/^\/sales\/accounts(?:\/|$)/.test(path)) return "sales";
  if (/^\/sales-feedback(\/|$)/.test(path)) return "gtm";
  if (/^\/contact-databases(\/|$)/.test(path)) return "database";
  if (/^\/contacts\/\d+\/verification(\/|$)/.test(path)) return "database";
  if (/^\/(auth|healthz|public|track|webhooks?|email-webhook)(\/|$)/.test(path)) return null;
  if (/^\/(team-access|users|admin|settings|integrations|smtp-accounts|scoring|scoring-rules|score-thresholds|stages)(\/|$)/.test(path)) return "settings";
  if (/^\/analytics\/dashboard(\/|$)/.test(path)) return "dashboard";
  if (/^\/intent\/(monitoring|monitoring-history|monitoring-config|monitoring-configs|monitoring-retry-options|monitoring-account-options|monitoring-roster-audience)(\/|$)/.test(path)) return "monitoring";
  if (/^\/intent\/inbound(\/|$)/.test(path)) return "gtm";
  if (/^\/intent(\/|$)/.test(path)) return "intent";
  if (/^\/buying-committee(\/|$)/.test(path)) return "committee";
  if (/^\/(analytics|accounts-analytics)(\/|$)/.test(path)) return "analytics";
  if (/^\/(dashboard)(\/|$)/.test(path)) return "dashboard";
  if (/^\/ai-answer(\/|$)/.test(path)) return "ai";
  if (/^\/(dnc|calls\/dnc|call-campaigns\/dnc)(\/|$)/.test(path)) return "dnc";
  if (/^\/(calls|call-campaigns)(\/|$)/.test(path)) return "calls";
  if (/^\/contest(\/|$)/.test(path)) return "contest";
  if (/^\/(forms|form-submissions|banners|cta-buttons|pitch-templates|media|page-components|storage)(\/|$)/.test(path)) return "library";
  if (/^\/(segments|imports|contacts-import)(\/|$)/.test(path)) return "database";
  if (/^\/contacts\/import(\/|$)/.test(path)) return "database";
  if (/^\/(journeys|journey-routing-rules)(\/|$)/.test(path)) return "journeys";
  if (/^\/(sequences|sequence-runs|email-sequences|email-templates)(\/|$)/.test(path)) return "sequences";
  if (/^\/engagement-history(\/|$)/.test(path)) return "contacts";
  const key = path.split("/")[1];
  return ["clients", "plays", "contacts", "companies", "deals", "templates"].includes(key) ? key as SectionKey : null;
}

export function sectionAccess(req: Request, res: Response, next: NextFunction): void {
  // Public endpoints continue through their existing authentication/validation.
  if (!req.isAuthenticated() || !req.user) return next();
  const user = req.user as any;
  if (user.role === "admin") return next();
  const path = req.path;
  if (/^\/auth(\/|$)/.test(path)) return next();
  if (req.method === "GET" && path.startsWith("/storage/public-objects/")) return next();
  // The unified Sales workspace shares feedback endpoints with embedded GTM
  // account cards. Neither grant exposes unrelated GTM imports or configuration.
  // Qualification review retains its separate administrator-only route guard.
  if (/^\/sales-feedback(?:\/|$)/.test(path)
      && canAccess(user, "sales", !["GET", "HEAD", "OPTIONS"].includes(req.method))) return next();
  if (req.method === "GET" && path === "/contacts" && canAccess(user, "database")) return next();
  if (req.method === "GET" && path === "/score-thresholds"
      && (["contacts","companies","database","analytics","dashboard","sales"] as const)
        .some(section => canAccess(user,section))) return next();
  // Analytics filter pickers need labels, not the entire CRM management API.
  // Return only tenant/client-scoped references when the target tab is denied.
  const referenceTables: Record<string, { table: string; section: SectionKey }> = {
    "/plays": {table:"abm_plays",section:"plays"},
    "/journeys": {table:"journeys",section:"journeys"},
    "/companies": {table:"companies",section:"companies"},
  };
  const reference = referenceTables[path];
  if (req.method === "GET" && reference && canAccess(user,"analytics") && !canAccess(user,reference.section)) {
    const allowed = Array.isArray(user.clientIds) ? user.clientIds : null;
    const selected = req.query.clientId === undefined ? null : Number(req.query.clientId);
    if (selected !== null && (!Number.isSafeInteger(selected) || selected <= 0 ||
        (allowed !== null && !allowed.includes(selected)))) {
      res.status(403).json({error:"This client is outside your access"}); return;
    }
    void pool.query(`SELECT id,name FROM ${reference.table} WHERE tenant_id=$1
      AND ($2::int[] IS NULL OR client_id=ANY($2::int[]))
      AND ($3::int IS NULL OR client_id=$3) ORDER BY name,id`,
    [user.tenantId,allowed,selected]).then(result => res.json(result.rows)).catch(next);
    return;
  }
  if (req.method === "GET" && path === "/analytics/calls/top-opportunities" && canAccess(user,"dashboard")) return next();
  if (req.method === "GET" && /^\/intent\/accounts\/\d+(?:\/score-breakdown)?$/.test(path)
      && (["analytics","monitoring","gtm"] as const).some(section => canAccess(user,section))) return next();
  // Restricted users need the authorized client picker even if they cannot
  // manage the Clients section. The list itself is filtered by clientAccess
  // and the clients route.
  if (req.method === "GET" && path === "/clients"
      && (["analytics", "dashboard", "sales", "gtm", "monitoring", "journeys", "contacts", "companies", "plays", "sequences", "committee", "database", "templates"] as const)
        .some(section => canAccess(user, section))) return next();
  // Scope pickers are shared read-only reference data, not access to the
  // management pages for the corresponding clients/roster.
  if (req.method === "GET" && ["/intent/scope-options", "/intent/catalog"].includes(path)
      && (["intent", "monitoring", "gtm", "committee"] as const).some(key => canAccess(user, key))) return next();
  // Team management is never delegated by a section grant.
  if (/^\/(users|team-access|admin|settings\/tenants)(\/|$)/.test(path)) {
    res.status(403).json({ error: "Administrator access required" }); return;
  }
  const section = apiSection(path);
  if (!section) {
    // Shared search is independently filtered. Notifications contain tenant-wide
    // details, so restricted users must not receive them.
    if (path === "/search" || path === "/notifications") return next();
    if (user.sectionPermissions == null || /^\/(public|track|healthz)(\/|$)/.test(path)) return next();
    res.status(403).json({ error: "This endpoint is not available with your section access" }); return;
  }
  // These reporting queries use POST only to carry bounded arrays of IDs.
  // Do not infer read access from a generic "/preview" suffix: other POSTs
  // may change data, call providers, or start background work.
  const reportQuery = req.method === "POST" && ["/analytics/gtm-status", "/analytics/acquisition"].includes(path);
  const write = !["GET", "HEAD", "OPTIONS"].includes(req.method) && !reportQuery;
  if (!canAccess(user, section, write)) {
    res.status(403).json({ error: write ? "Manage access is required for this section" : "You do not have access to this section" });
    return;
  }
  next();
}
