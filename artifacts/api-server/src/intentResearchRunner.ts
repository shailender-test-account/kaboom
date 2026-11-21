import { pool } from "@workspace/db";
import type { PoolClient } from "pg";
import { ensureIntentDefaults, eventFingerprint } from "./lib/alwaysOnIntent";
import { fetchExploriumEvents, fetchNewsEvents, fetchPerplexityEvents, fetchTavilyEvents, IntentProviderError, type ProviderEvent, type ProviderStats, type ResearchProvider } from "./lib/intentProviders";
import { logger } from "./lib/logger";
import { fetchTavilyWithPerplexityFallback } from "./lib/providerFallback";
import { RESEARCH_FITMENT_POLICY_VERSION, rebuildStoredResearchOpportunityLocally, refreshStoredResearchOpportunity } from "./lib/researchOpportunityInterpreter";
import { autoReviewPendingResearch } from "./lib/researchEvidenceAutoReview";
import { researchGeographyAssessment } from "./lib/researchGeography";
import { isUnattributedResearch as isUnattributedProcurement } from "./lib/publicResearchAttribution";
import { copiedDataSafetyEnabled, monitoringResearchAllowed, MONITORING_RUN_SCOPE_SQL } from "./lib/monitoringResearchPolicy";
import { assertResearchAccountLease, heartbeatResearchAccount, ResearchAccountLeaseLost, RESEARCH_ACCOUNT_HEARTBEAT_MS } from "./lib/researchAccountLease";
import { resolveHpResearchSubject, type HpResearchSubject } from "./lib/hpParentResearch";
import { ResearchRunnerRecovery, settleResearchBatch } from "./lib/researchRunnerRecovery";

const RESEARCH_TICK_MS = 5_000;
const ACCOUNT_BATCH_SIZE = 4;
const STALE_ACCOUNT_MINUTES = 10;
const POLICY_REBUILD_PROVIDER = "local_policy_rebuild";
const POLICY_REBUILD_DISCOVERY_BATCH = 100;
const POLICY_REBUILD_MAX_ATTEMPTS = 5;

type ResearchRun = {
  id: number;
  tenant_id: number;
  client_id: number | null;
  audience_id: number | null;
  provider: ResearchProvider | typeof POLICY_REBUILD_PROVIDER;
  request_count: number;
  confirmed_request_count: number;
  request_limit: number | null;
  summary: {
    request?: { eventTypes?: string[]; country?: string; categoryIds?: number[] };
    [key: string]: unknown;
  };
};

type ResearchRunAccount = {
  id: number;
  account_id: number;
  attempts: number;
};

let tickActive = false;
let wakeTimer: NodeJS.Timeout | undefined;
const recovery = new ResearchRunnerRecovery();

const numberFrom = (value: unknown) => Number.isFinite(Number(value)) ? Number(value) : 0;

