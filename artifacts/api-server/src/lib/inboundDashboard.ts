import { pool } from "@workspace/db";
import { canonicalInboundSubmissionSql } from "./inboundSubmissionDuplicates";
import { groupInboundCategoryCohorts, splitSelections } from "./inboundAccounts";
import { applyAccountCategoryReviews, categoryForMissingInterest, inboundCategories, inboundCategoryForInterest, inboundProducts, loadInboundCategoryRules } from "./inboundTaxonomy";

export type InboundDashboardFilters = {
  dateRange?: number | null;
  formType?: "lead_form" | "event_feedback" | null;
  category?: string | null;
  product?: string | null;
  sourceId?: number | null;
  clientIds?: number[] | null;
};

export function inboundProductOptionsFromRows(
  rows: Array<{productAffinity:string|null;affinityReviews:Record<string,unknown>|null}>,
  categoryRules: Awaited<ReturnType<typeof loadInboundCategoryRules>>,
) {
  const products=new Map<string,{name:string;categoryName:string;subcategoryName:string|null}>(
    inboundProducts.map(product=>[`${product.categoryName}:${product.name}`,product]));
  for(const row of rows){
    for(const selection of splitSelections(row.productAffinity)){
      if(row.affinityReviews?.[selection]==="rejected")continue;
      const product=inboundCategoryForInterest(selection,row.affinityReviews,categoryRules);
      products.set(`${product.categoryName}:${product.productName}`,{
        name:product.productName,categoryName:product.categoryName,
        subcategoryName:product.subcategoryName,
      });
    }
  }
  return [...products.values()].sort((a,b)=>a.categoryName.localeCompare(b.categoryName)||a.name.localeCompare(b.name));
}

