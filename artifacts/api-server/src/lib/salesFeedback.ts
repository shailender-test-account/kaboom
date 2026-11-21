import {randomUUID} from "node:crypto";
import {pool} from "@workspace/db";
import {driveBuffer,listDriveFiles, type DriveFile} from "./inboundAccounts";
import {clean,hash,parseFeedbackWorkbook,type ParsedFeedback,type FeedbackType} from "./salesFeedbackParser";

export const feedbackColumns = `f.id,f.client_id AS "clientId",f.account_id AS "accountId",f.contact_id AS "contactId",
 f.type,f.occurred_at AS "occurredAt",f.rep_name AS "repName",f.feedback,f.product,f.timing_months AS "timingMonths",
 f.proposed_temperature AS "proposedTemperature",f.review_status AS "reviewStatus",f.review_note AS "reviewNote",
 f.approved_qualification AS "approvedQualification",f.reviewed_at AS "reviewedAt",f.reviewed_by AS "reviewedBy",
 f.source_id AS "sourceId",f.file_name AS "fileName",f.sheet_name AS "sheetName",f.row_number AS "rowNumber",
 f.raw_fields AS "rawFields",f.created_at AS "createdAt",f.created_by AS "createdBy",
 NULLIF(btrim(concat_ws(' ',author.first_name,author.last_name)),'') AS "createdByName",
 f.next_action AS "nextAction",f.review_history AS "reviewHistory",
 EXISTS(SELECT 1 FROM sales_feedback newer WHERE newer.tenant_id=f.tenant_id AND newer.record_key=f.record_key AND newer.id>f.id) AS superseded,
 c.name AS "accountName",concat_ws(' ',ct.first_name,ct.last_name) AS "contactName",s.name AS "sourceName"`;
export const feedbackJoins = `LEFT JOIN companies c ON c.id=f.account_id AND c.tenant_id=f.tenant_id AND c.client_id=f.client_id
 LEFT JOIN contacts ct ON ct.id=f.contact_id AND ct.tenant_id=f.tenant_id AND ct.company_id=f.account_id AND ct.client_id=f.client_id
 LEFT JOIN sales_feedback_sources s ON s.id=f.source_id AND s.tenant_id=f.tenant_id
 LEFT JOIN users author ON author.id=f.created_by AND author.tenant_id=f.tenant_id`;
export async function readFeedback(tenantId:number,id:number) {
  return (await pool.query(`SELECT ${feedbackColumns} FROM sales_feedback f ${feedbackJoins} WHERE f.tenant_id=$1 AND f.id=$2`,[tenantId,id])).rows[0];
}
export const sourceColumns = `s.id,s.client_id AS "clientId",s.name,s.folder_url AS "folderUrl",s.type,s.enabled,
 s.field_mappings AS "fieldMappings",s.last_synced_at AS "lastSyncedAt",s.last_error AS "lastError",
 EXISTS(SELECT 1 FROM sales_feedback f WHERE f.tenant_id=s.tenant_id AND f.source_id=s.id) AS "hasImported"`;
