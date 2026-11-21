import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ query: vi.fn(), provider: vi.fn() }));
vi.mock("@workspace/db", () => ({ pool: { query: mocks.query } }));
vi.mock("@replit/connectors-sdk", () => ({
  ReplitConnectors: class { proxy = mocks.provider; listConnections = mocks.provider; },
}));
vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { id: 1, tenantId: 91, role: "admin" };
    next();
  },
}));
import router from "../routes/intentOpportunities";
const app = express().use(router);
afterEach(() => vi.clearAllMocks());

describe("read-only monitored-account quality contract", () => {
  it("scans past an empty first batch before applying readiness pagination and total",async()=>{
    const now=new Date().toISOString();
    const empty=(id:number)=>({id,name:"Acme",clientName:"HP",storedFindingCount:0,findings:[]});
    const ready={...empty(101),storedFindingCount:1,findings:[{
      id:1001,excerpt:"Acme India announced a new Hyderabad office: 600,000 square feet, expected to open in 2027.",
      sourceUrl:"https://example.com/news",occurredAt:now,eventType:null,reviewStatus:"approved",
      context:{publishedDate:now},
    }]};
    mocks.query.mockImplementation(async(sql:string,params:unknown[])=>{
      expect(sql.trim()).toMatch(/^SELECT /);
      if(sql.startsWith("SELECT count(*)"))return{rows:[{total:101}]};
      expect(params[4]).toBe(100);
      return{rows:params[5]===0?Array.from({length:100},(_,index)=>empty(index+1)):[ready]};
    });
    const result=await request(app).get("/intent/opportunities/monitored-accounts?completeResearch=true&pageSize=1").expect(200);
    expect(result.body).toMatchObject({total:1,items:[{id:101}]});
    expect(mocks.query).toHaveBeenCalledTimes(3);
    expect(mocks.provider).not.toHaveBeenCalled();
  });
  it("includes failed-review and historical stored findings, without changing completion or calling providers", async () => {
    const now = new Date();
    const findings = [{
      id: 1, excerpt: "Acme India announced a new Hyderabad office.", sourceUrl: "https://example.com/news",
      occurredAt: now.toISOString(), eventType: null, reviewStatus: "rejected", context: {},
    }, {
      id: 2, excerpt: "Acme India announced a new Hyderabad office.", sourceUrl: "https://example.com/old",
      occurredAt: "2020-01-01", eventType: null, reviewStatus: "approved", context: {},
    }];
    const account = { id: 7, name: "Acme", domain: null, clientId: 3, clientName: "HP",
      latestRunStatus: "completed", lastResearchedAt: now.toISOString(), hasInbound: false,
      storedFindingCount: 130, findings };
    const snapshot = structuredClone(account);
    mocks.query.mockImplementation(async (sql: string, params: unknown[]) => {
      const normalized = sql.replace(/\s+/g, " ").trim();
      expect(normalized).toMatch(/^SELECT /);
      expect(params.slice(0, 4)).toEqual([91, 3, "", 7]);
      if (normalized.startsWith("SELECT count(*)::int AS total FROM companies")) return { rows: [{ total: 1 }] };
      if (normalized.startsWith("SELECT c.id,c.name,c.domain")) {
        expect(normalized).toContain("LIMIT 100");
        expect(normalized).toContain('AS "storedFindingCount"');
        expect(normalized).not.toContain("e.review_status='approved'");
        expect(normalized).not.toContain("e.occurred_at BETWEEN");
        expect(normalized).toContain("e.tenant_id=c.tenant_id AND e.account_id=c.id");
        return { rows: [account] };
      }
      throw new Error("Unexpected diagnostic query");
    });
    for (let read = 0; read < 2; read++) {
      const response = await request(app).get("/intent/opportunities/monitored-accounts?clientId=3&accountId=7").expect(200);
      expect(response.body.items[0]).toMatchObject({
        latestRunStatus: "completed", lastResearchedAt: now.toISOString(), hasInbound: false, latestSignal: null,
        researchContext: {
          kind: "no_recent_findings", evidence: [], possibleNeeds: [],
          diagnostics: { assessedCount: 2, usableCount: 0, excludedCount: 2, storedFindingCount: 130, truncated: true,
            exclusions: [{ reason: "not_approved", count: 1 }, { reason: "stale_date", count: 1 }] },
        },
      });
    }
    expect(account).toEqual(snapshot);
    expect(mocks.query).toHaveBeenCalledTimes(4);
    expect(mocks.provider).not.toHaveBeenCalled();
  });
});
