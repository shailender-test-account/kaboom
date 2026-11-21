import { hpParentLastCheckedSql } from "./lib/hpParentResearch";
import { db, pool } from "@workspace/db";
import { sql } from "drizzle-orm";
import { providerConfigured, providerRequestLimit, type ResearchProvider } from "./lib/intentProviders";
import { PUBLIC_EVENT_TYPES } from "./lib/alwaysOnIntent";
import { logger } from "./lib/logger";
import { kickIntentResearchRunner } from "./intentResearchRunner";
import { buildContactsWhereClause, type FilterCriterion } from "./utils/segmentFilter";
import { evaluateTwoLevelIntentStatus, type IntentStatusEvidence } from "./lib/twoLevelIntentStatus";
import { inferCategoriesFromInterest, type ImportCatalogProduct } from "./lib/intentImportProductMatching";
import { isFreshInboundHot } from "./lib/intentOpportunityFreshness";
import { monitoringResearchAllowed } from "./lib/monitoringResearchPolicy";
import { guardMonitoringConnection } from "./lib/monitoringConnection";

const INDIA_OFFSET_MS=330*60*1000;
export const PROVIDER_ORDER:ResearchProvider[]=["perplexity","tavily","explorium","newsapi"];
const REQUESTS_PER_ACCOUNT:Record<ResearchProvider,number>={tavily:4,perplexity:4,explorium:1,newsapi:3};
// A Tavily account can consume four plans with up to four attempts each.
// Keep four additional reservations available so Perplexity can still run
// after Tavily exhausts its retries instead of being blocked by our run budget.
const RUN_REQUESTS_PER_ACCOUNT:Record<ResearchProvider,number>={...REQUESTS_PER_ACCOUNT,tavily:20};
let dailyTimer:NodeJS.Timeout|undefined;

export function nextDailyNineIst(now=new Date()){
  const ist=new Date(now.getTime()+INDIA_OFFSET_MS);
  const minutes=ist.getUTCHours()*60+ist.getUTCMinutes();
  const daysUntilTarget=minutes<9*60?0:1;
  const targetIst=Date.UTC(ist.getUTCFullYear(),ist.getUTCMonth(),ist.getUTCDate()+daysUntilTarget,9,0,0,0);
  return new Date(targetIst-INDIA_OFFSET_MS);
}

function dailyKey(target:Date){
  const ist=new Date(target.getTime()+INDIA_OFFSET_MS);
  return `${ist.getUTCFullYear()}-${String(ist.getUTCMonth()+1).padStart(2,"0")}-${String(ist.getUTCDate()).padStart(2,"0")}`;
}

async function monitoredSegmentCompanyIds(tenantId:number,configId:number){
  const segments=await pool.query<{segment_type:"static"|"dynamic";static_contact_ids:number[]|null;filter_criteria:FilterCriterion[]|null;logic_operator:"AND"|"OR"}>(
    `SELECT s.segment_type,s.static_contact_ids,s.filter_criteria,s.logic_operator
       FROM intent_monitoring_segments ms JOIN segments s ON s.tenant_id=ms.tenant_id AND s.id=ms.segment_id
      WHERE ms.tenant_id=$1 AND ms.config_id=$2`,
    [tenantId,configId],
  );
  const contactIds=new Set<number>();
  for(const segment of segments.rows){
    if(segment.segment_type==="static"){
      for(const id of segment.static_contact_ids??[])contactIds.add(Number(id));
      continue;
    }
    const where=await buildContactsWhereClause(tenantId,segment.filter_criteria??[],segment.logic_operator==="OR"?"OR":"AND");
    const rows=(await db.execute(sql`SELECT c.id FROM contacts c LEFT JOIN companies co ON co.id=c.company_id WHERE ${where}`)).rows as Array<{id:number}>;
    for(const row of rows)contactIds.add(Number(row.id));
  }
  if(!contactIds.size)return [];
  return (await pool.query<{company_id:number}>(
    "SELECT DISTINCT company_id FROM contacts WHERE tenant_id=$1 AND id=ANY($2::int[]) AND company_id IS NOT NULL",
    [tenantId,[...contactIds]],
  )).rows.map(row=>row.company_id);
}