async function refreshRunSummary(run: ResearchRun) {
  const usage = await pool.query<{ request_count: number; confirmed_request_count: number; request_limit: number | null }>(
    "SELECT request_count,confirmed_request_count,request_limit FROM intent_research_runs WHERE tenant_id=$1 AND id=$2",
    [run.tenant_id, run.id],
  );
  const accounts = await pool.query<{
    status: string;
    summary: Record<string, unknown>;
    error: string | null;
  }>(
    `SELECT status,summary,error
       FROM intent_research_run_accounts
      WHERE tenant_id=$1 AND run_id=$2
      ORDER BY id`,
    [run.tenant_id, run.id],
  );
  const totals = {
    accountsTotal: accounts.rows.length,
    accountsCompleted: 0,
    accountsRemaining: 0,
    accountsFailed: 0,
    accountsInterpreted: 0,
    requests: numberFrom(usage.rows[0]?.confirmed_request_count),
    requestAttempts: numberFrom(usage.rows[0]?.request_count),
    pages: 0,
    retries: 0,
    rateLimited: 0,
    recordsFetched: 0,
    recordsNormalized: 0,
    inserted: 0,
    duplicates: 0,
    fallbackAccounts: 0,
    primaryProviderFailures: 0,
  };
  const failures: string[] = [];
  for (const account of accounts.rows) {
    if (account.status === "completed") totals.accountsCompleted += 1;
    else if (account.status === "failed") totals.accountsFailed += 1;
    else totals.accountsRemaining += 1;
    if (account.summary?.interpreted) totals.accountsInterpreted += 1;
    for (const key of ["pages", "retries", "rateLimited", "recordsFetched", "recordsNormalized", "inserted", "duplicates"] as const) {
      totals[key] += numberFrom(account.summary?.[key]);
    }
    if(account.summary?.fallbackProvider==="perplexity")totals.fallbackAccounts+=1;
    if(account.summary?.primaryProviderFailed===true)totals.primaryProviderFailures+=1;
    if (account.error) failures.push(account.error);
  }
  const terminal = totals.accountsRemaining === 0;
  const status = terminal
    ? totals.accountsFailed === totals.accountsTotal ? "failed" : totals.accountsFailed ? "partial" : "completed"
    : "running";
  const summary = {
    ...run.summary,
    ...totals,
    ...(run.summary.monitoringLane==="warm"||run.summary.monitoringLane==="prospect"
      ? {laneCounts:{
          ...(run.summary.laneCounts as Record<string,unknown>|undefined),
          completed:totals.accountsCompleted,
          failed:totals.accountsFailed,
        }}
      : {}),
    cost: {
      provider: run.provider,
      confirmedBillableRequests: totals.requests,
      maximumBillableRequests: numberFrom(usage.rows[0]?.request_count),
      unit: "provider_request",
    },
    usageLimit: usage.rows[0]?.request_limit ?? undefined,
    failures: failures.slice(0, 100),
  };
  await pool.query(
    `UPDATE intent_research_runs
        SET status=$1,summary=$2,error=$3,completed_at=CASE WHEN $4 THEN NOW() ELSE NULL END
      WHERE tenant_id=$5 AND id=$6 AND status IN ('queued','running')`,
    [status, summary, terminal && failures.length ? failures[0] : null, terminal, run.tenant_id, run.id],
  );
}

async function reserveRunRequest(run: ResearchRun, account: ResearchRunAccount) {
  const reserved = await pool.query(
    `UPDATE intent_research_runs
        SET request_count=request_count+1
      WHERE tenant_id=$1 AND id=$2 AND status IN ('queued','running') AND (request_limit IS NULL OR request_count<request_limit)
        AND EXISTS(SELECT 1 FROM intent_research_run_accounts a
          WHERE a.tenant_id=$1 AND a.run_id=$2 AND a.id=$3 AND a.attempts=$4 AND a.status='running'
            AND a.started_at>=NOW()-interval '10 minutes')
      RETURNING request_count`,
    [run.tenant_id, run.id, account.id, account.attempts],
  );
  if (!reserved.rows[0]) throw new Error("Research run request limit reached");
}

async function confirmRunRequest(run: ResearchRun) {
  await pool.query(
    `UPDATE intent_research_runs
        SET confirmed_request_count=confirmed_request_count+1
      WHERE tenant_id=$1 AND id=$2 AND confirmed_request_count<request_count`,
    [run.tenant_id, run.id],
  );
}

