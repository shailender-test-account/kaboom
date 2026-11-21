import { pool } from "@workspace/db";
import { guardMonitoringConnection } from "./monitoringConnection";

/** Explicit selection only: expose the current owned HP roster as an ordinary
 * monitoring audience. No research, scheduling, or contact writes occur here. */
export async function selectMonitoringRoster(tenantId: number, clientId: number) {
  const db = await pool.connect();
  const connection = guardMonitoringConnection(db, "select monitoring roster");
  try {
    await db.query("BEGIN");
    await db.query("SELECT pg_advisory_xact_lock($1,$2)", [tenantId, clientId]);
    const owner = await db.query(`SELECT id,name FROM clients WHERE tenant_id=$1 AND id=$2`, [tenantId, clientId]);
    if (!owner.rowCount) throw new Error("Unknown client roster");
    const count = await db.query(`SELECT count(*)::int AS count FROM hp_account_profiles p
      JOIN companies c ON c.id=p.company_id AND c.tenant_id=p.tenant_id AND c.client_id=p.client_id
      WHERE p.tenant_id=$1 AND p.client_id=$2`, [tenantId, clientId]);
    if (!count.rows[0].count) throw new Error("No HP roster accounts available for this client");
    const marker = `System HP roster source; client=${clientId}`;
    const name = `${owner.rows[0].name} — Full account roster`;
    let audience = (await db.query(`SELECT id,name FROM intent_audiences
      WHERE tenant_id=$1 AND client_id=$2 AND description=$3 ORDER BY id LIMIT 1`,
    [tenantId, clientId, marker])).rows[0];
    if (!audience) {
      // Never take over a manually created same-name list.
      const inserted = await db.query(`INSERT INTO intent_audiences(tenant_id,client_id,name,description)
        VALUES($1,$2,$3,$4) ON CONFLICT (tenant_id,name) DO NOTHING RETURNING id,name`,
      [tenantId, clientId, name, marker]);
      audience = inserted.rows[0];
      if (!audience) throw new Error("A list already uses the full-roster name. Rename that list before selecting this roster.");
    }
    await db.query(`INSERT INTO intent_audience_companies(tenant_id,audience_id,company_id)
      SELECT p.tenant_id,$3,p.company_id FROM hp_account_profiles p
      JOIN companies c ON c.id=p.company_id AND c.tenant_id=p.tenant_id AND c.client_id=p.client_id
      WHERE p.tenant_id=$1 AND p.client_id=$2 ON CONFLICT DO NOTHING`, [tenantId, clientId, audience.id]);
    // This is a refreshed selection snapshot, not a fabricated upload or CRM merge.
    await db.query(`DELETE FROM intent_audience_companies ac WHERE ac.tenant_id=$1 AND ac.audience_id=$3
      AND NOT EXISTS(SELECT 1 FROM hp_account_profiles p JOIN companies c
        ON c.id=p.company_id AND c.tenant_id=p.tenant_id AND c.client_id=p.client_id
        WHERE p.tenant_id=$1 AND p.client_id=$2 AND p.company_id=ac.company_id)`,
    [tenantId, clientId, audience.id]);
    await db.query("COMMIT");
    connection.check();
    return { id: Number(audience.id), name: String(audience.name), memberCount: Number(count.rows[0].count) };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally { connection.release(); }
}
