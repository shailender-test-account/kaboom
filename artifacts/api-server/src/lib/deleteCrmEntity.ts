import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { pool } from "@workspace/db";
import { canonicalizeInbound, inboundResponseIdentity, type InboundFieldMappings } from "./inboundAccounts";

type DbClient = Pick<PoolClient, "query">;
type Submission = {
  id: number; source_id: number|null; drive_file_id: string; row_key: string;
  raw_fields: Record<string, unknown>; field_mappings: InboundFieldMappings | null;
};

async function tombstoneResponses(client: DbClient, tenantId: number, rows: Submission[]) {
  for (const row of rows) {
    // Manual responses have no Drive source and can never be re-imported, so
    // they do not need an import tombstone.
    if(row.source_id===null)continue;
    const identity = inboundResponseIdentity(canonicalizeInbound(row.raw_fields ?? {}, row.field_mappings ?? {}));
    const identityHash = identity ? createHash("sha256").update(identity).digest("hex") : null;
    await client.query(`INSERT INTO intent_inbound_deleted_rows
      (tenant_id,source_id,drive_file_id,row_key,identity_hash)
      VALUES($1,$2,$3,$4,$5)
      ON CONFLICT (tenant_id,source_id,drive_file_id,row_key) DO NOTHING`,
      [tenantId,row.source_id,row.drive_file_id,row.row_key,identityHash]);
  }
}

async function removeResponses(client: DbClient, tenantId: number, clause: string, id: number) {
  // The clause is internal, from a fixed list below; the ID remains a bound parameter.
  const rows=await client.query<Submission>(`SELECT s.id,s.source_id,s.drive_file_id,s.row_key,s.raw_fields,src.field_mappings
    FROM intent_inbound_submissions s LEFT JOIN intent_inbound_sources src
      ON src.tenant_id=s.tenant_id AND src.id=s.source_id
    WHERE s.tenant_id=$1 AND s.${clause}=$2 FOR UPDATE OF s`,[tenantId,id]);
  await tombstoneResponses(client,tenantId,rows.rows);
  const ids=rows.rows.map(row=>row.id);
  if(ids.length){
    await client.query(`DELETE FROM intent_inbound_manual_routes WHERE tenant_id=$1 AND submission_id=ANY($2::int[])`,[tenantId,ids]);
    await client.query(`DELETE FROM intent_inbound_submissions WHERE tenant_id=$1 AND id=ANY($2::int[])`,[tenantId,ids]);
  }
  return ids.length;
}

export async function deleteOneInboundResponse(tenantId:number,id:number) {
  const client=await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1::int,914357)",[tenantId]);
    const exists=await client.query("SELECT id FROM intent_inbound_submissions WHERE tenant_id=$1 AND id=$2 FOR UPDATE",[tenantId,id]);
    if(!exists.rowCount){await client.query("ROLLBACK");return false;}
    await removeResponses(client,tenantId,"id",id);
    await client.query("COMMIT");
    return true;
  } catch(error){await client.query("ROLLBACK");throw error;} finally{client.release();}
}

