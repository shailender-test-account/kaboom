import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks=vi.hoisted(()=>({query:vi.fn(),clientQuery:vi.fn(),release:vi.fn()}));
vi.mock("@workspace/db",()=>({
  pool:{query:mocks.query,connect:vi.fn(async()=>({query:mocks.clientQuery,release:mocks.release}))},db:{},
}));
vi.mock("../middlewares/requireAuth",async importOriginal=>({
  ...await importOriginal<typeof import("../middlewares/requireAuth")>(),
  requireAuth:(req:any,_res:any,next:any)=>{req.user={id:3,tenantId:7,role:"admin"};next();},
}));
vi.mock("../utils/segmentFilter",()=>({buildContactsWhereClause:vi.fn()}));
vi.mock("../lib/alwaysOnIntent",()=>({
  ensureIntentDefaults:vi.fn(),enqueueIntent:vi.fn(),matchEntities:vi.fn(),normalizedDomain:vi.fn(),recomputeIntent:vi.fn(),
  PUBLIC_EVENT_TYPES:["funding"],eventFingerprint:vi.fn(),readProductIntentScore:vi.fn(),
  base2Decay:vi.fn(()=>1),saturateRepeatedSignals:vi.fn(),selectIntentTier:vi.fn(()=>({key:"cold"})),
}));
import router from "../routes/intent";

const app=express().use(express.json()).use(router).use((error:Error,_req:any,res:any,_next:any)=>{
  res.status(500).json({error:error.message});
});
const result=(rows:any[])=>({rows,rowCount:rows.length});
const body={
  name:"No Category · Warm",clientId:9,classification:"warm",matchType:"category",
  productId:null,productName:null,categoryId:null,categoryName:"No Category",keywords:[],
  journeyId:36,sequenceId:16,priority:10,enabled:true,
};
const rules=[
  {id:6,classification:"warm",journey_id:36,sequence_id:16,priority:10,enabled:true},
  {id:7,classification:"warm",journey_id:36,sequence_id:16,priority:10,enabled:true},
  {id:8,classification:"all",journey_id:36,sequence_id:16,priority:10,enabled:true},
];

