import { pool } from "@workspace/db";
import { ReplitConnectors } from "@replit/connectors-sdk";
import { LookupBuyingCommitteeDomainBody, LookupBuyingCommitteeDomainResponse } from "@workspace/api-zod";
import type { z } from "zod";
import { committeeDomain, committeeError, committeeOwnedAccount, validateCommitteeSources } from "./buyingCommittee";
import { providerConfigured } from "./intentProviders";
type CommitteeDomainLookupInput = z.infer<typeof LookupBuyingCommitteeDomainBody>;
type CommitteeDomainLookupResult = z.infer<typeof LookupBuyingCommitteeDomainResponse>;
type CommitteeDomainCandidate = CommitteeDomainLookupResult["candidates"][number];

// Source pages are evidence to review, not an automated claim of legal ownership.
export function committeeSourceUrl(value: unknown): string {
  if (typeof value !== "string" || !committeeDomain(value)) return "";
  try {
    const url = new URL(value);
    if (!["https:", "http:"].includes(url.protocol)) return "";
    return url.href;
  } catch { return ""; }
}
const directories = /(^|\.)(linkedin\.com|facebook\.com|wikipedia\.org|crunchbase\.com|zoominfo\.com|apollo\.io|ambitionbox\.com|justdial\.com|indiamart\.com|bloomberg\.com)$/;
export function publicDomainCandidates(rows: any[], legalName: string, parentName: string | null = null): CommitteeDomainCandidate[] {
  const seen = new Set<string>();
  return rows.slice(0, 5).flatMap(row => {
    const sourceUrl = committeeSourceUrl(row.url), domain = committeeDomain(sourceUrl);
    if (!sourceUrl || directories.test(domain) || seen.has(domain)) return [];
    seen.add(domain);
    const evidence = [row.title, row.content ?? row.snippet].filter(v => typeof v === "string").join(" — ").slice(0, 1800);
    return [{ domain, sourceUrl, evidence, origin: "Public search result (verify on official site)",
      relationship: evidence.toLowerCase().includes(legalName.toLowerCase()) ? "legal-company" as const
        : parentName && evidence.toLowerCase().includes(parentName.toLowerCase()) ? "parent-company" as const : "uncertain" as const }];
  });
}