export type MonitoringLane = "warm" | "prospect";
export type LaneCounts = {eligible:number;scheduled:number;completed:number;deferred:number;failed:number};

export function allocateFairLaneAccounts<T extends {id:number}>(
  warm:T[],prospects:T[],dailyTarget:number,startingLane:MonitoringLane="warm",
){
  const lanes:Record<MonitoringLane,T[]>={warm,prospect:prospects};
  const selected:Record<MonitoringLane,T[]>={warm:[],prospect:[]};
  const indexes:Record<MonitoringLane,number>={warm:0,prospect:0};
  let lane=startingLane;
  let remaining=Math.max(0,Math.floor(dailyTarget));
  while(remaining>0&&(indexes.warm<warm.length||indexes.prospect<prospects.length)){
    if(indexes[lane]<lanes[lane].length){
      selected[lane].push(lanes[lane][indexes[lane]++]);
      remaining--;
    }
    lane=lane==="warm"?"prospect":"warm";
    if(indexes.warm>=warm.length)lane="prospect";
    if(indexes.prospect>=prospects.length)lane="warm";
  }
  return selected;
}

function categoryMatchedWarmInbound(productInterest:string|null,catalog:ImportCatalogProduct[],categoryNames:string[]){
  const names=new Set(inferCategoriesFromInterest(productInterest,catalog).map(item=>item.category.toLowerCase()));
  const normalized=String(productInterest??"").toLowerCase();
  return categoryNames.some(name=>names.has(name.toLowerCase())||normalized.includes(name.toLowerCase()));
}

export async function createProviderRun(tenantId:number,clientId:number,provider:ResearchProvider,accountIds:number[],requestLimit:number,idempotencyKey:string,categoryIds:number[],lane:MonitoringLane,laneCounts:LaneCounts,capacityWarning:boolean){
  const accountCount=accountIds.length;
  const summary={
     request:{eventTypes:PUBLIC_EVENT_TYPES,country:"India",schedule:"Daily 09:00 Asia/Kolkata",accountCount,categoryIds},
     monitoringLane:lane,
     laneCounts,
     capacityWarning,
    scheduled:true,
    accountsTotal:accountCount,accountsCompleted:0,accountsRemaining:accountCount,accountsFailed:0,accountsInterpreted:0,
    requests:0,pages:0,retries:0,rateLimited:0,recordsFetched:0,recordsNormalized:0,inserted:0,duplicates:0,
    cost:{provider,billableRequests:0,unit:"provider_request"},
  };
  const client=await pool.connect();
  const connection=guardMonitoringConnection(client,"schedule monitoring");
  try{
    await client.query("BEGIN");
    const created=await client.query<{id:number}>(
       `INSERT INTO intent_research_runs(tenant_id,client_id,provider,status,idempotency_key,request_limit,summary)
        VALUES($1,$2,$3,'queued',$4,$5,$6)
       ON CONFLICT (tenant_id,idempotency_key) DO NOTHING
       RETURNING id`,
       [tenantId,clientId,provider,idempotencyKey,requestLimit,summary],
    );
    if(!created.rows[0]){
      await client.query("COMMIT");
      connection.check();
      return false;
    }
    await client.query(
       `INSERT INTO intent_research_run_accounts(tenant_id,run_id,account_id,status)
        SELECT $1,$2,account_id,'pending' FROM unnest($3::int[]) account_id
       ON CONFLICT (tenant_id,run_id,account_id) DO NOTHING`,
      [tenantId,created.rows[0].id,accountIds],
    );
    await client.query("COMMIT");
    connection.check();
    return true;
  }catch(error){
    await connection.rollback();
    throw error;
  }finally{
    connection.release();
  }
}

