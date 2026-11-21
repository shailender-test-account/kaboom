import { createHash } from "node:crypto";
import path from "node:path";
import AdmZip from "adm-zip";
import * as XLSX from "xlsx";
import { ReplitConnectors } from "@replit/connectors-sdk";
import { pool } from "@workspace/db";
import { enrollHpRuleSequence, hpRuleSequenceEnabled } from "./hpRuleSequence";
import { hpClientNameSql } from "./hpClientScope";
import { hpContactMayNurture, WARM_ONLY_ROUTING_MESSAGE } from "./hpNurturePolicy";
import { isHpClient, resolveHpAccount, queueHpMatch, ensureHpProfile, hpLeadStatus } from "./hpBiImport";
import { captureHpLead } from "./hpBiLeads";
import { resolveSubmissionDate } from "./inboundSubmissionDate";
import { enqueueStep, isTenantQueueAvailable } from "../services/queue";
import { inferCategoriesFromInterest, inferProductsFromInterest, type ImportCatalogProduct } from "./intentImportProductMatching";
import { categoryForMissingInterest, inboundCategories, inboundCategoryForInterest, loadInboundCategoryRules, type InboundCategoryConfig } from "./inboundTaxonomy";

export type InboundClassificationInput = {
  hpLead?: boolean;
  interest?: unknown;
  demo?: unknown;
  timeframe?: unknown;
  title?: unknown;
  productInterest?: unknown;
};

export const inboundMappingTargets = [
  "companyName", "domain", "firstName", "lastName", "name", "email", "phone", "title",
  "function", "city", "country", "linkedinUrl", "interest", "demo", "timeframe",
  "productInterest", "feedback", "submittedAt", "formType", "overallExperience",
  "clubSuggestions", "hpSessionRating", "workshopRating", "demoRating", "futureTopics",
  "followUpDate", "followUpTime", "challenges", "hpId", "orderValue", "currency",
] as const;
export type InboundMappingTarget = typeof inboundMappingTargets[number];
export type InboundFieldMappings = Record<string, InboundMappingTarget>;

export type EventFeedbackSummaryRow = {
  event_feedback?: Record<string, unknown> | null;
  product_interest?: string | null;
};

export type EventFeedbackSummary = {
  responseCount: number;
  ratings: Record<"overallExperience" | "hpSessionRating" | "workshopRating" | "demoRating", Array<{ label: string; count: number }>>;
  requestedServices: Array<{ label: string; count: number }>;
  futureTopics: Array<{ label: string; count: number }>;
  followUpRequests: Array<{ date: string | null; time: string | null; count: number }>;
  challenges: Array<{ label: string; count: number }>;
};

export class MissingInboundCompanyMappingError extends Error {
  constructor() {
    super("Map a source heading to Company name before syncing. Rows without a company name cannot be imported.");
    this.name = "MissingInboundCompanyMappingError";
  }
}
const text = (value: unknown) => String(value ?? "").trim();
const truthy = (value: unknown) => /^(yes|y|true|1|interested|requested)$/i.test(text(value));
const hasPositiveSelection = (value: unknown) => {
  const selected = text(value);
  if (!selected || /^-+$/.test(selected)) return false;
  return selected.split(/[,;|\n]/).some(answer =>
    !["", "na", "none", "no", "nil", "notinterested", "nocategory", "noproduct", "noproductselected", "noservice", "notapplicable"]
      .includes(answer.toLowerCase().trim().replace(/[^a-z]/g, "")));
};

