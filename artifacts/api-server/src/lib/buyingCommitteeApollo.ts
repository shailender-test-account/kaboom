import { randomUUID } from "node:crypto";
import { pool } from "@workspace/db";
import { apolloCommitteeConfig, committeeDomain, committeeError, committeePlan, type CommitteeConfig } from "./buyingCommittee";
import { committeeCountry } from "./buyingCommitteeCountry";
import { findInternalCommitteeContacts } from "./buyingCommitteeInternal";

type ApolloPerson = {
  id?: string; name?: string; first_name?: string; last_name?: string; title?: string; email?: string;
  linkedin_url?: string; city?: string; state?: string; country?: string;
  phone_numbers?: { sanitized_number?: string; raw_number?: string }[];
  organization?: { primary_domain?: string; domain?: string; website_url?: string };
};
export function normalizeCommitteePeople(people: ApolloPerson[], ids: Set<string>, domain: string, country?: string) {
  return people.filter(p => p?.id && ids.has(p.id) && committeeDomain(
    p.organization?.primary_domain ?? p.organization?.domain ?? p.organization?.website_url) === domain
    && (!country || (!!committeeCountry(p.country) && committeeCountry(p.country) === committeeCountry(country))))
    .map(p => ({
      apolloId: p.id!, name: p.name?.trim() || [p.first_name, p.last_name].filter(Boolean).join(" "),
      title: p.title || null,
      email: p.email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.email) && !p.email.includes("email_not_unlocked") ? p.email : null,
      phone: p.phone_numbers?.[0]?.sanitized_number || p.phone_numbers?.[0]?.raw_number || null,
      linkedin: p.linkedin_url && /^https?:\/\/([a-z]+\.)?linkedin\.com\//i.test(p.linkedin_url) ? p.linkedin_url : null,
      location: [p.city, p.state, committeeCountry(p.country) ?? p.country].filter(Boolean).join(", ") || null,
    })).filter(p => p.name && !p.name.includes("*"));
}

