import {Router} from "express";
import {z} from "zod/v4";
import {pool} from "@workspace/db";
import {requireAuth,requireRole} from "../middlewares/requireAuth";
import {feedbackColumns,feedbackJoins,readFeedback,sourceColumns,feedbackFolderId,feedbackIdentity,previewFeedbackSource,syncFeedbackSource,manualFeedbackKey} from "../lib/salesFeedback";
import {googleDriveConnectionAvailable} from "../lib/inboundAccounts";
import {feedbackDate,feedbackTargets,hash} from "../lib/salesFeedbackParser";
import {salesFeedbackAccess,requestSalesAccess} from "../middlewares/salesFeedbackAccess";
import {salesScopeSql} from "../lib/salesAccountAccess";

const router=Router();
router.use(requireAuth);
router.use("/sales-feedback",salesFeedbackAccess);
const id=z.coerce.number().int().positive();
const optionalId=id.optional();
const kind=z.enum(["telesales","sales_rep"]);
const months=z.number().int().min(0).max(120).nullable().optional();
const manual=z.object({
  clientId:id,accountId:optionalId,contactId:optionalId,type:kind,
  occurredAt:z.string().max(80).optional(),repName:z.string().max(200).optional(),
  feedback:z.string().trim().min(1).max(10000),product:z.string().trim().max(300).nullable().optional(),
  timingMonths:months,proposedTemperature:z.enum(["Hot","Warm","Cold"]).nullable().optional(),
  nextAction:z.string().max(2000).nullable().optional(),
}).refine(v=>v.accountId||v.contactId,"Select an existing account or contact.");
const sourceInput=z.object({
  clientId:id,name:z.string().trim().min(1).max(200),folderUrl:z.string().max(500),type:kind,enabled:z.boolean(),
  fieldMappings:z.record(z.string().max(200),z.enum(feedbackTargets)).default({}),
});
const owned=async(tenantId:number,clientId:number)=>(await pool.query("SELECT 1 FROM clients WHERE tenant_id=$1 AND id=$2",[tenantId,clientId])).rowCount;
const handle=(fn:any)=>(req:any,res:any,next:any)=>Promise.resolve(fn(req,res)).catch((e:any)=>{
  if(e instanceof z.ZodError)res.status(400).json({error:e.issues.map((v:any)=>v.message).join("; ")});
  else if(e instanceof Error && /not found|must|Select |valid |Use a |cannot|Enable |already|paused|source identity|superseded|qualification|Review |date/i.test(e.message))
    res.status(/not found/.test(e.message)?404:400).json({error:e.message});
  else next(e);
});
router.get("/sales-feedback/options",handle(async(req:any,res:any)=>{
  const tenantId=req.user.tenantId;
  const input=z.object({clientId:optionalId,accountId:optionalId,contactId:optionalId,search:z.string().max(200).default(""),
    accountPage:z.coerce.number().int().min(1).max(100000).default(1),
    contactPage:z.coerce.number().int().min(1).max(100000).default(1),
  }).parse(req.query);
  let {clientId,accountId}=input;
  const {search,contactId}=input;
  const access=requestSalesAccess(req);
  if(contactId) {
    const row=(await pool.query("SELECT client_id,company_id FROM contacts WHERE tenant_id=$1 AND id=$2 AND NOT is_anonymous",[tenantId,contactId])).rows[0];
    if(!row || !row.company_id || (clientId && row.client_id!==clientId) || (accountId && row.company_id!==accountId))throw new Error("Contact not found for this account.");
    clientId=row.client_id;accountId=row.company_id;
  }
  if(accountId) {
    const row=(await pool.query("SELECT client_id FROM companies WHERE tenant_id=$1 AND id=$2",[tenantId,accountId])).rows[0];
    if(!row || (clientId && clientId!==row.client_id))throw new Error("Account not found for this client.");
    clientId=row.client_id;
  }
  const accountParams:unknown[]=[tenantId,clientId??null,`%${search}%`,accountId??null];
  const accountScope=salesScopeSql(access,"a",accountParams);
  const contactParams:unknown[]=[tenantId,clientId??null,`%${search}%`,contactId??null,accountId??null];
  const contactScope=salesScopeSql(access,"a",contactParams);
  accountParams.push((input.accountPage-1)*50);
  contactParams.push((input.contactPage-1)*50);
  const [clients,accounts,contacts,products,googleDriveConnected]=await Promise.all([
    pool.query("SELECT id,name FROM clients WHERE tenant_id=$1 AND ($2::int IS NULL OR id=$2) ORDER BY name",
      [tenantId,clientId??null]),
    pool.query(`SELECT a.id,a.name,a.client_id AS "clientId" FROM companies a WHERE a.tenant_id=$1 AND ($2::int IS NULL OR a.client_id=$2)
      AND (a.name ILIKE $3 OR a.id=$4 OR EXISTS(
        SELECT 1 FROM contacts match WHERE match.tenant_id=a.tenant_id AND match.client_id=a.client_id
        AND match.company_id=a.id AND NOT match.is_anonymous
        AND concat_ws(' ',match.first_name,match.last_name,match.email) ILIKE $3
      )) AND ${accountScope}
      ORDER BY (a.id=COALESCE($4,0)) DESC,a.name,a.id LIMIT 51 OFFSET $${accountParams.length}`,accountParams),
    pool.query(`SELECT c.id,concat_ws(' ',c.first_name,c.last_name) AS name,c.email,c.company_id AS "companyId",c.client_id AS "clientId"
      FROM contacts c JOIN companies a ON a.id=c.company_id AND a.tenant_id=c.tenant_id AND a.client_id=c.client_id
      WHERE c.tenant_id=$1 AND NOT c.is_anonymous AND ($2::int IS NULL OR c.client_id=$2)
      AND ($5::int IS NULL OR c.company_id=$5)
      AND (concat_ws(' ',c.first_name,c.last_name,c.email,a.name) ILIKE $3 OR c.id=$4) AND ${contactScope}
      ORDER BY (c.id=COALESCE($4,0)) DESC,c.first_name,c.id LIMIT 51 OFFSET $${contactParams.length}`,contactParams),
    Array.isArray(req.user.clientIds) ? Promise.resolve({rows:[]}) :
      pool.query("SELECT id,name FROM intent_products WHERE tenant_id=$1 AND active ORDER BY name,id",[tenantId]),
    Array.isArray(req.user.clientIds) ? Promise.resolve(false) : googleDriveConnectionAvailable(),
  ]);
  res.json({clients:clients.rows,accounts:accounts.rows.slice(0,50),contacts:contacts.rows.slice(0,50),
    accountsHasMore:accounts.rows.length>50,contactsHasMore:contacts.rows.length>50,
    products:products.rows,googleDriveConnected});
}));
router.get("/sales-feedback",handle(async(req:any,res:any)=>{
  const v=z.object({clientId:optionalId,accountId:optionalId,contactId:optionalId,parentKey:z.string().min(1).max(200).optional(),
    type:kind.optional(),status:z.enum(["pending","approved","rejected"]).optional(),
    page:z.coerce.number().int().min(1).max(100000).default(1),pageSize:z.coerce.number().int().min(1).max(100).default(20),
  }).refine(v=>!v.parentKey||v.clientId,"Parent account requires clientId.").parse(req.query);
  const params:unknown[]=[req.user.tenantId,v.clientId??null,v.accountId??null,v.contactId??null,v.type??null,v.status??null,v.parentKey??null];
  const access=requestSalesAccess(req);
  const ownerScope=salesScopeSql(access,access.visibility==="owned"?"sc":"f",params);
  const where=`f.tenant_id=$1 AND ($2::int IS NULL OR f.client_id=$2) AND ($3::int IS NULL OR f.account_id=$3)
    AND ($4::int IS NULL OR f.contact_id=$4) AND ($5::text IS NULL OR f.type=$5)
    AND ($6::text IS NULL OR f.review_status=$6)
    AND ($7::text IS NULL OR EXISTS(SELECT 1 FROM hp_account_profiles p WHERE p.tenant_id=f.tenant_id AND p.client_id=f.client_id AND p.company_id=f.account_id AND p.parent_key=$7))
    AND ${access.visibility==="owned"
      ? `EXISTS(SELECT 1 FROM companies sc WHERE sc.id=f.account_id AND sc.tenant_id=f.tenant_id AND sc.client_id=f.client_id AND ${ownerScope})`
      : ownerScope}`;
  const [count,items]=await Promise.all([
    pool.query(`SELECT count(*)::int AS total FROM sales_feedback f WHERE ${where}`,params),
    pool.query(`SELECT ${feedbackColumns} FROM sales_feedback f ${feedbackJoins} WHERE ${where} ORDER BY f.created_at DESC,f.id DESC LIMIT $${params.length+1} OFFSET $${params.length+2}`,
      [...params,v.pageSize,(v.page-1)*v.pageSize]),
  ]);
  res.json({items:items.rows,total:count.rows[0].total,page:v.page,pageSize:v.pageSize});
}));
router.post("/sales-feedback",requireRole("admin"),handle(async(req:any,res:any)=>{
  const input=manual.parse(req.body),tenantId=req.user.tenantId,authorId=req.user.id;
  if(!Number.isSafeInteger(authorId)||authorId<=0){res.status(401).json({error:"Sign in to record feedback."});return;}
  // Caller-controlled names, user IDs and submission timestamps never establish authorship.
  const {repName:_ignoredName,...fields}=input;
  const v={...fields,repName:""};
  if(!await owned(tenantId,v.clientId))throw new Error("Client not found.");
  const at=v.occurredAt?feedbackDate(v.occurredAt):null;
  if(v.occurredAt&&!at)throw new Error("Select a valid feedback date.");
  const db=await pool.connect();
  try{
    await db.query("BEGIN");await db.query("SELECT pg_advisory_xact_lock($1,914357)",[tenantId]);
    const author=(await db.query("SELECT first_name,last_name FROM users WHERE tenant_id=$1 AND id=$2 FOR KEY SHARE",[tenantId,authorId])).rows[0];
    if(!author){await db.query("ROLLBACK");res.status(401).json({error:"Sign in to record feedback."});return;}
    v.repName=[author.first_name,author.last_name].filter(Boolean).join(" ").trim()||`User ${authorId}`;
    const identity=await feedbackIdentity(db,tenantId,v.clientId,v.accountId,v.contactId);
    const result=await db.query(`INSERT INTO sales_feedback(tenant_id,client_id,account_id,contact_id,type,occurred_at,rep_name,feedback,
      next_action,product,timing_months,proposed_temperature,record_key,content_hash,raw_fields,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16) RETURNING id`,
      [tenantId,v.clientId,identity.accountId,identity.contactId,v.type,at,v.repName,v.feedback,v.nextAction??null,v.product??null,
        v.timingMonths??null,v.proposedTemperature??null,manualFeedbackKey(),hash(v),JSON.stringify(v),authorId]);
    await db.query("COMMIT");res.status(201).json(await readFeedback(tenantId,result.rows[0].id));
  }catch(e){await db.query("ROLLBACK");throw e;}finally{db.release();}
}));
router.post("/sales-feedback/:id/review",requireRole("admin"),handle(async(req:any,res:any)=>{
  if(req.user.role!=="admin"){res.status(403).json({error:"Only an admin may approve qualification changes."});return;}
  const entryId=id.parse(req.params.id),tenantId=req.user.tenantId;
  const v=z.object({decision:z.enum(["approve","reject"]),accountId:optionalId,contactId:optionalId,
    note:z.string().trim().min(1).max(2000),applyQualification:z.boolean(),product:z.string().trim().min(1).max(300).optional(),
    timingMonths:months,occurredAt:z.string().max(80).optional(),
  }).parse(req.body);
  const db=await pool.connect();
  try{
    await db.query("BEGIN");await db.query("SELECT pg_advisory_xact_lock($1,914357)",[tenantId]);
    const entry=(await db.query("SELECT * FROM sales_feedback WHERE tenant_id=$1 AND id=$2 FOR UPDATE",[tenantId,entryId])).rows[0];
    if(!entry)throw new Error("Feedback not found.");
    if(v.decision==="approve" && (await db.query("SELECT 1 FROM sales_feedback WHERE tenant_id=$1 AND record_key=$2 AND id>$3 LIMIT 1",[tenantId,entry.record_key,entryId])).rowCount)
      throw new Error("This feedback was superseded by a newer imported revision. Review the latest entry.");
    const identity=await feedbackIdentity(db,tenantId,entry.client_id,v.accountId??entry.account_id,v.contactId??entry.contact_id);
    if(v.decision==="approve"&&!identity.accountId)throw new Error("Select a verified account before approval.");
    const apply=v.decision==="approve"&&v.applyQualification;
    const product=v.product??entry.product, timing=v.timingMonths===undefined?entry.timing_months:v.timingMonths;
    const at=v.occurredAt?feedbackDate(v.occurredAt):entry.occurred_at;
    if(apply) {
      if(!identity.contactId || !product || timing===null || !at)throw new Error("Qualification approval must include a contact, product, purchase timeline and verified interaction date.");
      if(new Date(at).getTime()>Date.now())throw new Error("Qualification date cannot be in the future.");
      if(!(await db.query("SELECT 1 FROM intent_products WHERE tenant_id=$1 AND active AND name=$2",[tenantId,product])).rowCount)
        throw new Error("Select a configured active product for qualification.");
    }
    const audit={decision:v.decision,note:v.note,reviewedBy:req.user.id,at:new Date().toISOString(),
      accountId:identity.accountId,contactId:identity.contactId,applyQualification:apply,product,timingMonths:timing,occurredAt:at};
    await db.query(`UPDATE sales_feedback SET account_id=$3,contact_id=$4,review_status=$5,approved_qualification=$6,
      review_note=$7,reviewed_by=$8,reviewed_at=NOW(),product=$9,timing_months=$10,occurred_at=$11,
      review_history=review_history||$12::jsonb WHERE tenant_id=$1 AND id=$2`,
      [tenantId,entryId,identity.accountId,identity.contactId,v.decision==="approve"?"approved":"rejected",apply,
        v.note,req.user.id,product,timing,at,JSON.stringify([audit])]);
    await db.query("COMMIT");res.json(await readFeedback(tenantId,entryId));
  }catch(e){await db.query("ROLLBACK");throw e;}finally{db.release();}
}));
router.get("/sales-feedback/sources",handle(async(req:any,res:any)=>{
  res.json({items:(await pool.query(`SELECT ${sourceColumns} FROM sales_feedback_sources s
    WHERE s.tenant_id=$1 AND ($2::int IS NULL OR s.client_id=$2) ORDER BY s.id`,
    [req.user.tenantId,req.query.clientId??null])).rows});
}));
for(const method of ["post","put"] as const)router[method](`/sales-feedback/sources${method==="put"?"/:id":""}`,requireRole("admin"),handle(async(req:any,res:any)=>{
  const v=sourceInput.parse(req.body),tenantId=req.user.tenantId,folderId=feedbackFolderId(v.folderUrl);
  if(!await owned(tenantId,v.clientId))throw new Error("Client not found.");
  const db=await pool.connect();
  try {
    await db.query("BEGIN");
    let sourceId:number;
    if(method==="put") {
      sourceId=id.parse(req.params.id);
      // Coordinate source identity changes with file import commits.
      const old=(await db.query("SELECT * FROM sales_feedback_sources WHERE tenant_id=$1 AND id=$2 FOR UPDATE",[tenantId,sourceId])).rows[0];
      if(!old)throw new Error("Source not found.");
      const used=(await db.query("SELECT 1 FROM sales_feedback WHERE tenant_id=$1 AND source_id=$2 LIMIT 1",[tenantId,sourceId])).rowCount;
      if(used&&(old.client_id!==v.clientId||old.folder_id!==folderId||old.type!==v.type))throw new Error("Cannot change source identity after imports. Create a new source.");
      await db.query(`UPDATE sales_feedback_sources SET client_id=$3,name=$4,folder_url=$5,folder_id=$6,type=$7,enabled=$8,field_mappings=$9::jsonb,
        file_versions=CASE WHEN field_mappings IS DISTINCT FROM $9::jsonb OR folder_id<>$6 THEN '{}'::jsonb ELSE file_versions END
        WHERE tenant_id=$1 AND id=$2`,[tenantId,sourceId,v.clientId,v.name,v.folderUrl,folderId,v.type,v.enabled,JSON.stringify(v.fieldMappings)]);
    } else sourceId=(await db.query(`INSERT INTO sales_feedback_sources(tenant_id,client_id,name,folder_url,folder_id,type,enabled,field_mappings)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb) RETURNING id`,[tenantId,v.clientId,v.name,v.folderUrl,folderId,v.type,v.enabled,JSON.stringify(v.fieldMappings)])).rows[0].id;
    await db.query("COMMIT");
    res.status(method==="post"?201:200).json((await pool.query(`SELECT ${sourceColumns} FROM sales_feedback_sources s WHERE s.tenant_id=$1 AND s.id=$2`,[tenantId,sourceId])).rows[0]);
  }catch(e){await db.query("ROLLBACK");throw e;}finally{db.release();}
}));
router.get("/sales-feedback/sources/:id/preview",requireRole("admin"),handle(async(req:any,res:any)=>{
  res.json(await previewFeedbackSource(req.user.tenantId,id.parse(req.params.id)));
}));
router.post("/sales-feedback/sources/:id/sync",requireRole("admin"),handle(async(req:any,res:any)=>{
  res.json(await syncFeedbackSource(req.user.tenantId,id.parse(req.params.id)));
}));
export default router;
