import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks=vi.hoisted(()=>({query:vi.fn(),clientQuery:vi.fn(),release:vi.fn()}));
vi.mock("@workspace/db",()=>({pool:{query:mocks.query,connect:vi.fn(async()=>({query:mocks.clientQuery,release:mocks.release}))},db:{}}));
vi.mock("../middlewares/requireAuth",async importOriginal=>({...await importOriginal<typeof import("../middlewares/requireAuth")>(),requireAuth:(req:any,_res:any,next:any)=>{req.user={id:3,tenantId:7,role:"admin"};next();}}));
vi.mock("../utils/segmentFilter",()=>({buildContactsWhereClause:vi.fn()}));
vi.mock("../lib/alwaysOnIntent",()=>({
  ensureIntentDefaults:vi.fn(),enqueueIntent:vi.fn(),matchEntities:vi.fn(),normalizedDomain:vi.fn(),recomputeIntent:vi.fn(),
  PUBLIC_EVENT_TYPES:["funding"],eventFingerprint:vi.fn(()=>"funding:canonical"),readProductIntentScore:vi.fn(),
  base2Decay:vi.fn(()=>1),saturateRepeatedSignals:vi.fn((x:number[])=>x.reduce((a,b)=>a+b,0)),
  selectIntentTier:vi.fn(()=>({key:"cold"})),
}));
import router from "../routes/intent";
const app=express().use(express.json()).use(router);
const result=(rows:any[])=>({rows,rowCount:rows.length});
const pending={review_status:"pending_review",signal_id:null,account_id:null,product_id:null,event_type:"funding",event_fingerprint:null,source_url:"https://news.example/event",excerpt:"Funding",provider:"manual",confidence:80,context:{scope:{clientId:2,audienceId:5}},raw_evidence:{},occurred_at:new Date("2026-01-02"),client_id:2,audience_id:5};