async function removeContact(client: DbClient,tenantId:number,id:number,deletedAccountId?:number){
  if(deletedAccountId!==undefined){
    await client.query(`UPDATE intent_inbound_submissions SET contact_id=NULL,routing_status='error',
      routing_error='Linked contact was deleted with another account; review this response before routing.',updated_at=NOW()
      WHERE tenant_id=$1 AND contact_id=$2 AND account_id<>$3`,[tenantId,id,deletedAccountId]);
  }
  await removeResponses(client,tenantId,"contact_id",id);
  await client.query("DELETE FROM intent_inbound_manual_routes WHERE tenant_id=$1 AND contact_id=$2",[tenantId,id]);
  await client.query("DELETE FROM intent_score_history WHERE tenant_id=$1 AND entity_score_id IN (SELECT id FROM intent_entity_scores WHERE tenant_id=$1 AND contact_id=$2)",[tenantId,id]);
  await client.query("DELETE FROM intent_evidence WHERE tenant_id=$1 AND (contact_id=$2 OR signal_id IN (SELECT id FROM intent_signals WHERE tenant_id=$1 AND contact_id=$2))",[tenantId,id]);
  await client.query("DELETE FROM intent_recommendation_outcomes WHERE tenant_id=$1 AND recommendation_id IN (SELECT id FROM intent_recommendations WHERE tenant_id=$1 AND contact_id=$2)",[tenantId,id]);
  await client.query("DELETE FROM call_analysis WHERE tenant_id=$1 AND (contact_id=$2 OR call_log_id IN (SELECT id FROM call_logs WHERE tenant_id=$1 AND contact_id=$2))",[tenantId,id]);
  await client.query("DELETE FROM bot_sessions WHERE tenant_id=$1 AND (contact_id=$2 OR enrollment_id IN (SELECT id FROM sequence_enrollments WHERE contact_id=$2))",[tenantId,id]);
  const tables=[
    "activity_events","call_campaign_contacts","call_dnc_contacts","call_logs","contact_notes",
    "contact_stage_history","deals","email_events","form_submissions","intent_entity_scores",
    "intent_evidence","intent_recommendations","intent_recompute_queue","intent_signals",
    "notifications","play_contacts","score_history","visitor_tokens",
  ] as const;
  // Retain only stable deal identities, not deleted-contact notes or linkage snapshots.
  await client.query(`UPDATE deal_audit SET "before"=NULL,"after"=NULL WHERE tenant_id=$1 AND
    ("before"->>'contactId'=$2::text OR "after"->>'contactId'=$2::text OR
     "before"->>'contact_id'=$2::text OR "after"->>'contact_id'=$2::text)`,[tenantId,id]);
  await client.query(`INSERT INTO deal_audit(tenant_id,client_id,deal_id,action)
    SELECT tenant_id,client_id,id,'contact_deleted' FROM deals WHERE tenant_id=$1 AND contact_id=$2`,[tenantId,id]);
  for(const table of tables)await client.query(`DELETE FROM ${table} WHERE tenant_id=$1 AND contact_id=$2`,[tenantId,id]);
  // This join table and sequence enrollments are not tenant-keyed; the locked contact ID
  // is globally unique, so these cannot affect a different tenant.
  await client.query("DELETE FROM journey_contacts WHERE contact_id=$1",[id]);
  await client.query("DELETE FROM sequence_enrollments WHERE contact_id=$1",[id]);
  await client.query("UPDATE segments SET static_contact_ids=array_remove(static_contact_ids,$2::int) WHERE tenant_id=$1 AND $2::int=ANY(static_contact_ids)",[tenantId,id]);
  await client.query(`UPDATE journey_segments js SET snapshot_contact_ids=array_remove(js.snapshot_contact_ids,$2::int)
    FROM journeys j WHERE j.id=js.journey_id AND j.tenant_id=$1 AND $2::int=ANY(js.snapshot_contact_ids)`,[tenantId,id]);
  await client.query("DELETE FROM intent_contact_discovery_candidates WHERE tenant_id=$1 AND canonical_contact_id=$2",[tenantId,id]);
  // Remove directory PII while retaining a source-row tombstone against resurrection.
  await client.query(`UPDATE hp_account_profiles p SET dimensions=jsonb_set(p.dimensions,'{_gccProfiling}',
    (SELECT jsonb_agg(CASE WHEN r->>'contactId'=$2::text
      THEN jsonb_build_object('sourceRow',r->'sourceRow','fileHash',r->'fileHash','deleted',true)
      ELSE r END) FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p.dimensions->'_gccProfiling')='array'
        THEN p.dimensions->'_gccProfiling' ELSE '[]'::jsonb END) r))
    WHERE p.tenant_id=$1 AND jsonb_typeof(p.dimensions->'_gccProfiling')='array'
      AND EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p.dimensions->'_gccProfiling')='array'
        THEN p.dimensions->'_gccProfiling' ELSE '[]'::jsonb END) r WHERE r->>'contactId'=$2::text)`,
  [tenantId,id]);
  await client.query("DELETE FROM contacts WHERE tenant_id=$1 AND id=$2",[tenantId,id]);
}

