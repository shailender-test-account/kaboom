import type { Request, Response, NextFunction } from "express";
import { pool } from "@workspace/db";
import { authorizedClients } from "../lib/requestClientScope";

/**
 * A narrow, fail-closed boundary for users assigned to specific clients.
 * Legacy members (clientIds=null) keep their previous behavior. Do not add an
 * endpoint here until its own queries are proven to filter by client.
 */
export async function clientAccess(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!req.isAuthenticated() || !req.user) { next(); return; }
  const user = req.user as { tenantId: number; role: string; clientIds?: number[] | null };
  if (user.role === "admin" || !Array.isArray(user.clientIds)) { next(); return; }
  if (req.path.startsWith("/auth/")) { next(); return; }
  const ids = user.clientIds.filter(id => Number.isSafeInteger(id) && id > 0);
  const deny = () => res.status(403).json({ error: "This page or action is not available with client-restricted access" });
  if (!ids.length) { deny(); return; }
  const path = req.path;
  const read = req.method === "GET";
  // Sales already intersects ownership and the complete client grant itself.
  // Preserve its empty-result contract for out-of-scope list selections.
  if (/^\/sales\/accounts(?:\/|$)/.test(path)) { next(); return; }
  if (req.query.clientId !== undefined &&
      (typeof req.query.clientId !== "string" || !ids.includes(Number(req.query.clientId)))) {
    deny(); return;
  }
  // Trusted metadata cannot be supplied as a URL parameter. Reporting resolves
  // this to permitted account IDs before aggregating, including an empty set.
  Object.defineProperty(req, "query", { configurable: true,
    value: { ...req.query, [authorizedClients]: ids } });
  // These handlers explicitly intersect all queries with the user's complete
  // client set. Do not inject ids[0]: that silently hides other assigned clients.
  if (read && (
    /^\/analytics\/dashboard(?:\/(?:summary|panels))?$/.test(path)
    || /^\/intent\/inbound\/(?:sources|source|dashboard|accounts|contacts)$/.test(path)
    || path === "/intent/scope-options"
    || path === "/intent/catalog"
    || path === "/intent/inbound/category-rules"
    || path === "/intent/inbound/routing-rules"
    || path === "/buying-committee/options"
    || path === "/email-sequences"
    || path === "/intent/monitoring-configs"
    || /^\/intent\/monitoring-history(?:\/(?:accounts|batch-accounts))?$/.test(path)
    || path === "/notifications"
    || path === "/contact-databases"
    || path === "/score-thresholds"
    || /^\/analytics\/(?:traffic|stage-distribution|content-popularity|traffic-source|users-by-stage|contacts-drill|abm-data|landing-urls|scroll-depth|account-intelligence|journey-velocity|score-intelligence|playbook-recommendations|score-corrections|call-intelligence(?:\/aggregate)?|calls\/(?:top-opportunities|recent|export)|calls)$/.test(path)
  )) { next(); return; }
  // These resources are tenant-wide, with no client attribution. A restricted
  // user's collection is empty, not a broken page or disclosure of shared data.
  if (read && ["/templates", "/segments"].includes(path)) { res.json([]); return; }
  const single = path.match(/^\/(clients|companies|contacts|journeys|plays|sequences)\/(\d+)(?:\/(journeys|pages))?$/);
  const tables: Record<string, string> = {
    clients: "clients", companies: "companies", contacts: "contacts",
    journeys: "journeys", plays: "abm_plays", sequences: "sequences",
  };
  try {
    // These POSTs are bounded, read-only report lookups, not mutations.
    if(req.method==="POST" && ["/analytics/gtm-status","/analytics/acquisition"].includes(path)){
      for(const [field,table] of Object.entries({contactIds:"contacts",accountIds:"companies"})){
        const values=req.body?.[field];
        if(values===undefined && field==="accountIds" && path==="/analytics/gtm-status")continue;
        if(!Array.isArray(values)||values.length>200||values.some(id=>!Number.isSafeInteger(id)||id<=0)){
          res.status(400).json({error:"Provide bounded arrays of positive record IDs"});return;
        }
        const unique=[...new Set(values)];
        if(unique.length){
          const owned=await pool.query(`SELECT count(*)::int count FROM ${table}
            WHERE tenant_id=$1 AND id=ANY($2::bigint[]) AND client_id=ANY($3::int[])`,[user.tenantId,unique,ids]);
          if(owned.rows[0].count!==unique.length){deny();return;}
        }
      }
      next();return;
    }
    // These routes independently intersect every list/detail/mutation with the
    // complete permitted-client set; never silently replace it with ids[0].
    const committeePlan=read&&path.match(/^\/buying-committee\/plans\/(\d+)$/);
    if(committeePlan){
      const owned=await pool.query(`SELECT 1 FROM buying_committee_plans WHERE tenant_id=$1 AND id=$2 AND client_id=ANY($3::int[])`,
        [user.tenantId,Number(committeePlan[1]),ids]);
      if(!owned.rowCount){deny();return;}
      next();return;
    }
    const scopedDetail = read && path.match(/^\/(contacts|companies|plays|journeys)\/(\d+)\/(?:activities|submissions|plays|journeys|sequences|stage-history|timeline|contest-events|score-history|analytics|contacts|pages)$/);
    const analyticsDetail = read && path.match(/^\/analytics\/(plays|journeys)\/(\d+)(?:\/(?:page-stats|trends|events))?$/);
    if(scopedDetail||analyticsDetail){
      const match=(scopedDetail||analyticsDetail) as RegExpMatchArray;
      const record=await pool.query(`SELECT 1 FROM ${tables[match[1]]} WHERE tenant_id=$1 AND id=$2 AND client_id=ANY($3::int[])`,
        [user.tenantId,Number(match[2]),ids]);
      if(!record.rowCount){deny();return;}
      next();return;
    }
    const inboundAccount = read && path.match(/^\/intent\/inbound\/accounts\/(\d+)\/(?:responses|tracked-contact|anonymous-sessions)$/);
    const emailSequence = read && path.match(/^\/email-sequences\/(\d+)(?:\/(?:enrollments|canvas-stats)(?:\/\d+\/steps)?)?$/);
    if (inboundAccount || emailSequence) {
      const record = inboundAccount
        ? await pool.query(`SELECT 1 FROM companies WHERE tenant_id=$1 AND id=$2 AND client_id=ANY($3::int[])`,
          [user.tenantId,Number(inboundAccount[1]),ids])
        : await pool.query(`SELECT 1 FROM email_sequences s LEFT JOIN abm_plays p ON p.id=s.play_id AND p.tenant_id=s.tenant_id
          WHERE s.tenant_id=$1 AND s.id=$2 AND COALESCE(s.client_id,p.client_id)=ANY($3::int[])`,
          [user.tenantId,Number((emailSequence as RegExpMatchArray)[1]),ids]);
      if (!record.rowCount) { deny(); return; }
      next(); return;
    }
    let ownedClientId: number | undefined;
    if (single) {
      if (single[3] && !((single[1] === "clients" && single[3] === "journeys")
        || (single[1] === "journeys" && single[3] === "pages"))) { deny(); return; }
      if (!read && !["PATCH", "DELETE"].includes(req.method)) { deny(); return; }
      if (!read && single[3]) { deny(); return; }
      const table = tables[single[1]];
      const column = single[1] === "clients" ? "id" : "client_id";
      const result = await pool.query(`SELECT ${column} AS client_id FROM ${table}
        WHERE tenant_id=$1 AND id=$2`, [user.tenantId, Number(single[2])]);
      if (!result.rows.length || !ids.includes(Number(result.rows[0].client_id))) { deny(); return; }
      ownedClientId = Number(result.rows[0].client_id);
    } else if (read && path === "/clients") {
      // The client list applies its own exact filtering; do not inject a single
      // default client here, since the member may have multiple assignments.
      next(); return;
    } else if (read && /^\/intent\/accounts\/\d+(?:\/score-breakdown)?$/.test(path)) {
      const accountId = Number(path.split("/")[3]);
      const account = await pool.query(`SELECT client_id FROM companies WHERE tenant_id=$1 AND id=$2`,
        [user.tenantId, accountId]);
      if (!account.rows.length || !ids.includes(Number(account.rows[0].client_id))) { deny(); return; }
      ownedClientId = Number(account.rows[0].client_id);
    } else if (!(
      /^\/(companies|contacts|journeys|plays|sequences)$/.test(path)
      || (read && /^\/intent\/(accounts|companies|candidate-companies)$/.test(path))
      || (read && /^\/buying-committee\/(?:accounts|contacts|plans)$/.test(path))
      || (read && /^\/analytics\/hp-bi(?:\/(?:account|evidence|filter-options|heatmap|account-register|account-search|roster-analysis|warm-routing|imports|matches|export|template))?$/.test(path))
      || (read && /^\/sales-feedback(?:\/(?:options|sources|hot-follow-ups))?$/.test(path))
      || (read && /^\/sales-feedback\/hot-follow-ups\/\d+$/.test(path))
      || (!read && /^\/sales-feedback(?:\/(?:sources|hot-follow-ups\/\d+))?$/.test(path))
    )) {
      deny(); return;
    }
    if (!read && !["POST", "PATCH", "DELETE"].includes(req.method)) { deny(); return; }
    // List routes below are confirmed to filter on clientId; all other
    // tenant-wide reports, settings and exports are denied above.
    const rawQuery = req.query.clientId;
    const rawBody = req.body && typeof req.body === "object" ? req.body.clientId : undefined;
    const selected = rawQuery === undefined && rawBody === undefined
      ? (ownedClientId ?? ids[0]) : Number(rawQuery ?? rawBody);
    if (!Number.isSafeInteger(selected) || !ids.includes(selected) ||
        (rawQuery !== undefined && rawBody !== undefined && Number(rawQuery) !== Number(rawBody))) {
      deny(); return;
    }
    if (ownedClientId !== undefined && ownedClientId !== selected) { deny(); return; }
    const hotId = path.match(/^\/sales-feedback\/hot-follow-ups\/(\d+)$/);
    if (hotId) {
      const hot = await pool.query(`SELECT 1 FROM hp_hot_follow_ups
        WHERE tenant_id=$1 AND id=$2 AND client_id=$3`, [user.tenantId, Number(hotId[1]), selected]);
      if (!hot.rowCount) { deny(); return; }
    }
    // Validate referenced records as well as the nominal clientId: an attacker
    // can otherwise link a permitted action to another client's contact.
    const references: Record<string, string> = {
      accountId: "companies", companyId: "companies", contactId: "contacts",
      journeyId: "journeys", playId: "abm_plays", sequenceId: "email_sequences",
    };
    for (const [field, table] of Object.entries(references)) {
      const value = (req.body && typeof req.body === "object" ? req.body[field] : undefined) ?? req.query[field];
      if (value === undefined || value === null || value === "") continue;
      const n = Number(value);
      if (!Number.isSafeInteger(n) || n <= 0) { deny(); return; }
      const result = await pool.query(`SELECT 1 FROM ${table} WHERE tenant_id=$1 AND id=$2 AND client_id=$3`,
        [user.tenantId, n, selected]);
      if (!result.rowCount) { deny(); return; }
    }
    for (const [field, table] of Object.entries({
      accountIds: "companies", companyIds: "companies", contactIds: "contacts",
      journeyIds: "journeys", playIds: "abm_plays",
    })) {
      let values = (req.body && typeof req.body === "object" ? req.body[field] : undefined) ?? req.query[field];
      if (values === undefined) continue;
      if (read && typeof values === "string") values=values.split(",");
      if (!Array.isArray(values) || values.length > 100 ||
          values.some(value => !Number.isSafeInteger(Number(value)) || Number(value) <= 0)) { deny(); return; }
      const unique = [...new Set(values.map(Number))];
      if (unique.length) {
        const result = await pool.query(`SELECT count(*)::int AS count FROM ${table}
          WHERE tenant_id=$1 AND client_id=$2 AND id=ANY($3::int[])`, [user.tenantId, selected, unique]);
        if (Number(result.rows[0].count) !== unique.length) { deny(); return; }
      }
    }
    const assigneeId = req.body && typeof req.body === "object" ? req.body.assigneeId : undefined;
    if (assigneeId !== undefined && assigneeId !== null) {
      if (!Number.isSafeInteger(Number(assigneeId)) || Number(assigneeId) <= 0) { deny(); return; }
      const result = await pool.query(`SELECT 1 FROM users WHERE tenant_id=$1 AND id=$2
        AND (role='admin' OR client_ids IS NULL OR client_ids @> jsonb_build_array($3::int))`, [user.tenantId, Number(assigneeId), selected]);
      if (!result.rowCount) { deny(); return; }
    }
    if (!read && req.body && typeof req.body === "object") {
      const supported = new Set([...Object.keys(references),
        "accountIds", "companyIds", "contactIds", "journeyIds", "playIds", "assigneeId", "clientId"]);
      if (Object.keys(req.body).some(key => /Ids?$/.test(key) && !supported.has(key))) {
        deny(); return;
      }
    }
    if (read && rawQuery === undefined) {
      // Express 5's req.query is a getter; replace on this request only.
      Object.defineProperty(req, "query", { configurable: true, value: { ...req.query, clientId: String(selected) } });
    }
    if (!read && rawBody === undefined && !single && !hotId) { deny(); return; }
    next();
  } catch (error) { next(error); }
}