const rankedValues = (values: string[]) => {
  const counts = new Map<string, { label: string; count: number }>();
  for (const raw of values) {
    const label = text(raw).replace(/\s+/g, " ");
    if (!label || /^(?:n\/?a|none|no|nil|-+)$/i.test(label)) continue;
    const key = label.toLocaleLowerCase();
    const current = counts.get(key);
    counts.set(key, { label: current?.label ?? label, count: (current?.count ?? 0) + 1 });
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
};

export const splitSelections = (value: unknown) => text(value)
  .split(/\r?\n|;|\||,\s*(?=[A-Z0-9])/)
  .map(item => item.replace(/^[\s•\-–—✓✔☑]+/, "").trim())
  .filter(Boolean);

type CohortSubmission = {
  clientId:number;accountId:number;contactId:number|null;
  accountName?:string;productAffinity:string|null;classification:"hot"|"warm"|"cold";routingStatus:string;
  affinityReviews?:Record<string,unknown>|null;manualSelection?:string|null;
  submissionClassification?:"hot"|"warm"|"cold";routedRuleId?:number|null;
};

export function groupInboundAffinityCohorts(rows:CohortSubmission[],catalog:ImportCatalogProduct[],categoryRules?:InboundCategoryConfig) {
  const groups=new Map<string,{
    clientId:number;productAffinity:string;categoryName:string;classification:"hot"|"warm"|"cold";
    accounts:Map<number,string>;contacts:Set<number>;keywords:Set<string>;
    routed:number;pending:number;failed:number;
  }>();
  for(const row of rows){
    const selections=splitSelections(row.productAffinity).filter(selection=>
      !/^(?:n\/?a|none|no|nil|not interested|-+)$/i.test(selection)
      &&row.affinityReviews?.[selection]!=="rejected");
    const interests=selections.length?selections:["No product selected"];
    const seen=new Set<string>();
    for(const selection of interests){
      const unassigned=selection==="No product selected";
      const product=unassigned?undefined:inferProductsFromInterest(selection,catalog)[0];
      const productAffinity=product?.name??selection;
      const categoryName=unassigned
        ?(splitSelections(row.productAffinity).some(item=>!/^(?:n\/?a|none|no|nil|not interested|-+)$/i.test(item))?"Needs review":categoryForMissingInterest(row.affinityReviews)??"No Category")
        :inboundCategoryForInterest(selection,row.affinityReviews,categoryRules).categoryName;
      const key=`${row.clientId}:${row.classification}:${productAffinity.toLocaleLowerCase()}`;
      if(seen.has(key))continue;
      seen.add(key);
      const group=groups.get(key)??{
        clientId:Number(row.clientId),productAffinity,categoryName,classification:row.classification,
        accounts:new Map<number,string>(),contacts:new Set<number>(),keywords:new Set<string>(),
        routed:0,pending:0,failed:0
      };
      group.accounts.set(Number(row.accountId),row.accountName??`Account ${row.accountId}`);
      if(row.contactId)group.contacts.add(Number(row.contactId));
      if(!unassigned)group.keywords.add(selection);
      if(row.manualSelection&&row.manualSelection!==selection)group.pending++;
      else if(row.routingStatus==="routed")group.routed++;
      else if(row.routingStatus==="error")group.failed++;
      else group.pending++;
      groups.set(key,group);
    }
  }
  return [...groups.values()].map(group=>({
    clientId:group.clientId,productAffinity:group.productAffinity,
    categoryName:group.categoryName,classification:group.classification,
    accountCount:group.accounts.size,contactCount:group.contacts.size,
    accounts:[...group.accounts].map(([id,name])=>({id,name})).sort((a,b)=>a.name.localeCompare(b.name)),
    keywords:[...group.keywords],routed:group.routed,pending:group.pending,failed:group.failed
  })).sort((a,b)=>(a.productAffinity==="No product selected"?-1:0)-(b.productAffinity==="No product selected"?-1:0)
    ||a.categoryName.localeCompare(b.categoryName)
    ||a.productAffinity.localeCompare(b.productAffinity)
    ||a.classification.localeCompare(b.classification));
}

/** Answer-derived category cohorts, independent of whether a routing rule has been saved. */
export function groupInboundCategoryCohorts(rows:CohortSubmission[],_catalog:ImportCatalogProduct[],categoryRules?:InboundCategoryConfig) {
  const groups=new Map<string,{
    clientId:number;categoryName:string;classification:"hot"|"warm"|"cold";
    accounts:Map<number,{name:string;failed:boolean}>;contacts:Set<number>;products:Set<string>;
    routed:number;pending:number;failed:number;
  }>();
  for(const row of rows){
    const selected=splitSelections(row.productAffinity).filter(selection=>
      !/^(?:n\/?a|none|no|nil|not interested|-+)$/i.test(selection)
      &&row.affinityReviews?.[selection]!=="rejected");
    const interests=selected.length?selected:["No product selected"];
    const seen=new Set<string>();
    for(const selection of interests){
      const assigned=selection==="No product selected"
        &&!splitSelections(row.productAffinity).some(item=>!/^(?:n\/?a|none|no|nil|not interested|-+)$/i.test(item))
        ?{categoryName:categoryForMissingInterest(row.affinityReviews)??"No Category",productName:selection}
        :inboundCategoryForInterest(selection,row.affinityReviews,categoryRules);
      const categoryName=assigned.categoryName;
      const key=`${row.clientId}:${row.classification}:${categoryName.toLocaleLowerCase()}`;
      const group=groups.get(key)??{
        clientId:Number(row.clientId),categoryName,classification:row.classification,
        accounts:new Map<number,{name:string;failed:boolean}>(),contacts:new Set<number>(),products:new Set<string>(),
        routed:0,pending:0,failed:0,
      };
      const accountId=Number(row.accountId);
      const prior=group.accounts.get(accountId);
      const failed=row.routingStatus==="error"&&!(row.manualSelection&&row.manualSelection!==selection);
      group.accounts.set(accountId,{name:row.accountName??`Account ${row.accountId}`,failed:Boolean(prior?.failed||failed)});
      if(row.contactId)group.contacts.add(Number(row.contactId));
      group.products.add(assigned.productName);
      if(!seen.has(key)){
        if(row.manualSelection&&row.manualSelection!==selection)group.pending++;
        else if(row.routingStatus==="routed")group.routed++;
        else if(row.routingStatus==="error")group.failed++;
        else group.pending++;
        seen.add(key);
      }
      groups.set(key,group);
    }
  }
  return [...groups.values()].map(group=>({
    clientId:group.clientId,categoryName:group.categoryName,classification:group.classification,
    accountCount:group.accounts.size,contactCount:group.contacts.size,
    accounts:[...group.accounts].map(([id,account])=>({
      id,name:account.name,...(account.failed?{failed:true}:{}),
    })).sort((a,b)=>a.name.localeCompare(b.name)),
    products:[...group.products].sort(),routed:group.routed,pending:group.pending,failed:group.failed,
  })).sort((a,b)=>b.failed-a.failed||b.pending-a.pending||b.accountCount-a.accountCount
    ||a.categoryName.localeCompare(b.categoryName));
}

/** Only answer selections that are not covered by an enabled routing rule belong in the discovery view. */
export function groupUnconfiguredInboundAffinities(
  rows:CohortSubmission[],catalog:ImportCatalogProduct[],rules:InboundRoutingRule[],categoryRules?:InboundCategoryConfig,
) {
  const enabled=rules.filter(rule=>rule.enabled!==false);
  const unmatched=rows.flatMap<CohortSubmission>(row=>{
    const selected=splitSelections(row.productAffinity);
    const accepted=selected.filter(selection=>
      !/^(?:n\/?a|none|no|nil|not interested|-+)$/i.test(selection)
      &&row.affinityReviews?.[selection]!=="rejected");
    if(!accepted.length){
      // Missing and rejected interests still need human review even when a fallback exists.
      return [{...row,productAffinity:null}];
    }
    return accepted.flatMap(selection=>{
      const match=matchingInboundRoutingRule(enabled,row.clientId,selection,row.submissionClassification??row.classification,catalog,row.affinityReviews,categoryRules);
      // A broad fallback routes the response but does not configure this particular product.
      if(match&&match.match_type!=="fallback")return [];
      const routedHere=row.manualSelection===selection||Boolean(match&&match.id===row.routedRuleId);
      return [{
        ...row,productAffinity:selection,
        routingStatus:row.routingStatus==="routed"&&!routedHere?"pending":row.routingStatus,
      }];
    });
  });
  return groupInboundAffinityCohorts(unmatched,catalog,categoryRules);
}

export function summarizeEventFeedback(rows: EventFeedbackSummaryRow[]): EventFeedbackSummary {
  const ratingKeys = ["overallExperience", "hpSessionRating", "workshopRating", "demoRating"] as const;
  const ratings = Object.fromEntries(ratingKeys.map(key => [
    key,
    rankedValues(rows.map(row => text(row.event_feedback?.[key]))),
  ])) as EventFeedbackSummary["ratings"];
  const requestedServices = rankedValues(rows.flatMap(row => splitSelections(row.product_interest)));
  const futureTopics = rankedValues(rows.flatMap(row => splitSelections(row.event_feedback?.futureTopics)));
  const challenges = rankedValues(rows.map(row => text(row.event_feedback?.challenges)));
  const followUps = new Map<string, { date: string | null; time: string | null; count: number }>();
  for (const row of rows) {
    const date = text(row.event_feedback?.followUpDate) || null;
    const time = text(row.event_feedback?.followUpTime) || null;
    if (!date && !time) continue;
    const key = `${date ?? ""}\u0000${time ?? ""}`;
    const current = followUps.get(key);
    followUps.set(key, { date, time, count: (current?.count ?? 0) + 1 });
  }
  return {
    responseCount: rows.length,
    ratings,
    requestedServices,
    futureTopics,
    followUpRequests: [...followUps.values()].sort((a, b) => b.count - a.count || (a.date ?? "").localeCompare(b.date ?? "")),
    challenges,
  };
}

export function parsePurchaseTimeframeMonths(value: unknown): number | null {
  const raw = text(value).toLowerCase();
  if (!raw) return null;
  if (/^-\s*\d/.test(raw) || /\b(no plans|not decided|not sure|unknown|undecided)\b/.test(raw)) return null;
  // A lower bound is not a promise to purchase within six months.
  const lowerBound = raw.match(/\b(?:more than|over|after|beyond|longer than)\s*(\d+(?:\.\d+)?)\s*(months?|years?|weeks?|days?)\b/)
    ?? raw.match(/\b(\d+(?:\.\d+)?)\s*\+\s*(months?|years?|weeks?|days?)\b/)
    ?? raw.match(/\b(\d+(?:\.\d+)?)\s*(months?|years?|weeks?|days?)\s*\+/);
  if (lowerBound) {
    const amount = Number(lowerBound[1]);
    const unit = lowerBound[2];
    const months = unit.startsWith("year") ? amount * 12
      : unit.startsWith("week") ? amount / 4.345
      : unit.startsWith("day") ? amount / 30
      : amount;
    return months >= 6 ? Math.floor(months) + 1 : null;
  }
  if (/\b(immediate|immediately|asap|now)\b/.test(raw)) return 0;
  // Use the upper bound: a 6–12 month range does not promise purchase within six months.
  const range=raw.match(/(\d+(?:\.\d+)?)\s*(?:-|–|—|to)\s*(\d+(?:\.\d+)?)/);
  const number = Number(range?.[2]??raw.match(/\d+(?:\.\d+)?/)?.[0]);
  if (!Number.isFinite(number)) return null;
  // Stored horizons are integer months. Round up so 3.1/6.1 months cannot
  // incorrectly cross the Hot/Warm boundary.
  if (/\b(years?|yrs?)\b/.test(raw)) return Math.ceil(number * 12);
  if (/\b(weeks?|wks?)\b/.test(raw)) return Math.ceil(number / 4.345);
  if (/\b(days?)\b/.test(raw)) return Math.ceil(number / 30);
  return Math.ceil(number);
}

export function classifyInbound(input: InboundClassificationInput) {
  const interestText = `${text(input.interest)} ${text(input.demo)}`.toLowerCase();
  const explicitInterest = hasPositiveSelection(input.productInterest)
    || truthy(input.interest)
    || /\b(buy|purchase|procure|interested|pricing|quote)\b/.test(interestText);
  const requestedDemo = truthy(input.demo) || /\b(demo|demonstration|trial|pilot|poc|proof of concept)\b/.test(interestText);
  const purchaseTimeframeMonths = parsePurchaseTimeframeMonths(input.timeframe);
  const title = text(input.title);
  const isDecisionMaker = /\b(chief|ceo|cfo|cio|cto|coo|ciso|president|vice president|vp|director|head|general manager|gm|partner|owner|founder|procurement manager|purchase manager|senior manager)\b/i.test(title);
  const hasProduct = hasPositiveSelection(input.productInterest);
  const classification = hpLeadStatus(hasProduct ? "Selected product" : null, purchaseTimeframeMonths);
  return {
    classification,
    classificationReason: !hasProduct ? "Cold because no product or service was selected."
      : classification === "hot" ? "Selected product or service with a purchase timeline of three months or less."
      : classification === "warm" ? "Selected product or service with a purchase timeline over three and up to six months."
      : purchaseTimeframeMonths === null ? "Cold because no clear purchase timeline was given."
      : "Cold because the purchase timeline is beyond six months.",
    explicitInterest, requestedDemo, purchaseTimeframeMonths, isDecisionMaker,
  };
}

const repairedTimelineTenants = new Set<number>();
const runningTimelineRepairs = new Map<number, Promise<void>>();
export function repairInboundProductInterestClassifications(tenantId:number): Promise<void> {
  if (repairedTimelineTenants.has(tenantId)) return Promise.resolve();
  const running = runningTimelineRepairs.get(tenantId);
  if (running) return running;
  const work = (async () => {
  if (!repairedTimelineTenants.has(tenantId)) {
    // Reparse original answers once per process so legacy rounded/range values
    // cannot make existing records disagree with newly imported responses.
    const source = await pool.query(`SELECT s.id,s.purchase_timeframe_months,s.raw_fields,src.field_mappings
      FROM intent_inbound_submissions s LEFT JOIN intent_inbound_sources src
        ON src.id=s.source_id AND src.tenant_id=s.tenant_id
      WHERE s.tenant_id=$1`, [tenantId]);
    const changes: { id: number; months: number | null }[] = [];
    for (const row of source.rows) {
      const fields = canonicalizeInbound(row.raw_fields ?? {}, row.field_mappings ?? {});
      if (!Object.prototype.hasOwnProperty.call(fields, "timeframe")) continue;
      const months = parsePurchaseTimeframeMonths(fields.timeframe);
      if (months !== row.purchase_timeframe_months) changes.push({ id: Number(row.id), months });
    }
    if (changes.length) await pool.query(`UPDATE intent_inbound_submissions s
      SET purchase_timeframe_months=x.months,updated_at=NOW()
      FROM jsonb_to_recordset($2::jsonb) AS x(id int,months int)
      WHERE s.tenant_id=$1 AND s.id=x.id`, [tenantId, JSON.stringify(changes)]);
  }
  // Older imports interpreted "More than 6 Months" as exactly 6. Repair the
  // stored timeline before reconciling classifications; do not touch routing.
  await pool.query(`UPDATE intent_inbound_submissions s SET purchase_timeframe_months=7,
      classification='cold',
      classification_reason='Cold because the purchase timeline is beyond six months.',
      updated_at=NOW()
    WHERE s.tenant_id=$1 AND s.purchase_timeframe_months=6
      AND EXISTS (
        SELECT 1 FROM jsonb_each_text(s.raw_fields) AS answer(key,value)
        LEFT JOIN intent_inbound_sources src ON src.tenant_id=s.tenant_id AND src.id=s.source_id
        WHERE (answer.key ILIKE '%timeframe%purchase%'
          OR answer.key ILIKE '%purchase%timeframe%'
          OR src.field_mappings->>answer.key='timeframe')
          AND answer.value ~* '^[[:space:]]*(more than|over|after|beyond)[[:space:]]+6[[:space:]]+months?[[:space:]]*$'
      )`,[tenantId]);
  const positiveProductInterest=`EXISTS (
    SELECT 1 FROM regexp_split_to_table(COALESCE(product_interest,''), E'[,;|\\n]') AS answer(selection)
    WHERE NULLIF(btrim(answer.selection),'') IS NOT NULL
      AND regexp_replace(lower(btrim(answer.selection)),'[^a-z]','','g') NOT IN ('na','none','no','nil','notinterested','nocategory','noproduct','noproductselected','noservice','notapplicable')
      AND COALESCE(affinity_reviews->>btrim(answer.selection),'')<>'rejected')`;
  const classification=`CASE WHEN NOT (${positiveProductInterest}) THEN 'cold'
    WHEN purchase_timeframe_months BETWEEN 0 AND 3 THEN 'hot'
    WHEN purchase_timeframe_months>3 AND purchase_timeframe_months<=6 THEN 'warm' ELSE 'cold' END`;
  const reason=`CASE WHEN NOT (${positiveProductInterest})
    THEN 'Cold because no product or service was selected.'
    WHEN purchase_timeframe_months IS NULL OR purchase_timeframe_months<0 THEN 'Cold because no clear purchase timeline was given.'
    WHEN purchase_timeframe_months>6 THEN 'Cold because the purchase timeline is beyond six months.'
    WHEN purchase_timeframe_months>3 THEN 'Selected product or service with a purchase timeline over three and up to six months.'
    ELSE 'Selected product or service with a purchase timeline of three months or less.' END`;
  await pool.query(`UPDATE intent_inbound_submissions SET
      explicit_interest=explicit_interest OR (${positiveProductInterest}),
      classification=${classification},classification_reason=${reason},updated_at=NOW()
    WHERE tenant_id=$1 AND (classification IS DISTINCT FROM (${classification})
      OR classification_reason IS DISTINCT FROM (${reason})
      OR (explicit_interest=false AND (${positiveProductInterest})))`,[tenantId]);
  repairedTimelineTenants.add(tenantId);
  })();
  runningTimelineRepairs.set(tenantId, work);
  return work.finally(() => runningTimelineRepairs.delete(tenantId));
}

function normalizeKey(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

const aliases: Record<string, string[]> = {
  companyName: ["company", "company name", "account", "account name", "organisation", "organization"],
  domain: ["domain", "company domain", "website", "company website"],
  firstName: ["first name", "firstname", "given name"],
  lastName: ["last name", "lastname", "surname"],
  name: ["name", "full name", "contact name", "respondent name"],
  email: ["email", "email id", "e mail id", "email address", "work email", "business email"],
  phone: ["phone", "phone number", "mobile", "mobile number"],
  title: ["title", "job title", "designation", "desg", "role", "seniority"],
  function: ["function", "department", "job function", "business function"],
  city: ["city", "location", "work location"],
  country: ["country", "market"],
  linkedinUrl: ["linkedin", "linkedin url", "contact linkedin", "profile url"],
  interest: ["interest", "buy intent", "purchase intent", "interested in buying", "wants to buy", "buying interest"],
  demo: ["demo", "demo request", "wants demo", "request a demo", "trial request"],
  timeframe: ["timeframe", "purchase timeframe", "buying timeframe", "timeline", "when do you plan to buy"],
  productInterest: ["product", "product interest", "solution interest", "interested product", "category"],
  feedback: ["feedback", "event feedback", "comments", "comment", "notes", "response"],
  submittedAt: ["submitted at", "submission date", "response date", "date", "timestamp"],
  formType: ["form type", "response type", "source type"],
  overallExperience: ["overall experience", "event rating"],
  clubSuggestions: ["club suggestions", "activity suggestions"],
  hpSessionRating: ["hp session rating", "session by hp"],
  workshopRating: ["workshop rating", "discovery workshop rating"],
  demoRating: ["demo rating", "hp productivity solution demo rating"],
  futureTopics: ["future topics", "upcoming event topics"],
  followUpDate: ["follow up date", "suitable date"],
  followUpTime: ["follow up time", "suitable time"],
  challenges: ["business challenges", "challenges"],
  hpId: ["hp id", "unique id", "hp account id"],
  orderValue: ["total order value", "order value", "tov", "opportunity tov"],
  currency: ["currency", "order currency"],
};

function automaticTarget(heading: string): InboundMappingTarget | null {
  const normalized = normalizeKey(heading);
  for (const [target, names] of Object.entries(aliases)) {
    if (names.includes(normalized)) return target as InboundMappingTarget;
  }
  if (normalized === "mob no") return "phone";
  if (normalized.includes("rate your overall experience")) return "overallExperience";
  if (normalized.includes("suggestions on other activities")) return "clubSuggestions";
  if (normalized.includes("rate the session by hp")) return "hpSessionRating";
  if (normalized.includes("discovery workshop on") && normalized.includes("workplace")) return "workshopRating";
  if (normalized.includes("rate the hp productivity solution demo")) return "demoRating";
  if (normalized.includes("topics would you want us to cover")) return "futureTopics";
  if (normalized.includes("interested to know more") && normalized.includes("hp services")) return "productInterest";
  if (normalized.includes("estimated timeframe to purchase")) return "timeframe";
  if (normalized.includes("help us in purchase decision")) return "followUpDate";
  if (normalized.includes("suitable time")) return "followUpTime";
  if (normalized.includes("challenges that hp can resolve")) return "challenges";
  if (normalized.includes("other feedback") || normalized.includes("recommendations")) return "feedback";
  return null;
}

export function canonicalizeInbound(raw: Record<string, unknown>, mappings: InboundFieldMappings = {}) {
  const normalized = new Map(Object.entries(raw).map(([key, value]) => [normalizeKey(key), value]));
  const result: Record<string, unknown> = {};
  for (const [heading, value] of Object.entries(raw)) {
    const target = automaticTarget(heading);
    if (target && result[target] === undefined) result[target] = value;
  }
  for (const [heading, target] of Object.entries(mappings)) {
    if (normalized.has(normalizeKey(heading))) result[target] = normalized.get(normalizeKey(heading));
  }
  return result;
}

function structuredEventFeedback(fields:Record<string,unknown>) {
  const values={
    overallExperience:text(fields.overallExperience),clubSuggestions:text(fields.clubSuggestions),
    hpSessionRating:text(fields.hpSessionRating),workshopRating:text(fields.workshopRating),
    demoRating:text(fields.demoRating),futureTopics:text(fields.futureTopics),
    followUpDate:text(fields.followUpDate),followUpTime:text(fields.followUpTime),
    challenges:text(fields.challenges),
  };
  return Object.fromEntries(Object.entries(values).filter(([,value])=>Boolean(value)));
}

export function hasInboundCompanyMapping(headings: string[], mappings: InboundFieldMappings = {}) {
  if (Object.values(mappings).includes("companyName")) return true;
  return headings.some(heading => automaticTarget(heading) === "companyName");
}

export function inboundResponseIdentity(fields: Record<string, unknown>) {
  const submittedAt = text(fields.submittedAt);
  if (!submittedAt) return null;
  return [
    submittedAt,
    text(fields.email).toLowerCase(),
    text(fields.phone).replace(/\D/g, ""),
  ].join("|");
}

function decodeWordXml(value: string) {
  return value.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim();
}

function parseDocx(buffer: Buffer): Record<string, unknown>[] {
  const zip = new AdmZip(buffer);
  const xml = zip.readAsText("word/document.xml");
  const record: Record<string, unknown> = {};
  for (const rowXml of xml.match(/<w:tr\b[\s\S]*?<\/w:tr>/g) ?? []) {
    const cells = (rowXml.match(/<w:tc\b[\s\S]*?<\/w:tc>/g) ?? []).map(decodeWordXml).filter(Boolean);
    if (cells.length >= 2) record[cells[0]] = cells.slice(1).join(" ");
  }
  const xmlWithoutTables = xml.replace(/<w:tbl\b[\s\S]*?<\/w:tbl>/g, "");
  for (const paragraph of xmlWithoutTables.match(/<w:p\b[\s\S]*?<\/w:p>/g) ?? []) {
    const line = decodeWordXml(paragraph);
    const match = line.match(/^([^:]{2,80}):\s*(.+)$/);
    if (match) record[match[1]] = match[2];
  }
  return Object.keys(record).length ? [record] : [];
}

export function parseInboundRows(fileName: string, mimeType: string, buffer: Buffer): Record<string, unknown>[] {
  const ext = path.extname(fileName).toLowerCase();
  if (ext === ".docx" || mimeType.includes("wordprocessingml") || mimeType === "application/vnd.google-apps.document") return parseDocx(buffer);
  if ([".xlsx", ".xls", ".csv"].includes(ext) || /spreadsheet|excel|csv/.test(mimeType) || mimeType === "application/vnd.google-apps.spreadsheet") {
    const workbook = XLSX.read(buffer, { type: "buffer", cellDates: true });
    return workbook.SheetNames.flatMap(sheetName => {
      const worksheet = workbook.Sheets[sheetName];
      if (!worksheet) return [];
      return XLSX.utils.sheet_to_json<Record<string, unknown>>(worksheet, { defval: "" });
    });
  }
  throw new Error(`Unsupported file type for ${fileName}. Use .docx, .xlsx, .xls, or .csv.`);
}

export function driveFolderId(folderUrl: string) {
  const value = folderUrl.trim();
  const match = value.match(/\/folders\/([A-Za-z0-9_-]+)/) || value.match(/[?&]id=([A-Za-z0-9_-]+)/);
  if (match) return match[1];
  if (/^[A-Za-z0-9_-]{10,}$/.test(value)) return value;
  throw new Error("Enter a valid Google Drive folder URL or folder ID");
}

export type InboundRoutingRule = {
  id:number; client_id:number|null; match_type:"product"|"category"|"fallback"; keywords:unknown;
  classification?:"hot"|"warm"|"all"; journey_id:number|null; sequence_id:number; product_name:string|null; category_name:string|null;
  inbound_product_name?:string|null; inbound_category_name?:string|null;
  name?:string;enabled?:boolean;
};

const matchText=(haystack:string,needle:string)=>normalizeKey(haystack).includes(normalizeKey(needle));
/** Read-only audit: use today's applicable saved destination, never a stale
 * routed_rule_id or an unrelated membership elsewhere at the account. Keep
 * rejected answers visible to explain why their routing is blocked. */
export function inboundRoutingAuditTargets(
  submission: { product_interest: string | null; classification: "hot"|"warm"|"cold";
    affinity_reviews?: Record<string, unknown> | null },
  rules: InboundRoutingRule[], clientId: number, categoryRules: InboundCategoryConfig,
  catalog: ImportCatalogProduct[] = [],
) {
  const products = splitSelections(submission.product_interest);
  return (products.length ? products : [""]).map(product => ({
    product,
    rejected: submission.affinity_reviews?.[product] === "rejected",
    rule: matchingInboundRoutingRule(rules, clientId, product, submission.classification, catalog,
      submission.affinity_reviews, categoryRules),
  }));
}

export function matchingInboundRoutingRule(rules:InboundRoutingRule[],clientId:number,interest:string,classification:"hot"|"warm"|"cold"="warm",catalog:ImportCatalogProduct[]=[],overrides?:Record<string,unknown>|null,categoryRules?:InboundCategoryConfig):InboundRoutingRule|undefined {
  // Legacy "all" rules may still be saved, but must never route Hot or Cold.
  if (classification !== "warm") return undefined;
  const scoped=rules.filter(rule=>rule.client_id===clientId
    && (rule.classification==="all"||(rule.classification??"warm")==="warm"));
  const matches=(rule:InboundRoutingRule)=>{
    const keywords=Array.isArray(rule.keywords)?rule.keywords.map(text).filter(Boolean):[];
    const target=rule.match_type==="product"?rule.product_name:rule.category_name;
    const selections=splitSelections(interest);
    const missingAnswer=!selections.some(selection=>!/^(?:n\/?a|none|no|nil|not interested|-+)$/i.test(selection));
    const reviewedMissingCategory=missingAnswer?categoryForMissingInterest(overrides):null;
    return rule.match_type==="product"&&Boolean(rule.inbound_product_name
      ?selections.some(selection=>{
        const assigned=inboundCategoryForInterest(selection,overrides,categoryRules);
        return assigned.productName===rule.inbound_product_name
          &&(!rule.inbound_category_name||assigned.categoryName===rule.inbound_category_name);
      }):target&&matchText(interest,target))
      ||rule.match_type==="category"&&missingAnswer
        &&(reviewedMissingCategory
          ?rule.inbound_category_name===reviewedMissingCategory
          :rule.inbound_category_name==="No Category")
      ||rule.match_type==="category"&&Boolean(rule.inbound_category_name||rule.category_name)&&selections.some(selection=>{
        const assigned=inboundCategoryForInterest(selection,overrides,categoryRules);
        if(rule.inbound_category_name)return assigned.categoryName===rule.inbound_category_name;
        if(inboundCategories.includes(rule.category_name!))return assigned.categoryName===rule.category_name;
        if(matchText(selection,rule.category_name!))return true;
        const product=inferProductsFromInterest(selection,catalog)[0];
        const categories=inferCategoriesFromInterest(selection,catalog);
        return product?.category===rule.category_name
          ||categories.length===1&&categories[0].category===rule.category_name;
      })
      ||keywords.some(keyword=>matchText(interest,keyword));
  };
  return scoped.find(rule=>rule.match_type==="product"&&matches(rule))
    ??scoped.find(rule=>rule.match_type==="category"&&inboundCategories.includes(rule.inbound_category_name??rule.category_name??"")&&matches(rule))
    ??scoped.find(rule=>rule.match_type==="category"&&matches(rule))
    ??scoped.find(rule=>rule.match_type==="fallback");
}

type RuleCohortRow={
  submissionId:number;clientId:number;accountId:number;accountName:string;productAffinity:string|null;
  submissionClassification:"hot"|"warm"|"cold";routingStatus:string;routingError:string|null;
  routedRuleId:number|null;affinityReviews?:Record<string,unknown>|null;manualSelection?:string|null;
};

export function groupInboundRuleCohorts(rules:InboundRoutingRule[],rows:RuleCohortRow[],catalog:ImportCatalogProduct[]=[],categoryRules?:InboundCategoryConfig){
  const groups=new Map(rules.map(rule=>[rule.id,{
    ruleId:rule.id,name:rule.name??`Rule ${rule.id}`,classification:rule.classification??"warm",
    matchType:rule.match_type,enabled:rule.enabled??true,
    accounts:new Map<number,{id:number;name:string;responses:number;failures:Set<string>}>(),
    routed:0,pending:0,failed:0,
  }]));
  const enabledRules=rules.filter(rule=>rule.enabled!==false);
  for(const row of rows){
    if(row.manualSelection)continue;
    const selected=splitSelections(row.productAffinity);
    const accepted=selected.filter(selection=>row.affinityReviews?.[selection]!=="rejected");
    const matched=selected.length&&!accepted.length?undefined:
      matchingInboundRoutingRule(enabledRules,row.clientId,accepted.join("; "),row.submissionClassification,catalog,row.affinityReviews,categoryRules);
    const ruleId=row.routingStatus==="routed"&&groups.has(Number(row.routedRuleId))
      ?Number(row.routedRuleId):matched?.id;
    const group=ruleId===undefined?undefined:groups.get(ruleId);
    if(!group)continue;
    const account=group.accounts.get(row.accountId)??{
      id:row.accountId,name:row.accountName,responses:0,failures:new Set<string>(),
    };
    account.responses++;
    if(row.routingStatus==="routed")group.routed++;
    else if(row.routingStatus==="error"){
      group.failed++;
      account.failures.add(row.routingError??"Routing failed");
    }else group.pending++;
    group.accounts.set(row.accountId,account);
  }
  return [...groups.values()].sort((a,b)=>b.ruleId-a.ruleId).map(group=>({
    ruleId:group.ruleId,name:group.name,classification:group.classification,
    matchType:group.matchType,enabled:group.enabled,accountCount:group.accounts.size,
    accounts:[...group.accounts.values()].map(account=>({...account,failures:[...account.failures]}))
      .sort((a,b)=>a.name.localeCompare(b.name)),routed:group.routed,pending:group.pending,failed:group.failed,
  }));
}

export async function routePendingWarmSubmissions(
  tenantId:number,submissionIds?:number[],onlyRuleId?:number,
  approvedHpClientId?:number,
) {
  if (approvedHpClientId !== undefined && !hpRuleSequenceEnabled()) return {routed:0,pending:0,failed:0};
  // The same policy applies to background checks AND save/retry/import paths.
  // Otherwise a UI save could create an unauthorised enrollment that the
  // scoped processor would correctly refuse to resume.
  const hpClients = hpRuleSequenceEnabled()
    ? (await pool.query(`SELECT id FROM clients WHERE tenant_id=$1 AND ${hpClientNameSql("name")}`,[tenantId])).rows.map(r=>Number(r.id))
    : [];
  const approvedClients = new Set(hpClients);
  if (approvedHpClientId !== undefined && !approvedClients.has(approvedHpClientId))
    throw new Error("Automatic routing requires an owned HP client");
  const categoryRules=await loadInboundCategoryRules(tenantId);
  const submissionSql=`SELECT s.id,s.client_id,s.contact_id,s.product_interest,s.affinity_reviews,s.classification,
      s.raw_fields,src.field_mappings AS source_mappings,c.email,c.dnc,s.identity_review,s.account_id,
      s.reviewed_email
      FROM intent_inbound_submissions s LEFT JOIN contacts c ON c.id=s.contact_id AND c.tenant_id=s.tenant_id
      LEFT JOIN intent_inbound_sources src ON src.id=s.source_id AND src.tenant_id=s.tenant_id
       WHERE s.tenant_id=$1 AND s.classification='warm' AND s.routing_status IN ('pending','error')
      AND ($2::int[] IS NULL OR s.id=ANY($2::int[])) AND s.id>$3
      AND ($4::int IS NULL OR s.client_id=$4)
      ORDER BY s.id LIMIT 5000`;
  const selectedIds=submissionIds?.length?submissionIds:null;
  const [rulesResult,submissionsResult]=await Promise.all([
    pool.query<InboundRoutingRule & {enabled:boolean;journey_status:string;sequence_status:string;sequence_client_id:number}>(`SELECT r.id,r.client_id,r.match_type,r.classification,r.keywords,r.journey_id,r.sequence_id,
      r.enabled,j.status AS journey_status,es.status AS sequence_status,es.client_id AS sequence_client_id,
      r.inbound_product_name,r.inbound_category_name,
      COALESCE(r.inbound_product_name,p.name) AS product_name,
      COALESCE(r.inbound_category_name,pc.name) AS category_name
      FROM intent_inbound_routing_rules r
      LEFT JOIN journeys j ON j.id=r.journey_id AND j.tenant_id=r.tenant_id
      JOIN email_sequences es ON es.id=r.sequence_id AND es.tenant_id=r.tenant_id
      LEFT JOIN intent_products p ON p.id=r.product_id AND p.tenant_id=r.tenant_id
      LEFT JOIN intent_product_categories pc ON pc.id=r.category_id AND pc.tenant_id=r.tenant_id
      WHERE r.tenant_id=$1 AND (r.enabled=true OR r.client_id=ANY($2::int[])) AND r.journey_id IS NOT NULL AND j.id IS NOT NULL
        AND (es.status='active' OR r.client_id=ANY($2::int[]))
        AND ($3::int IS NULL OR r.client_id=$3)
        AND (NOT (r.client_id=ANY($2::int[])) OR j.client_id=r.client_id)
      ORDER BY r.priority,r.id`,[tenantId,hpClients,approvedHpClientId??null]),
    pool.query<any>(submissionSql,[tenantId,selectedIds,0,approvedHpClientId??null]),
  ]);
  const catalog=rulesResult.rows.some(rule=>rule.match_type==="category")
    ?(await pool.query<ImportCatalogProduct>(`SELECT p.id,p.name,c.name AS category,sub.name AS subcategory
      FROM intent_products p JOIN intent_product_categories c ON c.id=p.category_id AND c.tenant_id=p.tenant_id
      LEFT JOIN intent_product_subcategories sub ON sub.id=p.subcategory_id AND sub.tenant_id=p.tenant_id
      WHERE p.tenant_id=$1 AND p.active=true`,[tenantId])).rows:[];
  let routed=0,pending=0,failed=0;
  let batch=submissionsResult.rows;
  while(batch.length){
  for(const submission of batch){
     if(submission.classification!=="warm"){pending++;continue;}
     const approvedHp=approvedClients.has(Number(submission.client_id));
     if(submission.identity_review==="keep"){
       await pool.query(`UPDATE intent_inbound_submissions SET routing_status='error',
         routing_error='Source contact retained after email conflict review; email routing is blocked for this response.',updated_at=NOW()
         WHERE tenant_id=$1 AND id=$2 AND routing_status IN ('pending','error')`,[tenantId,submission.id]);
       failed++;continue;
     }
     const formEmail=text(canonicalizeInbound(submission.raw_fields??{},submission.source_mappings??{}).email).toLowerCase();
     const conflict=formEmail && submission.identity_review!=="relink"
       ? await pool.query(`SELECT 1 FROM contacts WHERE tenant_id=$1 AND lower(btrim(email))=$2
           AND company_id IS DISTINCT FROM $3 LIMIT 1`,[tenantId,formEmail,submission.account_id]):null;
     if(conflict?.rowCount){
       await pool.query(`UPDATE intent_inbound_submissions SET routing_status='error',
         routing_error='Form email belongs to another account. Admin identity review required.',updated_at=NOW()
         WHERE tenant_id=$1 AND id=$2 AND routing_status IN ('pending','error')`,[tenantId,submission.id]);
       failed++;continue;
     }
     if(submission.identity_review==="relink"){
       const valid=await pool.query(`SELECT 1 FROM contacts WHERE tenant_id=$1 AND id=$2
         AND company_id=$3 AND lower(btrim(email))=$4 LIMIT 1`,
         [tenantId,submission.contact_id,submission.account_id,submission.reviewed_email]);
       if(!valid.rowCount){failed++;continue;}
     }
    const selected=splitSelections(submission.product_interest);
    const accepted=selected.filter(selection=>submission.affinity_reviews?.[selection]!=="rejected");
    if(selected.length&&!accepted.length){if(!onlyRuleId)pending++;continue;}
    const rule=matchingInboundRoutingRule(rulesResult.rows,submission.client_id,accepted.join("; "),submission.classification,catalog,submission.affinity_reviews,categoryRules);
    if(!rule){if(!onlyRuleId)pending++;continue;}
    if(onlyRuleId && rule.id!==onlyRuleId)continue;
    if(!rule.journey_id){pending++;continue;}
    // A configured but unpublished specific route must not silently fall
    // through to a generic journey with a different pitch.
    const readiness = rule as typeof rulesResult.rows[number];
    if (approvedHp && (!readiness.enabled || readiness.journey_status!=="published"
      || readiness.sequence_status!=="active" || readiness.sequence_client_id!==submission.client_id)) {
      await pool.query(`UPDATE intent_inbound_submissions SET routing_error=$1,updated_at=NOW()
        WHERE tenant_id=$2 AND id=$3 AND routing_status IN ('pending','error')`,
      ["The matching rule is disabled or its destination is not published/active. Draft destinations were not activated.",tenantId,submission.id]);
      pending++;continue;
    }
    let emailRecoveryIssue:string|null=null;
    if(submission.contact_id&&!submission.email&&!submission.dnc){
      const candidate=text(canonicalizeInbound(submission.raw_fields??{},submission.source_mappings??{}).email).toLowerCase();
      if(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(candidate)){
        const recovered=await pool.query<{email:string}>(`UPDATE contacts SET email=$1,updated_at=NOW()
          WHERE tenant_id=$2 AND id=$3 AND (email IS NULL OR btrim(email)='')
            AND NOT EXISTS(SELECT 1 FROM contacts WHERE tenant_id=$2 AND lower(btrim(email))=$1 AND id<>$3)
          RETURNING email`,[candidate,tenantId,submission.contact_id]);
        submission.email=recovered.rows[0]?.email??null;
        if(!submission.email){
          const conflict=await pool.query(`SELECT 1 FROM contacts
            WHERE tenant_id=$1 AND id<>$2 AND lower(btrim(email))=$3 LIMIT 1`,
            [tenantId,submission.contact_id,candidate]);
          if(conflict.rowCount)emailRecoveryIssue="The form email belongs to another contact. Review the contact before retrying.";
        }
      }
    }
    if(!submission.contact_id||!submission.email||submission.dnc){
      await pool.query(`UPDATE intent_inbound_submissions SET routing_status='error',routing_error=$1,updated_at=NOW()
        WHERE tenant_id=$2 AND id=$3`,[submission.dnc?"Contact is on the DNC list":emailRecoveryIssue??"A valid contact email is required for email cadence",tenantId,submission.id]);
      failed++;continue;
    }
    const client=await pool.connect();
    let enrollment:{id:number;stepId:number|null;sequenceId:number;contactId:number}|null=null;
    try{
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock($1::int,914357)",[tenantId]);
       const locked=await client.query(`SELECT routing_status,contact_id,identity_review,account_id,classification FROM intent_inbound_submissions WHERE tenant_id=$1 AND id=$2 FOR UPDATE`,[tenantId,submission.id]);
      if(!locked.rows[0]||!["pending","error"].includes(locked.rows[0].routing_status)){await client.query("ROLLBACK");continue;}
      if(locked.rows[0].classification!=="warm"){await client.query("ROLLBACK");pending++;continue;}
      if(approvedHp&&!await hpContactMayNurture(tenantId,submission.client_id,submission.contact_id,client)){
        await client.query("ROLLBACK");pending++;continue;
      }
       if(!locked.rows[0].contact_id||locked.rows[0].contact_id!==submission.contact_id||
         locked.rows[0].identity_review!==submission.identity_review||locked.rows[0].account_id!==submission.account_id){
        await client.query("ROLLBACK");failed++;continue;
      }
      const live=await client.query(`SELECT id FROM contacts WHERE tenant_id=$1 AND id=$2
        AND client_id=$3 AND company_id=$4 AND NOT dnc AND NOT is_anonymous AND status='active'
        AND email ~ '^[^[:space:]@]+@[^[:space:]@]+\\.[^[:space:]@]+$' FOR SHARE`,
      [tenantId,submission.contact_id,submission.client_id,submission.account_id]);
      if(!live.rowCount){await client.query("ROLLBACK");failed++;continue;}
      const destination=await client.query(`SELECT r.id FROM intent_inbound_routing_rules r
        JOIN journeys j ON j.id=r.journey_id AND j.tenant_id=r.tenant_id AND j.client_id=r.client_id
        JOIN email_sequences es ON es.id=r.sequence_id AND es.tenant_id=r.tenant_id
        WHERE r.id=$1 AND r.tenant_id=$2 AND r.client_id=$3 AND r.enabled
          AND r.journey_id=$4 AND r.sequence_id=$5 AND j.status='published' AND es.status='active'
          AND (es.client_id IS NULL OR es.client_id=r.client_id) FOR SHARE OF r,j,es`,
      [rule.id,tenantId,submission.client_id,rule.journey_id,rule.sequence_id]);
      if(!destination.rowCount){await client.query("ROLLBACK");pending++;continue;}
      if(rule.journey_id){
        await client.query(`INSERT INTO journey_contacts(journey_id,contact_id,added_via)
          SELECT $1,$2,'inbound_form_rule' WHERE NOT EXISTS(
            SELECT 1 FROM journey_contacts WHERE journey_id=$1 AND contact_id=$2)`,[rule.journey_id,submission.contact_id]);
      }
      if (approvedHp) {
        await enrollHpRuleSequence(client,tenantId,submission.client_id,submission.contact_id,rule.id,accepted);
      } else {
      const existing=await client.query(`SELECT id FROM sequence_enrollments
        WHERE sequence_id=$1 AND contact_id=$2 AND (status='active' OR enrolled_at>=NOW()-interval '24 hours')
        ORDER BY enrolled_at DESC LIMIT 1`,[rule.sequence_id,submission.contact_id]);
      if(!existing.rows[0]){
        const first=await client.query<{id:number}>("SELECT id FROM sequence_steps WHERE sequence_id=$1 ORDER BY step_order,id LIMIT 1",[rule.sequence_id]);
        const stepId=first.rows[0]?.id??null,currentStepId=stepId??-1;
        const inserted=await client.query<{id:number}>(`INSERT INTO sequence_enrollments(sequence_id,contact_id,status,current_step_id)
          VALUES($1,$2,'active',$3) ON CONFLICT (sequence_id,contact_id) WHERE status='active' DO NOTHING RETURNING id`,
          [rule.sequence_id,submission.contact_id,currentStepId]);
        if(inserted.rows[0]) enrollment={id:inserted.rows[0].id,stepId,sequenceId:rule.sequence_id,contactId:submission.contact_id};
      }
      }
      await client.query(`UPDATE intent_inbound_submissions SET routed_rule_id=$1,routing_status='routed',
        routing_error=NULL,routed_at=NOW(),updated_at=NOW() WHERE tenant_id=$2 AND id=$3`,[rule.id,tenantId,submission.id]);
      await client.query("COMMIT");routed++;
    }catch(error){
      await client.query("ROLLBACK");
      await pool.query(`UPDATE intent_inbound_submissions SET routing_status='error',routing_error=$1,updated_at=NOW()
        WHERE tenant_id=$2 AND id=$3`,[error instanceof Error?error.message:"Routing failed",tenantId,submission.id]);
      failed++;
    }finally{client.release();}
    if(enrollment){
      const queueAvailable=await isTenantQueueAvailable(tenantId);
      if(queueAvailable&&enrollment.stepId){
        try{await enqueueStep({enrollmentId:enrollment.id,stepId:enrollment.stepId,sequenceId:enrollment.sequenceId,contactId:enrollment.contactId,tenantId});}
        catch{await pool.query("UPDATE sequence_enrollments SET resume_at=NOW() WHERE id=$1",[enrollment.id]);}
      }else await pool.query("UPDATE sequence_enrollments SET resume_at=NOW() WHERE id=$1",[enrollment.id]);
    }
  }
  if(batch.length<5000)break;
  batch=(await pool.query<any>(submissionSql,[tenantId,selectedIds,Number(batch[batch.length-1].id),approvedHpClientId??null])).rows;
  }
  return {routed,pending,failed};
}

export async function routeInboundRespondent(
  tenantId:number,submissionId:number,selection:string,journeyId:number,sequenceId:number,
  {startSequence=false}:{startSequence?:boolean}={},
):Promise<{routed:true;emailStarted?:boolean}|{error:string;status:number}> {
  const row=await pool.query<any>(`SELECT s.id,s.client_id,s.contact_id,s.product_interest,s.affinity_reviews,s.identity_review,s.reviewed_email,s.account_id,s.classification,
    s.raw_fields,src.field_mappings,c.email,c.dnc
    FROM intent_inbound_submissions s
    LEFT JOIN intent_inbound_sources src ON src.tenant_id=s.tenant_id AND src.id=s.source_id
    LEFT JOIN contacts c ON c.tenant_id=s.tenant_id AND c.id=s.contact_id
    WHERE s.tenant_id=$1 AND s.id=$2`,[tenantId,submissionId]);
  const submission=row.rows[0];
  if(!submission)return {error:"Inbound response not found",status:404};
  if(submission.classification!=="warm")return {error:WARM_ONLY_ROUTING_MESSAGE,status:409};
  if(submission.identity_review==="keep")
    return {error:"Source contact retained after email conflict review; email routing is blocked for this response.",status:409};
  if(submission.identity_review==="relink"){
    const valid=await pool.query(`SELECT 1 FROM contacts WHERE tenant_id=$1 AND id=$2
      AND company_id=$3 AND lower(btrim(email))=$4 LIMIT 1`,
      [tenantId,submission.contact_id,submission.account_id,submission.reviewed_email]);
    if(!valid.rowCount)return {error:"The reviewed email owner changed. Refresh and review again.",status:409};
  }
  const formEmail=text(canonicalizeInbound(submission.raw_fields??{},submission.field_mappings??{}).email).toLowerCase();
  if(formEmail && submission.identity_review!=="relink"){
    const conflict=await pool.query(`SELECT 1 FROM contacts c WHERE c.tenant_id=$1 AND lower(btrim(c.email))=$2
      AND c.id IS DISTINCT FROM $3 LIMIT 1`,[tenantId,formEmail,submission.contact_id]);
    if(conflict.rowCount)return {error:"Form email belongs to another contact. Admin identity review required before routing.",status:409};
  }
  if(!splitSelections(submission.product_interest).includes(selection)
    ||/^(?:n\/?a|none|no|nil|not interested|-+)$/i.test(selection)
    ||submission.affinity_reviews?.[selection]==="rejected"){
    return {error:"Choose a product interest from this respondent's response",status:400};
  }
  const [journey,sequence]=await Promise.all([
    pool.query(`SELECT 1 FROM journeys WHERE tenant_id=$1 AND id=$2 AND client_id=$3 AND status<>'archived'`,
      [tenantId,journeyId,submission.client_id]),
    pool.query(`SELECT 1 FROM email_sequences WHERE tenant_id=$1 AND id=$2
      AND (client_id IS NULL OR client_id=$3)
      AND (status='active' OR ($4::boolean AND status='draft'))`,
      [tenantId,sequenceId,submission.client_id,!startSequence]),
  ]);
  if(!journey.rowCount||!sequence.rowCount)return {error:startSequence
    ?"Choose a journey and an active sequence for this client"
    :"Choose a journey and a draft or active sequence for this client",status:400};
  if(!submission.contact_id)return {error:"This response has no linked contact; review the source details",status:400};
  if(submission.dnc)return {error:"This contact is on the DNC list",status:400};
  if(startSequence&&!submission.email){
    const candidate=text(canonicalizeInbound(submission.raw_fields??{},submission.field_mappings??{}).email).toLowerCase();
    if(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(candidate)){
      const recovered=await pool.query<{email:string}>(`UPDATE contacts SET email=$1,updated_at=NOW()
        WHERE tenant_id=$2 AND id=$3 AND (email IS NULL OR btrim(email)='')
        AND NOT EXISTS(SELECT 1 FROM contacts WHERE tenant_id=$2 AND id<>$3 AND lower(btrim(email))=$1)
        RETURNING email`,[candidate,tenantId,submission.contact_id]);
      submission.email=recovered.rows[0]?.email??null;
    }
  }
  if(startSequence&&!submission.email)return {error:"A valid, unambiguous contact email is required before starting email delivery",status:400};
  const client=await pool.connect();
  let enrollment:{id:number;stepId:number|null}|null=null;
  try{
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1::int,914357)",[tenantId]);
    const locked=await client.query(`SELECT product_interest,affinity_reviews,contact_id,identity_review,account_id,classification FROM intent_inbound_submissions
      WHERE tenant_id=$1 AND id=$2 FOR UPDATE`,[tenantId,submissionId]);
    if(locked.rows[0]?.classification!=="warm"
      ||!await hpContactMayNurture(tenantId,submission.client_id,submission.contact_id,client)){
      await client.query("ROLLBACK");
      return {error:WARM_ONLY_ROUTING_MESSAGE,status:409};
    }
    if(!locked.rows[0]||!splitSelections(locked.rows[0].product_interest).includes(selection)
      ||locked.rows[0].affinity_reviews?.[selection]==="rejected"){
      await client.query("ROLLBACK");
      return {error:"The product interest changed; refresh the account before routing",status:409};
    }
    if(!locked.rows[0].contact_id||locked.rows[0].contact_id!==submission.contact_id){
      await client.query("ROLLBACK");
      return {error:"The linked contact changed; refresh the account before routing",status:409};
    }
    if(locked.rows[0].identity_review!==submission.identity_review||locked.rows[0].account_id!==submission.account_id){
      await client.query("ROLLBACK");
      return {error:"Identity review changed; refresh before routing",status:409};
    }
    const live=await client.query("SELECT id FROM contacts WHERE tenant_id=$1 AND id=$2 FOR SHARE",[tenantId,submission.contact_id]);
    if(!live.rowCount){
      await client.query("ROLLBACK");
      return {error:"The linked contact was deleted; refresh the account before routing",status:409};
    }
    const existing=await client.query(`SELECT id FROM intent_inbound_manual_routes
      WHERE tenant_id=$1 AND submission_id=$2`,[tenantId,submissionId]);
    if(existing.rowCount){
      await client.query("ROLLBACK");
      return {error:"This response has already been routed manually. Existing enrollments are not changed.",status:409};
    }
    await client.query(`INSERT INTO journey_contacts(journey_id,contact_id,added_via)
      SELECT $1,$2,'inbound_form_rule' WHERE NOT EXISTS(
        SELECT 1 FROM journey_contacts WHERE journey_id=$1 AND contact_id=$2)`,
      [journeyId,submission.contact_id]);
    if(startSequence){
    const active=await client.query(`SELECT id FROM sequence_enrollments
      WHERE sequence_id=$1 AND contact_id=$2 AND (status='active' OR enrolled_at>=NOW()-interval '24 hours')
      ORDER BY enrolled_at DESC LIMIT 1`,[sequenceId,submission.contact_id]);
    if(!active.rows[0]){
      const first=await client.query<{id:number}>("SELECT id FROM sequence_steps WHERE sequence_id=$1 ORDER BY step_order,id LIMIT 1",[sequenceId]);
      const stepId=first.rows[0]?.id??null;
      const inserted=await client.query<{id:number}>(`INSERT INTO sequence_enrollments(sequence_id,contact_id,status,current_step_id)
        VALUES($1,$2,'active',$3) ON CONFLICT (sequence_id,contact_id) WHERE status='active' DO NOTHING RETURNING id`,
        [sequenceId,submission.contact_id,stepId??-1]);
      if(inserted.rows[0])enrollment={id:inserted.rows[0].id,stepId};
    }
    }
    await client.query(`INSERT INTO intent_inbound_manual_routes
      (tenant_id,submission_id,contact_id,selection,journey_id,sequence_id)
      VALUES($1,$2,$3,$4,$5,$6)`,
      [tenantId,submissionId,submission.contact_id,selection,journeyId,sequenceId]);
    await client.query(`UPDATE intent_inbound_submissions SET routing_status='routed',routing_error=NULL,
      routed_rule_id=NULL,routed_at=NOW(),updated_at=NOW() WHERE tenant_id=$1 AND id=$2`,[tenantId,submissionId]);
    await client.query("COMMIT");
  }catch(error){
    await client.query("ROLLBACK");
    if((error as {code?:string}).code==="23505")return {error:"This response was already routed; refresh the account",status:409};
    throw error;
  }finally{client.release();}
  if(enrollment){
    const queueAvailable=await isTenantQueueAvailable(tenantId);
    if(queueAvailable&&enrollment.stepId){
      try{await enqueueStep({enrollmentId:enrollment.id,stepId:enrollment.stepId,sequenceId,contactId:submission.contact_id,tenantId});}
      catch{await pool.query("UPDATE sequence_enrollments SET resume_at=NOW() WHERE id=$1",[enrollment.id]);}
    }else await pool.query("UPDATE sequence_enrollments SET resume_at=NOW() WHERE id=$1",[enrollment.id]);
  }
  return startSequence?{routed:true}:{routed:true,emailStarted:false};
}

export type DriveFile = { id: string; name: string; mimeType: string; modifiedTime?: string; createdTime?: string; webViewLink?: string };
type ParsedDriveFile = { rows: Record<string, unknown>[] } | { error: unknown };

async function driveJson(pathname: string) {
  const response = await new ReplitConnectors().proxy("google-drive", pathname, { method: "GET" });
  if (!response.ok) throw new Error(`Google Drive request failed (${response.status}): ${await response.text()}`);
  return response.json() as Promise<any>;
}

export async function googleDriveConnectionAvailable() {
  try {
    const response = await new ReplitConnectors().proxy("google-drive", "/drive/v3/about?fields=user", { method: "GET" });
    return response.ok;
  } catch {
    return false;
  }
}

export async function driveBuffer(file: DriveFile) {
  const googleNative = file.mimeType === "application/vnd.google-apps.document" || file.mimeType === "application/vnd.google-apps.spreadsheet";
  const pathname = googleNative
    ? `/drive/v3/files/${encodeURIComponent(file.id)}/export?mimeType=${encodeURIComponent(file.mimeType.endsWith("document") ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")}`
    : `/drive/v3/files/${encodeURIComponent(file.id)}?alt=media&supportsAllDrives=true`;
  const response = await new ReplitConnectors().proxy("google-drive", pathname, { method: "GET" });
  if (!response.ok) throw new Error(`Could not download ${file.name} (${response.status})`);
  return Buffer.from(await response.arrayBuffer());
}

export async function listDriveFiles(folderId: string) {
  const q = encodeURIComponent(`'${folderId.replace(/'/g, "\\'")}' in parents and trashed = false`);
  const files: DriveFile[] = [];
  let pageToken: string | undefined;
  do {
    const tokenQuery = pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : "";
    const listing = await driveJson(`/drive/v3/files?q=${q}&fields=nextPageToken,files(id,name,mimeType,modifiedTime,createdTime,webViewLink)&pageSize=1000&orderBy=modifiedTime%20desc&supportsAllDrives=true&includeItemsFromAllDrives=true${tokenQuery}`);
    files.push(...((listing.files ?? []) as DriveFile[]));
    pageToken = listing.nextPageToken || undefined;
  } while (pageToken);
  return files;
}

function supportedDriveFile(file: DriveFile) {
  return /\.(docx|xlsx|xls|csv)$/i.test(file.name) || /google-apps\.(document|spreadsheet)/.test(file.mimeType);
}

export async function previewInboundSource(tenantId: number, sourceId: number, scanLimit = 20) {
  const sourceResult = await pool.query<{folder_id:string;field_mappings:InboundFieldMappings}>(
    "SELECT folder_id,field_mappings FROM intent_inbound_sources WHERE tenant_id=$1 AND id=$2", [tenantId, sourceId],
  );
  const source = sourceResult.rows[0];
  if (!source) throw new Error("Inbound source not found");
  const files = (await listDriveFiles(source.folder_id)).filter(supportedDriveFile);
  const headings = new Map<string, { heading:string; samples:string[]; files:Set<string> }>();
  const errors: string[] = [];
  for (const file of files.slice(0, scanLimit)) {
    try {
      const rows = parseInboundRows(file.name, file.mimeType, await driveBuffer(file)).slice(0, 10);
      for (const row of rows) {
        for (const [heading, value] of Object.entries(row)) {
          const key = normalizeKey(heading);
          const entry = headings.get(key) ?? { heading, samples: [], files: new Set<string>() };
          const sample = text(value);
          if (sample && !entry.samples.includes(sample) && entry.samples.length < 3) entry.samples.push(sample);
          entry.files.add(file.name);
          headings.set(key, entry);
        }
      }
    } catch (error) {
      errors.push(`${file.name}: ${error instanceof Error ? error.message : "Preview failed"}`);
    }
  }
  const fields = [...headings.values()].map(entry => ({
    heading: entry.heading,
    automaticTarget: automaticTarget(entry.heading),
    savedTarget: source.field_mappings?.[entry.heading] ?? Object.entries(source.field_mappings ?? {})
      .find(([heading]) => normalizeKey(heading) === normalizeKey(entry.heading))?.[1] ?? null,
    samples: entry.samples,
    files: [...entry.files].slice(0, 3),
  })).sort((a, b) => Number(!!a.automaticTarget) - Number(!!b.automaticTarget) || a.heading.localeCompare(b.heading));
  return {
    files: files.length,
    scannedFiles: Math.min(files.length, scanLimit),
    fields,
    hasCompanyNameMapping: hasInboundCompanyMapping(fields.map(field => field.heading), source.field_mappings),
    errors: errors.slice(0, 10),
  };
}

async function resolveCompany(client: any, tenantId: number, clientId: number, name: string, domain: string | null, hpId?: string | null) {
  if (await isHpClient(tenantId, clientId, client)) {
    const match = await resolveHpAccount(client, tenantId, clientId, hpId || null, name, true);
    if (!match.id) {
      await queueHpMatch(client, tenantId, clientId, `inbound-company:${hpId || name}`, match.reason!, { fields: { companyName: name, hpId }, source: "questionnaire", contactId: null, occurredAt: null });
      return null;
    }
    await ensureHpProfile(client, tenantId, clientId, match.id, name, match.created, "questionnaire");
    return match.id;
  }
  const normalizedDomain = domain?.replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0].toLowerCase() || null;
  const found = await client.query(
    `SELECT id FROM companies WHERE tenant_id=$1 AND client_id=$2 AND
      (($3::text IS NOT NULL AND lower(domain)=$3) OR lower(name)=lower($4)) ORDER BY id LIMIT 1`,
    [tenantId, clientId, normalizedDomain, name],
  );
  if (found.rows[0]) return Number(found.rows[0].id);
  const created = await client.query(
    "INSERT INTO companies(tenant_id,client_id,name,domain) VALUES($1,$2,$3,$4) RETURNING id",
    [tenantId, clientId, name, normalizedDomain],
  );
  return Number(created.rows[0].id);
}

