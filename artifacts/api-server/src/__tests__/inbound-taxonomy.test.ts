import { describe, expect, it } from "vitest";
import { inboundCategoryForInterest, inboundProducts, validateInboundCategoryRules } from "../lib/inboundTaxonomy";
import { groupInboundCategoryCohorts, matchingInboundRoutingRule } from "../lib/inboundAccounts";

describe("tenant answer matching terms",()=>{
  const rules=[
    {categoryName:"Business Services",terms:["custom service"]},
    {categoryName:"IT Hardware",terms:["custom workstation"]},
    {categoryName:"Security",terms:[]},
    {categoryName:"Business Collaboration",terms:[]},
  ];
  it("classifies historic answers with saved terms while preserving response corrections",()=>{
    expect(validateInboundCategoryRules(rules)).toBeNull();
    const config={rules,useBuiltin:true};
    expect(inboundCategoryForInterest("Looking for CUSTOM SERVICE",null,config).categoryName).toBe("Business Services");
    expect(inboundCategoryForInterest("custom services",null,config).categoryName).toBe("Needs categorization");
    expect(inboundCategoryForInterest("custom service",{__categoryOverrides:{"custom service":"Security"}},config).categoryName).toBe("Security");
    expect(inboundCategoryForInterest("custom service and custom workstation",null,config).categoryName).toBe("Needs categorization");
    expect(inboundCategoryForInterest("AI laptops",null,{rules,useBuiltin:false}).categoryName).toBe("Needs categorization");
  });
  it("rejects cross-category matching terms that can overlap",()=>{
    expect(validateInboundCategoryRules([
      ...rules.slice(0,1),
      {categoryName:"IT Hardware",terms:["service"]},
    ])).toContain("overlaps");
  });
});

describe("inbound-only product categories", () => {
  it.each([
    ["AI laptops", "IT Hardware"],
    ["Poly headsets", "Business Collaboration"],
    ["Poly video conferencing solutions", "Business Collaboration"],
    ["HP Wolf Security", "Security"],
    ["HP SureClick", "Security"],
    ["Endpoint security", "Security"],
    ["Document & workflow management", "Business Services"],
    ["Printing security software", "Business Services"],
    ["Device as a Service", "Business Services"],
    ["HP Anyware", "Business Services"],
    ["Unrecognized answer", "Needs categorization"],
  ])("groups %s under %s", (answer, category) => {
    expect(inboundCategoryForInterest(answer).categoryName).toBe(category);
  });

  it("applies a reviewed per-response correction without altering the shared catalog", () => {
    expect(inboundCategoryForInterest("New custom service", {
      __categoryOverrides:{"New custom service":"Security"},
    }).categoryName).toBe("Security");
    const cohort=groupInboundCategoryCohorts([{
      clientId:2,accountId:5,contactId:8,accountName:"Acme",productAffinity:"New custom service",
      classification:"warm",routingStatus:"pending",
      affinityReviews:{__categoryOverrides:{"New custom service":"Security"}},
    }],[]);
    expect(cohort).toMatchObject([{categoryName:"Security",accountCount:1,contactCount:1}]);
  });

  it("routes categories by the inbound taxonomy before falling back to legacy catalog categories", () => {
    const rules=[
      {id:1,client_id:2,match_type:"category" as const,classification:"warm" as const,
        category_name:"Software & Services",product_name:null,keywords:[],journey_id:1,sequence_id:1},
      {id:2,client_id:2,match_type:"category" as const,classification:"warm" as const,
        category_name:"Business Services",product_name:null,keywords:[],journey_id:1,sequence_id:1},
    ];
    const catalog=[{id:10,name:"HP Managed Device Services",category:"Software & Services",subcategory:"Computing Services"}];
    expect(matchingInboundRoutingRule(rules,2,"HP Managed Device Services","warm",catalog)?.id).toBe(2);
  });

  it("keeps the product selector aligned with the documented categories", () => {
    expect(new Set(inboundProducts.map(product=>product.categoryName))).toEqual(
      new Set(["IT Hardware","Business Collaboration","Security","Business Services"]));
    expect(inboundProducts.find(product=>product.name==="HP Anyware")?.subcategoryName).toBe("Computing service");
  });
});