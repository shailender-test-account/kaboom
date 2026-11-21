import { describe, expect, it } from "vitest";
import { deriveProductFitments } from "../lib/signalProductFit";
import { workforceFacts } from "../lib/researchSourceFacts";
import { classifyResearchEvidence, researchEvidenceHeat } from "../lib/researchIntentEvidence";
import { addGrowthOpportunityFit } from "../lib/researchEvidenceAutoReview";
import { reassessResearchFinding } from "../lib/researchFindingReassessment";
import { enforceCategoryConclusionEvidence, type CategoryConclusion } from "../lib/researchOpportunityInterpreter";
import { evaluateTwoLevelIntentStatus } from "../lib/twoLevelIntentStatus";
import { scoredAccountSignals } from "../lib/additiveIntentScore";

const catalog = [
  {id:1,name:"HP Business Laptops",category:"IT Hardware",categoryId:10,subcategory:null},
  {id:2,name:"HP Industrial 3D Printing",category:"Commercial Printing",categoryId:20,subcategory:null},
  {id:3,name:"HP Office Printers",category:"Commercial Printing",categoryId:20,subcategory:null},
  {id:4,name:"Poly Headsets",category:"Business Collaboration",categoryId:30,subcategory:null},
  {id:5,name:"HP Engineering Workstations",category:"IT Hardware",categoryId:10,subcategory:null},
  {id:6,name:"Poly Video Bars",category:"Business Collaboration",categoryId:30,subcategory:null},
];
const bbc = "BBC plans to cut 2,000 jobs from its workforce in India as part of a savings programme.";
const shaw = "D E Shaw opened a new office in Bengaluru with 100,000 square feet of space and room for growth.";
const exxon = "ExxonMobil sees India's energy market growth and industrial production rising. Technology companies offer laptops and printing products.";