async function persistAccountEvidence(run: ResearchRun, account: ResearchRunAccount, rows: ProviderEvent[], stats: ProviderStats, subject?: HpResearchSubject) {
  const accountId = subject?.accountId ?? account.account_id;
  await assertResearchAccountLease(run.tenant_id, run.id, account);
  const company = await pool.query<{ name: string; domain: string | null }>(
    "SELECT name,domain FROM companies WHERE tenant_id=$1 AND id=$2",
    [run.tenant_id, accountId],
  );
  if (!company.rows[0]) throw new Error(`Account ${accountId} is no longer available`);

  const client = await pool.connect();
  let connectionError: Error | undefined;
  let rollbackFailed = false;
  const onConnectionError = (error: Error) => {
    connectionError = error;
    logger.warn({ runId: run.id, accountId: account.account_id }, "Research evidence connection lost");
  };
  client.on("error", onConnectionError);
  let inserted = 0;
  let duplicates = 0;
  try {
    await client.query("BEGIN");
    const ownership = await client.query(`SELECT id FROM intent_research_run_accounts
      WHERE tenant_id=$1 AND run_id=$2 AND id=$3 AND attempts=$4 AND status='running'
        AND started_at>=NOW()-interval '10 minutes' FOR UPDATE`,
      [run.tenant_id, run.id, account.id, account.attempts]);
    if (!ownership.rowCount) throw new ResearchAccountLeaseLost();
    for (const row of rows) {
      if (isUnattributedProcurement({
        eventType: row.eventType,
        searchKind: row.context?.searchKind as string | undefined,
        excerpt: row.excerpt,
        originalExcerpt: typeof row.context?.originalExcerpt==="string"?row.context.originalExcerpt:row.excerpt,
        sourceUrl: row.sourceUrl,
        companyName: company.rows[0].name,
        companyDomain: company.rows[0].domain,
      })) continue;
      const hasStableSource=Boolean(row.context?.sourceIdentity||row.sourceUrl);
      const fingerprint = `${eventFingerprint({
        // A single source is one evidence item. Its provider/AI label may change, but that
        // must not create duplicate cards with contradictory classifications.
        eventType: hasStableSource?"public_event_source":row.eventType,
        accountId,
        occurredAt: row.occurredAt,
        context: hasStableSource?{sourceIdentity:row.context?.sourceIdentity??row.sourceUrl}:row.context,
      })}:product:unscoped`;
      const evidence = await client.query(
        `INSERT INTO intent_evidence(
           tenant_id,research_run_id,account_id,evidence_kind,event_type,event_fingerprint,
           source_url,excerpt,provider,confidence,context,raw_evidence,review_status,occurred_at
         )
         VALUES($1,$2,$3,'public_event',$4,$5,$6,$7,$8,$9,$10,$11,'pending_review',$12)
         ON CONFLICT (tenant_id,event_fingerprint) WHERE event_fingerprint IS NOT NULL DO NOTHING
         RETURNING id`,
        [
          run.tenant_id,
          run.id,
          accountId,
          row.eventType,
          fingerprint,
          row.sourceUrl ?? null,
          row.excerpt,
          typeof row.context?.searchProvider==="string"?row.context.searchProvider:run.provider,
          row.confidence,
          {
            ...row.context,
            ...(subject ? { researchSubject: subject } : {}),
            researchGeography: researchGeographyAssessment(row, run.summary.request?.country ?? "India"),
            scope: {
              clientId: run.client_id,
              audienceId: run.audience_id,
              country: run.summary.request?.country ?? "India",
              categoryIds: run.summary.request?.categoryIds ?? [],
            },
          },
          row,
          row.occurredAt,
        ],
      );
      evidence.rows[0] ? inserted += 1 : duplicates += 1;
    }
    await client.query("COMMIT");
    if (connectionError) throw connectionError;
  } catch (error) {
    // Preserve the original failure; a broken socket cannot roll back, and a
    // failed rollback must not return a possibly open transaction to the pool.
    if (!connectionError) {
      await client.query("ROLLBACK").catch(rollbackError => {
        rollbackFailed = true;
        logger.warn({ runId: run.id, accountId: account.account_id, err: rollbackError }, "Research evidence rollback failed");
      });
    }
    throw error;
  } finally {
    client.release(Boolean(connectionError || rollbackFailed));
    client.removeListener("error", onConnectionError);
  }
  const aiReview = inserted ? await autoReviewPendingResearch(run.tenant_id, accountId) : { reviewed: 0, approved: 0, rejected: 0, pending: 0 };
  const opportunityBrief=await refreshStoredResearchOpportunity(run.tenant_id,accountId,run.summary.request?.country);
  return { ...stats, received: rows.length, inserted, duplicates, pendingReview: aiReview.pending, aiReview, interpreted: Boolean(opportunityBrief) };
}

