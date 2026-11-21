import {describe,expect,it} from "vitest";
import {scoreCategoryIntentPropensity} from "../lib/categoryIntentPropensity";

const now=new Date("2026-09-05T00:00:00Z");
const fact=(kind:"need"|"purchase"|"negative"|"external_pressure",id:string,strength=100)=>({
  id,kind,strength,occurredAt:now,halfLifeDays:60,sourceUrl:`https://reuters.com/${id}`,sourceReliability:90,underlyingEventKey:id,explanation:id,
});

describe("category intent propensity",()=>{
  it("keeps one cited profitability/ability-to-buy signal below Warm",()=>{
    const result=scoreCategoryIntentPropensity([fact("need","quarterly-profit",35)],now);
    expect(result.band).toBe("low");
    expect(result.score).toBeLessThan(40);
    expect(result.hasRecentPurchaseSignal).toBe(false);
  });
  it("requires a recent purchase-stage fact for Hot even when need and pressure are strong",()=>{
    const without=scoreCategoryIntentPropensity([fact("need","new-sites"),fact("need","hiring"),fact("external_pressure","os-eol")],now);
    expect(without.band).not.toBe("hot");
    const withTender=scoreCategoryIntentPropensity([...without.evidence,fact("purchase","laptop-rfp")],now);
    expect(withTender).toMatchObject({band:"hot",hasRecentPurchaseSignal:true});
  });
  it("does not call an unverified-web purchase claim Hot",()=>{
    const result=scoreCategoryIntentPropensity([{...fact("purchase","laptop-rfp"),sourceReliability:60,sourceUrl:"https://unknown.example/rfp"}],now);
    expect(result.hasRecentPurchaseSignal).toBe(false);
    expect(result.band).not.toBe("hot");
  });
  it("deduplicates multiple articles about one underlying event",()=>{
    const result=scoreCategoryIntentPropensity([
      fact("need","same-expansion"),{...fact("need","same-expansion"),id:"second-article"},
    ],now);
    expect(result.evidence).toHaveLength(1);
  });
  it("applies negative evidence and base-2 time decay",()=>{
    const recent=scoreCategoryIntentPropensity([fact("need","hiring"),fact("need","branches")],now);
    const reduced=scoreCategoryIntentPropensity([fact("need","hiring"),fact("need","branches"),fact("negative","closures")],now);
    expect(reduced.score).toBeLessThan(recent.score);
  });
});