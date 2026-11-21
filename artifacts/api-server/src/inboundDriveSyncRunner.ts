import { pool } from "@workspace/db";
import { googleDriveConnectionAvailable, syncInboundSource } from "./lib/inboundAccounts";
import { logger } from "./lib/logger";

const SYNC_INTERVAL_MS = 15 * 60_000;
let timer: NodeJS.Timeout | undefined;
let active = false;

async function runInboundDriveSync() {
  if (active) return;
  active = true;
  try {
    if (!await googleDriveConnectionAvailable()) return;
    const sources = await pool.query<{tenant_id:number;id:number}>(
      `SELECT tenant_id,id FROM intent_inbound_sources
       WHERE enabled=true AND (last_synced_at IS NULL OR last_synced_at<NOW()-interval '15 minutes')
       ORDER BY COALESCE(last_synced_at,to_timestamp(0)),id LIMIT 25`,
    );
    for (const source of sources.rows) {
      try {
        await syncInboundSource(source.tenant_id, source.id);
      } catch (error) {
        logger.warn({tenantId:source.tenant_id,sourceId:source.id,err:error},"Inbound Google Drive sync failed");
        await pool.query(
          `UPDATE intent_inbound_sources SET last_synced_at=NOW(),last_sync_status='failed',
           last_sync_summary=$1,updated_at=NOW() WHERE tenant_id=$2 AND id=$3`,
          [{error:error instanceof Error?error.message:"Sync failed"},source.tenant_id,source.id],
        );
      }
    }
  } catch (error) {
    logger.warn({err:error},"Inbound Google Drive sync runner failed");
  } finally {
    active = false;
  }
}

export function startInboundDriveSyncRunner() {
  if (timer) return;
  timer = setInterval(() => void runInboundDriveSync(), SYNC_INTERVAL_MS);
  timer.unref();
  setTimeout(() => void runInboundDriveSync(), 10_000).unref();
  logger.info({intervalMinutes:15},"Inbound Google Drive sync runner started");
}