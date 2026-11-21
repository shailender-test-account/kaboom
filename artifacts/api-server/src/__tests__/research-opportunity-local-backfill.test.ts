import { describe, expect, it } from "vitest";
import { RESEARCH_FITMENT_POLICY_VERSION, isCurrentResearchOpportunityBrief, rebuildResearchOpportunityLocally } from "../lib/researchOpportunityInterpreter";
import type { ProviderEvent } from "../lib/intentProviders";

const catalog=[
  {id:1,name:"HP Commercial Printer",categoryId:10,category:"Commercial Printing",subcategory:null},
  {id:2,name:"HP Business Laptop",categoryId:20,category:"IT Hardware",subcategory:null},
];
const evidence:ProviderEvent[]=[{
  eventType:"quarterly_financial",
  occurredAt:"2026-09-01T00:00:00.000Z",
  sourceUrl:"https://example.com/india-profit",
  excerpt:"An Indian textile manufacturer reported improved profit after reducing packaging and label production costs in India.",
  confidence:90,
  context:{location:"India"},
}];

describe("local research opportunity rebuild",()=>{
  it("retains only business-direction hypotheses whose quote and URL match the remaining source evidence",()=>{
    const point={theme:"Operating efficiency",signal:"The source reports lower local production costs.",
      direction:"Management may review operating efficiency before approving new investment.",
      sourceQuote:evidence[0].excerpt,sourceUrls:[evidence[0].sourceUrl!]};
    const result=rebuildResearchOpportunityLocally({company:{name:"Textile Co"},evidence,catalog,firstParty:[],
      storedBrief:{businessDirections:[point,{...point,theme:"Invented hiring",sourceQuote:"The account will hire 5,000 engineers."}]}});
    expect(result?.businessDirections).toEqual([point]);
  });
  it("keeps the API visibility gate aligned with the exported policy version",()=>{
    const current={
      fitmentPolicyVersion:RESEARCH_FITMENT_POLICY_VERSION,
      whyNow:"Current India evidence supports a category-specific operational review.",
    };
    expect(isCurrentResearchOpportunityBrief(current)).toBe(true);
    expect(isCurrentResearchOpportunityBrief({...current,fitmentPolicyVersion:RESEARCH_FITMENT_POLICY_VERSION-1})).toBe(false);
  });

  it("re-evaluates old conclusions with the current deterministic category gate",()=>{
    const oldBrief={fitmentPolicyVersion:5,categoryConclusions:[
      {categoryId:10,categoryName:"Commercial Printing",score:100,tier:"hot",accountFit:90,
        gaps:["Reduce packaging and label printing cost"],opportunities:["Consolidate label printing"],
        rationale:"Profit supports a printing opportunity.",evidenceStrength:"business_trigger",
        recommendedProducts:[{productId:1,name:"HP Commercial Printer",rationale:"Reduce label cost."}],
        buyers:["Operations"],sourceUrls:["https://example.com/india-profit"]},
      {categoryId:20,categoryName:"IT Hardware",score:100,tier:"hot",accountFit:90,
        gaps:["Reduce general cost"],opportunities:["Refresh laptops"],rationale:"Profit supports laptops.",
        evidenceStrength:"business_trigger",recommendedProducts:[{productId:2,name:"HP Business Laptop",rationale:"New laptops."}],
        buyers:["IT"],sourceUrls:["https://example.com/india-profit"]},
    ]};
    const first=rebuildResearchOpportunityLocally({company:{name:"Textile Co",industry:"Textiles"},evidence,catalog,firstParty:[],storedBrief:oldBrief});
    const second=rebuildResearchOpportunityLocally({company:{name:"Textile Co",industry:"Textiles"},evidence,catalog,firstParty:[],storedBrief:oldBrief});
    expect(first).toEqual(second);
    expect(first?.fitmentPolicyVersion).toBe(RESEARCH_FITMENT_POLICY_VERSION);
    expect(first?.categoryConclusions.find(value=>value.categoryId===10)?.tier).not.toBe("hot");
    expect(first?.categoryConclusions.find(value=>value.categoryId===20)).toMatchObject({tier:"cold",recommendedProducts:[]});
    expect(first?.categoryConclusions.every(value=>value.rationale.startsWith(value.tier==="cold"?"Cold:":"Monitor / Emerging:"))).toBe(true);
  });

  it("uses only approved evidence supplied by the caller and never needs a provider",()=>{
    const result=rebuildResearchOpportunityLocally({company:{name:"Textile Co",industry:"Textiles"},evidence,catalog,firstParty:[],storedBrief:{}});
    expect(result?.sourceUrls).toEqual(["https://example.com/india-profit"]);
    expect(result?.categoryConclusions).toHaveLength(2);
  });
});
