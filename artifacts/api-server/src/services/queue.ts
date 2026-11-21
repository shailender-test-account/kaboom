import { pool } from "@workspace/db";
import { getIntegrationConfig, CredentialStoreError } from "../lib/integrationCredentials";
import { logger } from "../lib/logger";

// ── Types ──────────────────────────────────────────────────────────────────

export interface SequenceJob {
  enrollmentId: number;
  stepId: number;
  sequenceId: number;
  contactId: number;
  tenantId: number;
  /** Present when created by a sequence run — used for run completion tracking. */
  runId?: number;
}

export interface RunEnrollmentJob {
  runId: number;
  sequenceId: number;
  tenantId: number;
}

export type EnqueueResult = "enqueued" | "duplicate" | "unavailable" | "error";

// ── Per-tenant queue registry ──────────────────────────────────────────────
//
// BullMQ Queue and Worker instances are bound to a specific IORedis connection.
// Each tenant can configure their own Upstash URL in Settings → Integrations.
// At enqueue time, _resolveTenantSet resolves the tenant's URL from
// tenant_integrations, lazy-inits a dedicated connection + queue pair, and
// calls the registered workerFactory so workers are also started for that
// connection — guaranteeing jobs are actually consumed.
// Tenants without a stored URL share the global fallback (UPSTASH_REDIS_URL).

interface TenantQueueSet {
  queue: any;      // BullMQ Queue ("sequence-steps")
  runQueue: any;   // BullMQ Queue ("sequence-runs")
  connection: any; // IORedis — owned exclusively by this set
  workers: any[];
}

const _tenantSets = new Map<number, TenantQueueSet>();

let _globalSet: TenantQueueSet | null = null;
let _globalInitialized = false;
let _globalUrl: string | undefined;

// BullMQ Worker class — cached after first dynamic import
let _WorkerClass: any = null;

// Worker factory: injected by index.ts after workers are wired up.
// Returns the created worker instances so they can be tracked in the tenant set
// and closed cleanly by invalidateTenantQueueCache.
type WorkerFactory = (connection: any) => Promise<any[]>;
let _workerFactory: WorkerFactory | null = null;

/** Register the factory used to start workers for new per-tenant connections. */
export function setWorkerFactory(fn: WorkerFactory): void {
  _workerFactory = fn;
}

/**
 * Invalidate the cached queue set for a tenant so the next enqueue re-reads
 * from tenant_integrations and picks up the new Upstash URL.
 * Called by the PUT /integrations/upstash handler after saving new config.
 */
export function invalidateTenantQueueCache(tenantId: number): void {
  const existing = _tenantSets.get(tenantId);
  if (existing && existing !== _globalSet) {
    // Gracefully close the old connection — do not await (fire-and-forget cleanup).
    for (const w of existing.workers.splice(0)) {
      w.close().catch(() => {});
    }
    existing.queue?.close().catch(() => {});
    existing.runQueue?.close().catch(() => {});
    existing.connection?.quit().catch(() => {});
  }
  _tenantSets.delete(tenantId);
  logger.info({ tenantId }, "Tenant queue cache invalidated — new config will be resolved at next enqueue");
}

// ── Internal helpers ───────────────────────────────────────────────────────

async function _loadBullMQ(): Promise<{ Queue: any; Worker: any }> {
  const { Queue, Worker } = await import("bullmq");
  _WorkerClass = Worker;
  return { Queue, Worker };
}

async function _makeSet(redisUrl: string): Promise<TenantQueueSet> {
  const { Queue } = await _loadBullMQ();
  const { default: IORedis } = await import("ioredis");
  const connection = new IORedis(redisUrl, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    tls: redisUrl.startsWith("rediss://") ? {} : undefined,
  });
  return {
    queue:      new Queue("sequence-steps", { connection }),
    runQueue:   new Queue("sequence-runs",  { connection }),
    connection,
    workers: [],
  };
}

/** Read a tenant's Upstash Redis URL from the server-managed credential store. */
async function _readTenantRedisUrl(tenantId: number): Promise<string | undefined> {
  try {
    const config = await getIntegrationConfig(tenantId, "upstash");
    const url = config?.redisUrl;
    return typeof url === "string" && url ? url : undefined;
  } catch (err: any) {
    if (err instanceof CredentialStoreError) throw err;
    if (err?.code !== "42P01") {
      logger.warn({ err, tenantId }, "Error reading tenant Upstash config");
    }
    return undefined;
  }
}

/**
 * Resolve (and lazily create) the queue set for a given tenant.
 * Priority: tenant's stored Upstash URL → global env-var fallback.
 * When a new tenant-specific set is created, the registered workerFactory is
 * called so workers are started for that connection immediately.
 */
async function _resolveTenantSet(tenantId: number): Promise<TenantQueueSet | null> {
  if (process.env.COPIED_DATA_SAFE_MODE === "true") return null;
  if (_tenantSets.has(tenantId)) return _tenantSets.get(tenantId)!;

  const tenantUrl = await _readTenantRedisUrl(tenantId);

  if (tenantUrl) {
    // Reuse global set if the URL matches (avoids duplicate connections).
    if (_globalSet && tenantUrl === _globalUrl) {
      _tenantSets.set(tenantId, _globalSet);
      return _globalSet;
    }
    // New URL: create a dedicated connection + queue pair and start workers for it.
    try {
      const set = await _makeSet(tenantUrl);
      _tenantSets.set(tenantId, set);
      logger.info({ tenantId }, "Tenant queue set initialised from stored Upstash config");
      if (_workerFactory) {
        _workerFactory(set.connection)
          .then(workers => { set.workers.push(...workers); })
          .catch(err =>
            logger.error({ err, tenantId }, "Failed to start workers for tenant queue set")
          );
      } else {
        logger.warn({ tenantId }, "Worker factory not registered — tenant queue set has no workers");
      }
      return set;
    } catch (err) {
      logger.error({ err, tenantId }, "Failed to initialise tenant BullMQ set — falling back to global");
    }
  }

  // Fall back to global set
  if (_globalSet) _tenantSets.set(tenantId, _globalSet);
  return _globalSet;
}

