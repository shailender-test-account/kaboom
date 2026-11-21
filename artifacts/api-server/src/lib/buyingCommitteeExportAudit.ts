import { pool } from "@workspace/db";

type ExportActor = { tenantId: number; id: number };
export type ExportOutcome = "completed" | "rejected" | "cancelled" | "failed";

/**
 * Persist before reading any PII; an unavailable audit store blocks the download.
 * Never copy untrusted query strings or foreign scope IDs into the audit trail.
 * A started record without finished_at is an unfinished attempt, not a success
 * (including a process crash where no final write is possible).
 */
export async function startCommitteeExportAudit(actor: ExportActor, clientId: number | null, accountIds: number[]) {
  const result = await pool.query<{ id: number }>(`
    INSERT INTO buying_committee_export_audits(tenant_id,requested_by,client_id,account_ids)
    SELECT $1,$2,c.id,ARRAY(
      SELECT co.id FROM companies co
      WHERE co.tenant_id=$1 AND co.client_id=c.id AND co.id=ANY($4::int[])
      ORDER BY co.id
    )
    FROM (SELECT id FROM clients WHERE tenant_id=$1 AND id=$3) c
    RIGHT JOIN (SELECT 1) attempt ON true
    RETURNING id`, [actor.tenantId, actor.id, clientId, accountIds]);
  return result.rows[0].id;
}

/** Tenant + requesting actor are required even when the caller knows the audit ID. */
export async function finishCommitteeExportAudit(actor: ExportActor, auditId: number, outcome: ExportOutcome, rowCount: number) {
  const result = await pool.query(`
    UPDATE buying_committee_export_audits SET outcome=$4,row_count=$5,finished_at=now()
    WHERE id=$3 AND tenant_id=$1 AND requested_by=$2 AND outcome='started'`,
  [actor.tenantId, actor.id, auditId, outcome, rowCount]);
  if (result.rowCount !== 1) throw new Error("Export audit could not be finalized");
}