export async function getInboundDashboard(tenantId: number, filters: InboundDashboardFilters) {
  const categoryRules = await loadInboundCategoryRules(tenantId);
  const rows = await pool.query<{
    submissionId:number;clientId:number;accountId:number;accountName:string;contactId:number|null;
    productAffinity:string|null;classification:"hot"|"warm"|"cold";routingStatus:string;
    affinityReviews:Record<string,unknown>|null;manualSelection:string|null;updatedAt:Date;
  }>(`SELECT s.id AS "submissionId",s.client_id AS "clientId",s.account_id AS "accountId",c.name AS "accountName",
      s.contact_id AS "contactId",s.product_interest AS "productAffinity",
      s.classification,s.routing_status AS "routingStatus",s.affinity_reviews AS "affinityReviews",
      mr.selection AS "manualSelection",s.updated_at AS "updatedAt"
    FROM intent_inbound_submissions s
    JOIN companies c ON c.tenant_id=s.tenant_id AND c.id=s.account_id
    LEFT JOIN intent_inbound_manual_routes mr ON mr.tenant_id=s.tenant_id AND mr.submission_id=s.id
    WHERE s.tenant_id=$1 AND ($2::text IS NULL OR s.form_type=$2)
      AND ${canonicalInboundSubmissionSql("s")}
      AND ($3::int IS NULL OR COALESCE(s.submitted_at,s.created_at)>=NOW()-$3::int*INTERVAL '1 day')
      AND ($4::int IS NULL OR s.source_id=$4)
      AND ($5::int[] IS NULL OR s.client_id=ANY($5::int[]))
    ORDER BY s.id DESC`,[tenantId,filters.formType??null,filters.dateRange??null,filters.sourceId??null,filters.clientIds??null]);

  const reviewed=applyAccountCategoryReviews(rows.rows);
  const selected=reviewed.flatMap(row=>{
    if(!filters.category&&!filters.product)return [row];
    const selections=splitSelections(row.productAffinity);
    if(!filters.product&&!selections.some(selection=>!/^(?:n\/?a|none|no|nil|not interested|-+)$/i.test(selection))
      &&filters.category===(categoryForMissingInterest(row.affinityReviews)??"No Category"))return [row];
    const matching=selections.filter(selection=>{
      if(row.affinityReviews?.[selection]==="rejected")return false;
      const assigned=inboundCategoryForInterest(selection,row.affinityReviews,categoryRules);
      return (!filters.category||assigned.categoryName===filters.category)
        &&(!filters.product||assigned.productName===filters.product);
    });
    return matching.length?[{...row,productAffinity:matching.join("; ")}]:[];
  });
  const productOptions=inboundProductOptionsFromRows(reviewed,categoryRules);
  const selectedAccountIds=[...new Set(selected.map(row=>Number(row.accountId)))];
  const accountTiers=selectedAccountIds.length?await pool.query<{account_id:number;classification:"hot"|"warm"|"cold"}>(
    `SELECT account_id,CASE WHEN bool_or(classification='hot') THEN 'hot'
       WHEN bool_or(classification='warm') THEN 'warm' ELSE 'cold' END AS classification
      FROM intent_inbound_submissions WHERE tenant_id=$1 AND account_id=ANY($2::int[])
        AND ($3::int IS NULL OR source_id=$3)
      GROUP BY account_id`,[tenantId,selectedAccountIds,filters.sourceId??null]):{rows:[]};
  const accounts=new Map<number,"hot"|"warm"|"cold"|"manual">(
    accountTiers.rows.map(row=>[Number(row.account_id),row.classification]));
  const contacts=new Set<number>();
  for(const row of selected){
    if(row.contactId)contacts.add(Number(row.contactId));
  }
  if(!filters.sourceId&&!filters.formType&&!filters.category&&!filters.product){
    const manual=await pool.query<{id:number}>(`SELECT c.id FROM companies c
      WHERE c.tenant_id=$1 AND c.inbound_manual=true
        AND ($3::int[] IS NULL OR c.client_id=ANY($3::int[]))
        AND ($2::int IS NULL OR COALESCE(c.inbound_manual_at,c.created_at)>=NOW()-$2::int*INTERVAL '1 day')
        AND NOT EXISTS(SELECT 1 FROM intent_inbound_submissions s WHERE s.tenant_id=c.tenant_id AND s.account_id=c.id)`,
      [tenantId,filters.dateRange??null,filters.clientIds??null]);
    for(const row of manual.rows)accounts.set(Number(row.id),"manual");
  }
  return {
    summary:{accounts:accounts.size,hot:[...accounts.values()].filter(value=>value==="hot").length,
      warm:[...accounts.values()].filter(value=>value==="warm").length,
      cold:[...accounts.values()].filter(value=>value==="cold").length,contacts:contacts.size},
    cohorts:groupInboundCategoryCohorts(selected,[],categoryRules).map(cohort=>{
      // Cohorts reflect response status; overall status uses all responses.
      // Identify the actual outlier accounts, not only their aggregate count.
      const cohortAccounts=cohort.accounts.map(account=>({
        ...account,
        ...(cohort.classification==="warm"&&accounts.get(account.id)==="hot"?{alsoHotOverall:true}:{}),
      }));
      return {
        ...cohort,accounts:cohortAccounts,
        alsoHotCount:cohortAccounts.filter(account=>account.alsoHotOverall).length,
      };
    }),
    options:{categories:[...inboundCategories,"Needs categorization","No Category"],products:productOptions},
    accountIds:[...accounts.keys()],
    submissionIds:[...new Set(selected.map(row=>Number(row.submissionId)))],
  };
}

export async function getInboundContactPage(
  tenantId: number, filters: InboundDashboardFilters, page: number, pageSize: number,
) {
  const dashboard=await getInboundDashboard(tenantId,filters);
  const total=dashboard.summary.contacts;
  if(!total)return {contacts:[],page,pageSize,total,totalPages:0};

  const rows=await pool.query<{
    id:number;name:string;email:string|null;phone:string|null;title:string|null;
    accountId:number;accountName:string;
  }>(`SELECT id,name,email,phone,title,"accountId","accountName"
    FROM (
      SELECT DISTINCT ON (s.contact_id)
        s.contact_id AS id,
        COALESCE(NULLIF(trim(concat_ws(' ',ct.first_name,ct.last_name)),''),'Contact #' || s.contact_id) AS name,
        ct.email,ct.phone,ct.title,
        s.account_id AS "accountId",c.name AS "accountName"
      FROM intent_inbound_submissions s
      JOIN companies c ON c.tenant_id=s.tenant_id AND c.id=s.account_id
      LEFT JOIN contacts ct ON ct.tenant_id=s.tenant_id AND ct.id=s.contact_id
      WHERE s.tenant_id=$1 AND s.id=ANY($2::int[]) AND s.contact_id IS NOT NULL
      ORDER BY s.contact_id,s.created_at DESC,s.id DESC
    ) matched
    ORDER BY lower("accountName"),lower(name),id
    LIMIT $3 OFFSET $4`,
    [tenantId,dashboard.submissionIds,pageSize,(page-1)*pageSize]);

  return {contacts:rows.rows,page,pageSize,total,totalPages:Math.ceil(total/pageSize)};
}