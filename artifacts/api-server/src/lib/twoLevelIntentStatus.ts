import rules from "./intentStatusRules.json";
import { inboundCategories, inboundCategoryForInterest, type InboundCategoryConfig } from "./inboundTaxonomy";
import { researchSourceText, workforceFacts, sourceRequirementPassages } from "./researchSourceFacts";
import { deriveProductFitments } from "./signalProductFit";
import { RESEARCH_CAPABILITIES } from "./researchIntentEvidence";
import { isResearchGeographyEligible } from "./researchGeography";

type Status = "hot" | "warm" | "cold";
type Strength = "strong" | "moderate" | "weak" | "none" | "negative" | "ambiguous";
type Attribution = "CONFIRMED" | "PROBABLE" | "POSSIBLE" | "INHERITED_OPEN" | "NONE";

export type IntentStatusEvidence = {
  id: number;
  evidenceKind: string;
  eventType: string | null;
  excerpt: string;
  sourceUrl: string | null;
  occurredAt: Date | string;
  confidence: number;
  reviewStatus: string;
  context: Record<string, unknown>;
  raw_evidence?: unknown;
};

export type CategoryStatus = {
  key: string;
  name: string;
  status: Status;
  attribution: Attribution;
  drivingSignals: Array<{ evidenceId: number; signalType: string; quote: string; sourceUrl: string | null; occurredAt: string; strength: Strength }>;
  lastTriggerDate: string | null;
  expiresAt: string | null;
  statusReason: string;
  nextPlay: string;
};

type DrivingSignal = { evidenceId: number; signalType: string; quote: string; sourceUrl: string | null; occurredAt: string; strength: Strength };

export type TwoLevelIntentStatus = {
  accountStatus: Status;
  accountFlag: "category_open" | null;
  accountExplanation: string;
  accountDrivingSignals: DrivingSignal[];
  categories: CategoryStatus[];
  negativeConflict: boolean;
  evaluatedAt: string;
  rulesVersion: number;
};

const day = 86_400_000;
const signalRules = rules.signals as Record<string,{hotQualifying:boolean;accountTrigger?:Status;negativeCap?:boolean;matrix:Strength[]}>;
const normalized = (value: unknown) => String(value ?? "").toLowerCase();
const strengthRank: Record<Strength,number> = { none:0,negative:0,ambiguous:1,weak:2,moderate:3,strong:4 };

function intentCategoryKey(name:string) {
  return name.toLocaleUpperCase().replace(/[^A-Z0-9]+/g,"_").replace(/^_|_$/g,"");
}

function evidenceCategory(row:IntentStatusEvidence, config:InboundCategoryConfig) {
  const context=row.context??{};
  const explicit=String(context.inboundCategoryName??"");
  const supportedPassages = row.evidenceKind === "public_event" ? sourceRequirementPassages(row.excerpt)
    .filter(text => deriveProductFitments({text,eventType:row.eventType},RESEARCH_CAPABILITIES).length > 0).join(" ") : row.excerpt;
  const descriptors=(row.evidenceKind === "public_event" ? [supportedPassages] : [explicit,context.productName,context.productCategory,context.productSubcategory,row.excerpt])
    .filter(value=>typeof value==="string"&&value.trim()).join(" ");
  const match=inboundCategoryForInterest(descriptors,null,config);
  if(inboundCategories.includes(match.categoryName))return match.categoryName;
  const text=normalized(descriptors);
  const signals=classifySignal(row);
  if(signals.includes("endpoint_refresh")&&/\b(endpoint|device|laptop|desktop|workstation|pc)\b/.test(text))return "IT Hardware";
  if((signals.includes("zero_trust")||signals.includes("regulatory_breach")||signals.includes("it_security_hiring"))
    &&/\b(security|cyber|endpoint|zero trust|ransomware|breach)\b/.test(text))return "Security";
  if(signals.includes("uc_collaboration")&&/\b(video|conference|headset|meeting room|teams room|zoom room|webex|ucaas)\b/.test(text))return "Business Collaboration";
  if(signals.includes("paperless")&&/\b(document|workflow|paperless|digitis|e-signature)\b/.test(text))return "Business Services";
  return null;
}