export async function processRunAccount(run: ResearchRun, account: ResearchRunAccount) {
  let subject: HpResearchSubject | undefined;
  let subjectLock: PoolClient | undefined;
  let subjectConnectionError: Error | undefined;
  const onSubjectConnectionError = (error: Error) => {
    subjectConnectionError = error;
    logger.warn({ runId: run.id, accountId: account.account_id }, "Parent research connection lost; stopping new provider requests");
  };
  let heartbeatActive = false;
  let leaseError: unknown;
  const heartbeat = setInterval(() => {
    if (heartbeatActive || leaseError) return;
    heartbeatActive = true;
    void heartbeatResearchAccount(run.tenant_id, run.id, account)
      .then(owned => { if (!owned) leaseError = new ResearchAccountLeaseLost(); })
      .catch(error => {
        leaseError = error;
        logger.warn({ runId: run.id, accountId: account.account_id, err: error }, "Research account heartbeat failed");
      })
      .finally(() => { heartbeatActive = false; });
  }, RESEARCH_ACCOUNT_HEARTBEAT_MS);
  heartbeat.unref();
  try {
    await assertResearchAccountLease(run.tenant_id, run.id, account);
    await ensureIntentDefaults(run.tenant_id);
    const eventTypes = run.summary.request?.eventTypes;
    const country = run.summary.request?.country ?? "India";
    subject = await resolveHpResearchSubject(run.tenant_id, account.account_id);
    await pool.query(`UPDATE intent_research_run_accounts SET summary=summary||jsonb_build_object('researchSubject',$1::jsonb)
      WHERE tenant_id=$2 AND id=$3 AND attempts=$4 AND status='running'`,
      [JSON.stringify(subject), run.tenant_id, account.id, account.attempts]);
    if (subject.scope === "parent") {
      subjectLock = await pool.connect();
      // Checked-out clients emit errors too; the pool's idle listener cannot
      // protect this session-scoped advisory lock.
      subjectLock.on("error", onSubjectConnectionError);
      await subjectLock.query("SELECT pg_advisory_lock(hashtextextended($1,0))",
        [`hp-parent-check:${run.tenant_id}:${subject.accountId}:${country.toLowerCase()}`]);
      // Siblings share one parent check, not one provider bill per legal member.
      const previous = await subjectLock.query(`SELECT a.id FROM intent_research_run_accounts a
        JOIN intent_research_runs r ON r.tenant_id=a.tenant_id AND r.id=a.run_id
        WHERE a.tenant_id=$1 AND r.client_id=$2 AND a.status='completed'
          AND a.summary->'researchSubject'->>'accountId'=$3
          AND lower(COALESCE(r.summary->'request'->>'country','India'))=lower($4)
          AND COALESCE(r.summary->'request'->'categoryIds','[]'::jsonb)=COALESCE($5::jsonb,'[]'::jsonb)
          AND COALESCE(r.summary->'request'->'eventTypes','[]'::jsonb)=COALESCE($6::jsonb,'[]'::jsonb)
          AND a.summary->>'reusedParentCheck' IS DISTINCT FROM 'true'
          AND a.completed_at>NOW()-interval '7 days'
        ORDER BY a.completed_at DESC LIMIT 1`,
        [run.tenant_id, run.client_id, String(subject.accountId), country,
          JSON.stringify(run.summary.request?.categoryIds ?? []), JSON.stringify(eventTypes ?? [])]);
      if (previous.rows.length && subject.accountId !== account.account_id) {
        await pool.query(`UPDATE intent_research_run_accounts SET status='completed',summary=$1,error=NULL,completed_at=NOW()
          WHERE tenant_id=$2 AND id=$3 AND attempts=$4 AND status='running'`,
          [{ researchSubject: subject, reusedParentCheck: true, country }, run.tenant_id, account.id, account.attempts]);
        return;
      }
    }
    const requestScope = {
          clientId: run.client_id ?? undefined,
          // Audience authorizes the selected member; the separate parent identity is
          // resolved server-side and is deliberately not added to that audience.
          audienceId: subject.scope === "parent" ? undefined : run.audience_id ?? undefined,
          accountIds: [subject.accountId],
          eventTypes,
           country,
          beforeRequest: async () => {
            if (!monitoringResearchAllowed()) throw new Error("Research automation is paused");
            if (subjectConnectionError) throw subjectConnectionError;
            if (leaseError) throw leaseError;
            await reserveRunRequest(run, account);
          },
          afterRequest: () => confirmRunRequest(run),
        };
    const fetched = run.provider === "perplexity" ? await fetchPerplexityEvents(run.tenant_id, requestScope)
      : run.provider === "tavily" ? await fetchTavilyWithPerplexityFallback(run.tenant_id, requestScope,{fetchTavilyEvents,fetchPerplexityEvents})
      : run.provider === "explorium" ? await fetchExploriumEvents(run.tenant_id, requestScope)
      : await fetchNewsEvents(run.tenant_id, {
          clientId: run.client_id ?? undefined,
          audienceId: subject.scope === "parent" ? undefined : run.audience_id ?? undefined,
          accountIds: [subject.accountId],
           country,
          beforeRequest: requestScope.beforeRequest,
          afterRequest: requestScope.afterRequest,
          failOnPartial: true,
        });
    const summary = { ...await persistAccountEvidence(run, account, fetched.rows, fetched.stats, subject), researchSubject: subject };
    await pool.query(
      `WITH completed AS (
         UPDATE intent_research_run_accounts
            SET status='completed',summary=$1,error=NULL,completed_at=NOW()
          WHERE tenant_id=$2 AND id=$3 AND attempts=$4 AND status='running'
          RETURNING account_id
       )
       UPDATE companies company SET last_researched_at=NOW()
         FROM completed
        WHERE company.tenant_id=$2 AND company.id=$5`,
      [summary, run.tenant_id, account.id, account.attempts, subject.accountId],
    );
  } catch (error) {
    if (error instanceof ResearchAccountLeaseLost) return;
    const message = error instanceof Error ? error.message : "Account research failed";
    let stats: Record<string, unknown> = error instanceof IntentProviderError ? error.stats : {};
    if (error instanceof IntentProviderError && error.partialRows.length) {
      stats = await persistAccountEvidence(run, account, error.partialRows, error.stats, subject);
    }
    await pool.query(
      `UPDATE intent_research_run_accounts
          SET status='failed',summary=$1,error=$2,completed_at=NOW()
        WHERE tenant_id=$3 AND id=$4 AND attempts=$5 AND status='running'`,
      [{ ...stats, ...(subject ? { researchSubject: subject } : {}) }, message, run.tenant_id, account.id, account.attempts],
    );
    logger.warn({ runId: run.id, accountId: account.account_id, err: message }, "Intent account research failed");
  } finally {
    clearInterval(heartbeat);
    if (subjectLock && subject) {
      if (!subjectConnectionError) await subjectLock.query("SELECT pg_advisory_unlock(hashtextextended($1,0))",
        [`hp-parent-check:${run.tenant_id}:${subject.accountId}:${(run.summary.request?.country ?? "India").toLowerCase()}`])
        .catch(error => {
          subjectConnectionError = error;
          logger.warn({ err: error }, "Parent research lock release failed");
        });
      // A failed unlock must not return a possibly locked session to the pool.
      subjectLock.release(Boolean(subjectConnectionError));
      subjectLock.removeListener("error", onSubjectConnectionError);
    }
  }
}