export async function lookupCommitteeDomain(tenantId: number, input: CommitteeDomainLookupInput): Promise<CommitteeDomainLookupResult> {
  if (!input.research) return lookupEvidence(tenantId, input);
  if (input.acknowledgeCost !== true) committeeError("Acknowledge the cost of one public search request.");
  // Cross-process tenant lock prevents parallel paid lookups from double clicks/tabs.
  const cx = await pool.connect();
  let locked = false;
  try {
    locked = (await cx.query("SELECT pg_try_advisory_lock(73231,$1::int) locked", [tenantId])).rows[0].locked;
    if (!locked) committeeError("A website research request is already running for this tenant. Wait for its result before requesting another.", 409);
    return await lookupEvidence(tenantId, input);
  } finally {
    try { if (locked) await cx.query("SELECT pg_advisory_unlock(73231,$1::int)", [tenantId]); }
    finally { cx.release(); }
  }
}
async function lookupEvidence(tenantId: number, input: CommitteeDomainLookupInput): Promise<CommitteeDomainLookupResult> {
  await validateCommitteeSources(tenantId, input.clientId, input.audienceIds);
  const account = await committeeOwnedAccount(tenantId, input);
  const profile = (await pool.query(`SELECT legal_name,parent_name FROM hp_account_profiles
    WHERE tenant_id=$1 AND client_id=$2 AND company_id=$3`, [tenantId, input.clientId, input.accountId])).rows[0];
  const legalName = profile?.legal_name?.trim() || account.name;
  const parentName = profile?.parent_name?.trim() || null;
  const candidates: CommitteeDomainCandidate[] = [];
  const add = (value: unknown, relationship: CommitteeDomainCandidate["relationship"], origin: string) => {
    const domain = committeeDomain(value);
    if (!domain || candidates.some(c => c.domain === domain && c.relationship === relationship)) return;
    candidates.push({ domain, sourceUrl: committeeSourceUrl(value) || `https://${domain}`,
      evidence: `${origin}: ${relationship === "parent-company" ? parentName : legalName}`, relationship, origin });
  };
  add(account.domain, "legal-company", "CRM domain on selected account");
  add(account.website, "legal-company", "CRM website on selected account");
  if (parentName && parentName.toLowerCase() !== legalName.toLowerCase()) {
    const parents = await pool.query(`SELECT domain,website FROM companies WHERE tenant_id=$1 AND client_id=$2
      AND lower(btrim(name))=lower($3) AND id<>$4 ORDER BY id LIMIT 5`, [tenantId, input.clientId, parentName, input.accountId]);
    parents.rows.forEach(p => { add(p.domain, "parent-company", "Roster parent matched to CRM"); add(p.website, "parent-company", "Roster parent matched to CRM"); });
  }
  const warnings = ["Suggestions are not proof of legal ownership. Open the source and confirm the selected legal employer, not just its group.",
    "No CRM change, plan approval, or Apollo sourcing occurs. Only explicitly confirmed domains enter the draft."];
  let provider: string | null = null, requests = 0;
  // Reuse owned evidence on every request. Paid work is always a separate acknowledged action.
  if (input.research) {
    if (input.acknowledgeCost !== true) committeeError("Acknowledge the cost of one public search request.");
    provider = await providerConfigured(tenantId, "tavily") ? "tavily"
      : await providerConfigured(tenantId, "perplexity") ? "perplexity" : null;
    if (!provider) committeeError("No public search provider is configured. Configure Tavily or Perplexity.", 409);
    const query = `"${legalName.slice(0, 200)}" official company website legal entity${parentName ? ` parent "${parentName.slice(0, 150)}"` : ""}`;
    requests = 1;
    try {
      let response: Response;
      if (provider === "tavily") {
        response = await fetch("https://api.tavily.com/search", { method: "POST",
          headers: { Authorization: `Bearer ${process.env.TAVILY_API_KEY}`, "Content-Type": "application/json" },
          signal: AbortSignal.timeout(20_000),
          body: JSON.stringify({ query, max_results: 5, search_depth: "basic", include_answer: false }) });
      } else {
        // The connector owns authentication. No retries or provider fan-out.
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          response = await Promise.race([new ReplitConnectors().proxy("perplexity", "/search", {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query, max_results: 5 }),
          }), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("timeout")), 20_000); })]);
        } finally { clearTimeout(timer); }
      }
      if (!response.ok) throw new Error("Provider rejected search");
      const data = await response.json() as { results?: unknown };
      if (!Array.isArray(data.results)) throw new Error("Invalid search response");
      for (const c of publicDomainCandidates(data.results, legalName, parentName)) if (!candidates.some(owned => owned.domain === c.domain)) candidates.push(c);
    } catch {
      committeeError("Public website search failed or timed out. One request may have incurred cost. Owned evidence is still available via Lookup website; retry only after renewed cost acknowledgement.", 502);
    }
  }
  if (!candidates.length) warnings.push("No supported website found. Do not infer a domain from the company name; confirm it manually from an official source.");
  if (candidates.length > 1) warnings.push("Multiple possible websites: resolve the legal-company identity before selecting.");
  if (candidates.some(c => c.relationship === "parent-company")) warnings.push("Parent-company evidence does not establish this legal company's employer domain.");
  const domains = [...new Set(candidates.map(c => c.domain))];
  if (domains.length) {
    const shared = await pool.query(`SELECT DISTINCT lower(regexp_replace(COALESCE(domain,''),'^www\\.','','i')) domain
      FROM companies WHERE tenant_id=$1 AND client_id=$2 AND id<>$3
      AND lower(regexp_replace(COALESCE(domain,''),'^www\\.','','i'))=ANY($4::text[]) LIMIT 10`,
    [tenantId, input.clientId, input.accountId, domains]);
    if (shared.rows.length) warnings.push(`Shared CRM domains: ${shared.rows.map(r => r.domain).join(", ")}. Review and source legal accounts separately.`);
  }
  return { accountId: input.accountId, legalName, parentName, candidates, warnings, provider, requests };
}