function classifySignal(row: IntentStatusEvidence): string[] {
  const context = row.context ?? {};
  const ai = context.aiReview && typeof context.aiReview === "object" ? context.aiReview as Record<string,unknown> : {};
  // Never classify from provider queries or other retrieval metadata. Search plans contain
  // words such as "jobs", "RFP", and "vendor" that are not facts from the source.
  const text = normalized(row.excerpt);
  const output = new Set<string>();
  const hiring = /\b(hiring|recruit(?:ment|ing)|vacanc(?:y|ies)|job (?:opening|posting)s?|walk-?in)\b/.test(text);
  if (hiring && !workforceFacts(text).contraction && row.eventType !== "layoffs") {
    if (/\b(cloud|devops|network|infrastructure)\b/.test(text)) output.add("it_infrastructure_hiring");
    if (/\b(ciso|soc\b|cyber|security|grc\b)\b/.test(text)) output.add("it_security_hiring");
    if (/\b(helpdesk|desktop support|endpoint|euc\b|itsm|intune|sccm)\b/.test(text)) output.add("endpoint_support_hiring");
    if (/\b(cio|cto|vp of it|head of it|it head|technology head)\b/.test(text)) output.add("it_leadership_hiring");
    if (/\b(procurement|strategic sourcing|vendor management)\b/.test(text)
      && /\b(hiring|recruit(?:ment|ing)|vacanc(?:y|ies)|job (?:opening|posting)s?|seeking|role)\b/.test(text)) output.add("procurement_hiring");
    if (/\b(facilities|workplace|real estate|office manager|meeting room|av\b)\b/.test(text)) output.add("workplace_hiring");
    if (/\b(contact cent(?:er|re)|call cent(?:er|re)|bpo|customer support|telesales)\b/.test(text)) output.add("contact_center_hiring");
    if (/\b(sales|business development|field ops|relationship manager|branch staff)\b/.test(text)) output.add("sales_branch_hiring");
    if (/\b(finance|accounts|compliance|legal|audit|records)\b/.test(text)) output.add("finance_compliance_hiring");
    if (/\b(software|developer|data|artificial intelligence|machine learning|engineering|design|cad\b)\b/.test(text)) output.add("engineering_hiring");
    if (/\b(operations|plant|logistics|warehouse|retail store)\b/.test(text)) output.add("operations_hiring");
    if (/\b(remote|hybrid)\b/.test(text)) output.add("remote_hybrid_hiring");
    if (/\b(digital transformation|pmo\b|erp\b|crm\b|programme manager|program manager)\b/.test(text)) output.add("transformation_hiring");
    if (/\b(\d{3,}\s+(roles|jobs|employees|people|agents)|high.volume hiring|mass hiring|multi.location|walk-?in)\b/.test(text)) output.add("high_volume_hiring");
  }
  if (/\b(revenue|profit|ebitda|margin)\b.*\b(grew|growth|increased|improved|up\s+\d|rise|rose)\b|\b(growth|increased|improved)\b.*\b(revenue|profit|ebitda|margin)\b/.test(text)) output.add("financial_growth");
  if (/\b(capex|capital expenditure|investment guidance|invest(?:ment|ing)?)\b/.test(text)) {
    if (/\b(technology|digital|software|cloud|cyber|it infrastructure|data cent(?:er|re))\b/.test(text)) output.add("capex_technology");
    else if (/\b(office|branch|campus|site)\b/.test(text)) output.add("capex_offices_sites");
    else output.add("capex_operational");
  }
  if (/\b(order book|contract win|large contract|major contract)\b/.test(text)) output.add("large_order");
  if (/\b(cost efficiency|cost optimisation|cost optimization|margin programme|margin program)\b/.test(text)) output.add("cost_efficiency");
  if (workforceFacts(text).contraction || row.eventType === "layoffs" || /\b(loss|revenue decline|revenues? (?:fell|declined|down)|profit (?:fell|declined|down)|profits? (?:fell|declined|down)|margin (?:fell|declined|down|contracted)|layoffs?|hiring freeze|spending freeze)\b/.test(text)) output.add("negative_financial");
  if (row.eventType === "regulatory_action" || /\b(data breach|ransomware|cyber incident|audit finding|regulatory penalty)\b/.test(text)) output.add("regulatory_breach");
  if (row.eventType === "merger_acquisition" || /\b(acquisition|acquire|merger)\b/.test(text)) {
    const closed = normalized(context.dealStage ?? ai.dealStage).includes("closed") || /\b(completed|closed|acquired|has acquired|deal completed)\b/.test(text);
    output.add(closed ? "acquisition_closed" : "acquisition_intent");
  }
  if (row.eventType === "branch_opening" || /\b(new branch|new office|new plant|new campus|opened|opening)\b/.test(text)) output.add("new_site");
  if (/\b(relocation|office consolidation|smart office|return.to.office)\b/.test(text)) output.add("office_change");
  if (/\b(market entry|new geography|entered the .* market|expanding into)\b/.test(text)) output.add("market_entry");
  if (/\b(rfp|rfq|current tender|invitation to bid|invites? bids?|request for (?:proposal|quotation)|vendor (?:selection|evaluation|replacement)|switch(?:ing|ed)? vendors?|replac(?:e|ing|ed) (?:its )?vendor)\b/.test(text)) output.add("vendor_change");
  if (row.eventType === "partnership") output.add("partnership");
  if (/\b(new product|product launch|service launch)\b/.test(text)) output.add("product_launch");
  if (/\b(cloud migration|saas\b|erp\b|crm\b)\b/.test(text)) output.add("cloud_erp");
  if (/\b(zero trust|iso 27001|soc 2|security investment)\b/.test(text)) output.add("zero_trust");
  if (/\b(windows 11|fleet refresh|device refresh|ai pc|endpoint refresh)\b/.test(text)) output.add("endpoint_refresh");
  if (/\b(teams rooms?|zoom rooms?|webex|ucaas|unified communications|video conferencing)\b/.test(text)) output.add("uc_collaboration");
  if (/\b(hybrid work|hybrid-work|desk booking|workplace experience)\b/.test(text)) output.add("hybrid_work");
  if (row.eventType === "technology_integration" || /\b(digital transformation|it outsourcing|daas|device as a service|managed services)\b/.test(text)) output.add("digital_transformation");
  if (/\b(paperless|document management|e-signature|digitisation|digitization)\b/.test(text)) output.add("paperless");
  return [...output];
}