async function claimRunAccounts(run: ResearchRun) {
  return pool.query<ResearchRunAccount>(
    `WITH next_accounts AS (
       SELECT id
         FROM intent_research_run_accounts
        WHERE tenant_id=$1
          AND run_id=$2
          AND EXISTS (SELECT 1 FROM intent_research_runs r WHERE r.tenant_id=$1 AND r.id=$2 AND r.status IN ('queued','running'))
          AND (
            status='pending'
            OR (status='running' AND started_at < NOW()-($3::text || ' minutes')::interval)
          )
        ORDER BY id
        FOR UPDATE SKIP LOCKED
        LIMIT $4
     )
     UPDATE intent_research_run_accounts account
        SET status='running',attempts=account.attempts+1,started_at=NOW(),completed_at=NULL,error=NULL
       FROM next_accounts
      WHERE account.id=next_accounts.id
      RETURNING account.id,account.account_id,account.attempts`,
    [run.tenant_id, run.id, STALE_ACCOUNT_MINUTES, ACCOUNT_BATCH_SIZE],
  );
}

async function processResearchRun(run: ResearchRun) {
  await pool.query(
    "UPDATE intent_research_runs SET status='running' WHERE tenant_id=$1 AND id=$2 AND status='queued'",
    [run.tenant_id, run.id],
  );
  const claimed = await claimRunAccounts(run);
  await settleResearchBatch(claimed.rows.map(account => processRunAccount(run, account)));
  await refreshRunSummary(run);
}

