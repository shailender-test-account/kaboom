import { pool } from "@workspace/db";

export interface MonitoringAccountQuery {
  clientId?: number; audienceId?: number; search?: string;
  page?: number; pageSize?: number; ids?: number[];
}

/** Selection-only query: never loads/scans intent evidence or starts provider work. */
export async function monitoringAccountOptions(tenantId: number, input: MonitoringAccountQuery) {
  const page = input.page ?? 1;
  const pageSize = Math.min(input.pageSize ?? 25, 50);
  const selected = input.ids?.length ? input.ids : null;
  const result = await pool.query(`SELECT c.id,c.name,c.domain,c.client_id AS "clientId"
    FROM companies c JOIN clients cl ON cl.id=c.client_id AND cl.tenant_id=c.tenant_id
    WHERE c.tenant_id=$1
      AND ($2::int IS NULL OR c.client_id=$2)
      AND NULLIF(btrim(c.name),'') IS NOT NULL
      AND ($3::int[] IS NULL OR c.id=ANY($3::int[]))
      AND ($3::int[] IS NOT NULL OR $4::int IS NULL OR EXISTS (
        SELECT 1 FROM intent_audience_companies ac JOIN intent_audiences a
          ON a.id=ac.audience_id AND a.tenant_id=ac.tenant_id
        WHERE ac.tenant_id=c.tenant_id AND ac.company_id=c.id AND ac.audience_id=$4))
      AND ($3::int[] IS NOT NULL OR $5::text IS NULL OR c.name ILIKE $5 OR c.domain ILIKE $5)
    ORDER BY c.name,c.id LIMIT $6 OFFSET $7`,
  [tenantId, input.clientId ?? null, selected, input.audienceId ?? null,
    input.search?.trim() ? `%${input.search.trim().replace(/[\\%_]/g, "\\$&")}%` : null,
    selected ? selected.length : pageSize + 1, selected ? 0 : (page - 1) * pageSize]);
  return { items: selected ? result.rows : result.rows.slice(0, pageSize),
    hasMore: !selected && result.rows.length > pageSize, page, pageSize };
}