async function scheduleMonitoringResearch(target:Date,filter:{tenantId?:number;configId?:number;activationKey?:string}={}){
  if(!monitoringResearchAllowed())return {createdRuns:0,scheduledAccounts:0};
  const configs=await pool.query<{tenant_id:number;config_id:number;client_id:number|null;daily_limit:number;category_ids:number[]}>(
    `SELECT c.tenant_id,c.id AS config_id,c.client_id,c.daily_limit,
       COALESCE(array_agg(DISTINCT mc.category_id) FILTER (WHERE mc.category_id IS NOT NULL),'{}') AS category_ids
       FROM intent_monitoring_configs c
       LEFT JOIN intent_monitoring_categories mc ON mc.tenant_id=c.tenant_id AND mc.config_id=c.id
       WHERE c.enabled=true AND ($1::int IS NULL OR c.tenant_id=$1) AND ($2::int IS NULL OR c.id=$2)
       GROUP BY c.tenant_id,c.id,c.daily_limit ORDER BY c.tenant_id,c.id`,
    [filter.tenantId??null,filter.configId??null],
  );
  const key=dailyKey(target);
  let createdRuns=0;
  let scheduledAccounts=0;
  for(const config of configs.rows){
    const segmentCompanyIds=await monitoredSegmentCompanyIds(config.tenant_id,config.config_id);
    const due=await pool.query<{id:number;client_id:number;name:string;domain:string|null}>(
      `SELECT id,client_id,name,domain FROM companies
        WHERE tenant_id=$1 AND client_id IS NOT NULL
           AND ($4::int IS NULL OR client_id=$4)
           AND (EXISTS (SELECT 1 FROM intent_monitoring_audiences ma
              JOIN intent_audience_companies ac ON ac.tenant_id=ma.tenant_id AND ac.audience_id=ma.audience_id AND ac.company_id=companies.id
              WHERE ma.tenant_id=$1 AND ma.config_id=$2)
             OR ($3::int[] IS NOT NULL AND id=ANY($3::int[]))
             OR EXISTS (SELECT 1 FROM intent_monitoring_accounts selected
                 WHERE selected.tenant_id=$1 AND selected.config_id=$2 AND selected.company_id=companies.id))
          AND (NULLIF(btrim(name),'') IS NOT NULL OR NULLIF(btrim(domain),'') IS NOT NULL)
          AND (COALESCE(${hpParentLastCheckedSql()},last_researched_at) IS NULL
            OR COALESCE(${hpParentLastCheckedSql()},last_researched_at) < NOW()-interval '7 days')
           AND NOT EXISTS(
             SELECT 1 FROM intent_research_run_accounts active
             WHERE active.tenant_id=companies.tenant_id AND active.account_id=companies.id
                AND active.status IN ('pending','claimed','running')
           )
        ORDER BY last_researched_at ASC NULLS FIRST,id
       `,
      [config.tenant_id,config.config_id,segmentCompanyIds.length?segmentCompanyIds:null,config.client_id],
    );
    const categoryRows=await pool.query<{id:number;name:string}>(
      `SELECT id,name FROM intent_product_categories WHERE tenant_id=$1 AND id=ANY($2::int[])`,
      [config.tenant_id,config.category_ids],
    );
    const categoryNames=categoryRows.rows.map(row=>row.name);
    const products=await pool.query<{id:number;name:string;category:string;subcategory:string|null}>(
      `SELECT p.id,p.name,pc.name AS category,ps.name AS subcategory
         FROM intent_products p
         JOIN intent_product_categories pc ON pc.tenant_id=p.tenant_id AND pc.id=p.category_id
         LEFT JOIN intent_product_subcategories ps ON ps.tenant_id=p.tenant_id AND ps.id=p.subcategory_id
        WHERE p.tenant_id=$1 AND p.active=true AND p.category_id=ANY($2::int[])`,
      [config.tenant_id,config.category_ids],
    );
    const accountIds=due.rows.map(row=>row.id);
    const warmInbound=new Set<number>();
    const inboundHot=new Set<number>();
    if(accountIds.length){
       const inbound=await pool.query<{account_id:number;classification:"hot"|"warm";product_interest:string|null;action_at:Date}>(
         `SELECT account_id,classification,product_interest,COALESCE(submitted_at,created_at) AS action_at FROM intent_inbound_submissions
          WHERE tenant_id=$1 AND account_id=ANY($2::int[]) AND classification IN ('hot','warm')`,
        [config.tenant_id,accountIds],
      );
      for(const row of inbound.rows){
         if(!categoryMatchedWarmInbound(row.product_interest,products.rows,categoryNames))continue;
         if(row.classification==="hot"&&isFreshInboundHot(row.action_at,target))inboundHot.add(row.account_id);
         else warmInbound.add(row.account_id);
      }
    }
    const evidenceByAccount=new Map<number,IntentStatusEvidence[]>();
    if(accountIds.length){
      const evidence=await pool.query<{id:number;account_id:number;event_type:string|null;excerpt:string|null;source_url:string|null;occurred_at:Date;confidence:number;review_status:string;context:Record<string,unknown>}>(
        `SELECT id,account_id,event_type,excerpt,source_url,occurred_at,confidence,review_status,context
           FROM intent_evidence
          WHERE tenant_id=$1 AND account_id=ANY($2::int[]) AND evidence_kind='public_event'
            AND review_status='approved' AND occurred_at>=NOW()-interval '90 days'
          ORDER BY occurred_at DESC,id DESC`,
        [config.tenant_id,accountIds],
      );
      for(const row of evidence.rows){
        const list=evidenceByAccount.get(row.account_id)??[];
        list.push({id:row.id,evidenceKind:"public_event",eventType:row.event_type,excerpt:row.excerpt??"",sourceUrl:row.source_url,occurredAt:row.occurred_at,confidence:row.confidence,reviewStatus:row.review_status,context:row.context??{}});
        evidenceByAccount.set(row.account_id,list);
      }
    }
    const warmIds=new Set<number>(warmInbound);
    const hotIds=new Set<number>(inboundHot);
    for(const [id,rows] of evidenceByAccount){
      const status=evaluateTwoLevelIntentStatus(rows);
      if(status.categories.some(category=>categoryNames.some(name=>name.toLowerCase()===category.name.toLowerCase())&&category.status==="warm"))warmIds.add(id);
      if(status.categories.some(category=>categoryNames.some(name=>name.toLowerCase()===category.name.toLowerCase())&&category.status==="hot"))hotIds.add(id);
    }
    const warmRows=due.rows.filter(row=>warmIds.has(row.id)&&!hotIds.has(row.id));
    const prospectRows=due.rows.filter(row=>!warmIds.has(row.id)&&!hotIds.has(row.id));
    const dailyTarget=Math.max(0,config.daily_limit);
    const providers:ResearchProvider[]=[];
    for(const provider of PROVIDER_ORDER)if(await providerConfigured(config.tenant_id,provider))providers.push(provider);
    const providerSlots:{provider:ResearchProvider;capacity:number}[]=[];
    for(const provider of providers){
      const requestCapacity=await providerRequestLimit(config.tenant_id,provider);
      const capacity=Math.floor(requestCapacity/REQUESTS_PER_ACCOUNT[provider]);
      if(capacity>0)providerSlots.push({provider,capacity});
    }
    const totalCapacity=providerSlots.reduce((sum,slot)=>sum+slot.capacity,0);
    const laneStart=(Math.floor(target.getTime()/86_400_000)%2)?"prospect":"warm";
    const allocation=allocateFairLaneAccounts(warmRows,prospectRows,Math.min(dailyTarget,totalCapacity),laneStart);
    const eligibleCounts:Record<MonitoringLane,number>={warm:warmRows.length,prospect:prospectRows.length};
    const providerShortfall=allocation.warm.length+allocation.prospect.length<Math.min(dailyTarget,warmRows.length+prospectRows.length);
    const scheduledCounts:Record<MonitoringLane,number>={warm:0,prospect:0};
    const assigned=[...allocation.warm.map(row=>({...row,lane:"warm" as const})),...allocation.prospect.map(row=>({...row,lane:"prospect" as const}))];
    let offset=0;
    const laneMetadataAssigned=new Set<MonitoringLane>();
    for(const slot of providerSlots){
      if(offset>=assigned.length)break;
      const providerRows=assigned.slice(offset,offset+slot.capacity);
      const byClientLane=new Map<string,{clientId:number;lane:MonitoringLane;ids:number[]}>();
      for(const row of providerRows){
        const mapKey=`${row.client_id}:${row.lane}`;
        const value=byClientLane.get(mapKey)??{clientId:row.client_id,lane:row.lane,ids:[]};
        value.ids.push(row.id);
        byClientLane.set(mapKey,value);
      }
      for(const {clientId,lane,ids} of byClientLane.values()){
        const laneCounts:LaneCounts={
          eligible:laneMetadataAssigned.has(lane)?0:eligibleCounts[lane],
          scheduled:ids.length,completed:0,
          deferred:laneMetadataAssigned.has(lane)?0:eligibleCounts[lane]-allocation[lane].length,
          failed:0,
        };
        const allocatedCapacity=ids.length*RUN_REQUESTS_PER_ACCOUNT[slot.provider];
        const providerLane=`${slot.provider}-${lane}`;
        const runKey=filter.activationKey
          ? `monitoring-activation:${filter.activationKey}:${clientId}:${providerLane}`
          : `daily-monitoring:${key}:${config.config_id}:${clientId}:${providerLane}`;
        if(await createProviderRun(config.tenant_id,clientId,slot.provider,ids,allocatedCapacity,runKey,config.category_ids,lane,laneCounts,providerShortfall)){
          createdRuns+=1;
          scheduledAccounts+=ids.length;
          scheduledCounts[lane]+=ids.length;
          laneMetadataAssigned.add(lane);
        }
      }
      offset+=providerRows.length;
    }
    const capacityDeferred:Record<MonitoringLane,number>={
      warm:eligibleCounts.warm-scheduledCounts.warm,
      prospect:eligibleCounts.prospect-scheduledCounts.prospect,
    };
      const configScheduled=scheduledCounts.warm+scheduledCounts.prospect;
      await pool.query(`UPDATE intent_monitoring_configs SET last_scheduled_at=NOW(),last_scheduled_count=$1,last_lane_counts=$2,updated_at=NOW() WHERE tenant_id=$3 AND id=$4`,[configScheduled,JSON.stringify({
        warm:{eligible:eligibleCounts.warm,scheduled:scheduledCounts.warm,completed:0,deferred:capacityDeferred.warm,failed:0},
        prospect:{eligible:eligibleCounts.prospect,scheduled:scheduledCounts.prospect,completed:0,deferred:capacityDeferred.prospect,failed:0},
      }),config.tenant_id,config.config_id]);
        if(configScheduled<Math.min(dailyTarget,eligibleCounts.warm+eligibleCounts.prospect))logger.warn({tenantId:config.tenant_id,scheduled:configScheduled,eligible:eligibleCounts},"Daily research provider capacity cannot cover the configured account batch");
  }
  if(createdRuns)kickIntentResearchRunner();
   logger.info({key,createdRuns,scheduledAccounts,trigger:filter.activationKey?"activation":"daily"},"Intent monitoring research scheduled");
   return {key,createdRuns,scheduledAccounts};
}

export async function scheduleDailyHpAccountResearch(target=new Date()){
  return scheduleMonitoringResearch(target);
}

export async function scheduleImmediateAccountResearch(tenantId:number,configId:number,activationKey:string,target=new Date()){
  return scheduleMonitoringResearch(target,{tenantId,configId,activationKey});
}

function armDailyTimer(now=new Date()){
  if(dailyTimer)clearTimeout(dailyTimer);
  const target=nextDailyNineIst(now);
  dailyTimer=setTimeout(()=>{
    void scheduleDailyHpAccountResearch(target)
      .catch(error=>logger.warn({err:error},"Daily intent monitoring scheduling failed"))
      .finally(()=>armDailyTimer(new Date(target.getTime()+60_000)));
  },Math.max(1,target.getTime()-now.getTime()));
  dailyTimer.unref();
  logger.info({nextRunAt:target.toISOString(),timezone:"Asia/Kolkata"},"Daily intent monitoring trigger armed");
}

export function startIntentWeeklyResearchScheduler(){
  armDailyTimer();
}
