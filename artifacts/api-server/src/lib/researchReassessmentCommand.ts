import fs from "node:fs";
import path from "node:path";
import { pool } from "@workspace/db";
import { reassessResearchFinding, type StoredResearchFinding } from "./researchFindingReassessment";
import { RESEARCH_FITMENT_POLICY_VERSION, rebuildResearchOpportunityLocally } from "./researchOpportunityInterpreter";
import type { SignalProduct } from "./signalProductFit";
import type { ProviderEvent } from "./intentProviders";

/** Development-only, account-scoped preview. No apply mode. */
export async function runResearchReassessment(args: string[]) {
  const [tenantArg, accountArg, reportFile] = args;
  if (args.length !== 3 || !/^[1-9]\d*$/.test(tenantArg ?? "") || !/^[1-9]\d*$/.test(accountArg ?? "")
    || !reportFile || process.env.NODE_ENV !== "development") {
    throw new Error("Use development only: research:reassess TENANT_ID ACCOUNT_ID REPORT_JSON. This command is preview-only.");
  }
  const tenantId = Number(tenantArg), accountId = Number(accountArg);
  const client = await pool.connect();
  try {
    await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await client.query("SET LOCAL statement_timeout = '15s'");
    const company = (await client.query<{name:string;industry:string|null}>(
      "SELECT name,industry FROM companies WHERE tenant_id=$1 AND id=$2", [tenantId,accountId])).rows[0];
    if (!company) throw new Error("Account not found in this tenant.");
    const catalog = (await client.query<SignalProduct & {categoryId:number}>(`SELECT p.id,p.name,c.id AS "categoryId",c.name AS category,s.name AS subcategory
      FROM intent_products p JOIN intent_product_categories c ON c.tenant_id=p.tenant_id AND c.id=p.category_id
      LEFT JOIN intent_product_subcategories s ON s.tenant_id=p.tenant_id AND s.id=p.subcategory_id
      WHERE p.tenant_id=$1 AND p.active=true ORDER BY p.id`, [tenantId])).rows;
    const findings = (await client.query<StoredResearchFinding & {occurredAt:Date;confidence:number;rawEvidence:{excerpt?:string}|null}>(`SELECT id,event_type AS "eventType",excerpt,source_url AS "sourceUrl",
      review_status AS "reviewStatus",product_id AS "productId",context,occurred_at AS "occurredAt",confidence,raw_evidence AS "rawEvidence"
      FROM intent_evidence WHERE tenant_id=$1 AND account_id=$2 AND evidence_kind='public_event'
      ORDER BY occurred_at DESC,id DESC LIMIT 1001`, [tenantId,accountId])).rows;
    if (findings.length > 1000) throw new Error("Account exceeds 1,000 findings. Narrow the export before reassessing; no partial report was produced.");
    const reviewed = findings.map(row => ({...row, context:{...row.context,
      originalExcerpt:row.rawEvidence?.excerpt || row.context?.originalExcerpt}}));
    const storedBrief = findings.find(row => row.context?.opportunityBrief)?.context.opportunityBrief ?? null;
    const now = Date.now();
    const evidence:ProviderEvent[] = reviewed.filter(row => row.reviewStatus === "approved"
      && now-new Date(row.occurredAt).getTime() <= 90*86_400_000).map(row => ({
        eventType:row.eventType as ProviderEvent["eventType"],excerpt:row.excerpt,
        occurredAt:row.occurredAt.toISOString(),sourceUrl:row.sourceUrl??undefined,
        context:row.context,confidence:row.confidence,
      }));
    const report = {
      mode:"preview_only", applied:false, tenantId,accountId,accountName:company.name,
      policyVersion:RESEARCH_FITMENT_POLICY_VERSION,
      boundaries:"No database writes, AI calls, BI/form qualification, fiscal totals, order value or automation changes. First-party evidence is intentionally excluded from this public-research preview.",
      authorization:"This JSON is a proposal only, never approval. Applying a correction requires a new server-issued proposal and explicit per-finding admin approval in the account Research tab.",
      findings:reviewed.map(row => reassessResearchFinding(row,catalog)),
      opportunityBrief:{before:storedBrief,proposed:rebuildResearchOpportunityLocally({
        company:{name:company.name,industry:company.industry??undefined},evidence,catalog,firstParty:[],storedBrief,
      })},
    };
    await client.query("ROLLBACK");
    fs.mkdirSync(path.dirname(reportFile),{recursive:true});
    fs.writeFileSync(reportFile,JSON.stringify(report,null,2),{flag:"wx",mode:0o600});
    return report;
  } catch (error) {
    await client.query("ROLLBACK").catch(()=>undefined);
    throw error;
  } finally {
    client.release();
  }
}