// ── Public init API ────────────────────────────────────────────────────────

/**
 * Initialise the global (env-var) queue set at server startup.
 * Per-tenant sets are created lazily at enqueue time via _resolveTenantSet.
 */
export async function initQueue(urlOverride?: string): Promise<void> {
  if (process.env.COPIED_DATA_SAFE_MODE === "true") return;
  if (_globalInitialized) return;
  _globalInitialized = true;

  const redisUrl = urlOverride ?? process.env.UPSTASH_REDIS_URL;
  if (!redisUrl) {
    logger.warn("No Redis URL available — sequence job queue disabled (configure via Settings → Integrations)");
    return;
  }

  try {
    _globalUrl = redisUrl;
    _globalSet = await _makeSet(redisUrl);
    logger.info("BullMQ global sequence queues initialised");
  } catch (err) {
    logger.error({ err }, "Failed to initialise global BullMQ queues");
  }
}

// ── Worker registration ────────────────────────────────────────────────────

/** Register a worker instance for cleanup on future reinit. */
export function registerWorker(worker: any, tenantId?: number): void {
  if (tenantId !== undefined) {
    const set = _tenantSets.get(tenantId);
    if (set) { set.workers.push(worker); return; }
  }
  _globalSet?.workers.push(worker);
}

// ── Queue availability check ───────────────────────────────────────────────

/**
 * Async, tenant-aware availability check.
 * Proactively resolves (and caches) the tenant's queue set so the result
 * reflects actual connection readiness — not just DB URL presence.
 * Returns true only when a functional queue set is available for this tenant
 * (either their own connection or the global env-var fallback).
 * Used by runEnrollmentService to decide BullMQ vs inline path.
 */
export async function isTenantQueueAvailable(tenantId: number): Promise<boolean> {
  // Fast path: already cached — check working queue exists.
  if (_tenantSets.has(tenantId)) return !!_tenantSets.get(tenantId)?.queue;
  // Attempt to resolve (and cache) the set now so the caller gets an accurate answer
  // and enqueueStep immediately after uses the pre-warmed cache.
  const set = await _resolveTenantSet(tenantId);
  return !!set?.queue;
}

/** Synchronous global-only check (used by sequence-worker internal paths). */
export function isStepQueueAvailable(): boolean { return !!_globalSet?.queue; }

// ── Enqueue helpers ────────────────────────────────────────────────────────

export async function enqueueStep(job: SequenceJob, delayMs = 0): Promise<void> {
  const set = await _resolveTenantSet(job.tenantId);
  if (!set?.queue) {
    logger.info({ job }, "Queue not ready — step skipped");
    return;
  }
  await set.queue.add("process-step", job, {
    delay: delayMs,
    attempts: 3,
    backoff: { type: "exponential", delay: 5000 },
  });
}

/**
 * Bulk-enqueue step jobs in a single Redis round-trip (all jobs must share a tenant).
 * Throws on failure so the caller can compensate the affected enrollments.
 */
export async function enqueueStepsBulk(jobs: SequenceJob[]): Promise<void> {
  if (jobs.length === 0) return;
  const set = await _resolveTenantSet(jobs[0].tenantId);
  if (!set?.queue) {
    // Throw (don't silently drop): the caller compensates the affected
    // enrollments, otherwise they'd stay 'active' forever with no queued job
    // and the run would never complete.
    throw new Error("Step queue unavailable — cannot bulk-enqueue");
  }
  await set.queue.addBulk(
    jobs.map(j => ({
      name: "process-step",
      data: j,
      opts: { attempts: 3, backoff: { type: "exponential" as const, delay: 5000 } },
    }))
  );
}

/**
 * Enqueue a run enrollment job.
 * @returns EnqueueResult — callers must only fire in-process fallback on "unavailable" or "error".
 */
export async function enqueueRunStart(data: RunEnrollmentJob, delayMs = 0): Promise<EnqueueResult> {
  const set = await _resolveTenantSet(data.tenantId);
  if (!set?.runQueue) return "unavailable";
  try {
    await set.runQueue.add("start-run", data, {
      // Deduplicate by runId — concurrent paths must never produce duplicate jobs.
      jobId: `run-${data.runId}`,
      delay: delayMs,
      attempts: 3,
      backoff: { type: "exponential", delay: 5000 },
    });
    return "enqueued";
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("already exists") || msg.includes("Job already exists")) {
      logger.debug({ runId: data.runId }, "Run job already queued (duplicate jobId) — skipping");
      return "duplicate";
    }
    logger.error({ err, data }, "Failed to enqueue run enrollment job");
    return "error";
  }
}

// ── Accessors (used by workers bootstrapped from index.ts) ─────────────────

export function getQueue():              any     { return _globalSet?.queue ?? null; }
export function getRunQueue():           any     { return _globalSet?.runQueue ?? null; }
export function getConnection():         any     { return _globalSet?.connection ?? null; }
export function getWorkerClass():        any     { return _WorkerClass; }