async function resolveContact(client: any, tenantId: number, clientId: number, accountId: number, fields: Record<string, unknown>) {
  const email = text(fields.email).toLowerCase() || null;
  const phone = text(fields.phone) || null;
  if (!email && !phone) return null;
  const conflict=email?await client.query(
    `SELECT 1 FROM contacts WHERE tenant_id=$1 AND lower(btrim(email))=$2
      AND company_id IS DISTINCT FROM $3 LIMIT 1`,[tenantId,email,accountId],
  ):null;
  // An email conflict cannot be resolved by a shared phone number. Only an
  // administrator may select the source-side contact after comparing evidence.
  if(conflict?.rowCount)return null;
  const safeEmail=conflict?.rowCount?null:email;
  if(!safeEmail&&!phone)return null;
  const found = await client.query(
    `SELECT id FROM contacts WHERE tenant_id=$1 AND (company_id=$4 OR company_id IS NULL)
      AND (($2::text IS NOT NULL AND lower(btrim(email))=$2) OR ($3::text IS NOT NULL AND phone=$3))
      ORDER BY CASE WHEN company_id=$4 THEN 0 ELSE 1 END,
        CASE WHEN $2::text IS NOT NULL AND lower(btrim(email))=$2 THEN 0 ELSE 1 END,id LIMIT 1`,
    [tenantId, safeEmail, phone, accountId],
  );
  const fullName = text(fields.name).split(/\s+/);
  const firstName = text(fields.firstName) || fullName[0] || null;
  const lastName = text(fields.lastName) || fullName.slice(1).join(" ") || null;
  if (found.rows[0]) {
    await client.query(
      `UPDATE contacts SET company_id=$1,client_id=COALESCE(client_id,$2),first_name=COALESCE(NULLIF($3,''),first_name),
       last_name=COALESCE(NULLIF($4,''),last_name),title=COALESCE(NULLIF($5,''),title),
       function=COALESCE(NULLIF($6,''),function),city=COALESCE(NULLIF($7,''),city),
       country=COALESCE(NULLIF($8,''),country),linkedin_url=COALESCE(NULLIF($9,''),linkedin_url),
       email=CASE WHEN (email IS NULL OR btrim(email)='') AND $10::text IS NOT NULL
         AND NOT EXISTS(SELECT 1 FROM contacts other WHERE other.tenant_id=$11 AND other.id<>$12 AND lower(btrim(other.email))=$10)
         THEN $10 ELSE email END,
       source='google_drive_inbound',updated_at=NOW() WHERE tenant_id=$11 AND id=$12`,
      [accountId, clientId, firstName, lastName, text(fields.title), text(fields.function), text(fields.city),
        text(fields.country), text(fields.linkedinUrl), safeEmail, tenantId, found.rows[0].id],
    );
    return Number(found.rows[0].id);
  }
  const created = await client.query(
    `INSERT INTO contacts(tenant_id,client_id,company_id,first_name,last_name,email,phone,title,function,city,country,linkedin_url,source)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'google_drive_inbound') RETURNING id`,
    [tenantId, clientId, accountId, firstName, lastName, safeEmail, phone, text(fields.title) || null,
     text(fields.function) || null, text(fields.city) || null, text(fields.country) || null, text(fields.linkedinUrl) || null],
  );
  return Number(created.rows[0].id);
}