describe("source-backed research demand", () => {
  it.each([bbc,shaw,exxon])("retains context without catalog fan-out: %s", text => {
    expect(deriveProductFitments({text,eventType:"hiring",aiProductIds:catalog.map(p=>p.id)},catalog)).toEqual([]);
    expect(classifyResearchEvidence({excerpt:text,eventType:"hiring",
      context:{aiReview:{fitments:catalog.map(p=>({productId:p.id,productName:p.name,category:p.category,points:100,level:"direct_intent"}))}}}))
      .toMatchObject({level:"business_trigger",hotEligible:false,points:10});
  });

  it.each([
    "The company is hiring after a $200 million investment.",
    "The company opened a 200,000 square feet office.",
    "Workforce grew 200% after an expansion.",
    "The company opened an office and has 500 employees.",
    "The company opened a new office by relocating 500 employees.",
    "Opened a new office with 500 office employees transferred from another site",
    "The company opened a new office with 500 employees already employed at another site.",
    "The company grows its office footprint with 500 office employees.",
    "Investment increased by 500 million with 200 office employees.",
    "The company is hiring with a total workforce of 5,000 employees.",
    "The company may hire up to 500 employees.",
    "The company eliminated 500 roles.",
  ])("never treats money, area, percentages, stock or cuts as new people: %s", text => {
    expect(workforceFacts(text).growthHeadcount).toBe(0);
    expect(deriveProductFitments({text,eventType:"hiring"},catalog)).toEqual([]);
  });

  it("does not confuse the buyer's printing business with the tender's requirement",()=>{
    const fits=deriveProductFitments({text:"Its industrial 3D printing division issued an RFP for office chairs this quarter."},catalog);
    expect(fits).toEqual([]);
  });

  it("uses the actual new headcount, not the stock total", () => {
    expect(workforceFacts("The company is hiring 200 employees, with a total workforce of 5,000 employees.").growthHeadcount).toBe(200);
    expect(workforceFacts("The workforce grew by 200 employees.").growthHeadcount).toBe(200);
    expect(workforceFacts("The company increased its workforce by 200 employees.").growthHeadcount).toBe(200);
  });

  it("preserves a scaled contact-center mechanism, without specialist devices or room systems", () => {
    const fits=deriveProductFitments({eventType:"hiring",text:"The company is starting a new contact center with 200 people in India."},catalog);
    expect(fits.map(p=>p.productId).sort()).toEqual([1,4]);
    expect(fits.every(p=>p.level==="confirmed_need")).toBe(true);
    expect(classifyResearchEvidence({eventType:"hiring",excerpt:"Starting a new contact center with 200 people.",
      context:{aiReview:{fitments:fits}}}).hotEligible).toBe(false);
  });

  it("does not infer growth from a staffed center losing employees", () => {
    expect(deriveProductFitments({eventType:"layoffs",text:"The contact center is cutting 200 staff from its workforce."},catalog)).toEqual([]);
    expect(workforceFacts(bbc)).toEqual({contraction:true,growthHeadcount:0});
  });

  it("requires the source, not invented AI gaps, to support category need", () => {
    const conclusions:CategoryConclusion[]=catalog.filter(p=>p.id<=3).map(p=>({
      categoryId:p.categoryId,categoryName:p.category,score:100,tier:"hot",accountFit:100,
      gaps:["Need laptops and industrial printing deployments"],opportunities:["Replace devices and deploy 3D printing"],
      rationale:"AI growth hypothesis",evidenceStrength:"business_trigger",buyers:["IT"],
      sourceUrls:["https://example.com/india"],recommendedProducts:[{productId:p.id,name:p.name,rationale:"AI suggested fit"}],
    }));
    const result=enforceCategoryConclusionEvidence({conclusions,catalog,firstParty:[],industry:"Energy",
      evidence:[{eventType:"branch_opening",excerpt:shaw,occurredAt:new Date().toISOString(),confidence:99,sourceUrl:"https://example.com/india",context:{}}]});
    expect(result.every(c=>c.tier==="cold"&&c.recommendedProducts.length===0)).toBe(true);
  });

  it("keeps valid industrial printing distinct from office printing", () => {
    const fits=deriveProductFitments({eventType:"procurement",text:"The company issued an RFP for industrial 3D printing with delivery required this quarter."},catalog);
    expect(fits.map(f=>f.productId)).toEqual([2]);
    expect(fits[0].level).toBe("direct_intent");
  });

  it.each([
    "The company issued an RFP for office chairs this quarter, while its industrial 3D printing operations grew in India.",
    "The company issued an RFP for office chairs this quarter; its industrial 3D printing operations grew in India.",
    "The company issued an RFP for office chairs this quarter and its industrial 3D printing operations grew in India.",
  ])("does not transfer buying proof between independent clauses: %s",text=>{
    expect(deriveProductFitments({eventType:"procurement",text},catalog)).toEqual([]);
    const classification=classifyResearchEvidence({eventType:"procurement",excerpt:text,
      context:{aiReview:{fitments:[{productId:2,productName:catalog[1].name,category:catalog[1].category,level:"direct_intent",points:100}]}}});
    expect(classification).toMatchObject({level:"context",points:0,hotEligible:false});
    expect(researchEvidenceHeat({rawScore:100,directCount:0,confirmedCount:0,hotEligible:classification.hotEligible})).toEqual({score:20,tier:"cold"});
    const conclusion:CategoryConclusion={categoryId:20,categoryName:"Commercial Printing",score:100,tier:"hot",accountFit:100,
      gaps:["Buy industrial 3D printing equipment"],opportunities:["Deploy industrial 3D printing"],rationale:"AI inferred purchase",
      evidenceStrength:"direct_intent",recommendedProducts:[{productId:2,name:catalog[1].name,rationale:"Printing RFP"}],buyers:["Procurement"],sourceUrls:["https://example.com/india"]};
    const gated=enforceCategoryConclusionEvidence({conclusions:[conclusion],catalog,firstParty:[],
      evidence:[{eventType:"procurement",excerpt:text,occurredAt:new Date().toISOString(),confidence:99,sourceUrl:"https://example.com/india",context:{}}]});
    expect(gated[0]).toMatchObject({tier:"cold",recommendedProducts:[]});
    expect(evaluateTwoLevelIntentStatus([{id:99,eventType:"procurement",excerpt:text,evidenceKind:"public_event",
      occurredAt:new Date(),confidence:99,reviewStatus:"approved",sourceUrl:"https://example.com/india",context:{}}]).accountStatus).toBe("cold");
  });

  it("keeps a laptop refresh tender valid without spreading to workstations", () => {
    const fits=deriveProductFitments({text:"The company issued an RFP for 500 laptops with delivery required this quarter."},catalog);
    expect(fits.map(f=>f.productId)).toEqual([1]);
    expect(fits[0]).toMatchObject({level:"direct_intent",points:70});
  });

  it("preserves a separate explicit purchase even when the company also cuts staff", () => {
    const fits=deriveProductFitments({eventType:"layoffs",text:`${bbc} The company issued an RFP for 100 laptops with delivery required this quarter.`},catalog);
    expect(fits.map(f=>f.productId)).toEqual([1]);
  });

  it("does not use stale AI growth labels in review or status", () => {
    const row={id:11,event_type:"hiring" as const,excerpt:"BBC increased its workforce by 2,000 people.",source_url:"https://example.com/india",
      occurred_at:new Date(),context:{originalExcerpt:bbc}};
    const review=addGrowthOpportunityFit({evidenceId:11,relevant:true,confidence:99,signalType:"hiring",
      extractedSignal:row.excerpt,rationale:"Growth",inferredCategories:["Industrial Printing"],catalogProductIds:[1,2]},row,catalog);
    expect(review).toMatchObject({signalType:"layoffs",catalogProductIds:[],fitments:[],extractedSignal:bbc});
    expect(review.inferredCategories).not.toContain("Industrial Printing");
    const status=evaluateTwoLevelIntentStatus([{
      id:11,eventType:"hiring",excerpt:row.excerpt,evidenceKind:"public_event",sourceUrl:row.source_url,occurredAt:row.occurred_at,
      reviewStatus:"approved",confidence:99,context:{...row.context,inboundCategoryName:"IT Hardware",aiReview:{extractedSignal:"hiring 2,000 people to deploy laptops"}},
    }]);
    expect(status.accountStatus).toBe("cold");
    expect(status.negativeConflict).toBe(true);
    expect(status.categories.every(c=>c.status==="cold"&&c.drivingSignals.length===0)).toBe(true);
  });

  it("produces a stable preview with removals and leaves the original finding unchanged", () => {
    const row={id:11,eventType:"hiring",excerpt:"BBC increased workforce by 2,000 people.",sourceUrl:"https://example.com/india",
      reviewStatus:"approved",productId:1,context:{originalExcerpt:bbc,aiReview:{catalogProductIds:[1,2],fitments:[
        {productId:1,productName:"HP Business Laptops",category:"IT Hardware",level:"confirmed_need",points:80},
      ]}}};
    const before=JSON.stringify(row);
    const report=reassessResearchFinding(row,catalog);
    expect(report).toEqual(reassessResearchFinding(row,catalog));
    expect(report.proposed).toMatchObject({eventType:"layoffs",disposition:"business_context_only",fitments:[],removedProductIds:[1,2],requiresHumanReview:true});
    expect(JSON.stringify(row)).toBe(before);
  });

  it("removes old workforce demand in reassessment when staff are transferred, not hired",()=>{
    const report=reassessResearchFinding({id:12,eventType:"branch_opening",
      excerpt:"Opened a new office with 500 office employees transferred from another site",
      sourceUrl:"https://example.com/office",reviewStatus:"approved",productId:1,
      context:{aiReview:{fitments:[{productId:1,productName:"HP Business Laptops",category:"IT Hardware",level:"confirmed_need",points:80}]}}},
      catalog);
    expect(report.workforce.growthHeadcount).toBe(0);
    expect(report.proposed).toMatchObject({fitments:[],removedProductIds:[1],disposition:"business_context_only"});
  });

  it("blocks additive points from stale AI growth interpretations",()=>{
    expect(scoredAccountSignals([{
      id:11,event_type:"hiring",occurred_at:new Date(),source_url:"https://example.com/india",confidence:99,
      excerpt:"BBC is adding 2,000 employees and needs laptops.",
      context:{originalExcerpt:bbc,aiReview:{relevant:true,confidence:99,rationale:"Growth requires devices.",
        fitments:[{productId:1,points:80,level:"confirmed_need",reason:"A large workforce expansion requires new laptop deployment."}]}},
    }],catalog)).toEqual([]);
  });
});