function normalizedEvidenceText(row:IntentStatusEvidence){
  return normalized(row.excerpt).replace(/[^a-z0-9₹]+/g," ").replace(/\s+/g," ").trim();
}

function preparedEvidence(row:IntentStatusEvidence){
  const text=normalizedEvidenceText(row);
  return {row,text,identity:normalized(row.context?.sourceIdentity),
    occurredAt:new Date(row.occurredAt).getTime(),
    tokens:new Set(text.split(" ").filter(token=>token.length>2))};
}

function substantiallySameEvidence(a:ReturnType<typeof preparedEvidence>,b:ReturnType<typeof preparedEvidence>){
  const aIdentity=a.identity,bIdentity=b.identity;
  if(aIdentity&&bIdentity&&aIdentity===bIdentity)return true;
  const aText=a.text,bText=b.text;
  if(aText&&aText===bText)return true;
  if(Math.abs(a.occurredAt-b.occurredAt)>21*day)return false;
  const left=a.tokens,right=b.tokens;
  if(left.size<6||right.size<6)return false;
  let overlap=0;
  for(const token of left)if(right.has(token))overlap++;
  return overlap/Math.max(left.size,right.size)>=0.8;
}

function deduplicateEvidence(rows:IntentStatusEvidence[]){
  const preferred=[...rows].sort((a,b)=>b.confidence-a.confidence||Number(Boolean(b.sourceUrl))-Number(Boolean(a.sourceUrl))||b.id-a.id);
  const unique:ReturnType<typeof preparedEvidence>[]=[];
  // Preserve the greedy preference/order and exact overlap threshold, but
  // tokenize each source once rather than once per pair of evidence rows.
  for(const row of preferred){
    const prepared=preparedEvidence(row);
    if(!unique.some(existing=>substantiallySameEvidence(existing,prepared)))unique.push(prepared);
  }
  return unique.map(item=>item.row);
}