export async function enqueueOutdatedResearchBriefs() {
  const candidates=await pool.query<{tenant_id:number;account_id:number}>(`WITH latest_briefs AS (
      SELECT DISTINCT ON (e.tenant_id,e.account_id) e.tenant_id,e.account_id,e.context->'opportunityBrief' AS brief
        FROM intent_evidence e
       WHERE e.account_id IS NOT NULL AND e.evidence_kind='public_event'
         AND e.review_status<>'rejected' AND e.context ? 'opportunityBrief'
       ORDER BY e.tenant_id,e.account_id,e.occurred_at DESC,e.id DESC
    )
    SELECT latest.tenant_id,latest.account_id FROM latest_briefs latest
     WHERE CASE WHEN latest.brief->>'fitmentPolicyVersion' ~ '^[0-9]+$'
       THEN (latest.brief->>'fitmentPolicyVersion')::int ELSE 0 END<$1
       AND EXISTS(SELECT 1 FROM intent_evidence approved
         WHERE approved.tenant_id=latest.tenant_id AND approved.account_id=latest.account_id
           AND approved.evidence_kind='public_event' AND approved.review_status='approved'
           AND approved.occurred_at>=NOW()-interval '3 months')
       AND NOT EXISTS(
         SELECT 1 FROM intent_research_runs maintenance
         JOIN intent_research_run_accounts maintenance_account
           ON maintenance_account.tenant_id=maintenance.tenant_id AND maintenance_account.run_id=maintenance.id
         WHERE maintenance.tenant_id=latest.tenant_id
           AND maintenance.idempotency_key=$3
           AND maintenance_account.account_id=latest.account_id
       )
     ORDER BY latest.tenant_id,latest.account_id LIMIT $2`,
  [RESEARCH_FITMENT_POLICY_VERSION,POLICY_REBUILD_DISCOVERY_BATCH,`brief-policy:${RESEARCH_FITMENT_POLICY_VERSION}`]);
  for(const candidate of candidates.rows){
    await pool.query(`WITH maintenance_run AS (
        INSERT INTO intent_research_runs(tenant_id,provider,status,idempotency_key,request_limit,summary)
        VALUES($1,$2,'running',$3,0,jsonb_build_object('maintenance','brief_policy_rebuild','policyVersion',$4::int,'providerRequests',0))
        ON CONFLICT (tenant_id,idempotency_key) DO UPDATE SET
          status=CASE WHEN intent_research_runs.status IN ('completed','failed','partial') THEN 'running' ELSE intent_research_runs.status END,
          completed_at=NULL
        RETURNING id
      )
      INSERT INTO intent_research_run_accounts(tenant_id,run_id,account_id)
      SELECT $1,id,$5 FROM maintenance_run
      ON CONFLICT (tenant_id,run_id,account_id) DO NOTHING`,
    [candidate.tenant_id,POLICY_REBUILD_PROVIDER,`brief-policy:${RESEARCH_FITMENT_POLICY_VERSION}`,RESEARCH_FITMENT_POLICY_VERSION,candidate.account_id]);
  }
  return candidates.rows.length;
}

