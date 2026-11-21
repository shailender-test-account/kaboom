import { matchingInboundRoutingRule, splitSelections, type InboundRoutingRule } from "./inboundAccounts";
import type { InboundCategoryConfig } from "./inboundTaxonomy";
import type { ImportCatalogProduct } from "./intentImportProductMatching";

export type InboundRouteRow = {
  accountId:number;clientId:number;submissionId:number;
  productInterest:string|null;affinityReviews:Record<string,unknown>|null;
  classification:"hot"|"warm"|"cold";routingStatus:string;
  routedRuleId:number|null;manualJourneyId:number|null;manualSequenceId:number|null;
  manualJourneyName:string|null;manualSequenceName:string|null;
  hasWarmJourneyHistory?:boolean;
};
export type NamedInboundRule = InboundRoutingRule & {
  journeyName:string|null;sequenceName:string|null;sequenceStatus:string|null;
  enabled:boolean;
};
export type InboundAccountRoute = {
  journeyId:number|null;journeyName:string|null;sequenceId:number|null;sequenceName:string|null;
  status:"routed"|"configured"|"error"|"unknown";source:"rule"|"manual";
  responseCount:number;
};

/** Keep actual enrollments separate from destinations that are merely configured for pending responses. */
export function accountRoutingDestinations(
  submissions:InboundRouteRow[],
  rules:NamedInboundRule[],
  catalog:ImportCatalogProduct[],
  categoryRules:InboundCategoryConfig,
  hotAccountIds:ReadonlySet<number>=new Set(),
) {
  const rulesById=new Map(rules.map(rule=>[rule.id,rule]));
  const enabledRules=rules.filter(rule=>rule.enabled&&rule.journey_id!==null
    &&Boolean(rule.journeyName)&&rule.sequenceStatus==="active"&&Boolean(rule.sequenceName));
  const byAccount=new Map<number,Map<string,InboundAccountRoute>>();
  for(const row of submissions){
    // A configured rule or stale "routed" marker is not Warm journey history.
    if(hotAccountIds.has(Number(row.accountId)) &&
      (row.classification!=="warm" || !row.hasWarmJourneyHistory))continue;
    let destination:Omit<InboundAccountRoute,"responseCount">|null=null;
    if(row.manualJourneyId!==null||row.manualSequenceId!==null){
      destination={
        journeyId:row.manualJourneyId,journeyName:row.manualJourneyName,
        sequenceId:row.manualSequenceId,sequenceName:row.manualSequenceName,
        status:"routed",source:"manual",
      };
    } else if(row.routingStatus==="routed"){
      const rule=rulesById.get(Number(row.routedRuleId));
      destination={
        journeyId:rule?.journey_id??null,journeyName:rule?.journeyName??null,
        sequenceId:rule?.sequence_id??null,sequenceName:rule?.sequenceName??null,
        status:rule?"routed":"unknown",source:"rule",
      };
    } else if(row.routingStatus==="pending"||row.routingStatus==="error"){
      const selected=splitSelections(row.productInterest);
      const accepted=selected.filter(selection=>row.affinityReviews?.[selection]!=="rejected");
      const rule=selected.length&&!accepted.length?undefined:matchingInboundRoutingRule(
        enabledRules,row.clientId,accepted.join("; "),row.classification,catalog,row.affinityReviews,categoryRules,
      );
      if(rule){
        const named=rulesById.get(rule.id)!;
        destination={
          journeyId:named.journey_id,journeyName:named.journeyName,
          sequenceId:named.sequence_id,sequenceName:named.sequenceName,
          status:row.routingStatus==="error"?"error":"configured",source:"rule",
        };
      }
    }
    if(!destination)continue;
    if(hotAccountIds.has(Number(row.accountId)) &&
      (destination.status!=="routed" || !destination.journeyId || !destination.journeyName))continue;
    const account=byAccount.get(row.accountId)??new Map<string,InboundAccountRoute>();
    const key=[destination.status,destination.source,destination.journeyId,destination.sequenceId].join(":");
    const existing=account.get(key);
    if(existing)existing.responseCount++;
    else account.set(key,{...destination,responseCount:1});
    byAccount.set(row.accountId,account);
  }
  return new Map([...byAccount].map(([accountId,destinations])=>[accountId,[...destinations.values()]
    .sort((a,b)=>({routed:0,configured:1,error:2,unknown:3})[a.status]
      -({routed:0,configured:1,error:2,unknown:3})[b.status]
      ||String(a.journeyName).localeCompare(String(b.journeyName)))]));
}