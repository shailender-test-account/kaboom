import { describe, expect, it } from "vitest";
import { evaluateTwoLevelIntentStatus, type IntentStatusEvidence } from "../lib/twoLevelIntentStatus";

const now = new Date("2026-09-21T12:00:00.000Z");
function evidence(overrides: Partial<IntentStatusEvidence>): IntentStatusEvidence {
  return {
    id: 1,
    evidenceKind: "public_event",
    eventType: "capital_investment",
    excerpt: "India investment update",
    sourceUrl: "https://example.com/news",
    occurredAt: "2026-09-15T00:00:00.000Z",
    confidence: 80,
    reviewStatus: "approved",
    context: {},
    ...overrides,
  };
}

describe("two-level intent status", () => {
  it("keeps intent-stage operational acquisition news Cold without a category-specific need", () => {
    const result = evaluateTwoLevelIntentStatus([evidence({
      eventType: "merger_acquisition",
      excerpt: "RPG Life Sciences in New Delhi is evaluating acquisitions and plans ₹500 crore for manufacturing and API capacity.",
      context: { dealStage: "intent", dealType: "asset_or_plant_acquisition", capexType: "operational" },
    })], now);
    expect(result.accountStatus).toBe("cold");
    expect(result.categories.map(item=>item.name)).toEqual(["IT Hardware","Business Collaboration","Security","Business Services"]);
    expect(result.categories.find(item => item.key === "BUSINESS_COLLABORATION")?.status).toBe("cold");
    expect(result.categories.find(item => item.key === "BUSINESS_SERVICES")?.status).toBe("cold");
  });

  it("makes explicit first-party need with a six-month timeframe Hot", () => {
    const result = evaluateTwoLevelIntentStatus([evidence({
      evidenceKind: "lead_form",
      eventType: "product_buy_intent",
      excerpt: "Need a quote for 250 laptops within 3 months.",
      reviewStatus: "approved",
    })], now);
    expect(result.accountStatus).toBe("hot");
    expect(result.categories.find(item => item.key === "IT_HARDWARE")).toMatchObject({ status: "hot", attribution: "CONFIRMED" });
  });

  it("caps news-based Hot at Warm when negative financial evidence is active", () => {
    const result = evaluateTwoLevelIntentStatus([
      evidence({ id:1,eventType:"technology_integration",excerpt:"The company approved a purchase order to replace 500 endpoint devices during a Windows 11 fleet refresh across India." }),
      evidence({ id:2,eventType:"layoffs",excerpt:"The company announced layoffs and a spending freeze across India." }),
    ], now);
    expect(result.accountStatus).toBe("warm");
    expect(result.categories.every(item => item.status !== "hot")).toBe(true);
    expect(result.negativeConflict).toBe(true);
  });

  it("keeps one moderate leadership signal Cold without corroboration", () => {
    const result = evaluateTwoLevelIntentStatus([evidence({
      eventType: "hiring",
      excerpt: "The India business appointed a new Head of IT in Mumbai.",
    })], now);
    expect(result.accountStatus).toBe("cold");
    expect(result.accountFlag).toBeNull();
    expect(result.accountDrivingSignals).toEqual([]);
    expect(result.categories.find(item => item.key === "IT_HARDWARE")?.statusReason).toContain("no current evidence");
    expect(result.categories.find(item => item.key === "BUSINESS_SERVICES")?.status).toBe("cold");
  });

  it("does not expose rejected evidence as a status driver", () => {
    const result = evaluateTwoLevelIntentStatus([evidence({
      eventType: "hiring",
      excerpt: "The India business appointed a new Head of IT in Mumbai.",
      reviewStatus: "rejected",
    })], now);
    expect(result.accountStatus).toBe("cold");
    expect(result.accountDrivingSignals).toEqual([]);
  });

  it("ignores procurement and hiring words that exist only in retrieval metadata",()=>{
    const result=evaluateTwoLevelIntentStatus([evidence({
      id:11,
      eventType:"capital_investment",
      excerpt:"Aditya Birla Group launched Ultravoilt, a new wires and cables business backed by ₹1,800 crore investment.",
      context:{query:"company RFP RFQ vendor procurement jobs hiring careers"},
    })],now);
    expect(result.accountStatus).not.toBe("hot");
    expect(result.accountDrivingSignals).toEqual([]);
    expect(result.categories.flatMap(category=>category.drivingSignals).some(signal=>["procurement_hiring","vendor_change"].includes(signal.signalType))).toBe(false);
  });

  it("collapses substantially identical coverage before creating drivers",()=>{
    const rows=[
      evidence({id:21,eventType:"capital_investment",excerpt:"Aditya Birla Group launched Ultravoilt, a wires and cables business backed by ₹1,800 crore investment.",sourceUrl:"https://one.example/story"}),
      evidence({id:22,eventType:"procurement",excerpt:"Aditya Birla Group launched Ultravoilt, a wires and cables business backed by ₹1,800 crore investment.",sourceUrl:"https://two.example/story"}),
    ];
    const result=evaluateTwoLevelIntentStatus(rows,now);
    const ids=new Set(result.categories.flatMap(category=>category.drivingSignals).map(signal=>signal.evidenceId));
    expect(ids.size).toBeLessThanOrEqual(1);
    expect(result.accountStatus).not.toBe("hot");
  });

  it("preserves greedy duplicate preference across identity, text, time and token-overlap boundaries",()=>{
    const day=86_400_000;
    const normalize=(value:unknown)=>String(value??"").toLowerCase();
    const text=(row:IntentStatusEvidence)=>normalize(row.excerpt).replace(/[^a-z0-9₹]+/g," ").replace(/\s+/g," ").trim();
    const same=(a:IntentStatusEvidence,b:IntentStatusEvidence)=>{
      const ai=normalize(a.context.sourceIdentity),bi=normalize(b.context.sourceIdentity);
      if(ai&&bi&&ai===bi)return true;
      if(text(a)&&text(a)===text(b))return true;
      if(Math.abs(new Date(a.occurredAt).getTime()-new Date(b.occurredAt).getTime())>21*day)return false;
      const left=new Set(text(a).split(" ").filter(token=>token.length>2));
      const right=new Set(text(b).split(" ").filter(token=>token.length>2));
      return left.size>=6&&right.size>=6&&[...left].filter(token=>right.has(token)).length/Math.max(left.size,right.size)>=0.8;
    };
    const base=evidence({id:101,eventType:"technology_integration",excerpt:"India approved a purchase order for endpoint refresh laptop deployment across Mumbai offices."});
    const variants=[
      evidence({...base,id:102,confidence:90,sourceUrl:null}),
      evidence({...base,id:103,excerpt:base.excerpt.replace("Mumbai","Pune")}),
      evidence({...base,id:104,occurredAt:new Date(new Date(base.occurredAt).getTime()-22*day)}),
      evidence({...base,id:105,context:{sourceIdentity:"SOURCE"},excerpt:"India has contracted replacement of video conferencing equipment."}),
      evidence({...base,id:106,context:{sourceIdentity:"source"},excerpt:"India will purchase endpoint devices for a Windows 11 fleet refresh.",occurredAt:new Date(new Date(base.occurredAt).getTime()-30*day)}),
      evidence({...base,id:107,confidence:60,excerpt:"India approved a purchase order for endpoint refresh laptop deployment across Pune offices and warehouses."}),
    ];
    for(const rows of [[base,...variants],[...variants].reverse(),...variants.map(row=>[base,row])]){
      const preferred=[...rows].sort((a,b)=>b.confidence-a.confidence||Number(Boolean(b.sourceUrl))-Number(Boolean(a.sourceUrl))||b.id-a.id);
      const legacy:IntentStatusEvidence[]=[];
      for(const row of preferred)if(!legacy.some(existing=>same(existing,row)))legacy.push(row);
      expect(evaluateTwoLevelIntentStatus(rows,now)).toEqual(evaluateTwoLevelIntentStatus(legacy,now));
    }
  });

  it("requires direct product purchase or deployment evidence for external Hot",()=>{
    const result=evaluateTwoLevelIntentStatus([evidence({
      id:31,eventType:"technology_integration",
      excerpt:"The company announced a funded rollout to replace 2,000 endpoint devices and deploy Windows 11 across its India offices.",
    })],now);
    expect(result.accountStatus).toBe("hot");
    expect(result.accountExplanation).toContain("replace 2,000 endpoint devices");
  });

  it("does not turn revenue growth with profit decline into category intent",()=>{
    const result=evaluateTwoLevelIntentStatus([evidence({
      id:41,eventType:"quarterly_financial",
      excerpt:"India revenue grew 10% year on year, while operating profit and net profit declined sharply.",
    })],now);
    expect(result.accountStatus).toBe("cold");
    expect(result.negativeConflict).toBe(true);
    expect(result.categories.every(category=>category.status==="cold"&&category.drivingSignals.length===0)).toBe(true);
    expect(result.categories.find(category=>category.key==="BUSINESS_SERVICES")?.statusReason).toContain("no current evidence");
  });

  it("does not assign generic operational hiring to a product category without a taxonomy match",()=>{
    const result=evaluateTwoLevelIntentStatus([evidence({
      id:51,eventType:"hiring",
      excerpt:"The company is hiring 300 contact center agents for its Bengaluru customer support operation.",
    })],now);
    expect(result.categories.every(category=>category.status==="cold")).toBe(true);
  });

  it("does not assign generic hiring and partnership evidence to product categories",()=>{
    const result=evaluateTwoLevelIntentStatus([
      evidence({id:61,eventType:"hiring",excerpt:"The company is hiring a Head of IT for its India business."}),
      evidence({id:62,eventType:"partnership",excerpt:"The India business announced a strategic partnership with a consulting firm.",sourceUrl:"https://example.com/partnership"}),
    ],now);
    expect(result.categories.every(category=>category.status==="cold")).toBe(true);
  });

  it("uses saved tenant phrase rules to override built-in monitoring evidence categories",()=>{
    const result=evaluateTwoLevelIntentStatus([evidence({
      id:71,eventType:"technology_integration",
      excerpt:"The company approved a purchase order to replace 300 endpoint devices in its device refresh across India.",
      context:{inboundCategoryName:"IT Hardware"},
    })],now,{
      rules:[{categoryName:"Business Services",terms:["device refresh"]}],
      useBuiltin:true,
    });
    expect(result.categories.find(category=>category.name==="Business Services")).toMatchObject({status:"hot",attribution:"PROBABLE"});
    expect(result.categories.find(category=>category.name==="IT Hardware")?.status).toBe("cold");
  });

  it("applies built-in four-category classification to historic monitoring evidence at read time",()=>{
    const result=evaluateTwoLevelIntentStatus([evidence({
      id:72,eventType:"technology_integration",
      excerpt:"The company approved a purchase order to replace 500 endpoint devices during a Windows 11 fleet refresh across India.",
    })],now);
    expect(result.categories.find(category=>category.name==="IT Hardware")).toMatchObject({status:"hot",attribution:"PROBABLE"});
    expect(result.categories.map(category=>category.name)).not.toContain("Software & Services");
  });
});