function hasDirectHotProof(row:IntentStatusEvidence,signalType:string){
  return sourceRequirementPassages(row.excerpt).some(passage => {
  const text=normalized(passage);
  const procurement=/\b(rfp|rfq|tender|invitation to bid|request for proposal|request for quotation|purchase order|vendor selection|vendor evaluation)\b/.test(text);
  const directAction=/\b(buy|buying|purchase|purchasing|procure|deploy|deployment|implement|implementation|migrate|migration|replace|replacement|refresh|rollout|adopt|adoption|upgrade|contracted|awarded)\b/.test(text);
  const product=/\b(laptop|desktop|workstation|pc|endpoint|device|printer|mfp|managed print|headset|video bar|meeting room|teams room|zoom room|cloud|erp|crm|cyber|security|zero trust|software|it infrastructure)\b/.test(text);
  const technologyBudget=/\b(₹|rs\.?|inr|\$|crore|million|billion)\b/.test(text)&&/\b(technology|digital|software|cloud|cyber|it infrastructure|endpoint|devices?)\b/.test(text);
  return (procurement&&product)||(directAction&&product)||(signalType==="capex_technology"&&technologyBudget);
  });
}

function expiry(occurredAt: string, days: number) {
  return new Date(new Date(occurredAt).getTime() + days * day).toISOString();
}

