import { loadHpMonitoringContext } from "../lib/hpMonitoringContext";
import { Router, type IRouter, type Request, type Response } from "express";
import { permittedClientIds } from "../lib/requestClientScope";
import type { PoolClient } from "pg";
import { canonicalInboundSubmissionSql } from "../lib/inboundSubmissionDuplicates";
import { pool } from "@workspace/db";
import { selectMonitoringRoster } from "../lib/monitoringRosterAudience";
import { monitoringHistory } from "../lib/monitoringHistory";
import monitoringHistoryAccountsRouter from "./monitoringHistoryAccounts";
import { isHpClient, resolveHpAccount, ensureHpProfile } from "../lib/hpBiImport";
import { db } from "@workspace/db";
import { AddManualInboundAccountBody } from "@workspace/api-zod";
import { sql } from "drizzle-orm";
import { z } from "zod/v4";
import { z as apiZ } from "zod";
import { createHash } from "node:crypto";
import { deleteOneInboundResponse } from "../lib/deleteCrmEntity";
import { requireAuth } from "../middlewares/requireAuth";
import { apiSection } from "../middlewares/sectionAccess";
import { canAccess, hasSectionGrant, type SectionPermissions } from "@workspace/api-zod";
import { registerInboundSubmissionDateRoute } from "./inboundSubmissionDate";
import { ensureIntentDefaults, enqueueIntent, eventFingerprint, isPurchaseStageSignal, matchEntities, normalizedDomain, PUBLIC_EVENT_TYPES, purchaseGateScore, questionnaireAgingSummary, questionnaireSignalAudit, readProductIntentScore, readProductIntentScores, recomputeIntent, saturateRepeatedSignals, selectIntentTier, signalDecay } from "../lib/alwaysOnIntent";
import { buildContactsWhereClause, type FilterCriterion } from "../utils/segmentFilter";
import { fetchApolloContacts, fetchNewsEvents, fetchPerplexityEvents, IntentProviderError, providerConfigured, providerRequestLimit, PUBLIC_RESEARCH_WINDOW_SQL, type ProviderEvent, type ProviderStats, type ResearchProvider } from "../lib/intentProviders";
import { RESEARCH_FITMENT_POLICY_VERSION, backfillStoredResearchOpportunities, rebuildStoredResearchOpportunityLocally, interpretResearchOpportunity, isCurrentResearchOpportunityBrief, researchAnalysisAvailability, type ResearchOpportunityBrief } from "../lib/researchOpportunityInterpreter";
import { isResearchGeographyEligible, researchGeographyAssessment } from "../lib/researchGeography";
import { isFreshPublicResearchEvidence } from "../lib/researchFreshness";
import { kickIntentResearchRunner } from "../intentResearchRunner";
import {
  QUESTIONNAIRE_DIMENSION_DEFAULTS,
  UPLOADED_ANSWER_APPROVAL_POLICY,
  UPLOADED_ANSWER_SIGNAL_TYPES,
  uploadedAnswerSignals,
  type QuestionnaireDimension,
} from "../lib/intentImportAnswers";
import { inferProductsFromInterest, type ImportCatalogProduct } from "../lib/intentImportProductMatching";
import { toJsonParameter } from "../lib/intentImportJson";
import { logger } from "../lib/logger";
import { readContactEngagementEvidence } from "../lib/contactEngagementEvidence";
import { inboundSignalType, inboundSourceRef, readFirstPartySignalSource, type FirstPartySourceRef } from "../lib/firstPartySignalSource";
import { hasLinkedCrmRecords } from "../lib/manualInboundAccount";
import { normalizeSpreadsheetDate, normalizeSpreadsheetTime } from "../lib/intentImportDateValues";
import { isHpClientName, recommendHpSolutions } from "../lib/hpSolutionFit";
import { analyzeProductFitment, prepareProductFitmentSource } from "../lib/signalProductFit";
import { classifyResearchEvidence, validatedResearchFitments, normalizedResearchEvidenceKey, researchEvidenceHeat, type ResearchEvidenceLevel } from "../lib/researchIntentEvidence";
import { isUnattributedResearch as isUnattributedProcurement, publicResearchMismatchReason } from "../lib/publicResearchAttribution";
import { intentTierRank, isStrongerIntentCandidate, selectCanonicalCategoryIntent } from "../lib/canonicalCategoryIntent";
import { readIntentGoogleSheet } from "../lib/googleSheetsIntent";
import { evaluateTwoLevelIntentStatus, type IntentStatusEvidence } from "../lib/twoLevelIntentStatus";
import { scheduleImmediateAccountResearch } from "../intentWeeklyResearchScheduler";
import { monitoringAccountOptions } from "../lib/monitoringAccountOptions";
import { monitoringNeedsActivation } from "../lib/monitoringScheduleActivation";
import { registerMonitoringRetryRoutes } from "./monitoringRetry";
import { readLatestMonitoringRuns, monitoringRunIsFresh } from "../lib/monitoringRunProgress";
import { readProductIntentActivity } from "../lib/alwaysOnIntent";
import { canonicalizeInbound, classifyInbound, driveFolderId, googleDriveConnectionAvailable, groupInboundCategoryCohorts, groupInboundRuleCohorts, groupUnconfiguredInboundAffinities, inboundMappingTargets, MissingInboundCompanyMappingError, previewInboundSource, repairInboundProductInterestClassifications, routeInboundRespondent, routePendingWarmSubmissions, splitSelections, summarizeEventFeedback, syncInboundSource } from "../lib/inboundAccounts";
import { getInboundContactPage, getInboundDashboard, inboundProductOptionsFromRows } from "../lib/inboundDashboard";
import { applyAccountCategoryReviews, categoryForMissingInterest, inboundCategories, inboundCategoryForInterest, loadInboundCategoryRules, validateInboundCategoryRules, type InboundCategoryConfig } from "../lib/inboundTaxonomy";
import { groupInboundRespondents } from "../lib/inboundRespondents";
import { accountRoutingDestinations, type NamedInboundRule } from "../lib/inboundAccountRoutes";
import { readAccountAdditiveScore, readContactAdditiveScore } from "../lib/additiveIntentScore";

type User = { id: number; tenantId: number; role: string; sectionPermissions?: SectionPermissions | null };
type ImportKind = "account_list" | "baseline" | "firmographic" | "event_feedback" | "event_questionnaire" | "lead_form" | "product_buy_intent" | "consulting";
const router: IRouter = Router();
router.use(requireAuth);
registerMonitoringRetryRoutes(router);

function productSignalPoints(maxPoints: number, strength: number, payload: unknown) {
  const fitmentPoints = payload && typeof payload === "object" ? Number((payload as Record<string, unknown>).fitmentPoints) : NaN;
  return Number.isFinite(fitmentPoints) ? Math.max(0, Math.min(100, fitmentPoints)) : maxPoints * strength / 100;
}

function tierHeat(tier:string|null|undefined){
  return intentTierRank(tier);
}

export function canonicalCategoryIntent(productAnalysis:any,researchIntent:any,selectedOnly:boolean,hotMin=70,categoryConfig:InboundCategoryConfig={rules:[],useBuiltin:true}){
  const productCandidates=(productAnalysis?.topCategories??[])
    .filter((category:any)=>!selectedOnly||category.inSelectedScope)
    .map((category:any)=>({
      categoryName:category.category,
      score:category.score,
      tier:category.tier,
      rationale:category.explanation,
      strongestProduct:category.strongestProduct,
      signalCount:category.signalCount,
      hasRecentPurchaseSignal:Boolean(category.hasRecentPurchaseSignal),
      source:category.explicitSource??(category.questionnaireDriven?"questionnaire":"approved_signals"),
      inSelectedScope:category.inSelectedScope,
    }));
  const conclusions=selectedOnly
    ? [researchIntent?.opportunityBrief?.bestSelectedConclusion].filter(Boolean)
    : (researchIntent?.opportunityBrief?.categoryConclusions??[]);
  const researchCandidates=conclusions
    .filter((conclusion:any)=>{
      const evidence=conclusion.propensity?.evidence;
      return Array.isArray(evidence)
        &&(Boolean(conclusion.propensity?.hasRecentPurchaseSignal)||evidence.length>=2);
    })
    .map((conclusion:any)=>{
    const suggestedProducts=(conclusion.recommendedProducts??[]).map((item:any)=>String(item.name??"")).filter(Boolean);
    const categoryMatch=inboundCategoryForInterest([conclusion.categoryName,...suggestedProducts].join(" "),null,categoryConfig);
    return {
      categoryName:inboundCategories.includes(categoryMatch.categoryName)?categoryMatch.categoryName:null,
      score:conclusion.score,
      tier:conclusion.tier,
      rationale:conclusion.rationale,
      strongestProduct:conclusion.recommendedProducts?.[0]?.name??null,
      signalCount:conclusion.propensity?.evidence?.length??0,
      confidence:conclusion.propensity?.dataConfidence,
      hasRecentPurchaseSignal:conclusion.propensity?.hasRecentPurchaseSignal,
      source:"research_propensity",
      inSelectedScope:selectedOnly,
    };
  }).filter((candidate:any)=>candidate.categoryName);
  const candidates=[...productCandidates,...researchCandidates]
    .filter(candidate=>Number(candidate.score)>0)
    .map(candidate=>candidate.tier==="hot"&&!candidate.hasRecentPurchaseSignal
      ? {...candidate,score:Math.min(Number(candidate.score),Math.max(0,hotMin-1)),tier:"warm",rationale:`${candidate.rationale??""} No explicit buying signal is present, so this account cannot be Hot.`.trim()}
      : candidate);
  return selectCanonicalCategoryIntent(candidates);
}

export function effectiveDetailIntent(
  isAccount:boolean,
  categoryIntent:{score:number;tier:string}|null|undefined,
  scoped:{score:number;tier:string}|null|undefined,
  stored:{score:number;tier:string},
){
  if(!isAccount)return {score:stored.score,tier:stored.tier};
  return categoryIntent
    ? {score:categoryIntent.score,tier:categoryIntent.tier}
    : {score:0,tier:"cold"};
}

function selectedCategoryIntent(
  categoryName:string,
  productAnalysis:any,
  intentStatus:{categories?:Array<{name:string;status:string;attribution:string}>}|null|undefined,
){
  const categoryStatus=intentStatus?.categories?.find(item=>item.name===categoryName);
  if(categoryStatus&&categoryStatus.attribution!=="INHERITED_OPEN"){
    return {score:categoryStatus.status==="hot"?100:categoryStatus.status==="warm"?50:0,tier:categoryStatus.status};
  }
  const productCategory=productAnalysis?.topCategories?.find((item:any)=>item.category===categoryName);
  return productCategory&&Number(productCategory.score)>0
    ? {score:Number(productCategory.score),tier:String(productCategory.tier)}
    : {score:0,tier:"cold"};
}

export function declaredQuestionnaireIntentTier(
  hasExplicitProductInterest:boolean,
  timeframeStrength:number|null|undefined,
  productInterestAgeDays=0,
){
  if(!hasExplicitProductInterest||productInterestAgeDays>=60)return null;
  if(timeframeStrength!=null&&timeframeStrength>=90)return "hot";
  return "warm";
}

export function qualifyImplicitProductIntent(
  rawScore:number,
  tiers:{key:string;label:string;min_score:number}[],
  hasRecentPurchaseSignal:boolean,
  implicitSignalCount:number,
){
  if(hasRecentPurchaseSignal)return purchaseGateScore(rawScore,tiers,hasRecentPurchaseSignal);
  if(implicitSignalCount>=2)return purchaseGateScore(rawScore,tiers,false);
  return {score:0,tier:"cold"};
}

const fields = ["account_name", "domain", "industry", "size", "contact_name", "first_name", "last_name", "email", "phone", "title", "signal_type", "source", "external_id", "summary", "strength", "captured_at", "vertical", "function", "baseline_score", "kaboom_tag", "knowledge_interest", "product_service_interest", "product_interest", "purchase_timeframe", "follow_up_date", "follow_up_time", "challenges", "business_challenge", "rating", "event_rating", "session_rating", "comments", "form_name", "campaign", "lead_source", "response_text", "qualification", "budget", "decision_role"] as const;
const importSchema = z.object({
  kind: z.enum(["account_list", "baseline", "firmographic", "event_feedback", "event_questionnaire", "lead_form", "product_buy_intent", "consulting"]),
  clientId: z.number().int().positive().optional(),
  productId: z.number().int().positive().optional(),
  audienceId: z.number().int().positive().optional(),
  rows: z.array(z.record(z.string(), z.unknown())).min(1).max(5000),
  mapping: z.record(z.string(), z.union([z.enum(fields), z.literal("ignore")])).default({}),
});
const positiveId = (value: string) => {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
};
const positiveIds = (value: unknown) => [...new Set(String(value ?? "").split(",").map(positiveId).filter((id): id is number => id !== null))];
const pageOf = (req: Request) => ({
  page: Math.max(1, Number(req.query.page) || 1),
  pageSize: Math.min(100, Math.max(1, Number(req.query.pageSize) || 25)),
});
function admin(req: Request, res: Response): User | null {
  const user = req.user as User;
  const section = apiSection(req.path);
  if (user.role !== "admin" && !(section && (req.method === "GET"
      ? canAccess(user, section) : hasSectionGrant(user, section, true)))) {
    res.status(403).json({ error: "Administrator or delegated section access required" }); return null;
  }
  return user;
}

const monitoringConfigBody = z.object({
  enabled: z.boolean(),
  clientId: z.number().int().positive().nullable(),
  audienceIds: z.array(z.number().int().positive()).max(1000),
  segmentIds: z.array(z.number().int().positive()).max(1000),
  categoryIds: z.array(z.number().int().positive()).max(1000),
  dailyLimit: z.union([z.literal(100),z.literal(200),z.literal(400),z.literal(500),z.literal(1000)]),
});
const monitoringScheduleBody=monitoringConfigBody.extend({
  name:z.string().trim().min(1).max(120),
  accountIds:z.array(z.number().int().positive()).max(10000),
});

async function latestMonitoringRun(tenantId:number,configId:number,storedLaneCounts?:Record<string,any>){
  const runs=await readLatestMonitoringRuns(tenantId,configId);
  if(!runs.length)return null;
  const accountsTotal=runs.reduce((sum,run)=>sum+Number(run.summary?.accountsTotal??0),0);
  const accountsCompleted=runs.reduce((sum,run)=>sum+Number(run.summary?.accountsCompleted??0),0);
  const accountsFailed=runs.reduce((sum,run)=>sum+Number(run.summary?.accountsFailed??0),0);
  const accountsRemaining=runs.reduce((sum,run)=>sum+Number(run.summary?.accountsRemaining??run.summary?.accountsTotal??0),0);
  const laneCounts={warm:{eligible:0,scheduled:0,completed:0,deferred:0,failed:0},prospect:{eligible:0,scheduled:0,completed:0,deferred:0,failed:0}};
  for(const run of runs){
    const lane=run.summary?.monitoringLane;
    if(lane!=="warm"&&lane!=="prospect")continue;
    const reported=run.summary?.laneCounts as Partial<typeof laneCounts.warm>|undefined;
    if(!reported)continue;
    laneCounts[lane].eligible+=Number(reported.eligible??0);
    laneCounts[lane].scheduled+=Number(reported.scheduled??0);
    laneCounts[lane].deferred+=Number(reported.deferred??0);
    laneCounts[lane].completed+=Number(run.summary?.accountsCompleted??0);
    laneCounts[lane].failed+=Number(run.summary?.accountsFailed??0);
  }
  for(const lane of ["warm","prospect"] as const){
    const stored=storedLaneCounts?.[lane];
    if(!stored||runs.some(run=>run.summary?.retryOfId))continue;
    laneCounts[lane].eligible=Number(stored.eligible??laneCounts[lane].eligible);
    laneCounts[lane].scheduled=Number(stored.scheduled??laneCounts[lane].scheduled);
    laneCounts[lane].deferred=Number(stored.deferred??laneCounts[lane].deferred);
  }
  const isFreshActive=(run:typeof runs[number])=>monitoringRunIsFresh(run);
  const active=runs.some(isFreshActive);
  const staleActive=runs.some(run=>(run.status==="queued"||run.status==="running")&&!isFreshActive(run));
  return {
    status:active?(runs.every(run=>run.status==="queued")?"queued":"running")
      :staleActive?(accountsCompleted>0?"partial":"failed")
      :accountsFailed===accountsTotal&&accountsTotal>0?"failed"
      :accountsFailed>0||runs.some(run=>run.status==="partial"||run.status==="failed")?(accountsCompleted>0?"partial":"failed")
      :"completed",
    startedAt:runs.reduce((earliest,run)=>!earliest||run.startedAt<earliest?run.startedAt:earliest,null as Date|null),
    completedAt:active?null:runs.reduce((latest,run)=>run.completedAt&&(!latest||run.completedAt>latest)?run.completedAt:latest,null as Date|null),
    accountsTotal,accountsCompleted,accountsFailed,accountsRemaining,laneCounts,
    providers:runs.map(run=>({runId:run.id,provider:run.provider,status:(run.status==="queued"||run.status==="running")&&!isFreshActive(run)?"failed":run.status,accountsFailed:Number(run.summary?.accountsFailed??0)})),
    capacityWarning:runs.some(run=>run.summary?.capacityWarning===true),
  };
}

async function monitoringConfig(tenantId: number) {
  const config = await pool.query<any>(
    `SELECT id,enabled,client_id AS "clientId",daily_limit AS "dailyLimit",last_lane_counts AS "lastLaneCounts",
            last_scheduled_at AS "lastScheduledAt",last_scheduled_count AS "lastScheduledCount"
       FROM intent_monitoring_configs WHERE tenant_id=$1`, [tenantId],
  );
  if (!config.rows[0]) return { enabled: false, clientId: null, audienceIds: [], segmentIds: [], categoryIds: [], dailyLimit: 500, lastScheduledAt: null, lastScheduledCount: 0, lastLaneCounts: {warm:{eligible:0,scheduled:0,completed:0,deferred:0,failed:0},prospect:{eligible:0,scheduled:0,completed:0,deferred:0,failed:0}}, latestRun: null };
  const row = config.rows[0];
  const [audiences, segments, categories, latestRun] = await Promise.all([
    pool.query<{audienceId:number}>(`SELECT audience_id AS "audienceId" FROM intent_monitoring_audiences WHERE tenant_id=$1 AND config_id=$2`, [tenantId, row.id]),
    pool.query<{segmentId:number}>(`SELECT segment_id AS "segmentId" FROM intent_monitoring_segments WHERE tenant_id=$1 AND config_id=$2`, [tenantId, row.id]),
    pool.query<{categoryId:number}>(`SELECT category_id AS "categoryId" FROM intent_monitoring_categories WHERE tenant_id=$1 AND config_id=$2`, [tenantId, row.id]),
    latestMonitoringRun(tenantId,row.id,row.lastLaneCounts),
  ]);
  return { ...row, audienceIds: audiences.rows.map(x => x.audienceId), segmentIds: segments.rows.map(x => x.segmentId), categoryIds: categories.rows.map(x => x.categoryId), latestRun };
}

router.get("/intent/monitoring-config", async (req, res, next) => {
  try { const u = admin(req, res); if (!u) return; res.json(await monitoringConfig(u.tenantId)); } catch (e) { next(e); }
});

router.put("/intent/monitoring-config", async (req, res, next) => {
  const u = admin(req, res); if (!u) return;
  const parsed = monitoringConfigBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const p = parsed.data;
  const audienceIds = [...new Set(p.audienceIds)], segmentIds = [...new Set(p.segmentIds)], categoryIds = [...new Set(p.categoryIds)];
  if (p.enabled && ((!audienceIds.length && !segmentIds.length) || !categoryIds.length)) {
    res.status(400).json({ error: "Enabled monitoring requires databases and categories" }); return;
  }
  try {
    if (p.clientId && !(await pool.query("SELECT 1 FROM clients WHERE tenant_id=$1 AND id=$2", [u.tenantId, p.clientId])).rowCount) {
      res.status(400).json({ error: "Invalid client" }); return;
    }
    if ((await pool.query("SELECT count(*)::int AS count FROM intent_audiences WHERE tenant_id=$1 AND id=ANY($2::int[])", [u.tenantId, audienceIds])).rows[0].count !== audienceIds.length) {
      res.status(400).json({ error: "Invalid database scope" }); return;
    }
    if ((await pool.query("SELECT count(*)::int AS count FROM segments WHERE tenant_id=$1 AND id=ANY($2::int[])", [u.tenantId, segmentIds])).rows[0].count !== segmentIds.length) {
      res.status(400).json({ error: "Invalid database segment scope" }); return;
    }
    if ((await pool.query("SELECT count(*)::int AS count FROM intent_product_categories WHERE tenant_id=$1 AND id=ANY($2::int[])", [u.tenantId, categoryIds])).rows[0].count !== categoryIds.length) {
      res.status(400).json({ error: "Invalid category scope" }); return;
    }
    const c = await pool.connect();
    let activatedConfig:{id:number;activationKey:string}|null=null;
    try {
      await c.query("BEGIN");
      await c.query("SELECT pg_advisory_xact_lock($1,$2)",[73421,u.tenantId]);
      const existing=await c.query<{id:number;enabled:boolean}>("SELECT id,enabled FROM intent_monitoring_configs WHERE tenant_id=$1 ORDER BY id LIMIT 1 FOR UPDATE",[u.tenantId]);
      const saved = existing.rows[0]
        ? await c.query<{id:number;updated_at:Date}>(`UPDATE intent_monitoring_configs SET client_id=$1,enabled=$2,daily_limit=$3,updated_at=NOW() WHERE tenant_id=$4 AND id=$5 RETURNING id,updated_at`,[p.clientId,p.enabled,p.dailyLimit,u.tenantId,existing.rows[0].id])
        : await c.query<{id:number;updated_at:Date}>(`INSERT INTO intent_monitoring_configs(tenant_id,client_id,enabled,daily_limit) VALUES($1,$2,$3,$4) RETURNING id,updated_at`,[u.tenantId,p.clientId,p.enabled,p.dailyLimit]);
      const id = saved.rows[0].id;
      await c.query("DELETE FROM intent_monitoring_audiences WHERE tenant_id=$1 AND config_id=$2", [u.tenantId, id]);
      await c.query("DELETE FROM intent_monitoring_segments WHERE tenant_id=$1 AND config_id=$2", [u.tenantId, id]);
      await c.query("DELETE FROM intent_monitoring_categories WHERE tenant_id=$1 AND config_id=$2", [u.tenantId, id]);
      if (audienceIds.length) await c.query("INSERT INTO intent_monitoring_audiences(tenant_id,config_id,audience_id) SELECT $1,$2,x FROM unnest($3::int[]) x ON CONFLICT DO NOTHING", [u.tenantId, id, audienceIds]);
      if (segmentIds.length) await c.query("INSERT INTO intent_monitoring_segments(tenant_id,config_id,segment_id) SELECT $1,$2,x FROM unnest($3::int[]) x ON CONFLICT DO NOTHING", [u.tenantId, id, segmentIds]);
      if (categoryIds.length) await c.query("INSERT INTO intent_monitoring_categories(tenant_id,config_id,category_id) SELECT $1,$2,x FROM unnest($3::int[]) x ON CONFLICT DO NOTHING", [u.tenantId, id, categoryIds]);
      await c.query("COMMIT");
      if(p.enabled&&!existing.rows[0]?.enabled)activatedConfig={id,activationKey:`${id}:${saved.rows[0].updated_at.toISOString()}`};
    } catch (e) { await c.query("ROLLBACK"); throw e; } finally { c.release(); }
    if(activatedConfig)await scheduleImmediateAccountResearch(u.tenantId,activatedConfig.id,activatedConfig.activationKey);
    res.json({...await monitoringConfig(u.tenantId),startedImmediately:Boolean(activatedConfig)});
  } catch (e) { next(e); }
});

async function monitoringSchedules(tenantId:number, clientIds:number[]|null=null){
  const configs=await pool.query<any>(`SELECT id,name,enabled,client_id AS "clientId",daily_limit AS "dailyLimit",last_lane_counts AS "lastLaneCounts",
    last_scheduled_at AS "lastScheduledAt",last_scheduled_count AS "lastScheduledCount",created_at AS "createdAt",updated_at AS "updatedAt"
    FROM intent_monitoring_configs WHERE tenant_id=$1 AND ($2::int[] IS NULL OR client_id=ANY($2::int[]))
    ORDER BY created_at,id`,[tenantId,clientIds]);
  if(!configs.rows.length)return [];
  const ids=configs.rows.map(row=>row.id);
  const [audiences,segments,categories,accounts]=await Promise.all([
    pool.query<any>(`SELECT config_id AS "configId",audience_id AS id FROM intent_monitoring_audiences WHERE tenant_id=$1 AND config_id=ANY($2::int[])`,[tenantId,ids]),
    pool.query<any>(`SELECT config_id AS "configId",segment_id AS id FROM intent_monitoring_segments WHERE tenant_id=$1 AND config_id=ANY($2::int[])`,[tenantId,ids]),
    pool.query<any>(`SELECT config_id AS "configId",category_id AS id FROM intent_monitoring_categories WHERE tenant_id=$1 AND config_id=ANY($2::int[])`,[tenantId,ids]),
    pool.query<any>(`SELECT config_id AS "configId",company_id AS id FROM intent_monitoring_accounts WHERE tenant_id=$1 AND config_id=ANY($2::int[])`,[tenantId,ids]),
  ]);
  const idsFor=(rows:any[],configId:number)=>rows.filter(row=>row.configId===configId).map(row=>row.id);
  return Promise.all(configs.rows.map(async row=>({...row,audienceIds:idsFor(audiences.rows,row.id),segmentIds:idsFor(segments.rows,row.id),categoryIds:idsFor(categories.rows,row.id),accountIds:idsFor(accounts.rows,row.id),latestRun:await latestMonitoringRun(tenantId,row.id,row.lastLaneCounts)})));
}

async function validateMonitoringSchedule(tenantId:number,p:z.infer<typeof monitoringScheduleBody>){
  const audienceIds=[...new Set(p.audienceIds)],segmentIds=[...new Set(p.segmentIds)],categoryIds=[...new Set(p.categoryIds)],accountIds=[...new Set(p.accountIds)];
  if(p.enabled&&(!audienceIds.length&&!segmentIds.length&&!accountIds.length||!categoryIds.length))throw new Error("Enabled monitoring requires at least one database, segment, or account and one category");
  if(p.clientId&&!(await pool.query("SELECT 1 FROM clients WHERE tenant_id=$1 AND id=$2",[tenantId,p.clientId])).rowCount)throw new Error("Invalid client");
  const checks=await Promise.all([
    pool.query<{count:number}>("SELECT count(*)::int AS count FROM intent_audiences WHERE tenant_id=$1 AND id=ANY($2::int[]) AND ($3::int IS NULL OR client_id IS NULL OR client_id=$3)",[tenantId,audienceIds,p.clientId]),
    pool.query<{count:number}>("SELECT count(*)::int AS count FROM segments WHERE tenant_id=$1 AND id=ANY($2::int[])",[tenantId,segmentIds]),
    pool.query<{count:number}>("SELECT count(*)::int AS count FROM intent_product_categories WHERE tenant_id=$1 AND id=ANY($2::int[])",[tenantId,categoryIds]),
    pool.query<{count:number}>("SELECT count(*)::int AS count FROM companies WHERE tenant_id=$1 AND id=ANY($2::int[]) AND client_id IS NOT NULL AND ($3::int IS NULL OR client_id=$3)",[tenantId,accountIds,p.clientId]),
  ]);
  if(checks[0].rows[0].count!==audienceIds.length)throw new Error("Invalid database scope");
  if(checks[1].rows[0].count!==segmentIds.length)throw new Error("Invalid segment scope");
  if(checks[2].rows[0].count!==categoryIds.length)throw new Error("Invalid category scope");
  if(checks[3].rows[0].count!==accountIds.length)throw new Error("Invalid or unassigned account scope; assign each account to a client before monitoring");
  return {audienceIds,segmentIds,categoryIds,accountIds};
}

async function saveMonitoringSchedule(tenantId:number,p:z.infer<typeof monitoringScheduleBody>,configId?:number){
  const scopes=await validateMonitoringSchedule(tenantId,p);
  const c=await pool.connect();
  let activated=false;
  let id=0;
  let activationKey="";
  try{
    await c.query("BEGIN");
    await c.query("SELECT pg_advisory_xact_lock($1,$2)",[73421,tenantId]);
    const existing=configId?await c.query<{
      id:number;enabled:boolean;clientId:number|null;dailyLimit:number;
      audienceIds:number[];segmentIds:number[];categoryIds:number[];accountIds:number[];
    }>(`SELECT c.id,c.enabled,c.client_id AS "clientId",c.daily_limit AS "dailyLimit",
      ARRAY(SELECT audience_id FROM intent_monitoring_audiences WHERE tenant_id=c.tenant_id AND config_id=c.id) AS "audienceIds",
      ARRAY(SELECT segment_id FROM intent_monitoring_segments WHERE tenant_id=c.tenant_id AND config_id=c.id) AS "segmentIds",
      ARRAY(SELECT category_id FROM intent_monitoring_categories WHERE tenant_id=c.tenant_id AND config_id=c.id) AS "categoryIds",
      ARRAY(SELECT company_id FROM intent_monitoring_accounts WHERE tenant_id=c.tenant_id AND config_id=c.id) AS "accountIds"
      FROM intent_monitoring_configs c WHERE c.tenant_id=$1 AND c.id=$2 FOR UPDATE`,[tenantId,configId]):{rows:[]};
    if(configId&&!existing.rows[0])throw new Error("Monitoring schedule not found");
    const saved=existing.rows[0]
      ?await c.query<{id:number;updated_at:Date}>(`UPDATE intent_monitoring_configs SET name=$1,client_id=$2,enabled=$3,daily_limit=$4,updated_at=NOW() WHERE tenant_id=$5 AND id=$6 RETURNING id,updated_at`,[p.name,p.clientId,p.enabled,p.dailyLimit,tenantId,configId])
      :await c.query<{id:number;updated_at:Date}>(`INSERT INTO intent_monitoring_configs(tenant_id,name,client_id,enabled,daily_limit) VALUES($1,$2,$3,$4,$5) RETURNING id,updated_at`,[tenantId,p.name,p.clientId,p.enabled,p.dailyLimit]);
    id=saved.rows[0].id;
    for(const table of ["intent_monitoring_audiences","intent_monitoring_segments","intent_monitoring_categories","intent_monitoring_accounts"])await c.query(`DELETE FROM ${table} WHERE tenant_id=$1 AND config_id=$2`,[tenantId,id]);
    const inserts:[string,number[]][]=[
      ["audience_id",scopes.audienceIds],["segment_id",scopes.segmentIds],["category_id",scopes.categoryIds],["company_id",scopes.accountIds],
    ];
    const tables=["intent_monitoring_audiences","intent_monitoring_segments","intent_monitoring_categories","intent_monitoring_accounts"];
    for(let i=0;i<inserts.length;i++)if(inserts[i][1].length)await c.query(`INSERT INTO ${tables[i]}(tenant_id,config_id,${inserts[i][0]}) SELECT $1,$2,x FROM unnest($3::int[]) x ON CONFLICT DO NOTHING`,[tenantId,id,inserts[i][1]]);
    activated=monitoringNeedsActivation({...p,...scopes},existing.rows[0]);
    activationKey=`${id}:${saved.rows[0].updated_at.toISOString()}`;
    await c.query("COMMIT");
  }catch(error){await c.query("ROLLBACK");throw error;}finally{c.release();}
  return {id,activated,activationKey};
}

function startMonitoringScheduleInBackground(tenantId:number,configId:number,activationKey:string){
  void scheduleImmediateAccountResearch(tenantId,configId,activationKey)
    .catch(error=>logger.warn({tenantId,configId,err:error},"Immediate intent monitoring scheduling failed"));
}

router.use(monitoringHistoryAccountsRouter);
router.get("/intent/monitoring-history",async(req,res,next)=>{
  try{
    const u=admin(req,res);if(!u)return;
    const parsed=z.object({days:z.coerce.number().int().min(1).max(90).default(30),
      configId:z.coerce.number().int().positive().optional()}).safeParse(req.query);
    if(!parsed.success){res.status(400).json({error:"Choose a valid schedule and a range of 1–90 days"});return;}
    if(parsed.data.configId&&!(await pool.query("SELECT 1 FROM intent_monitoring_configs WHERE tenant_id=$1 AND id=$2",[u.tenantId,parsed.data.configId])).rowCount){
      res.status(404).json({error:"Monitoring schedule not found"});return;
    }
    res.json(await monitoringHistory(u.tenantId,parsed.data.days,parsed.data.configId,permittedClientIds(req)));
  }catch(error){next(error);}
});
router.get("/intent/monitoring-configs",async(req,res,next)=>{try{const u=admin(req,res);if(!u)return;res.json({schedules:await monitoringSchedules(u.tenantId,permittedClientIds(req))});}catch(error){next(error);}});
router.post("/intent/monitoring-configs",async(req,res,next)=>{try{const u=admin(req,res);if(!u)return;const parsed=monitoringScheduleBody.safeParse(req.body);if(!parsed.success){res.status(400).json({error:parsed.error.message});return;}const saved=await saveMonitoringSchedule(u.tenantId,parsed.data);const schedule=(await monitoringSchedules(u.tenantId)).find(row=>row.id===saved.id);res.status(201).json({...schedule,startedImmediately:saved.activated});if(saved.activated)startMonitoringScheduleInBackground(u.tenantId,saved.id,saved.activationKey);}catch(error){if(error instanceof Error&&error.message.startsWith("Invalid")){res.status(400).json({error:error.message});return;}next(error);}});
router.put("/intent/monitoring-configs/:id",async(req,res,next)=>{try{const u=admin(req,res);if(!u)return;const id=positiveId(req.params.id);const parsed=monitoringScheduleBody.safeParse(req.body);if(!id||!parsed.success){res.status(400).json({error:parsed.success?"Invalid schedule":parsed.error.message});return;}const saved=await saveMonitoringSchedule(u.tenantId,parsed.data,id);const schedule=(await monitoringSchedules(u.tenantId)).find(row=>row.id===saved.id);res.json({...schedule,startedImmediately:saved.activated});if(saved.activated)startMonitoringScheduleInBackground(u.tenantId,saved.id,saved.activationKey);}catch(error){if(error instanceof Error&&(error.message.startsWith("Invalid")||error.message.includes("not found"))){res.status(error.message.includes("not found")?404:400).json({error:error.message});return;}next(error);}});
router.patch("/intent/monitoring-configs/:id/status",async(req,res,next)=>{try{const u=admin(req,res);if(!u)return;const id=positiveId(req.params.id);const parsed=z.object({enabled:z.boolean()}).safeParse(req.body);if(!id||!parsed.success){res.status(400).json({error:"Invalid schedule status"});return;}const result=await pool.query(`UPDATE intent_monitoring_configs SET enabled=$1,updated_at=NOW() WHERE tenant_id=$2 AND id=$3 RETURNING id`,[parsed.data.enabled,u.tenantId,id]);if(!result.rowCount){res.status(404).json({error:"Monitoring schedule not found"});return;}res.json({ok:true});}catch(error){next(error);}});

const questionnaireRuleSchema = z.object({
  id: z.string().trim().min(1).max(80),
  label: z.string().trim().min(1).max(120),
  keywords: z.array(z.string().trim().min(1).max(100)).max(30),
  strength: z.number().int().min(0).max(100),
});
const questionnaireDimensionSchema = z.object({
  id: z.number().int().positive(),
  key: z.string().trim().min(1).max(80),
  label: z.string().trim().min(1).max(120),
  maxPoints: z.number().int().min(0).max(100),
  rules: z.array(questionnaireRuleSchema).min(1).max(20),
});
const questionnaireKeys = new Set(QUESTIONNAIRE_DIMENSION_DEFAULTS.map((dimension) => dimension.key));

async function ensureQuestionnaireDefaults(tenantId: number, executor: Pick<typeof pool, "query"> = pool) {
  for (const dimension of QUESTIONNAIRE_DIMENSION_DEFAULTS) {
    await executor.query(
      `INSERT INTO intent_questionnaire_settings(tenant_id,dimension,label,max_points,rules)
       VALUES($1,$2,$3,$4,$5) ON CONFLICT (tenant_id,dimension) DO NOTHING`,
      [tenantId, dimension.key, dimension.label, dimension.maxPoints, JSON.stringify(dimension.rules)],
    );
  }
}

async function readQuestionnaireSettings(tenantId: number, executor: Pick<typeof pool, "query"> = pool) {
  await ensureQuestionnaireDefaults(tenantId, executor);
  const result = await executor.query<{
    id: number;
    key: string;
    label: string;
    maxPoints: number;
    rules: QuestionnaireDimension["rules"];
  }>(
    `SELECT id,dimension AS key,label,max_points AS "maxPoints",rules
     FROM intent_questionnaire_settings WHERE tenant_id=$1 ORDER BY dimension`,
    [tenantId],
  );
  return result.rows;
}

async function rescoreQuestionnaireEvidence(
  tenantId: number,
  settings: QuestionnaireDimension[],
  executor: Pick<typeof pool, "query">,
) {
  const signals = await executor.query<{ id: number; payload: { answer?: { field?: unknown; value?: unknown } } | null }>(
    `SELECT s.id,s.payload
     FROM intent_signals s
     JOIN intent_signal_types st ON st.tenant_id=s.tenant_id AND st.id=s.signal_type_id
     WHERE s.tenant_id=$1 AND s.product_id IS NOT NULL AND st.category='questionnaire'`,
    [tenantId],
  );
  const updates: Array<{ id: number; strength: number; reason: string }> = [];
  for (const signal of signals.rows) {
    const field = typeof signal.payload?.answer?.field === "string" ? signal.payload.answer.field : "";
    const value = typeof signal.payload?.answer?.value === "string" ? signal.payload.answer.value : "";
    const rescoredAnswer = field && value ? uploadedAnswerSignals({ [field]: value }, settings)[0] : null;
    if (!rescoredAnswer) continue;
    updates.push({ id: signal.id, strength: rescoredAnswer.strength, reason: rescoredAnswer.reason });
  }
  for (let offset = 0; offset < updates.length; offset += 1000) {
    const chunk = updates.slice(offset, offset + 1000);
    const values = chunk.map((_, index) => {
      const base = index * 3;
      return `($${base + 1}::int,$${base + 2}::int,$${base + 3}::text)`;
    }).join(",");
    const parameters = chunk.flatMap((update) => [update.id, update.strength, update.reason]);
    await executor.query(
      `UPDATE intent_signals AS signal SET strength=change.strength,
         payload=jsonb_set(jsonb_set(signal.payload,'{answer,strength}',to_jsonb(change.strength),true),'{answer,reason}',to_jsonb(change.reason),true)
       FROM (VALUES ${values}) AS change(id,strength,reason)
       WHERE signal.tenant_id=$${parameters.length + 1} AND signal.id=change.id`,
      [...parameters, tenantId],
    );
    await executor.query(
      `UPDATE intent_evidence AS evidence SET confidence=change.strength,
         context=jsonb_set(jsonb_set(evidence.context,'{answer,strength}',to_jsonb(change.strength),true),'{answer,reason}',to_jsonb(change.reason),true)
       FROM (VALUES ${values}) AS change(id,strength,reason)
       WHERE evidence.tenant_id=$${parameters.length + 1} AND evidence.signal_id=change.id`,
      [...parameters, tenantId],
    );
  }
  return updates.length;
}
async function hasClient(tenantId: number, clientId?: number) {
  if (!clientId) return true;
  return (await pool.query("SELECT 1 FROM clients WHERE tenant_id=$1 AND id=$2", [tenantId, clientId])).rowCount! > 0;
}
async function hasTenantRow(tenantId: number, table: "intent_products" | "intent_audiences", id?: number) {
  if (!id) return true;
  return (await pool.query(`SELECT 1 FROM ${table} WHERE tenant_id=$1 AND id=$2`, [tenantId, id])).rowCount! > 0;
}
async function hasAudienceScope(tenantId:number,audienceId:number|undefined,clientId:number|undefined) {
  if(!audienceId) return true;
  return (await pool.query("SELECT 1 FROM intent_audiences WHERE tenant_id=$1 AND id=$2 AND ($3::int IS NULL OR client_id IS NULL OR client_id=$3)",[tenantId,audienceId,clientId??null])).rowCount!>0;
}
/** Every directly selected or resolved company must satisfy both selected scopes. */
export async function hasCompanyScope(tenantId:number, companyId:number|null, clientId:number|undefined, audienceId:number|undefined) {
  if (!companyId) return false;
  return (await pool.query(`SELECT 1 FROM companies c WHERE c.tenant_id=$1 AND c.id=$2
    AND ($3::int IS NULL OR c.client_id=$3)
    AND ($4::int IS NULL OR EXISTS(SELECT 1 FROM intent_audience_companies ac WHERE ac.tenant_id=c.tenant_id AND ac.audience_id=$4 AND ac.company_id=c.id))`,
  [tenantId,companyId,clientId??null,audienceId??null])).rowCount! > 0;
}
/** Contact matches must honor the selected client and, when present, its company. */
async function hasContactScope(tenantId: number, contactId: number | null, clientId: number | undefined, companyId: number | null, audienceId: number | undefined) {
  if (!contactId) return false;
  return (await pool.query(`SELECT 1
    FROM contacts c LEFT JOIN companies co ON co.tenant_id=c.tenant_id AND co.id=c.company_id
    WHERE c.tenant_id=$1 AND c.id=$2
      AND ($3::int IS NULL OR c.client_id=$3 OR co.client_id=$3)
      AND ($4::int IS NULL OR c.company_id IS NULL OR c.company_id=$4)
      AND ($5::int IS NULL OR EXISTS(
        SELECT 1 FROM intent_audience_companies ac
        WHERE ac.tenant_id=c.tenant_id AND ac.audience_id=$5 AND ac.company_id=c.company_id
      ))`,
  [tenantId, contactId, clientId ?? null, companyId ?? null, audienceId ?? null])).rowCount! > 0;
}
async function segmentCompanyScope(tenantId:number,segmentId:number|null) {
  if(!segmentId)return null;
  const segment=await pool.query<{segment_type:string;static_contact_ids:number[]|null;filter_criteria:FilterCriterion[]|null;logic_operator:"AND"|"OR"}>("SELECT segment_type,static_contact_ids,filter_criteria,logic_operator FROM segments WHERE tenant_id=$1 AND id=$2",[tenantId,segmentId]);
  if(!segment.rows[0])return undefined;
  let contactIds=segment.rows[0].segment_type==="static"?(segment.rows[0].static_contact_ids??[]):[];
  if(segment.rows[0].segment_type==="dynamic"){
    const where=await buildContactsWhereClause(tenantId,segment.rows[0].filter_criteria??[],segment.rows[0].logic_operator==="OR"?"OR":"AND");
    contactIds=((await db.execute(sql`SELECT c.id FROM contacts c LEFT JOIN companies co ON co.id=c.company_id WHERE ${where}`)).rows as any[]).map(row=>Number(row.id));
  }
  if(!contactIds.length)return [];
  return (await pool.query<{company_id:number}>("SELECT DISTINCT company_id FROM contacts WHERE tenant_id=$1 AND id=ANY($2::int[]) AND company_id IS NOT NULL",[tenantId,contactIds])).rows.map(row=>row.company_id);
}
async function scopedProductIds(tenantId:number, productId:number|null, categoryIds:number[], subcategoryIds:number[]) {
  if (!productId && !categoryIds.length && !subcategoryIds.length) return null;
  const q=await pool.query<{id:number}>(`SELECT p.id FROM intent_products p
     WHERE p.tenant_id=$1 AND ($2::int IS NULL OR p.id=$2) AND ($3::int[] IS NULL OR p.category_id=ANY($3::int[])) AND ($4::int[] IS NULL OR p.subcategory_id=ANY($4::int[]))`,[tenantId,productId,categoryIds.length?categoryIds:null,subcategoryIds.length?subcategoryIds:null]);
  if(!q.rows.length) {
     const valid=await pool.query(`SELECT
       ($2::int IS NULL OR EXISTS(SELECT 1 FROM intent_products p WHERE p.tenant_id=$1 AND p.id=$2)) AS product_ok,
       ($3::int[] IS NULL OR (SELECT count(*) FROM intent_product_categories WHERE tenant_id=$1 AND id=ANY($3::int[]))=cardinality($3::int[])) AS category_ok,
       ($4::int[] IS NULL OR (SELECT count(*) FROM intent_product_subcategories s WHERE s.tenant_id=$1 AND s.id=ANY($4::int[]) AND ($3::int[] IS NULL OR s.category_id=ANY($3::int[])))=cardinality($4::int[])) AS subcategory_ok`,
     [tenantId,productId,categoryIds.length?categoryIds:null,subcategoryIds.length?subcategoryIds:null]);
    if(!valid.rows[0]?.product_ok||!valid.rows[0]?.category_ok||!valid.rows[0]?.subcategory_ok)return undefined;
  }
  return q.rows.map(x=>x.id);
}
const catalogBody = z.object({ name: z.string().trim().min(1).max(160), categoryId: z.number().int().positive().optional(), subcategoryId: z.number().int().positive().nullable().optional(), active: z.boolean().optional(), description: z.string().trim().max(1000).optional(), clientId: z.number().int().positive().optional(), companyIds: z.array(z.number().int().positive()).max(10000).optional(), segmentIds: z.array(z.number().int().positive()).max(100).default([]), rows: z.array(z.record(z.string(),z.unknown())).max(5000).optional(), mapping: z.record(z.string(), z.union([z.enum(fields), z.literal("ignore")])).default({}) });
const httpUrl = z.string().url().max(2000).refine(value => { const protocol=new URL(value).protocol; return protocol==="http:"||protocol==="https:"; }, "Only http/https source URLs are allowed");
const tierFields = "t.key AS \"tierKey\",t.label AS \"tierLabel\",t.color AS \"tierColor\"";
const productScopedImport = (kind: ImportKind) => kind === "product_buy_intent";
const responseImport = (kind: ImportKind) => kind === "event_feedback" || kind === "event_questionnaire" || kind === "lead_form";
const signalTypeFor = (kind: ImportKind) => ({ account_list: "target_account", baseline: "kaboom_baseline", firmographic: "firmographic", event_feedback: "event_feedback", event_questionnaire: "event_questionnaire", lead_form: "lead_form", product_buy_intent: "event_feedback", consulting: "consulting" }[kind]);
const INTENT_CATEGORY_ALLOWLIST = ["IT Hardware", "Virtual Collaboration", "Software & Services", "Commercial Printing"] as const;
const INTENT_SUBCATEGORY_ALLOWLIST = ["Laptops", "Workstations", "Laser Printers", "Monitors & Displays", "Servers & Storage", "Networking Equipment", "Peripherals & Accessories", "Audio Conferencing", "Video Conferencing", "Teleconferencing", "Headphones", "Active Noise Cancellation", "Fleet Management", "Security Solutions", "Digital Workspaces", "Computing Services", "Document & Printing Services", "Sustainability", "Collaboration Software", "Consulting Services", "Enterprise Printing", "Industrial Printing", "3D Printing", "Large Format Printing"] as const;

async function ensureIntentCatalogDefaults(tenantId:number) {
  const defaults:Record<string,Array<{name:string;products:string[]}>>={
    "IT Hardware":[
      {name:"Laptops",products:["Business Laptops","Professional Laptops","Mobile Workstations"]},
      {name:"Workstations",products:["Desktop Workstations","Engineering Workstations","Graphics Workstations"]},
      {name:"Laser Printers",products:["Monochrome Laser Printers","Color Laser Printers","Multifunction Laser Printers"]},
      {name:"Monitors & Displays",products:["Business Monitors","Large Format Displays","Interactive Displays"]},
      {name:"Servers & Storage",products:["Rack Servers","Network Attached Storage","Backup Storage"]},
      {name:"Networking Equipment",products:["Switches","Routers","Wireless Access Points"]},
      {name:"Peripherals & Accessories",products:["Keyboards & Mice","Docking Stations","Printer Supplies"]},
    ],
    "Virtual Collaboration":[
      {name:"Audio Conferencing",products:["Conference Phones","Speakerphones","Audio Conferencing Systems"]},
      {name:"Video Conferencing",products:["Room Video Systems","Webcams","Video Bars"]},
      {name:"Teleconferencing",products:["Teleconference Platforms","Meeting Bridges","Conference Services"]},
      {name:"Headphones",products:["Business Headsets","Wireless Headsets","Call Center Headsets"]},
      {name:"Active Noise Cancellation",products:["ANC Headsets","ANC Earbuds","Noise-Cancelling Conference Devices"]},
    ],
    "Software & Services":[
      {name:"Fleet Management",products:["HP Workforce Experience Platform","HP Fleet Management"]},
      {name:"Security Solutions",products:["HP Workforce Security Solution","HP Wolf Security"]},
      {name:"Digital Workspaces",products:["HP Digital Workspaces"]},
      {name:"Computing Services",products:["HP Computing Services","HP Managed Device Services"]},
      {name:"Document & Printing Services",products:["HP Document & Printing Services","HP Managed Print Services"]},
      {name:"Sustainability",products:["HP Renew Solutions"]},
      {name:"Collaboration Software",products:["HP Poly Software and Services"]},
      {name:"Consulting Services",products:["HP Workforce Transformation Consulting"]},
    ],
    "Commercial Printing":[
      {name:"Enterprise Printing",products:["HP Enterprise Printers","HP Managed Office Printers"]},
      {name:"Industrial Printing",products:["HP Digital Presses","HP Label and Packaging Presses"]},
      {name:"3D Printing",products:["HP Jet Fusion 3D Printers","HP Metal Jet 3D Printers","HP 3D Professional Services"]},
      {name:"Large Format Printing",products:["HP Latex Printers","HP PageWide XL Printers","HP Technical Plotters","HP Stitch Sublimation Printers"]},
    ],
  };
  const expectedSubcategories=Object.values(defaults).flat().length;
  const expectedProducts=Object.values(defaults).flat().reduce((count,subcategory)=>count+subcategory.products.length,0);
  const existing=await pool.query<{categories:number;subcategories:number;products:number}>(`SELECT
    (SELECT count(*)::int FROM intent_product_categories WHERE tenant_id=$1 AND name=ANY($2::text[])) AS categories,
    (SELECT count(*)::int FROM intent_product_subcategories WHERE tenant_id=$1 AND name=ANY($3::text[])) AS subcategories,
    (SELECT count(*)::int FROM intent_products p JOIN intent_product_categories c ON c.tenant_id=p.tenant_id AND c.id=p.category_id JOIN intent_product_subcategories s ON s.tenant_id=p.tenant_id AND s.id=p.subcategory_id WHERE p.tenant_id=$1 AND c.name=ANY($2::text[]) AND s.name=ANY($3::text[])) AS products`,
    [tenantId,INTENT_CATEGORY_ALLOWLIST,INTENT_SUBCATEGORY_ALLOWLIST]);
  if(existing.rows[0]?.categories===Object.keys(defaults).length&&existing.rows[0]?.subcategories===expectedSubcategories&&existing.rows[0]?.products===expectedProducts)return;
  const categoryNames=Object.keys(defaults);
  const subcategoryRows=Object.entries(defaults).flatMap(([category,subcategories])=>subcategories.map(subcategory=>({category,name:subcategory.name})));
  const productRows=Object.entries(defaults).flatMap(([category,subcategories])=>subcategories.flatMap(subcategory=>subcategory.products.map(product=>({category,subcategory:subcategory.name,name:product}))));
  const c=await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query(`INSERT INTO intent_product_categories(tenant_id,name)
      SELECT $1,name FROM unnest($2::text[]) AS seed(name)
      ON CONFLICT (tenant_id,name) DO NOTHING`,[tenantId,categoryNames]);
    await c.query(`INSERT INTO intent_product_subcategories(tenant_id,category_id,name)
      SELECT $1,c.id,seed.name
      FROM unnest($2::text[],$3::text[]) AS seed(category,name)
      JOIN intent_product_categories c ON c.tenant_id=$1 AND c.name=seed.category
      ON CONFLICT (tenant_id,category_id,name) DO NOTHING`,[tenantId,subcategoryRows.map(row=>row.category),subcategoryRows.map(row=>row.name)]);
    await c.query(`INSERT INTO intent_products(tenant_id,category_id,subcategory_id,name,active)
      SELECT $1,c.id,s.id,seed.name,true
      FROM unnest($2::text[],$3::text[],$4::text[]) AS seed(category,subcategory,name)
      JOIN intent_product_categories c ON c.tenant_id=$1 AND c.name=seed.category
      JOIN intent_product_subcategories s ON s.tenant_id=$1 AND s.category_id=c.id AND s.name=seed.subcategory
      ON CONFLICT (tenant_id,name) DO NOTHING`,[tenantId,productRows.map(row=>row.category),productRows.map(row=>row.subcategory),productRows.map(row=>row.name)]);
    await c.query("COMMIT");
  } catch(error) {
    await c.query("ROLLBACK");
    throw error;
  } finally {
    c.release();
  }
}

async function visibleProductIds(tenantId:number) {
  const q=await pool.query<{id:number}>(`SELECT id FROM intent_products WHERE tenant_id=$1 AND active=true`,[tenantId]);
  return q.rows.map(row=>row.id);
}

type ResearchIntentTopic = {
  label:string;
  score:number;
  tier:"hot"|"warm"|"cold";
  evidenceCount:number;
  pendingCount:number;
  approvedCount:number;
  latestAt:string|null;
  solutions:string[];
  explanation:string;
};
type ResearchIntentResult = {topics:ResearchIntentTopic[];signalCount:number;pendingCount:number;approvedCount:number;latestAt:string|null;opportunityBrief?:ResearchOpportunityBrief;statusEvidence?:IntentStatusEvidence[]};

const INFERRED_INTENT_RULES:Array<{label:string;keywords:RegExp;solutions:string[]}> = [
  {label:"Cloud & Data Center",keywords:/\b(cloud|data cent(?:er|re)|server|storage|infrastructure|private cloud|hybrid cloud)\b/i,solutions:["Cloud migration","Data-center modernization","Infrastructure managed services"]},
  {label:"Cybersecurity",keywords:/\b(cyber|cybersecurity|security|zero trust|ransomware|threat|soc\b|identity access|iam\b)\b/i,solutions:["Cybersecurity services","Zero-trust security","Identity and access management"]},
  {label:"Networking & Connectivity",keywords:/\b(network|networking|wi-?fi|5g|broadband|connectivity|sd-?wan|switch(?:es|ing)?|router)\b/i,solutions:["Enterprise networking","SD-WAN and connectivity","Wireless infrastructure"]},
  {label:"AI & Data Analytics",keywords:/\b(artificial intelligence|\bai\b|machine learning|generative ai|analytics|data science|predictive)\b/i,solutions:["AI enablement","Data and analytics platforms","Automation and insights"]},
  {label:"Software & SaaS",keywords:/\b(software|saas|platform|application|api\b|digital product|subscription)\b/i,solutions:["Business software","SaaS platforms","Application modernization"]},
  {label:"Digital Transformation",keywords:/\b(digital transformation|moderni[sz]ation|automation|digiti[sz]e|technology transformation|erp\b)\b/i,solutions:["Digital transformation","Workflow automation","Technology consulting"]},
  {label:"Customer Experience & Contact Center",keywords:/\b(customer experience|contact center|call center|omnichannel|customer service|crm\b|customer engagement)\b/i,solutions:["Contact-center modernization","Customer experience platforms","Omnichannel engagement"]},
  {label:"Workplace & Collaboration",keywords:/\b(remote work|hybrid work|collaboration|video conference|meeting|workplace|unified communications|teleconference)\b/i,solutions:["Hybrid-work solutions","Video collaboration","Unified communications"]},
  {label:"IT Services & Managed Support",keywords:/\b(managed service|outsourc|consult(?:ing|ancy)|systems integrator|support services|professional services)\b/i,solutions:["Managed IT services","Technology consulting","Service-desk support"]},
  {label:"Devices & End-user Computing",keywords:/\b(laptop|desktop|workstation|endpoint|device fleet|personal computer|pc\b|employee devices?)\b/i,solutions:["Endpoint refresh","Device lifecycle services","End-user computing"]},
  {label:"Printing & Document Workflow",keywords:/\b(printer|printing|print fleet|document workflow|scanning|multifunction)\b/i,solutions:["Managed print services","Document workflow","Secure printing"]},
  {label:"Telecom & Voice",keywords:/\b(telecom|telecommunication|voice services|phone system|ucaa?s|unified communications|call routing)\b/i,solutions:["Telecom modernization","Voice and UC services","Business communications"]},
  {label:"Supply Chain & Logistics",keywords:/\b(supply chain|logistics|warehouse|distribution|fleet|procurement)\b/i,solutions:["Supply-chain technology","Warehouse automation","Procurement solutions"]},
  {label:"Workforce & Talent",keywords:/\b(hir(?:e|es|ed|ing)|workforce|talent|recruit(?:ment|ing)|employees?|headcount|layoffs?)\b/i,solutions:["Workforce expansion support","Employee technology","Talent and HR systems"]},
  {label:"Finance & Cost Optimization",keywords:/\b(financial results?|earnings|revenue|profit|budget|cost reduction|cost optimization|investment)\b/i,solutions:["Cost optimization","Finance transformation","Investment planning"]},
  {label:"Sustainability & Energy",keywords:/\b(sustainab(?:ility|le)|renewable|carbon|energy efficiency|net zero|emissions?)\b/i,solutions:["Sustainability technology","Energy management","Carbon reporting"]},
];

const EVENT_INTENT_FALLBACKS:Record<string,{label:string;solutions:string[]}> = {
  funding:{label:"Growth & Investment Strategy",solutions:["Growth infrastructure","Technology investment planning"]},
  capital_investment:{label:"Growth & Investment Strategy",solutions:["Capital investment planning","Infrastructure expansion"]},
  hiring:{label:"Workforce & Talent",solutions:["Workforce expansion support","Employee technology"]},
  layoffs:{label:"Workforce & Talent",solutions:["Workforce planning","Cost optimization"]},
  technology_integration:{label:"Digital Transformation",solutions:["Technology integration","Application modernization"]},
  partnership:{label:"Strategic Partnerships",solutions:["Partnership enablement","Technology ecosystem services"]},
  merger_acquisition:{label:"M&A & Transformation",solutions:["M&A integration","Enterprise transformation"]},
  branch_opening:{label:"Expansion & Infrastructure",solutions:["Site rollout technology","Network and workplace deployment"]},
  cxo_appointment:{label:"Executive Strategy",solutions:["Technology strategy","Transformation advisory"]},
  quarterly_financial:{label:"Finance & Cost Optimization",solutions:["Finance transformation","Cost optimization"]},
  regulatory_action:{label:"Risk, Compliance & Governance",solutions:["Compliance control platforms","Audit and risk analytics","Regulatory case management"]},
  operational_risk:{label:"Operational Resilience",solutions:["Operational risk analytics","Workflow controls","Resilience and continuity services"]},
};

function researchIntentAnalysis(rows:Array<{id:number;account_id:number;event_type:string|null;excerpt:string|null;source_url?:string|null;occurred_at:Date|string;confidence:number;review_status:string;context?:Record<string,any>;raw_evidence?:unknown}>) {
  const byAccount=new Map<number,Map<string,{score:number;count:number;pending:number;approved:number;latestAt:string|null;solutions:Set<string>;levels:Record<ResearchEvidenceLevel,number>;scoredEvidence:Set<string>;hotEligible:boolean}>>();
  const evidenceIds=new Map<number,Set<number>>();
  for(const row of rows){
    const account=byAccount.get(row.account_id)??new Map();
    const accountEvidence=evidenceIds.get(row.account_id)??new Set<number>();accountEvidence.add(row.id);evidenceIds.set(row.account_id,accountEvidence);
    const validatedFits=validatedResearchFitments({eventType:row.event_type,excerpt:row.excerpt,context:row.context});
    const supportedTopics=[...new Set(validatedFits.map(fit=>fit.category))]
      .map(label=>({label,solutions:[label],keywords:/./}));
    // A row's validated product demand must not be copied to unrelated AI-inferred topics.
    const topics=supportedTopics.length?supportedTopics:[EVENT_INTENT_FALLBACKS[row.event_type??""]].filter(Boolean).map(fallback=>({...fallback,keywords:/./}));
    const classification=classifyResearchEvidence({eventType:row.event_type,excerpt:row.excerpt,context:row.context},validatedFits);
    const evidenceKey=normalizedResearchEvidenceKey({sourceUrl:row.source_url,excerpt:row.excerpt});
    for(const topic of topics){
      const current=account.get(topic.label)??{score:0,count:0,pending:0,approved:0,latestAt:null,solutions:new Set<string>(),levels:{direct_intent:0,confirmed_need:0,business_trigger:0,context:0},scoredEvidence:new Set<string>(),hotEligible:false};
      current.count+=1;
      if(row.review_status==="approved"){
        current.approved+=1;
        if(!current.scoredEvidence.has(evidenceKey)){
          current.scoredEvidence.add(evidenceKey);
          current.score=Math.min(100,current.score+classification.points);
          current.levels[classification.level]+=1;
          current.hotEligible ||= classification.hotEligible;
        }
      }else current.pending+=1;
      const occurredAt=new Date(row.occurred_at).toISOString();
      if(!current.latestAt||occurredAt>current.latestAt)current.latestAt=occurredAt;
      topic.solutions.forEach((solution:string)=>current.solutions.add(solution));
      account.set(topic.label,current);
    }
    byAccount.set(row.account_id,account);
  }
  const result=new Map<number,ResearchIntentResult>();
  for(const [accountId,topics] of byAccount){
    const values=[...topics].map(([label,value])=>{
      const heat=value.approved?researchEvidenceHeat({rawScore:Math.round(value.score),directCount:value.levels.direct_intent,confirmedCount:value.levels.confirmed_need,hotEligible:value.hotEligible}):{score:0,tier:"cold" as const};
      const approvedScore=heat.score;
      const tier:ResearchIntentTopic["tier"]=heat.tier;
      const explanation=!value.approved
        ? `Provisional research lead from ${value.pending} low-confidence evidence item${value.pending===1?"":"s"} awaiting human review; it does not affect intent status.`
        : value.levels.direct_intent||value.levels.confirmed_need
          ? `${tier[0].toUpperCase()+tier.slice(1)} research intent from ${value.levels.direct_intent} direct and ${value.levels.confirmed_need} confirmed-need signal${value.levels.confirmed_need===1?"":"s"} after duplicate suppression.`
          : `Business context only from ${value.approved} approved public signal${value.approved===1?"":"s"}; no category-specific operational need or buying action is validated.`;
      return {label,score:approvedScore,tier,evidenceCount:value.count,pendingCount:value.pending,approvedCount:value.approved,latestAt:value.latestAt,solutions:[...value.solutions].slice(0,3),explanation};
    }).sort((a,b)=>b.score-a.score||a.label.localeCompare(b.label));
    const accountRows=rows.filter(row=>row.account_id===accountId);
    const opportunityBrief=accountRows.map(row=>row.context?.opportunityBrief).find(isCurrentResearchOpportunityBrief);
    result.set(accountId,{topics:values,signalCount:evidenceIds.get(accountId)?.size??0,pendingCount:accountRows.filter(row=>row.review_status!=="approved").length,approvedCount:accountRows.filter(row=>row.review_status==="approved").length,latestAt:values.reduce<string|null>((latest,topic)=>!topic.latestAt?latest:!latest||topic.latestAt>latest?topic.latestAt:latest, null),...(opportunityBrief?{opportunityBrief}:{}),statusEvidence:accountRows.map(row=>({id:row.id,evidenceKind:"public_event",eventType:row.event_type,excerpt:row.excerpt??"",sourceUrl:row.source_url??null,occurredAt:row.occurred_at,confidence:row.confidence,reviewStatus:row.review_status,context:row.context??{},raw_evidence:row.raw_evidence}))});
  }
  return result;
}

async function readAccountResearchEvidence(tenantId:number,accountIds:number[],approvedOnly=false) {
  const q=await pool.query<{id:number;account_id:number;event_type:string|null;excerpt:string|null;source_url:string|null;occurred_at:Date;confidence:number;review_status:string;context:Record<string,any>;raw_evidence?:{excerpt?:string;context?:{searchKind?:string}};company_name:string;company_domain:string|null;reviewed_by:number|null}>(`SELECT e.id,e.account_id,e.event_type,e.excerpt,e.source_url,e.occurred_at,e.confidence,e.review_status,e.context,e.raw_evidence,c.name AS company_name,c.domain AS company_domain,e.reviewed_by
     FROM intent_evidence e JOIN companies c ON c.tenant_id=e.tenant_id AND c.id=e.account_id
     WHERE e.tenant_id=$1 AND e.account_id=ANY($2::int[]) AND e.evidence_kind='public_event'
       AND e.occurred_at>=NOW()-interval '${PUBLIC_RESEARCH_WINDOW_SQL}' AND ${approvedOnly?"e.review_status='approved'":"e.review_status<>'rejected'"}
     ORDER BY e.occurred_at DESC,e.id DESC`,[tenantId,accountIds]);
  const excludedPublicIds=new Set<number>();
  const excludedAccounts=new Set<number>();
  const validRows=q.rows.filter(row=>{
    const unattributed=isUnattributedProcurement({eventType:row.event_type,searchKind:row.context?.searchKind??row.raw_evidence?.context?.searchKind,excerpt:row.excerpt,originalExcerpt:row.raw_evidence?.excerpt,sourceUrl:row.source_url,companyName:row.company_name,companyDomain:row.company_domain,manuallyReviewed:row.reviewed_by!=null});
    const geographyEligible=isResearchGeographyEligible(row);
    if(unattributed||!geographyEligible){
      excludedAccounts.add(row.account_id);
      if(row.review_status==="approved")excludedPublicIds.add(row.id);
    }
    return !unattributed && geographyEligible && isFreshPublicResearchEvidence(row.excerpt,row.occurred_at);
  });
  return {validRows,excludedAccounts,excludedPublicIds};
}
type AccountResearchRead=Promise<Awaited<ReturnType<typeof readAccountResearchEvidence>>>;

async function accountResearchIntent(tenantId:number,accountIds:number[],selectedCategoryIds?:number[],sharedResearch?:AccountResearchRead) {
  if(!accountIds.length)return new Map<number,ResearchIntentResult>();
  const {validRows,excludedAccounts}=await (sharedResearch??readAccountResearchEvidence(tenantId,accountIds));
  const result=researchIntentAnalysis(validRows);
  // A persisted brief may have been generated from excluded evidence; do not reuse it.
  for(const accountId of excludedAccounts) {
    const item=result.get(accountId);
    if(item?.opportunityBrief?.geographyPolicyVersion!==1&&item)delete item.opportunityBrief;
  }
  if(!selectedCategoryIds?.length)return result;
  for(const value of result.values()){
    value.topics=[];
    const brief=value.opportunityBrief;
    if(!brief?.categoryConclusions)continue;
    const categoryConclusions=brief.categoryConclusions.filter(conclusion=>selectedCategoryIds.includes(conclusion.categoryId));
    const bestSelectedConclusion=[...categoryConclusions].sort((a,b)=>b.score-a.score||b.accountFit-a.accountFit||a.categoryName.localeCompare(b.categoryName))[0]??null;
    value.opportunityBrief={...brief,categoryConclusions,bestSelectedConclusion};
  }
  return result;
}

export function applyFirstPartyStatus(status:ReturnType<typeof evaluateTwoLevelIntentStatus>,productAnalysis:any) {
  const categories=status.categories.map(category=>({...category,drivingSignals:[...category.drivingSignals]}));
  for(const source of productAnalysis?.topCategories??[]){
    if(!source.explicitSource||!["hot","warm"].includes(source.tier))continue;
    const category=categories.find(item=>item.name.toLowerCase()===String(source.category).toLowerCase());
    if(!category)continue;
    category.status=source.tier;
    category.attribution="CONFIRMED";
    category.statusReason=source.tier==="hot"
      ? `Hot because first-party evidence explicitly identifies ${category.name} interest with purchase-stage timing or action.`
      : `Warm because first-party evidence identifies ${category.name} interest, but the timing or commitment is not strong enough for Hot.`;
    category.nextPlay=source.tier==="hot"?`Route to the ${category.name} specialist and reference the explicit first-party need.`:`Nurture the explicit ${category.name} interest and confirm timing.`;
    category.drivingSignals.unshift({evidenceId:source.firstPartySource?.kind==="intent_evidence"?source.firstPartySource.id:0,
      signalType:source.firstPartySource?.formType?inboundSignalType(source.firstPartySource.formType):source.explicitSource,
      quote:source.explanation,sourceUrl:null,occurredAt:source.firstPartyOccurredAt??new Date().toISOString(),strength:source.tier==="hot"?"strong":"moderate",
      ...source.firstPartySource?{firstPartySource:source.firstPartySource}:{}});
  }
  const inboundStatus=productAnalysis?.inboundIntent?.classification;
  const accountStatus=inboundStatus==="hot"||categories.some(category=>category.status==="hot")||status.accountStatus==="hot"?"hot"
    :inboundStatus==="warm"||categories.some(category=>category.status==="warm")||status.accountStatus==="warm"?"warm":"cold";
  const confirmedHot=categories.find(category=>category.status==="hot"&&category.attribution==="CONFIRMED");
  const inboundSignal=productAnalysis?.inboundIntent
    ? {evidenceId:0,signalType:inboundSignalType(productAnalysis.inboundIntent.firstPartySource?.formType),
        quote:productAnalysis.inboundIntent.reason,sourceUrl:null,occurredAt:productAnalysis.inboundIntent.occurredAt,
        strength:inboundStatus==="hot"?"strong":"moderate",firstPartySource:productAnalysis.inboundIntent.firstPartySource}
    : null;
  const accountDrivingSignals=inboundSignal?[inboundSignal,...status.accountDrivingSignals].slice(0,5):confirmedHot?[...confirmedHot.drivingSignals,...status.accountDrivingSignals].slice(0,5):status.accountDrivingSignals;
  const accountExplanation=inboundSignal
    ? `${inboundStatus==="hot"?"Hot":"Warm"} overall from current first-party inbound qualification: ${productAnalysis.inboundIntent.reason}`
    : confirmedHot
    ? `Hot overall because explicit first-party evidence indicates near-term investment in ${confirmedHot.name}.`
    : status.accountExplanation;
  return {...status,categories,accountStatus,accountDrivingSignals,accountExplanation};
}

async function productFitAnalysis(tenantId:number,accountIds:number[],priorityProductIds?:number[]|null,includeHistoricalQuestionnaire=true,categoryConfig?:InboundCategoryConfig,sharedResearch?:AccountResearchRead) {
  if(!accountIds.length)return new Map<number,any>();
  const effectiveCategoryConfig=categoryConfig??await loadInboundCategoryRules(tenantId);
  const [products,signals,tiers,inbound,publicEvidence]=await Promise.all([
    pool.query<{id:number;name:string;category_name:string;subcategory_name:string|null}>(`SELECT p.id,p.name,c.name AS category_name,s.name AS subcategory_name
      FROM intent_products p JOIN intent_product_categories c ON c.tenant_id=p.tenant_id AND c.id=p.category_id
      LEFT JOIN intent_product_subcategories s ON s.tenant_id=p.tenant_id AND s.id=p.subcategory_id
      WHERE p.tenant_id=$1 AND p.active=true ORDER BY p.name`,[tenantId]),
    pool.query<{id:number;account_id:number;product_id:number|null;key:string;max_points:number;half_life_days:number;strength:number;occurred_at:Date;source:string;summary:string|null;payload:unknown;explicit_source:"questionnaire"|"lead_form"|null;first_party_source?:FirstPartySourceRef}>(`SELECT s.id,s.account_id,s.product_id,st.key,COALESCE(qs.max_points,st.max_points) AS max_points,st.half_life_days,s.strength,s.occurred_at,s.source,s.summary,s.payload,
        (SELECT jsonb_build_object('kind','intent_evidence','id',proof.id,'formType',proof.evidence_kind) FROM intent_evidence proof WHERE proof.tenant_id=s.tenant_id AND proof.signal_id=s.id
          AND proof.account_id=s.account_id AND proof.review_status='approved'
          AND proof.evidence_kind IN ('lead_form','event_questionnaire','event_feedback','product_buy_intent')
          ORDER BY CASE WHEN proof.evidence_kind='lead_form' THEN 0 ELSE 1 END,proof.id DESC LIMIT 1) AS first_party_source,
        CASE
          WHEN EXISTS(SELECT 1 FROM intent_evidence explicit_ie WHERE explicit_ie.tenant_id=s.tenant_id AND explicit_ie.account_id=s.account_id AND explicit_ie.signal_id=s.id AND explicit_ie.review_status='approved' AND explicit_ie.evidence_kind='lead_form') THEN 'lead_form'
          WHEN EXISTS(SELECT 1 FROM intent_evidence explicit_ie WHERE explicit_ie.tenant_id=s.tenant_id AND explicit_ie.account_id=s.account_id AND explicit_ie.signal_id=s.id AND explicit_ie.review_status='approved' AND explicit_ie.evidence_kind IN ('event_questionnaire','event_feedback')) THEN 'questionnaire'
          ELSE NULL
        END AS explicit_source
      FROM intent_signals s JOIN intent_signal_types st ON st.id=s.signal_type_id AND st.tenant_id=s.tenant_id
      LEFT JOIN intent_questionnaire_settings qs ON qs.tenant_id=s.tenant_id AND st.key='questionnaire_' || qs.dimension
      WHERE s.tenant_id=$1 AND s.account_id=ANY($2::int[]) AND (s.product_id IS NOT NULL OR st.category='questionnaire') AND st.active
      AND ${includeHistoricalQuestionnaire ? `(st.category='questionnaire' OR s.occurred_at>=NOW()-interval '${PUBLIC_RESEARCH_WINDOW_SQL}')` : `s.occurred_at>=NOW()-interval '${PUBLIC_RESEARCH_WINDOW_SQL}'`}
      AND (s.expires_at IS NULL OR s.expires_at>NOW())
      AND (NOT EXISTS(SELECT 1 FROM intent_evidence ie WHERE ie.tenant_id=s.tenant_id AND ie.signal_id=s.id)
        OR EXISTS(SELECT 1 FROM intent_evidence ie WHERE ie.tenant_id=s.tenant_id AND ie.signal_id=s.id AND ie.review_status='approved'))`,[tenantId,accountIds]),
    pool.query<{key:string;label:string;min_score:number}>("SELECT key,label,min_score FROM intent_tiers WHERE tenant_id=$1 AND active ORDER BY min_score",[tenantId]),
    pool.query<{id:number;account_id:number;form_type:string;classification:"hot"|"warm";classification_reason:string;product_interest:string;affinity_reviews:Record<string,unknown>|null;submitted_at:Date|null;created_at:Date}>(`SELECT id,account_id,form_type,classification,classification_reason,product_interest,affinity_reviews,submitted_at,created_at
      FROM intent_inbound_submissions s
      WHERE tenant_id=$1 AND account_id=ANY($2::int[]) AND classification IN ('hot','warm')
        AND ${canonicalInboundSubmissionSql("s")}
        AND NULLIF(btrim(product_interest),'') IS NOT NULL
        AND regexp_replace(lower(btrim(product_interest)),'[^a-z]','','g') NOT IN ('na','none','no','nil','notinterested')
      ORDER BY CASE WHEN classification='hot' THEN 0 ELSE 1 END,COALESCE(submitted_at,created_at) DESC,id DESC`,[tenantId,accountIds]),
    sharedResearch??readAccountResearchEvidence(tenantId,accountIds,true),
  ]);
    const {excludedPublicIds}=publicEvidence;
    const productById=new Map(products.rows.map(product=>[product.id,product]));
    const categoryForProduct=(product:{name:string;subcategory_name:string|null})=>{
      const mapped=inboundCategoryForInterest([product.name,product.subcategory_name].filter(Boolean).join(" "),null,effectiveCategoryConfig);
      return inboundCategories.includes(mapped.categoryName)?mapped.categoryName:"Needs categorization";
    };
    const signalsByAccountProduct=new Map<string,typeof signals.rows>();
    const questionnaireByAccount=new Map<number,typeof signals.rows>();
    const grouped=new Map<string,Map<string,number[]>>();
    const derivedPublicFitBySignalId=new Map<number,ReturnType<typeof analyzeProductFitment>>();
    const preparedSources=new Map<string,ReturnType<typeof prepareProductFitmentSource>>();
    const publicFit=(signal:typeof signals.rows[number],product:typeof products.rows[number])=>{
      const text=signal.summary??"";
      let prepared=preparedSources.get(text);
      if(!prepared){prepared=prepareProductFitmentSource(text);preparedSources.set(text,prepared);}
      return analyzeProductFitment({eventType:signal.key,text,confidence:signal.strength},
        {id:product.id,name:product.name,category:product.category_name,subcategory:product.subcategory_name},prepared);
    };
    const eligibleSignalIds=new Set<number>();
  const scoringWindowStart=new Date();scoringWindowStart.setMonth(scoringWindowStart.getMonth()-3);
  const scoringSignals=signals.rows.filter(signal=>new Date(signal.occurred_at)>=scoringWindowStart||Boolean(signal.explicit_source));
  for(const s of scoringSignals){
    if(s.source==="public_event" && excludedPublicIds.has(Number((s.payload as {evidenceId?:number}|null)?.evidenceId)))continue;
    if(s.key?.startsWith("questionnaire_")){
      const accountSignals=questionnaireByAccount.get(s.account_id)??[];
      accountSignals.push(s);
      questionnaireByAccount.set(s.account_id,accountSignals);
    }
    if(s.product_id==null)continue;
    const product=productById.get(s.product_id);
    if(!product)continue;
    if(s.source==="public_event"){if(!isFreshPublicResearchEvidence(s.summary,s.occurred_at))continue;const fit=publicFit(s,product);if(!fit||!["direct_intent","confirmed_need"].includes(fit.level))continue;derivedPublicFitBySignalId.set(s.id,fit);}
    eligibleSignalIds.add(s.id);
    const key=`${s.account_id}:${s.product_id}`;
    const productSignals=signalsByAccountProduct.get(key)??[];
    productSignals.push(s);
    signalsByAccountProduct.set(key,productSignals);
    const types=grouped.get(key)??new Map(),values=types.get(s.key)??[];
    const derivedPublicFit=derivedPublicFitBySignalId.get(s.id);
    const scoringPayload=derivedPublicFit?{...(s.payload&&typeof s.payload==="object"?s.payload as Record<string,unknown>:{}),fitmentLevel:derivedPublicFit.level,fitmentPoints:derivedPublicFit.points}:s.payload;
    values.push(productSignalPoints(s.max_points,s.strength,scoringPayload)*signalDecay(s.key,(Date.now()-new Date(s.occurred_at).getTime())/86_400_000,s.half_life_days));
    types.set(s.key,values);grouped.set(key,types);
  }
  for(const productSignals of signalsByAccountProduct.values())productSignals.sort((a,b)=>new Date(b.occurred_at).getTime()-new Date(a.occurred_at).getTime());
  const output=new Map<number,any>();
  const inboundSources=new Map<number,FirstPartySourceRef>();
  for(const accountId of accountIds){
    const prioritySet=priorityProductIds?new Set(priorityProductIds):null;
    const productScores:any[]=products.rows.map(product=>{const scopeKey=`${accountId}:${product.id}`,types=grouped.get(scopeKey)??new Map();let score=[...types.values()].reduce((sum,values)=>sum+saturateRepeatedSignals(values),0);if(types.size>1)score+=Math.min(10,(types.size-1)*2);score=Math.min(100,Math.round(score));const productSignals=signalsByAccountProduct.get(scopeKey)??[];const explicitSource=productSignals.find(signal=>signal.explicit_source)?.explicit_source??null;const latestTimeframe=productSignals.find(signal=>signal.key==="questionnaire_timeframe");const latestExplicitInterest=productSignals.find(signal=>signal.key==="questionnaire_product_interest"&&Boolean(signal.explicit_source));const productInterestAgeDays=latestExplicitInterest?(Date.now()-new Date(latestExplicitInterest.occurred_at).getTime())/86_400_000:Infinity;const declaredTier=declaredQuestionnaireIntentTier(Boolean(latestExplicitInterest),latestTimeframe?.strength,productInterestAgeDays);const hasRecentPurchaseSignal=productSignals.some(signal=>isPurchaseStageSignal(signal));const implicitSignalCount=productSignals.filter(signal=>!signal.explicit_source&&new Date(signal.occurred_at)>=scoringWindowStart).length;const warmMin=tiers.rows.find(tier=>tier.key==="warm")?.min_score??40;const gated=declaredTier?{score:declaredTier==="hot"?score:Math.max(score,warmMin),tier:declaredTier}:qualifyImplicitProductIntent(score,tiers.rows,hasRecentPurchaseSignal,implicitSignalCount);score=gated.score;const tier=gated.tier;const supportingEvidence=productSignals.slice(0,5).map(signal=>({signalType:signal.key,summary:signal.summary||signal.key.replace(/_/g," "),source:signal.source,occurredAt:signal.occurred_at}));const explanation=score>0?`${tier[0].toUpperCase()+tier.slice(1)} category propensity from ${productSignals.length} approved signal${productSignals.length===1?"":"s"}. ${hasRecentPurchaseSignal?"Recent purchase-stage evidence is present.":declaredTier==="warm"?"Explicit product interest is within the 60-day nurture window.":latestExplicitInterest?"The explicit product-interest nurture window has expired; new corroborating signals are required for Warm.":"No recent purchase-stage evidence; multiple strong signals are required for Warm."} ${supportingEvidence.slice(0,2).map(item=>item.summary).join(" · ")}`:"Cold because no current evidence qualifies this product for nurture.";return {productId:product.id,productName:product.name,category:product.category_name,subcategory:product.subcategory_name,score,tier,declaredTier,explicitSource,scoreMeaning:"Category propensity",hasRecentPurchaseSignal,inSelectedScope:prioritySet?prioritySet.has(product.id):true,explanation,supportingEvidence,signalHeads:[...types.keys()],signalCount:[...types.values()].reduce((sum,values)=>sum+values.length,0)};}).sort((a,b)=>Number(Boolean(b.explicitSource))-Number(Boolean(a.explicitSource))||Number(b.inSelectedScope)-Number(a.inSelectedScope)||b.score-a.score);
    const inboundRows=inbound.rows.filter(row=>row.account_id===accountId);
    for(const fit of productScores) {
      const proof=signalsByAccountProduct.get(`${accountId}:${fit.productId}`)?.find(signal=>signal.explicit_source&&signal.first_party_source);
      if(proof){fit.firstPartySource=proof.first_party_source;fit.firstPartyOccurredAt=proof.occurred_at;}
    }
    const inboundCatalog=products.rows.map(product=>({id:product.id,name:product.name,category:categoryForProduct(product),subcategory:product.subcategory_name}));
    const scopedInboundRows=prioritySet
      ? inboundRows.filter(row=>inferProductsFromInterest(row.product_interest,inboundCatalog,{includeCategoryMatches:false}).some(product=>prioritySet.has(product.id)))
      : inboundRows;
    for(const row of scopedInboundRows){
      const matches=inferProductsFromInterest(row.product_interest,inboundCatalog);
      for(const match of matches){
        const fit=productScores.find(item=>item.productId===match.id);
        if(!fit||prioritySet&&!prioritySet.has(match.id))continue;
        const score=row.classification==="hot"?100:50;
        if(intentTierRank(row.classification)>=intentTierRank(fit.tier)){
          fit.score=Math.max(fit.score,score);fit.tier=row.classification;fit.declaredTier=row.classification;fit.explicitSource=row.form_type==="lead_form"?"lead_form":"questionnaire";
          fit.firstPartySource=inboundSourceRef(row);fit.firstPartyOccurredAt=row.submitted_at??row.created_at;
          fit.hasRecentPurchaseSignal=row.classification==="hot";fit.explanation=row.classification_reason;
          fit.supportingEvidence=[{signalType:"inbound_product_interest",summary:row.product_interest,source:inboundSignalType(row.form_type),occurredAt:row.submitted_at??row.created_at},...fit.supportingEvidence].slice(0,5);
          fit.signalHeads=[...new Set(["inbound_product_interest",...fit.signalHeads])];fit.signalCount+=1;
        }
      }
    }
    productScores.sort((a,b)=>Number(Boolean(b.explicitSource))-Number(Boolean(a.explicitSource))||Number(b.inSelectedScope)-Number(a.inSelectedScope)||b.score-a.score);
    for(const fit of productScores)if(fit.explicitSource&&fit.score===0)fit.score=1;
    for(const fit of productScores){
      const source=products.rows.find(product=>product.id===fit.productId);
      const manualRow=scopedInboundRows.find(row=>inferProductsFromInterest(row.product_interest,inboundCatalog,{includeCategoryMatches:false}).some(match=>match.id===fit.productId));
      const overrides=manualRow?.affinity_reviews?.__categoryOverrides;
      const explicitOverride=overrides&&typeof overrides==="object"&&!Array.isArray(overrides)
        ?(overrides as Record<string,unknown>)[manualRow?.product_interest??""]:null;
      fit.catalogCategory=source?.category_name??fit.category;
      fit.category=typeof explicitOverride==="string"&&inboundCategories.includes(explicitOverride)
        ?explicitOverride:source?categoryForProduct(source):"Needs categorization";
    }
    const fits=productScores.filter(fit=>fit.score>0);
    const coldTier=selectIntentTier(0,tiers.rows).key;
    const catalogCategories=inboundCategories;
    const categoryMap=new Map<string,{category:string;score:number;tier:string;inSelectedScope:boolean;signalHeads:string[];signalCount:number;strongestProduct:string|null;explanation:string;hasRecentPurchaseSignal:boolean;questionnaireDriven?:boolean;explicitSource?:"questionnaire"|"lead_form"|null}>(catalogCategories.map(category=>{const inSelectedScope=!prioritySet||products.rows.some(product=>categoryForProduct(product)===category&&prioritySet.has(product.id));return [category,{category,score:0,tier:coldTier,inSelectedScope,signalHeads:[],signalCount:0,strongestProduct:null,explanation:"No approved signal currently supports this category.",hasRecentPurchaseSignal:false}]}));
    for(const category of catalogCategories){const categoryProducts=productScores.filter(fit=>fit.category===category),strongest=categoryProducts[0],heads=[...new Set(categoryProducts.flatMap(fit=>fit.signalHeads))],signalCount=categoryProducts.reduce((sum,fit)=>sum+fit.signalCount,0);if(strongest&&strongest.score>0)categoryMap.set(category,{category,score:strongest.score,tier:strongest.tier,inSelectedScope:categoryProducts.some(fit=>fit.inSelectedScope),signalHeads:heads,signalCount,strongestProduct:strongest.productName,explicitSource:strongest.explicitSource,questionnaireDriven:strongest.explicitSource==="questionnaire",hasRecentPurchaseSignal:strongest.hasRecentPurchaseSignal,explanation:`${strongest.explicitSource?"Explicit first-party response. ":""}${strongest.tier[0].toUpperCase()+strongest.tier.slice(1)} possible fit because ${strongest.supportingEvidence.slice(0,2).map((item:any)=>item.summary).join(" · ")} ${strongest.declaredTier?`The respondent’s purchase timeframe sets this fit to ${strongest.declaredTier}. `:""}Suggested product: ${strongest.productName} (${strongest.score}).`});}
    const questionnaireSignals=(questionnaireByAccount.get(accountId)??[]).sort((a,b)=>new Date(b.occurred_at).getTime()-new Date(a.occurred_at).getTime());
    const answers=questionnaireSignals.map(signal=>{const payload=signal.payload&&typeof signal.payload==="object"?signal.payload as any:{};return {field:payload.answer?.field??signal.key.replace("questionnaire_",""),value:payload.answer?.value??signal.summary,strength:signal.strength,reason:payload.answer?.reason??"",productId:signal.product_id,occurredAt:signal.occurred_at,audit:questionnaireSignalAudit({key:signal.key,maxPoints:signal.max_points,strength:signal.strength,occurredAt:signal.occurred_at,halfLifeDays:signal.half_life_days,payload:signal.payload})};});
    const latestTimeframeAnswer=answers.find(answer=>answer.field==="purchase_timeframe");
    const latestProductInterestAnswer=answers.find(answer=>answer.field==="product_interest");
    const productInterestAgeDays=latestProductInterestAnswer?(Date.now()-new Date(latestProductInterestAnswer.occurredAt).getTime())/86_400_000:Infinity;
    const hasActiveExplicitProductInterest=Boolean(latestProductInterestAnswer)&&productInterestAgeDays<60;
    const questionnaireDeclaredTier=declaredQuestionnaireIntentTier(Boolean(latestProductInterestAnswer),latestTimeframeAnswer?.strength,productInterestAgeDays);
    const unassignedInterest=answers.find(answer=>answer.field==="product_interest"&&answer.productId==null);
    const inferredCategoryScopes=unassignedInterest?splitSelections(unassignedInterest.value)
      .map(value=>inboundCategoryForInterest(value,null,effectiveCategoryConfig))
      .filter(match=>inboundCategories.includes(match.categoryName))
      .map(match=>({category:match.categoryName}))
      .filter((scope,index,all)=>all.findIndex(item=>item.category===scope.category)===index):[];
    for(const scope of inferredCategoryScopes){const relevant=questionnaireSignals.filter(signal=>signal.product_id==null&&signal.key!=="questionnaire_knowledge_intent"),types=new Map<string,number[]>();for(const signal of relevant){const values=types.get(signal.key)??[];values.push(signal.max_points*signal.strength/100*signalDecay(signal.key,(Date.now()-new Date(signal.occurred_at).getTime())/86_400_000,signal.half_life_days));types.set(signal.key,values);}let score=[...types.values()].reduce((sum,values)=>sum+saturateRepeatedSignals(values),0);if(types.size>1)score+=Math.min(10,(types.size-1)*2);score=Math.min(100,Math.round(score));const existing=categoryMap.get(scope.category);const explicitSource=relevant.find(signal=>signal.explicit_source)?.explicit_source??"questionnaire";const hasRecentPurchaseSignal=relevant.some(signal=>isPurchaseStageSignal(signal));const warmMin=tiers.rows.find(tier=>tier.key==="warm")?.min_score??40;const gated=questionnaireDeclaredTier==="hot"&&hasRecentPurchaseSignal?{score:Math.max(score,tiers.rows.find(tier=>tier.key==="hot")?.min_score??70),tier:"hot"}:hasActiveExplicitProductInterest?{score:Math.max(score,warmMin),tier:"warm"}:{score:0,tier:"cold"};score=gated.score;const questionnaireTier=gated.tier;const questionnaireCandidate={categoryName:scope.category,score,tier:questionnaireTier,source:explicitSource};const existingCandidate=existing?{categoryName:existing.category,score:existing.score,tier:existing.tier,source:existing.explicitSource??(existing.questionnaireDriven?"questionnaire":"approved_signals")}:null;if(!existingCandidate||isStrongerIntentCandidate(questionnaireCandidate,existingCandidate))categoryMap.set(scope.category,{category:scope.category,score,tier:questionnaireTier,inSelectedScope:existing?.inSelectedScope??true,signalHeads:[...types.keys()],signalCount:relevant.length,strongestProduct:null,questionnaireDriven:explicitSource==="questionnaire",explicitSource,hasRecentPurchaseSignal,explanation:`Explicit ${explicitSource==="lead_form"?"lead-form":"questionnaire"} answers identify ${scope.category} interest from “${String(unassignedInterest?.value??"").slice(0,160)}”. ${hasActiveExplicitProductInterest?"The product interest is within the 60-day Warm nurture window.":"The 60-day nurture window has expired; new positive evidence is required to restore Warm status."} No individual product was selected because the answer does not uniquely identify a catalog SKU.`});}
    for(const row of scopedInboundRows){
      const mapped=inboundCategoryForInterest(row.product_interest,row.affinity_reviews,effectiveCategoryConfig);
      if(!inboundCategories.includes(mapped.categoryName))continue;
      const existing=categoryMap.get(mapped.categoryName);
      const score=row.classification==="hot"?100:50;
      if(!existing||intentTierRank(row.classification)>=intentTierRank(existing.tier)){
        const matchedProduct=inferProductsFromInterest(row.product_interest,inboundCatalog,{includeCategoryMatches:false})[0];
        categoryMap.set(mapped.categoryName,{category:mapped.categoryName,score,tier:row.classification,inSelectedScope:existing?.inSelectedScope??true,signalHeads:["inbound_product_interest"],signalCount:1,strongestProduct:matchedProduct?.name??null,explicitSource:"lead_form",questionnaireDriven:false,hasRecentPurchaseSignal:row.classification==="hot",explanation:row.classification_reason});
      }
    }
    const categories=[...categoryMap.values()];
    for(const category of categories)if(category.explicitSource&&category.score===0)category.score=1;
    categories.sort((a,b)=>Number(Boolean(b.explicitSource))-Number(Boolean(a.explicitSource))||Number(b.inSelectedScope)-Number(a.inSelectedScope)||b.score-a.score||a.category.localeCompare(b.category));
    const signalCount=[...products.rows].reduce((count,product)=>count+[...(grouped.get(`${accountId}:${product.id}`)?.values()??[])].reduce((n,values)=>n+values.length,0),0);
    const selectedFits=prioritySet?fits.filter(fit=>fit.inSelectedScope):fits;
    for(const category of categoryMap.values()) {
      const fit=productScores.find(product=>product.productName===category.strongestProduct);
      if(fit?.firstPartySource)Object.assign(category,{firstPartySource:fit.firstPartySource,firstPartyOccurredAt:fit.firstPartyOccurredAt});
    }
    const strongestInbound=scopedInboundRows[0];
    if(strongestInbound)inboundSources.set(accountId,inboundSourceRef(strongestInbound));
    output.set(accountId,{bestProduct:selectedFits[0]??null,hotProducts:fits.filter(f=>f.tier==="hot"),topProducts:fits.slice(0,8),hotCategories:categories.filter(c=>c.tier==="hot").slice(0,8),topCategories:categories,inboundIntent:strongestInbound?{classification:strongestInbound.classification,reason:strongestInbound.classification_reason,occurredAt:strongestInbound.submitted_at??strongestInbound.created_at,affinities:[...new Set(scopedInboundRows.map(row=>row.product_interest))]}:null,questionnaireAnalysis:{answerCount:answers.length,assignedCount:answers.filter(answer=>answer.productId!=null).length,unassignedCount:answers.filter(answer=>answer.productId==null).length,declaredTier:questionnaireDeclaredTier,latestAt:answers[0]?.occurredAt??null,inferredCategories:inferredCategoryScopes.map(scope=>scope.category),answers,interpretation:answers.length?(inferredCategoryScopes.length?`Questionnaire answers support ${inferredCategoryScopes.map(scope=>scope.category).join(", ")} at category level. ${questionnaireDeclaredTier?`The declared timeframe sets the questionnaire temperature to ${questionnaireDeclaredTier}.`:""}`:"Questionnaire answers are incorporated as account context, but no unique catalog product or category can be defended yet."):"No questionnaire answers are available in the current three-month window."},signalTracking:signalCount>0||scopedInboundRows.length?"complete":"no_signals",signalCount:signalCount+scopedInboundRows.length});
  }
  for(const [accountId,analysis] of output) {
    if(analysis.inboundIntent) {
      analysis.inboundIntent.firstPartySource=inboundSources.get(accountId);
    }
    for(const category of analysis.topCategories) {
      if(category.firstPartySource)continue;
      const fit=analysis.topProducts.find((product:any)=>product.productName===category.strongestProduct);
      const proof=fit?.firstPartySource ? fit : (questionnaireByAccount.get(accountId)??[])
        .filter(signal=>signal.explicit_source&&signal.first_party_source)
        .sort((a,b)=>new Date(b.occurred_at).getTime()-new Date(a.occurred_at).getTime())
        .find(signal=>inboundCategoryForInterest(signal.summary??"",null,effectiveCategoryConfig).categoryName===category.category);
      if(proof) {
        category.firstPartySource=proof.firstPartySource??proof.first_party_source;
        category.firstPartyOccurredAt=proof.firstPartyOccurredAt??proof.occurred_at;
      }
    }
  }
  return output;
}

async function inboundCategoryProductIds(tenantId:number,categoryName:string,categoryConfig:InboundCategoryConfig) {
  const products=await pool.query<{id:number;name:string;subcategory_name:string|null}>(`SELECT p.id,p.name,s.name AS subcategory_name
    FROM intent_products p LEFT JOIN intent_product_subcategories s
      ON s.tenant_id=p.tenant_id AND s.id=p.subcategory_id
    WHERE p.tenant_id=$1 AND p.active=true`,[tenantId]);
  return products.rows.filter(product=>
    inboundCategoryForInterest([product.name,product.subcategory_name].filter(Boolean).join(" "),null,categoryConfig).categoryName===categoryName
  ).map(product=>product.id);
}

const accountHasIntentEvidenceSql = `(
  EXISTS(SELECT 1 FROM intent_signals s WHERE s.tenant_id=c.tenant_id AND s.account_id=c.id)
  OR EXISTS(SELECT 1 FROM intent_evidence e WHERE e.tenant_id=c.tenant_id AND e.account_id=c.id AND e.review_status<>'rejected')
  OR EXISTS(SELECT 1 FROM intent_inbound_submissions ib WHERE ib.tenant_id=c.tenant_id AND ib.account_id=c.id)
)`;
// Share only work currently executing. Never serve an expired snapshot or let
// a second panel duplicate the same large evidence read on first load.
const pendingCanonicalReads=new Map<string,Promise<any[]>>();

export async function canonicalScopedAccountIntents(
  tenantId:number,
  accountIds:number[],
  scopedProducts:number[],
  explicitlySelectedProducts:number[]|null,
  categoryIds:number[],
  categoryConfig?:InboundCategoryConfig,
  selectedCategoryName?:string,
) {
  if(!accountIds.length)return new Map<number,any>();
  const analyzable=await pool.query<{id:number}>(`SELECT c.id FROM companies c
    WHERE c.tenant_id=$1 AND c.id=ANY($2::int[]) AND ${accountHasIntentEvidenceSql}`, [tenantId,accountIds]);
  const analyzableIds=analyzable.rows.map(row=>row.id);
  const effectiveCategoryConfig=categoryConfig??await loadInboundCategoryRules(tenantId);
  const readKey=createHash("sha256").update(JSON.stringify([tenantId,[...analyzableIds].sort((a,b)=>a-b),
    scopedProducts,explicitlySelectedProducts,categoryIds,effectiveCategoryConfig])).digest("hex");
  let pending=pendingCanonicalReads.get(readKey);
  if(!pending){
    // One batch-owned read/validation of source evidence feeds both analyses.
    // No results survive completion, and no accounts beyond this batch load.
    const sharedResearch=analyzableIds.length?readAccountResearchEvidence(tenantId,analyzableIds):undefined;
    pending=Promise.all([
      scopedProducts.length&&analyzableIds.length?readProductIntentActivity(tenantId,scopedProducts,analyzableIds):Promise.resolve(new Map()),
      productFitAnalysis(tenantId,analyzableIds,explicitlySelectedProducts?scopedProducts:null,true,effectiveCategoryConfig,sharedResearch),
      accountResearchIntent(tenantId,analyzableIds,categoryIds,sharedResearch),
    ]);
    pendingCanonicalReads.set(readKey,pending);
  }
  let activity:Map<number,Date|null>,fits:Map<number,any>,research:Map<number,ResearchIntentResult>;
  try{[activity,fits,research]=await pending;}
  finally{if(pendingCanonicalReads.get(readKey)===pending)pendingCanonicalReads.delete(readKey);}
  const output=new Map<number,any>();
  const analyzableSet=new Set(analyzableIds);
  const emptyStatus=evaluateTwoLevelIntentStatus([],new Date(),effectiveCategoryConfig);
  for(const accountId of accountIds){
    if(!analyzableSet.has(accountId)){
      output.set(accountId,{score:0,tier:"cold",lastSignalAt:null,contributions:[],intentStatus:emptyStatus});
      continue;
    }
    const scoped={score:0,tier:"cold",lastSignalAt:activity.get(accountId)??null,contributions:[]};
    const productAnalysis=fits.get(accountId);
    const savedResearch=research.get(accountId);
    const researchIntent=savedResearch?{...savedResearch}:undefined;
    const categoryIntent=canonicalCategoryIntent(productAnalysis,researchIntent,explicitlySelectedProducts!==null,70,effectiveCategoryConfig);
    const intentStatus=applyFirstPartyStatus(evaluateTwoLevelIntentStatus(researchIntent?.statusEvidence??[],new Date(),effectiveCategoryConfig),productAnalysis);
    const selectedIntent=selectedCategoryName?selectedCategoryIntent(selectedCategoryName,productAnalysis,intentStatus):null;
    if(researchIntent)delete researchIntent.statusEvidence;
    output.set(accountId,{
      score:selectedIntent?.score??(intentStatus?.accountStatus==="hot"?100:intentStatus?.accountStatus==="warm"?50:0),
      tier:selectedIntent?.tier??intentStatus?.accountStatus??categoryIntent?.tier??scoped.tier,
      lastSignalAt:scoped.lastSignalAt,
      contributions:scoped.contributions,
      canonicalCategoryIntent:categoryIntent,
      productAnalysis,
      researchIntent,
      intentStatus,
    });
  }
  return output;
}

function normalizeImportRow(
  raw: Record<string, unknown>,
  mapping: Record<string, string>,
  questionnaireSettings: QuestionnaireDimension[] = QUESTIONNAIRE_DIMENSION_DEFAULTS,
) {
  const byCanonical: Record<string, unknown> = {};
  for (const [header, canonical] of Object.entries(mapping)) {
    if (canonical === "ignore") continue;
    if (byCanonical[canonical] === undefined) byCanonical[canonical] = raw[header];
    else byCanonical[canonical] = [...(Array.isArray(byCanonical[canonical]) ? byCanonical[canonical] : [byCanonical[canonical]]), raw[header]];
  }
  for (const key of fields) if (byCanonical[key] === undefined) byCanonical[key] = raw[key];
  const text = (key: string) => {
    const value = byCanonical[key];
    return Array.isArray(value) ? value.map(item => String(item ?? "").trim()).filter(Boolean).join("; ") : value === undefined || value === null ? "" : String(value).trim();
  };
  const strengthValue = text("strength") || text("baseline_score");
  const strength = strengthValue === "" ? 50 : Number(strengthValue);
  const capturedAt = normalizeSpreadsheetDate(byCanonical.captured_at) ?? new Date().toISOString();
  const followUpDate = normalizeSpreadsheetDate(byCanonical.follow_up_date);
  const followUpTime = normalizeSpreadsheetTime(byCanonical.follow_up_time);
  const mappedPayload = { ...byCanonical };
  if (followUpDate) mappedPayload.follow_up_date = followUpDate;
  if (followUpTime) mappedPayload.follow_up_time = followUpTime;
  return {
    accountName: text("account_name"), domain: normalizedDomain(text("domain")), industry: text("industry"),
    contactName: text("contact_name"), firstName: text("first_name"), lastName: text("last_name"),
    email: text("email").toLowerCase(), phone: text("phone"), title: text("title"), source: text("source"),
    externalId: text("external_id"), summary: text("summary"), vertical: text("vertical"), function: text("function"),
    strength: Number.isFinite(strength) && strength >= 0 && strength <= 100 ? Math.round(strength) : null,
    capturedAt,
    rawPayload: raw,
    mappedPayload,
    answerSignals: uploadedAnswerSignals(byCanonical, questionnaireSettings),
  };
}
async function previewRows(tenantId: number, kind: ImportKind, rows: Record<string, unknown>[], mapping: Record<string, string>, clientId?: number, audienceId?: number) {
  const output: any[] = [];
  const questionnaireSettings = responseImport(kind) ? await readQuestionnaireSettings(tenantId) : QUESTIONNAIRE_DIMENSION_DEFAULTS;
  const catalog = responseImport(kind)
    ? (await pool.query<ImportCatalogProduct>(`SELECT p.id,p.name,c.name AS category,s.name AS subcategory
         FROM intent_products p
         JOIN intent_product_categories c ON c.tenant_id=p.tenant_id AND c.id=p.category_id
         LEFT JOIN intent_product_subcategories s ON s.tenant_id=p.tenant_id AND s.id=p.subcategory_id
        WHERE p.tenant_id=$1 AND p.active=true
        ORDER BY c.name,s.name,p.name`, [tenantId])).rows
    : [];
  for (let index = 0; index < rows.length; index++) {
    const normalized = normalizeImportRow(rows[index], mapping, questionnaireSettings);
    const match = await matchEntities(tenantId, { email: normalized.email, phone: normalized.phone, companyName: normalized.accountName, domain: normalized.domain });
    const inferredProducts = inferProductsFromInterest(normalized.mappedPayload.product_interest ?? normalized.mappedPayload.product_service_interest, catalog);
    const errors: string[] = [];
    const accountInScope = !match.accountId || kind === "account_list" || await hasCompanyScope(tenantId,match.accountId,clientId,audienceId);
    const contactInScope = !match.contactId || kind === "account_list" || await hasContactScope(tenantId, match.contactId, clientId, match.accountId, audienceId);
    if (normalized.strength === null) errors.push("strength must be between 0 and 100");
    if (!normalized.capturedAt) errors.push("captured_at must be a valid date");
    if (kind === "account_list" && !match.accountId && (!clientId || !normalized.accountName)) errors.push("A new account requires clientId and account_name");
    const canCreateRespondent = responseImport(kind) && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized.email);
    const canCreateScopedAccount = responseImport(kind) && Boolean(clientId && normalized.accountName);
    const willReplaceAccount = Boolean(match.accountId && !accountInScope && canCreateScopedAccount);
    const willReplaceContact = Boolean(match.contactId && !contactInScope && canCreateRespondent);
    if (match.accountId && !accountInScope && !willReplaceAccount) errors.push("Matched company is outside the selected client or audience and the row cannot create a scoped company");
    if (match.contactId && !contactInScope && !willReplaceContact) errors.push("Matched contact is outside the selected client or audience and the row cannot create a scoped respondent");
    if (match.conflict && accountInScope && contactInScope) errors.push("Contact and account identifiers resolve to different canonical companies");
    if (canCreateRespondent && audienceId && (!match.accountId || !accountInScope) && !canCreateScopedAccount) errors.push("Audience-scoped respondents require an account name that can be added to the selected client");
    if (kind === "consulting" ? !normalized.vertical : kind !== "account_list" && (!match.accountId || !accountInScope) && (!match.contactId || !contactInScope) && !canCreateRespondent) errors.push(kind === "consulting" ? "Consulting rows require vertical" : responseImport(kind) ? "A valid email or canonical account/contact match is required" : "No unambiguous canonical match");
    output.push({
      rowNumber: index + 1,
      status: errors.length ? "error" : "valid",
      normalized,
      match: {
        ...match,
        accountInScope,
        contactInScope,
        willCreateAccount: (!match.accountId || willReplaceAccount) && canCreateScopedAccount,
        willCreateContact: (!match.contactId || willReplaceContact) && canCreateRespondent,
        replacingOutOfScopeAccount: willReplaceAccount,
        replacingOutOfScopeContact: willReplaceContact,
      },
      inferredProducts,
      errors,
    });
  }
  return output;
}
function importResponse(rows: any[], mapping: Record<string, string>) {
  const headers = [...new Set(rows.flatMap(row => Object.keys(row.normalized.rawPayload)))];
  return {
    headers, mappingFields: fields.map(key => ({ key, label: key.replace(/_/g, " ") })), mapping,
    rows, summary: {
      total: rows.length,
      valid: rows.filter(r => r.status === "valid").length,
      invalid: rows.filter(r => r.status === "error").length,
    },
  };
}

/* Catalog and audiences are deliberately separate from global entity scores. */
router.get("/intent/catalog", async (req, res, next) => { try {
  const u = req.user as User;
  await ensureIntentCatalogDefaults(u.tenantId);
  const [categories, subcategories, products] = await Promise.all([
    pool.query(`SELECT id,name,created_at AS "createdAt",updated_at AS "updatedAt" FROM intent_product_categories WHERE tenant_id=$1 ORDER BY name`, [u.tenantId]),
    pool.query(`SELECT id,category_id AS "categoryId",name,created_at AS "createdAt",updated_at AS "updatedAt" FROM intent_product_subcategories WHERE tenant_id=$1 ORDER BY name`, [u.tenantId]),
    pool.query(`SELECT id,category_id AS "categoryId",subcategory_id AS "subcategoryId",name,active,created_at AS "createdAt",updated_at AS "updatedAt" FROM intent_products WHERE tenant_id=$1 ORDER BY name`, [u.tenantId]),
  ]);
  res.json({ categories: categories.rows, subcategories: subcategories.rows, products: products.rows });
} catch (e) { next(e); } });
router.get("/intent/scope-options", async (req,res,next) => { try {
  const u=req.user as User;
  const allowedClients=permittedClientIds(req);
  const clientId=positiveId(String(req.query.clientId??""));
  if(req.query.clientId&&!await hasClient(u.tenantId,clientId??undefined)){res.status(400).json({error:"Unknown client"});return;}
  await ensureIntentCatalogDefaults(u.tenantId);
  const [clients,segments,categories,subcategories,products,audiences,accounts,accountCount,categoryRules,rosters]=await Promise.all([
    pool.query(`SELECT id,name FROM clients WHERE tenant_id=$1 AND ($2::int[] IS NULL OR id=ANY($2::int[])) ORDER BY name`,[u.tenantId,allowedClients]),
    allowedClients===null ? pool.query(`SELECT id,name,last_computed_count AS "memberCount" FROM segments WHERE tenant_id=$1 ORDER BY name`,[u.tenantId]) : Promise.resolve({rows:[]}),
    pool.query(`SELECT id,name FROM intent_product_categories WHERE tenant_id=$1 ORDER BY name`,[u.tenantId]),
    pool.query(`SELECT id,category_id AS "categoryId",name FROM intent_product_subcategories WHERE tenant_id=$1 ORDER BY name`,[u.tenantId]),
    pool.query(`SELECT id,category_id AS "categoryId",subcategory_id AS "subcategoryId",name,active FROM intent_products WHERE tenant_id=$1 ORDER BY name`,[u.tenantId]),
    pool.query(`SELECT id,name,client_id AS "clientId",description FROM intent_audiences WHERE tenant_id=$1 AND ($2::int IS NULL OR client_id IS NULL OR client_id=$2)
      AND ($3::int[] IS NULL OR client_id=ANY($3::int[])) ORDER BY name`,[u.tenantId,clientId,allowedClients]),
    req.query.includeAccounts==="false" ? Promise.resolve({rows:[]}) :
      pool.query(`SELECT id,name,domain,client_id AS "clientId" FROM companies WHERE tenant_id=$1 AND ($2::int IS NULL OR client_id=$2)
        AND ($3::int[] IS NULL OR client_id=ANY($3::int[])) ORDER BY name,id`,[u.tenantId,clientId,allowedClients]),
    pool.query<{count:string}>(`SELECT count(*) FROM companies WHERE tenant_id=$1 AND ($2::int IS NULL OR client_id=$2)
      AND ($3::int[] IS NULL OR client_id=ANY($3::int[]))`,[u.tenantId,clientId,allowedClients]),
    loadInboundCategoryRules(u.tenantId),
    pool.query(`SELECT p.client_id AS "clientId",cl.name||' — Full account roster' AS name,
      count(*)::int AS "memberCount" FROM hp_account_profiles p
      JOIN companies c ON c.id=p.company_id AND c.tenant_id=p.tenant_id AND c.client_id=p.client_id
      JOIN clients cl ON cl.id=p.client_id AND cl.tenant_id=p.tenant_id
      WHERE p.tenant_id=$1 AND ($2::int IS NULL OR p.client_id=$2)
        AND ($3::int[] IS NULL OR p.client_id=ANY($3::int[]))
      GROUP BY p.client_id,cl.name ORDER BY cl.name`,[u.tenantId,clientId,allowedClients]),
  ]);
  const subcategoryNames=new Map(subcategories.rows.map(row=>[Number(row.id),String(row.name)]));
  const mappedProducts=products.rows.map(product=>({
    ...product,
    inboundCategoryName:inboundCategoryForInterest(
      [product.name,subcategoryNames.get(Number(product.subcategoryId))].filter(Boolean).join(" "),null,categoryRules,
    ).categoryName,
  }));
  res.json({clients:clients.rows,segments:segments.rows,categories:categories.rows,categoryNames:inboundCategories,subcategories:subcategories.rows,products:mappedProducts,audiences:audiences.rows,accounts:accounts.rows,accountCount:Number(accountCount.rows[0]?.count??0),rosters:rosters.rows});
} catch(e){next(e);} });

router.post("/intent/monitoring-roster-audience", async (req,res,next) => {
  const u=admin(req,res); if(!u)return;
  const parsed=z.object({clientId:z.number().int().positive()}).safeParse(req.body);
  if(!parsed.success){res.status(400).json({error:"Choose a valid client roster"});return;}
  try { res.json(await selectMonitoringRoster(u.tenantId,parsed.data.clientId)); }
  catch(error){
    if(error instanceof Error && /Unknown client|No HP roster|already uses/.test(error.message)){
      res.status(400).json({error:error.message});return;
    }
    next(error);
  }
});

router.get("/intent/monitoring-account-options", async (req, res, next) => {
  try {
    const u = admin(req, res); if (!u) return;
    const parsed = z.object({
      clientId: z.coerce.number().int().positive().optional(),
      audienceId: z.coerce.number().int().positive().optional(),
      search: z.string().max(200).optional(),
      page: z.coerce.number().int().min(1).max(100000).default(1),
      pageSize: z.coerce.number().int().min(1).max(50).default(25),
      ids: z.string().max(2400).regex(/^\d+(,\d+)*$/).optional(),
    }).safeParse(req.query);
    if (!parsed.success) { res.status(400).json({error:"Invalid account search"}); return; }
    const input = parsed.data;
    const ids = input.ids?.split(",").map(Number);
    if (ids && (ids.length > 200 || ids.some(id => !Number.isSafeInteger(id) || id <= 0))) {
      res.status(400).json({error:"Select at most 200 valid account IDs"}); return;
    }
    if (input.clientId && !await hasClient(u.tenantId,input.clientId)) {
      res.status(400).json({error:"Unknown client"}); return;
    }
    if (input.audienceId && !(await pool.query(`SELECT 1 FROM intent_audiences
      WHERE tenant_id=$1 AND id=$2 AND ($3::int IS NULL OR client_id IS NULL OR client_id=$3)`,
    [u.tenantId,input.audienceId,input.clientId ?? null])).rowCount) {
      res.status(400).json({error:"Unknown list for this client"}); return;
    }
    res.json(await monitoringAccountOptions(u.tenantId,{...input,ids}));
  } catch (error) { next(error); }
});

router.get("/intent/pipeline-pricing", async (req, res, next) => { try {
  const u = req.user as User;
  await ensureIntentCatalogDefaults(u.tenantId);
  const rows = await pool.query(`SELECT c.id AS "categoryId",c.name AS "categoryName",p.id AS "productId",p.name AS "productName",
    coalesce(pp.average_unit_price,0)::float8 AS "averageUnitPrice",coalesce(pp.currency,'INR') AS currency
    FROM intent_product_categories c
    JOIN intent_products p ON p.tenant_id=c.tenant_id AND p.category_id=c.id AND p.active=true
    LEFT JOIN intent_product_pricing pp ON pp.tenant_id=p.tenant_id AND pp.product_id=p.id
    WHERE c.tenant_id=$1 ORDER BY c.name,p.name`, [u.tenantId]);
  const categories = new Map<number, any>();
  for (const row of rows.rows as any[]) {
    const category = categories.get(row.categoryId) ?? { id: row.categoryId, name: row.categoryName, products: [] };
    category.products.push({ id: row.productId, name: row.productName, averageUnitPrice: Number(row.averageUnitPrice) || 0 });
    categories.set(row.categoryId, category);
  }
  res.json({ currency: rows.rows[0]?.currency ?? "INR", categories: [...categories.values()] });
} catch (e) { next(e); } });

router.put("/intent/pipeline-pricing", async (req, res, next) => {
  const u = admin(req, res); if (!u) return;
  const parsed = z.object({
    currency: z.string().trim().regex(/^[A-Z]{3}$/),
    prices: z.array(z.object({ productId: z.number().int().positive(), averageUnitPrice: z.number().finite().min(0).max(1_000_000_000_000) })).max(2000),
  }).safeParse(req.body);
  if (!parsed.success || new Set(parsed.data?.prices.map(price => price.productId)).size !== parsed.data?.prices.length) {
    res.status(400).json({ error: "Invalid pipeline pricing" }); return;
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const valid = await client.query<{id:number}>("SELECT id FROM intent_products WHERE tenant_id=$1 AND active=true AND id=ANY($2::int[])", [u.tenantId, parsed.data.prices.map(price => price.productId)]);
    if (valid.rows.length !== parsed.data.prices.length) {
      await client.query("ROLLBACK"); res.status(400).json({ error: "Unknown product in pipeline pricing" }); return;
    }
    for (const price of parsed.data.prices) {
      await client.query(`INSERT INTO intent_product_pricing(tenant_id,product_id,average_unit_price,currency,updated_by)
        VALUES($1,$2,$3,$4,$5)
        ON CONFLICT(tenant_id,product_id) DO UPDATE SET average_unit_price=excluded.average_unit_price,currency=excluded.currency,updated_by=excluded.updated_by,updated_at=NOW()`,
        [u.tenantId, price.productId, price.averageUnitPrice, parsed.data.currency, u.id]);
    }
    await client.query("COMMIT");
    res.json({ currency: parsed.data.currency, prices: parsed.data.prices });
  } catch (e) { await client.query("ROLLBACK"); next(e); } finally { client.release(); }
});

router.post(["/intent/categories", "/intent/catalog/category"], async (req, res, next) => { try {
  const u = admin(req, res), p = catalogBody.safeParse(req.body); if (!u) return;
  if (!p.success) { res.status(400).json({ error: "Invalid category" }); return; }
  const q = await pool.query(`INSERT INTO intent_product_categories(tenant_id,name) VALUES($1,$2) RETURNING id,name,created_at AS "createdAt",updated_at AS "updatedAt"`, [u.tenantId, p.data.name]);
  res.status(201).json({ category: q.rows[0] });
} catch (e) { next(e); } });
router.put(["/intent/categories/:id", "/intent/catalog/category/:id"], async (req, res, next) => { try {
  const u = admin(req, res), id = positiveId(String(req.params.id)), p = catalogBody.safeParse(req.body); if (!u) return;
  if (!id || !p.success) { res.status(400).json({ error: "Invalid category" }); return; }
  const q = await pool.query(`UPDATE intent_product_categories SET name=$1,updated_at=NOW() WHERE tenant_id=$2 AND id=$3 RETURNING id,name,created_at AS "createdAt",updated_at AS "updatedAt"`, [p.data.name,u.tenantId,id]);
  if (!q.rows[0]) { res.status(404).json({ error: "Category not found" }); return; } res.json({ category:q.rows[0] });
} catch (e) { next(e); } });
router.delete(["/intent/categories/:id", "/intent/catalog/category/:id"], async (req, res, next) => { try { const u=admin(req,res),id=positiveId(String(req.params.id)); if(!u)return; if(!id){res.status(400).json({error:"Invalid category"});return;} const used=await pool.query("SELECT 1 FROM intent_product_subcategories WHERE tenant_id=$1 AND category_id=$2 UNION ALL SELECT 1 FROM intent_products WHERE tenant_id=$1 AND category_id=$2 LIMIT 1",[u.tenantId,id]);if(used.rows[0]){res.status(409).json({error:"Category has subcategories or products"});return;} const q=await pool.query("DELETE FROM intent_product_categories WHERE tenant_id=$1 AND id=$2 RETURNING id",[u.tenantId,id]); if(!q.rows[0]){res.status(404).json({error:"Category not found"});return;} res.sendStatus(204); } catch(e){next(e);} });

router.post(["/intent/subcategories", "/intent/catalog/subcategory"], async (req,res,next) => { try { const u=admin(req,res),p=catalogBody.safeParse(req.body); if(!u)return; if(!p.success || !p.data.categoryId){res.status(400).json({error:"Invalid subcategory"});return;} const q=await pool.query(`INSERT INTO intent_product_subcategories(tenant_id,category_id,name) SELECT $1,$2,$3 WHERE EXISTS(SELECT 1 FROM intent_product_categories WHERE tenant_id=$1 AND id=$2) RETURNING id,category_id AS "categoryId",name,created_at AS "createdAt",updated_at AS "updatedAt"`,[u.tenantId,p.data.categoryId,p.data.name]);if(!q.rows[0]){res.status(400).json({error:"Unknown category"});return;}res.status(201).json({subcategory:q.rows[0]}); }catch(e){next(e);} });
router.put(["/intent/subcategories/:id", "/intent/catalog/subcategory/:id"], async (req,res,next)=>{try{const u=admin(req,res),id=positiveId(String(req.params.id)),p=catalogBody.safeParse(req.body);if(!u)return;if(!id||!p.success||!p.data.categoryId){res.status(400).json({error:"Invalid subcategory"});return;}const q=await pool.query(`UPDATE intent_product_subcategories SET name=$1,category_id=$2,updated_at=NOW() WHERE tenant_id=$3 AND id=$4 AND EXISTS(SELECT 1 FROM intent_product_categories WHERE tenant_id=$3 AND id=$2) RETURNING id,category_id AS "categoryId",name`,[p.data.name,p.data.categoryId,u.tenantId,id]);if(!q.rows[0]){res.status(404).json({error:"Subcategory not found"});return;}res.json({subcategory:q.rows[0]});}catch(e){next(e);}});
router.delete(["/intent/subcategories/:id", "/intent/catalog/subcategory/:id"], async(req,res,next)=>{try{const u=admin(req,res),id=positiveId(String(req.params.id));if(!u)return;if(!id){res.status(400).json({error:"Invalid subcategory"});return;}const used=await pool.query("SELECT 1 FROM intent_products WHERE tenant_id=$1 AND subcategory_id=$2 LIMIT 1",[u.tenantId,id]);if(used.rows[0]){res.status(409).json({error:"Subcategory has products"});return;}const q=await pool.query("DELETE FROM intent_product_subcategories WHERE tenant_id=$1 AND id=$2 RETURNING id",[u.tenantId,id]);if(!q.rows[0]){res.status(404).json({error:"Subcategory not found"});return;}res.sendStatus(204);}catch(e){next(e);}});

router.post(["/intent/products", "/intent/catalog/product"], async(req,res,next)=>{try{const u=admin(req,res),p=catalogBody.safeParse(req.body);if(!u)return;if(!p.success||!p.data.categoryId){res.status(400).json({error:"Invalid product"});return;}const q=await pool.query(`INSERT INTO intent_products(tenant_id,category_id,subcategory_id,name,active) SELECT $1,$2,$3,$4,$5 WHERE EXISTS(SELECT 1 FROM intent_product_categories WHERE tenant_id=$1 AND id=$2) AND ($3::int IS NULL OR EXISTS(SELECT 1 FROM intent_product_subcategories WHERE tenant_id=$1 AND id=$3 AND category_id=$2)) RETURNING id,category_id AS "categoryId",subcategory_id AS "subcategoryId",name,active`,[u.tenantId,p.data.categoryId,p.data.subcategoryId ?? null,p.data.name,p.data.active ?? true]);if(!q.rows[0]){res.status(400).json({error:"Unknown category or subcategory"});return;}res.status(201).json({product:q.rows[0]});}catch(e){next(e);}});
router.put(["/intent/products/:id", "/intent/catalog/product/:id"], async(req,res,next)=>{try{const u=admin(req,res),id=positiveId(String(req.params.id)),p=catalogBody.safeParse(req.body);if(!u)return;if(!id||!p.success||!p.data.categoryId){res.status(400).json({error:"Invalid product"});return;}const q=await pool.query(`UPDATE intent_products SET category_id=$1,subcategory_id=$2,name=$3,active=$4,updated_at=NOW() WHERE tenant_id=$5 AND id=$6 AND EXISTS(SELECT 1 FROM intent_product_categories WHERE tenant_id=$5 AND id=$1) AND ($2::int IS NULL OR EXISTS(SELECT 1 FROM intent_product_subcategories WHERE tenant_id=$5 AND id=$2 AND category_id=$1)) RETURNING id,category_id AS "categoryId",subcategory_id AS "subcategoryId",name,active`,[p.data.categoryId,p.data.subcategoryId ??null,p.data.name,p.data.active??true,u.tenantId,id]);if(!q.rows[0]){res.status(400).json({error:"Unknown category or subcategory, or product not found"});return;}res.json({product:q.rows[0]});}catch(e){next(e);}});
router.delete(["/intent/products/:id", "/intent/catalog/product/:id"],async(req,res,next)=>{try{const u=admin(req,res),id=positiveId(String(req.params.id));if(!u)return;if(!id){res.status(400).json({error:"Invalid product"});return;}const q=await pool.query("DELETE FROM intent_products WHERE tenant_id=$1 AND id=$2 RETURNING id",[u.tenantId,id]);if(!q.rows[0]){res.status(404).json({error:"Product not found"});return;}res.sendStatus(204);}catch(e){next(e);}});

router.get("/intent/audiences", async(req,res,next)=>{try{const u=req.user as User;const q=await pool.query(`SELECT a.id,a.name,a.description,a.created_at AS "createdAt",count(m.company_id)::int AS "companyCount" FROM intent_audiences a LEFT JOIN intent_audience_companies m ON m.tenant_id=a.tenant_id AND m.audience_id=a.id WHERE a.tenant_id=$1 GROUP BY a.id ORDER BY a.name`,[u.tenantId]);res.json({audiences:q.rows});}catch(e){next(e);}});
router.post("/intent/audiences",async(req,res,next)=>{try{
  const u=req.user as User,p=catalogBody.safeParse(req.body); if(!p.success||!(await hasClient(u.tenantId,p.data.clientId))){res.status(400).json({error:"Invalid audience or client"});return;}
  const memberIds=new Set<number>(p.data.companyIds??[]), errors:Array<{rowNumber:number;error:string}>=[];
  const segments=await pool.query<{id:number;segment_type:"static"|"dynamic";static_contact_ids:number[]|null;filter_criteria:FilterCriterion[]|null;logic_operator:"AND"|"OR"}>(`SELECT id,segment_type,static_contact_ids,filter_criteria,logic_operator FROM segments WHERE tenant_id=$1 AND id=ANY($2::int[])`,[u.tenantId,p.data.segmentIds]);
  if(segments.rows.length!==p.data.segmentIds.length){res.status(400).json({error:"Unknown segment"});return;}
  for(const segment of segments.rows){
    let contactIds:number[]=segment.static_contact_ids??[];
    if(segment.segment_type==="dynamic"){
      const where=await buildContactsWhereClause(u.tenantId,segment.filter_criteria??[],segment.logic_operator==="OR"?"OR":"AND");
      contactIds=((await db.execute(sql`SELECT c.id FROM contacts c LEFT JOIN companies co ON co.id=c.company_id WHERE ${where}`)).rows as any[]).map(r=>Number(r.id));
    }
    if(contactIds.length){const companies=await pool.query<{company_id:number}>(`SELECT DISTINCT company_id FROM contacts WHERE tenant_id=$1 AND company_id IS NOT NULL AND id=ANY($2::int[])`,[u.tenantId,contactIds]);companies.rows.forEach(r=>memberIds.add(r.company_id));}
  }
  for(let i=0;i<(p.data.rows??[]).length;i++){const n=normalizeImportRow(p.data.rows![i],p.data.mapping);const m=await matchEntities(u.tenantId,{companyName:n.accountName,domain:n.domain});if(m.conflict||!m.accountId)errors.push({rowNumber:i+1,error:m.conflict?"Conflicting company identifiers":"No unambiguous company match"});else memberIds.add(m.accountId);}
  const c=await pool.connect();try{await c.query("BEGIN");const q=await c.query(`INSERT INTO intent_audiences(tenant_id,client_id,name,description,created_by) VALUES($1,$2,$3,$4,$5) RETURNING id,name,client_id AS "clientId",description,created_at AS "createdAt"`,[u.tenantId,p.data.clientId??null,p.data.name,p.data.description??null,u.id]);
    const valid=await c.query<{id:number}>(`SELECT id FROM companies WHERE tenant_id=$1 AND id=ANY($2::int[]) AND ($3::int IS NULL OR client_id=$3)`,[u.tenantId,[...memberIds],p.data.clientId??null]);
    for(const row of valid.rows)await c.query("INSERT INTO intent_audience_companies(tenant_id,audience_id,company_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",[u.tenantId,q.rows[0].id,row.id]);
    await c.query("COMMIT");res.status(201).json({audience:{...q.rows[0],companyCount:valid.rows.length},added:valid.rows.length,validationErrors:errors});
  }catch(e){await c.query("ROLLBACK");throw e;}finally{c.release();}
}catch(e){next(e);}});
router.delete("/intent/audiences/:id",async(req,res,next)=>{const c=await pool.connect();try{const u=req.user as User,id=positiveId(String(req.params.id));if(!id){res.status(400).json({error:"Invalid audience"});return;}await c.query("BEGIN");const found=await c.query("SELECT 1 FROM intent_audiences WHERE tenant_id=$1 AND id=$2",[u.tenantId,id]);if(!found.rows[0]){await c.query("ROLLBACK");res.status(404).json({error:"Audience not found"});return;}await c.query("DELETE FROM intent_audience_companies WHERE tenant_id=$1 AND audience_id=$2",[u.tenantId,id]);await c.query("DELETE FROM intent_audiences WHERE tenant_id=$1 AND id=$2",[u.tenantId,id]);await c.query("COMMIT");res.sendStatus(204);}catch(e){await c.query("ROLLBACK");next(e);}finally{c.release();}});
router.get("/intent/candidate-companies",async(req,res,next)=>{try{const u=req.user as User,clientId=positiveId(String(req.query.clientId??""));if(req.query.clientId&&!await hasClient(u.tenantId,clientId??undefined)){res.status(400).json({error:"Unknown client"});return;}const q=await pool.query(`SELECT id,name,domain,industry,client_id AS "clientId" FROM companies WHERE tenant_id=$1 AND ($2::int IS NULL OR client_id=$2) ORDER BY name LIMIT 1000`,[u.tenantId,clientId]);res.json({companies:q.rows});}catch(e){next(e);}});
router.get("/intent/companies",async(req,res,next)=>{try{const u=req.user as User,clientId=positiveId(String(req.query.clientId??"")),search=typeof req.query.search==="string"&&req.query.search.trim()?`%${req.query.search.trim()}%`:null;if(req.query.clientId&&!await hasClient(u.tenantId,clientId??undefined)){res.status(400).json({error:"Unknown client"});return;}const q=await pool.query(`SELECT id,name,domain,industry,client_id AS "clientId" FROM companies WHERE tenant_id=$1 AND ($2::int IS NULL OR client_id=$2) AND ($3::text IS NULL OR name ILIKE $3 OR domain ILIKE $3) ORDER BY name LIMIT 1000`,[u.tenantId,clientId,search]);res.json(q.rows);}catch(e){next(e);}});
router.post("/intent/audiences/:id/segments/:segmentId", async (req, res, next) => { try {
  const u=req.user as User, audienceId=positiveId(req.params.id), segmentId=positiveId(req.params.segmentId);
  if (!audienceId || !segmentId) { res.status(400).json({ error:"Invalid audience or segment" }); return; }
  const audience=await pool.query<{client_id:number|null}>("SELECT client_id FROM intent_audiences WHERE tenant_id=$1 AND id=$2",[u.tenantId,audienceId]);
  const segment=await pool.query<{segment_type:string;static_contact_ids:number[]|null;filter_criteria:FilterCriterion[]|null;logic_operator:"AND"|"OR"}>("SELECT segment_type,static_contact_ids,filter_criteria,logic_operator FROM segments WHERE tenant_id=$1 AND id=$2",[u.tenantId,segmentId]);
  if(!audience.rows[0]||!segment.rows[0]){res.status(404).json({error:"Audience or segment not found"});return;}
  let ids=segment.rows[0].segment_type==="static" ? segment.rows[0].static_contact_ids??[] : [];
  if(segment.rows[0].segment_type==="dynamic"){const where=await buildContactsWhereClause(u.tenantId,segment.rows[0].filter_criteria??[],segment.rows[0].logic_operator==="OR"?"OR":"AND");ids=((await db.execute(sql`SELECT c.id FROM contacts c LEFT JOIN companies co ON co.id=c.company_id WHERE ${where}`)).rows as any[]).map(r=>Number(r.id));}
  const added=await pool.query(`INSERT INTO intent_audience_companies(tenant_id,audience_id,company_id)
    SELECT DISTINCT $1,$2,company_id FROM contacts WHERE tenant_id=$1 AND company_id IS NOT NULL AND id=ANY($3::int[]) AND ($4::int IS NULL OR EXISTS(SELECT 1 FROM companies WHERE tenant_id=$1 AND id=contacts.company_id AND client_id=$4))
    ON CONFLICT DO NOTHING RETURNING company_id`,[u.tenantId,audienceId,ids,audience.rows[0].client_id]);
  res.json({ audienceId, segmentId, added: added.rowCount ?? 0, companyIds: added.rows.map((r:any)=>r.company_id) });
} catch(e){next(e);} });

router.get("/intent/overview", async (req, res, next) => { try {
  const u = req.user as User;
  const clientId=positiveId(String(req.query.clientId??"")), audienceId=positiveId(String(req.query.audienceId??"")), segmentId=positiveId(String(req.query.segmentId??"")), accountId=positiveId(String(req.query.accountId??"")), productId=positiveId(String(req.query.productId??"")), categoryIds=positiveIds(req.query.categoryIds??req.query.categoryId), subcategoryIds=positiveIds(req.query.subcategoryIds??req.query.subcategoryId);
  const categoryName=typeof req.query.categoryName==="string"?req.query.categoryName.trim():"";
  if(categoryName&&!inboundCategories.includes(categoryName)){res.status(400).json({error:"Unknown category name"});return;}
  const categoryConfig=await loadInboundCategoryRules(u.tenantId);
  if ((req.query.clientId && !await hasClient(u.tenantId,clientId??undefined)) || !await hasAudienceScope(u.tenantId,audienceId??undefined,clientId??undefined) || (accountId&&!await hasCompanyScope(u.tenantId,accountId,clientId??undefined,audienceId??undefined))) { res.status(400).json({error:"Invalid intent scope"}); return; }
   if(String(req.query.navOnly)==="true"){
    const counts=await pool.query(`SELECT (SELECT count(*)::int FROM companies c
      WHERE c.tenant_id=$1 AND ($2::int IS NULL OR c.client_id=$2)
        AND ($3::int IS NULL OR EXISTS(SELECT 1 FROM intent_audience_companies ac
          WHERE ac.tenant_id=c.tenant_id AND ac.audience_id=$3 AND ac.company_id=c.id))) AS accounts,
      (SELECT count(*)::int FROM intent_signals s JOIN companies c ON c.tenant_id=s.tenant_id AND c.id=s.account_id
        WHERE s.tenant_id=$1 AND s.occurred_at>=NOW()-interval '30 days'
          AND (s.expires_at IS NULL OR s.expires_at>NOW())
          AND ($2::int IS NULL OR c.client_id=$2)
          AND ($3::int IS NULL OR EXISTS(SELECT 1 FROM intent_audience_companies ac
            WHERE ac.tenant_id=s.tenant_id AND ac.audience_id=$3 AND ac.company_id=s.account_id))) AS signals`,
      [u.tenantId,clientId,audienceId]);
    res.json({totalAccounts:counts.rows[0]?.accounts??0,activeSignals30d:counts.rows[0]?.signals??0,
      hotAccounts:null,tierBreakdown:[],qualificationDeferred:true});
    return;
   }
   if (String(req.query.summaryOnly) === "true" || categoryName) {
    await Promise.all([ensureIntentDefaults(u.tenantId),ensureIntentCatalogDefaults(u.tenantId)]);
    let requestedScope=await scopedProductIds(u.tenantId,productId,categoryIds,subcategoryIds);
    if(requestedScope===undefined){res.status(400).json({error:"Unknown product scope"});return;}
    if(categoryName&&!productId&&!categoryIds.length&&!subcategoryIds.length)
      requestedScope=await inboundCategoryProductIds(u.tenantId,categoryName,categoryConfig);
    const scope=requestedScope??await visibleProductIds(u.tenantId);
    const segmentCompanyIds=await segmentCompanyScope(u.tenantId,segmentId);
    if(segmentCompanyIds===undefined){res.status(400).json({error:"Unknown segment"});return;}
    const companies=await pool.query<{id:number}>(`SELECT c.id FROM companies c WHERE c.tenant_id=$1
      AND ($2::int IS NULL OR c.client_id=$2)
      AND ($3::int IS NULL OR EXISTS(SELECT 1 FROM intent_audience_companies ac WHERE ac.tenant_id=c.tenant_id AND ac.audience_id=$3 AND ac.company_id=c.id))
      AND ($4::int[] IS NULL OR c.id=ANY($4::int[]))
      AND ($5::int IS NULL OR c.id=$5)`,
      [u.tenantId,clientId,audienceId,segmentCompanyIds,accountId]);
    const [canonical,tierRows]=await Promise.all([
      canonicalScopedAccountIntents(u.tenantId,companies.rows.map(row=>row.id),scope,requestedScope,categoryIds,categoryConfig,categoryName||undefined),
      pool.query<{key:string;label:string;minScore:number}>('SELECT key,label,min_score AS "minScore" FROM intent_tiers WHERE tenant_id=$1 AND active ORDER BY min_score',[u.tenantId]),
    ]);
    const counts=new Map<string,number>([["hot",0],["warm",0],["cold",0]]);
    for(const value of canonical.values()){
      if(categoryName){
        const match=(value.productAnalysis?.topCategories??[]).some((item:any)=>item.category===categoryName&&item.score>0)
          ||(value.intentStatus?.categories??[]).some((item:any)=>item.name===categoryName&&["hot","warm"].includes(item.status)&&item.attribution!=="INHERITED_OPEN");
        if(!match)continue;
      }
      counts.set(value.tier,(counts.get(value.tier)??0)+1);
    }
    const active=scope.length?await pool.query<{count:string}>(`SELECT count(*) FROM intent_signals s LEFT JOIN contacts ct ON ct.tenant_id=s.tenant_id AND ct.id=s.contact_id JOIN companies c ON c.tenant_id=s.tenant_id AND c.id=coalesce(s.account_id,ct.company_id) WHERE s.tenant_id=$1 AND s.product_id=ANY($2::int[]) AND s.occurred_at>=NOW()-interval '30 days' AND (s.expires_at IS NULL OR s.expires_at>NOW()) AND ($3::int IS NULL OR c.client_id=$3) AND ($4::int IS NULL OR EXISTS(SELECT 1 FROM intent_audience_companies ac WHERE ac.tenant_id=s.tenant_id AND ac.audience_id=$4 AND ac.company_id=c.id)) AND ($5::int[] IS NULL OR c.id=ANY($5::int[])) AND ($6::int IS NULL OR c.id=$6)`,[u.tenantId,scope,clientId,audienceId,segmentCompanyIds,accountId]):{rows:[{count:"0"}]};
    res.json({totalAccounts:categoryName?["hot","warm","cold"].reduce((sum,key)=>sum+(counts.get(key)??0),0):companies.rows.length,categoryName:categoryName||null,hotAccounts:counts.get("hot")??0,warmAccounts:counts.get("warm")??0,coldAccounts:counts.get("cold")??0,
      activeSignals30d:Number(active.rows[0]?.count??0),surgingAccounts:0,hotContacts:0,pendingRecommendations:0,totalContacts:0,
      tierBreakdown:["hot","warm","cold"].map(tierKey=>({tierKey,count:counts.get(tierKey)??0})),
      tierThresholds:tierRows.rows}); return;
  }
  await Promise.all([ensureIntentDefaults(u.tenantId),ensureIntentCatalogDefaults(u.tenantId)]);
  let requestedScope=await scopedProductIds(u.tenantId,productId,categoryIds,subcategoryIds);
  if(requestedScope===undefined){res.status(400).json({error:"Unknown product scope"});return;}
  if(categoryName&&!productId&&!categoryIds.length&&!subcategoryIds.length)
    requestedScope=await inboundCategoryProductIds(u.tenantId,categoryName,categoryConfig);
  const scope=requestedScope??await visibleProductIds(u.tenantId);
  if(scope){
    const entities=await pool.query<{account_id:number;trend_delta:number}>(`SELECT c.id AS account_id,coalesce(es.trend_delta,0) AS trend_delta FROM companies c LEFT JOIN intent_entity_scores es ON es.tenant_id=c.tenant_id AND es.account_id=c.id WHERE c.tenant_id=$1 AND ($2::int IS NULL OR c.client_id=$2) AND ($3::int IS NULL OR EXISTS(SELECT 1 FROM intent_audience_companies ac WHERE ac.tenant_id=c.tenant_id AND ac.audience_id=$3 AND ac.company_id=c.id))`,[u.tenantId,clientId,audienceId]);
    const scoreMap=scope.length?await readProductIntentScores(u.tenantId,scope,entities.rows.map(x=>x.account_id)):new Map();
    const scores=entities.rows.map(x=>({
      score:scoreMap.get(x.account_id)?.score??0,
      tier:scoreMap.get(x.account_id)?.tier??"cold",
      lastSignalAt:scoreMap.get(x.account_id)?.lastSignalAt??null,
      contributions:scoreMap.get(x.account_id)?.contributions??[],
      trendDelta:x.trend_delta,
    }));
    const tiers=new Map<string,number>();
    scores.forEach(x=>tiers.set(x.tier,(tiers.get(x.tier)??0)+1));
    const active=scope.length?await pool.query<{count:string}>(`SELECT count(*) FROM intent_signals s LEFT JOIN contacts ct ON ct.tenant_id=s.tenant_id AND ct.id=s.contact_id JOIN companies c ON c.tenant_id=s.tenant_id AND c.id=coalesce(s.account_id,ct.company_id) WHERE s.tenant_id=$1 AND s.product_id=ANY($2::int[]) AND s.occurred_at>=NOW()-interval '30 days' AND (s.expires_at IS NULL OR s.expires_at>NOW()) AND ($3::int IS NULL OR c.client_id=$3) AND ($4::int IS NULL OR EXISTS(SELECT 1 FROM intent_audience_companies ac WHERE ac.tenant_id=s.tenant_id AND ac.audience_id=$4 AND ac.company_id=c.id))`,[u.tenantId,scope,clientId,audienceId]):{rows:[{count:"0"}]};
    res.json({surgingAccounts:scores.filter(x=>x.trendDelta>0).length,hotAccounts:scores.filter(x=>x.tier==="hot").length,hotContacts:0,activeSignals30d:Number(active.rows[0]?.count??0),pendingRecommendations:0,totalAccounts:scores.length,totalContacts:0,tierBreakdown:[...tiers].map(([tier,count])=>({tier,count}))});return;
  }
  if(clientId || audienceId){const q=await pool.query(`SELECT
    (SELECT count(*)::int FROM intent_entity_scores es JOIN companies c ON c.id=es.account_id AND c.tenant_id=es.tenant_id WHERE es.tenant_id=$1 AND es.account_id IS NOT NULL AND ($2::int IS NULL OR c.client_id=$2) AND ($3::int IS NULL OR EXISTS(SELECT 1 FROM intent_audience_companies ac WHERE ac.tenant_id=$1 AND ac.audience_id=$3 AND ac.company_id=c.id)) AND es.trend_delta>0) AS "surgingAccounts",
    (SELECT count(*)::int FROM intent_entity_scores es JOIN companies c ON c.id=es.account_id AND c.tenant_id=es.tenant_id WHERE es.tenant_id=$1 AND es.account_id IS NOT NULL AND ($2::int IS NULL OR c.client_id=$2) AND ($3::int IS NULL OR EXISTS(SELECT 1 FROM intent_audience_companies ac WHERE ac.tenant_id=$1 AND ac.audience_id=$3 AND ac.company_id=c.id)) AND es.tier='hot') AS "hotAccounts",
    (SELECT count(*)::int FROM intent_entity_scores es JOIN contacts ct ON ct.id=es.contact_id AND ct.tenant_id=es.tenant_id JOIN companies c ON c.id=ct.company_id AND c.tenant_id=ct.tenant_id WHERE es.tenant_id=$1 AND es.contact_id IS NOT NULL AND ($2::int IS NULL OR c.client_id=$2) AND ($3::int IS NULL OR EXISTS(SELECT 1 FROM intent_audience_companies ac WHERE ac.tenant_id=$1 AND ac.audience_id=$3 AND ac.company_id=c.id)) AND es.tier='hot') AS "hotContacts",
    (SELECT count(*)::int FROM intent_signals s LEFT JOIN contacts ct ON ct.id=s.contact_id AND ct.tenant_id=s.tenant_id JOIN companies c ON c.tenant_id=s.tenant_id AND c.id=coalesce(s.account_id,ct.company_id) WHERE s.tenant_id=$1 AND s.occurred_at>=NOW()-interval '30 days' AND (s.expires_at IS NULL OR s.expires_at>NOW()) AND ($2::int IS NULL OR c.client_id=$2) AND ($3::int IS NULL OR EXISTS(SELECT 1 FROM intent_audience_companies ac WHERE ac.tenant_id=$1 AND ac.audience_id=$3 AND ac.company_id=c.id))) AS "activeSignals30d",
    (SELECT count(*)::int FROM intent_recommendations r LEFT JOIN contacts ct ON ct.id=r.contact_id AND ct.tenant_id=r.tenant_id JOIN companies c ON c.tenant_id=r.tenant_id AND c.id=coalesce(r.account_id,ct.company_id) WHERE r.tenant_id=$1 AND r.status='pending' AND ($2::int IS NULL OR c.client_id=$2) AND ($3::int IS NULL OR EXISTS(SELECT 1 FROM intent_audience_companies ac WHERE ac.tenant_id=$1 AND ac.audience_id=$3 AND ac.company_id=c.id))) AS "pendingRecommendations",
     (SELECT count(*)::int FROM companies c WHERE c.tenant_id=$1 AND ($2::int IS NULL OR c.client_id=$2) AND ($3::int IS NULL OR EXISTS(SELECT 1 FROM intent_audience_companies ac WHERE ac.tenant_id=$1 AND ac.audience_id=$3 AND ac.company_id=c.id))) AS "totalAccounts",
    (SELECT count(*)::int FROM intent_entity_scores es JOIN contacts ct ON ct.id=es.contact_id AND ct.tenant_id=es.tenant_id JOIN companies c ON c.id=ct.company_id AND c.tenant_id=ct.tenant_id WHERE es.tenant_id=$1 AND es.contact_id IS NOT NULL AND ($2::int IS NULL OR c.client_id=$2) AND ($3::int IS NULL OR EXISTS(SELECT 1 FROM intent_audience_companies ac WHERE ac.tenant_id=$1 AND ac.audience_id=$3 AND ac.company_id=c.id))) AS "totalContacts"`,[u.tenantId,clientId,audienceId]);res.json({...q.rows[0],tierBreakdown:[]});return;}
  const q = await pool.query(`SELECT
    (SELECT count(*)::int FROM intent_entity_scores WHERE tenant_id=$1 AND account_id IS NOT NULL AND trend_delta>0) AS "surgingAccounts",
    (SELECT count(*)::int FROM intent_entity_scores WHERE tenant_id=$1 AND account_id IS NOT NULL AND tier='hot') AS "hotAccounts",
    (SELECT count(*)::int FROM intent_entity_scores WHERE tenant_id=$1 AND contact_id IS NOT NULL AND tier='hot') AS "hotContacts",
    (SELECT count(*)::int FROM intent_signals WHERE tenant_id=$1 AND occurred_at>=NOW()-interval '30 days' AND (expires_at IS NULL OR expires_at>NOW())) AS "activeSignals30d",
    (SELECT count(*)::int FROM intent_recommendations WHERE tenant_id=$1 AND status='pending') AS "pendingRecommendations",
    (SELECT count(*)::int FROM companies WHERE tenant_id=$1) AS "totalAccounts",
    (SELECT count(*)::int FROM intent_entity_scores WHERE tenant_id=$1 AND contact_id IS NOT NULL) AS "totalContacts",
    coalesce((SELECT json_agg(json_build_object('tierKey',tier,'count',count) ORDER BY tier)
      FROM (SELECT tier,count(*)::int count FROM intent_entity_scores WHERE tenant_id=$1 GROUP BY tier) grouped),'[]') AS "tierBreakdown"`, [u.tenantId]);
  res.json(q.rows[0]);
} catch (e) { next(e); } });

router.get("/intent/sales-dashboard", async (req, res, next) => { try {
  const u = req.user as User;
  const categoryConfig=await loadInboundCategoryRules(u.tenantId);
  await Promise.all([ensureIntentDefaults(u.tenantId), ensureIntentCatalogDefaults(u.tenantId)]);
  const catalog = await pool.query<any>(`SELECT c.id AS "categoryId",c.name AS "catalogCategoryName",p.id AS "productId",p.name AS "productName",s.name AS "subcategoryName",
    coalesce(pp.average_unit_price,0)::float8 AS "averageUnitPrice"
    FROM intent_product_categories c JOIN intent_products p ON p.tenant_id=c.tenant_id AND p.category_id=c.id AND p.active=true
    LEFT JOIN intent_product_subcategories s ON s.tenant_id=p.tenant_id AND s.id=p.subcategory_id
    LEFT JOIN intent_product_pricing pp ON pp.tenant_id=p.tenant_id AND pp.product_id=p.id
    WHERE c.tenant_id=$1 ORDER BY c.name,p.name`, [u.tenantId]);
  const allCategoryIds = [...new Set(catalog.rows.map(row => Number(row.categoryId)))];
  const requestedCategoryIds = positiveIds(req.query.categoryIds ?? req.query.categoryId);
  if (requestedCategoryIds.some(id => !allCategoryIds.includes(id))) { res.status(400).json({ error: "Unknown category scope" }); return; }
  const requestedCategoryName=typeof req.query.categoryName==="string"?req.query.categoryName.trim():"";
  if(requestedCategoryName&&!inboundCategories.includes(requestedCategoryName)){res.status(400).json({error:"Unknown category name"});return;}
  const productCategoryNames=new Map<number,string>(catalog.rows.map((row:any)=>[
    Number(row.productId),
    inboundCategoryForInterest([row.productName,row.subcategoryName].filter(Boolean).join(" "),null,categoryConfig).categoryName,
  ]));
  const legacyCategoryIdsByName=new Map(inboundCategories.map(name=>[
    name,
    [...new Set(catalog.rows.filter((row:any)=>productCategoryNames.get(Number(row.productId))===name).map((row:any)=>Number(row.categoryId)))],
  ]));
  const selectedCategoryNames=requestedCategoryName?[requestedCategoryName]
    :requestedCategoryIds.length?inboundCategories.filter(name=>(legacyCategoryIdsByName.get(name)??[]).some(id=>requestedCategoryIds.includes(id)))
    :inboundCategories;
  const selectedLegacyCategoryIds=[...new Set(selectedCategoryNames.flatMap(name=>legacyCategoryIdsByName.get(name)??[]))];
  const selectedProductIds=catalog.rows.filter((row:any)=>
    selectedCategoryNames.includes(productCategoryNames.get(Number(row.productId))??"")
      &&(!requestedCategoryIds.length||requestedCategoryIds.includes(Number(row.categoryId)))
  ).map((row:any)=>Number(row.productId));
  const companies = await pool.query<{id:number;name:string;lastResearchedAt:Date|null}>('SELECT id,name,last_researched_at AS "lastResearchedAt" FROM companies WHERE tenant_id=$1 ORDER BY name LIMIT 1000', [u.tenantId]);
  const analyzable = await pool.query<{id:number}>(`SELECT c.id FROM companies c
    WHERE c.tenant_id=$1 AND (
      EXISTS(SELECT 1 FROM intent_signals s WHERE s.tenant_id=c.tenant_id AND s.account_id=c.id)
      OR EXISTS(SELECT 1 FROM intent_evidence e WHERE e.tenant_id=c.tenant_id AND e.account_id=c.id)
      OR EXISTS(SELECT 1 FROM intent_inbound_submissions ib WHERE ib.tenant_id=c.tenant_id AND ib.account_id=c.id)
      OR EXISTS(SELECT 1 FROM contacts ct JOIN form_submissions fs ON fs.tenant_id=ct.tenant_id AND fs.contact_id=ct.id
        WHERE ct.tenant_id=c.tenant_id AND ct.company_id=c.id AND fs.submitted_at>=NOW()-interval '90 days')
    )`,[u.tenantId]);
  const analysisAccountIds = analyzable.rows.map(row=>row.id);
  const [fits, research, signalRows, submissions] = await Promise.all([
    productFitAnalysis(u.tenantId, analysisAccountIds, selectedProductIds,true,categoryConfig),
    accountResearchIntent(u.tenantId, analysisAccountIds),
    pool.query<any>(`SELECT p.id AS "productId",count(*)::int AS signals
      FROM intent_signals s JOIN intent_products p ON p.tenant_id=s.tenant_id AND p.id=s.product_id
      WHERE s.tenant_id=$1 AND s.occurred_at>=NOW()-interval '30 days' AND (s.expires_at IS NULL OR s.expires_at>NOW())
      GROUP BY p.id`, [u.tenantId]),
    pool.query<any>(`SELECT fs.id,fs.field_values AS "fieldValues",fs.submitted_at AS "submittedAt",ct.company_id AS "accountId"
      FROM form_submissions fs LEFT JOIN contacts ct ON ct.tenant_id=fs.tenant_id AND ct.id=fs.contact_id
      WHERE fs.tenant_id=$1 AND fs.submitted_at>=NOW()-interval '90 days' ORDER BY fs.submitted_at DESC`, [u.tenantId]),
  ]);
  const signalByCategory = new Map<string,number>();
  for(const row of signalRows.rows){
    const categoryName=productCategoryNames.get(Number(row.productId));
    if(categoryName)signalByCategory.set(categoryName,(signalByCategory.get(categoryName)??0)+Number(row.signals));
  }
  const categoryPipeline = new Map<string, { pipeline:number; units:number; matched:number }>();
  let unmatchedSubmissions = 0;
  for (const submission of submissions.rows) {
    const fields = submission.fieldValues && typeof submission.fieldValues === "object" ? submission.fieldValues as Record<string, unknown> : {};
    const normalized = Object.entries(fields).map(([key, value]) => [key.toLowerCase().replace(/[^a-z0-9]+/g, "_"), value] as const);
    const unitField = normalized.find(([key]) => /(^|_)(units?|quantity|qty|device_count|seat_count|license_count)($|_)/.test(key));
    const unitMatch = String(unitField?.[1] ?? "").replace(/,/g, "").match(/\d+(?:\.\d+)?/);
    const units = unitMatch ? Math.max(0, Number(unitMatch[0])) : 0;
    const interestText = normalized.filter(([key]) => /(product|solution|category|interest)/.test(key)).map(([,value]) => String(value ?? "")).join(" ").toLowerCase();
    const product = [...catalog.rows].sort((a,b) => String(b.productName).length-String(a.productName).length).find(row => interestText.includes(String(row.productName).toLowerCase()));
    const mappedCategory=product
      ? productCategoryNames.get(Number(product.productId))
      : inboundCategoryForInterest(interestText,null,categoryConfig).categoryName;
    const categoryName=inboundCategories.includes(mappedCategory??"")?mappedCategory:"";
    if (!categoryName || units <= 0) { unmatchedSubmissions += 1; continue; }
    const categoryProducts = catalog.rows.filter((row:any) => productCategoryNames.get(Number(row.productId)) === categoryName);
    const configured = categoryProducts.map(row => Number(row.averageUnitPrice) || 0).filter(value => value > 0);
    const unitPrice = product ? Number(product.averageUnitPrice) || 0 : configured.length ? configured.reduce((sum,value) => sum + value, 0) / configured.length : 0;
    if (unitPrice <= 0) { unmatchedSubmissions += 1; continue; }
    const current = categoryPipeline.get(categoryName) ?? { pipeline: 0, units: 0, matched: 0 };
    current.pipeline += units * unitPrice; current.units += units; current.matched += 1;
    categoryPipeline.set(categoryName, current);
  }
  const categoryScores=new Map<string,{accountId:number;score:number;tier:string;rationale:string|null;productName:string|null;lastSignalAt:Date|null;lastResearchedAt:Date|null}>();
  const categories = inboundCategories.map(name => {
    const scored = companies.rows.map(account => {
      const fit=fits.get(account.id);
      const category=(fit?.topCategories??[]).find((item:any)=>item.category===name);
      const conclusions=(research.get(account.id)?.opportunityBrief?.categoryConclusions??[])
        .filter((item:any)=>inboundCategoryForInterest([
          item.categoryName,
          ...(item.recommendedProducts??[]).map((product:any)=>String(product.name??"")),
        ].join(" "),null,categoryConfig).categoryName===name);
      const canonical=canonicalCategoryIntent(
        {topCategories:category?[category]:[]},
        {opportunityBrief:{categoryConclusions:conclusions}},
        false,
        70,
        categoryConfig,
      );
      const product=(fit?.topProducts??[]).find((item:any)=>item.category===name);
      const result={
        accountId:account.id,
        score:Number(canonical?.score??0),
        tier:String(canonical?.tier??"cold"),
        rationale:canonical?.rationale??category?.explanation??"No validated evidence supports this category yet.",
        productName:canonical?.strongestProduct??product?.productName??null,
        lastSignalAt:product?.supportingEvidence?.[0]?.occurredAt??null,
        lastResearchedAt:account.lastResearchedAt,
      };
      categoryScores.set(`${account.id}:${name}`,result);
      return result;
    });
    const pipeline = categoryPipeline.get(name) ?? { pipeline: 0, units: 0, matched: 0 };
    return { id: name, name, categoryName:name, legacyCategoryIds:legacyCategoryIdsByName.get(name)??[], imageKey: name, score: Math.max(0, ...scored.map(item => Number(item.score) || 0)),
      hotAccounts: scored.filter(item => item.tier === "hot").length, warmAccounts: scored.filter(item => item.tier === "warm").length,
      coldAccounts: scored.filter(item => item.tier === "cold").length, signals: signalByCategory.get(name) ?? 0,
      pipeline: Math.round(pipeline.pipeline), units: pipeline.units, accountCount: scored.filter(item => item.score > 0).length };
  });
  const rankedAccounts=companies.rows.flatMap(account=>selectedCategoryNames.map(categoryName=>{
    const category=categories.find(item=>item.categoryName===categoryName)!;
    const score=categoryScores.get(`${account.id}:${categoryName}`)??{score:0,tier:"cold",rationale:"No validated evidence supports this category yet.",productName:null,lastSignalAt:null,lastResearchedAt:account.lastResearchedAt};
    return {id:account.id,name:account.name,score:score.score,tier:score.tier,categoryId:category.legacyCategoryIds[0]??null,categoryIds:category.legacyCategoryIds,categoryName:category.categoryName,
      productName:score.productName??undefined,whyNow:score.rationale??undefined,lastSignalAt:score.lastSignalAt??undefined,lastResearchedAt:score.lastResearchedAt};
  })).sort((a,b)=>tierHeat(b.tier)-tierHeat(a.tier)||b.score-a.score||a.name.localeCompare(b.name)||a.categoryName.localeCompare(b.categoryName));
  const opportunities=rankedAccounts.filter(item=>item.score>0);
  const uniqueHot = new Set(opportunities.filter(item => item.tier === "hot").map(item => item.id)).size;
  const selectedCategories = categories.filter(category => selectedCategoryNames.includes(category.categoryName));
  const selectedPipeline = selectedCategories.reduce((sum, category) => sum + category.pipeline, 0);
  const selectedUnits = selectedCategories.reduce((sum, category) => sum + category.units, 0);
  const matchedSubmissions = selectedCategoryNames.reduce((sum,name) => sum + (categoryPipeline.get(name)?.matched ?? 0), 0);
  const pricedProducts = catalog.rows.filter(row => Number(row.averageUnitPrice) > 0).length;
  const label = requestedCategoryName||(selectedCategoryNames.length===1?selectedCategoryNames[0]:"All categories");
  res.json({
    scope: { categoryIds: selectedLegacyCategoryIds, requestedCategoryIds, categoryName:requestedCategoryName||null, categoryNames:selectedCategoryNames, label },
    summary: { hotAccounts: uniqueHot, newSignals: selectedCategories.reduce((sum,category) => sum+category.signals,0),
      categoryOpportunities: opportunities.length, potentialPipeline: selectedPipeline, leadForms: matchedSubmissions, units: selectedUnits },
     categories, topAccounts: rankedAccounts.filter(item => item.tier === "hot" || item.tier === "warm").slice(0, 8),
    pipelineCoverage: { matchedSubmissions, unmatchedSubmissions, pricedProducts, totalProducts: catalog.rows.length },
  });
} catch (e) { next(e); } });

router.get("/intent/accounts", async (req, res, next) => { try {
  const u = req.user as User, { page, pageSize } = pageOf(req);
  await ensureIntentCatalogDefaults(u.tenantId);
  const sortBy = ["score", "trend", "name", "lastSignal"].includes(String(req.query.sortBy)) ? String(req.query.sortBy) : "score";
  const sortDir = String(req.query.sortDir).toLowerCase() === "asc" ? "ASC" : "DESC";
  const order = ({ score: "es.score", trend: "es.trend_delta", name: "c.name", lastSignal: "es.last_signal_at" } as Record<string, string>)[sortBy];
  const search = typeof req.query.search === "string" && req.query.search.trim() ? `%${req.query.search.trim()}%` : null;
  const country = typeof req.query.country === "string" && req.query.country.trim() ? `%${req.query.country.trim()}%` : null;
  const tier = typeof req.query.tier === "string" ? req.query.tier : null;
  const requestedTiers = tier ? tier.split(",").filter(value=>["hot","warm","cold"].includes(value)) : [];
  const source = typeof req.query.source === "string" ? req.query.source : null;
  const clientId = positiveId(String(req.query.clientId ?? "")), productId = positiveId(String(req.query.productId ?? ""));
  const categoryIds = positiveIds(req.query.categoryIds??req.query.categoryId), subcategoryIds = positiveIds(req.query.subcategoryIds??req.query.subcategoryId);
  const categoryName=typeof req.query.categoryName==="string"?req.query.categoryName.trim():"";
  if(categoryName&&!inboundCategories.includes(categoryName)){res.status(400).json({error:"Unknown category name"});return;}
  const categoryConfig=await loadInboundCategoryRules(u.tenantId);
  const audienceId = positiveId(String(req.query.audienceId ?? ""));
  const segmentId = positiveId(String(req.query.segmentId ?? ""));
  const accountId = positiveId(String(req.query.accountId ?? ""));
  const segmentCompanyIds=await segmentCompanyScope(u.tenantId,segmentId);
  if(segmentCompanyIds===undefined){res.status(400).json({error:"Unknown segment"});return;}
  let requestedProducts=await scopedProductIds(u.tenantId,productId,categoryIds,subcategoryIds);
  if(requestedProducts===undefined){res.status(400).json({error:"Unknown product scope"});return;}
  if(categoryName&&!productId&&!categoryIds.length&&!subcategoryIds.length)
    requestedProducts=await inboundCategoryProductIds(u.tenantId,categoryName,categoryConfig);
  const scopedProducts=requestedProducts??await visibleProductIds(u.tenantId);
  if(scopedProducts){
    const candidateWhere=`FROM companies c
      LEFT JOIN intent_entity_scores es ON es.tenant_id=c.tenant_id AND es.account_id=c.id
      WHERE c.tenant_id=$1 AND ($2::int IS NULL OR c.client_id=$2) AND ($3::int IS NULL OR EXISTS(SELECT 1 FROM intent_audience_companies ac WHERE ac.tenant_id=c.tenant_id AND ac.audience_id=$3 AND ac.company_id=c.id))
      AND ($4::text IS NULL OR c.name ILIKE $4 OR c.domain ILIKE $4)
      AND ($5::text IS NULL OR EXISTS(SELECT 1 FROM intent_signals s WHERE s.tenant_id=c.tenant_id AND s.account_id=c.id AND s.source=$5))
      AND ($6::text IS NULL OR EXISTS(SELECT 1 FROM contacts ct WHERE ct.tenant_id=c.tenant_id AND ct.company_id=c.id AND (ct.country ILIKE $6 OR ct.hq_country ILIKE $6 OR ct.city ILIKE $6 OR ct.state ILIKE $6)))
      AND ($7::int[] IS NULL OR c.id=ANY($7::int[]))
      AND ($8::int IS NULL OR c.id=$8)`;
    const candidateParams=[u.tenantId,clientId,audienceId,search,source,country,segmentCompanyIds,accountId];
    if(String(req.query.bounded)==="true"){
      const cursor=Number(req.query.cursor??0);
      if(!Number.isSafeInteger(cursor)||cursor<0){res.status(400).json({error:"Invalid account cursor"});return;}
      const batchSize=Math.min(pageSize,5);
      const needsEvidence=Boolean(categoryName)||(requestedTiers.length>0&&!requestedTiers.includes("cold"));
      const batch=await pool.query(`SELECT c.id,c.name,c.domain,c.industry,c.client_id AS "clientId",
        c.last_researched_at AS "lastResearchedAt",c.last_researched_at AS "lastMonitoredAt"
        ${candidateWhere} ${needsEvidence?`AND ${accountHasIntentEvidenceSql}`:""}
        ORDER BY CASE WHEN EXISTS(SELECT 1 FROM intent_inbound_submissions ib
          WHERE ib.tenant_id=c.tenant_id AND ib.account_id=c.id AND ib.classification IN ('hot','warm'))
          OR es.tier IN ('hot','warm') THEN 0 ELSE 1 END,
          c.last_researched_at DESC NULLS LAST,c.id ASC LIMIT $10 OFFSET $9`,[...candidateParams,cursor,batchSize+1]);
      const hasMore=batch.rows.length>batchSize;
      const candidates=batch.rows.slice(0,batchSize);
      const intents=await canonicalScopedAccountIntents(u.tenantId,candidates.map(row=>row.id),
        scopedProducts,requestedProducts??null,categoryIds,categoryConfig,categoryName||undefined);
      const accounts=candidates.map(row=>({...row,...intents.get(row.id)}))
        .filter(row=>(!requestedTiers.length||requestedTiers.includes(row.tier))
          &&(!categoryName||(row.productAnalysis?.topCategories??[]).some((item:any)=>item.category===categoryName&&item.score>0)
            ||(row.intentStatus?.categories??[]).some((item:any)=>item.name===categoryName&&["hot","warm"].includes(item.status)&&item.attribution!=="INHERITED_OPEN")))
        .sort((a,b)=>({hot:2,warm:1,cold:0}[b.tier as "hot"|"warm"|"cold"]??0)-({hot:2,warm:1,cold:0}[a.tier as "hot"|"warm"|"cold"]??0)
          ||Number(b.score??0)-Number(a.score??0)||a.id-b.id);
      const [tiers,monitored]=await Promise.all([
        pool.query("SELECT key,label FROM intent_tiers WHERE tenant_id=$1 AND active",[u.tenantId]),
        pool.query<{id:number}>(`SELECT DISTINCT ac.company_id AS id FROM intent_monitoring_configs mc
          JOIN intent_monitoring_audiences ma ON ma.tenant_id=mc.tenant_id AND ma.config_id=mc.id
          JOIN intent_audience_companies ac ON ac.tenant_id=ma.tenant_id AND ac.audience_id=ma.audience_id
          WHERE mc.tenant_id=$1 AND mc.enabled AND ac.company_id=ANY($2::int[])`,[u.tenantId,accounts.map(row=>row.id)]),
      ]);
      const monitoredIds=new Set(monitored.rows.map(row=>row.id));
      res.json({accounts:accounts.map(row=>({...row,isMonitored:monitoredIds.has(row.id),tierKey:row.tier,
        tierLabel:tiers.rows.find(t=>t.key===row.tier)?.label??"Cold"})),
        partial:true,scanned:candidates.length,hasMore,nextCursor:hasMore?cursor+candidates.length:null,
        total:accounts.length,totalPages:1,pageSize:batchSize,page:1});
      return;
    }
    // Qualify only evidence-bearing IDs, once. Do not re-read the catalog and
    // rescore thousands of untouched roster accounts in 100-account batches.
    const candidates=await pool.query<{id:number}>(`SELECT c.id ${candidateWhere}
      AND ${accountHasIntentEvidenceSql}`,candidateParams);
    const canonical=await canonicalScopedAccountIntents(u.tenantId,candidates.rows.map(row=>row.id),
      scopedProducts,requestedProducts,categoryIds,categoryConfig,categoryName||undefined);
    const ranking=[...canonical].map(([id,row])=>({id,score:row.score,tier:row.tier,last_signal_at:row.lastSignalAt,
      category_match:!categoryName
        ||(row.productAnalysis?.topCategories??[]).some((item:any)=>item.category===categoryName&&item.score>0)
        ||(row.intentStatus?.categories??[]).some((item:any)=>item.name===categoryName&&["hot","warm"].includes(item.status)&&item.attribution!=="INHERITED_OPEN")}));
    const rankedWhere=candidateWhere.replace("WHERE c.tenant_id=$1",`LEFT JOIN jsonb_to_recordset($9::jsonb)
      AS ci(id int,score int,tier text,last_signal_at timestamptz,category_match boolean) ON ci.id=c.id
      WHERE c.tenant_id=$1`)+`
      AND ($10::text[] IS NULL OR COALESCE(ci.tier,'cold')=ANY($10::text[]))
      AND (NOT $11::boolean OR ci.category_match=true)`;
    const rankedParams=[...candidateParams,JSON.stringify(ranking),requestedTiers.length?requestedTiers:null,Boolean(categoryName)];
    const rankedOrder=sortBy==="name"?"c.name":sortBy==="lastSignal"?"ci.last_signal_at"
      :sortBy==="trend"?"0::int":"COALESCE(ci.score,0)";
    const paged=await pool.query(`SELECT c.id,c.name,c.domain,c.industry,c.client_id AS "clientId",
      c.last_researched_at AS "lastResearchedAt",c.last_researched_at AS "lastMonitoredAt",
      COALESCE(ci.score,0) AS score,COALESCE(ci.tier,'cold') AS tier,ci.last_signal_at AS "lastSignalAt",
      count(*) OVER()::int AS total ${rankedWhere}
      ORDER BY CASE ci.tier WHEN 'hot' THEN 2 WHEN 'warm' THEN 1 ELSE 0 END DESC,
        ${rankedOrder} ${sortDir} NULLS LAST,c.id LIMIT $12 OFFSET $13`,
      [...rankedParams,pageSize,(page-1)*pageSize]);
    const total=Number(paged.rows[0]?.total??(page>1
      ?(await pool.query(`SELECT count(*)::int AS total ${rankedWhere}`,rankedParams)).rows[0]?.total:0)??0);
    const visibleIds=paged.rows.map(row=>row.id);
    const monitored=visibleIds.length?await pool.query<{id:number}>(`SELECT DISTINCT ac.company_id AS id
      FROM intent_monitoring_configs mc
      JOIN intent_monitoring_audiences ma ON ma.tenant_id=mc.tenant_id AND ma.config_id=mc.id
      JOIN intent_audience_companies ac ON ac.tenant_id=ma.tenant_id AND ac.audience_id=ma.audience_id
      WHERE mc.tenant_id=$1 AND mc.enabled AND ac.company_id=ANY($2::int[])`,[u.tenantId,visibleIds]):{rows:[]};
    const monitoredIds=new Set(monitored.rows.map(row=>row.id));
    const emptyStatus=evaluateTwoLevelIntentStatus([],new Date(),categoryConfig);
    const candidateRows=paged.rows.map(({total:_total,...row})=>({
      intentStatus:emptyStatus,...row,...canonical.get(row.id),isMonitored:monitoredIds.has(row.id),
    }));
    const tiers=await pool.query<{key:string;label:string;color:string;min_score:number}>("SELECT key,label,color,min_score FROM intent_tiers WHERE tenant_id=$1 AND active",[u.tenantId]);
    const accounts=candidateRows.map((row:any)=>{
      const tierRow=tiers.rows.find(t=>t.key===row.tier)??tiers.rows.find(t=>t.key==="cold");
      return {...row,tierKey:row.tier,tierLabel:tierRow?.label??"Cold",tierColor:tierRow?.color??"slate",trendDelta:0,previousScore:0,updatedAt:null};
    });
    res.json({accounts,page,pageSize,total,totalPages:Math.ceil(total/pageSize)}); return;
  }
  const q = await pool.query(`SELECT c.id,c.name,c.domain,c.industry,c.last_researched_at AS "lastResearchedAt",c.last_researched_at AS "lastMonitoredAt",EXISTS(SELECT 1 FROM intent_monitoring_configs mc JOIN intent_monitoring_audiences ma ON ma.tenant_id=mc.tenant_id AND ma.config_id=mc.id JOIN intent_audience_companies ac ON ac.tenant_id=ma.tenant_id AND ac.audience_id=ma.audience_id AND ac.company_id=c.id WHERE mc.tenant_id=c.tenant_id AND mc.enabled) AS "isMonitored",CASE WHEN es.last_signal_at>=NOW()-interval '1 year' THEN coalesce(es.score,0) ELSE 0 END AS score,CASE WHEN es.last_signal_at>=NOW()-interval '1 year' THEN coalesce(es.previous_score,0) ELSE 0 END AS "previousScore",CASE WHEN es.last_signal_at>=NOW()-interval '1 year' THEN coalesce(es.trend_delta,0) ELSE 0 END AS "trendDelta",CASE WHEN es.last_signal_at>=NOW()-interval '1 year' THEN es.last_signal_at END AS "lastSignalAt",es.updated_at AS "updatedAt",t.key AS "tierKey",t.label AS "tierLabel",t.color AS "tierColor", count(*) OVER()::int AS total
    FROM companies c LEFT JOIN intent_entity_scores es ON es.account_id=c.id AND es.tenant_id=c.tenant_id LEFT JOIN intent_tiers t ON t.tenant_id=c.tenant_id AND t.key=CASE WHEN es.last_signal_at>=NOW()-interval '1 year' THEN coalesce(es.tier,'cold') ELSE 'cold' END
    WHERE c.tenant_id=$1 AND ($2::text[] IS NULL OR CASE WHEN es.last_signal_at>=NOW()-interval '1 year' THEN coalesce(es.tier,'cold') ELSE 'cold' END=ANY($2::text[])) AND ($3::text IS NULL OR c.name ILIKE $3 OR c.domain ILIKE $3)
    AND ($4::text IS NULL OR EXISTS(SELECT 1 FROM intent_signals s WHERE s.tenant_id=c.tenant_id AND s.account_id=c.id AND s.source=$4))
    AND ($5::int IS NULL OR c.client_id=$5)
    AND ($6::int IS NULL OR EXISTS(SELECT 1 FROM intent_audience_companies ac WHERE ac.tenant_id=c.tenant_id AND ac.audience_id=$6 AND ac.company_id=c.id))
    AND (($7::int IS NULL AND $8::int[] IS NULL AND $9::int[] IS NULL) OR EXISTS(SELECT 1 FROM intent_signals ps JOIN intent_products ip ON ip.tenant_id=ps.tenant_id AND ip.id=ps.product_id WHERE ps.tenant_id=c.tenant_id AND ps.account_id=c.id AND (($7::int IS NOT NULL AND ps.product_id=$7) OR ($8::int[] IS NOT NULL AND ip.category_id=ANY($8::int[])) OR ($9::int[] IS NOT NULL AND ip.subcategory_id=ANY($9::int[])))))
    ORDER BY ${order} ${sortDir} NULLS LAST,c.id ASC LIMIT $10 OFFSET $11`, [u.tenantId, requestedTiers.length?requestedTiers:null, search, source, clientId, audienceId, productId, categoryIds.length?categoryIds:null, subcategoryIds.length?subcategoryIds:null, pageSize, (page - 1) * pageSize]);
  const total = Number(q.rows[0]?.total ?? 0);
  let accounts=q.rows.map(({total:_total,...row})=>row);
  const accountIds=accounts.map((row:any)=>row.id);
  const [fits,researchIntents]=await Promise.all([productFitAnalysis(u.tenantId,accountIds),accountResearchIntent(u.tenantId,accountIds)]);
  accounts=accounts.map((row:any)=>{
    const productAnalysis=fits.get(row.id);
    const researchIntent=researchIntents.get(row.id);
    return {...row,canonicalCategoryIntent:canonicalCategoryIntent(productAnalysis,researchIntent,false,70,categoryConfig),productAnalysis,researchIntent};
  });
  res.json({ accounts, page, pageSize, total, totalPages: Math.ceil(total / pageSize) });
} catch (e) { next(e); } });

const contactScopeId = z.string().regex(/^\d+$/).refine(value => positiveId(value) !== null);
const contactScopeIds = z.string().regex(/^\d+(,\d+)*$/).refine(value => value.split(",").every(id => positiveId(id) !== null));
const contactDetailScope = z.object({
  clientId: contactScopeId.optional(), audienceId: contactScopeId.optional(),
  productId: contactScopeId.optional(),
  categoryId: contactScopeId.optional(), categoryIds: contactScopeIds.optional(),
  subcategoryId: contactScopeId.optional(), subcategoryIds: contactScopeIds.optional(),
});

async function detail(req: Request, res: Response, entity: "account" | "contact") {
  const u = req.user as User, id = positiveId(String(req.params.id)); if (!id) { res.status(400).json({ error: "Invalid ID" }); return; }
  const isAccount = entity === "account", column = isAccount ? "account_id" : "contact_id";
  const section = req.query.section;
  if (section !== undefined && (typeof section !== "string" || !(isAccount ? ["identity", "evidence", "research", "analysis", "first-party-source"] : ["identity", "evidence", "recommendations", "analysis", "engagement"]).includes(section))) {
    res.status(400).json({ error: "Unknown detail section" }); return;
  }
  if (!isAccount && !contactDetailScope.safeParse(req.query).success) {
    res.status(400).json({error:"Invalid contact scope"}); return;
  }
  const identity = isAccount
     ? `c.id,c.name,c.domain,c.industry,c.last_researched_at AS "lastResearchedAt",c.last_researched_at AS "lastMonitoredAt",EXISTS(SELECT 1 FROM intent_monitoring_configs mc JOIN intent_monitoring_audiences ma ON ma.tenant_id=mc.tenant_id AND ma.config_id=mc.id JOIN intent_audience_companies ac ON ac.tenant_id=ma.tenant_id AND ac.audience_id=ma.audience_id AND ac.company_id=c.id WHERE mc.tenant_id=c.tenant_id AND mc.enabled) AS "isMonitored"`
    : `c.id,concat_ws(' ',c.first_name,c.last_name) AS name,c.title,c.email,c.phone,c.client_id AS "clientId",c.company_id AS "companyId",co.name AS "companyName",co.domain AS "companyDomain"`;
  const joins = isAccount ? "JOIN companies c ON c.id=es.account_id AND c.tenant_id=es.tenant_id" : "JOIN contacts c ON c.id=es.contact_id AND c.tenant_id=es.tenant_id LEFT JOIN companies co ON co.id=c.company_id AND co.tenant_id=c.tenant_id";
  const productId = positiveId(String(req.query.productId ?? "")), categoryIds=positiveIds(req.query.categoryIds??req.query.categoryId), subcategoryIds=positiveIds(req.query.subcategoryIds??req.query.subcategoryId);
  const categoryName=typeof req.query.categoryName==="string"?req.query.categoryName.trim():"";
  if(categoryName&&!inboundCategories.includes(categoryName)){res.status(400).json({error:"Unknown category name"});return;}
  const categoryConfig=await loadInboundCategoryRules(u.tenantId);
  const clientId=positiveId(String(req.query.clientId??"")), audienceId=positiveId(String(req.query.audienceId??""));
  if((req.query.clientId && !await hasClient(u.tenantId,clientId??undefined)) || !await hasAudienceScope(u.tenantId,audienceId??undefined,clientId??undefined)){res.status(400).json({error:"Invalid intent scope"});return;}
  const legacyDetailProducts=await scopedProductIds(u.tenantId,productId,categoryIds,subcategoryIds);
  const detailProducts=categoryName&&!productId&&!categoryIds.length&&!subcategoryIds.length
    ?await inboundCategoryProductIds(u.tenantId,categoryName,categoryConfig)
    :legacyDetailProducts;
  if(detailProducts===undefined){res.status(400).json({error:"Unknown product scope"});return;}
  const analysisScope={selectedProductIds:detailProducts??[],selectedCategoryIds:categoryIds,categoryName:categoryName||null};
  // A contact exists independently of its score row. Check its company ownership
  // before any optional panel work, including for contacts without intent yet.
  let contactIdentity: Record<string, any> | undefined;
  if (!isAccount) {
    const owned = await pool.query(`SELECT ${identity} FROM contacts c
      LEFT JOIN companies co ON co.id=c.company_id AND co.tenant_id=c.tenant_id
      WHERE c.tenant_id=$1 AND c.id=$2
      AND ($3::int IS NULL OR co.client_id=$3)
      AND ($4::int IS NULL OR EXISTS(SELECT 1 FROM intent_audience_companies ac
        WHERE ac.tenant_id=c.tenant_id AND ac.audience_id=$4 AND ac.company_id=co.id))`,
      [u.tenantId,id,clientId,audienceId]);
    contactIdentity=owned.rows[0];
    if (!contactIdentity) { res.status(404).json({error:"Contact not found"}); return; }
    if (section==="engagement") {
      const pagination=z.object({
        gtmPage:z.coerce.number().int().min(1).max(100000).default(1),
        timelinePage:z.coerce.number().int().min(1).max(100000).default(1),
      }).safeParse(req.query);
      if(!pagination.success){res.status(400).json({error:"Invalid engagement pagination"});return;}
      res.json(await readContactEngagementEvidence(u.tenantId,id,contactIdentity.clientId??null,
        pagination.data.gtmPage,pagination.data.timelinePage));return;
    }
    if (section==="identity") { res.json({...contactIdentity,analysisScope}); return; }
    if (section==="recommendations") {
      const recommendations=detailProducts ? {rows:[]} : await pool.query(`SELECT id,tier AS "tierKey",play_type AS "playType",title,summary,options,evidence,status,generation_status AS "generationStatus",generated_at AS "generatedAt"
        FROM intent_recommendations WHERE tenant_id=$1 AND contact_id=$2 ORDER BY created_at DESC`,[u.tenantId,id]);
      res.json({recommendations:recommendations.rows,
        latestRecommendation:recommendations.rows.find((item:any)=>item.status==="pending")??recommendations.rows[0]??null,analysisScope}); return;
    }
  }
  // Identity and research do not depend on score rows or supporting evidence.
  // Every panel independently enforces the same tenant/client/audience boundary.
  if(section==="identity" || section==="research" || section==="first-party-source"){
    const account=await pool.query(`SELECT c.id,c.client_id AS "clientId",c.name,c.domain,c.industry,c.last_researched_at AS "lastResearchedAt"
      FROM companies c WHERE c.tenant_id=$1 AND c.id=$2
      AND ($3::int IS NULL OR c.client_id=$3)
      AND ($4::int IS NULL OR EXISTS(SELECT 1 FROM intent_audience_companies ac
        WHERE ac.tenant_id=c.tenant_id AND ac.audience_id=$4 AND ac.company_id=c.id))`,[u.tenantId,id,clientId,audienceId]);
    if(!account.rows[0]){res.status(404).json({error:"Account not found"});return;}
    if(section==="identity"){res.json({...account.rows[0],analysisScope});return;}
    if(section==="first-party-source"){
      const input=z.object({sourceKind:z.enum(["inbound_submission","intent_evidence"]),sourceId:z.coerce.number().int().positive()}).safeParse(req.query);
      if(!input.success){res.status(400).json({error:"Invalid first-party source"});return;}
      const source=await readFirstPartySignalSource(u.tenantId,id,{kind:input.data.sourceKind,id:input.data.sourceId});
      if(!source){res.status(404).json({error:"Source response not found for this account"});return;}
      res.json(source);return;
    }
    const researchIntent=(await accountResearchIntent(u.tenantId,[id],categoryIds)).get(id);
    if(researchIntent)delete researchIntent.statusEvidence;
    const monitoringContext=await loadHpMonitoringContext(u.tenantId,account.rows[0].clientId,[id]);
    res.json({
      researchIntent:researchIntent??null,
      canonicalResearchIntent:canonicalCategoryIntent(undefined,researchIntent,detailProducts!==null,70,categoryConfig),
      parentMonitoringContext:monitoringContext.filter(context=>context.researchScope==="parent"),
      memberMonitoringContext:monitoringContext.filter(context=>context.researchScope==="member"),
    });return;
  }
  const companyAlias=isAccount?"c":"co";
  const q = await pool.query(`SELECT ${identity},es.score,es.previous_score AS "previousScore",es.trend_delta AS "trendDelta",es.last_signal_at AS "lastSignalAt",es.updated_at AS "updatedAt",es.contributions,${tierFields}
    FROM intent_entity_scores es ${joins} LEFT JOIN intent_tiers t ON t.tenant_id=es.tenant_id AND t.key=es.tier WHERE es.tenant_id=$1 AND es.${column}=$2
    AND ($3::int IS NULL OR ${companyAlias}.client_id=$3) AND ($4::int IS NULL OR EXISTS(SELECT 1 FROM intent_audience_companies ac WHERE ac.tenant_id=es.tenant_id AND ac.audience_id=$4 AND ac.company_id=${companyAlias}.id))`, [u.tenantId, id, clientId, audienceId]);
  if (!q.rows[0] && contactIdentity) {
    q.rows.push({...contactIdentity,score:0,previousScore:0,trendDelta:0,lastSignalAt:null,updatedAt:null,contributions:[],tierKey:"cold",tierLabel:"Cold",tierColor:"slate"});
  }
  if (!q.rows[0] && (detailProducts || isAccount)) {
    const canonical=await pool.query(isAccount
      ? `SELECT c.id,c.name,c.domain,c.industry,c.last_researched_at AS "lastResearchedAt" FROM companies c WHERE c.tenant_id=$1 AND c.id=$2 AND ($3::int IS NULL OR c.client_id=$3) AND ($4::int IS NULL OR EXISTS(SELECT 1 FROM intent_audience_companies ac WHERE ac.tenant_id=c.tenant_id AND ac.audience_id=$4 AND ac.company_id=c.id))`
      : `SELECT c.id,concat_ws(' ',c.first_name,c.last_name) AS name,c.title,c.email,c.phone,c.company_id AS "companyId",co.name AS "companyName",co.domain AS "companyDomain" FROM contacts c JOIN companies co ON co.id=c.company_id AND co.tenant_id=c.tenant_id WHERE c.tenant_id=$1 AND c.id=$2 AND ($3::int IS NULL OR co.client_id=$3) AND ($4::int IS NULL OR EXISTS(SELECT 1 FROM intent_audience_companies ac WHERE ac.tenant_id=c.tenant_id AND ac.audience_id=$4 AND ac.company_id=co.id))`,[u.tenantId,id,clientId,audienceId]);
    if(canonical.rows[0]) q.rows.push({...canonical.rows[0],score:0,previousScore:0,trendDelta:0,lastSignalAt:null,updatedAt:null,contributions:[],tierKey:"cold",tierLabel:"Cold",tierColor:"slate"});
  }
  if (!q.rows[0]) { res.status(404).json({ error: `${isAccount ? "Account" : "Contact"} not found` }); return; }
  if (!isAccount && section==="analysis") {
    const scoped=detailProducts ? await readProductIntentScore(u.tenantId,detailProducts,{contactId:id}) : null;
    const effective=effectiveDetailIntent(false,null,scoped,{score:q.rows[0].score,tier:q.rows[0].tierKey});
    // Keep the shared route's contact score and tier semantics unchanged.
    const tierRow=categoryName && effective.tier!==q.rows[0].tierKey
      ? (await pool.query("SELECT key,label,color FROM intent_tiers WHERE tenant_id=$1 AND key=$2",[u.tenantId,effective.tier])).rows[0] : null;
    res.json({score:effective.score,tierKey:effective.tier,
      tierLabel:tierRow?.label??(effective.tier===q.rows[0].tierKey?q.rows[0].tierLabel:effective.tier),
      tierColor:tierRow?.color??(effective.tier===q.rows[0].tierKey?q.rows[0].tierColor:"slate"),
      contributions:scoped?.contributions??q.rows[0].contributions??[],
      lastSignalAt:scoped?scoped.lastSignalAt:q.rows[0].lastSignalAt,analysisScope}); return;
  }
  const companyCondition = isAccount ? "s.account_id=$2" : "(s.contact_id=$2 OR s.account_id=(SELECT company_id FROM contacts WHERE tenant_id=$1 AND id=$2))";
  const [history, signals, recommendations, contacts, persistedEvidence, historical] = await Promise.all([
    detailProducts || section==="analysis" ? Promise.resolve({rows:[]}) : pool.query(`SELECT h.created_at AS date,h.score,t.key AS "tierKey",t.label AS "tierLabel",h.score-lag(h.score,1,h.score) OVER(ORDER BY h.created_at) AS delta FROM intent_score_history h LEFT JOIN intent_tiers t ON t.tenant_id=h.tenant_id AND t.key=h.tier WHERE h.tenant_id=$1 AND h.created_at>=NOW()-interval '${PUBLIC_RESEARCH_WINDOW_SQL}' AND h.entity_score_id=(SELECT id FROM intent_entity_scores WHERE tenant_id=$1 AND ${column}=$2) ORDER BY h.created_at`, [u.tenantId, id]),
    section==="analysis" ? Promise.resolve({rows:[]}) : pool.query(`SELECT s.id,s.product_id AS "productId",p.name AS "productName",pc.name AS "categoryName",st.key AS "typeKey",st.label AS "typeLabel",s.source,s.summary,s.strength,s.occurred_at AS "capturedAt",s.expires_at AS "expiresAt",s.vertical,s.function,s.payload AS "rawPayload" FROM intent_signals s JOIN intent_signal_types st ON st.id=s.signal_type_id AND st.tenant_id=s.tenant_id LEFT JOIN intent_products p ON p.tenant_id=s.tenant_id AND p.id=s.product_id LEFT JOIN intent_product_categories pc ON pc.tenant_id=p.tenant_id AND pc.id=p.category_id WHERE s.tenant_id=$1 AND ${companyCondition} AND ($3::int[] IS NULL OR s.product_id IS NULL OR s.product_id=ANY($3::int[])) AND s.occurred_at>=NOW()-interval '${PUBLIC_RESEARCH_WINDOW_SQL}' AND (NOT EXISTS(SELECT 1 FROM intent_evidence ie WHERE ie.tenant_id=s.tenant_id AND ie.signal_id=s.id) OR EXISTS(SELECT 1 FROM intent_evidence ie WHERE ie.tenant_id=s.tenant_id AND ie.signal_id=s.id AND ie.review_status='approved')) ORDER BY s.occurred_at DESC,s.id DESC LIMIT 100`, [u.tenantId, id, detailProducts]),
    detailProducts || section==="analysis" || (!isAccount && section==="evidence") ? Promise.resolve({rows:[]}) : pool.query(`SELECT id,tier AS "tierKey",play_type AS "playType",title,summary,options,evidence,status,generation_status AS "generationStatus",generated_at AS "generatedAt"
      FROM intent_recommendations WHERE tenant_id=$1 AND ${column}=$2 ORDER BY created_at DESC`, [u.tenantId, id]),
    isAccount && !detailProducts && section!=="analysis" ? pool.query(`SELECT c.id,concat_ws(' ',c.first_name,c.last_name) AS name,c.title,es.score,es.trend_delta AS "trendDelta",t.key AS "tierKey",t.label AS "tierLabel",t.color AS "tierColor" FROM contacts c JOIN intent_entity_scores es ON es.contact_id=c.id AND es.tenant_id=c.tenant_id LEFT JOIN intent_tiers t ON t.tenant_id=es.tenant_id AND t.key=es.tier WHERE c.tenant_id=$1 AND c.company_id=$2 ORDER BY es.score DESC`, [u.tenantId, id]) : Promise.resolve({ rows: [] }),
    pool.query(`SELECT e.id,e.product_id AS "productId",p.name AS "productName",e.evidence_kind AS "evidenceKind",e.event_type AS "eventType",e.source_url AS "sourceUrl",e.excerpt,e.provider,e.confidence,e.context,e.raw_evidence AS "rawEvidence",e.review_status AS "reviewStatus",e.reviewed_by AS "reviewedBy",e.occurred_at AS "eventDate",s.strength
      FROM intent_evidence e LEFT JOIN intent_signals s ON s.tenant_id=e.tenant_id AND s.id=e.signal_id
      LEFT JOIN intent_products p ON p.tenant_id=e.tenant_id AND p.id=e.product_id
      WHERE e.tenant_id=$1 AND ${isAccount ? "e.account_id=$2" : "(e.contact_id=$2 OR e.account_id=(SELECT company_id FROM contacts WHERE tenant_id=$1 AND id=$2))"}
      AND e.review_status<>'rejected'
      AND ($3::int[] IS NULL OR e.product_id IS NULL OR e.product_id=ANY($3::int[]))
      AND (e.evidence_kind<>'public_event' OR e.occurred_at>=NOW()-interval '${PUBLIC_RESEARCH_WINDOW_SQL}') ORDER BY e.occurred_at DESC,e.id DESC LIMIT 200`, [u.tenantId,id,detailProducts]),
    section==="analysis" ? Promise.resolve({rows:[]}) : pool.query(`SELECT count(*)::int AS count,max(s.occurred_at) AS "latestAt" FROM intent_signals s WHERE s.tenant_id=$1 AND ${companyCondition} AND s.occurred_at<NOW()-interval '${PUBLIC_RESEARCH_WINDOW_SQL}'`,[u.tenantId,id]),
  ]);
  const excludedDetailPublicIds=new Set(persistedEvidence.rows.filter((item:any)=>item.evidenceKind==="public_event"&&(!isResearchGeographyEligible({...item,raw_evidence:item.rawEvidence})||isUnattributedProcurement({
    eventType:item.eventType,searchKind:item.context?.searchKind??item.rawEvidence?.context?.searchKind,
    excerpt:item.excerpt,originalExcerpt:item.rawEvidence?.excerpt,sourceUrl:item.sourceUrl,
    companyName:isAccount?q.rows[0].name:q.rows[0].companyName,companyDomain:isAccount?q.rows[0].domain:q.rows[0].companyDomain,manuallyReviewed:item.reviewedBy!=null,
  }))).map((item:any)=>item.id));
  const currentSignals = signals.rows.filter((item:any) => item.source !== "public_event" || (isFreshPublicResearchEvidence(item.summary, item.capturedAt) && !excludedDetailPublicIds.has(Number(item.rawPayload?.evidenceId))));
  const currentPersistedEvidence = persistedEvidence.rows.filter((item:any) => item.reviewStatus!=="rejected" && (item.evidenceKind !== "public_event" || (isFreshPublicResearchEvidence(item.excerpt, item.eventDate) && isResearchGeographyEligible({...item,raw_evidence:item.rawEvidence}) && !isUnattributedProcurement({eventType:item.eventType,searchKind:item.context?.searchKind??item.rawEvidence?.context?.searchKind,excerpt:item.excerpt,originalExcerpt:item.rawEvidence?.excerpt,sourceUrl:item.sourceUrl,companyName:isAccount?q.rows[0].name:q.rows[0].companyName,companyDomain:isAccount?q.rows[0].domain:q.rows[0].companyDomain,manuallyReviewed:item.reviewedBy!=null}))));
  const selectedClient = isAccount && clientId && section!=="analysis"
    ? (await pool.query<{name:string}>("SELECT name FROM clients WHERE tenant_id=$1 AND id=$2", [u.tenantId, clientId])).rows[0]
    : null;
  const hpSolutionFit = selectedClient && isHpClientName(selectedClient.name)
    ? {
        clientName: selectedClient.name,
        recommendations: recommendHpSolutions([
          ...currentSignals.map((item:any) => ({
            id: `signal:${item.id}`,
            text: item.summary ?? "",
            source: item.source,
            occurredAt: item.capturedAt,
          })),
          ...currentPersistedEvidence.map((item:any) => ({
            id: `evidence:${item.id}`,
            text: item.excerpt ?? "",
            source: item.provenance ?? item.provider ?? item.source,
            occurredAt: item.eventDate ?? item.capturedAt,
          })),
        ]),
        sources: [
          "https://www.hp.com/in-en/business-solutions/services-solutions.html",
          "https://www.hp.com/in-en/business-solutions/business-computers.html",
          "https://www.hp.com/in-en/business-solutions/commercial-printers.html",
          "https://www.hp.com/in-en/poly.html",
        ],
      }
    : undefined;
  const existingBehavior = detailProducts ? null : (q.rows[0].contributions ?? []).find((item: any) => item.key === "existing_behavior") ?? null;
  if(section==="evidence"){
    res.json({
      scoreHistory:history.rows,signals:currentSignals,recentSignals:currentSignals,
      recommendations:recommendations.rows,contacts:contacts.rows,
      latestRecommendation:recommendations.rows.find((item:any)=>item.status==="pending")??recommendations.rows[0]??null,
      excludedHistoricalSignals:historical.rows[0]??{count:0,latestAt:null},
      hpSolutionFit,analysisScope,
      evidence:{
        public:currentPersistedEvidence.filter((item:any)=>item.evidenceKind==="public_event"),
        uploaded:currentPersistedEvidence.filter((item:any)=>["uploaded_intent","event_feedback","event_questionnaire","lead_form","product_buy_intent","consulting"].includes(item.evidenceKind)),
        companyKaboom:isAccount ? currentSignals.filter((item:any)=>String(item.source).toLowerCase().includes("kaboom")) : [],
        contactKaboom:!isAccount && existingBehavior ? [{summary:existingBehavior.reason,capturedAt:q.rows[0].updatedAt,source:"Kaboom",contribution:existingBehavior.points,details:existingBehavior.evidence}] : [],
      },
      ...(!isAccount ? {existingBehavior,activityEvidence:existingBehavior ? [{summary:existingBehavior.reason,capturedAt:q.rows[0].updatedAt,source:"Kaboom",details:existingBehavior.evidence}] : []} : {}),
    });return;
  }
  const scoped = detailProducts ? await readProductIntentScore(u.tenantId, detailProducts, isAccount ? { accountId: id } : { contactId: id }) : null;
    const [accountProductAnalysis,accountResearchAnalysis]=isAccount?await Promise.all([
      productFitAnalysis(u.tenantId,[id],detailProducts,true,categoryConfig).then(result=>result.get(id)),
      section==="analysis"?Promise.resolve(undefined):accountResearchIntent(u.tenantId,[id],categoryIds).then(result=>result.get(id)),
    ]):[undefined,undefined];
  const accountIntentStatus=isAccount?applyFirstPartyStatus(evaluateTwoLevelIntentStatus(currentPersistedEvidence.map((row:any)=>({id:row.id,evidenceKind:row.evidenceKind,eventType:row.eventType,excerpt:row.excerpt??"",sourceUrl:row.sourceUrl??null,occurredAt:row.eventDate,confidence:row.confidence??0,reviewStatus:row.reviewStatus,context:{...(row.context??{}),productName:row.productName}})),new Date(),categoryConfig),accountProductAnalysis):undefined;
  if(accountResearchAnalysis)delete accountResearchAnalysis.statusEvidence;
  const categoryIntent=isAccount?canonicalCategoryIntent(accountProductAnalysis,accountResearchAnalysis,detailProducts!==null,70,categoryConfig):null;
   const effective=categoryName&&isAccount
     ?selectedCategoryIntent(categoryName,accountProductAnalysis,accountIntentStatus)
     :effectiveDetailIntent(isAccount,categoryIntent,scoped,{score:q.rows[0].score,tier:q.rows[0].tierKey});
   const effectiveScore=isAccount?(categoryName?effective.score:accountIntentStatus?.accountStatus==="hot"?100:accountIntentStatus?.accountStatus==="warm"?50:0):effective.score;
   const effectiveTier=isAccount?(categoryName?effective.tier:accountIntentStatus?.accountStatus??effective.tier):effective.tier;
   const effectiveTierRow=(section==="analysis"||categoryIntent||categoryName)&&effectiveTier!==q.rows[0].tierKey
    ? (await pool.query<{key:string;label:string;color:string}>("SELECT key,label,color FROM intent_tiers WHERE tenant_id=$1 AND key=$2",[u.tenantId,effectiveTier])).rows[0]
    : null;
  if(section==="analysis"){
    res.json({
      score:effectiveScore,tierKey:effectiveTier,
      tierLabel:effectiveTierRow?.label??(effectiveTier===q.rows[0].tierKey?q.rows[0].tierLabel:effectiveTier),
      tierColor:effectiveTierRow?.color??(effectiveTier===q.rows[0].tierKey?q.rows[0].tierColor:"slate"),
      contributions:scoped?.contributions??q.rows[0].contributions??[],
      lastSignalAt:scoped?scoped.lastSignalAt:q.rows[0].lastSignalAt,
      canonicalCategoryIntent:categoryIntent,productAnalysis:accountProductAnalysis,
      intentStatus:accountIntentStatus,analysisScope,
    });return;
  }
  res.json({
    ...q.rows[0],
    score:effectiveScore,
    tierKey:effectiveTier,
    tierLabel:effectiveTierRow?.label??(effectiveTier===q.rows[0].tierKey?q.rows[0].tierLabel:effectiveTier),
    tierColor:effectiveTierRow?.color??(effectiveTier===q.rows[0].tierKey?q.rows[0].tierColor:"slate"),
    ...(scoped ? { contributions: scoped.contributions, lastSignalAt: scoped.lastSignalAt, productId } : {}),
    contributions: scoped?.contributions ?? q.rows[0].contributions ?? [],
    scoreHistory: history.rows,
    signals: currentSignals,
    recentSignals: currentSignals,
    recommendations: recommendations.rows,
    latestRecommendation: recommendations.rows.find((item: any) => item.status === "pending") ?? recommendations.rows[0] ?? null,
    contacts: contacts.rows,
    excludedHistoricalSignals: historical.rows[0]??{count:0,latestAt:null},
    ...(isAccount?{canonicalCategoryIntent:categoryIntent,productAnalysis:accountProductAnalysis,researchIntent:accountResearchAnalysis,intentStatus:accountIntentStatus,hpSolutionFit,analysisScope:{selectedProductIds:detailProducts??[],selectedCategoryIds:categoryIds,categoryName:categoryName||null}}:{}),
    evidence: {
      public: currentPersistedEvidence.filter((item:any)=>item.evidenceKind==="public_event"),
      uploaded: currentPersistedEvidence.filter((item:any)=>["uploaded_intent","event_feedback","event_questionnaire","lead_form","product_buy_intent","consulting"].includes(item.evidenceKind)),
      companyKaboom: isAccount ? currentSignals.filter((item:any)=>String(item.source).toLowerCase().includes("kaboom")) : [],
      contactKaboom: isAccount ? [] : (existingBehavior ? [{ summary: existingBehavior.reason, capturedAt: q.rows[0].updatedAt, source: "Kaboom", contribution: existingBehavior.points, details: existingBehavior.evidence }] : []),
    },
    ...(isAccount ? {} : {
      existingBehavior,
      activityEvidence: existingBehavior ? [{
        summary: existingBehavior.reason,
        capturedAt: q.rows[0].updatedAt,
        source: "Kaboom",
        details: existingBehavior.evidence,
      }] : [],
    }),
  });
}
router.get("/intent/accounts/:id/score-breakdown", async (req,res,next)=>{
  try {
    const id=positiveId(req.params.id);
    if(!id){res.status(400).json({error:"Invalid account"});return;}
    const result=await readAccountAdditiveScore((req.user as User).tenantId,id);
    if(!result){res.status(404).json({error:"Account not found"});return;}
    res.json(result);
  } catch(error){next(error);}
});
router.get("/intent/contacts/:id/score-breakdown", async (req,res,next)=>{
  try {
    const id=positiveId(req.params.id);
    if(!id){res.status(400).json({error:"Invalid contact"});return;}
    const scope=contactDetailScope.safeParse(req.query);
    if(!scope.success){res.status(400).json({error:"Invalid contact scope"});return;}
    const tenantId=(req.user as User).tenantId;
    const clientId=scope.data.clientId ? Number(scope.data.clientId) : null;
    const audienceId=scope.data.audienceId ? Number(scope.data.audienceId) : null;
    if(!await hasClient(tenantId,clientId??undefined) || !await hasAudienceScope(tenantId,audienceId??undefined,clientId??undefined)){
      res.status(400).json({error:"Invalid intent scope"});return;
    }
    const owned=await pool.query(`SELECT c.id FROM contacts c
      LEFT JOIN companies co ON co.id=c.company_id AND co.tenant_id=c.tenant_id
      WHERE c.tenant_id=$1 AND c.id=$2 AND ($3::int IS NULL OR co.client_id=$3)
      AND ($4::int IS NULL OR EXISTS(SELECT 1 FROM intent_audience_companies ac
        WHERE ac.tenant_id=c.tenant_id AND ac.audience_id=$4 AND ac.company_id=co.id))`,[tenantId,id,clientId,audienceId]);
    if(!owned.rows[0]){res.status(404).json({error:"Contact not found"});return;}
    const result=await readContactAdditiveScore(tenantId,id);
    if(!result){res.status(404).json({error:"Contact not found"});return;}
    res.json(result);
  } catch(error){next(error);}
});
router.get("/intent/accounts/:id", (req, res, next) => detail(req, res, "account").catch(next));
router.get("/intent/contacts/:id", (req, res, next) => detail(req, res, "contact").catch(next));

router.get("/intent/recommendations", async (req, res, next) => { try {
  const u = req.user as User, { page, pageSize } = pageOf(req), status = typeof req.query.status === "string" ? req.query.status : null, tier = typeof req.query.tier === "string" ? req.query.tier : null;
  const clientId=positiveId(String(req.query.clientId??"")),audienceId=positiveId(String(req.query.audienceId??"")),productId=positiveId(String(req.query.productId??"")),categoryIds=positiveIds(req.query.categoryIds??req.query.categoryId),subcategoryIds=positiveIds(req.query.subcategoryIds??req.query.subcategoryId);
  if((req.query.clientId && !await hasClient(u.tenantId,clientId??undefined)) || !await hasAudienceScope(u.tenantId,audienceId??undefined,clientId??undefined)){res.status(400).json({error:"Invalid intent scope"});return;}
  const products=await scopedProductIds(u.tenantId,productId,categoryIds,subcategoryIds);
  if(products===undefined){res.status(400).json({error:"Unknown product scope"});return;}
  if(products){res.json({recommendations:[],page,pageSize,total:0,totalPages:0});return;}
  if(clientId||audienceId){
    const q=await pool.query(`SELECT r.id,CASE WHEN r.account_id IS NOT NULL THEN 'account' ELSE 'contact' END AS "targetType",coalesce(r.account_id,r.contact_id) AS "targetId",coalesce(a.name,concat_ws(' ',c.first_name,c.last_name)) AS "targetIdentity",t.key AS "tierKey",r.play_type AS "playType",r.title,r.summary,r.options,r.evidence,r.status,r.generation_status AS "generationStatus",r.generated_at AS "generatedAt",r.note AS outcome,count(*) OVER()::int total
      FROM intent_recommendations r LEFT JOIN companies a ON a.id=r.account_id AND a.tenant_id=r.tenant_id LEFT JOIN contacts c ON c.id=r.contact_id AND c.tenant_id=r.tenant_id LEFT JOIN companies co ON co.id=c.company_id AND co.tenant_id=c.tenant_id LEFT JOIN intent_tiers t ON t.tenant_id=r.tenant_id AND t.key=r.tier
      WHERE r.tenant_id=$1 AND ($2::text IS NULL OR r.status=$2) AND ($3::text IS NULL OR t.key=$3 OR r.tier=$3)
      AND ($4::int IS NULL OR coalesce(a.client_id,co.client_id)=$4)
      AND ($5::int IS NULL OR EXISTS(SELECT 1 FROM intent_audience_companies ac WHERE ac.tenant_id=r.tenant_id AND ac.audience_id=$5 AND ac.company_id=coalesce(a.id,co.id)))
      ORDER BY r.created_at DESC LIMIT $6 OFFSET $7`,[u.tenantId,status,tier,clientId,audienceId,pageSize,(page-1)*pageSize]);
    const total=Number(q.rows[0]?.total??0);res.json({recommendations:q.rows.map(({total:_total,...row})=>row),page,pageSize,total,totalPages:Math.ceil(total/pageSize)});return;
  }
  const q = await pool.query(`SELECT r.id,CASE WHEN r.account_id IS NOT NULL THEN 'account' ELSE 'contact' END AS "targetType",coalesce(r.account_id,r.contact_id) AS "targetId",coalesce(a.name,concat_ws(' ',c.first_name,c.last_name)) AS "targetIdentity",t.key AS "tierKey",r.play_type AS "playType",r.title,r.summary,r.options,r.evidence,r.status,r.generation_status AS "generationStatus",r.generated_at AS "generatedAt",r.note AS outcome,count(*) OVER()::int total FROM intent_recommendations r LEFT JOIN companies a ON a.id=r.account_id AND a.tenant_id=r.tenant_id LEFT JOIN contacts c ON c.id=r.contact_id AND c.tenant_id=r.tenant_id LEFT JOIN intent_tiers t ON t.tenant_id=r.tenant_id AND t.key=r.tier WHERE r.tenant_id=$1 AND ($2::text IS NULL OR r.status=$2) AND ($3::text IS NULL OR t.key=$3 OR r.tier=$3) ORDER BY r.created_at DESC LIMIT $4 OFFSET $5`, [u.tenantId, status, tier, pageSize, (page - 1) * pageSize]);
  const total = Number(q.rows[0]?.total ?? 0); res.json({ recommendations: q.rows.map(({ total: _total, ...row }) => row), page, pageSize, total, totalPages: Math.ceil(total / pageSize) });
} catch (e) { next(e); } });

router.patch("/intent/recommendations/:id", async (req, res, next) => { const u = req.user as User, id = positiveId(String(req.params.id)), p = z.object({ status: z.enum(["actioned", "dismissed", "pending"]), note: z.string().max(2000).optional() }).safeParse(req.body); if (!id || !p.success) { res.status(400).json({ error: "Invalid recommendation update" }); return; } const client = await pool.connect(); try { await client.query("BEGIN"); const q = await client.query(`UPDATE intent_recommendations SET status=$1,note=coalesce($2,note),resolved_at=CASE WHEN $1='pending' THEN NULL ELSE NOW() END,updated_at=NOW() WHERE tenant_id=$3 AND id=$4
  RETURNING id,CASE WHEN account_id IS NOT NULL THEN 'account' ELSE 'contact' END AS "targetType",coalesce(account_id,contact_id) AS "targetId",tier AS "tierKey",play_type AS "playType",title,summary,options,evidence,status,generation_status AS "generationStatus",generated_at AS "generatedAt",resolved_at AS "resolvedAt",note`, [p.data.status, p.data.note ?? null, u.tenantId, id]); if (!q.rows[0]) { await client.query("ROLLBACK"); res.status(404).json({ error: "Recommendation not found" }); return; } await client.query("INSERT INTO intent_recommendation_outcomes(tenant_id,recommendation_id,status,note,actor_id) VALUES($1,$2,$3,$4,$5)", [u.tenantId, id, p.data.status, p.data.note ?? null, u.id]); await client.query("COMMIT"); res.json({ recommendation: q.rows[0] }); } catch (e) { await client.query("ROLLBACK"); next(e); } finally { client.release(); } });

router.get("/intent/config", async (req, res, next) => {
  try {
    const u = admin(req, res);
    if (!u) return;
    await ensureIntentDefaults(u.tenantId);
    const [types, tiers, questionnaireDimensions] = await Promise.all([
      pool.query(`SELECT id,key,label,category,max_points AS weight,half_life_days AS "halfLifeDays",active FROM intent_signal_types WHERE tenant_id=$1 AND category<>'questionnaire' ORDER BY key`, [u.tenantId]),
      pool.query(`SELECT id,key,label,min_score AS "minScore",color,sort_order AS "sortOrder",active FROM intent_tiers WHERE tenant_id=$1 ORDER BY sort_order`, [u.tenantId]),
      readQuestionnaireSettings(u.tenantId),
    ]);
    res.json({
      signalTypes: types.rows,
      tiers: tiers.rows,
      questionnaireDimensions,
      questionnaireDefaults: QUESTIONNAIRE_DIMENSION_DEFAULTS,
      productIntentScoreMaximum: 100,
    });
  } catch (e) {
    next(e);
  }
});
router.put("/intent/config", async (req, res, next) => {
  const u = admin(req, res);
  if (!u) return;
  const p = z.object({
    signalTypes: z.array(z.object({ id: z.number().int(), key: z.string(), label: z.string(), category: z.string(), weight: z.number().int().min(0).max(100), halfLifeDays: z.number().int().min(1), active: z.boolean() })),
    tiers: z.array(z.object({ id: z.number().int(), key: z.string(), label: z.string(), minScore: z.number().int().min(0).max(100), color: z.string().min(1), sortOrder: z.number().int(), active: z.boolean() })),
    questionnaireDimensions: z.array(questionnaireDimensionSchema),
  }).safeParse(req.body);
  const dimensions = p.success ? p.data.questionnaireDimensions : [];
  const dimensionsValid = dimensions.length === questionnaireKeys.size
    && new Set(dimensions.map((dimension) => dimension.key)).size === questionnaireKeys.size
    && dimensions.every((dimension) => questionnaireKeys.has(dimension.key)
      && new Set(dimension.rules.map((rule) => rule.id)).size === dimension.rules.length);
  if (!p.success || !dimensionsValid || p.data.tiers.length !== 3 || p.data.tiers.filter(x => x.active).length !== 3 || p.data.tiers.some((x, i) => x.sortOrder !== i) || p.data.tiers[0]?.minScore !== 0 || new Set(p.data.tiers.map(x => x.key)).size !== 3 || new Set(p.data.tiers.map(x => x.minScore)).size !== 3) {
    res.status(400).json({ error: "Configuration must include bounded, unique questionnaire rules and exactly three active ordered tiers beginning at 0" });
    return;
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await ensureQuestionnaireDefaults(u.tenantId, client);
    const [knownTypes, knownTiers, knownDimensions, currentTypes, currentTiers] = await Promise.all([
      client.query("SELECT id FROM intent_signal_types WHERE tenant_id=$1 AND category<>'questionnaire'", [u.tenantId]),
      client.query("SELECT id FROM intent_tiers WHERE tenant_id=$1", [u.tenantId]),
      client.query("SELECT id,dimension FROM intent_questionnaire_settings WHERE tenant_id=$1", [u.tenantId]),
      client.query(`SELECT id,max_points AS weight,half_life_days AS "halfLifeDays",active FROM intent_signal_types WHERE tenant_id=$1 AND category<>'questionnaire' ORDER BY id`, [u.tenantId]),
      client.query(`SELECT id,label,min_score AS "minScore",color,sort_order AS "sortOrder",active FROM intent_tiers WHERE tenant_id=$1 ORDER BY id`, [u.tenantId]),
    ]);
    const typeIds = new Set(knownTypes.rows.map((row: any) => row.id));
    const tierIds = new Set(knownTiers.rows.map((row: any) => row.id));
    const dimensionIds = new Map(knownDimensions.rows.map((row: any) => [row.dimension, row.id]));
    if (p.data.signalTypes.some(x => !typeIds.has(x.id))
      || p.data.tiers.some(x => !tierIds.has(x.id))
      || dimensions.some(x => dimensionIds.get(x.key) !== x.id)) {
      await client.query("ROLLBACK");
      res.status(400).json({ error: "Unknown or cross-tenant configuration ID" });
      return;
    }
    const genericConfigChanged = p.data.signalTypes.some((signal) => {
      const current = currentTypes.rows.find((row: any) => row.id === signal.id);
      return !current || current.weight !== signal.weight || current.halfLifeDays !== signal.halfLifeDays || current.active !== signal.active;
    }) || p.data.tiers.some((tier) => {
      const current = currentTiers.rows.find((row: any) => row.id === tier.id);
      return !current || current.label !== tier.label || current.minScore !== tier.minScore || current.color !== tier.color || current.sortOrder !== tier.sortOrder || current.active !== tier.active;
    });
    for (const signal of p.data.signalTypes) {
      await client.query("UPDATE intent_signal_types SET max_points=$1,half_life_days=$2,active=$3,updated_at=NOW() WHERE tenant_id=$4 AND id=$5", [signal.weight, signal.halfLifeDays, signal.active, u.tenantId, signal.id]);
    }
    for (const tier of p.data.tiers) {
      await client.query("UPDATE intent_tiers SET label=$1,min_score=$2,color=$3,sort_order=$4,active=$5 WHERE tenant_id=$6 AND id=$7", [tier.label, tier.minScore, tier.color, tier.sortOrder, tier.active, u.tenantId, tier.id]);
    }
    for (const dimension of dimensions) {
      await client.query(
        "UPDATE intent_questionnaire_settings SET label=$1,max_points=$2,rules=$3,updated_at=NOW() WHERE tenant_id=$4 AND id=$5 AND dimension=$6",
        [dimension.label, dimension.maxPoints, JSON.stringify(dimension.rules), u.tenantId, dimension.id, dimension.key],
      );
    }
    const rescoredSignals = await rescoreQuestionnaireEvidence(u.tenantId, dimensions, client);
    await client.query("COMMIT");
    if (genericConfigChanged) {
      const entities = await pool.query<{ account_id: number | null; contact_id: number | null }>("SELECT account_id,contact_id FROM intent_entity_scores WHERE tenant_id=$1 ORDER BY coalesce(account_id,contact_id) LIMIT 1000", [u.tenantId]);
      for (const entity of entities.rows) await enqueueIntent(u.tenantId, { accountId: entity.account_id, contactId: entity.contact_id }, "config");
    }
    res.json({
      signalTypes: p.data.signalTypes,
      tiers: p.data.tiers,
      questionnaireDimensions: dimensions,
      questionnaireDefaults: QUESTIONNAIRE_DIMENSION_DEFAULTS,
      productIntentScoreMaximum: 100,
      rescoredSignals,
    });
  } catch (e) {
    await client.query("ROLLBACK");
    next(e);
  } finally {
    client.release();
  }
});

router.get("/intent/imports", async (req, res, next) => { try { const u = req.user as User, { page, pageSize } = pageOf(req); const [items, count] = await Promise.all([pool.query("SELECT id,client_id AS \"clientId\",product_id AS \"productId\",audience_id AS \"audienceId\",kind,idempotency_key AS \"idempotencyKey\",file_name AS \"fileName\",status,total_rows AS \"totalRows\",inserted_rows AS \"insertedRows\",skipped_rows AS \"skippedRows\",failed_rows AS \"failedRows\",unmatched_rows AS \"unmatchedRows\",summary,errors,created_at AS \"createdAt\",completed_at AS \"completedAt\" FROM intent_import_runs WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT $2 OFFSET $3", [u.tenantId, pageSize, (page - 1) * pageSize]), pool.query<{ count: string }>("SELECT count(*) FROM intent_import_runs WHERE tenant_id=$1", [u.tenantId])]); const total = Number(count.rows[0].count); res.json({ imports: items.rows, page, pageSize, total, totalPages: Math.ceil(total / pageSize) }); } catch (e) { next(e); } });
router.post("/intent/imports/google-sheet/read", async (req,res,next) => { try {
  const u=admin(req,res);if(!u)return;
  const parsed=z.object({spreadsheet:z.string().trim().min(20).max(1000),range:z.string().trim().max(500).optional()}).safeParse(req.body);
  if(!parsed.success){res.status(400).json({error:"Enter a valid Google Sheets URL and optional A1 range"});return;}
  res.json(await readIntentGoogleSheet(parsed.data.spreadsheet,parsed.data.range));
} catch(e){next(e);} });
router.post("/intent/imports/preview", async (req, res, next) => { try { const u = req.user as User, p = importSchema.safeParse(req.body); if (!p.success || (productScopedImport(p.data.kind)&&!p.data.productId) || !(await hasClient(u.tenantId, p.data.clientId)) || !(await hasTenantRow(u.tenantId, "intent_products", p.data.productId)) || !(await hasAudienceScope(u.tenantId,p.data.audienceId,p.data.clientId))) { res.status(400).json({ error: "Invalid import scope" }); return; } res.json(importResponse(await previewRows(u.tenantId, p.data.kind, p.data.rows, p.data.mapping, p.data.clientId, p.data.audienceId), p.data.mapping)); } catch (e) { next(e); } });

router.post("/intent/imports/commit", async (req, res, next) => {
  const u = req.user as User;
  const p = importSchema.extend({ idempotencyKey: z.string().min(8).max(200), fileName: z.string().max(255).optional() }).safeParse(req.body);
  if (!p.success || (productScopedImport(p.data.kind)&&!p.data.productId) || !(await hasClient(u.tenantId, p.data.clientId)) || !(await hasTenantRow(u.tenantId, "intent_products", p.data.productId)) || !(await hasAudienceScope(u.tenantId,p.data.audienceId,p.data.clientId))) { res.status(400).json({ error: "Invalid import scope" }); return; }
  try {
    await ensureIntentDefaults(u.tenantId);
    const preview = await previewRows(u.tenantId, p.data.kind, p.data.rows, p.data.mapping, p.data.clientId, p.data.audienceId);
    const hash = createHash("sha256").update(JSON.stringify({ kind: p.data.kind, clientId: p.data.clientId ?? null, productId: p.data.productId ?? null, audienceId: p.data.audienceId ?? null, rows: p.data.rows, mapping: p.data.mapping })).digest("hex");
    const client = await pool.connect(), affected = new Map<string, { accountId?: number | null; contactId?: number | null }>();
    let inserted = 0, skipped = 0, unmatched = 0;
    const errors: Array<{ rowNumber: number; error: string }> = preview.filter(r => r.status === "error").map(r => ({ rowNumber: r.rowNumber, error: r.errors.join("; ") }));
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`intent-import:${u.tenantId}`]);
      const existing = await client.query<{ summary: object }>(
        `SELECT summary FROM intent_import_runs
         WHERE tenant_id=$1
           AND (idempotency_key=$2 OR (
             kind=$3
             AND client_id IS NOT DISTINCT FROM $4
             AND product_id IS NOT DISTINCT FROM $5
             AND audience_id IS NOT DISTINCT FROM $6
             AND file_hash=$7
           ))
         LIMIT 1`,
          [u.tenantId, p.data.idempotencyKey, p.data.kind, p.data.clientId ?? null, p.data.productId ?? null, p.data.audienceId ?? null, hash],
      );
      if (existing.rows[0]) {
        await client.query("COMMIT");
        res.json({ ...existing.rows[0].summary, duplicate: true });
        return;
      }
      const importRun = await client.query<{ id: number }>(
        `INSERT INTO intent_import_runs(tenant_id,client_id,product_id,audience_id,kind,idempotency_key,file_name,file_hash,status,total_rows,created_by)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,'processing',$9,$10) RETURNING id`,
        [u.tenantId, p.data.clientId ?? null, p.data.productId ?? null, p.data.audienceId ?? null, p.data.kind, p.data.idempotencyKey, p.data.fileName ?? null, hash, p.data.rows.length, u.id],
      );
      const answerImport = ["product_buy_intent", "event_feedback", "event_questionnaire", "lead_form"].includes(p.data.kind);
      const answerTypeKeys = UPLOADED_ANSWER_SIGNAL_TYPES.map(([key]) => key);
      const signalTypes = await client.query<{ id: number; key: string }>(
        "SELECT id,key FROM intent_signal_types WHERE tenant_id=$1 AND key=ANY($2::text[])",
        [u.tenantId, [...new Set([signalTypeFor(p.data.kind), ...answerTypeKeys])]],
      );
      const typeByKey = new Map(signalTypes.rows.map(type => [type.key, type.id]));
      const hpClient = p.data.clientId ? await isHpClient(u.tenantId, p.data.clientId, client) : false;
      if (!typeByKey.has(signalTypeFor(p.data.kind)) || (answerImport && answerTypeKeys.some(key => !typeByKey.has(key)))) throw new Error("Intent signal type is unavailable");
      for (const item of preview) {
        if (item.status === "error") { skipped++; continue; }
        const n = item.normalized;
        let accountId = item.match.accountInScope ? item.match.accountId as number | null : null;
        let contactId = item.match.contactInScope ? item.match.contactId as number | null : null;
        if (hpClient && p.data.clientId) {
          if (!accountId && n.accountName) {
            const match = await resolveHpAccount(client, u.tenantId, p.data.clientId, null, n.accountName, true);
            if (!match.id) { errors.push({ rowNumber: item.rowNumber, error: match.reason || "HP identity review required" }); skipped++; continue; }
            accountId = match.id;
          }
          if (accountId) {
            const owned = await client.query("SELECT name FROM companies WHERE tenant_id=$1 AND client_id=$2 AND id=$3", [u.tenantId, p.data.clientId, accountId]);
            if (!owned.rows[0]) { errors.push({ rowNumber: item.rowNumber, error: "Account is outside the selected HP client" }); skipped++; continue; }
            await ensureHpProfile(client, u.tenantId, p.data.clientId, accountId, owned.rows[0].name, false, "HP data import");
          }
        }
        if (!accountId && p.data.kind === "account_list") {
          const lockKey = `${u.tenantId}:${n.domain ?? ""}:${n.accountName.toLowerCase()}`;
          await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [lockKey]);
          const found = await client.query<{ id: number }>("SELECT id FROM companies WHERE tenant_id=$1 AND (($2<>'' AND lower(btrim(domain))=$2) OR ($3<>'' AND lower(btrim(name))=$3)) LIMIT 2", [u.tenantId, n.domain ?? "", n.accountName.toLowerCase()]);
          if (found.rows.length === 1) accountId = found.rows[0].id;
          else if (found.rows.length === 0) {
            const created = await client.query<{ id: number }>("INSERT INTO companies(tenant_id,client_id,name,domain,industry) VALUES($1,$2,$3,$4,$5) RETURNING id", [u.tenantId, p.data.clientId, n.accountName, n.domain, n.industry || null]);
            accountId = created.rows[0].id;
          } else { errors.push({ rowNumber: item.rowNumber, error: "Ambiguous account match" }); skipped++; continue; }
        }
        if (!accountId && responseImport(p.data.kind) && p.data.clientId && n.accountName) {
          const normalizedName = n.accountName.trim().toLowerCase();
          const responseEmailDomain = n.email?.split("@")[1]?.trim().toLowerCase() ?? "";
          const lockKey = `${u.tenantId}:${p.data.clientId}:${n.domain ?? ""}:${normalizedName}`;
          await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [lockKey]);
          const found = await client.query<{ id: number }>(
            `SELECT id FROM companies
              WHERE tenant_id=$1 AND client_id=$2
                AND ($6::int IS NULL OR EXISTS(
                  SELECT 1 FROM intent_audience_companies ac
                  WHERE ac.tenant_id=companies.tenant_id
                    AND ac.audience_id=$6
                    AND ac.company_id=companies.id
                ))
                AND (
                  ($3<>'' AND lower(btrim(domain))=$3)
                  OR lower(btrim(name))=$4
                  OR ($5<>'' AND EXISTS(
                    SELECT 1 FROM contacts ct
                    WHERE ct.tenant_id=companies.tenant_id
                      AND ct.company_id=companies.id
                      AND lower(split_part(btrim(ct.email),'@',2))=$5
                  ))
                )
              LIMIT 2`,
            [u.tenantId, p.data.clientId, n.domain ?? "", normalizedName, responseEmailDomain, p.data.audienceId ?? null],
          );
          if (found.rows.length === 1) accountId = found.rows[0].id;
          else if (found.rows.length === 0) {
            const created = await client.query<{ id: number }>(
              "INSERT INTO companies(tenant_id,client_id,name,domain,industry) VALUES($1,$2,$3,$4,$5) RETURNING id",
              [u.tenantId, p.data.clientId, n.accountName, n.domain, n.industry || null],
            );
            accountId = created.rows[0].id;
          } else {
            errors.push({ rowNumber: item.rowNumber, error: "Ambiguous account match inside the selected client" });
            skipped++;
            continue;
          }
          if (p.data.audienceId) {
            await client.query(
              "INSERT INTO intent_audience_companies(tenant_id,audience_id,company_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
              [u.tenantId, p.data.audienceId, accountId],
            );
          }
        }
        if (!contactId && responseImport(p.data.kind) && n.email) {
          await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`intent-response:${u.tenantId}:${n.email}`]);
          const existingContact = await client.query<{ id: number; company_id: number | null }>(
            `SELECT ct.id,ct.company_id FROM contacts ct
              LEFT JOIN companies c ON c.tenant_id=ct.tenant_id AND c.id=ct.company_id
             WHERE ct.tenant_id=$1 AND lower(btrim(ct.email))=$2
               AND ($3::int IS NULL OR (ct.client_id=$3 AND c.client_id=$3))
               AND ($4::int IS NULL OR ct.company_id=$4)
               AND ($5::int IS NULL OR EXISTS(
                 SELECT 1 FROM intent_audience_companies ac
                 WHERE ac.tenant_id=ct.tenant_id AND ac.audience_id=$5 AND ac.company_id=ct.company_id
               ))
             ORDER BY ct.id LIMIT 1`,
            [u.tenantId, n.email, p.data.clientId ?? null, accountId, p.data.audienceId ?? null],
          );
          if (existingContact.rows[0]) {
            contactId = existingContact.rows[0].id;
            accountId = accountId ?? existingContact.rows[0].company_id;
          } else {
            const names = n.contactName.trim().split(/\s+/);
            const firstName = n.firstName || names[0] || null;
            const lastName = n.lastName || (names.length > 1 ? names.slice(1).join(" ") : null);
            const createdContact = await client.query<{ id: number }>(
              `INSERT INTO contacts(tenant_id,client_id,company_id,first_name,last_name,email,phone,title,function,source)
               VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
              [u.tenantId, p.data.clientId ?? null, accountId, firstName, lastName, n.email, n.phone || null, n.title || null, n.function || null, p.data.kind],
            );
            contactId = createdContact.rows[0].id;
          }
        }
        if (!accountId && !contactId && p.data.kind !== "consulting") { unmatched++; errors.push({ rowNumber: item.rowNumber, error: "No unambiguous canonical match" }); continue; }
        if (accountId && p.data.kind !== "account_list" && !await hasCompanyScope(u.tenantId,accountId,p.data.clientId,p.data.audienceId)) {
          skipped++; errors.push({rowNumber:item.rowNumber,error:"Matched company is outside the selected client or audience"}); continue;
        }
        if (contactId && p.data.kind !== "account_list" && !await hasContactScope(u.tenantId, contactId, p.data.clientId, accountId, p.data.audienceId)) {
          skipped++; errors.push({rowNumber:item.rowNumber,error:"Matched contact is outside the selected client or account"}); continue;
        }
        if (p.data.clientId && accountId) {
          const owner=await client.query<{client_id:number}>("SELECT client_id FROM companies WHERE tenant_id=$1 AND id=$2 FOR SHARE",[u.tenantId,accountId]);
          if(!owner.rows[0] || owner.rows[0].client_id!==p.data.clientId){skipped++;errors.push({rowNumber:item.rowNumber,error:"Matched company belongs to a different client"});continue;}
        }
        // Account-list membership is independent of signal de-duplication.
        if (p.data.kind === "account_list" && p.data.audienceId && accountId) await client.query("INSERT INTO intent_audience_companies(tenant_id,audience_id,company_id) SELECT $1,$2,$3 WHERE EXISTS(SELECT 1 FROM companies WHERE tenant_id=$1 AND id=$3 AND ($4::int IS NULL OR client_id=$4)) ON CONFLICT DO NOTHING", [u.tenantId, p.data.audienceId, accountId, p.data.clientId ?? null]);
        const source = n.source || `import:${p.data.kind}`;
        const mapped = n.mappedPayload as Record<string, unknown>;
        const derivedAnswers = answerImport ? n.answerSignals : [];
        const inferredProducts = p.data.productId
          ? [{ id: p.data.productId, name: "Selected product", category: "", subcategory: null, confidence: 100, matchedOn: "product" as const }]
          : item.inferredProducts ?? [];
        const signalSpecs = derivedAnswers.length ? derivedAnswers : [{
          signalTypeKey: signalTypeFor(p.data.kind),
          label: p.data.kind.replace(/_/g, " "),
          field: "response",
          value: n.summary || String(mapped.response_text || mapped.comments || ""),
          strength: n.strength,
          reason: "Generic uploaded intent strength",
        }];
        let rowInserted = false;
        for (const [answerIndex, answer] of signalSpecs.entries()) {
          const signalTypeId = typeByKey.get(answer.signalTypeKey);
          if (!signalTypeId) throw new Error(`Intent signal type ${answer.signalTypeKey} is unavailable`);
          const answerProductIds = answer.field === "knowledge_interest"
            ? [null]
            : inferredProducts.length
              ? inferredProducts.map((product: { id: number }) => product.id)
              : [null];
          for (const answerProductId of answerProductIds) {
          const provenance = {
            importRunId: importRun.rows[0].id,
            idempotencyKey: p.data.idempotencyKey,
            fileName: p.data.fileName ?? null,
            rowNumber: item.rowNumber,
            importKind: p.data.kind,
            source,
            inferredProduct: answerProductId
              ? inferredProducts.find((product: { id: number }) => product.id === answerProductId) ?? null
              : null,
          };
          const rowHash = createHash("sha256").update(JSON.stringify({
            kind: p.data.kind,
            source,
            normalized: n,
            answerField: answer.field,
            answerValue: answer.value,
            productId: answerProductId,
          })).digest("hex");
          const externalId = n.externalId
            ? `${n.externalId}:${answer.field}:${answerIndex}:product:${answerProductId ?? "none"}`
            : null;
          const answerSummary = `${answer.label}: ${answer.value}`.slice(0, 12000);
          const signalPayload = {
            rawPayload: n.rawPayload,
            mappedPayload: mapped,
            answer: { field: answer.field, value: answer.value, strength: answer.strength, reason: answer.reason },
            provenance,
          };
          const signal = await client.query<{ id: number }>(`INSERT INTO intent_signals(tenant_id,client_id,product_id,signal_type_id,account_id,contact_id,source,external_id,row_hash,summary,strength,occurred_at,vertical,function,payload)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) ON CONFLICT DO NOTHING RETURNING id`,
            [u.tenantId, p.data.clientId ?? null, answerProductId, signalTypeId, accountId, contactId, source, externalId, rowHash, answerSummary, answer.strength, n.capturedAt, n.vertical || null, n.function || null, toJsonParameter(signalPayload)]);
          if (!signal.rows[0]) continue;
          rowInserted = true;
          // Every scoring signal has one evidence row linked to the durable upload run.
          const evidenceKind = responseImport(p.data.kind) ? p.data.kind : "uploaded_intent";
          const excerpt = answerSummary || n.summary || `${answer.label}: response`;
          await client.query(`INSERT INTO intent_evidence(tenant_id,signal_id,import_run_id,account_id,contact_id,product_id,evidence_kind,event_type,excerpt,provider,confidence,context,raw_evidence,review_status,occurred_at)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'import',$10,$11,$12,$13,$14)`,
            [u.tenantId, signal.rows[0].id, importRun.rows[0].id, accountId, contactId, answerProductId, evidenceKind, answer.signalTypeKey, excerpt.slice(0, 12000), answer.strength, toJsonParameter({
              answer: { field: answer.field, value: answer.value, strength: answer.strength, reason: answer.reason },
              provenance,
              approvalPolicy: UPLOADED_ANSWER_APPROVAL_POLICY,
              formName: mapped.form_name ?? null,
              campaign: mapped.campaign ?? null,
              leadSource: mapped.lead_source ?? null,
            }), toJsonParameter(n.rawPayload), UPLOADED_ANSWER_APPROVAL_POLICY.reviewStatus, n.capturedAt]);
          }
        }
        if (!rowInserted) { skipped++; continue; }
        inserted++;
        if (accountId) affected.set(`a:${accountId}`, { accountId });
        if (contactId) {
          affected.set(`c:${contactId}`, { contactId });
          const company = await client.query<{ company_id: number | null }>("SELECT company_id FROM contacts WHERE tenant_id=$1 AND id=$2", [u.tenantId, contactId]);
          if (company.rows[0]?.company_id) affected.set(`a:${company.rows[0].company_id}`, { accountId: company.rows[0].company_id });
        }
        if (!accountId && !contactId && p.data.kind === "consulting" && n.vertical) {
          const matchingAccounts = await client.query<{ id: number }>(
            "SELECT id FROM companies WHERE tenant_id=$1 AND lower(btrim(industry))=lower(btrim($2)) AND ($3::int IS NULL OR client_id=$3) ORDER BY id LIMIT 1000",
            [u.tenantId, n.vertical, p.data.clientId ?? null],
          );
          for (const company of matchingAccounts.rows) {
            affected.set(`a:${company.id}`, { accountId: company.id });
          }
        }
      }
      const summary = { inserted, skipped, failed: errors.length, unmatched, duplicate: false };
      await client.query(`UPDATE intent_import_runs
        SET status='completed',inserted_rows=$1,skipped_rows=$2,failed_rows=$3,unmatched_rows=$4,summary=$5,errors=$6,completed_at=NOW()
        WHERE tenant_id=$7 AND id=$8`,
      [inserted, skipped, errors.length, unmatched, toJsonParameter(summary), toJsonParameter(errors), u.tenantId, importRun.rows[0].id]);
      await client.query("COMMIT");
      // Product scopes are read-only views and must never mutate global scores.
      for (const entity of affected.values()) {
        await enqueueIntent(u.tenantId, entity, "import");
        try {
          await recomputeIntent(u.tenantId, entity, "import");
          await pool.query(
            "UPDATE intent_recompute_queue SET status='done',updated_at=NOW() WHERE tenant_id=$1 AND account_id IS NOT DISTINCT FROM $2 AND contact_id IS NOT DISTINCT FROM $3 AND status='pending'",
            [u.tenantId, entity.accountId ?? null, entity.contactId ?? null],
          );
        } catch {
          // The durable queue remains pending and will retry independently.
        }
      }
      res.json({ ...summary, errors });
    } catch (e) { await client.query("ROLLBACK"); throw e; } finally { client.release(); }
  } catch (e) { next(e); }
});

router.post("/intent/recompute", async (req, res, next) => { try {
  const u = admin(req, res); if (!u) return;
  const p = z.object({ scope: z.enum(["all", "accounts", "contacts"]) }).safeParse(req.body);
  if (!p.success) { res.status(400).json({ error: "scope must be all, accounts, or contacts" }); return; }
  const condition = p.data.scope === "accounts" ? "AND account_id IS NOT NULL AND contact_id IS NULL" : p.data.scope === "contacts" ? "AND contact_id IS NOT NULL AND account_id IS NULL" : "";
  const entities = await pool.query<{ account_id: number | null; contact_id: number | null }>(`SELECT account_id,contact_id FROM intent_entity_scores WHERE tenant_id=$1 ${condition} ORDER BY coalesce(account_id,contact_id),account_id NULLS LAST,contact_id NULLS LAST LIMIT 1000`, [u.tenantId]);
  for (const entity of entities.rows) await enqueueIntent(u.tenantId, { accountId: entity.account_id, contactId: entity.contact_id }, "admin_recompute");
  res.json({ scope: p.data.scope, enqueued: entities.rows.length, limit: 1000 });
} catch (e) { next(e); } });

router.post("/intent/research/briefs/backfill", async (req,res,next)=>{try{
  const u=admin(req,res);if(!u)return;
  const parsed=z.object({limit:z.number().int().min(1).max(500).default(100)}).safeParse(req.body??{});
  if(!parsed.success){res.status(400).json({error:"limit must be between 1 and 500"});return;}
  const summary=await backfillStoredResearchOpportunities(u.tenantId,parsed.data.limit);
  req.log.info({tenantId:u.tenantId,...summary},"Local research brief backfill completed");
  res.json({...summary,providerRequests:0,policyVersion:RESEARCH_FITMENT_POLICY_VERSION});
}catch(e){next(e);}});

const researchEventSchema = z.object({
  accountId: z.number().int().positive().optional(), companyName: z.string().trim().min(1).max(250).optional(), domain: z.string().trim().max(255).optional(),
  eventType: z.enum(PUBLIC_EVENT_TYPES), occurredAt: z.string().datetime(),
  sourceUrl: httpUrl.optional(), excerpt: z.string().trim().min(1).max(12000),
  confidence: z.number().int().min(0).max(100).default(50), context: z.record(z.string(), z.unknown()).default({}),
  productId: z.number().int().positive().optional(), strength: z.number().int().min(0).max(100).optional(),
});
const researchRequestSchema = z.object({
  provider: z.enum(["manual", "demo", "newsapi", "perplexity", "tavily", "explorium"]).default("perplexity"), clientId: z.number().int().positive().optional(), audienceId: z.number().int().positive().optional(),
  idempotencyKey: z.string().trim().min(8).max(200).optional(), retryOfId: z.number().int().positive().optional(),
  accountIds: z.array(z.number().int().positive()).max(1000).optional(),
  eventTypes: z.array(z.enum(PUBLIC_EVENT_TYPES)).min(1).max(PUBLIC_EVENT_TYPES.length).optional(),
  country: z.string().trim().min(2).max(100).default("India"),
  rows: z.array(researchEventSchema).max(1000).default([]),
});

router.get(["/intent/research-runs","/intent/research/runs"], async (req,res,next) => { try {
  const u=req.user as User, {page,pageSize}=pageOf(req);
  const q=await pool.query(`SELECT id,client_id AS "clientId",audience_id AS "audienceId",provider,status,idempotency_key AS "idempotencyKey",attempts,retry_of_id AS "retryOfId",summary,error,started_at AS "startedAt",completed_at AS "completedAt"
    FROM intent_research_runs WHERE tenant_id=$1 ORDER BY started_at DESC LIMIT $2 OFFSET $3`,[u.tenantId,pageSize,(page-1)*pageSize]);
  res.json({runs:q.rows,page,pageSize});
} catch(e){next(e);} });
router.get("/intent/research/runs/:runId", async (req,res,next) => { try {
  const u=req.user as User,runId=positiveId(req.params.runId);
  if(!runId){res.status(400).json({error:"Invalid research run"});return;}
  const run=await pool.query(`SELECT id,client_id AS "clientId",audience_id AS "audienceId",provider,status,idempotency_key AS "idempotencyKey",attempts,retry_of_id AS "retryOfId",summary,error,started_at AS "startedAt",completed_at AS "completedAt"
    FROM intent_research_runs WHERE tenant_id=$1 AND id=$2`,[u.tenantId,runId]);
  if(!run.rows[0]){res.status(404).json({error:"Research run not found"});return;}
  res.json(run.rows[0]);
} catch(e){next(e);} });
router.post(["/intent/research-runs","/intent/research/runs"], async(req,res,next)=>{ try {
  const u=admin(req,res), p=researchRequestSchema.safeParse(req.body); if(!u)return;
  if(!p.success || !await hasClient(u.tenantId,p.data.clientId) || !await hasAudienceScope(u.tenantId,p.data.audienceId,p.data.clientId)){res.status(400).json({error:"Invalid research request"});return;}
  if(p.data.retryOfId && !(await pool.query("SELECT 1 FROM intent_research_runs WHERE tenant_id=$1 AND id=$2",[u.tenantId,p.data.retryOfId])).rows[0]){res.status(400).json({error:"Unknown retry run"});return;}
  const provider=p.data.provider;
  const idempotencyKey=p.data.idempotencyKey??`${provider}:${u.tenantId}:${u.id}:${Date.now()}`;
  let rows=[...p.data.rows],providerStats:ProviderStats|undefined;
  if(!rows.length){
    const prior=await pool.query<{id:number;summary:unknown;status:string}>("SELECT id,summary,status FROM intent_research_runs WHERE tenant_id=$1 AND idempotency_key=$2",[u.tenantId,idempotencyKey]);
    if(prior?.rows?.[0]){res.json({...prior.rows[0],duplicate:true});return;}
    if(!["newsapi","perplexity","tavily","explorium"].includes(provider)){res.status(400).json({error:"A live provider is required when rows are not supplied"});return;}
    if(!await providerConfigured(u.tenantId,provider as ResearchProvider)){res.status(503).json({error:"provider_not_configured",message:`${provider} is not configured`});return;}
    if(!p.data.country){res.status(400).json({error:"Select a research country before starting the run"});return;}
    const accountIds=[...new Set(p.data.accountIds??[])].sort((a,b)=>a-b);
    if(!accountIds.length){res.status(400).json({error:"Select at least one account to research"});return;}
    const requestLimit=await providerRequestLimit(u.tenantId,provider as ResearchProvider);
    const scopedAccounts=await pool.query<{id:number}>(
      `SELECT c.id FROM companies c
        WHERE c.tenant_id=$1
          AND c.id=ANY($2::int[])
          AND ($3::int IS NULL OR c.client_id=$3)
          AND ($4::int IS NULL OR EXISTS (
            SELECT 1 FROM intent_audience_companies ac
             WHERE ac.tenant_id=c.tenant_id AND ac.audience_id=$4 AND ac.company_id=c.id
          ))
        ORDER BY c.id`,
      [u.tenantId,accountIds,p.data.clientId??null,p.data.audienceId??null],
    );
    if(scopedAccounts.rows.length!==accountIds.length){res.status(400).json({error:"One or more selected accounts are outside the research scope"});return;}
    const summary={
      request:{clientId:p.data.clientId??null,audienceId:p.data.audienceId??null,accountIds,eventTypes:p.data.eventTypes??PUBLIC_EVENT_TYPES,country:p.data.country},
      accountsTotal:accountIds.length,accountsCompleted:0,accountsRemaining:accountIds.length,accountsFailed:0,accountsInterpreted:0,
      requests:0,pages:0,retries:0,rateLimited:0,recordsFetched:0,recordsNormalized:0,inserted:0,duplicates:0,
      cost:{provider,billableRequests:0,unit:"provider_request"},
    };
    const c=await pool.connect();
    try{
      await c.query("BEGIN");
      const created=await c.query<{id:number}>(`INSERT INTO intent_research_runs(tenant_id,client_id,audience_id,provider,status,idempotency_key,retry_of_id,requested_by,request_limit,summary)
        VALUES($1,$2,$3,$4,'queued',$5,$6,$7,$8,$9)
        ON CONFLICT (tenant_id,idempotency_key) DO NOTHING RETURNING id`,[u.tenantId,p.data.clientId??null,p.data.audienceId??null,provider,idempotencyKey,p.data.retryOfId??null,u.id,requestLimit,summary]);
      if(!created.rows[0]){
        const duplicate=await c.query<{id:number;summary:unknown;status:string}>("SELECT id,summary,status FROM intent_research_runs WHERE tenant_id=$1 AND idempotency_key=$2",[u.tenantId,idempotencyKey]);
        await c.query("COMMIT");
        res.json({...duplicate.rows[0],duplicate:true});
        return;
      }
      for(const accountId of accountIds)await c.query(`INSERT INTO intent_research_run_accounts(tenant_id,run_id,account_id,status)
        VALUES($1,$2,$3,'pending') ON CONFLICT (tenant_id,run_id,account_id) DO NOTHING`,[u.tenantId,created.rows[0].id,accountId]);
      await c.query("COMMIT");
      kickIntentResearchRunner();
      res.status(202).json({id:created.rows[0].id,runId:created.rows[0].id,provider,status:"queued",summary,duplicate:false});
      return;
    }catch(error){await c.query("ROLLBACK");throw error;}finally{c.release();}
  }
  const opportunityBriefs=new Map<number,ResearchOpportunityBrief>();
  if(providerStats){
    const groupedRows=new Map<number,typeof rows>();
    for(const row of rows){if(!row.accountId)continue;const group=groupedRows.get(row.accountId)??[];group.push(row);groupedRows.set(row.accountId,group);}
    const groups=[...groupedRows.entries()];
    for(let offset=0;offset<groups.length;offset+=4){
      const batch=groups.slice(offset,offset+4);
      const briefs=await Promise.all(batch.map(async([accountId,accountRows])=>{
        const first=accountRows[0];
         return [accountId,await interpretResearchOpportunity(u.tenantId,{name:first.companyName??`Account ${accountId}`,domain:first.domain},accountRows,p.data.country)] as const;
      }));
      for(const [accountId,brief] of briefs)if(brief)opportunityBriefs.set(accountId,brief);
    }
  }
  for(const row of rows) if(row.productId && !await hasTenantRow(u.tenantId,"intent_products",row.productId)){res.status(400).json({error:"Unknown product"});return;}
  await ensureIntentDefaults(u.tenantId);
  const c=await pool.connect(); let inserted=0, review=0, duplicates=0;
  try { await c.query("BEGIN");
    const prior=await c.query<{id:number;summary:unknown,status:string}>("SELECT id,summary,status FROM intent_research_runs WHERE tenant_id=$1 AND idempotency_key=$2",[u.tenantId,idempotencyKey]);
    if(prior.rows[0]){await c.query("COMMIT");res.json({run:prior.rows[0],duplicate:true});return;}
    const runStatus=providerStats?.failures.length?"partial":"completed";
    const run=(await c.query<{id:number}>(`INSERT INTO intent_research_runs(tenant_id,client_id,audience_id,provider,status,idempotency_key,retry_of_id,requested_by,summary,completed_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,'{}',NOW()) RETURNING id`,[u.tenantId,p.data.clientId??null,p.data.audienceId??null,provider,runStatus,idempotencyKey,p.data.retryOfId??null,u.id])).rows[0];
    for(const [accountId,opportunityBrief] of opportunityBriefs){
      await c.query(`UPDATE intent_evidence
        SET context=context || jsonb_build_object('opportunityBrief',$1::jsonb)
        WHERE id=(SELECT id FROM intent_evidence WHERE tenant_id=$2 AND account_id=$3 AND evidence_kind='public_event' AND review_status<>'rejected' ORDER BY occurred_at DESC,id DESC LIMIT 1)`,
      [JSON.stringify(opportunityBrief),u.tenantId,accountId]);
    }
    for(const row of rows) {
      let accountId=row.accountId??null;
      if(accountId && !await hasCompanyScope(u.tenantId,accountId,p.data.clientId,p.data.audienceId)){review++;accountId=null;}
      if(!accountId && (row.companyName||row.domain)){const match=await matchEntities(u.tenantId,{companyName:row.companyName,domain:row.domain});accountId=match.accountId;if(match.conflict||!await hasCompanyScope(u.tenantId,accountId,p.data.clientId,p.data.audienceId)){accountId=null;review++;}}
      const fingerprint=accountId?eventFingerprint({eventType:row.eventType,accountId,occurredAt:row.occurredAt,context:row.context}):null;
      const evidenceFingerprint=fingerprint?`${fingerprint}:product:${row.productId??"unscoped"}`:null;
      const type=(await c.query<{id:number}>("SELECT id FROM intent_signal_types WHERE tenant_id=$1 AND key=$2",[u.tenantId,row.eventType])).rows[0];
      let signalId:number|null=null;
      if(accountId && type && row.productId && isResearchGeographyEligible(row,p.data.country)) {
        const s=await c.query<{id:number}>(`INSERT INTO intent_signals(tenant_id,client_id,product_id,signal_type_id,account_id,source,row_hash,summary,strength,occurred_at,payload)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING RETURNING id`,[u.tenantId,p.data.clientId??null,row.productId,type.id,accountId,"public_event",evidenceFingerprint,row.excerpt,row.strength??row.confidence,row.occurredAt,{eventType:row.eventType,sourceUrl:row.sourceUrl??null,excerpt:row.excerpt,context:row.context,scope:{clientId:p.data.clientId??null,audienceId:p.data.audienceId??null}}]);
        signalId=s.rows[0]?.id??null;
      }
      const opportunityBrief=accountId?opportunityBriefs.get(accountId):undefined;
      const evidence=await c.query(`INSERT INTO intent_evidence(tenant_id,signal_id,research_run_id,account_id,product_id,evidence_kind,event_type,event_fingerprint,source_url,excerpt,provider,confidence,context,raw_evidence,review_status,occurred_at)
        VALUES($1,$2,$3,$4,$5,'public_event',$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
        ON CONFLICT (tenant_id,event_fingerprint) WHERE event_fingerprint IS NOT NULL DO NOTHING RETURNING id`,[u.tenantId,signalId,run.id,accountId,row.productId??null,row.eventType,evidenceFingerprint,row.sourceUrl??null,row.excerpt,provider,row.confidence,{...row.context,...(opportunityBrief?{opportunityBrief}:{}),scope:{clientId:p.data.clientId??null,audienceId:p.data.audienceId??null,country:p.data.country??row.context.country??"India"}},row,"pending_review",row.occurredAt]);
      if(evidence.rows[0])inserted++;else if(evidenceFingerprint)duplicates++;
    }
    const summary={...(providerStats??{}),received:rows.length,inserted,duplicates,pendingReview:review};
    await c.query("UPDATE intent_research_runs SET summary=$1 WHERE tenant_id=$2 AND id=$3",[summary,u.tenantId,run.id]);await c.query("COMMIT");
    res.status(201).json({id:run.id,provider,status:runStatus,summary,duplicate:false});
  } catch(e){await c.query("ROLLBACK");throw e;} finally{c.release();}
}catch(e){next(e);}});
router.post("/intent/research/runs/:runId/resume",async(req,res,next)=>{try{
  const u=admin(req,res),runId=positiveId(req.params.runId);if(!u)return;
  if(!runId){res.status(400).json({error:"Invalid research run"});return;}
  const c=await pool.connect();
  try{
    await c.query("BEGIN");
    const resumed=await c.query<{id:number}>(`UPDATE intent_research_runs
      SET status='queued',attempts=attempts+1,error=NULL,completed_at=NULL
      WHERE tenant_id=$1 AND id=$2 AND provider IN ('newsapi','perplexity','tavily','explorium') AND status IN ('failed','partial')
      RETURNING id`,[u.tenantId,runId]);
    if(!resumed.rows[0]){await c.query("ROLLBACK");res.status(409).json({error:"Only failed or partial research runs can be resumed"});return;}
    await c.query(`UPDATE intent_research_run_accounts
      SET status='pending',error=NULL,started_at=NULL,completed_at=NULL
      WHERE tenant_id=$1 AND run_id=$2 AND status='failed'`,[u.tenantId,runId]);
    await c.query("COMMIT");
  }catch(error){await c.query("ROLLBACK");throw error;}finally{c.release();}
  kickIntentResearchRunner();
  res.status(202).json({id:runId,runId,status:"queued"});
}catch(e){next(e);}});

router.get("/intent/research/attribution-review",async(req,res,next)=>{try{
  const u=admin(req,res);if(!u)return;
  const accountId=req.query.accountId==null?null:positiveId(String(req.query.accountId));
  const cursor=req.query.cursor==null?null:positiveId(String(req.query.cursor));
  if((req.query.accountId!=null&&!accountId)||(req.query.cursor!=null&&!cursor)){res.status(400).json({error:"Invalid review filter"});return;}
  const items:Array<Record<string,unknown>>=[];
  let before=cursor;
  // Scan in bounded batches so old approved records remain discoverable without loading a tenant's entire history.
  for(let batch=0;batch<10&&items.length<50;batch++){
    const q=await pool.query<{id:number;account_id:number;account_name:string;domain:string|null;event_type:string|null;excerpt:string|null;source_url:string|null;raw_evidence:{excerpt?:string;context?:{searchKind?:string}}|null;context:Record<string,any>;occurred_at:Date}>(`SELECT e.id,e.account_id,c.name AS account_name,c.domain,e.event_type,e.excerpt,e.source_url,e.raw_evidence,e.context,e.occurred_at
      FROM intent_evidence e JOIN companies c ON c.tenant_id=e.tenant_id AND c.id=e.account_id
      WHERE e.tenant_id=$1 AND e.evidence_kind='public_event' AND e.review_status='approved'
        AND e.reviewed_by IS NULL AND NOT (e.context ? 'attributionReviews')
        AND ($2::int IS NULL OR e.account_id=$2) AND ($3::int IS NULL OR e.id<$3)
      ORDER BY e.id DESC LIMIT 200`,[u.tenantId,accountId,before]);
    if(!q.rows.length){before=null;break;}
    for(const row of q.rows){
      const originalExcerpt=row.raw_evidence?.excerpt??row.context?.originalExcerpt??"";
      const reason=publicResearchMismatchReason({eventType:row.event_type,searchKind:row.context?.searchKind??row.raw_evidence?.context?.searchKind,originalExcerpt,sourceUrl:row.source_url,companyName:row.account_name,companyDomain:row.domain});
      if(reason)items.push({id:row.id,accountId:row.account_id,accountName:row.account_name,eventType:row.event_type,originalExcerpt,excerpt:row.excerpt,sourceUrl:row.source_url,occurredAt:row.occurred_at,reason});
      before=row.id;
      if(items.length===50)break;
    }
    if(q.rows.length<200){before=null;break;}
  }
  res.json({items,nextCursor:before});
}catch(e){next(e);}});

router.get("/intent/research/attribution-review/history",async(req,res,next)=>{try{
  const u=admin(req,res);if(!u)return;
  const accountId=positiveId(String(req.query.accountId??""));
  if(!accountId){res.status(400).json({error:"Invalid account"});return;}
  const q=await pool.query(`SELECT e.id,e.account_id AS "accountId",c.name AS "accountName",e.event_type AS "eventType",
    COALESCE(e.raw_evidence->>'excerpt',e.context->>'originalExcerpt','') AS "originalExcerpt",
    e.source_url AS "sourceUrl",e.context->'attributionReviews' AS reviews
    FROM intent_evidence e LEFT JOIN companies c ON c.tenant_id=e.tenant_id AND c.id=e.account_id
    WHERE e.tenant_id=$1 AND e.evidence_kind='public_event' AND e.context ? 'attributionReviews'
      AND (e.account_id=$2 OR EXISTS(SELECT 1 FROM jsonb_array_elements(e.context->'attributionReviews') review
        WHERE review->>'fromAccountId'=$3))
    ORDER BY e.reviewed_at DESC,e.id DESC LIMIT 100`,[u.tenantId,accountId,String(accountId)]);
  res.json({items:q.rows});
}catch(e){next(e);}});

router.post("/intent/research/attribution-review/:id",async(req,res,next)=>{try{
  const u=admin(req,res);if(!u)return;
  const id=positiveId(String(req.params.id));
  const parsed=z.object({decision:z.enum(["reject","reassign","retain"]),accountId:z.number().int().positive().optional(),reason:z.string().trim().min(8).max(1000)}).strict().safeParse(req.body);
  if(!id||!parsed.success||(parsed.data.decision==="reassign")!==Boolean(parsed.data.accountId)){res.status(400).json({error:"Decision, reason, and reassignment account (when applicable) are required"});return;}
  const c=await pool.connect();
  let oldAccountId:number|null=null,newAccountId:number|null=null;
  try{
    await c.query("BEGIN");
    const q=await c.query<{account_id:number;signal_id:number|null;product_id:number|null;review_status:string;reviewed_by:number|null;event_fingerprint:string|null;context:Record<string,any>;source_url:string|null;raw_evidence:{excerpt?:string;context?:{searchKind?:string}}|null;excerpt:string|null;event_type:string|null;account_name:string;domain:string|null;client_id:number|null;audience_id:number|null}>(`SELECT e.account_id,e.signal_id,e.product_id,e.review_status,e.reviewed_by,e.event_fingerprint,e.context,e.source_url,e.raw_evidence,e.excerpt,e.event_type,company.name AS account_name,company.domain,r.client_id,r.audience_id
      FROM intent_evidence e JOIN companies company ON company.tenant_id=e.tenant_id AND company.id=e.account_id
      LEFT JOIN intent_research_runs r ON r.tenant_id=e.tenant_id AND r.id=e.research_run_id
      WHERE e.tenant_id=$1 AND e.id=$2 AND e.evidence_kind='public_event' FOR UPDATE OF e`,[u.tenantId,id]);
    const row=q.rows[0];
    if(!row){await c.query("ROLLBACK");res.status(404).json({error:"Research evidence not found"});return;}
    if(row.review_status!=="approved"||row.reviewed_by!=null||row.context?.attributionReviews){await c.query("ROLLBACK");res.status(409).json({error:"This item has already been reviewed or changed"});return;}
    const reason=publicResearchMismatchReason({eventType:row.event_type,searchKind:row.context?.searchKind??row.raw_evidence?.context?.searchKind,originalExcerpt:row.raw_evidence?.excerpt??row.context?.originalExcerpt??"",sourceUrl:row.source_url,companyName:row.account_name,companyDomain:row.domain});
    if(!reason){await c.query("ROLLBACK");res.status(409).json({error:"This item is not in the attribution review queue"});return;}
    oldAccountId=row.account_id;
    newAccountId=parsed.data.accountId??oldAccountId;
    const scope=row.context?.scope??{};
    if(parsed.data.decision==="reassign"&&(newAccountId===oldAccountId||!await hasCompanyScope(u.tenantId,newAccountId,row.client_id??scope.clientId??undefined,row.audience_id??scope.audienceId??undefined))){
      await c.query("ROLLBACK");res.status(400).json({error:"Choose another account within the research scope"});return;
    }
    if(parsed.data.decision==="reassign"){
      const target=(await c.query<{name:string;domain:string|null}>("SELECT name,domain FROM companies WHERE tenant_id=$1 AND id=$2",[u.tenantId,newAccountId])).rows[0];
      if(!target||publicResearchMismatchReason({eventType:row.event_type,originalExcerpt:row.raw_evidence?.excerpt??row.context?.originalExcerpt??"",sourceUrl:row.source_url,companyName:target.name,companyDomain:target.domain})){
        await c.query("ROLLBACK");res.status(400).json({error:"The original source must identify the destination account or come from its domain. Reject this item instead if attribution cannot be verified."});return;
      }
    }
    const decision=parsed.data.decision;
    if(decision!=="retain"){
      // Remove only signals created for this evidence, never shared or unrelated source signals.
      await c.query(`DELETE FROM intent_signals s WHERE s.tenant_id=$1 AND s.source='public_event'
        AND s.account_id=$2 AND (s.payload->>'evidenceId'=$3 OR s.id=$4)
        AND NOT EXISTS(SELECT 1 FROM intent_evidence other WHERE other.tenant_id=s.tenant_id AND other.signal_id=s.id AND other.id<>$3::int)`,
      [u.tenantId,oldAccountId,String(id),row.signal_id]);
    }
    const fingerprint=decision==="reassign"&&row.event_fingerprint?`${row.event_fingerprint}:reassigned:${newAccountId}`:row.event_fingerprint;
    await c.query(`UPDATE intent_evidence SET account_id=$1,review_status=$2,signal_id=$3,product_id=$4,event_fingerprint=$5,reviewed_by=$6,reviewed_at=NOW(),
      excerpt=CASE WHEN $7::text='reassign' THEN COALESCE(raw_evidence->>'excerpt',context->>'originalExcerpt',excerpt) ELSE excerpt END,
      context=(CASE WHEN $7::text='reassign' THEN context-'aiReview' ELSE context END) || jsonb_build_object('attributionReviews',COALESCE(context->'attributionReviews','[]'::jsonb) || jsonb_build_array(jsonb_build_object(
        'decision',$7::text,'reason',$8::text,'flagReason',$9::text,'reviewerId',$6::int,'fromAccountId',$10::int,'toAccountId',$1::int,'at',NOW())))
      WHERE tenant_id=$11 AND id=$12`,
      [newAccountId,decision==="reject"?"rejected":"approved",decision==="retain"?row.signal_id:null,decision==="retain"?row.product_id:null,fingerprint,u.id,decision,parsed.data.reason,reason,oldAccountId,u.tenantId,id]);
    await c.query(`UPDATE intent_evidence SET context=context-'opportunityBrief'
      WHERE tenant_id=$1 AND evidence_kind='public_event' AND account_id IN ($2,$3) AND context ? 'opportunityBrief'`,
      [u.tenantId,oldAccountId,newAccountId]);
    await c.query("COMMIT");
  }catch(error){await c.query("ROLLBACK").catch(()=>undefined);throw error;}finally{c.release();}
  try{
    for(const affected of new Set([oldAccountId,newAccountId].filter((value):value is number=>value!=null))){
      await rebuildStoredResearchOpportunityLocally(u.tenantId,affected,true);
      await enqueueIntent(u.tenantId,{accountId:affected},"research_attribution_review");
      await recomputeIntent(u.tenantId,{accountId:affected},"research_attribution_review");
    }
  }catch(error){
    req.log.error({err:error,evidenceId:id},"Research attribution decision saved, but recomputation failed");
    res.status(503).json({error:"Decision saved, but recomputation failed. Reload and retry from the review history."});return;
  }
  res.json({id,decision:parsed.data.decision,oldAccountId,newAccountId});
}catch(e){next(e);}});

router.post("/intent/research/attribution-review/:id/refresh",async(req,res,next)=>{try{
  const u=admin(req,res);if(!u)return;
  const id=positiveId(String(req.params.id));
  if(!id){res.status(400).json({error:"Invalid evidence ID"});return;}
  const q=await pool.query<{account_id:number;context:{attributionReviews?:Array<{fromAccountId:number;toAccountId:number}>}}>(
    `SELECT account_id,context FROM intent_evidence WHERE tenant_id=$1 AND id=$2 AND evidence_kind='public_event' AND context ? 'attributionReviews'`,[u.tenantId,id]);
  const row=q.rows[0];
  if(!row){res.status(404).json({error:"Reviewed evidence not found"});return;}
  const ids=new Set<number>([row.account_id]);
  for(const review of row.context.attributionReviews??[]){
    if(Number.isInteger(review.fromAccountId)&&review.fromAccountId>0)ids.add(review.fromAccountId);
    if(Number.isInteger(review.toAccountId)&&review.toAccountId>0)ids.add(review.toAccountId);
  }
  for(const accountId of ids){
    await rebuildStoredResearchOpportunityLocally(u.tenantId,accountId,true);
    await enqueueIntent(u.tenantId,{accountId},"research_attribution_review");
    await recomputeIntent(u.tenantId,{accountId},"research_attribution_review");
  }
  res.json({accountIds:[...ids]});
}catch(e){next(e);}});

router.get("/intent/evidence",async(req,res,next)=>{try{
  const u=req.user as User,{page,pageSize}=pageOf(req),accountId=positiveId(String(req.query.accountId??"")),productId=positiveId(String(req.query.productId??"")),status=typeof req.query.reviewStatus==="string"?req.query.reviewStatus:null;
  if(req.query.productId && !await hasTenantRow(u.tenantId,"intent_products",productId??undefined)){res.status(400).json({error:"Unknown product"});return;}
  const q=await pool.query(`SELECT e.id,e.signal_id AS "signalId",e.account_id AS "accountId",e.contact_id AS "contactId",e.product_id AS "productId",e.evidence_kind AS "evidenceKind",e.event_type AS "eventType",e.source_url AS "sourceUrl",e.excerpt,e.provider,e.confidence,e.context,e.raw_evidence AS "rawEvidence",e.review_status AS "reviewStatus",e.occurred_at AS "occurredAt",c.name AS "accountName"
    FROM intent_evidence e LEFT JOIN companies c ON c.tenant_id=e.tenant_id AND c.id=e.account_id WHERE e.tenant_id=$1 AND (e.evidence_kind<>'public_event' OR e.occurred_at>=NOW()-interval '${PUBLIC_RESEARCH_WINDOW_SQL}') AND ($2::int IS NULL OR e.account_id=$2) AND ($3::int IS NULL OR e.product_id=$3) AND ($4::text IS NULL OR e.review_status=$4) ORDER BY e.occurred_at DESC LIMIT $5 OFFSET $6`,[u.tenantId,accountId,productId,status,pageSize,(page-1)*pageSize]);
  res.json({evidence:q.rows.filter((row:any)=>row.evidenceKind!=="public_event"||isFreshPublicResearchEvidence(row.excerpt,row.occurredAt)).map((row:any)=>row.evidenceKind!=="public_event"?row:{...row,context:{...row.context,researchGeography:researchGeographyAssessment({...row,raw_evidence:row.rawEvidence,companyName:row.accountName})}}),page,pageSize});
}catch(e){next(e);}});
router.patch("/intent/evidence/:id/review",async(req,res,next)=>{try{
  const u=admin(req,res),id=positiveId(req.params.id),p=z.object({reviewStatus:z.enum(["approved","rejected","pending_review"]),accountId:z.number().int().positive().optional(),productId:z.number().int().positive().optional(),sourceUrl:httpUrl.optional()}).safeParse(req.body);if(!u)return;
  if(!id||!p.success){res.status(400).json({error:"Invalid evidence review"});return;}
  const c=await pool.connect();try{await c.query("BEGIN");
  const current=await c.query<{review_status:string;signal_id:number|null;account_id:number|null;product_id:number|null;evidence_kind:string;event_type:string|null;event_fingerprint:string|null;source_url:string|null;excerpt:string|null;provider:string;confidence:number;context:Record<string,any>;raw_evidence:unknown;occurred_at:Date;client_id:number|null;audience_id:number|null;company_name?:string}>(`SELECT e.*,r.client_id,r.audience_id,co.name AS company_name FROM intent_evidence e LEFT JOIN intent_research_runs r ON r.tenant_id=e.tenant_id AND r.id=e.research_run_id LEFT JOIN companies co ON co.tenant_id=e.tenant_id AND co.id=e.account_id WHERE e.tenant_id=$1 AND e.id=$2 FOR UPDATE OF e`,[u.tenantId,id]);
  if(!current.rows[0]){await c.query("ROLLBACK");res.status(404).json({error:"Evidence not found"});return;}
   const row=current.rows[0];
   if(row?.evidence_kind==="public_event"&&row.context?.attributionReviews){await c.query("ROLLBACK");res.status(409).json({error:"Attribution-reviewed research cannot be changed through the general evidence review endpoint"});return;}
  const transitions:Record<string,string[]>={pending_review:["approved","rejected"],approved:["pending_review","rejected"],rejected:["pending_review","approved"]};
  if(row.review_status!==p.data.reviewStatus&&!transitions[row.review_status]?.includes(p.data.reviewStatus)){await c.query("ROLLBACK");res.status(400).json({error:"Invalid evidence review transition"});return;}
  const accountId=p.data.accountId??row.account_id,productId=p.data.productId??row.product_id,sourceUrl=p.data.sourceUrl??row.source_url;
  const scope=row.context?.scope??{},clientId=row.client_id??scope.clientId??undefined,audienceId=row.audience_id??scope.audienceId??undefined;
  if((sourceUrl&&!httpUrl.safeParse(sourceUrl).success)||(p.data.productId&&!await hasTenantRow(u.tenantId,"intent_products",p.data.productId))||(p.data.accountId&&!await hasCompanyScope(u.tenantId,p.data.accountId,clientId,audienceId))){await c.query("ROLLBACK");res.status(400).json({error:"Invalid evidence assignment or source URL"});return;}
  let signalId=row.signal_id,eventKey=row.event_fingerprint;
  if(p.data.reviewStatus==="approved"){
    if(!accountId||!productId){await c.query("ROLLBACK");res.status(400).json({error:"Approval requires an assigned accountId and productId"});return;}
    if(row.evidence_kind==="public_event"&&!isResearchGeographyEligible(row)){await c.query("ROLLBACK");res.status(400).json({error:"India-scoped evidence requires an explicit India operation, market or location in the original source. Search settings and AI conclusions cannot establish relevance. The evidence remains available for audit."});return;}
    if(row.evidence_kind==="public_event"&&!isFreshPublicResearchEvidence(row.excerpt,row.occurred_at)){await c.query("ROLLBACK");res.status(400).json({error:"This public evidence is outside the current three-month research window or contains only stale dated facts, so it cannot be approved."});return;}
    if((!p.data.productId&&!await hasTenantRow(u.tenantId,"intent_products",productId))||(!p.data.accountId&&!await hasCompanyScope(u.tenantId,accountId,clientId,audienceId))){await c.query("ROLLBACK");res.status(400).json({error:"Account or product is outside the evidence scope"});return;}
    if(signalId&&(accountId!==row.account_id||productId!==row.product_id)){await c.query("ROLLBACK");res.status(409).json({error:"Linked evidence cannot be reassigned"});return;}
    if(!signalId){
      await ensureIntentDefaults(u.tenantId);if(!row.event_type){await c.query("ROLLBACK");res.status(400).json({error:"Public event type is required"});return;}
      eventKey=`${eventFingerprint({eventType:row.event_type,accountId,occurredAt:new Date(row.occurred_at).toISOString(),context:row.context})}:product:${productId}`;
      const type=await c.query<{id:number}>("SELECT id FROM intent_signal_types WHERE tenant_id=$1 AND key=$2",[u.tenantId,row.event_type]);if(!type.rows[0])throw new Error("Intent signal type is unavailable");
      const inserted=await c.query<{id:number}>(`INSERT INTO intent_signals(tenant_id,client_id,product_id,signal_type_id,account_id,source,row_hash,summary,strength,occurred_at,payload) VALUES($1,$2,$3,$4,$5,'public_event',$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING RETURNING id`,[u.tenantId,clientId??null,productId,type.rows[0].id,accountId,eventKey,row.excerpt,row.confidence,row.occurred_at,{eventType:row.event_type,sourceUrl,excerpt:row.excerpt,context:row.context}]);
      signalId=inserted.rows[0]?.id??(await c.query<{id:number}>("SELECT id FROM intent_signals WHERE tenant_id=$1 AND source='public_event' AND row_hash=$2",[u.tenantId,eventKey])).rows[0]?.id??null;
    }
  }
  const q=await c.query(`UPDATE intent_evidence SET signal_id=$1,account_id=$2,product_id=$3,event_fingerprint=$4,source_url=$5,review_status=$6,reviewed_by=$7,reviewed_at=CASE WHEN $6='pending_review' THEN NULL ELSE NOW() END WHERE tenant_id=$8 AND id=$9 RETURNING id,signal_id AS "signalId",account_id AS "accountId",product_id AS "productId",event_type AS "eventType",source_url AS "sourceUrl",excerpt,provider,confidence,context,raw_evidence AS "rawEvidence",review_status AS "reviewStatus",occurred_at AS "occurredAt"`,[signalId,accountId,productId,eventKey,sourceUrl,p.data.reviewStatus,u.id,u.tenantId,id]);
  await c.query("COMMIT");
  if(accountId){await enqueueIntent(u.tenantId,{accountId},"research_review");await recomputeIntent(u.tenantId,{accountId},"research_review");}
  res.json({evidence:q.rows[0]});
  }catch(e){await c.query("ROLLBACK");throw e;}finally{c.release();}
}catch(e){next(e);}});
router.post("/intent/accounts/:id/research-analysis",async(req,res,next)=>{try{
  const u=req.user as User,id=positiveId(req.params.id);
  if(!id){res.status(400).json({error:"Invalid account"});return;}
  const company=(await pool.query<{name:string;domain:string|null}>("SELECT name,domain FROM companies WHERE tenant_id=$1 AND id=$2",[u.tenantId,id])).rows[0];
  if(!company){res.status(404).json({error:"Account not found"});return;}
  const evidence=await pool.query<{id:number;event_type:ProviderEvent["eventType"];occurred_at:Date;source_url:string|null;excerpt:string;confidence:number;context:Record<string,unknown>;raw_evidence?:{excerpt?:string}}>(
    `SELECT id,event_type,occurred_at,source_url,excerpt,confidence,context,raw_evidence FROM intent_evidence
      WHERE tenant_id=$1 AND account_id=$2 AND evidence_kind='public_event' AND review_status<>'rejected'
        AND occurred_at>=NOW()-interval '${PUBLIC_RESEARCH_WINDOW_SQL}' ORDER BY occurred_at DESC LIMIT 50`,
    [u.tenantId,id],
  );
  const rows=evidence.rows.filter(row=>isFreshPublicResearchEvidence(row.excerpt,row.occurred_at)&&isResearchGeographyEligible(row));
  if(!rows.length){res.status(400).json({error:"No current, citable public evidence is available for analysis."});return;}
   const brief=await interpretResearchOpportunity(u.tenantId,{id,name:company.name,domain:company.domain??undefined},rows.map(row=>({
    accountId:id,companyName:company.name,domain:company.domain??undefined,eventType:row.event_type,occurredAt:row.occurred_at.toISOString(),
    sourceUrl:row.source_url??undefined,excerpt:row.raw_evidence?.excerpt??row.excerpt,confidence:row.confidence,context:{...row.context,originalExcerpt:row.raw_evidence?.excerpt??row.context?.originalExcerpt},
   })));
  if(!brief){res.status(503).json({error:"Opportunity analysis could not be generated. The evidence remains available for review; retry analysis in a moment."});return;}
  await pool.query(`UPDATE intent_evidence SET context=context||jsonb_build_object('opportunityBrief',$1::jsonb)
    WHERE tenant_id=$2 AND id=$3`,[JSON.stringify(brief),u.tenantId,rows[0].id]);
  res.json({opportunityBrief:brief});
}catch(e){next(e);}});
router.get("/intent/research/summary",async(req,res,next)=>{try{
  const u=req.user as User,clientId=positiveId(String(req.query.clientId??"")),audienceId=positiveId(String(req.query.audienceId??"")),accountIds=positiveIds(req.query.accountIds).sort((a,b)=>a-b);
  if((req.query.clientId&&!await hasClient(u.tenantId,clientId??undefined))||!await hasAudienceScope(u.tenantId,audienceId??undefined,clientId??undefined)){res.status(400).json({error:"Invalid research scope"});return;}
  const [counts,latest,activeRuns,newsConfigured,perplexityConfigured,tavilyConfigured,exploriumConfigured,contactConfigured]=await Promise.all([
    pool.query<{review_status:string;count:string}>(`SELECT review_status,count(*) FROM intent_evidence WHERE tenant_id=$1 AND evidence_kind='public_event' AND occurred_at>=NOW()-interval '${PUBLIC_RESEARCH_WINDOW_SQL}' AND ($2::int IS NULL OR account_id IN (SELECT id FROM companies WHERE tenant_id=$1 AND client_id=$2)) AND ($3::int IS NULL OR account_id IN (SELECT company_id FROM intent_audience_companies WHERE tenant_id=$1 AND audience_id=$3)) AND ($4::int[] IS NULL OR account_id=ANY($4::int[])) GROUP BY review_status`,[u.tenantId,clientId,audienceId,accountIds.length?accountIds:null]),
    pool.query(`SELECT id,provider,status,started_at AS "startedAt",completed_at AS "completedAt",summary,error FROM intent_research_runs WHERE tenant_id=$1 AND ($2::int IS NULL OR client_id=$2) AND ($3::int IS NULL OR audience_id=$3) AND ($4::int[] IS NULL OR summary->'request'->'accountIds' @> to_jsonb($4::int[])) ORDER BY started_at DESC LIMIT 1`,[u.tenantId,clientId,audienceId,accountIds.length?accountIds:null]),
    pool.query<{count:string}>(`SELECT count(*) FROM intent_research_runs WHERE tenant_id=$1 AND status IN ('queued','running') AND ($2::int IS NULL OR client_id=$2) AND ($3::int IS NULL OR audience_id=$3) AND ($4::int[] IS NULL OR summary->'request'->'accountIds' @> to_jsonb($4::int[]))`,[u.tenantId,clientId,audienceId,accountIds.length?accountIds:null]),
    providerConfigured(u.tenantId,"newsapi"),
    providerConfigured(u.tenantId,"perplexity"),
    providerConfigured(u.tenantId,"tavily"),
    providerConfigured(u.tenantId,"explorium"),
    providerConfigured(u.tenantId,"apollo"),
  ]);
  const reviewCounts={pending:0,approved:0,rejected:0};for(const row of counts.rows){if(row.review_status==="pending_review")reviewCounts.pending=Number(row.count);else if(row.review_status==="approved")reviewCounts.approved=Number(row.count);else if(row.review_status==="rejected")reviewCounts.rejected=Number(row.count);}
  const availableProviders=[...(perplexityConfigured?["perplexity"]:[]),...(tavilyConfigured?["tavily"]:[]),...(exploriumConfigured?["explorium"]:[]),...(newsConfigured?["newsapi"]:[])];
  res.json({providerConfigured:availableProviders.length>0,availableProviders,activeRunCount:Number(activeRuns.rows[0]?.count??0),contactProviderConfigured:contactConfigured,provider:availableProviders[0]??"manual",contactProvider:contactConfigured?"apollo":"manual",status:availableProviders.length?"ready":"provider_not_configured",liveProviderConfigured:availableProviders.length>0,...researchAnalysisAvailability(),eventTaxonomy:PUBLIC_EVENT_TYPES.map(key=>({key,label:key.replace(/_/g," ").replace(/\b\w/g,x=>x.toUpperCase())})),reviewCounts,latestRun:latest.rows[0]??null});
}catch(e){next(e);}});

router.get("/intent/discovery/runs",async(req,res,next)=>{try{
  const u=req.user as User,{page,pageSize}=pageOf(req);
  const q=await pool.query(`SELECT id,client_id AS "clientId",audience_id AS "audienceId",provider,status,attempts,criteria,summary,error,created_at AS "startedAt",completed_at AS "completedAt"
    FROM intent_contact_discovery_runs WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`,[u.tenantId,pageSize,(page-1)*pageSize]);
  res.json({runs:q.rows,page,pageSize});
}catch(e){next(e);}});

const discoverySchema=z.object({
  clientId:z.number().int().positive().optional(), audienceId:z.number().int().positive().optional(), accountIds:z.array(z.number().int().positive()).max(1000).optional(), provider:z.enum(["manual","demo","database","apollo"]).default("database"),
  idempotencyKey:z.string().trim().min(8).max(200), criteria:z.object({seniorities:z.array(z.string().max(100)).max(20).default([]),functions:z.array(z.string().max(100)).max(30).default([]),locations:z.array(z.string().max(160)).max(30).default([])}).default({seniorities:[],functions:[],locations:[]}),
  candidates:z.array(z.object({companyId:z.number().int().positive(),firstName:z.string().trim().max(120).optional(),lastName:z.string().trim().max(120).optional(),email:z.string().email().max(320).optional(),phone:z.string().max(80).optional(),title:z.string().max(250).optional(),function:z.string().max(120).optional(),location:z.string().max(250).optional(),sourceUrl:z.string().url().max(2000).optional(),confidence:z.number().int().min(0).max(100).default(50),rawEvidence:z.record(z.string(),z.unknown()).default({})})).max(5000).default([]),
});
router.post("/intent/discovery/preview",async(req,res,next)=>{try{
  const u=admin(req,res),p=discoverySchema.safeParse(req.body);if(!u)return;
  if(!p.success||!await hasClient(u.tenantId,p.data.clientId)||!await hasAudienceScope(u.tenantId,p.data.audienceId,p.data.clientId)){res.status(400).json({error:"Invalid discovery request"});return;}
  let candidates=[...p.data.candidates],providerStats:ProviderStats|undefined;
  let provider=candidates.length?p.data.provider:"database";
  if(!candidates.length){
    const seniorityPatterns=p.data.criteria.seniorities.flatMap(level=>({
      manager:["manager"],
      director:["director","head"],
      vp:["vice president","vp"],
      cxo:["chief","cxo","founder","owner"],
    }[level.toLowerCase()]??[level]));
    const dbContacts=await pool.query<any>(`SELECT ct.id,ct.company_id AS "companyId",ct.first_name AS "firstName",ct.last_name AS "lastName",ct.email,ct.phone,ct.title,ct.function,
      coalesce(ct.city,ct.state,ct.country,ct.hq_country) AS location
      FROM contacts ct JOIN companies co ON co.tenant_id=ct.tenant_id AND co.id=ct.company_id
      WHERE ct.tenant_id=$1 AND NOT coalesce(ct.is_anonymous,false)
        AND ($2::int IS NULL OR co.client_id=$2)
        AND ($3::int IS NULL OR EXISTS(SELECT 1 FROM intent_audience_companies ac WHERE ac.tenant_id=co.tenant_id AND ac.audience_id=$3 AND ac.company_id=co.id))
        AND ($4::int[] IS NULL OR co.id=ANY($4::int[]))
        AND ($5::text[] IS NULL OR EXISTS(SELECT 1 FROM unnest($5::text[]) pattern WHERE coalesce(ct.title,'') ILIKE '%'||pattern||'%'))
        AND ($6::text[] IS NULL OR EXISTS(SELECT 1 FROM unnest($6::text[]) requested WHERE coalesce(ct.function,'') ILIKE '%'||requested||'%' OR coalesce(ct.title,'') ILIKE '%'||requested||'%'))
        AND ($7::text[] IS NULL OR EXISTS(SELECT 1 FROM unnest($7::text[]) requested WHERE coalesce(ct.city,'') ILIKE '%'||requested||'%' OR coalesce(ct.state,'') ILIKE '%'||requested||'%' OR coalesce(ct.country,'') ILIKE '%'||requested||'%' OR coalesce(ct.hq_country,'') ILIKE '%'||requested||'%'))
      ORDER BY ct.updated_at DESC NULLS LAST,ct.id DESC LIMIT 5000`,[
        u.tenantId,p.data.clientId??null,p.data.audienceId??null,p.data.accountIds?.length?p.data.accountIds:null,
        seniorityPatterns.length?seniorityPatterns:null,p.data.criteria.functions.length?p.data.criteria.functions:null,p.data.criteria.locations.length?p.data.criteria.locations:null,
      ]);
    candidates=dbContacts.rows.map(contact=>({...contact,confidence:100,rawEvidence:{provider:"database",contactId:contact.id}}));
    if(!candidates.length&&await providerConfigured(u.tenantId,"apollo")){
      provider="apollo";
      try{const fetched=await fetchApolloContacts(u.tenantId,{clientId:p.data.clientId,audienceId:p.data.audienceId,accountIds:p.data.accountIds,...p.data.criteria});candidates=fetched.rows;providerStats=fetched.stats;}
      catch(error){
        const message=error instanceof Error?error.message:"Apollo discovery failed",stats=error instanceof IntentProviderError?error.stats:undefined;
        const failed=await pool.query<{id:number}>(`INSERT INTO intent_contact_discovery_runs(tenant_id,client_id,audience_id,provider,criteria,idempotency_key,status,summary,error,requested_by,completed_at) VALUES($1,$2,$3,'apollo',$4,$5,'failed',$6,$7,$8,NOW()) ON CONFLICT (tenant_id,idempotency_key) DO UPDATE SET status='failed',summary=EXCLUDED.summary,error=EXCLUDED.error,completed_at=NOW() RETURNING id`,[u.tenantId,p.data.clientId??null,p.data.audienceId??null,p.data.criteria,p.data.idempotencyKey,stats??{},message,u.id]);
        res.status(502).json({error:"provider_failed",message,runId:failed.rows[0]?.id,candidates:[],providerConfigured:true,stats});return;
      }
    }
  }
  const c=await pool.connect();try{await c.query("BEGIN");const old=await c.query<{id:number}>("SELECT id FROM intent_contact_discovery_runs WHERE tenant_id=$1 AND idempotency_key=$2",[u.tenantId,p.data.idempotencyKey]);if(old.rows[0]){await c.query("COMMIT");res.json({runId:old.rows[0].id,duplicate:true});return;}
    const storedCriteria={...p.data.criteria,provider:providerStats,databaseCount:provider==="database"?candidates.length:0};
    const runStatus=providerStats?.failures.length?"partial":"preview";
    const run=(await c.query<{id:number}>(`INSERT INTO intent_contact_discovery_runs(tenant_id,client_id,audience_id,provider,criteria,idempotency_key,status,summary,requested_by,completed_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW()) RETURNING id`,[u.tenantId,p.data.clientId??null,p.data.audienceId??null,provider,storedCriteria,p.data.idempotencyKey,runStatus,providerStats??{},u.id])).rows[0];
    const preview:any[]=[];for(const candidate of candidates){if(!await hasCompanyScope(u.tenantId,candidate.companyId,p.data.clientId,p.data.audienceId)){preview.push({...candidate,status:"invalid_company_scope"});continue;}const match=await matchEntities(u.tenantId,{email:candidate.email,phone:candidate.phone});const status=match.conflict||(match.contactId&&match.accountId!==candidate.companyId)?"uncertain_match":match.contactId?"matched":"pending_review";const row=(await c.query<{id:number}>(`INSERT INTO intent_contact_discovery_candidates(tenant_id,run_id,company_id,first_name,last_name,email,phone,title,function,location,source_url,provider,confidence,raw_evidence,match_status,canonical_contact_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id`,[u.tenantId,run.id,candidate.companyId,candidate.firstName??null,candidate.lastName??null,candidate.email?.toLowerCase()??null,candidate.phone??null,candidate.title??null,candidate.function??null,candidate.location??null,candidate.sourceUrl??null,provider,candidate.confidence,candidate.rawEvidence,status,match.contactId??null])).rows[0];preview.push({id:row.id,name:[candidate.firstName,candidate.lastName].filter(Boolean).join(" ")||candidate.email||"Unknown",title:candidate.title,location:candidate.location,function:candidate.function,email:candidate.email,confidence:candidate.confidence,source:provider,status,match});}await c.query("COMMIT");const providerAvailable=provider==="database"||await providerConfigured(u.tenantId,"apollo");const message=preview.length?`Found ${preview.length} matching contact${preview.length===1?"":"s"} in ${provider==="database"?"the database":"Apollo"}.`:providerAvailable?"No matching contacts were found in the database or Apollo.":"No matching database contacts were found. Connect Apollo to extend discovery.";res.status(201).json({runId:run.id,criteria:storedCriteria,candidates:preview,providerConfigured:providerAvailable,providerUsed:provider,databaseCount:provider==="database"?preview.length:0,message,status:runStatus});}catch(e){await c.query("ROLLBACK");throw e;}finally{c.release();}
}catch(e){next(e);}});
router.post("/intent/discovery/:runId/approve",async(req,res,next)=>{try{
  const u=admin(req,res),runId=positiveId(req.params.runId),p=z.object({candidateIds:z.array(z.number().int().positive()).min(1).max(5000)}).safeParse(req.body);if(!u)return;if(!runId||!p.success){res.status(400).json({error:"Invalid approval"});return;}
  const c=await pool.connect();let imported=0,alreadyPresent=0,needsReview=0;try{await c.query("BEGIN");const run=await c.query<{client_id:number|null}>("SELECT client_id FROM intent_contact_discovery_runs WHERE tenant_id=$1 AND id=$2",[u.tenantId,runId]);if(!run.rows[0]){await c.query("ROLLBACK");res.status(404).json({error:"Discovery run not found"});return;}
    const candidates=await c.query<any>("SELECT * FROM intent_contact_discovery_candidates WHERE tenant_id=$1 AND run_id=$2 AND id=ANY($3::int[]) FOR UPDATE",[u.tenantId,runId,p.data.candidateIds]);
    for(const x of candidates.rows){if(x.match_status==="uncertain_match"){needsReview++;continue;}if(x.canonical_contact_id){alreadyPresent++;await c.query("UPDATE intent_contact_discovery_candidates SET match_status='approved',reviewed_by=$1,reviewed_at=NOW() WHERE tenant_id=$2 AND id=$3",[u.id,u.tenantId,x.id]);continue;}
      const created=await c.query<{id:number}>(`INSERT INTO contacts(tenant_id,client_id,company_id,first_name,last_name,email,phone,title,function,city,source) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'intent_discovery') RETURNING id`,[u.tenantId,run.rows[0].client_id,x.company_id,x.first_name,x.last_name,x.email,x.phone,x.title,x.function,x.location]);
      await c.query("UPDATE intent_contact_discovery_candidates SET canonical_contact_id=$1,match_status='approved',reviewed_by=$2,reviewed_at=NOW() WHERE tenant_id=$3 AND id=$4",[created.rows[0].id,u.id,u.tenantId,x.id]);imported++;
    }await c.query("UPDATE intent_contact_discovery_runs SET status='completed',completed_at=NOW() WHERE tenant_id=$1 AND id=$2",[u.tenantId,runId]);await c.query("COMMIT");res.json({runId,imported,alreadyPresent,needsReview});}catch(e){await c.query("ROLLBACK");throw e;}finally{c.release();}
}catch(e){next(e);}});
router.post("/intent/contact-discovery",async(req,res,next)=>{try{
  const u=admin(req,res);if(!u)return;
  const p=z.object({clientId:z.number().int().positive().optional(),audienceId:z.number().int().positive().optional(),accountIds:z.array(z.number().int().positive()).max(1000).optional(),seniorities:z.array(z.string()).default([]),functions:z.array(z.string()).default([]),locations:z.array(z.string()).default([]),candidates:z.array(z.unknown()).optional()}).safeParse(req.body);
  if(!p.success||!await hasClient(u.tenantId,p.data.clientId)||!await hasAudienceScope(u.tenantId,p.data.audienceId,p.data.clientId)){res.status(400).json({error:"Invalid discovery request"});return;}
  if(!p.data.candidates?.length){
    res.status(503).json({error:"provider_not_configured",runId:null,candidates:[],providerConfigured:false,liveProviderConfigured:false,message:"A live contact enrichment provider is not configured"});return;
  }
  res.status(400).json({error:"Use /intent/discovery/preview for normalized provider candidates"});
}catch(e){next(e);}});
router.post("/intent/contact-discovery/approve",async(req,res,next)=>{try{
  const u=admin(req,res),p=z.object({runId:z.number().int().positive(),candidateIds:z.array(z.number().int().positive()).min(1).max(5000)}).safeParse(req.body);if(!u)return;
  if(!p.success){res.status(400).json({error:"runId and candidateIds are required"});return;}
  const c=await pool.connect();let approved=0,needsReview=0;try{await c.query("BEGIN");const run=await c.query<{client_id:number|null}>("SELECT client_id FROM intent_contact_discovery_runs WHERE tenant_id=$1 AND id=$2",[u.tenantId,p.data.runId]);if(!run.rows[0]){await c.query("ROLLBACK");res.status(404).json({error:"Discovery run not found"});return;}
    const rows=await c.query<any>("SELECT * FROM intent_contact_discovery_candidates WHERE tenant_id=$1 AND run_id=$2 AND id=ANY($3::int[]) FOR UPDATE",[u.tenantId,p.data.runId,p.data.candidateIds]);for(const x of rows.rows){if(x.match_status==="uncertain_match"){needsReview++;continue;}let contactId=x.canonical_contact_id;if(!contactId)contactId=(await c.query<{id:number}>("INSERT INTO contacts(tenant_id,client_id,company_id,first_name,last_name,email,phone,title,function,city,source) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'intent_discovery') RETURNING id",[u.tenantId,run.rows[0].client_id,x.company_id,x.first_name,x.last_name,x.email,x.phone,x.title,x.function,x.location])).rows[0].id;await c.query("UPDATE intent_contact_discovery_candidates SET canonical_contact_id=$1,match_status='approved',reviewed_by=$2,reviewed_at=NOW() WHERE tenant_id=$3 AND id=$4",[contactId,u.id,u.tenantId,x.id]);approved++;}await c.query("COMMIT");res.json({approved,needsReview});}catch(e){await c.query("ROLLBACK");throw e;}finally{c.release();}
}catch(e){next(e);}});

router.get(["/intent/heat-matrix","/intent/product-matrix"],async(req,res,next)=>{try{
  const u=req.user as User, rawPage=pageOf(req),pageSize=Math.min(50,rawPage.pageSize),page=rawPage.page,singular=positiveId(String(req.query.productId??"")),provided=positiveIds(req.query.productIds),productIds=[...new Set(singular?[singular]:provided)],audienceId=positiveId(String(req.query.audienceId??"")),clientId=positiveId(String(req.query.clientId??"")),categoryIds=positiveIds(req.query.categoryIds??req.query.categoryId),subcategoryIds=positiveIds(req.query.subcategoryIds??req.query.subcategoryId);
  const categoryName=typeof req.query.categoryName==="string"?req.query.categoryName.trim():"";
  if(categoryName&&!inboundCategories.includes(categoryName)){res.status(400).json({error:"Unknown category name"});return;}
  const categoryConfig=await loadInboundCategoryRules(u.tenantId);
  if(!await hasClient(u.tenantId,clientId??undefined)||!await hasAudienceScope(u.tenantId,audienceId??undefined,clientId??undefined)){res.status(400).json({error:"Invalid matrix scope"});return;}
    const products=productIds.length
      ? await pool.query<{id:number;name:string;subcategoryName:string|null}>(`SELECT p.id,p.name,s.name AS "subcategoryName" FROM intent_products p LEFT JOIN intent_product_subcategories s ON s.tenant_id=p.tenant_id AND s.id=p.subcategory_id WHERE p.tenant_id=$1 AND p.id=ANY($2::int[])`,[u.tenantId,productIds])
      : await pool.query<{id:number;name:string;subcategoryName:string|null}>(`SELECT p.id,p.name,s.name AS "subcategoryName" FROM intent_products p LEFT JOIN intent_product_subcategories s ON s.tenant_id=p.tenant_id AND s.id=p.subcategory_id WHERE p.tenant_id=$1 AND p.active=true AND ($2::int[] IS NULL OR p.category_id=ANY($2::int[])) AND ($3::int[] IS NULL OR p.subcategory_id=ANY($3::int[])) ORDER BY p.name LIMIT 100`,[u.tenantId,categoryIds.length?categoryIds:null,subcategoryIds.length?subcategoryIds:null]);
  if(productIds.length&&products.rows.length!==productIds.length){res.status(400).json({error:"Unknown product"});return;}
  const categoryForProductId=new Map(products.rows.map(product=>[product.id,inboundCategoryForInterest([product.name,product.subcategoryName].filter(Boolean).join(" "),null,categoryConfig).categoryName]));
  const selectedProducts=products.rows.filter(product=>
    !categoryName||categoryForProductId.get(product.id)===categoryName
  );
  const scope=`FROM companies c WHERE c.tenant_id=$1 AND ($2::int IS NULL OR c.client_id=$2) AND ($3::int IS NULL OR EXISTS(SELECT 1 FROM intent_audience_companies ac WHERE ac.tenant_id=c.tenant_id AND ac.audience_id=$3 AND ac.company_id=c.id))`;
  const [totalResult,companies]=await Promise.all([
    pool.query<{count:string}>(`SELECT count(*) ${scope}`,[u.tenantId,clientId,audienceId]),
    pool.query<{id:number;name:string;lastResearchedAt:Date|null}>(`SELECT c.id,c.name,c.last_researched_at AS "lastResearchedAt" ${scope} ORDER BY c.name LIMIT $4 OFFSET $5`,[u.tenantId,clientId,audienceId,pageSize,(page-1)*pageSize]),
  ]);
  const accountIds=companies.rows.map(x=>x.id), selectedProductIds=selectedProducts.map(x=>x.id);
  const [signals,contactCounts,tiers]=accountIds.length&&selectedProductIds.length?await Promise.all([
    pool.query<{account_id:number;product_id:number;key:string;label:string;max_points:number;half_life_days:number;strength:number;occurred_at:Date;summary:string|null;payload:unknown;source:string;evidence_excerpt:string|null;evidence_context:Record<string,unknown>|null;raw_evidence:unknown}>(`SELECT s.account_id,s.product_id,st.key,st.label,COALESCE(qs.max_points,st.max_points) AS max_points,st.half_life_days,s.strength,s.occurred_at,s.summary,s.payload,s.source,evidence.excerpt AS evidence_excerpt,evidence.context AS evidence_context,evidence.raw_evidence
      FROM intent_signals s JOIN intent_signal_types st ON st.id=s.signal_type_id AND st.tenant_id=s.tenant_id
      LEFT JOIN intent_questionnaire_settings qs ON qs.tenant_id=s.tenant_id AND st.key='questionnaire_' || qs.dimension
      LEFT JOIN LATERAL (SELECT excerpt,context,raw_evidence FROM intent_evidence
        WHERE tenant_id=s.tenant_id AND review_status='approved'
          AND (signal_id=s.id OR id=CASE WHEN s.payload->>'evidenceId' ~ '^[0-9]{1,9}$' THEN (s.payload->>'evidenceId')::int END)
        ORDER BY id DESC LIMIT 1) evidence ON true
      WHERE s.tenant_id=$1 AND s.account_id=ANY($2::int[]) AND s.product_id=ANY($3::int[]) AND (st.category='questionnaire' OR s.occurred_at>=NOW()-interval '${PUBLIC_RESEARCH_WINDOW_SQL}') AND st.active AND (s.expires_at IS NULL OR s.expires_at>NOW()) AND (NOT EXISTS(SELECT 1 FROM intent_evidence ie WHERE ie.tenant_id=s.tenant_id AND ie.signal_id=s.id) OR EXISTS(SELECT 1 FROM intent_evidence ie WHERE ie.tenant_id=s.tenant_id AND ie.signal_id=s.id AND ie.review_status='approved'))`,[u.tenantId,accountIds,selectedProductIds]),
    pool.query<{account_id:number;product_id:number;count:string}>(`SELECT account_id,product_id,count(DISTINCT contact_id) FROM intent_evidence WHERE tenant_id=$1 AND account_id=ANY($2::int[]) AND product_id=ANY($3::int[]) AND occurred_at>=NOW()-interval '${PUBLIC_RESEARCH_WINDOW_SQL}' AND contact_id IS NOT NULL GROUP BY account_id,product_id`,[u.tenantId,accountIds,selectedProductIds]),
    pool.query<{key:string;label:string;min_score:number}>("SELECT key,label,min_score FROM intent_tiers WHERE tenant_id=$1 AND active",[u.tenantId]),
  ]):[{rows:[]},{rows:[]},{rows:[]}];
  const purchaseSignalScopes=new Set<string>();
  const grouped=new Map<string,Map<string,{label:string;values:number[];originalValues:number[];latest:Date}>>();
  for(const s of signals.rows){
    if(s.source==="public_event"&&!isResearchGeographyEligible({
      excerpt:s.evidence_excerpt,context:s.evidence_context,raw_evidence:s.raw_evidence,
    }))continue;
    const key=`${s.account_id}:${s.product_id}`,types=grouped.get(key)??new Map(),g=types.get(s.key)??{label:s.label,values:[],originalValues:[],latest:new Date(s.occurred_at)},originalPoints=productSignalPoints(s.max_points,s.strength,s.payload);
    g.originalValues.push(originalPoints);g.values.push(originalPoints*signalDecay(s.key,(Date.now()-new Date(s.occurred_at).getTime())/86_400_000,s.half_life_days));
    if(new Date(s.occurred_at)>g.latest)g.latest=new Date(s.occurred_at);
    types.set(s.key,g);grouped.set(key,types);if(isPurchaseStageSignal(s))purchaseSignalScopes.add(key);
  }
  const contacts=new Map(contactCounts.rows.map(x=>[`${x.account_id}:${x.product_id}`,Number(x.count)]));
  const accounts=companies.rows.map(account=>({accountId:account.id,accountName:account.name,lastResearchedAt:account.lastResearchedAt,cells:selectedProducts.map(product=>{const scopeKey=`${account.id}:${product.id}`,types=grouped.get(scopeKey)??new Map(),contributions=[...types].map(([key,g])=>({key,label:g.label,points:Number(saturateRepeatedSignals(g.values).toFixed(2)),signalCount:g.values.length})),questionnaireAging=questionnaireAgingSummary([...types].filter(([key])=>key.startsWith("questionnaire_")).map(([,g])=>({currentValues:g.values,originalValues:g.originalValues})));if(contributions.length>1)contributions.push({key:"breadth_bonus",label:"Signal breadth bonus",points:Math.min(10,(contributions.length-1)*2),signalCount:contributions.length-1});const rawScore=Math.min(100,Math.round(contributions.reduce((n,x)=>n+x.points,0))),hasRecentPurchaseSignal=purchaseSignalScopes.has(scopeKey),gated=purchaseGateScore(rawScore,tiers.rows,hasRecentPurchaseSignal),score=gated.score,latest=[...types.values()].reduce<Date|null>((v,x)=>!v||x.latest>v?x.latest:v,null),tier=gated.tier;return {productId:product.id,productName:product.name,categoryName:categoryForProductId.get(product.id),score,status:tier,tier,hasRecentPurchaseSignal,trendDelta:0,lastSignalAt:latest,matchedContacts:contacts.get(scopeKey)??0,explanation:contributions.length?contributions.slice(0,2).map(x=>`${x.label}: ${x.points} pts`).join("; "):"No product-scoped evidence yet",contributions,questionnaireAging};})}));
   const total=Number(totalResult.rows[0]?.count??0);res.json({products:selectedProducts.map(product=>({...product,categoryName:categoryForProductId.get(product.id)})),accounts,page,pageSize,total,totalPages:Math.ceil(total/pageSize)});
}catch(e){next(e);}});

const inboundSourceBody=z.object({
  name:z.string().trim().min(1).max(120).default("Inbound forms"),
  clientId:z.number().int().positive(),
  folderUrl:z.string().trim().min(1).max(1000),
  formType:z.enum(["lead_form","event_feedback"]),
  enabled:z.boolean().default(true),
  fieldMappings:z.record(z.string(),z.enum(inboundMappingTargets)).default({}),
});

const inboundSourceColumns=`id,name,client_id AS "clientId",folder_url AS "folderUrl",form_type AS "formType",enabled,field_mappings AS "fieldMappings",
  last_synced_at AS "lastSyncedAt",last_sync_status AS "lastSyncStatus",last_sync_summary AS "lastSyncSummary",
  created_at AS "createdAt",updated_at AS "updatedAt"`;

class InboundSourceNotFoundError extends Error {}
class InboundSourceIdentityLockedError extends Error {}
class InboundSourceDuplicateFolderError extends Error {}

async function updateInboundSourceRecord(tenantId:number,id:number,data:z.infer<typeof inboundSourceBody>,folderId:string){
  const connection=await pool.connect();
  try{
    await connection.query("BEGIN");
    const current=await connection.query<{id:number;client_id:number;folder_id:string;form_type:string}>(
      "SELECT id,client_id,folder_id,form_type FROM intent_inbound_sources WHERE tenant_id=$1 AND id=$2 FOR UPDATE",[tenantId,id]);
    if(!current.rowCount)throw new InboundSourceNotFoundError();
    const old=current.rows[0];
    const submissions=await connection.query<{has_submissions:boolean}>(
      "SELECT EXISTS(SELECT 1 FROM intent_inbound_submissions WHERE tenant_id=$1 AND source_id=$2) AS has_submissions",[tenantId,id]);
    const identityChanged=old.client_id!==data.clientId||old.folder_id!==folderId||old.form_type!==data.formType;
    if(identityChanged&&submissions.rows[0]?.has_submissions)throw new InboundSourceIdentityLockedError();
    const saved=await connection.query<any>(`UPDATE intent_inbound_sources SET client_id=$1,name=$2,folder_url=$3,folder_id=$4,form_type=$5,
      enabled=$6,field_mappings=$7,updated_at=NOW() WHERE tenant_id=$8 AND id=$9 RETURNING ${inboundSourceColumns}`,
      [data.clientId,data.name,data.folderUrl,folderId,data.formType,data.enabled,data.fieldMappings,tenantId,id]);
    await connection.query("COMMIT");
    return saved.rows[0];
  }catch(error){
    await connection.query("ROLLBACK");
    if((error as {code?:string})?.code==="23505")throw new InboundSourceDuplicateFolderError();
    throw error;
  }finally{connection.release();}
}

function respondInboundSourceUpdateError(error:unknown,res:Response){
  if(error instanceof InboundSourceNotFoundError){res.status(404).json({error:"Inbound source not found"});return true;}
  if(error instanceof InboundSourceIdentityLockedError){
    res.status(409).json({error:"This source has imported submissions, so its folder, client, and form type cannot be changed. Create a new inbound source to keep campaign identity and history separate."});
    return true;
  }
  if(error instanceof InboundSourceDuplicateFolderError){
    res.status(409).json({error:"This Google Drive folder is already configured as an inbound source."});
    return true;
  }
  return false;
}

async function validatedInboundSourceId(req:Request,res:Response):Promise<number|null|undefined>{
  if(req.query.sourceId===undefined)return null;
  if(typeof req.query.sourceId!=="string"){res.status(400).json({error:"Invalid inbound source ID"});return;}
  const id=positiveId(req.query.sourceId);
  if(!id){res.status(400).json({error:"Invalid inbound source ID"});return;}
  const source=await pool.query(`SELECT 1 FROM intent_inbound_sources WHERE tenant_id=$1 AND id=$2
    AND ($3::int[] IS NULL OR client_id=ANY($3::int[]))`,[(req.user as User).tenantId,id,permittedClientIds(req)]);
  if(!source.rowCount){res.status(404).json({error:"Inbound source not found"});return;}
  return id;
}

router.get("/intent/inbound/sources",async(req,res,next)=>{try{
  const u=req.user as User;
  const sources=await pool.query<any>(`SELECT ${inboundSourceColumns} FROM intent_inbound_sources
    WHERE tenant_id=$1 AND ($2::int[] IS NULL OR client_id=ANY($2::int[])) ORDER BY id`,[u.tenantId,permittedClientIds(req)]);
  res.json({sources:sources.rows,googleDriveConnected:await googleDriveConnectionAvailable()});
}catch(e){next(e);}});

router.post("/intent/inbound/sources",async(req,res,next)=>{try{
  const u=admin(req,res),parsed=inboundSourceBody.safeParse(req.body);if(!u)return;
  if(!parsed.success){res.status(400).json({error:parsed.error.message});return;}
  const client=await pool.query("SELECT 1 FROM clients WHERE tenant_id=$1 AND id=$2",[u.tenantId,parsed.data.clientId]);
  if(!client.rowCount){res.status(400).json({error:"Invalid client"});return;}
  let folderId:string;try{folderId=driveFolderId(parsed.data.folderUrl);}catch(error){res.status(400).json({error:error instanceof Error?error.message:"Invalid Google Drive folder"});return;}
  try{
    const saved=await pool.query<any>(`INSERT INTO intent_inbound_sources
      (tenant_id,client_id,name,folder_url,folder_id,form_type,enabled,field_mappings,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING ${inboundSourceColumns}`,
      [u.tenantId,parsed.data.clientId,parsed.data.name,parsed.data.folderUrl,folderId,parsed.data.formType,parsed.data.enabled,parsed.data.fieldMappings,u.id]);
    res.status(201).json({source:saved.rows[0]});
  }catch(error){
    if((error as {code?:string})?.code==="23505"){res.status(409).json({error:"This Google Drive folder is already configured as an inbound source."});return;}
    throw error;
  }
}catch(e){next(e);}});

router.put("/intent/inbound/sources/:id",async(req,res,next)=>{try{
  const u=admin(req,res),id=positiveId(Array.isArray(req.params.id)?req.params.id[0]:req.params.id),parsed=inboundSourceBody.safeParse(req.body);
  if(!u)return;
  if(!id){res.status(400).json({error:"Invalid inbound source ID"});return;}
  if(!parsed.success){res.status(400).json({error:parsed.error.message});return;}
  const clientExists=await pool.query("SELECT 1 FROM clients WHERE tenant_id=$1 AND id=$2",[u.tenantId,parsed.data.clientId]);
  if(!clientExists.rowCount){res.status(400).json({error:"Invalid client"});return;}
  let folderId:string;try{folderId=driveFolderId(parsed.data.folderUrl);}catch(error){res.status(400).json({error:error instanceof Error?error.message:"Invalid Google Drive folder"});return;}
  try{res.json({source:await updateInboundSourceRecord(u.tenantId,id,parsed.data,folderId)});}
  catch(error){if(!respondInboundSourceUpdateError(error,res))throw error;}
}catch(e){next(e);}});

router.get("/intent/inbound/sources/:id/preview",async(req,res,next)=>{try{
  const u=admin(req,res),id=positiveId(Array.isArray(req.params.id)?req.params.id[0]:req.params.id);
  if(!u)return;
  if(!id){res.status(400).json({error:"Invalid inbound source ID"});return;}
  const source=await pool.query("SELECT 1 FROM intent_inbound_sources WHERE tenant_id=$1 AND id=$2",[u.tenantId,id]);
  if(!source.rowCount){res.status(404).json({error:"Inbound source not found"});return;}
  try{res.json(await previewInboundSource(u.tenantId,id));}
  catch(error){
    const message=error instanceof Error?error.message:"Google Drive preview failed";
    if(/connect|credential|auth|401|403/i.test(message)){res.status(409).json({error:"Connect Google Drive before previewing this folder."});return;}
    throw error;
  }
}catch(e){next(e);}});

router.post("/intent/inbound/sources/:id/sync",async(req,res,next)=>{try{
  const u=admin(req,res),id=positiveId(Array.isArray(req.params.id)?req.params.id[0]:req.params.id);if(!u)return;
  if(!id){res.status(400).json({error:"Invalid inbound source ID"});return;}
  const source=await pool.query<{enabled:boolean}>("SELECT enabled FROM intent_inbound_sources WHERE tenant_id=$1 AND id=$2",[u.tenantId,id]);
  if(!source.rows[0]){res.status(404).json({error:"Inbound source not found"});return;}
  if(!source.rows[0].enabled){res.status(409).json({error:"Enable this inbound source before syncing it."});return;}
  try{res.json(await syncInboundSource(u.tenantId,id));}
  catch(error){
    const message=error instanceof Error?error.message:"Google Drive sync failed";
    if(error instanceof MissingInboundCompanyMappingError){res.status(409).json({error:message,code:"MISSING_COMPANY_MAPPING"});return;}
    if(/connect|credential|auth|401|403/i.test(message)){res.status(409).json({error:"Connect Google Drive before syncing this folder."});return;}
    throw error;
  }
}catch(e){next(e);}});

router.get("/intent/inbound/source",async(req,res,next)=>{try{
  const u=req.user as User;
  const source=await pool.query<any>(`SELECT id,name,client_id AS "clientId",folder_url AS "folderUrl",form_type AS "formType",enabled,field_mappings AS "fieldMappings",
    last_synced_at AS "lastSyncedAt",last_sync_status AS "lastSyncStatus",last_sync_summary AS "lastSyncSummary",
    created_at AS "createdAt",updated_at AS "updatedAt"
    FROM intent_inbound_sources WHERE tenant_id=$1 AND ($2::int[] IS NULL OR client_id=ANY($2::int[]))
    ORDER BY id LIMIT 1`,[u.tenantId,permittedClientIds(req)]);
  res.json({source:source.rows[0]??null,googleDriveConnected:await googleDriveConnectionAvailable()});
}catch(e){next(e);}});

router.put("/intent/inbound/source",async(req,res,next)=>{try{
  const u=admin(req,res),parsed=inboundSourceBody.safeParse(req.body);if(!u)return;
  if(!parsed.success){res.status(400).json({error:parsed.error.message});return;}
  const client=await pool.query("SELECT 1 FROM clients WHERE tenant_id=$1 AND id=$2",[u.tenantId,parsed.data.clientId]);
  if(!client.rowCount){res.status(400).json({error:"Invalid client"});return;}
  let folderId:string;try{folderId=driveFolderId(parsed.data.folderUrl);}catch(error){res.status(400).json({error:error instanceof Error?error.message:"Invalid Google Drive folder"});return;}
  const existing=await pool.query<{id:number}>("SELECT id FROM intent_inbound_sources WHERE tenant_id=$1 ORDER BY id LIMIT 1",[u.tenantId]);
  if(existing.rows[0]){
    try{res.json({source:await updateInboundSourceRecord(u.tenantId,existing.rows[0].id,parsed.data,folderId)});}
    catch(error){if(!respondInboundSourceUpdateError(error,res))throw error;}
    return;
  }
  try{
    const saved=await pool.query<any>(`INSERT INTO intent_inbound_sources(tenant_id,client_id,name,folder_url,folder_id,form_type,enabled,field_mappings,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING ${inboundSourceColumns}`,
      [u.tenantId,parsed.data.clientId,parsed.data.name,parsed.data.folderUrl,folderId,parsed.data.formType,parsed.data.enabled,parsed.data.fieldMappings,u.id]);
    res.json({source:saved.rows[0]});
  }catch(error){
    if((error as {code?:string})?.code==="23505"){res.status(409).json({error:"This Google Drive folder is already configured as an inbound source."});return;}
    throw error;
  }
}catch(e){next(e);}});

router.get("/intent/inbound/source/preview",async(req,res,next)=>{try{
  const u=admin(req,res);if(!u)return;
  const source=await pool.query<{id:number}>("SELECT id FROM intent_inbound_sources WHERE tenant_id=$1 ORDER BY id LIMIT 1",[u.tenantId]);
  if(!source.rows[0]){res.status(400).json({error:"Configure a Google Drive folder first"});return;}
  try{res.json(await previewInboundSource(u.tenantId,source.rows[0].id));}
  catch(error){
    const message=error instanceof Error?error.message:"Google Drive preview failed";
    if(/connect|credential|auth|401|403/i.test(message)){res.status(409).json({error:"Connect Google Drive before previewing this folder."});return;}
    throw error;
  }
}catch(e){next(e);}});

router.post("/intent/inbound/source/sync",async(req,res,next)=>{try{
  const u=admin(req,res);if(!u)return;
  const source=await pool.query<{id:number;enabled:boolean}>("SELECT id,enabled FROM intent_inbound_sources WHERE tenant_id=$1 ORDER BY id LIMIT 1",[u.tenantId]);
  if(!source.rows[0]){res.status(400).json({error:"Configure and enable a Google Drive folder first"});return;}
  if(!source.rows[0].enabled){res.status(409).json({error:"Enable the first configured Google Drive source before syncing. The legacy sync endpoint does not fall through to other sources."});return;}
  try{res.json(await syncInboundSource(u.tenantId,source.rows[0].id));}
  catch(error){
    const message=error instanceof Error?error.message:"Google Drive sync failed";
    if(error instanceof MissingInboundCompanyMappingError){res.status(409).json({error:message,code:"MISSING_COMPANY_MAPPING"});return;}
    if(/connect|credential|auth|401|403/i.test(message)){res.status(409).json({error:"Connect Google Drive before syncing this folder."});return;}
    throw error;
  }
}catch(e){next(e);}});

const inboundDashboardFilters=(query:Record<string,unknown>,sourceId:number|null=null,clientIds:number[]|null=null)=>{
  const range=Number(query.dateRange);
  return {
    dateRange:[7,30,90,365].includes(range)?range:null,
    formType:query.formType==="lead_form"||query.formType==="event_feedback"?query.formType:null,
    category:typeof query.category==="string"&&inboundCategories.concat("Needs categorization","No Category").includes(query.category)?query.category:null,
    product:typeof query.product==="string"&&query.product.length<=120?query.product:null,
    sourceId,
    clientIds,
  } as const;
};

const categoryRuleBody=z.object({useBuiltin:z.boolean(),rules:z.array(z.object({
  categoryName:z.enum(["IT Hardware","Business Collaboration","Security","Business Services"]),
  terms:z.array(z.string().trim().min(2).max(100)).max(30),
})).length(4)});

class ManualInboundEmailConflictError extends Error {}

async function saveManualInboundContact(
  connection:PoolClient,
  tenantId:number,
  clientId:number,
  accountId:number,
  fields:ManualInboundAccountFields,
  accountName:string,
  preferredContactId:number|null=null,
) {
  const email=fields.contactEmail.trim().toLowerCase();
  await connection.query("SELECT pg_advisory_xact_lock($1::int,hashtext($2)::int)",[tenantId,email]);
  const existing=await connection.query<{id:number;company_id:number|null}>(
    `SELECT id,company_id FROM contacts WHERE tenant_id=$1 AND lower(btrim(email))=$2 ORDER BY id FOR UPDATE`,
    [tenantId,email]);
  if(existing.rows.some(contact=>contact.company_id!==accountId))throw new ManualInboundEmailConflictError();
  const preferred=preferredContactId?await connection.query<{id:number;company_id:number|null}>(
    "SELECT id,company_id FROM contacts WHERE tenant_id=$1 AND id=$2 FOR UPDATE",[tenantId,preferredContactId]):null;
  if(preferred?.rows[0]&&preferred.rows[0].company_id!==accountId)throw new ManualInboundEmailConflictError();
  const contactId=existing.rows[0]?.id??preferred?.rows[0]?.id;
  const [firstName,...lastParts]=fields.contactName.trim().split(/\s+/);
  const lastName=lastParts.join(" ")||null;
  if(contactId){
    await connection.query(`UPDATE contacts SET client_id=$3,company_id=$4,first_name=$5,last_name=$6,email=$7,
      phone=$8,title=$9,designation=$9,city=$10,company_name=$11,updated_at=NOW()
      WHERE tenant_id=$1 AND id=$2`,
      [tenantId,contactId,clientId,accountId,firstName,lastName,email,fields.contactPhone||null,fields.designation||null,fields.city||null,accountName]);
    return contactId;
  }
  const created=await connection.query<{id:number}>(`INSERT INTO contacts
    (tenant_id,client_id,company_id,first_name,last_name,email,phone,title,designation,city,company_name,source)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8,$9,$10,'manual') RETURNING id`,
    [tenantId,clientId,accountId,firstName,lastName,email,fields.contactPhone||null,fields.designation||null,fields.city||null,accountName]);
  return created.rows[0].id;
}

async function saveManualInboundResponse(
  connection:PoolClient,
  tenantId:number,
  clientId:number,
  accountId:number,
  contactId:number,
  productName:string,
  fields:ManualInboundAccountFields,
  responseId:number|null,
) {
  const submittedDate=fields.formType==="event_feedback"?fields.eventDate!:fields.formFilledDate!;
  const submittedAt=new Date(`${submittedDate}T00:00:00.000Z`);
  const classification=classifyInbound({
    productInterest:productName,
    timeframe:fields.purchaseTimeframeMonths,
    title:fields.designation,
    interest:true,
  });
  const eventFeedback=fields.formType==="event_feedback"?{
    eventName:fields.eventName??"",
    eventDate:fields.eventDate!,
    contactName:fields.contactName,
    contactEmail:fields.contactEmail.trim().toLowerCase(),
    contactPhone:fields.contactPhone??"",
    designation:fields.designation??"",
    city:fields.city??"",
    categoryName:fields.categoryName,
    productId:fields.productId,
    productName,
    purchaseTimeframeMonths:fields.purchaseTimeframeMonths??null,
    formType:fields.formType,
    manualProvenance:"manual",
  }:{};
  const affinityReviews={__categoryOverrides:{[productName]:fields.categoryName}};
  const rawFields={
    manualProvenance:"manual",
    companyName:fields.name,
    domain:fields.domain??"",
    industry:fields.industry??"",
    contactName:fields.contactName,
    firstName:fields.contactName.trim().split(/\s+/)[0]??"",
    lastName:fields.contactName.trim().split(/\s+/).slice(1).join(" "),
    contactEmail:fields.contactEmail.trim().toLowerCase(),
    email:fields.contactEmail.trim().toLowerCase(),
    contactPhone:fields.contactPhone??"",
    phone:fields.contactPhone??"",
    designation:fields.designation??"",
    title:fields.designation??"",
    city:fields.city??"",
    productId:fields.productId,
    productInterest:productName,
    categoryName:fields.categoryName,
    purchaseTimeframeMonths:fields.purchaseTimeframeMonths??null,
    timeframe:fields.purchaseTimeframeMonths==null?"":String(fields.purchaseTimeframeMonths),
    formType:fields.formType,
    eventName:fields.eventName??"",
    eventDate:fields.eventDate??"",
    formFilledDate:fields.formFilledDate??"",
    submittedAt:submittedDate,
  };
  const response=await connection.query<{id:number}>(responseId
    ?`UPDATE intent_inbound_submissions SET client_id=$3,contact_id=$4,drive_file_id=$5,drive_modified_at=NULL,
        row_key='manual-account-response',file_name='Manual entry',form_type=$6,classification=$7,
        classification_reason=$8,explicit_interest=$9,requested_demo=$10,purchase_timeframe_months=$11,
        is_decision_maker=$12,feedback=NULL,product_interest=$13,submitted_at=$14,affinity_reviews=$15::jsonb,
         event_feedback=$16::jsonb,
         raw_fields=$17::jsonb || CASE
           WHEN client_id=$3 AND contact_id=$4
             AND raw_fields->>'contactName'=$17::jsonb->>'contactName'
             AND raw_fields->>'contactEmail'=$17::jsonb->>'contactEmail'
             AND raw_fields ? 'trackedContact'
           THEN jsonb_build_object('trackedContact',raw_fields->'trackedContact')
           ELSE '{}'::jsonb END,updated_at=NOW()
      WHERE tenant_id=$1 AND id=$2 AND source_id IS NULL RETURNING id`
    :`INSERT INTO intent_inbound_submissions
        (tenant_id,source_id,client_id,account_id,contact_id,drive_file_id,row_key,file_name,form_type,
         classification,classification_reason,explicit_interest,requested_demo,purchase_timeframe_months,
         is_decision_maker,feedback,product_interest,submitted_at,affinity_reviews,event_feedback,raw_fields)
      VALUES($1,NULL,$2,$3,$4,$5,'manual-account-response','Manual entry',$6,$7,$8,$9,$10,$11,$12,NULL,$13,$14,$15::jsonb,$16::jsonb,$17::jsonb)
      RETURNING id`,
    responseId
      ?[tenantId,responseId,clientId,contactId,`manual-account-${accountId}`,fields.formType,classification.classification,classification.classificationReason,
        classification.explicitInterest,classification.requestedDemo,classification.purchaseTimeframeMonths,classification.isDecisionMaker,
        productName,submittedAt,JSON.stringify(affinityReviews),JSON.stringify(eventFeedback),JSON.stringify(rawFields)]
      :[tenantId,clientId,accountId,contactId,`manual-account-${accountId}`,fields.formType,classification.classification,classification.classificationReason,
        classification.explicitInterest,classification.requestedDemo,classification.purchaseTimeframeMonths,classification.isDecisionMaker,
        productName,submittedAt,JSON.stringify(affinityReviews),JSON.stringify(eventFeedback),JSON.stringify(rawFields)]);
  if(!response.rows[0])throw new Error("Manual inbound response could not be saved.");
  return response.rows[0].id;
}

const manualInboundAccountBody=AddManualInboundAccountBody.superRefine((value,ctx)=>{
  const dateIsValid=(date:string|undefined)=>!date||(!Number.isNaN(Date.parse(`${date}T00:00:00Z`))&&new Date(`${date}T00:00:00Z`).toISOString().slice(0,10)===date);
  if(!Number.isInteger(value.clientId))ctx.addIssue({code:"custom",path:["clientId"],message:"Select a valid client."});
  if(!Number.isInteger(value.productId))ctx.addIssue({code:"custom",path:["productId"],message:"Select a valid catalog product."});
  if(value.name.trim().length<2)ctx.addIssue({code:"custom",path:["name"],message:"Enter an account name with at least two characters."});
  if(!value.contactName.trim())ctx.addIssue({code:"custom",path:["contactName"],message:"Enter a contact name."});
  if(value.formType==="lead_form"&&!value.formFilledDate)ctx.addIssue({code:"custom",path:["formFilledDate"],message:"A form-filled date is required for lead forms."});
  if(value.formType==="event_feedback"&&!value.eventName?.trim())ctx.addIssue({code:"custom",path:["eventName"],message:"An event name is required for event feedback."});
  if(value.formType==="event_feedback"&&!value.eventDate)ctx.addIssue({code:"custom",path:["eventDate"],message:"An event date is required for event feedback."});
  for(const field of ["eventDate","formFilledDate"] as const)if(!dateIsValid(value[field]))ctx.addIssue({code:"custom",path:[field],message:"Enter a valid YYYY-MM-DD date."});
});
type ManualInboundAccountFields=apiZ.infer<typeof manualInboundAccountBody>;

async function findManualInboundProduct(connection:PoolClient,tenantId:number,fields:ManualInboundAccountFields) {
  const product=await connection.query<{name:string;subcategoryName:string|null}>(`
    SELECT p.name,s.name AS "subcategoryName" FROM intent_products p
    LEFT JOIN intent_product_subcategories s ON s.tenant_id=p.tenant_id AND s.id=p.subcategory_id
    WHERE p.tenant_id=$1 AND p.id=$2 AND p.active=true`,[tenantId,fields.productId]);
  if(!product.rows[0])return {error:"Select an active product from your tenant's catalog."} as const;
  const categoryRules=await loadInboundCategoryRules(tenantId);
  const resolved=inboundCategoryForInterest(
    [product.rows[0].name,product.rows[0].subcategoryName].filter(Boolean).join(" "),null,categoryRules,
  );
  if(resolved.categoryName!==fields.categoryName)
    return {error:"That product does not belong to the selected GTM OS category. Choose a matching product."} as const;
  return {name:product.rows[0].name} as const;
}

router.post("/intent/inbound/accounts",async(req,res,next)=>{try{
  const u=req.user as User;
  const parsed=manualInboundAccountBody.safeParse(req.body);
  if(!parsed.success){res.status(400).json({error:parsed.error.issues[0]?.message??"Enter all required account and inbound response details."});return;}
  const fields=parsed.data;
  const {clientId,name,domain,industry}=fields;
  if(!await hasClient(u.tenantId,clientId)){res.status(400).json({error:"Unknown client"});return;}
  const connection=await pool.connect();
  try{
    await connection.query("BEGIN");
    const hpClient=await isHpClient(u.tenantId,clientId,connection);
    if(hpClient){
      await connection.query("SELECT pg_advisory_xact_lock($1::int,914357)",[u.tenantId]);
      await connection.query("SELECT pg_advisory_xact_lock($1::int,$2::int)",[u.tenantId,clientId]);
    }
    await connection.query("SELECT pg_advisory_xact_lock($1::int,914358)",[u.tenantId]);
    const product=await findManualInboundProduct(connection,u.tenantId,fields);
    if("error" in product){await connection.query("ROLLBACK");res.status(400).json({error:product.error});return;}
    const hpMatch=hpClient?await resolveHpAccount(connection,u.tenantId,clientId,null,name,false):null;
    if(hpMatch&&!hpMatch.id&&hpMatch.reason!=="Account not matched"){
      await connection.query("ROLLBACK");res.status(409).json({error:`${hpMatch.reason}. Review the HP account identity first.`});return;
    }
    const matches=hpClient
      ? await connection.query<{id:number;name:string}>("SELECT id,name FROM companies WHERE tenant_id=$1 AND client_id=$2 AND id=$3 FOR UPDATE",[u.tenantId,clientId,hpMatch?.id??null])
      : await connection.query<{id:number;name:string}>(`SELECT id,name FROM companies
      WHERE tenant_id=$1 AND client_id=$2 AND (lower(name)=lower($3) OR ($4::text IS NOT NULL AND lower(domain)=lower($4)))
      ORDER BY id FOR UPDATE`,[u.tenantId,clientId,name,domain||null]);
    if((matches.rowCount??0)>1){await connection.query("ROLLBACK");res.status(409).json({error:"The account name and domain match different companies. Resolve the duplicate companies before adding this response."});return;}
    let accountId:number,created=false;
    if(matches.rows[0]){
      accountId=matches.rows[0].id;
      const existingResponse=await connection.query("SELECT 1 FROM intent_inbound_submissions WHERE tenant_id=$1 AND account_id=$2 LIMIT 1",[u.tenantId,accountId]);
      if(existingResponse.rowCount){await connection.query("ROLLBACK");res.status(409).json({error:"This account already has an inbound response. Edit its manual response instead."});return;}
      await connection.query(`UPDATE companies SET inbound_manual=true,inbound_manual_at=COALESCE(inbound_manual_at,NOW()),
        domain=COALESCE($3,domain),industry=COALESCE($4,industry),updated_at=NOW()
        WHERE tenant_id=$1 AND id=$2`,[u.tenantId,accountId,domain||null,industry||null]);
    }else{
      const createdAccount=await connection.query<{id:number}>(`INSERT INTO companies(tenant_id,client_id,name,domain,industry,inbound_manual,inbound_manual_at)
        VALUES($1,$2,$3,$4,$5,true,NOW()) RETURNING id`,[u.tenantId,clientId,name,domain||null,industry||null]);
      accountId=createdAccount.rows[0].id;created=true;
    }
    if(hpClient)await ensureHpProfile(connection,u.tenantId,clientId,accountId,name,created,"manual inbound");
    const contactId=await saveManualInboundContact(connection,u.tenantId,clientId,accountId,fields,name);
    const submissionId=await saveManualInboundResponse(connection,u.tenantId,clientId,accountId,contactId,product.name,fields,null);
    await connection.query("COMMIT");
    res.status(created?201:200).json({id:accountId,name,submissionId});
}catch(error){
    await connection.query("ROLLBACK");
    if(error instanceof ManualInboundEmailConflictError){res.status(409).json({error:"That contact email is already owned by a different company. Resolve the CRM contact ownership before saving."});return;}
    throw error;
  }finally{connection.release();}
}catch(e){next(e);}});

router.patch("/intent/inbound/accounts/:accountId/manual",async(req,res,next)=>{try{
  const u=req.user as User,accountId=positiveId(req.params.accountId);
  const parsed=manualInboundAccountBody.safeParse(req.body);
  if(!accountId||!parsed.success){res.status(400).json({error:parsed.success?"Enter a valid account id.":parsed.error.issues[0]?.message??"Enter all required account and inbound response details."});return;}
  const fields=parsed.data;
  const {clientId,name,domain,industry}=fields;
  const connection=await pool.connect();
  try{
    await connection.query("BEGIN");
    const account=await connection.query<{id:number;client_id:number;name:string}>("SELECT id,client_id,name FROM companies WHERE tenant_id=$1 AND id=$2 AND inbound_manual=true FOR UPDATE",[u.tenantId,accountId]);
    if(!account.rowCount){await connection.query("ROLLBACK");res.status(404).json({error:"Manual inbound account not found."});return;}
    const responses=await connection.query<{id:number;source_id:number|null;contact_id:number|null}>(
      "SELECT id,source_id,contact_id FROM intent_inbound_submissions WHERE tenant_id=$1 AND account_id=$2 ORDER BY id FOR UPDATE",[u.tenantId,accountId]);
    if(responses.rows.some(response=>response.source_id!==null)){
      await connection.query("ROLLBACK");res.status(409).json({error:"Imported inbound responses cannot be edited through manual account entry."});return;
    }
    if((responses.rowCount??0)>1){await connection.query("ROLLBACK");res.status(409).json({error:"This account has multiple manual responses. Edit the response record directly."});return;}
    if(clientId!==account.rows[0].client_id&&await hasLinkedCrmRecords(connection,u.tenantId,accountId)){
      await connection.query("ROLLBACK");
      res.status(409).json({error:"This company has contacts or deals. Keep its current client, or move the linked CRM records first."});return;
    }
    if(!await hasClient(u.tenantId,clientId)){await connection.query("ROLLBACK");res.status(400).json({error:"Unknown client"});return;}
    const product=await findManualInboundProduct(connection,u.tenantId,fields);
    if("error" in product){await connection.query("ROLLBACK");res.status(400).json({error:product.error});return;}
    const conflict=await connection.query(`SELECT 1 FROM companies WHERE tenant_id=$1 AND client_id=$2 AND id<>$3
      AND (lower(name)=lower($4) OR ($5::text IS NOT NULL AND lower(domain)=lower($5))) LIMIT 1`,
      [u.tenantId,clientId,accountId,name,domain||null]);
    if(conflict.rowCount){await connection.query("ROLLBACK");res.status(409).json({error:"Another account with that name or domain exists for this client."});return;}
    await connection.query(`UPDATE companies SET client_id=$3,name=$4,domain=$5,industry=$6,updated_at=NOW()
      WHERE tenant_id=$1 AND id=$2 RETURNING id,name`,[u.tenantId,accountId,clientId,name,domain||null,industry||null]);
    const contactId=await saveManualInboundContact(connection,u.tenantId,clientId,accountId,fields,name,responses.rows[0]?.contact_id??null);
    const submissionId=await saveManualInboundResponse(connection,u.tenantId,clientId,accountId,contactId,product.name,fields,responses.rows[0]?.id??null);
    await connection.query("COMMIT");
    res.json({id:accountId,name,submissionId});
  }catch(error){
    await connection.query("ROLLBACK");
    if(error instanceof ManualInboundEmailConflictError){res.status(409).json({error:"That contact email is already owned by a different company. Resolve the CRM contact ownership before saving."});return;}
    throw error;
  }finally{connection.release();}
}catch(e){next(e);}});

// A reviewed link is scoped to one journey and one manual account. The source
// contact's company, browser tokens, and historical events remain untouched.
// Anonymous verification deliberately records event IDs, not a token mapping:
// subsequent visits with the same browser token are never implicitly claimed.
function anonymousWindowQuery() {
  return `SELECT je.id,je.event_type AS "eventType",je.created_at AS "createdAt",
    jp.title AS "pageName",je.page_url AS "pageUrl"
    FROM journey_events je LEFT JOIN journey_pages jp ON jp.id=je.page_id
    WHERE je.tenant_id=$1 AND je.journey_id=$2 AND je.visitor_token=$3
      AND je.created_at >= $4 AND je.created_at < $4::timestamptz + interval '30 minutes'
      AND COALESCE(je.is_bot,false)=false
    ORDER BY je.created_at,je.id LIMIT 201`;
}
function anonymousActivityWindowQuery() {
  return `SELECT ae.id,ae.event_type AS "eventType",ae.created_at AS "createdAt",ae.page_name AS "pageName"
    FROM activity_events ae LEFT JOIN contacts ct ON ct.id=ae.contact_id AND ct.tenant_id=ae.tenant_id
    WHERE ae.tenant_id=$1 AND ae.journey_id=$2 AND ae.visitor_token=$3
      AND ae.created_at >= $4 AND ae.created_at < $4::timestamptz + interval '30 minutes'
      AND (ae.contact_id IS NULL OR ct.is_anonymous=true)
      AND COALESCE(ae.is_bot,false)=false
      AND NOT (ae.event_type='page_view' AND EXISTS (
        SELECT 1 FROM journey_events je LEFT JOIN journey_pages jp ON jp.id=je.page_id
        WHERE je.tenant_id=ae.tenant_id AND je.journey_id=ae.journey_id
          AND je.visitor_token=ae.visitor_token AND je.event_type='page_view'
          AND COALESCE(je.is_bot,false)=false
          AND je.created_at >= $4 AND je.created_at < $4::timestamptz + interval '30 minutes'
          AND ABS(EXTRACT(EPOCH FROM (je.created_at-ae.created_at)))<120
          AND NULLIF(TRIM(jp.title),'') IS NOT DISTINCT FROM NULLIF(TRIM(ae.page_name),'')
      ))
    ORDER BY ae.created_at,ae.id LIMIT 201`;
}
router.get("/intent/inbound/accounts/:accountId/anonymous-sessions",async(req,res,next)=>{try{
  const u=admin(req,res),accountId=positiveId(req.params.accountId);if(!u)return;
  if(!accountId){res.status(400).json({error:"Invalid account"});return;}
  const account=await pool.query(`SELECT id,client_id FROM companies WHERE tenant_id=$1 AND id=$2 AND inbound_manual=true`,[u.tenantId,accountId]);
  if(!account.rowCount){res.status(404).json({error:"Manual account not found"});return;}
  const journeyId=positiveId(req.query.journeyId as string);
  const anchorEventId=positiveId(req.query.anchorEventId as string);
  const search=typeof req.query.contactQuery==="string"?req.query.contactQuery.trim().slice(0,100):"";
  const [journeys,events,history,contacts]=await Promise.all([
    pool.query(`SELECT id,name FROM journeys WHERE tenant_id=$1 AND client_id=$2 ORDER BY name`,[u.tenantId,account.rows[0].client_id]),
    journeyId?pool.query(`SELECT je.id,je.created_at AS "createdAt",je.event_type AS "eventType",jp.title AS "pageName",
       LEFT(je.visitor_token,8) AS "tokenHint"
       FROM journey_events je JOIN journeys j ON j.id=je.journey_id AND j.tenant_id=je.tenant_id
       LEFT JOIN journey_pages jp ON jp.id=je.page_id
       WHERE je.tenant_id=$1 AND je.journey_id=$2 AND j.client_id=$3
         AND je.visitor_token IS NOT NULL AND je.event_type='page_view'
         AND COALESCE(je.is_bot,false)=false
         AND NOT EXISTS(SELECT 1 FROM visitor_tokens vt
           JOIN contacts known ON known.id=vt.contact_id AND known.tenant_id=vt.tenant_id AND known.is_anonymous=false
           WHERE vt.tenant_id=je.tenant_id AND vt.token=je.visitor_token)
         AND NOT EXISTS(SELECT 1 FROM form_submissions fs WHERE fs.tenant_id=je.tenant_id AND fs.visitor_token=je.visitor_token AND fs.contact_id IS NOT NULL)
         AND NOT EXISTS(SELECT 1 FROM verified_journey_sessions v WHERE v.tenant_id=je.tenant_id AND v.revoked_at IS NULL AND je.id=ANY(v.event_ids))
       ORDER BY je.created_at DESC LIMIT 50`,[u.tenantId,journeyId,account.rows[0].client_id]):Promise.resolve({rows:[]}),
    pool.query(`SELECT v.id,v.journey_id AS "journeyId",v.anchor_event_id AS "anchorEventId",
       v.event_ids AS "eventIds",v.activity_event_ids AS "activityEventIds",v.contact_id AS "contactId",v.evidence,v.reviewed_by AS "reviewedBy",v.reviewed_at AS "reviewedAt",
       v.revoked_at AS "revokedAt",v.revoke_reason AS "revokeReason",
       reviewer.email AS "reviewer", revoker.email AS "revoker"
       FROM verified_journey_sessions v
       LEFT JOIN users reviewer ON reviewer.id=v.reviewed_by AND reviewer.tenant_id=v.tenant_id
       LEFT JOIN users revoker ON revoker.id=v.revoked_by AND revoker.tenant_id=v.tenant_id
       WHERE v.tenant_id=$1 AND v.account_id=$2 ORDER BY v.id DESC LIMIT 100`,[u.tenantId,accountId]),
    search.length>=2?pool.query(`SELECT ct.id,ct.email,trim(concat_ws(' ',ct.first_name,ct.last_name)) AS name,
       co.name AS "accountName" FROM contacts ct
       LEFT JOIN companies co ON co.id=ct.company_id AND co.tenant_id=ct.tenant_id
       WHERE ct.tenant_id=$1 AND ct.is_anonymous=false
         AND (ct.email ILIKE $2 OR concat_ws(' ',ct.first_name,ct.last_name) ILIKE $2)
       ORDER BY ct.id DESC LIMIT 20`,[u.tenantId,`%${search}%`]):Promise.resolve({rows:[]}),
  ]);
  let preview: Array<{id:number;eventType:string;createdAt:Date;pageName:string|null;pageUrl:string|null}>=[];
  let activityPreview: Array<{id:number;eventType:string;createdAt:Date;pageName:string|null}>=[];
  if(anchorEventId && journeyId){
    const anchor=await pool.query(`SELECT id,visitor_token,created_at FROM journey_events
      WHERE tenant_id=$1 AND journey_id=$2 AND id=$3 AND event_type='page_view'
        AND COALESCE(is_bot,false)=false AND visitor_token IS NOT NULL
        AND NOT EXISTS(SELECT 1 FROM visitor_tokens vt
          JOIN contacts known ON known.id=vt.contact_id AND known.tenant_id=vt.tenant_id AND known.is_anonymous=false
          WHERE vt.tenant_id=$1 AND vt.token=journey_events.visitor_token)
        AND NOT EXISTS(SELECT 1 FROM form_submissions fs
          WHERE fs.tenant_id=$1 AND fs.visitor_token=journey_events.visitor_token AND fs.contact_id IS NOT NULL)
        AND NOT EXISTS(SELECT 1 FROM verified_journey_sessions v
          WHERE v.tenant_id=$1 AND v.revoked_at IS NULL AND journey_events.id=ANY(v.event_ids))`,
      [u.tenantId,journeyId,anchorEventId]);
    if(anchor.rowCount && journeys.rows.some(j=>j.id===journeyId)){
      const a=anchor.rows[0];
      const window=await pool.query(anonymousWindowQuery(),[u.tenantId,journeyId,a.visitor_token,a.created_at]);
      preview=window.rows;
      const activity=await pool.query(anonymousActivityWindowQuery(),[u.tenantId,journeyId,a.visitor_token,a.created_at]);
      activityPreview=activity.rows;
    }
  }
  res.json({journeys:journeys.rows,events:events.rows,history:history.rows,contacts:contacts.rows,preview,activityPreview});
}catch(e){next(e);}});

router.post("/intent/inbound/accounts/:accountId/anonymous-sessions",async(req,res,next)=>{try{
  const u=admin(req,res),accountId=positiveId(req.params.accountId);if(!u)return;
  const parsed=z.object({anchorEventId:z.number().int().positive(),contactId:z.number().int().positive(),
    evidence:z.string().trim().min(20).max(2000),confirm:z.literal(true)}).safeParse(req.body);
  if(!accountId||!parsed.success){res.status(400).json({error:"Select an event and contact, and describe the evidence (at least 20 characters)."});return;}
  const c=await pool.connect();
  try{
    await c.query("BEGIN");
    await c.query("SELECT pg_advisory_xact_lock($1::int,914360)",[u.tenantId]);
    const anchor=await c.query(`SELECT je.id,je.journey_id,je.visitor_token,je.created_at
      FROM journey_events je JOIN journeys j ON j.id=je.journey_id AND j.tenant_id=je.tenant_id
      JOIN companies co ON co.tenant_id=je.tenant_id AND co.client_id=j.client_id AND co.id=$2 AND co.inbound_manual=true
      WHERE je.tenant_id=$1 AND je.id=$3 AND je.event_type='page_view' AND COALESCE(je.is_bot,false)=false
        AND je.visitor_token IS NOT NULL`,[u.tenantId,accountId,parsed.data.anchorEventId]);
    const contact=await c.query(`SELECT id FROM contacts WHERE tenant_id=$1 AND id=$2 AND is_anonymous=false`,[u.tenantId,parsed.data.contactId]);
    if(!anchor.rowCount||!contact.rowCount){await c.query("ROLLBACK");res.status(404).json({error:"Event or contact is no longer eligible"});return;}
    const a=anchor.rows[0];
    // A bounded thirty-minute window anchored at the selected event. The IDs
    // and eligibility are frozen at review, so earlier/later visits stay anonymous.
    const session=await c.query(anonymousWindowQuery(),[u.tenantId,a.journey_id,a.visitor_token,a.created_at]);
    const activity=await c.query(anonymousActivityWindowQuery(),[u.tenantId,a.journey_id,a.visitor_token,a.created_at]);
    const resolved=await c.query(`SELECT 1 WHERE
      EXISTS(SELECT 1 FROM visitor_tokens vt
        JOIN contacts known ON known.id=vt.contact_id AND known.tenant_id=vt.tenant_id AND known.is_anonymous=false
        WHERE vt.tenant_id=$1 AND vt.token=$2)
      OR EXISTS(SELECT 1 FROM form_submissions WHERE tenant_id=$1 AND visitor_token=$2 AND contact_id IS NOT NULL)
      OR EXISTS(SELECT 1 FROM verified_journey_sessions v WHERE v.tenant_id=$1 AND v.revoked_at IS NULL
        AND (v.event_ids && $3::int[] OR v.activity_event_ids && $4::int[]))`,
      [u.tenantId,a.visitor_token,session.rows.map(r=>r.id),activity.rows.map(r=>r.id)]);
    if(resolved.rowCount||session.rows.length>200||activity.rows.length>200||!session.rows.length){
      await c.query("ROLLBACK");res.status(409).json({error:"This session is identified, already verified, or too large to review. Refresh the list."});return;
    }
    const saved=await c.query(`INSERT INTO verified_journey_sessions
      (tenant_id,account_id,contact_id,journey_id,anchor_event_id,event_ids,activity_event_ids,evidence,reviewed_by)
      VALUES($1,$2,$3,$4,$5,$6::int[],$7::int[],$8,$9)
      RETURNING id,event_ids AS "eventIds",reviewed_at AS "reviewedAt"`,
      [u.tenantId,accountId,parsed.data.contactId,a.journey_id,a.id,session.rows.map(r=>r.id),activity.rows.map(r=>r.id),parsed.data.evidence,u.id]);
    await c.query("COMMIT");res.status(201).json(saved.rows[0]);
  }catch(error){await c.query("ROLLBACK");throw error;}finally{c.release();}
}catch(e){next(e);}});

router.post("/intent/inbound/accounts/:accountId/anonymous-sessions/:id/revoke",async(req,res,next)=>{try{
  const u=admin(req,res),accountId=positiveId(req.params.accountId),id=positiveId(req.params.id);if(!u)return;
  const parsed=z.object({reason:z.string().trim().min(10).max(1000)}).safeParse(req.body);
  if(!accountId||!id||!parsed.success){res.status(400).json({error:"A revocation reason of at least 10 characters is required."});return;}
  const result=await pool.query(`UPDATE verified_journey_sessions SET revoked_at=NOW(),revoked_by=$4,revoke_reason=$5
    WHERE tenant_id=$1 AND account_id=$2 AND id=$3 AND revoked_at IS NULL RETURNING id`,
    [u.tenantId,accountId,id,u.id,parsed.data.reason]);
  if(!result.rowCount){res.status(404).json({error:"Active verification not found"});return;}
  res.json({revoked:true});
}catch(e){next(e);}});

router.get("/intent/inbound/accounts/:accountId/tracked-contact",async(req,res,next)=>{try{
  const u=admin(req,res),accountId=positiveId(req.params.accountId);if(!u)return;
  if(!accountId){res.status(400).json({error:"Invalid account"});return;}
  const record=await pool.query<{client_id:number;contact_id:number;raw_fields:Record<string,any>;account_added_at:Date|null}>(
    `SELECT s.client_id,s.contact_id,s.raw_fields,c.inbound_manual_at AS account_added_at FROM intent_inbound_submissions s
     JOIN companies c ON c.tenant_id=s.tenant_id AND c.id=s.account_id AND c.inbound_manual=true
     WHERE s.tenant_id=$1 AND s.account_id=$2 AND s.source_id IS NULL
       AND s.raw_fields->>'manualProvenance'='manual'
     ORDER BY s.id DESC LIMIT 1`,[u.tenantId,accountId]);
  const manual=record.rows[0];
  if(!manual?.contact_id){res.status(404).json({error:"This account has no manual contact to link."});return;}
  const [candidates,journeys]=await Promise.all([
    pool.query(`SELECT ct.id,trim(concat_ws(' ',ct.first_name,ct.last_name)) AS name,
         ct.email,coalesce(c.name,'No account') AS "accountName"
       FROM contacts ct LEFT JOIN companies c ON c.id=ct.company_id AND c.tenant_id=ct.tenant_id
       WHERE ct.tenant_id=$1 AND ct.id<>$2 AND ct.is_anonymous=false
         AND lower(trim(concat_ws(' ',ct.first_name,ct.last_name)))=lower($3)
         AND EXISTS (SELECT 1 FROM visitor_tokens vt WHERE vt.tenant_id=ct.tenant_id AND vt.contact_id=ct.id)
       ORDER BY ct.id LIMIT 20`,
      [u.tenantId,manual.contact_id,String(manual.raw_fields.contactName??"").trim()]),
    pool.query(`SELECT id,name FROM journeys WHERE tenant_id=$1 AND client_id=$2 ORDER BY name`,
      [u.tenantId,manual.client_id]),
  ]);
  res.json({candidates:candidates.rows,journeys:journeys.rows,linked:manual.raw_fields.trackedContact??null,
    accountAddedAt:manual.account_added_at});
}catch(e){next(e);}});

router.post("/intent/inbound/accounts/:accountId/tracked-contact",async(req,res,next)=>{try{
  const u=admin(req,res),accountId=positiveId(req.params.accountId);if(!u)return;
  const parsed=z.union([
    z.object({contactId:z.number().int().positive(),journeyId:z.number().int().positive(),confirmSamePerson:z.literal(true),
      startDate:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(date=>{
        const parsed=new Date(`${date}T00:00:00Z`);
        return !Number.isNaN(parsed.getTime())&&parsed.toISOString().slice(0,10)===date&&parsed.getTime()<=Date.now();
      }).optional()}),
    z.object({contactId:z.null(),journeyId:z.null()}),
  ]).safeParse(req.body);
  if(!accountId||!parsed.success){res.status(400).json({error:"Select a tracked contact and journey, and confirm they are the same person."});return;}
  const connection=await pool.connect();
  try{
    await connection.query("BEGIN");
    await connection.query("SELECT pg_advisory_xact_lock($1::int,914359)",[u.tenantId]);
    const record=await connection.query<{id:number;client_id:number;contact_id:number;raw_fields:Record<string,any>}>(
      `SELECT s.id,s.client_id,s.contact_id,s.raw_fields FROM intent_inbound_submissions s
       JOIN companies c ON c.tenant_id=s.tenant_id AND c.id=s.account_id AND c.inbound_manual=true
       WHERE s.tenant_id=$1 AND s.account_id=$2 AND s.source_id IS NULL
         AND s.raw_fields->>'manualProvenance'='manual'
       ORDER BY s.id DESC LIMIT 1 FOR UPDATE OF s`,[u.tenantId,accountId]);
    const manual=record.rows[0];
    if(!manual?.contact_id){await connection.query("ROLLBACK");res.status(404).json({error:"Manual contact not found."});return;}
    if(parsed.data.contactId===null){
      await connection.query(`UPDATE intent_inbound_submissions SET raw_fields=raw_fields-'trackedContact',updated_at=NOW()
        WHERE tenant_id=$1 AND id=$2`,[u.tenantId,manual.id]);
      await connection.query("COMMIT");res.json({linked:null});return;
    }
    const {contactId,journeyId,startDate}=parsed.data;
    const [candidate,journey,conflict]=await Promise.all([
      connection.query(`SELECT ct.id FROM contacts ct
        WHERE ct.tenant_id=$1 AND ct.id=$2 AND ct.id<>$3 AND ct.is_anonymous=false
          AND lower(trim(concat_ws(' ',ct.first_name,ct.last_name)))=lower($4)
          AND EXISTS(SELECT 1 FROM visitor_tokens vt WHERE vt.tenant_id=ct.tenant_id AND vt.contact_id=ct.id)`,
        [u.tenantId,contactId,manual.contact_id,String(manual.raw_fields.contactName??"").trim()]),
      connection.query(`SELECT 1 FROM journeys WHERE tenant_id=$1 AND id=$2 AND client_id=$3`,
        [u.tenantId,journeyId,manual.client_id]),
      connection.query(`SELECT 1 FROM intent_inbound_submissions s WHERE s.tenant_id=$1 AND s.account_id<>$2
        AND s.raw_fields->'trackedContact'->>'contactId'=$3::text
        AND s.raw_fields->'trackedContact'->>'journeyId'=$4::text LIMIT 1`,
        [u.tenantId,accountId,contactId,journeyId]),
    ]);
    if(!candidate.rowCount||!journey.rowCount||conflict.rowCount){
      await connection.query("ROLLBACK");
      res.status(409).json({error:conflict.rowCount?"This tracked contact is already linked to another account on that journey.":"Contact or journey is no longer eligible for this account."});return;
    }
    const linked={contactId,journeyId,reviewedBy:u.id,reviewedAt:new Date().toISOString(),
      ...(startDate?{effectiveFrom:`${startDate}T00:00:00.000Z`}:{})};
    await connection.query(`UPDATE intent_inbound_submissions SET
      raw_fields=jsonb_set(raw_fields,'{trackedContact}',$3::jsonb),updated_at=NOW()
      WHERE tenant_id=$1 AND id=$2`,[u.tenantId,manual.id,JSON.stringify(linked)]);
    await connection.query("COMMIT");res.json({linked});
  }catch(error){await connection.query("ROLLBACK");throw error;}finally{connection.release();}
}catch(e){next(e);}});

router.delete("/intent/inbound/accounts/:accountId/manual",async(req,res,next)=>{try{
  const u=req.user as User,accountId=positiveId(req.params.accountId);
  if(!accountId){res.status(400).json({error:"Invalid account"});return;}
  const connection=await pool.connect();
  try{
    await connection.query("BEGIN");
    const account=await connection.query("SELECT id FROM companies WHERE tenant_id=$1 AND id=$2 AND inbound_manual=true FOR UPDATE",[u.tenantId,accountId]);
    if(!account.rowCount){await connection.query("ROLLBACK");res.status(404).json({error:"Manual inbound account not found."});return;}
    const responses=await connection.query("SELECT 1 FROM intent_inbound_submissions WHERE tenant_id=$1 AND account_id=$2 LIMIT 1",[u.tenantId,accountId]);
    if(responses.rowCount){await connection.query("ROLLBACK");res.status(409).json({error:"This account now has a form response and cannot be removed from Inbound Accounts."});return;}
    await connection.query("UPDATE companies SET inbound_manual=false,inbound_manual_at=NULL,updated_at=NOW() WHERE tenant_id=$1 AND id=$2",[u.tenantId,accountId]);
    await connection.query("COMMIT");
    res.sendStatus(204);
  }catch(error){await connection.query("ROLLBACK");throw error;}finally{connection.release();}
}catch(e){next(e);}});

router.get("/intent/inbound/category-rules",async(req,res,next)=>{try{
  const u=req.user as User;
  res.json({...await loadInboundCategoryRules(u.tenantId),categories:inboundCategories});
}catch(e){next(e);}});

router.put("/intent/inbound/category-rules",async(req,res,next)=>{try{
  const u=admin(req,res);if(!u)return;
  const parsed=categoryRuleBody.safeParse(req.body);
  if(!parsed.success){res.status(400).json({error:"Provide matching terms for each of the four categories (2–100 characters per term)."});return;}
  const rules=parsed.data.rules;
  if(new Set(rules.map(rule=>rule.categoryName)).size!==4){res.status(400).json({error:"Provide each category exactly once."});return;}
  const error=validateInboundCategoryRules(rules);
  if(error){res.status(400).json({error});return;}
  await pool.query(`INSERT INTO intent_inbound_category_rules(tenant_id,rules,use_builtin) VALUES($1,$2::jsonb,$3)
    ON CONFLICT (tenant_id) DO UPDATE SET rules=EXCLUDED.rules,use_builtin=EXCLUDED.use_builtin,updated_at=NOW()`,
    [u.tenantId,JSON.stringify(rules),parsed.data.useBuiltin]);
  res.json({rules,useBuiltin:parsed.data.useBuiltin});
}catch(e){next(e);}});

router.get("/intent/inbound/dashboard",async(req,res,next)=>{try{
  const u=req.user as User;
  const sourceId=await validatedInboundSourceId(req,res);if(sourceId===undefined)return;
  await repairInboundProductInterestClassifications(u.tenantId);
  const {accountIds,submissionIds,...dashboard}=await getInboundDashboard(u.tenantId,inboundDashboardFilters(req.query,sourceId,permittedClientIds(req)));
  res.json(dashboard);
}catch(e){next(e);}});

router.get("/intent/inbound/contacts",async(req,res,next)=>{try{
  const u=req.user as User,{page,pageSize}=pageOf(req);
  const sourceId=await validatedInboundSourceId(req,res);if(sourceId===undefined)return;
  await repairInboundProductInterestClassifications(u.tenantId);
  res.json(await getInboundContactPage(u.tenantId,inboundDashboardFilters(req.query,sourceId,permittedClientIds(req)),page,pageSize));
}catch(e){next(e);}});

router.get("/intent/inbound/accounts",async(req,res,next)=>{try{
  const u=req.user as User,{page,pageSize}=pageOf(req),classification=String(req.query.classification??"");
  const sourceId=await validatedInboundSourceId(req,res);if(sourceId===undefined)return;
  await repairInboundProductInterestClassifications(u.tenantId);
  const search=String(req.query.search??"").trim(),filter=["hot","warm","cold","manual"].includes(classification)?classification:null;
  const formType=String(req.query.formType??"");
  let selectedFormType:"lead_form"|"event_feedback"|null=formType==="lead_form"||formType==="event_feedback"?formType:null;
  if(sourceId){
    const source=await pool.query<{form_type:string}>("SELECT form_type FROM intent_inbound_sources WHERE tenant_id=$1 AND id=$2",[u.tenantId,sourceId]);
    if(!source.rows[0]){res.status(404).json({error:"Inbound source not found"});return;}
    if(selectedFormType&&source.rows[0].form_type!==selectedFormType){res.status(400).json({error:"Inbound source type does not match"});return;}
    selectedFormType??=source.rows[0].form_type as "lead_form"|"event_feedback";
  }
  const dashboardFilters=inboundDashboardFilters(req.query,sourceId,permittedClientIds(req));
  const submissionIds=dashboardFilters.clientIds!==null||dashboardFilters.dateRange||dashboardFilters.category||dashboardFilters.product
    ?(await getInboundDashboard(u.tenantId,{...dashboardFilters,formType:selectedFormType})).submissionIds:null;
  const params=[u.tenantId,sourceId,selectedFormType,filter,search||null,submissionIds,dashboardFilters.dateRange,!sourceId&&!selectedFormType&&!dashboardFilters.category&&!dashboardFilters.product,pageSize,(page-1)*pageSize,dashboardFilters.clientIds];
  const base=`FROM (
    SELECT * FROM (SELECT DISTINCT ON (s.account_id)
      s.account_id,s.client_id,c.name,c.domain,c.industry,
       CASE WHEN EXISTS(SELECT 1 FROM intent_inbound_submissions history
           WHERE history.tenant_id=s.tenant_id AND history.account_id=s.account_id AND ($2::int IS NULL OR history.source_id=$2) AND history.classification='hot') THEN 'hot'
        WHEN EXISTS(SELECT 1 FROM intent_inbound_submissions history
           WHERE history.tenant_id=s.tenant_id AND history.account_id=s.account_id AND ($2::int IS NULL OR history.source_id=$2) AND history.classification='warm') THEN 'warm'
        ELSE 'cold' END AS classification,
      max(COALESCE(s.submitted_at,s.created_at)) OVER(PARTITION BY s.account_id) AS submitted_at,
      max(s.created_at) OVER(PARTITION BY s.account_id) AS imported_at,
      count(*) OVER(PARTITION BY s.account_id)::int AS response_count,
      s.form_type,s.classification_reason,s.product_interest,s.feedback,s.event_feedback,s.purchase_timeframe_months,
      (SELECT jsonb_build_object(
        'clientId',manual.client_id,'name',manual.raw_fields->'companyName','domain',manual.raw_fields->'domain','industry',manual.raw_fields->'industry',
        'editable',NOT EXISTS(SELECT 1 FROM intent_inbound_submissions other
          WHERE other.tenant_id=manual.tenant_id AND other.account_id=manual.account_id AND other.source_id IS NOT NULL),
        'contactName',manual.raw_fields->'contactName','contactEmail',manual.raw_fields->'contactEmail','contactPhone',manual.raw_fields->'contactPhone',
        'designation',manual.raw_fields->'designation','city',manual.raw_fields->'city','productId',manual.raw_fields->'productId',
        'categoryName',manual.raw_fields->'categoryName','purchaseTimeframeMonths',manual.raw_fields->'purchaseTimeframeMonths',
        'formType',manual.raw_fields->'formType','eventName',manual.raw_fields->'eventName','eventDate',manual.raw_fields->'eventDate',
        'formFilledDate',manual.raw_fields->'formFilledDate'
      ) FROM intent_inbound_submissions manual
        WHERE manual.tenant_id=s.tenant_id AND manual.account_id=s.account_id AND manual.source_id IS NULL
          AND manual.raw_fields->>'manualProvenance'='manual' AND $2::int IS NULL
        ORDER BY manual.updated_at DESC,manual.id DESC LIMIT 1) AS manual_details,
      CASE WHEN ct.id IS NULL THEN NULL ELSE jsonb_build_object(
        'id',ct.id,'name',trim(concat_ws(' ',ct.first_name,ct.last_name)),
        'email',ct.email,'phone',ct.phone,'title',ct.title
      ) END AS contact
    FROM intent_inbound_submissions s JOIN companies c ON c.tenant_id=s.tenant_id AND c.id=s.account_id
    LEFT JOIN contacts ct ON ct.tenant_id=s.tenant_id AND ct.id=s.contact_id
    WHERE s.tenant_id=$1 AND ($2::int IS NULL OR s.source_id=$2) AND ($3::text IS NULL OR s.form_type=$3)
      AND ($11::int[] IS NULL OR s.client_id=ANY($11::int[]))
      AND ${canonicalInboundSubmissionSql("s")}
      AND ($6::int[] IS NULL OR s.id=ANY($6::int[]))
      AND ($7::int IS NULL OR COALESCE(s.submitted_at,s.created_at)>=NOW()-$7::int*INTERVAL '1 day')
    ORDER BY s.account_id,CASE s.classification WHEN 'hot' THEN 0 WHEN 'warm' THEN 1 ELSE 2 END,s.created_at DESC,s.id DESC) responses
    UNION ALL
    SELECT c.id,c.client_id,c.name,c.domain,c.industry,NULL::text,NULL::timestamptz,COALESCE(c.inbound_manual_at,c.created_at),0,
      'manual'::text,'Manually added; no inbound response yet.'::text,NULL::text,NULL::text,
      '{}'::jsonb,NULL::int,NULL::jsonb,NULL::jsonb
    FROM companies c WHERE c.tenant_id=$1 AND c.inbound_manual=true AND $8::boolean
      AND ($11::int[] IS NULL OR c.client_id=ANY($11::int[]))
      AND ($7::int IS NULL OR COALESCE(c.inbound_manual_at,c.created_at)>=NOW()-$7::int*INTERVAL '1 day')
          AND NOT EXISTS(SELECT 1 FROM intent_inbound_submissions s WHERE s.tenant_id=c.tenant_id AND s.account_id=c.id)
  ) inbound WHERE ($4::text IS NULL OR ($4='manual' AND (classification IS NULL OR manual_details IS NOT NULL)) OR classification=$4)
    AND ($5::text IS NULL OR name ILIKE '%'||$5||'%' OR domain ILIKE '%'||$5||'%' OR contact->>'email' ILIKE '%'||$5||'%')`;
  const [rows,count,summary,eventRows]=await Promise.all([
    pool.query<any>(`SELECT * ${base} ORDER BY CASE classification WHEN 'hot' THEN 0 WHEN 'warm' THEN 1 ELSE 2 END,COALESCE(submitted_at,imported_at) DESC LIMIT $9 OFFSET $10`,params),
    pool.query<{count:string}>(`SELECT count(*) ${base.replaceAll("$11","$9")}`,[...params.slice(0,8),dashboardFilters.clientIds]),
    pool.query<{hot:string;warm:string;cold:string}>(`SELECT count(DISTINCT account_id) FILTER(WHERE classification='hot') AS hot,
      count(DISTINCT account_id) FILTER(WHERE classification='warm' AND account_id NOT IN
         (SELECT account_id FROM intent_inbound_submissions WHERE tenant_id=$1 AND ($2::int IS NULL OR source_id=$2) AND ($3::text IS NULL OR form_type=$3) AND classification='hot'
           AND ($4::int[] IS NULL OR id=ANY($4::int[]))
           AND ($5::int IS NULL OR COALESCE(submitted_at,created_at)>=NOW()-$5::int*INTERVAL '1 day'))) AS warm,
      count(DISTINCT account_id) FILTER(WHERE classification='cold' AND account_id NOT IN
         (SELECT account_id FROM intent_inbound_submissions WHERE tenant_id=$1 AND ($2::int IS NULL OR source_id=$2) AND ($3::text IS NULL OR form_type=$3) AND classification IN ('hot','warm')
           AND ($4::int[] IS NULL OR id=ANY($4::int[]))
           AND ($5::int IS NULL OR COALESCE(submitted_at,created_at)>=NOW()-$5::int*INTERVAL '1 day'))) AS cold
       FROM intent_inbound_submissions WHERE tenant_id=$1 AND ($2::int IS NULL OR source_id=$2) AND ($3::text IS NULL OR form_type=$3)
         AND ($4::int[] IS NULL OR id=ANY($4::int[]))
         AND ($5::int IS NULL OR COALESCE(submitted_at,created_at)>=NOW()-$5::int*INTERVAL '1 day')`,
        [u.tenantId,sourceId,selectedFormType,submissionIds,dashboardFilters.dateRange]),
    selectedFormType==="event_feedback"
      ?pool.query<{event_feedback:Record<string,unknown>;product_interest:string|null}>(
         `SELECT event_feedback,product_interest FROM intent_inbound_submissions s
          WHERE tenant_id=$1 AND form_type='event_feedback' AND ($2::int IS NULL OR source_id=$2)
             AND ${canonicalInboundSubmissionSql("s")}
            AND ($3::int[] IS NULL OR id=ANY($3::int[]))`,
          [u.tenantId,sourceId,submissionIds])
      :Promise.resolve({rows:[]}),
  ]);
   const pageAccountIds=rows.rows.map((row:any)=>Number(row.account_id));
    const [respondentRows,respondentProducts,accountOverviews,routeRules,categoryRules]=pageAccountIds.length?await Promise.all([
    pool.query<any>(`SELECT s.account_id AS "accountId",s.id AS "submissionId",s.contact_id AS "contactId",
       s.client_id AS "clientId",s.routed_rule_id AS "routedRuleId",
      trim(concat_ws(' ',ct.first_name,ct.last_name)) AS "contactName",ct.title AS "contactTitle",
      ct.email AS "contactEmail",s.product_interest AS "productInterest",s.affinity_reviews AS "affinityReviews",
      s.raw_fields AS "rawFields",src.field_mappings AS "fieldMappings",s.updated_at AS "updatedAt",
       s.identity_review AS "identityReview",s.reviewed_source_account_id AS "reviewedSourceAccountId",
      s.classification,s.routing_status AS "routingStatus",s.routing_error AS "routingError",
       mr.selection AS "manualSelection",mr.journey_id AS "manualJourneyId",mr.sequence_id AS "manualSequenceId",
       mj.name AS "manualJourneyName",ms.name AS "manualSequenceName",
       (s.classification='warm' AND s.routing_status='routed' AND EXISTS (
         SELECT 1 FROM journey_contacts jc
         JOIN journeys history_journey ON history_journey.id=jc.journey_id AND history_journey.tenant_id=s.tenant_id
         WHERE jc.contact_id=s.contact_id
           AND jc.journey_id=COALESCE(mr.journey_id,history_rule.journey_id)
       )) AS "hasWarmJourneyHistory"
      FROM intent_inbound_submissions s
      LEFT JOIN contacts ct ON ct.tenant_id=s.tenant_id AND ct.id=s.contact_id
      LEFT JOIN intent_inbound_sources src ON src.tenant_id=s.tenant_id AND src.id=s.source_id
      LEFT JOIN intent_inbound_manual_routes mr ON mr.tenant_id=s.tenant_id AND mr.submission_id=s.id
       LEFT JOIN intent_inbound_routing_rules history_rule ON history_rule.tenant_id=s.tenant_id AND history_rule.id=s.routed_rule_id
       LEFT JOIN journeys mj ON mj.tenant_id=s.tenant_id AND mj.id=mr.journey_id
       LEFT JOIN email_sequences ms ON ms.tenant_id=s.tenant_id AND ms.id=mr.sequence_id
        WHERE s.tenant_id=$1 AND s.account_id=ANY($2::int[]) AND ($3::int IS NULL OR s.source_id=$3)
         AND ${canonicalInboundSubmissionSql("s")}
      ORDER BY s.created_at DESC,s.id DESC`,
         [u.tenantId,pageAccountIds,sourceId]),
    pool.query<any>(`SELECT p.id,p.name,c.name AS category,s.name AS subcategory
      FROM intent_products p JOIN intent_product_categories c ON c.id=p.category_id AND c.tenant_id=p.tenant_id
      LEFT JOIN intent_product_subcategories s ON s.id=p.subcategory_id AND s.tenant_id=p.tenant_id
      WHERE p.tenant_id=$1 AND p.active=true`,[u.tenantId]),
     pool.query<any>(`SELECT DISTINCT ON (s.account_id) s.account_id,
       CASE WHEN bool_or(s.classification='hot') OVER(PARTITION BY s.account_id) THEN 'hot'
         WHEN bool_or(s.classification='warm') OVER(PARTITION BY s.account_id) THEN 'warm' ELSE 'cold' END AS classification,
       max(COALESCE(s.submitted_at,s.created_at)) OVER(PARTITION BY s.account_id) AS submitted_at,
       max(s.created_at) OVER(PARTITION BY s.account_id) AS imported_at,
       count(*) OVER(PARTITION BY s.account_id)::int AS response_count,
       s.form_type,s.classification_reason,s.product_interest,s.feedback,s.event_feedback,s.purchase_timeframe_months
       FROM intent_inbound_submissions s
        WHERE s.tenant_id=$1 AND s.account_id=ANY($2::int[]) AND ($3::int IS NULL OR s.source_id=$3)
         AND ${canonicalInboundSubmissionSql("s")}
       ORDER BY s.account_id,CASE s.classification WHEN 'hot' THEN 0 WHEN 'warm' THEN 1 ELSE 2 END,s.created_at DESC,s.id DESC`,
        [u.tenantId,pageAccountIds,sourceId]),
     pool.query<NamedInboundRule>(`SELECT r.id,r.client_id,r.match_type,r.classification,r.keywords,
       r.journey_id,r.sequence_id,r.inbound_product_name,r.inbound_category_name,
       p.name AS product_name,pc.name AS category_name,r.enabled,
       j.name AS "journeyName",es.name AS "sequenceName",es.status AS "sequenceStatus"
       FROM intent_inbound_routing_rules r
       LEFT JOIN journeys j ON j.tenant_id=r.tenant_id AND j.id=r.journey_id
       LEFT JOIN email_sequences es ON es.tenant_id=r.tenant_id AND es.id=r.sequence_id
       LEFT JOIN intent_products p ON p.tenant_id=r.tenant_id AND p.id=r.product_id
       LEFT JOIN intent_product_categories pc ON pc.tenant_id=r.tenant_id AND pc.id=r.category_id
       WHERE r.tenant_id=$1 ORDER BY r.priority,r.id`,[u.tenantId]),
     loadInboundCategoryRules(u.tenantId),
    ]):[{rows:[]},{rows:[]},{rows:[]},{rows:[]},{rules:[],useBuiltin:true}];
  const respondents=groupInboundRespondents(applyAccountCategoryReviews(respondentRows.rows.map((row:any)=>({
    ...row,productAffinity:row.productInterest,
  }))),respondentProducts.rows);
   const hotAccountIds=new Set<number>(accountOverviews.rows.filter((row:any)=>row.classification==="hot").map((row:any)=>Number(row.account_id)));
   const destinations=accountRoutingDestinations(respondentRows.rows,routeRules.rows,respondentProducts.rows,categoryRules,hotAccountIds);
   const candidateEmails=[...new Set(respondentRows.rows.filter((row:any)=>!row.identityReview)
     .map((row:any)=>String(canonicalizeInbound(row.rawFields??{},row.fieldMappings??{}).email??"").trim().toLowerCase())
     .filter(Boolean))];
   const ownerRows:{email:string;company_id:number|null}[]=candidateEmails.length?(await pool.query<{email:string;company_id:number|null}>(`
     SELECT lower(btrim(email)) AS email,company_id FROM contacts
     WHERE tenant_id=$1 AND lower(btrim(email))=ANY($2::text[])`,[u.tenantId,candidateEmails])).rows:[];
   const conflictCounts=new Map<number,number>();
   for(const response of respondentRows.rows){
     if(response.identityReview)continue;
     const email=String(canonicalizeInbound(response.rawFields??{},response.fieldMappings??{}).email??"").trim().toLowerCase();
     if(ownerRows.some(owner=>owner.email===email && Number(owner.company_id)!==Number(response.reviewedSourceAccountId??response.accountId))){
       const id=Number(response.accountId);
       conflictCounts.set(id,(conflictCounts.get(id)??0)+1);
     }
   }
   const overviewByAccount=new Map(accountOverviews.rows.map((overview:any)=>[Number(overview.account_id),overview]));
  const total=Number(count.rows[0]?.count??0);
  res.json({accounts:rows.rows.map((row:any)=>{
    const people=respondents.get(Number(row.account_id))??[];
    const primary=people.find(person=>person.isPrimary);
      return {...row,...overviewByAccount.get(Number(row.account_id)),respondents:people,
       identityConflictCount:conflictCounts.get(Number(row.account_id))??0,
       routes:destinations.get(Number(row.account_id))??[],contact:primary?{
      id:primary.id,name:primary.name,title:primary.title,email:primary.email,
    }:row.contact};
  }),page,pageSize,total,totalPages:Math.ceil(total/pageSize),
    summary:{hot:Number(summary.rows[0]?.hot??0),warm:Number(summary.rows[0]?.warm??0),cold:Number(summary.rows[0]?.cold??0)},
    eventFeedbackSummary:selectedFormType==="event_feedback"?summarizeEventFeedback(eventRows.rows):null});
}catch(e){next(e);}});

router.get("/intent/inbound/accounts/:accountId/responses",async(req,res,next)=>{try{
  const u=req.user as User,accountId=positiveId(req.params.accountId);
  if(!accountId){res.status(400).json({error:"Invalid account"});return;}
  const sourceId=await validatedInboundSourceId(req,res);if(sourceId===undefined)return;
  const account=await pool.query("SELECT name FROM companies WHERE tenant_id=$1 AND id=$2",[u.tenantId,accountId]);
  if(!account.rowCount){res.status(404).json({error:"Account not found"});return;}
  const [responses,products,categoryRules]=await Promise.all([
    pool.query<any>(`SELECT s.id,s.form_type AS "formType",s.file_name AS "fileName",COALESCE(s.submitted_at,s.created_at) AS "submittedAt",
      CASE WHEN s.raw_fields ? '__submissionDateOverride' THEN 'edited'
        WHEN s.submitted_at IS NULL OR s.raw_fields->>'__submissionDateOrigin'='upload' THEN 'upload' ELSE 'source' END AS "submissionDateOrigin",
      s.classification,s.classification_reason AS "classificationReason",s.product_interest AS "productInterest",
       s.account_id AS "accountId",s.client_id AS "clientId",s.product_interest AS "productAffinity",s.updated_at AS "updatedAt",
       (s.raw_fields-'__submissionDateOverride'-'__submissionDateOrigin'-'__submissionDateEditedBy'-'__submissionDateEditedAt') AS "answers",s.affinity_reviews AS "affinityReviews",
       s.contact_id AS "contactId",s.identity_review AS "identityReview",
       s.identity_reviewed_by AS "identityReviewedBy",s.identity_reviewed_at AS "identityReviewedAt",
       NULLIF(trim(concat_ws(' ',reviewer.first_name,reviewer.last_name)),'') AS "identityReviewerName",
       s.reviewed_source_account_id AS "reviewedSourceAccountId",s.reviewed_source_contact_id AS "reviewedSourceContactId",
       src.field_mappings AS "fieldMappings"
       FROM intent_inbound_submissions s
       LEFT JOIN users reviewer ON reviewer.tenant_id=s.tenant_id AND reviewer.id=s.identity_reviewed_by
       LEFT JOIN intent_inbound_sources src ON src.tenant_id=s.tenant_id AND src.id=s.source_id
        WHERE s.tenant_id=$1 AND s.account_id=$2 AND ($3::int IS NULL OR s.source_id=$3)
         AND ${canonicalInboundSubmissionSql("s")}
       ORDER BY s.created_at DESC,s.id DESC LIMIT 501`,[u.tenantId,accountId,sourceId]),
    pool.query<any>(`SELECT p.id,p.name,c.name AS category,s.name AS subcategory
      FROM intent_products p JOIN intent_product_categories c ON c.id=p.category_id AND c.tenant_id=p.tenant_id
      LEFT JOIN intent_product_subcategories s ON s.id=p.subcategory_id AND s.tenant_id=p.tenant_id
      WHERE p.tenant_id=$1 AND p.active=true`,[u.tenantId]),
    loadInboundCategoryRules(u.tenantId),
  ]);
  const catalog=products.rows.map((p:any)=>({id:Number(p.id),name:String(p.name),category:String(p.category),subcategory:p.subcategory?String(p.subcategory):null}));
   const emails=[...new Set(responses.rows.map((row:any)=>String(canonicalizeInbound(row.answers??{},row.fieldMappings??{}).email??"").trim().toLowerCase()).filter(Boolean))];
   const phones=[...new Set(responses.rows.map((row:any)=>String(canonicalizeInbound(row.answers??{},row.fieldMappings??{}).phone??"").trim()).filter(Boolean))];
   const contacts=await pool.query<any>(`SELECT ct.id,ct.company_id AS "accountId",ct.client_id AS "clientId",
     trim(concat_ws(' ',ct.first_name,ct.last_name)) AS name,ct.email,ct.phone,
     co.name AS "accountName"
     FROM contacts ct LEFT JOIN companies co ON co.tenant_id=ct.tenant_id AND co.id=ct.company_id
     WHERE ct.tenant_id=$1 AND (ct.id=ANY($2::int[]) OR lower(btrim(ct.email))=ANY($3::text[]) OR ct.phone=ANY($4::text[]))
     ORDER BY ct.id`,
     [u.tenantId,responses.rows.flatMap((row:any)=>[row.contactId,row.reviewedSourceContactId]).filter(Boolean),emails,phones]);
   const contactById=new Map(contacts.rows.map((ct:any)=>[Number(ct.id),ct]));
   const accountNames=await pool.query<{id:number;name:string}>(`SELECT id,name FROM companies WHERE tenant_id=$1
     AND id=ANY($2::int[])`,[u.tenantId,[accountId,...responses.rows.map((row:any)=>row.reviewedSourceAccountId).filter(Boolean)]]);
   const nameById=new Map(accountNames.rows.map(row=>[Number(row.id),row.name]));
  res.json({accountName:account.rows[0].name,hasMore:responses.rows.length>500,
    responses:applyAccountCategoryReviews(responses.rows).slice(0,500).map((row:any)=>({
       ...row,fieldMappings:undefined,missingCategory:categoryForMissingInterest(row.affinityReviews),
       identityConflict:(()=>{
         const email=String(canonicalizeInbound(row.answers??{},row.fieldMappings??{}).email??"").trim().toLowerCase();
         const sourceAccountId=Number(row.reviewedSourceAccountId??row.accountId);
         const owners=contacts.rows.filter((ct:any)=>ct.email?.trim().toLowerCase()===email && Number(ct.accountId)!==sourceAccountId);
         const owner=owners[0];
         if(!owner)return null;
         const formPhone=String(canonicalizeInbound(row.answers??{},row.fieldMappings??{}).phone??"").trim();
         const sourceContact=contactById.get(Number(row.reviewedSourceContactId??row.contactId))??
           contacts.rows.find((ct:any)=>formPhone&&ct.phone===formPhone&&Number(ct.accountId)===sourceAccountId)??null;
         return {email,sourceAccountId,sourceAccountName:nameById.get(sourceAccountId)??null,
           sourceContact,owner,review:row.identityReview,
           reviewedById:row.identityReviewedBy,reviewedByName:row.identityReviewerName,
           reviewedAt:row.identityReviewedAt,
           canKeep:Boolean(sourceContact&&formPhone&&sourceContact.phone===formPhone&&Number(sourceContact.accountId)===sourceAccountId),
           canRelink:owners.length===1&&Number(owner.clientId)===Number(row.clientId)&&Boolean(owner.accountId),
           ambiguousOwners:owners.length>1};
       })(),
      affinities:splitSelections(row.productInterest).filter((selection:string)=>!(/^(?:n\/?a|none|no|nil|not interested|-+)$/i.test(selection)))
        .map((selection:string)=>({selection,derivedProduct:inferProductsFromInterest(selection,catalog)[0]?.name??null,
          categoryName:inboundCategoryForInterest(selection,row.affinityReviews,categoryRules).categoryName,
          review:row.affinityReviews?.[selection]??"unreviewed"})),
    }))});
}catch(e){next(e);}});

router.post("/intent/inbound/responses/:id/identity-review",async(req,res,next)=>{try{
  const u=admin(req,res),id=positiveId(String(req.params.id));if(!u)return;
  const parsed=z.object({action:z.enum(["keep","relink"]),ownerContactId:z.number().int().positive(),
    sourceAccountId:z.number().int().positive(),sourceContactId:z.number().int().positive().nullable(),
    email:z.string().email()}).safeParse(req.body);
  if(!id||!parsed.success){res.status(400).json({error:"Review both records and select a valid resolution"});return;}
  const connection=await pool.connect();
  try{
    await connection.query("BEGIN");
    await connection.query("SELECT pg_advisory_xact_lock($1::int,914357)",[u.tenantId]);
    const row=await connection.query<any>(`SELECT s.*,src.field_mappings FROM intent_inbound_submissions s
      LEFT JOIN intent_inbound_sources src ON src.tenant_id=s.tenant_id AND src.id=s.source_id
      WHERE s.tenant_id=$1 AND s.id=$2 FOR UPDATE OF s`,[u.tenantId,id]);
    const submission=row.rows[0];
    if(!submission){await connection.query("ROLLBACK");res.status(404).json({error:"Response not found"});return;}
    const email=String(canonicalizeInbound(submission.raw_fields??{},submission.field_mappings??{}).email??"").trim().toLowerCase();
    const sourceAccountId=Number(submission.reviewed_source_account_id??submission.account_id);
    const sourceContactId=submission.identity_review==="relink"?submission.reviewed_source_contact_id:submission.contact_id;
    const owner=await connection.query<any>(`SELECT id,company_id,client_id FROM contacts WHERE tenant_id=$1
      AND lower(btrim(email))=$2 ORDER BY id FOR UPDATE`,[u.tenantId,email]);
    const target=owner.rows.find((person:any)=>Number(person.id)===parsed.data.ownerContactId);
    if(owner.rows.length!==1||!target||!email||email!==parsed.data.email.trim().toLowerCase()||
      sourceAccountId!==parsed.data.sourceAccountId||
      (sourceContactId!==null&&sourceContactId!==parsed.data.sourceContactId)||
      !target.company_id||Number(target.company_id)===sourceAccountId||
      (parsed.data.action==="relink"&&Number(target.client_id)!==Number(submission.client_id))){
      await connection.query("ROLLBACK");res.status(409).json({error:"Contact or form evidence changed. Refresh and review again."});return;
    }
    if(parsed.data.action==="keep"&&!parsed.data.sourceContactId){
      await connection.query("ROLLBACK");res.status(409).json({error:"No source contact is linked. Correct the source record before keeping this link."});return;
    }
    if(parsed.data.action==="keep"){
      const source=await connection.query(`SELECT 1 FROM contacts WHERE tenant_id=$1 AND id=$2 AND company_id=$3
        AND phone=$4`,[u.tenantId,parsed.data.sourceContactId,sourceAccountId,
          String(canonicalizeInbound(submission.raw_fields??{},submission.field_mappings??{}).phone??"").trim()]);
      if(!source.rowCount){await connection.query("ROLLBACK");res.status(409).json({error:"Source contact evidence changed; refresh and review again."});return;}
    }
    await connection.query(`UPDATE intent_inbound_submissions SET
      account_id=$1,contact_id=$2,identity_review=$3,reviewed_email=$4,reviewed_source_account_id=$5,
      reviewed_source_contact_id=$10,identity_reviewed_by=$11,identity_reviewed_at=NOW(),
      routing_status=CASE WHEN routing_status='routed' THEN 'routed' ELSE $6 END,
      routing_error=CASE WHEN routing_status='routed' THEN routing_error ELSE $7 END,updated_at=NOW()
      WHERE tenant_id=$8 AND id=$9`,
      [parsed.data.action==="relink"?target.company_id:sourceAccountId,
       parsed.data.action==="relink"?target.id:parsed.data.sourceContactId,parsed.data.action,email,sourceAccountId,
       parsed.data.action==="relink"?"pending":"error",
       parsed.data.action==="keep"?"Form email belongs to another contact; no automatic email routing for this response.":null,u.tenantId,id,
       parsed.data.sourceContactId,u.id]);
    await connection.query("COMMIT");
    res.json({review:parsed.data.action});
  }catch(error){await connection.query("ROLLBACK");throw error;}finally{connection.release();}
}catch(e){next(e);}});

router.delete("/intent/inbound/responses/:id",async(req,res,next)=>{try{
  const u=admin(req,res),id=positiveId(String(req.params.id));if(!u)return;
  if(!id){res.status(400).json({error:"Invalid response"});return;}
  if(!await deleteOneInboundResponse(u.tenantId,id)){res.status(404).json({error:"Response not found"});return;}
  res.sendStatus(204);
}catch(e){next(e);}});

registerInboundSubmissionDateRoute(router);

router.patch("/intent/inbound/responses/:id/category",async(req,res,next)=>{try{
  const u=admin(req,res),id=positiveId(req.params.id);if(!u)return;
  const parsed=z.object({selection:z.string().trim().min(1).max(200).nullable(),
    category:z.enum(["IT Hardware","Business Collaboration","Security","Business Services"]).nullable()}).safeParse(req.body);
  if(!id||!parsed.success){res.status(400).json({error:"Choose a valid product interest and category"});return;}
  const row=await pool.query<{account_id:number;product_interest:string|null}>(`SELECT account_id,product_interest FROM intent_inbound_submissions WHERE tenant_id=$1 AND id=$2`,[u.tenantId,id]);
  if(!row.rowCount){res.status(404).json({error:"Response not found"});return;}
  if(parsed.data.selection===null){
    if(splitSelections(row.rows[0].product_interest).some(selection=>!/^(?:n\/?a|none|no|nil|not interested|-+)$/i.test(selection))){
      res.status(400).json({error:"This response has a product answer. Correct that interest instead."});return;
    }
    await pool.query(`UPDATE intent_inbound_submissions
      SET affinity_reviews=CASE WHEN $1::text IS NULL THEN COALESCE(affinity_reviews,'{}'::jsonb)-'__missingCategory'
        ELSE COALESCE(affinity_reviews,'{}'::jsonb)||jsonb_build_object('__missingCategory',$1::text) END,
        updated_at=NOW() WHERE tenant_id=$2 AND id=$3`,
      [parsed.data.category,u.tenantId,id]);
    await routePendingWarmSubmissions(u.tenantId,[id]);
    res.json({category:parsed.data.category,updatedResponses:1});return;
  }
  const selection=parsed.data.selection;
  if(!splitSelections(row.rows[0].product_interest).includes(selection)){
    res.status(400).json({error:"Interest is not part of this response"});return;
  }
  const accountResponses=await pool.query<{id:number;product_interest:string|null}>(`SELECT id,product_interest
    FROM intent_inbound_submissions WHERE tenant_id=$1 AND account_id=$2`,
    [u.tenantId,row.rows[0].account_id]);
  const matchingIds=accountResponses.rows.filter(response=>
    splitSelections(response.product_interest).includes(selection)).map(response=>response.id);
  await pool.query(`UPDATE intent_inbound_submissions
    SET affinity_reviews=jsonb_set(COALESCE(affinity_reviews,'{}'::jsonb),'{__categoryOverrides}',
      CASE WHEN $1::text IS NULL THEN COALESCE(affinity_reviews->'__categoryOverrides','{}'::jsonb)-$2::text
        ELSE COALESCE(affinity_reviews->'__categoryOverrides','{}'::jsonb)||jsonb_build_object($2::text,$1::text)
      END,true),updated_at=NOW()
    WHERE tenant_id=$3 AND id=ANY($4::int[])`,
    [parsed.data.category,parsed.data.selection,u.tenantId,matchingIds]);
  await routePendingWarmSubmissions(u.tenantId,matchingIds);
  res.json({category:parsed.data.category,updatedResponses:matchingIds.length});
}catch(e){next(e);}});

router.patch("/intent/inbound/responses/:id/affinity-review",async(req,res,next)=>{try{
  const u=admin(req,res),id=positiveId(req.params.id);
  if(!u)return;
  const parsed=z.object({selection:z.string().min(1).max(200),review:z.enum(["confirmed","rejected"])}).safeParse(req.body);
  if(!id||!parsed.success){res.status(400).json({error:"Choose a valid interest and review status"});return;}
  const row=await pool.query<{product_interest:string|null}>(`SELECT product_interest FROM intent_inbound_submissions WHERE tenant_id=$1 AND id=$2`,[u.tenantId,id]);
  if(!row.rowCount){res.status(404).json({error:"Response not found"});return;}
  if(!splitSelections(row.rows[0].product_interest).includes(parsed.data.selection)){
    res.status(400).json({error:"Interest is not part of this response"});return;
  }
  await pool.query(`UPDATE intent_inbound_submissions SET affinity_reviews=jsonb_set(affinity_reviews,ARRAY[$1::text],to_jsonb($2::text),true),updated_at=NOW()
    WHERE tenant_id=$3 AND id=$4`,[parsed.data.selection,parsed.data.review,u.tenantId,id]);
  res.json({review:parsed.data.review});
}catch(e){next(e);}});

router.post("/intent/inbound/responses/:id/route",async(req,res,next)=>{try{
  const u=admin(req,res),id=positiveId(req.params.id);
  if(!u)return;
  const parsed=z.object({
    selection:z.string().trim().min(1).max(200),
    journeyId:z.number().int().positive(),sequenceId:z.number().int().positive(),
    startSequence:z.boolean().default(false),
  }).safeParse(req.body);
  if(!id||!parsed.success){res.status(400).json({error:"Choose a product interest, journey and sequence"});return;}
  const result=await routeInboundRespondent(u.tenantId,id,parsed.data.selection,parsed.data.journeyId,parsed.data.sequenceId,
    {startSequence:parsed.data.startSequence});
  if("error" in result){res.status(result.status).json({error:result.error});return;}
  res.json(result);
}catch(e){next(e);}});

const inboundRoutingRuleBody=z.object({
  name:z.string().trim().min(1).max(120),clientId:z.number().int().positive(),
  classification:z.enum(["hot","warm","all"]).default("warm"),
  matchType:z.enum(["product","category","fallback"]),productId:z.number().int().positive().nullable().default(null),
  productName:z.string().trim().min(1).max(120).nullable().default(null),
  categoryName:z.string().trim().min(1).max(120).nullable().default(null),
  categoryId:z.number().int().positive().nullable().default(null),
  keywords:z.array(z.string().trim().min(1).max(80)).max(20).default([]),
  journeyId:z.number().int().positive().nullable().default(null),sequenceId:z.number().int().positive(),
  priority:z.number().int().min(1).max(10000).default(100),enabled:z.boolean().default(true),
}).superRefine((value,ctx)=>{
  if(value.classification!=="warm")ctx.addIssue({code:"custom",path:["classification"],message:"Only Warm leads may be routed to journeys and nurture sequences. Hot leads are for telecaller follow-up."});
  if(value.matchType==="product"&&!value.productName&&!value.productId&&!value.keywords.length)ctx.addIssue({code:"custom",path:["productName"],message:"Choose a product or provide an affinity keyword"});
  if(value.matchType==="category"&&!value.categoryName&&!value.categoryId)ctx.addIssue({code:"custom",path:["categoryName"],message:"Choose a category"});
  if(value.enabled&&!value.journeyId)ctx.addIssue({code:"custom",path:["journeyId"],message:"Choose a journey before enabling automatic routing"});
});

async function validateInboundRoutingRefs(tenantId:number,data:z.infer<typeof inboundRoutingRuleBody>,excludeId?:number){
  if(data.matchType==="product"&&data.productName&&!data.categoryName)return "Choose a product category";
  if(data.categoryName&&!inboundCategories.includes(data.categoryName)
    &&!(data.matchType==="product"&&data.categoryName==="Needs categorization")
    &&!(data.matchType==="category"&&data.categoryName==="No Category"&&!data.categoryId&&!data.productId&&!data.productName&&!data.keywords.length))
    return "Choose an inbound category";
  if(data.productName){
    const choices=(await getInboundDashboard(tenantId,{})).options.products;
    if(!choices.some(product=>product.name===data.productName
      &&(!data.categoryName||product.categoryName===data.categoryName)))return "Choose an inbound product";
  }
  const [client,journey,sequence,product,category,fallback]=await Promise.all([
    pool.query("SELECT 1 FROM clients WHERE tenant_id=$1 AND id=$2",[tenantId,data.clientId]),
    data.journeyId?pool.query("SELECT client_id FROM journeys WHERE tenant_id=$1 AND id=$2",[tenantId,data.journeyId]):Promise.resolve({rowCount:1,rows:[]}),
    pool.query("SELECT 1 FROM email_sequences WHERE tenant_id=$1 AND id=$2 AND status='active'",[tenantId,data.sequenceId]),
    data.productId?pool.query("SELECT 1 FROM intent_products WHERE tenant_id=$1 AND id=$2 AND active=true",[tenantId,data.productId]):Promise.resolve({rowCount:1}),
    data.categoryId?pool.query("SELECT 1 FROM intent_product_categories WHERE tenant_id=$1 AND id=$2",[tenantId,data.categoryId]):Promise.resolve({rowCount:1}),
    data.matchType==="fallback"&&data.enabled?pool.query(`SELECT 1 FROM intent_inbound_routing_rules
      WHERE tenant_id=$1 AND match_type='fallback' AND enabled=true AND client_id IS NOT DISTINCT FROM $2::int
      AND ($3::int IS NULL OR id<>$3) LIMIT 1`,[tenantId,data.clientId,excludeId??null]):Promise.resolve({rowCount:0}),
  ]);
  if(!client.rowCount)return "Unknown client";
  if(data.journeyId&&!journey.rowCount)return "Unknown journey";
  if(data.journeyId&&Number((journey.rows[0] as any).client_id)!==data.clientId)return "The journey must belong to the selected client";
  if(!sequence.rowCount)return "Choose an active sequence";
  if(!product.rowCount)return "Unknown active product";
  if(!category.rowCount)return "Unknown product category";
  if(fallback.rowCount)return "Only one enabled broader fallback rule is allowed for this client scope";
  return null;
}

router.get("/intent/inbound/routing-rules",async(req,res,next)=>{try{
  const u=admin(req,res);if(!u)return;
  const allowed=permittedClientIds(req);
  await repairInboundProductInterestClassifications(u.tenantId);
  await pool.query(`INSERT INTO intent_product_categories(tenant_id,name)
    SELECT $1,name FROM unnest($2::text[]) AS seed(name)
    ON CONFLICT (tenant_id,name) DO NOTHING`,[u.tenantId,inboundCategories]);
  const sourceId=positiveId(String(req.query.sourceId??""));
  const [rules,clients,categories,products,journeys,sequences,summary,cohorts]=await Promise.all([
    pool.query<any>(`SELECT r.id,r.name,r.client_id AS "clientId",r.match_type AS "matchType",r.classification,
       r.product_id AS "productId",COALESCE(r.inbound_product_name,p.name) AS "productName",
       r.inbound_product_name AS "inboundProductName",
       r.category_id AS "categoryId",COALESCE(r.inbound_category_name,pc.name) AS "categoryName",
       r.inbound_category_name AS "inboundCategoryName",
      r.keywords,r.journey_id AS "journeyId",j.name AS "journeyName",r.sequence_id AS "sequenceId",es.name AS "sequenceName",
      r.priority,r.enabled,r.created_at AS "createdAt",r.updated_at AS "updatedAt"
      FROM intent_inbound_routing_rules r
      LEFT JOIN journeys j ON j.id=r.journey_id LEFT JOIN email_sequences es ON es.id=r.sequence_id
      LEFT JOIN intent_products p ON p.id=r.product_id LEFT JOIN intent_product_categories pc ON pc.id=r.category_id
       WHERE r.tenant_id=$1 AND ($2::int[] IS NULL OR r.client_id=ANY($2::int[])) ORDER BY r.priority,r.id`,[u.tenantId,allowed]),
    pool.query("SELECT id,name FROM clients WHERE tenant_id=$1 AND ($2::int[] IS NULL OR id=ANY($2::int[])) ORDER BY name",[u.tenantId,allowed]),
    Promise.resolve({rows:[...inboundCategories,"Needs categorization","No Category"]}),
    pool.query("SELECT p.id,p.name,c.name AS \"categoryName\",s.name AS \"subcategoryName\" FROM intent_products p JOIN intent_product_categories c ON c.tenant_id=p.tenant_id AND c.id=p.category_id LEFT JOIN intent_product_subcategories s ON s.tenant_id=p.tenant_id AND s.id=p.subcategory_id WHERE p.tenant_id=$1 AND p.active=true ORDER BY p.name",[u.tenantId]),
    pool.query("SELECT id,name,client_id AS \"clientId\" FROM journeys WHERE tenant_id=$1 AND status<>'archived' AND ($2::int[] IS NULL OR client_id=ANY($2::int[])) ORDER BY name",[u.tenantId,allowed]),
    pool.query(`SELECT id,name,status,client_id AS "clientId" FROM email_sequences
      WHERE tenant_id=$1 AND (status='active' OR ($2::boolean AND status='draft'))
        AND ($3::int[] IS NULL OR client_id=ANY($3::int[])) ORDER BY name`,
      [u.tenantId,req.query.includeDraftSequences==="true",allowed]),
    pool.query<any>(`SELECT count(*) FILTER(WHERE routing_status='routed')::int AS routed,
      count(*) FILTER(WHERE routing_status='pending')::int AS pending,
      count(*) FILTER(WHERE routing_status='error')::int AS failed
       FROM intent_inbound_submissions WHERE tenant_id=$1 AND ($2::int IS NULL OR source_id=$2)
         AND ($3::int[] IS NULL OR client_id=ANY($3::int[]))`,[u.tenantId,sourceId??null,allowed]),
    pool.query<any>(`SELECT s.id AS "submissionId",s.client_id AS "clientId",s.account_id AS "accountId",s.contact_id AS "contactId",
      c.name AS "accountName",btrim(s.product_interest) AS "productAffinity",
       s.classification,
      s.classification AS "submissionClassification",s.routing_status AS "routingStatus",
      s.routing_error AS "routingError",s.routed_rule_id AS "routedRuleId",s.affinity_reviews AS "affinityReviews",
      mr.selection AS "manualSelection"
      FROM intent_inbound_submissions s JOIN companies c ON c.id=s.account_id AND c.tenant_id=s.tenant_id
      LEFT JOIN intent_inbound_manual_routes mr ON mr.tenant_id=s.tenant_id AND mr.submission_id=s.id
      WHERE s.tenant_id=$1 AND ($2::int IS NULL OR s.source_id=$2)
         AND ($3::int[] IS NULL OR s.client_id=ANY($3::int[]))
       ORDER BY s.created_at DESC,s.id DESC`,[u.tenantId,sourceId??null,allowed]),
  ]);
   const catalog=products.rows.map((product:any)=>({id:Number(product.id),name:String(product.name),category:String(product.categoryName),subcategory:product.subcategoryName?String(product.subcategoryName):null}));
  const routingRules=rules.rows.map((rule:any)=>({
    id:rule.id,name:rule.name,client_id:rule.clientId,match_type:rule.matchType,
     classification:rule.classification,product_name:rule.productName,category_name:rule.categoryName,
     inbound_product_name:rule.inboundProductName,inbound_category_name:rule.inboundCategoryName,
    keywords:rule.keywords,journey_id:rule.journeyId,sequence_id:rule.sequenceId,enabled:rule.enabled,
  }));
  const categoryRules=await loadInboundCategoryRules(u.tenantId);
  const affinityCohorts=groupUnconfiguredInboundAffinities(cohorts.rows,catalog,routingRules,categoryRules);
  const categoryCohorts=groupInboundCategoryCohorts(cohorts.rows,catalog,categoryRules);
  const ruleCohorts=groupInboundRuleCohorts(routingRules,cohorts.rows,catalog,categoryRules);
   res.json({rules:rules.rows,cohorts:affinityCohorts,categoryCohorts,ruleCohorts,options:{
     clients:clients.rows,categories:categories.rows,
     products:inboundProductOptionsFromRows(cohorts.rows,categoryRules),
     journeys:journeys.rows,sequences:sequences.rows},summary:summary.rows[0]});
}catch(e){next(e);}});

router.post("/intent/inbound/routing-rules",async(req,res,next)=>{try{
  const u=admin(req,res),parsed=inboundRoutingRuleBody.safeParse(req.body);if(!u)return;
  if(!parsed.success){res.status(400).json({error:parsed.error.message});return;}
  const error=await validateInboundRoutingRefs(u.tenantId,parsed.data);if(error){res.status(400).json({error});return;}
  const d=parsed.data,client=await pool.connect();
  let row;
  try{
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1,$2)",[u.tenantId,d.clientId]);
    const duplicate=d.matchType==="category"&&d.categoryName==="No Category"
      &&!d.categoryId&&!d.productId&&!d.productName&&!d.keywords.length
      ?await client.query(`SELECT id FROM intent_inbound_routing_rules
      WHERE tenant_id=$1 AND client_id=$2 AND match_type='category' AND inbound_category_name='No Category'
        AND product_id IS NULL AND category_id IS NULL AND inbound_product_name IS NULL
        AND keywords='[]'::jsonb AND (classification=$3 OR classification='all' OR $3='all') LIMIT 1`,
      [u.tenantId,d.clientId,d.classification]):{rowCount:0};
    if(duplicate.rowCount){await client.query("ROLLBACK");res.status(409).json({error:"A No Category route already covers this client and status. Edit the saved route instead."});return;}
    row=await client.query<any>(`INSERT INTO intent_inbound_routing_rules
    (tenant_id,client_id,name,match_type,classification,product_id,category_id,keywords,journey_id,sequence_id,priority,enabled,created_by,inbound_product_name,inbound_category_name)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
    [u.tenantId,d.clientId,d.name,d.matchType,d.classification,d.productId,d.categoryId,JSON.stringify(d.keywords),d.journeyId,d.sequenceId,d.priority,d.enabled,u.id,d.matchType==="product"?d.productName:null,d.matchType==="category"||d.matchType==="product"&&d.productName?d.categoryName:null]);
    await client.query("COMMIT");
  }catch(e){await client.query("ROLLBACK");throw e;}finally{client.release();}
  const routing=await routePendingWarmSubmissions(u.tenantId,undefined,Number(row.rows[0].id));
  res.status(201).json({id:row.rows[0].id,routing});
}catch(e){next(e);}});

router.put("/intent/inbound/routing-rules/:id",async(req,res,next)=>{try{
  const u=admin(req,res),id=positiveId(req.params.id),parsed=inboundRoutingRuleBody.safeParse(req.body);if(!u)return;
  if(!id||!parsed.success){res.status(400).json({error:parsed.success?"Invalid rule":parsed.error.message});return;}
  const error=await validateInboundRoutingRefs(u.tenantId,parsed.data,id);if(error){res.status(400).json({error});return;}
  const d=parsed.data,client=await pool.connect();
  let row;
  try{
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1,$2)",[u.tenantId,d.clientId]);
    const duplicate=d.matchType==="category"&&d.categoryName==="No Category"
      &&!d.categoryId&&!d.productId&&!d.productName&&!d.keywords.length
      ?await client.query(`SELECT id FROM intent_inbound_routing_rules
      WHERE tenant_id=$1 AND client_id=$2 AND id<>$3 AND match_type='category' AND inbound_category_name='No Category'
        AND product_id IS NULL AND category_id IS NULL AND inbound_product_name IS NULL
        AND keywords='[]'::jsonb AND (classification=$4 OR classification='all' OR $4='all') LIMIT 1`,
      [u.tenantId,d.clientId,id,d.classification]):{rowCount:0};
    if(duplicate.rowCount&&d.enabled){
      const current=await client.query<any>(`SELECT client_id,match_type,classification,enabled,inbound_category_name,
        product_id,category_id,inbound_product_name,keywords FROM intent_inbound_routing_rules
        WHERE tenant_id=$1 AND id=$2 FOR UPDATE`,[u.tenantId,id]);
      const old=current.rows[0];
      const preservesOverlap=old?.enabled&&old.client_id===d.clientId
        &&old.match_type==="category"&&old.inbound_category_name==="No Category"
        &&old.product_id===null&&old.category_id===null&&old.inbound_product_name===null
        &&Array.isArray(old.keywords)&&old.keywords.length===0
        &&(old.classification===d.classification||old.classification==="all");
      if(!preservesOverlap){await client.query("ROLLBACK");res.status(409).json({error:"A No Category route already covers this client and status. Consolidate duplicates before expanding this route."});return;}
    }
    row=await client.query(`UPDATE intent_inbound_routing_rules SET client_id=$1,name=$2,match_type=$3,
    classification=$4,product_id=$5,category_id=$6,keywords=$7,journey_id=$8,sequence_id=$9,priority=$10,enabled=$11,
    inbound_product_name=$14,inbound_category_name=$15,updated_at=NOW()
    WHERE tenant_id=$12 AND id=$13 RETURNING id`,
    [d.clientId,d.name,d.matchType,d.classification,d.productId,d.categoryId,JSON.stringify(d.keywords),d.journeyId,d.sequenceId,d.priority,d.enabled,u.tenantId,id,d.matchType==="product"?d.productName:null,d.matchType==="category"||d.matchType==="product"&&d.productName?d.categoryName:null]);
    await client.query("COMMIT");
  }catch(e){await client.query("ROLLBACK");throw e;}finally{client.release();}
  if(!row.rowCount){res.status(404).json({error:"Routing rule not found"});return;}
  const routing=await routePendingWarmSubmissions(u.tenantId,undefined,id);
  // Editing an existing No Category rule must never enroll historical respondents
  // in another journey; only pending responses may be routed by the save.
  // Do not reattach historical respondents on a rule edit. Their current heat
  // may now be Hot; all new membership must pass the Warm-only admission path.
  res.json({id,routing});
}catch(e){next(e);}});

router.post("/intent/inbound/routing-rules/consolidate-no-category",async(req,res,next)=>{try{
  const u=admin(req,res);if(!u)return;
  const parsed=z.object({clientId:z.number().int().positive()}).safeParse(req.body);
  if(!parsed.success){res.status(400).json({error:"Choose a client"});return;}
  const client=await pool.connect();
  try{
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1,$2)",[u.tenantId,parsed.data.clientId]);
    const rules=await client.query<any>(`SELECT id,classification,journey_id,sequence_id,priority,enabled
      FROM intent_inbound_routing_rules WHERE tenant_id=$1 AND client_id=$2
        AND match_type='category' AND inbound_category_name='No Category'
        AND product_id IS NULL AND category_id IS NULL AND inbound_product_name IS NULL
        AND keywords='[]'::jsonb ORDER BY id FOR UPDATE`,[u.tenantId,parsed.data.clientId]);
    const canonical=rules.rows.find(r=>r.classification==="all"&&r.enabled);
    const duplicates=canonical?rules.rows.filter(r=>r.id!==canonical.id
      &&r.enabled===canonical.enabled&&r.journey_id===canonical.journey_id
      &&r.sequence_id===canonical.sequence_id&&r.priority===canonical.priority):[];
    if(!duplicates.length){await client.query("ROLLBACK");res.status(409).json({error:"No equivalent No Category routes can be safely consolidated."});return;}
    const ids=duplicates.map(r=>r.id);
    // Pending/error responses may currently select a removed rule; do not silently retarget them.
    const pending=await client.query(`SELECT id FROM intent_inbound_submissions
      WHERE tenant_id=$1 AND client_id=$2 AND classification IN ('hot','warm','cold')
        AND routing_status IN ('pending','error')
        AND NOT EXISTS (SELECT 1 FROM regexp_split_to_table(COALESCE(product_interest,''), E'[,;|\\n]') AS answer(selection)
          WHERE btrim(answer.selection)<>'' AND btrim(answer.selection) !~* '^(n/?a|none|no|nil|not interested|-+)$')
        AND (affinity_reviews->>'__missingCategory' IS NULL OR affinity_reviews->>'__missingCategory'='No Category')
      FOR UPDATE`,
      [u.tenantId,parsed.data.clientId]);
    const historical=await client.query<{routed_rule_id:number}>(`SELECT DISTINCT routed_rule_id FROM intent_inbound_submissions
      WHERE tenant_id=$1 AND routed_rule_id=ANY($2::int[])`,[u.tenantId,ids]);
    const referenced=new Set(historical.rows.map(r=>r.routed_rule_id));
    const removableIds=ids.filter(ruleId=>!referenced.has(ruleId));
    if(pending.rowCount||!removableIds.length){
      await client.query("ROLLBACK");
      res.status(409).json({error:`Cannot consolidate: ${referenced.size} history-linked routes and ${pending.rowCount} unresolved No Category responses need review.`});return;
    }
    const deleted=await client.query(`DELETE FROM intent_inbound_routing_rules r WHERE r.tenant_id=$1 AND r.id=ANY($2::int[])
      AND NOT EXISTS (SELECT 1 FROM intent_inbound_submissions s WHERE s.tenant_id=r.tenant_id AND s.routed_rule_id=r.id)
      RETURNING r.id`,[u.tenantId,removableIds]);
    if(deleted.rowCount!==removableIds.length){await client.query("ROLLBACK");res.status(409).json({error:"Historical routing changed during consolidation. Retry after review."});return;}
    await client.query("COMMIT");
    res.json({keptId:canonical.id,removedIds:removableIds,retainedIds:ids.filter(ruleId=>referenced.has(ruleId))});
  }catch(e){await client.query("ROLLBACK");throw e;}finally{client.release();}
}catch(e){next(e);}});

router.post("/intent/inbound/routing-rules/:id/retry",async(req,res,next)=>{try{
  const u=admin(req,res),id=positiveId(req.params.id),sourceId=positiveId(String(req.query.sourceId??""));
  if(!u)return;
  if(!id){res.status(400).json({error:"Invalid routing rule"});return;}
  const rule=await pool.query("SELECT 1 FROM intent_inbound_routing_rules WHERE tenant_id=$1 AND id=$2 AND enabled=true",[u.tenantId,id]);
  if(!rule.rowCount){res.status(404).json({error:"Enabled routing rule not found"});return;}
  if(sourceId){
    const source=await pool.query("SELECT 1 FROM intent_inbound_sources WHERE tenant_id=$1 AND id=$2",[u.tenantId,sourceId]);
    if(!source.rowCount){res.status(400).json({error:"Invalid inbound source"});return;}
  }
  const submissions=await pool.query<{id:number}>(`SELECT id FROM intent_inbound_submissions
    WHERE tenant_id=$1 AND routing_status IN ('pending','error') AND ($2::int IS NULL OR source_id=$2)
    ORDER BY id LIMIT 5000`,[u.tenantId,sourceId??null]);
  const routing=submissions.rows.length
    ?await routePendingWarmSubmissions(u.tenantId,submissions.rows.map(row=>row.id),id)
    :{routed:0,pending:0,failed:0};
  res.json({routing});
}catch(e){next(e);}});

router.delete("/intent/inbound/routing-rules/:id",async(req,res,next)=>{try{
  const u=admin(req,res),id=positiveId(req.params.id);if(!u)return;
  if(!id){res.status(400).json({error:"Invalid rule"});return;}
  const deleted=await pool.query("DELETE FROM intent_inbound_routing_rules WHERE tenant_id=$1 AND id=$2",[u.tenantId,id]);
  if(!deleted.rowCount){res.status(404).json({error:"Routing rule not found"});return;}
  res.sendStatus(204);
}catch(e){next(e);}});

export default router;