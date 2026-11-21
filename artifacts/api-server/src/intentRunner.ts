import { pool } from "@workspace/db";
import { enqueueIntent, processIntentQueue } from "./lib/alwaysOnIntent";
import { logger } from "./lib/logger";

const QUEUE_TICK_MS = 60_000;
const SWEEP_TICK_MS = 24 * 60 * 60 * 1000;
const SWEEP_PAGE_SIZE = 1_000;
const DISCOVERY_MAX_PAGES = 2;
let contactDiscoveryCursor = 0;
let accountDiscoveryCursor = 0;

async function discoverContactsPage(afterId: number) {
  return pool.query<{ next_cursor: number; candidate_count: number }>(
    `WITH candidates AS MATERIALIZED (
       SELECT c.tenant_id,c.id AS contact_id
       FROM contacts c
       WHERE c.id > $1
         AND coalesce(c.is_anonymous,false)=false
         AND EXISTS (
           SELECT 1 FROM activity_events a
           WHERE a.tenant_id=c.tenant_id AND a.contact_id=c.id
             AND coalesce(a.is_bot,false)=false
             AND a.created_at >= NOW()-interval '90 days'
         )
         AND NOT EXISTS (
           SELECT 1 FROM intent_entity_scores s
           WHERE s.tenant_id=c.tenant_id AND s.contact_id=c.id
         )
       ORDER BY c.id
       LIMIT $2
     ), queued AS (
       INSERT INTO intent_recompute_queue(tenant_id,contact_id,source)
       SELECT tenant_id,contact_id,'bootstrap_activity' FROM candidates
       ON CONFLICT (tenant_id,contact_id)
         WHERE contact_id IS NOT NULL AND status IN ('pending','claimed')
       DO NOTHING
       RETURNING id
     )
     SELECT coalesce(max(contact_id),$1)::int AS next_cursor,count(*)::int AS candidate_count
     FROM candidates`,
    [afterId, SWEEP_PAGE_SIZE],
  );
}

async function discoverAccountsPage(afterId: number) {
  return pool.query<{ next_cursor: number; candidate_count: number }>(
    `WITH candidates AS MATERIALIZED (
       SELECT c.tenant_id,c.company_id AS account_id
       FROM contacts c
       WHERE c.company_id > $1
         AND coalesce(c.is_anonymous,false)=false
         AND EXISTS (
           SELECT 1 FROM activity_events a
           WHERE a.tenant_id=c.tenant_id AND a.contact_id=c.id
             AND coalesce(a.is_bot,false)=false
             AND a.created_at >= NOW()-interval '90 days'
         )
         AND NOT EXISTS (
           SELECT 1 FROM intent_entity_scores s
           WHERE s.tenant_id=c.tenant_id AND s.account_id=c.company_id
         )
       GROUP BY c.tenant_id,c.company_id
       ORDER BY c.company_id
       LIMIT $2
     ), queued AS (
       INSERT INTO intent_recompute_queue(tenant_id,account_id,source)
       SELECT tenant_id,account_id,'bootstrap_activity' FROM candidates
       ON CONFLICT (tenant_id,account_id)
         WHERE account_id IS NOT NULL AND status IN ('pending','claimed')
       DO NOTHING
       RETURNING id
     )
     SELECT coalesce(max(account_id),$1)::int AS next_cursor,count(*)::int AS candidate_count
     FROM candidates`,
    [afterId, SWEEP_PAGE_SIZE],
  );
}

export async function discoverUnscoredIntentEntities(maxPages = DISCOVERY_MAX_PAGES) {
  let contacts = 0;
  let accounts = 0;
  for (let page = 0; page < maxPages; page += 1) {
    const row = (await discoverContactsPage(contactDiscoveryCursor)).rows[0];
    const count = row?.candidate_count ?? 0;
    contacts += count;
    contactDiscoveryCursor = count < SWEEP_PAGE_SIZE ? 0 : row.next_cursor;
    if (count < SWEEP_PAGE_SIZE) break;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  for (let page = 0; page < maxPages; page += 1) {
    const row = (await discoverAccountsPage(accountDiscoveryCursor)).rows[0];
    const count = row?.candidate_count ?? 0;
    accounts += count;
    accountDiscoveryCursor = count < SWEEP_PAGE_SIZE ? 0 : row.next_cursor;
    if (count < SWEEP_PAGE_SIZE) break;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  return { contacts, accounts };
}

/** Isolated queue consumer; it intentionally never invokes legacy scoring or routing. */
export function startIntentRunner(): void {
  let queueRunning = false;
  let sweepRunning = false;

  const tickQueue = async () => {
    if (queueRunning) return;
    queueRunning = true;
    try {
      await processIntentQueue(100);
    } catch (err) {
      logger.warn({ err }, "Intent queue tick failed");
    } finally {
      queueRunning = false;
    }
  };

  const maintenanceSweep = async () => {
    if (sweepRunning) return;
    sweepRunning = true;
    try {
      await discoverUnscoredIntentEntities();
      let lastId = 0;
      while (true) {
        const entities = await pool.query<{ id: number; tenant_id: number; account_id: number | null; contact_id: number | null }>(
          "SELECT id,tenant_id,account_id,contact_id FROM intent_entity_scores WHERE id>$1 ORDER BY id LIMIT $2",
          [lastId, SWEEP_PAGE_SIZE],
        );
        for (const entity of entities.rows) {
          await enqueueIntent(entity.tenant_id, { accountId: entity.account_id, contactId: entity.contact_id }, "nightly_decay");
        }
        if (entities.rows.length < SWEEP_PAGE_SIZE) break;
        lastId = entities.rows[entities.rows.length - 1].id;
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      await tickQueue();
    } catch (err) {
      logger.warn({ err }, "Intent maintenance sweep failed");
    } finally {
      sweepRunning = false;
    }
  };

  const bootstrapMissingEntities = async () => {
    if (sweepRunning) return;
    sweepRunning = true;
    try {
      await discoverUnscoredIntentEntities();
      await tickQueue();
    } catch (err) {
      logger.warn({ err }, "Intent bootstrap discovery failed");
    } finally {
      sweepRunning = false;
    }
  };

  void tickQueue();
  // A restart must not enqueue every previously scored entity again. That can
  // create a multi-hour backlog that delays fresh account activity and score
  // explanations. Startup only discovers entities that have never been scored;
  // the full decay refresh remains on the daily maintenance cadence.
  void bootstrapMissingEntities();
  setInterval(() => { void tickQueue(); }, QUEUE_TICK_MS).unref();
  setInterval(() => { void maintenanceSweep(); }, SWEEP_TICK_MS).unref();
}