describe("intent evidence review route",()=>{
  beforeEach(()=>{mocks.query.mockReset();mocks.clientQuery.mockReset();mocks.release.mockReset();});

  it("rejects unsafe source URL schemes before persistence",async()=>{
    await request(app).patch("/intent/evidence/4/review").send({reviewStatus:"approved",accountId:8,productId:9,sourceUrl:"javascript:alert(1)"}).expect(400);
    expect(mocks.clientQuery).not.toHaveBeenCalled();
  });

  it("cannot approve pending evidence without account and product assignment",async()=>{
    mocks.clientQuery.mockResolvedValueOnce(result([])).mockResolvedValueOnce(result([pending])).mockResolvedValueOnce(result([]));
    const response=await request(app).patch("/intent/evidence/4/review").send({reviewStatus:"approved"}).expect(400);
    expect(response.body.error).toContain("accountId and productId");
    expect(mocks.clientQuery.mock.calls.some(([sql])=>String(sql).includes("INSERT INTO intent_signals"))).toBe(false);
  });

  it.each([
    "BBC restructures its London and UK operations.",
    "ExxonMobil opens a manufacturing facility in Texas, United States.",
  ])("blocks India approval of foreign source evidence: %s",async(excerpt)=>{
    const row={...pending,evidence_kind:"public_event",account_id:8,product_id:9,
      occurred_at:new Date(),excerpt:"AI suggests a Hyderabad opportunity",
      context:{scope:{country:"India"},opportunityBrief:{whyNow:"India opportunity"}},
      raw_evidence:{excerpt,context:{sourceTitle:excerpt}}};
    mocks.clientQuery.mockResolvedValueOnce(result([])).mockResolvedValueOnce(result([row])).mockResolvedValueOnce(result([]));
    const response=await request(app).patch("/intent/evidence/4/review").send({reviewStatus:"approved"}).expect(400);
    expect(response.body.error).toContain("original source");
    expect(mocks.clientQuery.mock.calls.some(([sql])=>/^\s*(INSERT|UPDATE|DELETE)\b/.test(String(sql)))).toBe(false);
  });

  it("assigns approved evidence and creates a linked deduplicated product signal",async()=>{
    mocks.clientQuery
      .mockResolvedValueOnce(result([])).mockResolvedValueOnce(result([pending]))
      .mockResolvedValueOnce(result([{id:12}]))
      .mockResolvedValueOnce(result([{id:33}]))
      .mockResolvedValueOnce(result([{id:4,signalId:33,accountId:8,productId:9,reviewStatus:"approved"}]))
      .mockResolvedValueOnce(result([]));
    mocks.query.mockResolvedValueOnce(result([{id:9}])).mockResolvedValueOnce(result([{ok:1}]));
    const response=await request(app).patch("/intent/evidence/4/review").send({reviewStatus:"approved",accountId:8,productId:9}).expect(200);
    expect(response.body.evidence).toMatchObject({signalId:33,accountId:8,productId:9,reviewStatus:"approved"});
    const insert=mocks.clientQuery.mock.calls.find(([sql])=>String(sql).includes("INSERT INTO intent_signals"));
    expect(insert?.[1]).toContain("funding:canonical:product:9");
  });

  it("allows approved evidence to be rejected without deleting its linked signal",async()=>{
    const approved={...pending,review_status:"approved",signal_id:33,account_id:8,product_id:9,event_fingerprint:"funding:key"};
    mocks.clientQuery.mockResolvedValueOnce(result([])).mockResolvedValueOnce(result([approved])).mockResolvedValueOnce(result([{id:4,signalId:33,accountId:8,productId:9,reviewStatus:"rejected"}])).mockResolvedValueOnce(result([]));
    const response=await request(app).patch("/intent/evidence/4/review").send({reviewStatus:"rejected"}).expect(200);
    expect(response.body.evidence.reviewStatus).toBe("rejected");
    expect(mocks.clientQuery.mock.calls.some(([sql])=>String(sql).includes("DELETE"))).toBe(false);
  });

  it("reports zero-credential research and enrichment actions unavailable",async()=>{
    // An empty SELECT is a successful query with no rows, not an undefined
    // driver result (the credential store deliberately fails closed on errors).
    mocks.query.mockResolvedValue(result([]));
    const research=await request(app).post("/intent/research/runs").send({provider:"newsapi",rows:[]}).expect(503);
    expect(research.body).toMatchObject({error:"provider_not_configured"});
    const discovery=await request(app).post("/intent/contact-discovery").send({seniorities:[],functions:[],locations:[]}).expect(503);
    expect(discovery.body).toMatchObject({error:"provider_not_configured",providerConfigured:false,candidates:[]});
  });

  it("ingests matched public evidence as pending review, never pre-approved",async()=>{
    mocks.query.mockResolvedValueOnce(result([{id:9}])).mockResolvedValueOnce(result([{ok:1}]));
    mocks.clientQuery
      .mockResolvedValueOnce(result([]))
      .mockResolvedValueOnce(result([]))
      .mockResolvedValueOnce(result([{id:1}]))
      .mockResolvedValueOnce(result([{id:12}]))
      .mockResolvedValueOnce(result([{id:33}]))
      .mockImplementationOnce(async(sql:string,params:any[])=>{
        expect(sql).toContain("INSERT INTO intent_evidence");
        expect(params[13]).toBe("pending_review");
        expect(params[11].scope.country).toBe("India");
        return result([{id:4}]);
      })
      .mockResolvedValueOnce(result([]))
      .mockResolvedValueOnce(result([]));
    await request(app).post("/intent/research/runs").send({rows:[{
      accountId:8,productId:9,eventType:"funding",occurredAt:"2026-01-02T00:00:00.000Z",
      sourceUrl:"https://news.example/event",excerpt:"Funding announced in Hyderabad",confidence:80,
    }]}).expect(201);
  });

  it("defaults omitted-country manual runs to India even if provider metadata says Global",async()=>{
    mocks.query.mockResolvedValue(result([{ok:1,id:9}]));
    mocks.clientQuery.mockImplementation(async(sql:string,params:any[])=>{
      if(sql.startsWith("SELECT id,summary,status"))return result([]);
      if(sql.includes("INSERT INTO intent_evidence")){
        expect(params[1]).toBeNull();
        expect(params[11].scope.country).toBe("India");
        expect(params[13]).toBe("pending_review");
      }
      return result(sql.includes("RETURNING id")?[{id:4}]:[]);
    });
    await request(app).post("/intent/research/runs").send({provider:"manual",rows:[{
      accountId:8,productId:9,eventType:"funding",occurredAt:new Date().toISOString(),
      sourceUrl:"https://news.example/event",excerpt:"BBC announces restructuring in London and the UK.",
      context:{country:"Global"},confidence:80,
    }]}).expect(201);
    expect(mocks.clientQuery.mock.calls.some(([sql])=>String(sql).includes("INSERT INTO intent_signals"))).toBe(false);
  });
});