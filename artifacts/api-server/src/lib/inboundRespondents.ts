import { canonicalizeInbound, splitSelections, type InboundFieldMappings } from "./inboundAccounts";
import { inferProductsFromInterest, type ImportCatalogProduct } from "./intentImportProductMatching";
import { inboundCategoryForInterest } from "./inboundTaxonomy";

export type InboundRespondentRow = {
  accountId:number; submissionId:number; contactId:number|null;
  contactName:string|null;contactTitle:string|null;contactEmail:string|null;
  productInterest:string|null;affinityReviews:Record<string,unknown>|null;
  rawFields:Record<string,unknown>;fieldMappings:InboundFieldMappings|null;
  classification:"hot"|"warm"|"cold";routingStatus:string;routingError:string|null;
  manualSelection:string|null;manualJourneyId:number|null;manualSequenceId:number|null;
};

function seniority(title:string) {
  if(/\b(chief|ceo|cio|cto|cfo|ciso|coo|president|founder|owner)\b/i.test(title))return 5;
  if(/\b(vice president|assistant vice president|associate vice president|vp|avp|svp|evp|dvp)\b/i.test(title))return 4;
  if(/\b(director|head|general manager|gm)\b/i.test(title))return 3;
  if(/\b(senior manager|manager|lead)\b/i.test(title))return 2;
  return 1;
}

export function groupInboundRespondents(rows:InboundRespondentRow[],catalog:ImportCatalogProduct[]) {
  const accounts=new Map<number,Map<string,{
    id:number|null;name:string;title:string;email:string|null;interests:Array<{
      submissionId:number;selection:string;category:string|null;classification:"hot"|"warm"|"cold";
      routingStatus:string;routingError:string|null;manualJourneyId:number|null;manualSequenceId:number|null;
      responseManuallyRouted:boolean;
    }>;responseCount:number;rank:number;
  }>>();
  for(const row of rows){
    const fields=canonicalizeInbound(row.rawFields??{},row.fieldMappings??{});
    const name=row.contactName?.trim()||String(fields.name??[fields.firstName,fields.lastName].filter(Boolean).join(" ")).trim()||"Unnamed respondent";
    const title=row.contactTitle?.trim()||String(fields.title??"").trim();
    const email=row.contactEmail||null;
    const key=row.contactId?`contact:${row.contactId}`:`response:${row.submissionId}`;
    const group=accounts.get(row.accountId)??new Map();
    const respondent=group.get(key)??{id:row.contactId,name,title,email,interests:[],responseCount:0,rank:seniority(title)};
    respondent.responseCount++;
    const selections=splitSelections(row.productInterest).filter(selection=>
      !/^(?:n\/?a|none|no|nil|not interested|-+)$/i.test(selection)
      &&row.affinityReviews?.[selection]!=="rejected");
    for(const selection of selections){
      respondent.interests.push({
        submissionId:row.submissionId,selection,category:inboundCategoryForInterest(selection,row.affinityReviews).categoryName,
        classification:row.classification,routingStatus:row.routingStatus,routingError:row.routingError,
        manualJourneyId:row.manualSelection===selection?row.manualJourneyId:null,
        manualSequenceId:row.manualSelection===selection?row.manualSequenceId:null,
        responseManuallyRouted:Boolean(row.manualSelection),
      });
    }
    group.set(key,respondent);
    accounts.set(row.accountId,group);
  }
  return new Map([...accounts].map(([accountId,respondents])=>{
    const sorted=[...respondents.values()].sort((a,b)=>
      Number(b.interests.length>0)-Number(a.interests.length>0)
      ||b.rank-a.rank||a.name.localeCompare(b.name));
    return [accountId,sorted.map(({rank,...respondent},index)=>({
      ...respondent,isPrimary:index===0&&respondent.interests.length>0,
    }))];
  }));
}