describe("No Category route save and consolidation",()=>{
  beforeEach(()=>{
    vi.clearAllMocks();
    mocks.query.mockImplementation(async(sql:string)=>{
      if(sql.includes("FROM clients"))return result([{id:9}]);
      if(sql.includes("FROM journeys"))return result([{client_id:9}]);
      if(sql.includes("FROM email_sequences"))return result([{id:16}]);
      return result([]);
    });
    mocks.clientQuery.mockImplementation(async(sql:string)=>{
      if(sql.includes("SELECT id FROM intent_inbound_routing_rules"))return result([{id:8}]);
      if(sql.includes("FROM intent_inbound_routing_rules WHERE"))return result(rules);
      if(sql.includes("SELECT id FROM intent_inbound_submissions"))return result([]);
      if(sql.includes("SELECT DISTINCT routed_rule_id"))return result([]);
      if(sql.includes("UPDATE intent_inbound_routing_rules"))return result([{id:6}]);
      if(sql.includes("DELETE FROM intent_inbound_routing_rules"))return result([{id:6},{id:7}]);
      return result([]);
    });
  });

  it("rejects a duplicate create before inserting or routing pending responses",async()=>{
    const response=await request(app).post("/intent/inbound/routing-rules").send(body).expect(409);
    expect(response.body.error).toContain("already covers");
    expect(mocks.clientQuery.mock.calls.some(([sql])=>String(sql).includes("INSERT INTO intent_inbound_routing_rules"))).toBe(false);
  });

  it("rejects editing a rule into an overlapping No Category status",async()=>{
    const response=await request(app).put("/intent/inbound/routing-rules/6").send(body).expect(409);
    expect(response.body.error).toContain("Consolidate duplicates");
    expect(mocks.clientQuery.mock.calls.some(([sql])=>String(sql).includes("UPDATE intent_inbound_routing_rules"))).toBe(false);
  });

  it("allows destination edits on an already-overlapping Warm rule",async()=>{
    mocks.clientQuery.mockImplementation(async(sql:string)=>{
      if(sql.includes("SELECT id FROM intent_inbound_routing_rules"))return result([{id:8}]);
      if(sql.includes("SELECT client_id,match_type,classification,enabled"))return result([{
        client_id:9,match_type:"category",classification:"warm",enabled:true,
        inbound_category_name:"No Category",product_id:null,category_id:null,
        inbound_product_name:null,keywords:[],
      }]);
      if(sql.includes("UPDATE intent_inbound_routing_rules"))return result([{id:6}]);
      return result([]);
    });
    mocks.query.mockImplementation(async(sql:string)=>{
      if(sql.includes("FROM clients"))return result([{id:9}]);
      if(sql.includes("FROM journeys"))return result([{client_id:9}]);
      if(sql.includes("FROM email_sequences"))return result([{id:16}]);
      return result([]);
    });
    await request(app).put("/intent/inbound/routing-rules/6").send({...body,classification:"warm",journeyId:36}).expect(200);
    expect(mocks.clientQuery.mock.calls.some(([sql])=>String(sql).includes("UPDATE intent_inbound_routing_rules"))).toBe(true);
    expect(mocks.query.mock.calls.some(([sql])=>String(sql).includes("INSERT INTO journey_contacts"))).toBe(false);
  });

  it("allows disabling an overlapping rule even when its route has history",async()=>{
    await request(app).put("/intent/inbound/routing-rules/6").send({...body,classification:"warm",enabled:false}).expect(200);
    expect(mocks.clientQuery.mock.calls.some(([sql])=>String(sql).includes("UPDATE intent_inbound_routing_rules"))).toBe(true);
  });

  it("refuses to remove a rule referenced by routed submissions",async()=>{
    mocks.clientQuery.mockImplementation(async(sql:string)=>{
      if(sql.includes("FROM intent_inbound_routing_rules WHERE"))return result(rules);
      if(sql.includes("SELECT id FROM intent_inbound_submissions"))return result([]);
      if(sql.includes("SELECT DISTINCT routed_rule_id"))return result([{routed_rule_id:6},{routed_rule_id:7}]);
      return result([]);
    });
    await request(app).post("/intent/inbound/routing-rules/consolidate-no-category").send({clientId:9}).expect(409);
    expect(mocks.clientQuery.mock.calls.some(([sql])=>String(sql).includes("DELETE FROM intent_inbound_routing_rules"))).toBe(false);
  });

  it("refuses to retarget an unresolved No Category response",async()=>{
    mocks.clientQuery.mockImplementation(async(sql:string)=>{
      if(sql.includes("FROM intent_inbound_routing_rules WHERE"))return result(rules);
      if(sql.includes("SELECT id FROM intent_inbound_submissions"))return result([{id:42}]);
      if(sql.includes("SELECT DISTINCT routed_rule_id"))return result([]);
      return result([]);
    });
    const response=await request(app).post("/intent/inbound/routing-rules/consolidate-no-category").send({clientId:9}).expect(409);
    expect(response.body.error).toContain("1 unresolved");
    expect(mocks.clientQuery.mock.calls.some(([sql])=>String(sql).includes("DELETE FROM intent_inbound_routing_rules"))).toBe(false);
  });

  it("removes only equivalent, unused rules and leaves submissions and enrollments unchanged",async()=>{
    const response=await request(app).post("/intent/inbound/routing-rules/consolidate-no-category").send({clientId:9}).expect(200);
    expect(response.body).toEqual({keptId:8,removedIds:[6,7],retainedIds:[]});
    const deletion=mocks.clientQuery.mock.calls.find(([sql])=>String(sql).includes("DELETE FROM intent_inbound_routing_rules"));
    expect(deletion?.[1]).toEqual([7,[6,7]]);
    expect(mocks.clientQuery.mock.calls.some(([sql])=>/^\s*(UPDATE|INSERT)\b/.test(String(sql)))).toBe(false);
  });

  it("keeps a historical Warm rule but removes an unused duplicate",async()=>{
    mocks.clientQuery.mockImplementation(async(sql:string)=>{
      if(sql.includes("FROM intent_inbound_routing_rules WHERE"))return result(rules);
      if(sql.includes("SELECT id FROM intent_inbound_submissions"))return result([]);
      if(sql.includes("SELECT DISTINCT routed_rule_id"))return result([{routed_rule_id:6}]);
      if(sql.includes("DELETE FROM intent_inbound_routing_rules"))return result([{id:7}]);
      return result([]);
    });
    const response=await request(app).post("/intent/inbound/routing-rules/consolidate-no-category").send({clientId:9}).expect(200);
    expect(response.body).toEqual({keptId:8,removedIds:[7],retainedIds:[6]});
    expect(mocks.clientQuery.mock.calls.find(([sql])=>String(sql).includes("DELETE FROM intent_inbound_routing_rules"))?.[1]).toEqual([7,[7]]);
  });
});