export function feedbackFolderId(value:string) {
  const url=new URL(value);
  if(url.protocol!=="https:" || url.hostname!=="drive.google.com")throw new Error("Use a Google Drive folder URL.");
  const id=url.pathname.match(/\/folders\/([A-Za-z0-9_-]+)/)?.[1] ?? (url.pathname==="/open"?url.searchParams.get("id"):null);
  if(!id || !/^[A-Za-z0-9_-]{5,200}$/.test(id))throw new Error("Use a Google Drive folder URL.");
  return id;
}
export async function resolveFeedbackIdentity(db:any,tenantId:number,clientId:number,row:ParsedFeedback) {
  const accounts=await db.query(`SELECT id FROM companies WHERE tenant_id=$1 AND client_id=$2
    AND lower(regexp_replace(trim(name),'\\s+',' ','g'))=lower(regexp_replace(trim($3),'\\s+',' ','g')) LIMIT 2`,
    [tenantId,clientId,row.companyName]);
  let accountId=accounts.rowCount===1?Number(accounts.rows[0].id):null;
  const contacts=await db.query(`SELECT id,company_id FROM contacts WHERE tenant_id=$1 AND client_id=$2 AND NOT is_anonymous
    AND (($3<>'' AND lower(trim(email))=$3) OR ($3='' AND $4<>'' AND regexp_replace(COALESCE(phone,''),'[^0-9]','','g')=$4)
      OR ($3='' AND $4='' AND $5::int IS NOT NULL AND company_id=$5 AND lower(trim(concat_ws(' ',first_name,last_name)))=lower($6)))
    LIMIT 2`,[tenantId,clientId,row.email,row.phone.replace(/\D/g,""),accountId,row.contactName]);
  if(contacts.rowCount!==1)return {accountId,contactId:null};
  const contact=contacts.rows[0];
  // Never move an existing contact, or silently attach an email owned elsewhere.
  if(!contact.company_id || (accountId && accountId!==Number(contact.company_id)))return {accountId,contactId:null};
  if(!accountId && row.companyName)return {accountId:null,contactId:null};
  accountId=Number(contact.company_id);
  return {accountId,contactId:Number(contact.id)};
}
export async function feedbackIdentity(db:any,tenantId:number,clientId:number,accountId?:number|null,contactId?:number|null) {
  if(contactId) {
    const contact=(await db.query(`SELECT c.company_id FROM contacts c JOIN companies a ON a.id=c.company_id AND a.tenant_id=c.tenant_id AND a.client_id=c.client_id
      WHERE c.tenant_id=$1 AND c.client_id=$2 AND c.id=$3 AND NOT c.is_anonymous`,[tenantId,clientId,contactId])).rows[0];
    if(!contact || (accountId && accountId!==contact.company_id))throw new Error("Contact must belong to the selected account and client.");
    accountId=Number(contact.company_id);
  }
  if(accountId && !(await db.query("SELECT 1 FROM companies WHERE tenant_id=$1 AND client_id=$2 AND id=$3",[tenantId,clientId,accountId])).rowCount)
    throw new Error("Account not found for this client.");
  return {accountId:accountId??null,contactId:contactId??null};
}
async function filesForSource(source:any) {
  return (await listDriveFiles(source.folder_id)).filter(file=>/\.(xlsx|xls|csv)$/i.test(file.name)||file.mimeType==="application/vnd.google-apps.spreadsheet");
}
export async function previewFeedbackSource(tenantId:number,id:number) {
  const source=(await pool.query("SELECT * FROM sales_feedback_sources WHERE tenant_id=$1 AND id=$2",[tenantId,id])).rows[0];
  if(!source)throw new Error("Source not found.");
  const files=await filesForSource(source), sheets:any[]=[],errors:string[]=[];
  for(const file of files.slice(0,3))try {
    const result=parseFeedbackWorkbook(await driveBuffer(file),source.type,source.field_mappings);
    sheets.push(...result.sheets.map(sheet=>({...sheet,name:`${file.name} / ${sheet.name}`})));
  }catch(error){errors.push(`${file.name}: ${error instanceof Error?error.message:"Could not preview"}`);}
  return {files:files.map(file=>({id:file.id,name:file.name})),sheets,errors};
}
async function importFeedbackFile(db:any,source:any,file:DriveFile,records:ParsedFeedback[]) {
  let imported=0,duplicates=0;
  await db.query("BEGIN");
  try {
    await db.query("SELECT pg_advisory_xact_lock($1,914357)",[source.tenant_id]);
    const current=(await db.query("SELECT enabled,client_id,folder_id,type FROM sales_feedback_sources WHERE tenant_id=$1 AND id=$2 FOR SHARE",[source.tenant_id,source.id])).rows[0];
    if(!current?.enabled)throw new Error("Source is paused.");
    if(current.client_id!==source.client_id||current.folder_id!==source.folder_id||current.type!==source.type)
      throw new Error("Source identity changed; sync again with the current settings.");
    for(const row of records) {
      const identity=await resolveFeedbackIdentity(db,source.tenant_id,source.client_id,row);
      const recordKey=hash([source.id,row.type,row.sheetName,row.recordId||[row.companyName,row.email||row.phone||row.contactName,row.occurredAt,row.product]]);
      const {rowNumber: _rowNumber,sheetName: _sheetName,...content}=row;
      const contentHash=hash(content);
      const inserted=await db.query(`INSERT INTO sales_feedback(tenant_id,client_id,source_id,account_id,contact_id,type,occurred_at,rep_name,
        feedback,next_action,product,timing_months,proposed_temperature,file_name,file_id,sheet_name,row_number,record_key,content_hash,raw_fields)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20::jsonb)
        ON CONFLICT(tenant_id,record_key,content_hash) DO NOTHING RETURNING id`,
        [source.tenant_id,source.client_id,source.id,identity.accountId,identity.contactId,row.type,row.occurredAt,row.repName,
          row.feedback,row.nextAction,row.product,row.timingMonths,row.proposedTemperature,file.name,file.id,row.sheetName,row.rowNumber,recordKey,contentHash,JSON.stringify(row.rawFields)]);
      if(inserted.rowCount) {
        imported++;
        await db.query(`UPDATE sales_feedback SET approved_qualification=false,
          review_history=review_history||jsonb_build_array(jsonb_build_object('action','superseded','at',NOW(),'replacementId',$3::int))
          WHERE tenant_id=$1 AND record_key=$2 AND id<>$3 AND approved_qualification`,[source.tenant_id,recordKey,inserted.rows[0].id]);
      } else duplicates++;
    }
    await db.query(`UPDATE sales_feedback_sources SET file_versions=file_versions||jsonb_build_object($3::text,$4::text)
      WHERE tenant_id=$1 AND id=$2`,[source.tenant_id,source.id,file.id,file.modifiedTime??"unversioned"]);
    await db.query("COMMIT");
    return {imported,duplicates};
  }catch(error){await db.query("ROLLBACK");throw error;}
}
export async function syncFeedbackSource(tenantId:number,id:number) {
  const db=await pool.connect();
  let locked=false;
  try {
    locked=Boolean((await db.query("SELECT pg_try_advisory_lock($1,$2) AS locked",[tenantId,-id])).rows[0].locked);
    if(!locked)throw new Error("This feedback source is already syncing.");
    const source=(await db.query("SELECT * FROM sales_feedback_sources WHERE tenant_id=$1 AND id=$2",[tenantId,id])).rows[0];
    if(!source)throw new Error("Source not found.");
    if(!source.enabled)throw new Error("Enable this feedback source before syncing.");
    const files=await filesForSource(source);
    const pending=files.filter(file=>!file.modifiedTime||source.file_versions?.[file.id]!==file.modifiedTime);
    const result={imported:0,duplicates:0,files:0,errors:[] as string[],remainingFiles:Math.max(0,pending.length-20)};
    for(const file of pending.slice(0,20))try{
      const parsed=parseFeedbackWorkbook(await driveBuffer(file),source.type,source.field_mappings);
      if(!parsed.sheets.length)throw new Error("No recognized feedback headers. Preview this source and map its columns.");
      const counts=await importFeedbackFile(db,source,file,parsed.records);
      result.imported+=counts.imported;result.duplicates+=counts.duplicates;result.files++;
    }catch(error){result.errors.push(`${file.name}: ${error instanceof Error?error.message:"Import failed"}`);}
    await db.query(`UPDATE sales_feedback_sources SET last_synced_at=NOW(),last_error=$3 WHERE tenant_id=$1 AND id=$2`,
      [tenantId,id,result.errors.length?result.errors.join("\n").slice(0,5000):null]);
    return result;
  }catch(error){
    if(locked)await db.query("UPDATE sales_feedback_sources SET last_error=$3,last_synced_at=NOW() WHERE tenant_id=$1 AND id=$2",
      [tenantId,id,error instanceof Error?error.message:"Sync failed"]);
    throw error;
  }finally{if(locked)await db.query("SELECT pg_advisory_unlock($1,$2)",[tenantId,-id]);db.release();}
}

let syncing=false;
/** Only explicitly enabled new feedback sources. No legacy GTM or outreach jobs. */
export function startSalesFeedbackSync() {
  if(process.env.SALES_FEEDBACK_SYNC_ENABLED!=="true")return;
  const tick=async()=>{
    if(syncing)return;
    syncing=true;
    try{
      const sources=await pool.query(`SELECT tenant_id,id FROM sales_feedback_sources WHERE enabled
        AND (last_synced_at IS NULL OR last_synced_at<NOW()-interval '10 minutes') ORDER BY last_synced_at NULLS FIRST,id LIMIT 20`);
      for(const source of sources.rows)try{await syncFeedbackSource(source.tenant_id,source.id);}catch{/* Per-source last_error is retained. */}
    }finally{syncing=false;}
  };
  const interval=setInterval(()=>{void tick().catch(error=>console.error("Sales feedback sync failed",error));},60_000);
  interval.unref();
}
export const manualFeedbackKey=()=>randomUUID();
