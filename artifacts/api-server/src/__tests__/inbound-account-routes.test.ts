import { describe, expect, it } from "vitest";
import { accountRoutingDestinations, type InboundRouteRow, type NamedInboundRule } from "../lib/inboundAccountRoutes";

const rules:NamedInboundRule[]=[
  {
    id:5,client_id:4,match_type:"category",classification:"all",keywords:[],
    inbound_category_name:"No Category",journey_id:36,sequence_id:16,
    journeyName:"General introduction",sequenceName:"General nurture",
    sequenceStatus:"active",enabled:true,product_name:null,category_name:null,
  },
  {
    id:6,client_id:4,match_type:"product",classification:"warm",keywords:[],
    product_name:"Endpoint Security",journey_id:37,sequence_id:17,
    journeyName:"Security discovery",sequenceName:"Security follow-up",
    sequenceStatus:"active",enabled:true,category_name:null,
  },
];
const response=(overrides:Partial<InboundRouteRow>={}):InboundRouteRow=>({
  accountId:1,clientId:4,submissionId:1,productInterest:null,affinityReviews:{},
  classification:"cold",routingStatus:"pending",routedRuleId:null,
  manualJourneyId:null,manualSequenceId:null,manualJourneyName:null,manualSequenceName:null,
  ...overrides,
});
const routes=(rows:InboundRouteRow[],items=rules,hotAccounts:ReadonlySet<number>=new Set())=>accountRoutingDestinations(rows,items,
  [{id:81,name:"Endpoint Security",category:"Security",subcategory:null}],{rules:[],useBuiltin:true},hotAccounts);

describe("inbound account destinations",()=>{
  it("shows configured destinations for Warm responses, never Cold responses",()=>{
    expect(routes([response()]).has(1)).toBe(false);
    expect(routes([response({classification:"warm"})]).get(1)).toEqual([{
      journeyId:36,journeyName:"General introduction",sequenceId:16,sequenceName:"General nurture",
      status:"configured",source:"rule",responseCount:1,
    }]);
  });
  it("shows the actual routed rule even if later disabled and does not mislabel pending responses as routed",()=>{
    const disabled=[{...rules[0],enabled:false},rules[1]];
    expect(routes([response({routingStatus:"routed",routedRuleId:5})],disabled).get(1)?.[0])
      .toMatchObject({journeyName:"General introduction",status:"routed"});
    expect(routes([response()],disabled).has(1)).toBe(false);
  });
  it("keeps different respondent destinations and statuses rather than showing only the newest",()=>{
    const account=routes([
      response({submissionId:1,routingStatus:"routed",routedRuleId:5}),
      response({submissionId:2,productInterest:"Endpoint Security",classification:"warm"}),
      response({submissionId:3,productInterest:"Endpoint Security",classification:"warm"}),
    ]).get(1);
    expect(account).toMatchObject([
      {journeyName:"General introduction",status:"routed",responseCount:1},
      {journeyName:"Security discovery",status:"configured",responseCount:2},
    ]);
  });
  it("uses the exact manual destination for a response, even without a product selection",()=>{
    expect(routes([response({
      routingStatus:"routed",manualJourneyId:42,manualSequenceId:43,
      manualJourneyName:"Custom journey",manualSequenceName:"Custom sequence",
    })]).get(1)?.[0]).toMatchObject({
      journeyName:"Custom journey",sequenceName:"Custom sequence",source:"manual",status:"routed",
    });
  });
  it("does not imply a route for manual accounts or rejected interests",()=>{
    expect(routes([]).size).toBe(0);
    expect(routes([response({productInterest:"Endpoint Security",affinityReviews:{"Endpoint Security":"rejected"}})]).size).toBe(0);
  });
  it("hides all configured or unverified routing on Hot accounts",()=>{
    const hot=new Set([1]);
    expect(routes([
      response({classification:"warm",productInterest:"Endpoint Security"}),
      response({classification:"hot",routingStatus:"routed",routedRuleId:5}),
      response({classification:"warm",routingStatus:"routed",routedRuleId:5}),
      response({classification:"hot",manualJourneyId:42,manualJourneyName:"Incorrect Hot route"}),
    ],rules,hot).has(1)).toBe(false);
  });
  it("shows only verified, named Warm journey history on Hot accounts",()=>{
    expect(routes([
      response({classification:"warm",routingStatus:"routed",routedRuleId:5,hasWarmJourneyHistory:true}),
      response({classification:"warm",productInterest:"Endpoint Security"}),
      response({classification:"warm",routingStatus:"routed",routedRuleId:999,hasWarmJourneyHistory:true}),
    ],rules,new Set([1])).get(1)).toMatchObject([
      {journeyId:36,journeyName:"General introduction",status:"routed",responseCount:1},
    ]);
  });
  it("does not accept Hot routing as history even with a membership",()=>{
    expect(routes([response({
      classification:"hot",routingStatus:"routed",routedRuleId:5,hasWarmJourneyHistory:true,
    })],rules,new Set([1])).has(1)).toBe(false);
  });
});