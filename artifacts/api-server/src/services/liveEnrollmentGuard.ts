import { pool } from "@workspace/db";

/**
 * A deletion locks the contact FOR UPDATE before removing enrollments. Hold a
 * conflicting share lock through provider acceptance and history writes so
 * neither an in-flight nor a stale queued send can outlive that deletion.
 */
export async function withLiveEnrollment<T>(
  tenantId: number, contactId: number, enrollmentId: number, email: string,
  action: () => Promise<T>,
): Promise<{allowed: false} | {allowed: true; value: T}> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const live = await client.query(
      `SELECT c.id FROM contacts c
       WHERE c.tenant_id=$1 AND c.id=$2 AND c.email=$4
         AND EXISTS (SELECT 1 FROM sequence_enrollments se
                     WHERE se.id=$3 AND se.contact_id=c.id AND se.status='active')
       FOR SHARE OF c`, [tenantId,contactId,enrollmentId,email],
    );
    if(!live.rowCount){await client.query("ROLLBACK");return {allowed:false};}
    const value=await action();
    await client.query("COMMIT");
    return {allowed:true,value};
  } catch(error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}