/** Charge bounds and attempts are durable, including uncertain/network-failed requests. */
async function reserveRequest(tenantId: number, planId: number, targetId: number, lease: string, budget: number) {
  const cx = await pool.connect();
  try {
    await cx.query("BEGIN");
    await cx.query("SELECT id FROM buying_committee_plans WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [tenantId, planId]);
    const usage = await cx.query(`SELECT COALESCE(sum(requests),0)::int n FROM buying_committee_targets WHERE tenant_id=$1 AND plan_id=$2`, [tenantId, planId]);
    if (usage.rows[0].n >= budget) committeeError("Apollo request limit reached for this plan. Prior attempts are retained; review usage before creating a new approved plan.", 409);
    const reserved = await cx.query(`UPDATE buying_committee_targets SET requests=requests+1
      WHERE tenant_id=$1 AND id=$2 AND lease=$3 AND status='processing' RETURNING id`, [tenantId, targetId, lease]);
    if (!reserved.rowCount) committeeError("This sourcing attempt no longer owns the account. Reload the plan.", 409);
    await cx.query("COMMIT");
  } catch (err) { await cx.query("ROLLBACK"); throw err; } finally { cx.release(); }
}
async function apolloRequest<T>(tenantId: number, planId: number, targetId: number, lease: string,
  budget: number, key: string, endpoint: string, body: unknown, query = ""): Promise<T> {
  await reserveRequest(tenantId, planId, targetId, lease, budget);
  let response: Response;
  try {
    response = await fetch(`https://api.apollo.io/api/v1/${endpoint}${query}`, {
      method: "POST", headers: { "Content-Type": "application/json", "X-Api-Key": key, accept: "application/json" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(25_000),
    });
  } catch {
    committeeError("Apollo did not confirm a response. The request attempt is retained because it may have consumed credits. No automatic retry was made.", 502);
  }
  // Usage belongs to the account's full history even if a newer attempt fenced this one.
  await pool.query(`UPDATE buying_committee_targets SET responses=responses+1 WHERE tenant_id=$1 AND id=$2`,
    [tenantId, targetId]);
  if (!response!.ok) committeeError(`Apollo returned HTTP ${response!.status}. ${response!.status === 429 ? "Rate limit reached; wait before an explicit retry." : "Check your Apollo API permissions, plan and credits."} No automatic retry was made.`, 502);
  try { return await response!.json() as T; } catch { committeeError("Apollo returned an unreadable response. The attempt is retained; no automatic retry was made.", 502); }
}

/** Explicit, admin-approved manual action only. No background polling or auto-retries. */
export async function sourceCommitteeAccount(tenantId: number, planId: number, companyId: number, retry: boolean) {
  const { plan, targets } = await committeePlan(tenantId, planId);
  if (plan.status !== "approved") committeeError("Review and approve the saved draft before sourcing.", 409);
  const target = targets.find(t => t.company_id === companyId);
  if (!target) committeeError("The account is no longer available in this plan.", 404);
  if (target.status === "completed") return { status: "completed" };
  const config = plan.config as CommitteeConfig;
  const country = committeeCountry(config.country);
  if (!country) committeeError("This approved plan has no contact country. Create and approve a new country-specific plan before sourcing. Existing contacts are retained.", 409);
  const lease = randomUUID();
  const claimed = await pool.query(`UPDATE buying_committee_targets SET status='processing',lease=$4,started_at=NOW(),completed_at=NULL,error=NULL
    WHERE tenant_id=$1 AND plan_id=$2 AND company_id=$3 AND (
      status='pending' OR ($5::boolean AND (status='failed' OR (status='processing' AND started_at<NOW()-interval '5 minutes'))))
    RETURNING id,domain`, [tenantId, planId, companyId, lease, retry]);
  if (!claimed.rowCount) committeeError("This account is already being sourced, or requires an explicit retry. Wait for the current attempt to finish; interrupted attempts can be retried after five minutes.", 409);
  const { id: targetId, domain } = claimed.rows[0];
  try {
     const internalIds = await findInternalCommitteeContacts(tenantId, plan.client_id, companyId, country,
       config.designations, config.limitPerAccount);
     if (internalIds.length) {
       const cx = await pool.connect();
       try {
         await cx.query("BEGIN");
         const owned = await cx.query(`SELECT t.id FROM buying_committee_targets t
           JOIN companies co ON co.id=t.company_id AND co.tenant_id=t.tenant_id AND co.client_id=$4
           WHERE t.tenant_id=$1 AND t.id=$2 AND t.lease=$3 AND t.status='processing' FOR UPDATE OF t`,
         [tenantId, targetId, lease, plan.client_id]);
         if (!owned.rowCount) committeeError("The account was changed or deleted while sourcing. No contacts were attributed.", 409);
         // Lock the people through attribution so deletion/account correction cannot race this save.
         const current = await cx.query(`SELECT id FROM contacts WHERE tenant_id=$1 AND client_id=$2
           AND company_id=$3 AND id=ANY($4::int[]) FOR UPDATE`,
         [tenantId, plan.client_id, companyId, internalIds]);
         if (current.rowCount !== internalIds.length)
           committeeError("Internal contacts changed while sourcing. Review the account before an explicit retry.", 409);
         const rechecked = await findInternalCommitteeContacts(tenantId, plan.client_id, companyId, country,
           config.designations, config.limitPerAccount, cx);
         if (rechecked.length !== internalIds.length || rechecked.some(id => !internalIds.includes(id)))
           committeeError("Internal contact targeting changed while sourcing. Review before an explicit retry.", 409);
         await cx.query(`INSERT INTO buying_committee_internal_contacts(tenant_id,client_id,company_id,contact_id,target_id,categories)
           SELECT $1::int,$2::int,$3::int,id,$5::int,$6::jsonb FROM contacts WHERE id=ANY($4::int[])
           AND tenant_id=$1 AND client_id=$2 AND company_id=$3
           ON CONFLICT(target_id,contact_id) DO NOTHING`,
         [tenantId, plan.client_id, companyId, internalIds, targetId, JSON.stringify(config.categories)]);
         await cx.query(`UPDATE buying_committee_targets SET status='completed',found=$4,completed_at=NOW(),error=NULL
           WHERE tenant_id=$1 AND id=$2 AND lease=$3 AND status='processing'`,
         [tenantId, targetId, lease, internalIds.length]);
         await cx.query("COMMIT");
       } catch (err) { await cx.query("ROLLBACK"); throw err; } finally { cx.release(); }
       return { status: "completed" };
     }
     // Never reserve credits or even load provider credentials when the internal database has matches.
     const provider = await apolloCommitteeConfig(tenantId);
     if (!provider.configured) committeeError("No matching internal contacts were found. Configure Contact discovery in Settings → Integrations to use external sourcing.", 409);
    if (!committeeDomain(domain)) committeeError("This account has no approved company domain.", 409);
    const budget = Math.min(config.requestBudget ?? 20, provider.maxRequests);
    const search = new URLSearchParams({ page: "1", per_page: String(config.limitPerAccount),
      include_similar_titles: "true", "q_organization_domains_list[]": domain });
    for (const title of config.designations) search.append("person_titles[]", title);
    search.append("person_locations[]", country);
    const payload = await apolloRequest<{people?:ApolloPerson[]}>(tenantId, planId, targetId, lease, budget, provider.apiKey!,
      "mixed_people/api_search", {}, `?${search}`);
    if (!Array.isArray(payload.people)) committeeError("Apollo search returned an unexpected format. No contacts were saved.", 502);
    const ids = [...new Set<string>(payload.people.map((p: ApolloPerson) => p?.id).filter((id: unknown): id is string => typeof id === "string" && id.length > 0))].slice(0, config.limitPerAccount);
    let people: ReturnType<typeof normalizeCommitteePeople> = [];
    if (ids.length) {
      const details = await apolloRequest<{matches?:(ApolloPerson|null)[]}>(tenantId, planId, targetId, lease, budget, provider.apiKey!,
        "people/bulk_match", { details: ids.map(id => ({ id })), reveal_personal_emails: false, reveal_phone_number: false });
      if (!Array.isArray(details.matches)) committeeError("Apollo enrichment returned an unexpected format. No unverified contacts were saved.", 502);
      people = normalizeCommitteePeople(details.matches.filter((p):p is ApolloPerson=>p!==null), new Set(ids), domain, country);
      if (details.matches.some(Boolean) && !people.length) committeeError("Apollo returned contacts without a verified match to both the approved company domain and contact country. No contacts were attributed; review the company and country before an explicit retry.", 409);
    }
    const cx = await pool.connect();
    try {
      await cx.query("BEGIN");
      const owned = await cx.query(`SELECT t.id FROM buying_committee_targets t
        JOIN companies c ON c.id=t.company_id AND c.tenant_id=t.tenant_id AND c.client_id=$4
        WHERE t.tenant_id=$1 AND t.id=$2 AND t.lease=$3 AND t.status='processing' FOR UPDATE OF t`,
      [tenantId, targetId, lease, plan.client_id]);
      if (!owned.rowCount) committeeError("The account was changed or deleted while sourcing. No contacts were attributed.", 409);
      for (const p of people) {
        await cx.query(`INSERT INTO buying_committee_contacts(tenant_id,client_id,company_id,apollo_id,name,title,email,phone,linkedin,location,categories)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
          ON CONFLICT(tenant_id,client_id,company_id,apollo_id) DO UPDATE SET
          name=EXCLUDED.name,title=EXCLUDED.title,email=COALESCE(EXCLUDED.email,buying_committee_contacts.email),
          phone=COALESCE(EXCLUDED.phone,buying_committee_contacts.phone),linkedin=COALESCE(EXCLUDED.linkedin,buying_committee_contacts.linkedin),
          location=EXCLUDED.location,sourced_at=NOW(),
          categories=(SELECT jsonb_agg(DISTINCT value) FROM jsonb_array_elements(buying_committee_contacts.categories||EXCLUDED.categories))`,
        [tenantId, plan.client_id, companyId, p.apolloId, p.name, p.title, p.email, p.phone, p.linkedin, p.location, JSON.stringify(config.categories)]);
      }
      await cx.query(`UPDATE buying_committee_targets SET status='completed',found=$4,completed_at=NOW(),error=NULL
        WHERE tenant_id=$1 AND id=$2 AND lease=$3`, [tenantId, targetId, lease, people.length]);
      await cx.query("COMMIT");
    } catch (err) { await cx.query("ROLLBACK"); throw err; } finally { cx.release(); }
    return { status: "completed" };
  } catch (err: any) {
    const message = err.status ? err.message : "Sourcing could not be completed. Prior attempts and completed accounts are retained. Review before an explicit retry.";
    await pool.query(`UPDATE buying_committee_targets SET status='failed',error=$4,completed_at=NOW()
      WHERE tenant_id=$1 AND id=$2 AND lease=$3 AND status='processing'`, [tenantId, targetId, lease, message]);
    if (err.status) throw err;
    committeeError(message, 502);
  }
}