export async function syncInboundSource(tenantId: number, sourceId: number) {
  const sourceResult = await pool.query<any>(
    "SELECT * FROM intent_inbound_sources WHERE tenant_id=$1 AND id=$2", [tenantId, sourceId],
  );
  const source = sourceResult.rows[0];
  if (!source) throw new Error("Inbound source not found");
  const hpSource = Boolean(await isHpClient(tenantId, source.client_id));
  const files = (await listDriveFiles(source.folder_id)).filter(supportedDriveFile);
  const parsedFiles = new Map<string, ParsedDriveFile>();
  if (!Object.values(source.field_mappings ?? {}).includes("companyName")) {
    const headings = new Set<string>();
    for (const file of files) {
      try {
        const rows = parseInboundRows(file.name, file.mimeType, await driveBuffer(file));
        parsedFiles.set(file.id, { rows });
        for (const row of rows) for (const heading of Object.keys(row)) headings.add(heading);
      } catch (error) {
        parsedFiles.set(file.id, { error });
      }
    }
    if (!hasInboundCompanyMapping([...headings], source.field_mappings ?? {})) {
      throw new MissingInboundCompanyMappingError();
    }
  }
  let imported = 0, skipped = 0, failed = 0;
  const importedSubmissionIds:number[]=[];
  const errors: string[] = [];
  for (const file of files) {
    try {
      const parsed = parsedFiles.get(file.id);
      if (parsed && "error" in parsed) throw parsed.error;
      const rows = parsed?.rows ?? parseInboundRows(file.name, file.mimeType, await driveBuffer(file));
      const existingRows = await pool.query<{row_key:string;raw_fields:Record<string,unknown>}>(
        `SELECT row_key,raw_fields FROM intent_inbound_submissions
         WHERE tenant_id=$1 AND source_id=$2 AND drive_file_id=$3 ORDER BY id`,
        [tenantId, source.id, file.id],
      );
      const existingKeysByIdentity = new Map<string,string>();
      const ambiguousIdentities = new Set<string>();
      for (const existing of existingRows.rows) {
        const identity = inboundResponseIdentity(canonicalizeInbound(existing.raw_fields ?? {}, source.field_mappings ?? {}));
        if (!identity) continue;
        if (existingKeysByIdentity.has(identity)) ambiguousIdentities.add(identity);
        else existingKeysByIdentity.set(identity, existing.row_key);
      }
      for (const identity of ambiguousIdentities) existingKeysByIdentity.delete(identity);
      for (let index = 0; index < rows.length; index++) {
        const raw = rows[index];
        const fields = canonicalizeInbound(raw, source.field_mappings ?? {});
        const companyName = text(fields.companyName);
        if (!companyName) { skipped++; continue; }
        const classification = classifyInbound({ ...fields, hpLead: hpSource });
        const identity = inboundResponseIdentity(fields);
        const rowKey = identity
          ? existingKeysByIdentity.get(identity) ?? createHash("sha256").update(`response:${identity}`).digest("hex")
          : createHash("sha256").update(JSON.stringify(raw)).digest("hex");
        const identityHash=identity?createHash("sha256").update(identity).digest("hex"):null;
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          // Deletion and import take this tenant-scoped lock before reading or
          // writing responses, so a sync cannot resurrect a just-deleted row.
          await client.query("SELECT pg_advisory_xact_lock($1::int,914357)",[tenantId]);
          const deleted=await client.query(`SELECT 1 FROM intent_inbound_deleted_rows
            WHERE tenant_id=$1 AND source_id=$2 AND drive_file_id=$3
              AND (row_key=$4 OR ($5::text IS NOT NULL AND identity_hash=$5)) LIMIT 1`,
            [tenantId,source.id,file.id,rowKey,identityHash]);
          if(deleted.rowCount){await client.query("ROLLBACK");skipped++;continue;}
          const accountId = await resolveCompany(client, tenantId, source.client_id, companyName, text(fields.domain) || null, text(fields.hpId) || null);
          if (!accountId) { await client.query("COMMIT"); skipped++; continue; }
          const email=text(fields.email).toLowerCase();
          const prior=await client.query<{submitted_at:Date|null;created_at:Date;raw_fields:Record<string,unknown>;identity_review:string|null;reviewed_email:string|null;reviewed_source_account_id:number|null;reviewed_source_contact_id:number|null;contact_id:number|null;account_id:number;identity_reviewed_by:number|null;identity_reviewed_at:Date|null}>(`
            SELECT identity_review,reviewed_email,reviewed_source_account_id,reviewed_source_contact_id,contact_id,account_id,
              identity_reviewed_by,identity_reviewed_at,submitted_at,created_at,raw_fields
            FROM intent_inbound_submissions WHERE tenant_id=$1 AND source_id=$2 AND drive_file_id=$3 AND row_key=$4 FOR UPDATE`,
            [tenantId,source.id,file.id,rowKey]);
          const previous=prior.rows[0];
          const sourceStillValid=previous?.identity_review!=="keep" || Boolean(
            (await client.query(`SELECT 1 FROM contacts WHERE tenant_id=$1 AND id=$2 AND company_id=$3 AND phone=$4`,
              [tenantId,previous?.reviewed_source_contact_id,accountId,text(fields.phone)])).rowCount);
          const keepValid=previous?.identity_review==="keep" && sourceStillValid &&
            previous.reviewed_email===email && Number(previous.reviewed_source_account_id)===accountId &&
            previous.contact_id===previous.reviewed_source_contact_id;
          // A previously kept response must not acquire the disputed email just
          // because its former owner later removed it from their CRM record.
          const preExistingContact = hpSource ? await client.query(`SELECT 1 FROM contacts WHERE tenant_id=$1 AND
            (($2::text<>'' AND lower(btrim(email))=$2) OR ($3::text<>'' AND phone=$3)) LIMIT 1`,
            [tenantId, email, text(fields.phone)]) : null;
          const contactId=keepValid?previous.contact_id:
            await resolveContact(client,tenantId,source.client_id,accountId,fields);
          const owner=email?await client.query<{id:number;company_id:number;client_id:number}>(`SELECT id,company_id,client_id FROM contacts
            WHERE tenant_id=$1 AND lower(btrim(email))=$2 AND company_id IS DISTINCT FROM $3 ORDER BY id`,
            [tenantId,email,accountId]):null;
          const hasConflict=Boolean(owner?.rows[0]);
          const reviewValid=sourceStillValid && previous?.reviewed_email===email &&
            Number(previous.reviewed_source_account_id)===accountId &&
            (previous.identity_review==="keep" && previous.contact_id===previous.reviewed_source_contact_id ||
             previous.identity_review==="relink" && owner?.rows.length===1 &&
               previous.contact_id===owner.rows[0].id &&
               previous.account_id===owner.rows[0].company_id && owner.rows[0].client_id===source.client_id);
          const reviewed=reviewValid?previous.identity_review:null;
          const linkedAccountId=reviewed==="relink"?previous.account_id:accountId;
          const linkedContactId=reviewed?previous.contact_id:contactId;
          const submittedAtRaw=text(fields.submittedAt);
          const sourceDate=submittedAtRaw&&!Number.isNaN(Date.parse(submittedAtRaw))?new Date(submittedAtRaw):null;
          const {submittedAt,dateMetadata}=resolveSubmissionDate(sourceDate,previous,file.createdTime);
          const saved=await client.query<{id:number}>(
            `INSERT INTO intent_inbound_submissions(
              tenant_id,source_id,client_id,account_id,contact_id,drive_file_id,drive_modified_at,row_key,file_name,form_type,
              classification,classification_reason,explicit_interest,requested_demo,purchase_timeframe_months,is_decision_maker,
               feedback,product_interest,submitted_at,event_feedback,raw_fields,
               identity_review,reviewed_email,reviewed_source_account_id,reviewed_source_contact_id,routing_status,routing_error,
               identity_reviewed_by,identity_reviewed_at)
              VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29)
             ON CONFLICT (tenant_id,source_id,drive_file_id,row_key) DO UPDATE SET
              account_id=EXCLUDED.account_id,contact_id=EXCLUDED.contact_id,classification=EXCLUDED.classification,
               classification_reason=EXCLUDED.classification_reason,form_type=EXCLUDED.form_type,
               explicit_interest=EXCLUDED.explicit_interest,requested_demo=EXCLUDED.requested_demo,
               purchase_timeframe_months=EXCLUDED.purchase_timeframe_months,is_decision_maker=EXCLUDED.is_decision_maker,
                feedback=EXCLUDED.feedback,product_interest=EXCLUDED.product_interest,submitted_at=EXCLUDED.submitted_at,
                event_feedback=EXCLUDED.event_feedback,
                affinity_reviews=CASE WHEN intent_inbound_submissions.product_interest IS DISTINCT FROM EXCLUDED.product_interest
                  THEN '{}'::jsonb ELSE intent_inbound_submissions.affinity_reviews END,
               drive_modified_at=EXCLUDED.drive_modified_at,file_name=EXCLUDED.file_name,
                raw_fields=EXCLUDED.raw_fields,identity_review=EXCLUDED.identity_review,
                reviewed_email=EXCLUDED.reviewed_email,reviewed_source_account_id=EXCLUDED.reviewed_source_account_id,
                reviewed_source_contact_id=EXCLUDED.reviewed_source_contact_id,
                identity_reviewed_by=EXCLUDED.identity_reviewed_by,identity_reviewed_at=EXCLUDED.identity_reviewed_at,
                routing_status=CASE WHEN intent_inbound_submissions.routing_status='routed' THEN 'routed'
                  ELSE EXCLUDED.routing_status END,
                routing_error=CASE WHEN intent_inbound_submissions.routing_status='routed' THEN intent_inbound_submissions.routing_error
                  ELSE EXCLUDED.routing_error END,updated_at=NOW()
              RETURNING id`,
             [tenantId, source.id, source.client_id, linkedAccountId, linkedContactId, file.id, file.modifiedTime ?? null, rowKey, file.name,
              source.form_type,
             classification.classification, classification.classificationReason, classification.explicitInterest,
             classification.requestedDemo, classification.purchaseTimeframeMonths, classification.isDecisionMaker,
              text(fields.feedback) || null, text(fields.productInterest) || null, submittedAt,
               source.form_type==="event_feedback"?structuredEventFeedback(fields):{},{...raw,...dateMetadata},reviewed,reviewed?email:null,
               reviewed?accountId:null,reviewed?(previous.reviewed_source_contact_id??contactId):null,
                reviewed==="keep"||hasConflict&&reviewed!=="relink"?"error":"pending",
                reviewed==="keep"?"Source contact retained after email conflict review; email routing is blocked for this response."
                  :hasConflict&&reviewed!=="relink"?"Form email belongs to another account. Admin identity review required.":null,
               reviewed?previous.identity_reviewed_by:null,reviewed?previous.identity_reviewed_at:null],
          );
          importedSubmissionIds.push(saved.rows[0].id);
          if (hpSource) {
            await captureHpLead(client, { tenantId, clientId: source.client_id, accountId: linkedAccountId, contactId: linkedContactId,
              newContact: !preExistingContact?.rowCount, sourceKey: `inbound:${saved.rows[0].id}`, source: "questionnaire", occurredAt: submittedAt,
              actualLead: Boolean(source.form_type !== "event_feedback" || classification.explicitInterest || classification.requestedDemo),
              fields: { ...fields, horizonMonths: classification.purchaseTimeframeMonths },
              lineage: { sourceId: source.id, fileId: file.id, fileName: file.name, rowKey } });
          }
          await client.query("COMMIT");
          imported++;
        } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
      }
    } catch (error) { failed++; errors.push(`${file.name}: ${error instanceof Error ? error.message : "Import failed"}`); }
  }
  const status = failed ? (imported ? "partial" : "failed") : "completed";
  const routing=await routePendingWarmSubmissions(tenantId,importedSubmissionIds);
  const summary = { files: files.length, imported, skipped, failed, routing, errors: errors.slice(0, 20) };
  await pool.query(
    "UPDATE intent_inbound_sources SET last_synced_at=NOW(),last_sync_status=$1,last_sync_summary=$2,updated_at=NOW() WHERE tenant_id=$3 AND id=$4",
    [status, summary, tenantId, sourceId],
  );
  return { status, ...summary };
}