export function evaluateTwoLevelIntentStatus(
  rows: IntentStatusEvidence[],
  now = new Date(),
  categoryConfig:InboundCategoryConfig = {rules:[],useBuiltin:true},
): TwoLevelIntentStatus {
  const active = deduplicateEvidence(rows.map(row => row.evidenceKind === "public_event"
    ? { ...row, excerpt: researchSourceText(row.excerpt, row.context) } : row)
    .filter(row => row.reviewStatus !== "rejected").filter(row => {
    if (row.evidenceKind === "public_event") {
      if (row.reviewStatus !== "approved" || !isResearchGeographyEligible(row)) return false;
    }
    return now.getTime() - new Date(row.occurredAt).getTime() <= 90 * day;
  }));
  const buckets = inboundCategories.map(name => ({ category:{key:intentCategoryKey(name),name}, strong: [] as any[], moderate: [] as any[], weak: [] as any[], negative: [] as any[], ambiguous: [] as any[], firstPartyHot: [] as any[], firstPartyWarm: [] as any[] }));
  let accountTriggerHot = false;
  const accountTriggerSignals: Array<{row:IntentStatusEvidence;signalType:string;strength:Strength;occurredAt:string}> = [];
  let negativeConflict = false;
  for (const row of active) {
    const occurredAt = new Date(row.occurredAt).toISOString();
    const ageDays = (now.getTime() - new Date(occurredAt).getTime()) / day;
    const text = normalized(`${row.excerpt} ${JSON.stringify(row.context ?? {})}`);
    const firstParty = ["lead_form","event_feedback","event_questionnaire","product_buy_intent"].includes(row.evidenceKind);
    const categoryName=evidenceCategory(row,categoryConfig);
    if (firstParty) {
      const explicit = /\b(need|interested|require|quote|demo|rfp|tender|seats?|units?|quantity|laptops?|desktops?|workstations?|headsets?|video bar|meeting room|printers?|mfp|managed print|security|endpoint|daas)\b/.test(text);
      const urgent = /\b(quote|demo|rfp|tender|\d+\s*(seats?|units?|devices?)|immediate|within\s+[1-6]\s+months?|[1-6]\s+months?)\b/.test(text);
      const bucket=buckets.find(item=>item.category.name===categoryName);
      if (explicit && bucket) {
        const target = urgent ? bucket.firstPartyHot : bucket.firstPartyWarm;
        target.push({ row, signalType: "first_party_need", strength: urgent ? "strong" : "moderate", occurredAt });
      }
    }
    for (const signalType of classifySignal(row)) {
      const rule = signalRules[signalType];
      if (!rule) continue;
      if (rule.negativeCap) negativeConflict = true;
      if (!firstParty && !rule.negativeCap
        && !deriveProductFitments({text:row.excerpt,eventType:row.eventType},RESEARCH_CAPABILITIES).length) continue;
      if (rule.accountTrigger === "hot" && ageDays <= 45) {
        accountTriggerHot = true;
        accountTriggerSignals.push({row,signalType,strength:"strong",occurredAt});
      }
      const strongest=rule.matrix.reduce<Strength>((best,strength)=>strengthRank[strength]>strengthRank[best]?strength:best,"none");
      const bucket=buckets.find(item=>item.category.name===categoryName);
      if (bucket && strongest!=="none") {
        const target = bucket[strongest === "negative" ? "negative" : strongest];
        target.push({ row, signalType, strength:strongest, occurredAt, hotQualifying: rule.hotQualifying });
      }
    }
  }
  const categories: CategoryStatus[] = buckets.map(bucket => {
    const liveHot = bucket.strong.filter(item => item.hotQualifying && item.row.confidence >= 60 && now.getTime() - new Date(item.occurredAt).getTime() <= 45 * day && hasDirectHotProof(item.row,item.signalType));
    const externalPositive=[...bucket.strong,...bucket.moderate,...bucket.ambiguous,...bucket.weak]
      .filter(item=>now.getTime()-new Date(item.occurredAt).getTime()<=90*day);
    const positiveEvidenceIds=new Set(externalPositive.map(item=>item.row.id));
    const positiveSignalTypes=new Set(externalPositive.map(item=>item.signalType));
    const corroboratedWarm=positiveEvidenceIds.size>=2&&positiveSignalTypes.size>=2;
    const strongWarm=bucket.strong.filter(item=>!liveHot.includes(item));
    let status: Status = bucket.firstPartyHot.length || liveHot.length ? "hot"
      : bucket.firstPartyWarm.length || strongWarm.length || corroboratedWarm ? "warm"
      : "cold";
    let attribution: Attribution = bucket.firstPartyHot.length || bucket.firstPartyWarm.length ? "CONFIRMED"
      : liveHot.length || strongWarm.length ? "PROBABLE"
      : status === "warm" ? "POSSIBLE" : "NONE";
    if (status === "cold" && accountTriggerHot) { status = "warm"; attribution = "INHERITED_OPEN"; }
    if (negativeConflict && status === "hot" && !bucket.firstPartyHot.length) status = "warm";
    const qualifyingDrivers=status==="hot"
      ? [...bucket.firstPartyHot,...liveHot]
      : status==="warm"
        ? [...bucket.firstPartyWarm,...strongWarm,...(corroboratedWarm?externalPositive:[])]
        : [];
    const drivers = qualifyingDrivers
      .sort((a,b) => new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime()).slice(0,3)
      .map(item => ({ evidenceId:item.row.id,signalType:item.signalType,quote:item.row.excerpt.slice(0,500),sourceUrl:item.row.sourceUrl,occurredAt:item.occurredAt,strength:item.strength as Strength }));
    const lastTriggerDate = drivers[0]?.occurredAt ?? null;
    const expiresAt = lastTriggerDate ? expiry(lastTriggerDate, status === "hot" ? 45 : 90) : null;
    const negativeNote=bucket.negative.length
      ? ` ${bucket.negative.length} current negative signal${bucket.negative.length===1?" reduces":"s reduce"} confidence.`
      : "";
    const statusReason = attribution === "CONFIRMED"
      ? `${status === "hot" ? "Hot" : "Warm"} because first-party evidence explicitly identifies ${bucket.category.name} interest${status === "hot" ? " with purchase timing, quantity, quote, demo, or procurement action" : ", but purchase timing or commitment is not yet strong enough for Hot"}.`
      : attribution === "PROBABLE"
        ? status === "hot"
          ? `Hot because approved evidence directly states: “${drivers[0]?.quote.slice(0,220) ?? "Direct purchase or deployment action"}”.`
          : `Warm based on one strong category-specific operational signal: “${drivers[0]?.quote.slice(0,220)}”. It indicates a plausible ${bucket.category.name} need, but no explicit purchase timing or action is confirmed.${negativeNote}`
        : attribution === "POSSIBLE"
          ? `Warm because ${positiveEvidenceIds.size} independent positive signals across ${positiveSignalTypes.size} signal types reinforce a ${bucket.category.name} need. No explicit purchase timing or action is confirmed.${negativeNote}`
          : attribution === "INHERITED_OPEN"
            ? `Warm because the account has a live account-level Hot trigger, but the evidence does not explicitly identify ${bucket.category.name}. This is inherited opportunity, not confirmed category demand.`
            : externalPositive.length
              ? `Cold because the available ${externalPositive.length===1?"signal is":"signals are"} contextual or insufficiently corroborated and do not create a defensible category-specific link to ${bucket.category.name}. Generic revenue or profit movement is an account-capacity modifier, not buying intent.${negativeNote}`
              : `Cold because no current evidence creates a defensible category-specific link to ${bucket.category.name} investment.${negativeNote}`;
    const nextPlay = attribution === "INHERITED_OPEN"
      ? "Hot account — category to be discovered: lead with a portfolio conversation."
      : status === "hot" ? `Route to the ${bucket.category.name} specialist and reference the strongest trigger.`
      : status === "warm" ? `Nurture around ${bucket.category.name} and validate timing, ownership, and scale.`
      : `Do not pitch ${bucket.category.name}; wait for new qualifying evidence.`;
    return { key:bucket.category.key,name:bucket.category.name,status,attribution,drivingSignals:drivers,lastTriggerDate,expiresAt,statusReason,nextPlay };
  });
  const categoryHot = categories.some(category => category.status === "hot");
  const categoryWarm = categories.some(category => category.status === "warm");
  const accountStatus: Status = categoryHot || accountTriggerHot ? "hot" : categoryWarm ? "warm" : "cold";
  const accountDrivingSignals: DrivingSignal[] = (accountTriggerHot
    ? accountTriggerSignals.map(item=>({evidenceId:item.row.id,signalType:item.signalType,quote:item.row.excerpt.slice(0,500),sourceUrl:item.row.sourceUrl,occurredAt:item.occurredAt,strength:item.strength}))
    : categories.filter(category=>category.status==="hot").flatMap(category=>category.drivingSignals)
  ).filter((item,index,items)=>items.findIndex(candidate=>candidate.evidenceId===item.evidenceId&&candidate.signalType===item.signalType)===index)
    .sort((a,b)=>new Date(b.occurredAt).getTime()-new Date(a.occurredAt).getTime()).slice(0,5);
  const strongestCategory=categories.find(category=>category.status==="hot");
  const accountExplanation=accountStatus==="hot"&&accountTriggerHot&&!categoryHot
    ? `Hot overall because ${accountDrivingSignals.length} current account-level buying trigger${accountDrivingSignals.length===1?" is":"s are"} active. These signals indicate a high possibility of near-term HP investment, but do not name a specific HP category; category statuses therefore remain Warm until product-level need or purchase action is confirmed.`
    : accountStatus==="hot"&&strongestCategory
      ? `Hot overall because approved evidence directly supports ${strongestCategory.name}: “${strongestCategory.drivingSignals[0]?.quote.slice(0,220) ?? "Direct purchase or deployment action"}”.`
      : accountStatus==="warm"
        ? `Warm overall because current evidence suggests possible HP investment, but no active signal meets the explicit or high-probability Hot threshold.`
        : `Cold overall because no current approved evidence establishes a defensible likelihood of HP investment.`;
  return { accountStatus, accountFlag: accountTriggerHot && !categoryHot ? "category_open" : null, accountExplanation, accountDrivingSignals, categories, negativeConflict, evaluatedAt:now.toISOString(), rulesVersion:rules.version };
}
