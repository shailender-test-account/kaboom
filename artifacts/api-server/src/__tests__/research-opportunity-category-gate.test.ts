import { describe, expect, it } from "vitest";
import { enforceCategoryConclusionEvidence, type CategoryConclusion } from "../lib/researchOpportunityInterpreter";
import type { ProviderEvent } from "../lib/intentProviders";

const catalog = [
  { id: 1, name: "HP Commercial Printer", categoryId: 10, category: "Commercial Printing", subcategory: null },
  { id: 2, name: "HP Business Laptop", categoryId: 20, category: "IT Hardware", subcategory: null },
];

function conclusion(categoryId:number,categoryName:string,score=100):CategoryConclusion {
  const product=catalog.find(item=>item.categoryId===categoryId)!;
  const printing=categoryId===10;
  return {categoryId,categoryName,score,tier:"hot",accountFit:90,gaps:[printing?"Reduce packaging and label printing cost":"Reduce production cost"],opportunities:[printing?"Consolidate production-print and document workflows":"Improve production workflow efficiency"],
    rationale:`Textile profitability indicates cost discipline; ${product.name} could improve production workflow efficiency.`,evidenceStrength:"business_trigger",
    recommendedProducts:[{productId:product.id,name:product.name,rationale:"Potential workflow cost reduction."}],buyers:["Operations"],sourceUrls:["https://example.com/profit"]};
}

const profitability:ProviderEvent={eventType:"quarterly_financial",occurredAt:new Date().toISOString(),sourceUrl:"https://example.com/profit",
  excerpt:"Grasim Industries reports improved first-quarter profit as costs decreased in its textile business.",confidence:85,context:{}};

describe("category evidence enforcement",()=>{
  it("keeps a profitability-only sector hypothesis at Monitor/Emerging and prevents generic profit from making categories Hot",()=>{
    const result=enforceCategoryConclusionEvidence({conclusions:[conclusion(10,"Commercial Printing",62),conclusion(20,"IT Hardware",100)],
      evidence:[profitability],catalog,firstParty:[],industry:"Textiles"});
    expect(result.every(item=>["low","emerging"].includes(item.propensityBand??""))).toBe(true);
    expect(result.every(item=>item.tier!=="hot")).toBe(true);
    expect(result.find(item=>item.categoryId===20)).toMatchObject({tier:"cold",recommendedProducts:[]});
    expect(result.find(item=>item.categoryId===20)?.score).toBeLessThanOrEqual(3);
  });

  it("allows Hot only when product-linked first-party intent has an urgent timeframe",()=>{
    const result=enforceCategoryConclusionEvidence({conclusions:[conclusion(10,"Commercial Printing")],evidence:[profitability],catalog,
      firstParty:[
        {eventType:"questionnaire_product_interest",excerpt:"Interested in HP Commercial Printer",occurredAt:new Date(),product:"HP Commercial Printer"},
        {eventType:"questionnaire_timeframe",excerpt:"Purchase within 30 days",occurredAt:new Date(),product:null},
      ],industry:"Textiles"});
    expect(result[0]).toMatchObject({score:80,tier:"hot",propensityBand:"hot",evidenceStrength:"direct_intent"});
  });

  it("treats revenue growth with profit decline as account context plus negative evidence, never category warmth",()=>{
    const mixedFinancial:ProviderEvent={...profitability,excerpt:"Revenue grew 10% year on year, while operating profit and net profit declined sharply."};
    const result=enforceCategoryConclusionEvidence({conclusions:[conclusion(10,"Commercial Printing",100)],evidence:[mixedFinancial],catalog,firstParty:[],industry:"Textiles"});
    expect(result[0].tier).toBe("cold");
    expect(result[0].propensity?.negativeDeduction).toBeGreaterThan(0);
    expect(result[0].rationale).toContain("account context only");
  });
});