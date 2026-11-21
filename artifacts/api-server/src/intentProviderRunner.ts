import { pool } from "@workspace/db";
import { ensureIntentDefaults, eventFingerprint, matchEntities } from "./lib/alwaysOnIntent";
import { fetchApolloContacts, fetchNewsEvents, IntentProviderError } from "./lib/intentProviders";
import { logger } from "./lib/logger";

const PROVIDER_TICK_MS = 6 * 60 * 60 * 1000;

function bucket(provider: string, tenantId: number) {
  return `scheduled:${provider}:${tenantId}:${Math.floor(Date.now() / PROVIDER_TICK_MS)}`;
}

async function runScheduledNews(tenantId: number) {
  const key = bucket("newsapi", tenantId);
  if ((await pool.query("SELECT 1 FROM intent_research_runs WHERE tenant_id=$1 AND idempotency_key=$2", [tenantId, key])).rowCount) return;
  let runId: number | undefined;
  try {
    const run = await pool.query<{ id: number }>(
      `INSERT INTO intent_research_runs(tenant_id,provider,status,idempotency_key,summary)
       VALUES($1,'newsapi','running',$2,'{}') RETURNING id`,
      [tenantId, key],
    );
    runId = run.rows[0].id;
    await ensureIntentDefaults(tenantId);
    const fetched = await fetchNewsEvents(tenantId, {});
    let inserted = 0, duplicates = 0;
    for (const row of fetched.rows) {
      if (!row.accountId) continue;
      const hasStableSource=Boolean(row.context?.sourceIdentity||row.sourceUrl);
      const fingerprint = `${eventFingerprint({
        eventType:hasStableSource?"public_event_source":row.eventType,
        accountId:row.accountId,
        occurredAt:row.occurredAt,
        context:hasStableSource?{sourceIdentity:row.context?.sourceIdentity??row.sourceUrl}:row.context,
      })}:product:unscoped`;
      const result = await pool.query(
        `INSERT INTO intent_evidence(tenant_id,research_run_id,account_id,evidence_kind,event_type,event_fingerprint,source_url,excerpt,provider,confidence,context,raw_evidence,review_status,occurred_at)
         VALUES($1,$2,$3,'public_event',$4,$5,$6,$7,'newsapi',$8,$9,$10,'pending_review',$11)
         ON CONFLICT (tenant_id,event_fingerprint) WHERE event_fingerprint IS NOT NULL DO NOTHING`,
        [tenantId, runId, row.accountId, row.eventType, fingerprint, row.sourceUrl ?? null, row.excerpt, row.confidence, row.context, { scheduled: true }, row.occurredAt],
      );
      result.rowCount ? inserted += 1 : duplicates += 1;
    }
    await pool.query("UPDATE intent_research_runs SET status=$1,summary=$2,completed_at=NOW() WHERE tenant_id=$3 AND id=$4", [fetched.stats.failures.length ? "partial" : "completed", { ...fetched.stats, inserted, duplicates }, tenantId, runId]);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Scheduled NewsAPI run failed";
    const stats = error instanceof IntentProviderError ? error.stats : {};
    if (runId) await pool.query("UPDATE intent_research_runs SET status='failed',summary=$1,error=$2,completed_at=NOW() WHERE tenant_id=$3 AND id=$4", [stats, message, tenantId, runId]);
    logger.warn({ tenantId, err: message }, "Scheduled intent research failed");
  }
}

async function runScheduledContacts(tenantId: number) {
  const key = bucket("apollo", tenantId);
  if ((await pool.query("SELECT 1 FROM intent_contact_discovery_runs WHERE tenant_id=$1 AND idempotency_key=$2", [tenantId, key])).rowCount) return;
  let runId: number | undefined;
  try {
    const run = await pool.query<{ id: number }>(
      `INSERT INTO intent_contact_discovery_runs(tenant_id,provider,status,idempotency_key,criteria,summary)
       VALUES($1,'apollo','running',$2,'{}','{}') RETURNING id`,
      [tenantId, key],
    );
    runId = run.rows[0].id;
    const fetched = await fetchApolloContacts(tenantId, { seniorities: [], functions: [], locations: [] });
    let inserted = 0, uncertain = 0;
    for (const candidate of fetched.rows) {
      const match = await matchEntities(tenantId, { email: candidate.email, phone: candidate.phone });
      const status = match.conflict || (match.contactId && match.accountId !== candidate.companyId) ? "uncertain_match" : match.contactId ? "matched" : "pending_review";
      if (status === "uncertain_match") uncertain += 1;
      await pool.query(
        `INSERT INTO intent_contact_discovery_candidates(tenant_id,run_id,company_id,first_name,last_name,email,phone,title,function,location,source_url,provider,confidence,raw_evidence,match_status,canonical_contact_id)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'apollo',$12,$13,$14,$15)`,
        [tenantId, runId, candidate.companyId, candidate.firstName ?? null, candidate.lastName ?? null, candidate.email?.toLowerCase() ?? null, candidate.phone ?? null, candidate.title ?? null, candidate.function ?? null, candidate.location ?? null, candidate.sourceUrl ?? null, candidate.confidence, candidate.rawEvidence, status, match.contactId ?? null],
      );
      inserted += 1;
    }
    await pool.query("UPDATE intent_contact_discovery_runs SET status=$1,summary=$2,completed_at=NOW() WHERE tenant_id=$3 AND id=$4", [fetched.stats.failures.length ? "partial" : "preview", { ...fetched.stats, inserted, uncertain }, tenantId, runId]);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Scheduled Apollo run failed";
    const stats = error instanceof IntentProviderError ? error.stats : {};
    if (runId) await pool.query("UPDATE intent_contact_discovery_runs SET status='failed',summary=$1,error=$2,completed_at=NOW() WHERE tenant_id=$3 AND id=$4", [stats, message, tenantId, runId]);
    logger.warn({ tenantId, err: message }, "Scheduled contact discovery failed");
  }
}

export async function runScheduledIntentProviders() {
  const configured = await pool.query<{ tenant_id: number; provider: string }>(
    `SELECT tenant_id,provider FROM tenant_integrations
      WHERE provider IN ('newsapi','apollo') AND (coalesce(config->>'apiKey','')<>'' OR config ? '_credentials')
        AND coalesce((config->>'enabled')::boolean,true)`,
  );
  await Promise.all(configured.rows.map(row => row.provider === "newsapi" ? runScheduledNews(row.tenant_id) : runScheduledContacts(row.tenant_id)));
}

export function startIntentProviderRunner() {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try { await runScheduledIntentProviders(); }
    catch (error) { logger.warn({ err: error }, "Intent provider scheduler failed"); }
    finally { running = false; }
  };
  setTimeout(() => { void tick(); }, 60_000).unref();
  setInterval(() => { void tick(); }, PROVIDER_TICK_MS).unref();
}