export async function processPolicyRebuildRun(run:ResearchRun) {
  const claimed=await claimRunAccounts(run);
  await settleResearchBatch(claimed.rows.map(async account=>{
    try{
      const outcome=await rebuildStoredResearchOpportunityLocally(run.tenant_id,account.account_id);
      await pool.query(`UPDATE intent_research_run_accounts
        SET status='completed',summary=jsonb_build_object('outcome',$1,'policyVersion',$2,'providerRequests',0),
            error=NULL,completed_at=NOW()
        WHERE tenant_id=$3 AND run_id=$4 AND id=$5`,
      [outcome,RESEARCH_FITMENT_POLICY_VERSION,run.tenant_id,run.id,account.id]);
    }catch(error){
      const message=error instanceof Error?error.message:"Local brief rebuild failed";
      await pool.query(`UPDATE intent_research_run_accounts
        SET status=CASE WHEN attempts<$1 THEN 'pending' ELSE 'failed' END,
            error=$2,completed_at=CASE WHEN attempts<$1 THEN NULL ELSE NOW() END
        WHERE tenant_id=$3 AND run_id=$4 AND id=$5`,
      [POLICY_REBUILD_MAX_ATTEMPTS,message,run.tenant_id,run.id,account.id]);
      logger.warn({runId:run.id,tenantId:run.tenant_id,accountId:account.account_id,err:message},"Local research brief policy rebuild failed");
    }
  }));
  await refreshRunSummary(run);
}

async function tickResearchRuns() {
  if (tickActive || !monitoringResearchAllowed() || !recovery.ready()) return;
  tickActive = true;
  try {
    const monitoringOnly = copiedDataSafetyEnabled();
    if (!monitoringOnly) await enqueueOutdatedResearchBriefs();
    const runs = await pool.query<ResearchRun>(
      `SELECT r.id,r.tenant_id,r.client_id,r.audience_id,r.provider,r.request_count,r.confirmed_request_count,r.request_limit,r.summary
         FROM intent_research_runs r
        WHERE r.status IN ('queued','running')
          AND ($1::boolean=false OR ${MONITORING_RUN_SCOPE_SQL})
        ORDER BY r.started_at,r.id
        LIMIT 10`,
      [monitoringOnly],
    );
    for (const run of runs.rows) {
      if (["newsapi", "perplexity", "tavily", "explorium"].includes(run.provider)) await processResearchRun(run);
      else if(run.provider===POLICY_REBUILD_PROVIDER)await processPolicyRebuildRun(run);
    }
    if (monitoringOnly) {
      recovery.succeeded();
      return;
    }
    const backlog = await pool.query<{ tenant_id: number; account_id: number }>(
      `SELECT tenant_id,account_id FROM intent_evidence
        WHERE evidence_kind='public_event' AND review_status='pending_review'
        GROUP BY tenant_id,account_id ORDER BY min(created_at) LIMIT 1`,
    );
    if (backlog.rows[0]) {
      await autoReviewPendingResearch(backlog.rows[0].tenant_id, backlog.rows[0].account_id);
      await refreshStoredResearchOpportunity(backlog.rows[0].tenant_id,backlog.rows[0].account_id);
    }
    recovery.succeeded();
  } catch (error) {
    const retryAfterMs = recovery.failed();
    logger.warn({ err: error, retryAfterMs }, "Intent research runner tick failed");
  } finally {
    tickActive = false;
  }
}

export function kickIntentResearchRunner() {
  if (wakeTimer) clearTimeout(wakeTimer);
  wakeTimer = setTimeout(() => {
    wakeTimer = undefined;
    void tickResearchRuns();
  }, 0);
  wakeTimer.unref();
}

export function startIntentResearchRunner() {
  kickIntentResearchRunner();
  setInterval(() => { void tickResearchRuns(); }, RESEARCH_TICK_MS).unref();
}
