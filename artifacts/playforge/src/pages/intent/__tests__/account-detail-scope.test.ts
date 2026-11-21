import { describe, expect, it } from "vitest";
import { explicitPublicEvidenceRank, selectScopedCategoryInsights } from "../account-detail";

describe("scoped account detail priorities", () => {
  it("removes generic out-of-scope themes and ranks explicit first-party intent first", () => {
    const result=selectScopedCategoryInsights([
      {category:"Finance & Cost Optimization",score:100,tier:"hot",inSelectedScope:false,explicitSource:null},
      {category:"M&A & Transformation",score:100,tier:"hot",inSelectedScope:false,explicitSource:null},
      {category:"Software & Services",score:48,tier:"warm",inSelectedScope:true,explicitSource:null},
      {category:"Managed Software Services",score:5,tier:"cold",inSelectedScope:true,explicitSource:"questionnaire"},
    ],true);

    expect(result.map(item=>item.category)).toEqual(["Managed Software Services","Software & Services"]);
  });

  it("keeps generic themes available in an unscoped account analysis", () => {
    const result=selectScopedCategoryInsights([
      {category:"Finance & Cost Optimization",score:90,inSelectedScope:false,explicitSource:null},
      {category:"Software & Services",score:40,inSelectedScope:true,explicitSource:null},
    ],false);

    expect(result.map(item=>item.category)).toEqual(["Software & Services","Finance & Cost Optimization"]);
  });

  it("places explicit tenders and direct buying evidence before generic news", () => {
    const evidence=[
      {eventType:"quarterly_financial",context:{}},
      {eventType:"tender",context:{}},
      {eventType:"technology_integration",context:{fitmentLevel:"direct_intent"}},
    ].sort((a,b)=>explicitPublicEvidenceRank(a)-explicitPublicEvidenceRank(b));

    expect(evidence.map(item=>item.eventType)).toEqual(["tender","technology_integration","quarterly_financial"]);
  });
});