export async function deleteContactAndHistory(tenantId:number,id:number){
  const client=await pool.connect();
  try{
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1::int,914357)",[tenantId]);
    const row=await client.query("SELECT id FROM contacts WHERE tenant_id=$1 AND id=$2 FOR UPDATE",[tenantId,id]);
    if(!row.rowCount){await client.query("ROLLBACK");return false;}
    await removeContact(client,tenantId,id);
    await client.query("COMMIT");
    return true;
  }catch(error){await client.query("ROLLBACK");throw error;}finally{client.release();}
}

export async function deleteCompanyAndHistory(tenantId:number,id:number){
  const client=await pool.connect();
  try{
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1::int,914357)",[tenantId]);
    const row=await client.query("SELECT id FROM companies WHERE tenant_id=$1 AND id=$2 FOR UPDATE",[tenantId,id]);
    if(!row.rowCount){await client.query("ROLLBACK");return false;}
    const contacts=await client.query<{id:number}>("SELECT id FROM contacts WHERE tenant_id=$1 AND company_id=$2 ORDER BY id FOR UPDATE",[tenantId,id]);
    for(const contact of contacts.rows)await removeContact(client,tenantId,contact.id,id);
    await removeResponses(client,tenantId,"account_id",id);
    await client.query("DELETE FROM intent_score_history WHERE tenant_id=$1 AND entity_score_id IN (SELECT id FROM intent_entity_scores WHERE tenant_id=$1 AND account_id=$2)",[tenantId,id]);
    await client.query("DELETE FROM intent_evidence WHERE tenant_id=$1 AND (account_id=$2 OR signal_id IN (SELECT id FROM intent_signals WHERE tenant_id=$1 AND account_id=$2))",[tenantId,id]);
    await client.query("DELETE FROM intent_recommendation_outcomes WHERE tenant_id=$1 AND recommendation_id IN (SELECT id FROM intent_recommendations WHERE tenant_id=$1 AND account_id=$2)",[tenantId,id]);
    const accountTables=[
      ["activity_events","company_id"],["deals","company_id"],["intent_audience_companies","company_id"],
      ["intent_contact_discovery_candidates","company_id"],["intent_entity_scores","account_id"],
      ["intent_evidence","account_id"],["intent_monitoring_accounts","company_id"],
      ["intent_opportunity_handoffs","account_id"],["intent_recommendations","account_id"],
      ["intent_recompute_queue","account_id"],["intent_research_run_accounts","account_id"],
      ["intent_signals","account_id"],
    ] as const;
    await client.query(`UPDATE deal_audit SET "before"=NULL,"after"=NULL WHERE tenant_id=$1 AND
      ("before"->>'companyId'=$2::text OR "after"->>'companyId'=$2::text OR
       "before"->>'company_id'=$2::text OR "after"->>'company_id'=$2::text)`,[tenantId,id]);
    await client.query(`INSERT INTO deal_audit(tenant_id,client_id,deal_id,action)
      SELECT tenant_id,client_id,id,'account_deleted' FROM deals WHERE tenant_id=$1 AND company_id=$2`,[tenantId,id]);
    for(const [table,column] of accountTables)await client.query(`DELETE FROM ${table} WHERE tenant_id=$1 AND ${column}=$2`,[tenantId,id]);
    await client.query("DELETE FROM journey_companies WHERE company_id=$1",[id]);
    await client.query("DELETE FROM companies WHERE tenant_id=$1 AND id=$2",[tenantId,id]);
    await client.query("COMMIT");
    return true;
  }catch(error){await client.query("ROLLBACK");throw error;}finally{client.release();}
}