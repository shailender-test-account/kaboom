import type { PoolClient } from "pg";

export async function hasLinkedCrmRecords(
  connection: PoolClient,
  tenantId: number,
  accountId: number,
): Promise<boolean> {
  const result = await connection.query<{ linked: boolean }>(`SELECT
    EXISTS(SELECT 1 FROM contacts WHERE tenant_id=$1 AND company_id=$2)
    OR EXISTS(SELECT 1 FROM deals WHERE tenant_id=$1 AND company_id=$2) AS linked`,
  [tenantId, accountId]);
  return result.rows[0]?.linked ?? false;
}