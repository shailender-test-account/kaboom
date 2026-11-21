import { pool } from "@workspace/db";
import { isHpClient } from "./hpBiImport";

export async function hpPageContext(tenantId: number, journeyId: number, pageId: unknown) {
  const row = (await pool.query(`SELECT j.client_id,p.title,p.bi_category,p.bi_product,p.bi_program FROM journeys j
    LEFT JOIN journey_pages p ON p.journey_id=j.id AND p.id=$3
    WHERE j.tenant_id=$1 AND j.id=$2`, [tenantId, journeyId, Number(pageId) || null])).rows[0];
  if (!row || !await isHpClient(tenantId, row.client_id)) return null;
  return { category: row.bi_category ?? null, product: row.bi_product ?? null, program: row.bi_program ?? null,
    journeyId, pageId: Number(pageId) || null, clientId: row.client_id, pageName: row.title ?? null };
}
export async function snapshotHpActivity(tenantId: number, journeyId: number, pageId: unknown, eventId: number) {
  const context = await hpPageContext(tenantId, journeyId, pageId);
  if (!context) return;
  const old = (await pool.query("SELECT metadata FROM activity_events WHERE tenant_id=$1 AND id=$2", [tenantId, eventId])).rows[0];
  let metadata: Record<string, unknown> = {};
  try { metadata = old?.metadata ? JSON.parse(old.metadata) : {}; } catch { metadata = { originalMetadata: old?.metadata }; }
  await pool.query(`UPDATE activity_events SET metadata=$3,journey_id=COALESCE(journey_id,$4),
    client_id=COALESCE(client_id,$5),page_name=COALESCE(page_name,$6) WHERE tenant_id=$1 AND id=$2`,
  [tenantId, eventId, JSON.stringify({ ...metadata, biContext: context }), journeyId, context.clientId, context.pageName]);
}
