import { base2Decay, saturateRepeatedSignals } from "./alwaysOnIntent";

export type PropensityFactKind = "account_fit"|"need"|"refresh"|"purchase"|"external_pressure"|"negative";
export type PropensityBand = "hot"|"warm"|"emerging"|"low";

export type PropensityFact = {
  id:string;
  kind:PropensityFactKind;
  strength:number;
  occurredAt:string|Date;
  halfLifeDays:number;
  sourceUrl?:string|null;
  sourceReliability:number;
  underlyingEventKey:string;
  explanation:string;
};

const CAPS:Record<Exclude<PropensityFactKind,"negative">,number>={
  account_fit:10,need:20,refresh:15,purchase:25,external_pressure:20,
};

export function scoreCategoryIntentPropensity(facts:PropensityFact[],now=new Date()){
  const accepted=facts.filter(fact=>
    fact.id.trim()&&fact.underlyingEventKey.trim()&&fact.explanation.trim()
    && Number.isFinite(fact.strength)&&Number.isFinite(fact.sourceReliability)
    && (fact.kind==="account_fit"||Boolean(fact.sourceUrl)),
  );
  const byUnderlyingEvent=new Map<string,PropensityFact>();
  for(const fact of accepted.sort((a,b)=>new Date(b.occurredAt).getTime()-new Date(a.occurredAt).getTime())){
    const key=`${fact.kind}:${fact.underlyingEventKey}`;
    if(!byUnderlyingEvent.has(key))byUnderlyingEvent.set(key,fact);
  }
  const deduped=[...byUnderlyingEvent.values()];
  const pointsFor=(kind:PropensityFactKind)=>{
    const values=deduped.filter(fact=>fact.kind===kind).map(fact=>{
      const age=(now.getTime()-new Date(fact.occurredAt).getTime())/86_400_000;
      return Math.max(0,Math.min(100,fact.strength))/100
        * Math.max(0,Math.min(100,fact.sourceReliability))/100
        * base2Decay(age,fact.halfLifeDays);
    });
    return Math.min(1,saturateRepeatedSignals(values));
  };
  const components={
    accountFit:Number((pointsFor("account_fit")*CAPS.account_fit).toFixed(2)),
    need:Number((pointsFor("need")*CAPS.need).toFixed(2)),
    refresh:Number((pointsFor("refresh")*CAPS.refresh).toFixed(2)),
    purchaseReadiness:Number((pointsFor("purchase")*CAPS.purchase).toFixed(2)),
    externalPressure:Number((pointsFor("external_pressure")*CAPS.external_pressure).toFixed(2)),
  };
  const positives=deduped.filter(f=>f.kind!=="negative"&&f.kind!=="account_fit");
  const recentKinds=new Set(positives.filter(f=>now.getTime()-new Date(f.occurredAt).getTime()<=90*86_400_000).map(f=>f.kind));
  const distinctEvents=new Set(positives.filter(f=>now.getTime()-new Date(f.occurredAt).getTime()<=90*86_400_000).map(f=>f.underlyingEventKey));
  const momentum=recentKinds.size>=2&&distinctEvents.size>=2?Math.min(10,4+(distinctEvents.size-2)*2):0;
  const negativeDeduction=Math.min(35,pointsFor("negative")*35);
  const weightedReliability=positives.length
    ? positives.reduce((sum,f)=>sum+Math.max(0,Math.min(100,f.sourceReliability)),0)/positives.length
    : 0;
  const dataConfidence=Math.max(0.35,Math.min(1,weightedReliability/100));
  let score=Math.round(Math.max(0,Object.values(components).reduce((sum,n)=>sum+n,0)+momentum-negativeDeduction)*dataConfidence);
  const recentPurchase=deduped.some(f=>f.kind==="purchase"&&f.sourceReliability>=80&&now.getTime()-new Date(f.occurredAt).getTime()<=90*86_400_000);
  const reinforcingNeed=recentKinds.has("need")&&distinctEvents.size>=2;
  if(recentPurchase)score=Math.max(score,80);
  if(!recentPurchase)score=Math.min(score,79);
  if(!reinforcingNeed&&!recentPurchase)score=Math.min(score,59);
  const band:PropensityBand=score>=80&&recentPurchase?"hot":score>=60&&reinforcingNeed?"warm":score>=40?"emerging":"low";
  return {score,band,components,momentum,negativeDeduction:Number(negativeDeduction.toFixed(2)),dataConfidence:Number(dataConfidence.toFixed(2)),hasRecentPurchaseSignal:recentPurchase,evidence:deduped};
}

export function sourceReliability(url?:string|null,context?:Record<string,unknown>){
  if(!url)return 0;
  let host="";
  try{host=new URL(url).hostname.toLowerCase().replace(/^www\./,"");}catch{return 0;}
  if(context?.sourceType==="official"||context?.sourceType==="regulatory")return 100;
  if(/(?:^|\.)(gov|gov\.in|sec\.gov|nseindia\.com|bseindia\.com)$/.test(host))return 100;
  if(/(?:^|\.)(reuters\.com|apnews\.com|bloomberg\.com|ft\.com|wsj\.com|bbc\.com|cnbc\.com|economictimes\.indiatimes\.com|business-standard\.com|livemint\.com)$/.test(host))return 90;
  return 60;
}