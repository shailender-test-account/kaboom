import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks=vi.hoisted(()=>({query:vi.fn(),connect:vi.fn(),clientQuery:vi.fn(),release:vi.fn()}));
vi.mock("@workspace/db",()=>({pool:{query:mocks.query,connect:mocks.connect},db:{}}));

import { backfillStoredResearchOpportunities, RESEARCH_FITMENT_POLICY_VERSION } from "../lib/researchOpportunityInterpreter";

const oldBrief={fitmentPolicyVersion:5,categoryConclusions:[]};

describe("stored research brief backfill persistence",()=>{
  beforeEach(()=>{
    vi.clearAllMocks();
    mocks.connect.mockResolvedValue({query:mocks.clientQuery,release:mocks.release});
    mocks.query.mockResolvedValue({rows:[{accountId:41}]});
  });

  it("uses tenant-scoped approved evidence and persists the current policy once",async()=>{
    mocks.clientQuery.mockImplementation(async(sql:string)=>{
       if(sql.startsWith("SELECT name,domain,industry"))return {rows:[{name:"India Co",domain:"indiaco.example",industry:"Textiles"}]};
      if(sql.includes("SELECT event_type,occurred_at,source_url"))return {rows:[{
        id:99,event_type:"quarterly_financial",occurred_at:new Date("2026-09-01"),source_url:"https://example.com/india",
        excerpt:"India Co reduced packaging and label production costs in India.",confidence:90,context:{location:"India"},
      }]};
      if(sql.includes("SELECT p.id,p.name,c.id"))return {rows:[{id:1,name:"Printer",categoryId:10,category:"Commercial Printing",subcategory:null}]};
      if(sql.includes("SELECT e.event_type AS"))return {rows:[]};
      if(sql.includes("context->'opportunityBrief' AS brief"))return {rows:[{id:99,brief:oldBrief}]};
      return {rows:[],rowCount:1};
    });
    const result=await backfillStoredResearchOpportunities(7,25);
    expect(result).toMatchObject({eligible:1,rebuilt:1,skipped:0,failed:0,accountIds:[41]});
    expect(mocks.query.mock.calls[0][1]).toEqual([7,RESEARCH_FITMENT_POLICY_VERSION,25]);
    const approvedEvidenceCall=mocks.clientQuery.mock.calls.find(([sql])=>String(sql).includes("SELECT event_type,occurred_at,source_url"));
    expect(approvedEvidenceCall?.[1]).toEqual([7,41]);
    expect(String(approvedEvidenceCall?.[0])).toContain("review_status='approved'");
    const update=mocks.clientQuery.mock.calls.find(([sql])=>String(sql).startsWith("UPDATE intent_evidence"));
    expect(String(update?.[0])).toContain("'policyVersion',$2::int");
    expect(update?.[1]?.slice(1)).toEqual([RESEARCH_FITMENT_POLICY_VERSION,7,99]);
    expect(mocks.release).toHaveBeenCalledOnce();
  });

  it("is idempotent when another worker has already rebuilt the brief",async()=>{
    mocks.clientQuery.mockImplementation(async(sql:string)=>{
       if(sql.startsWith("SELECT name,domain,industry"))return {rows:[{name:"India Co",domain:"indiaco.example",industry:"Textiles"}]};
      if(sql.includes("context->'opportunityBrief' AS brief"))return {rows:[{id:99,brief:{fitmentPolicyVersion:RESEARCH_FITMENT_POLICY_VERSION}}]};
      return {rows:[]};
    });
    const result=await backfillStoredResearchOpportunities(7,25);
    expect(result).toMatchObject({rebuilt:0,skipped:1,failed:0});
    expect(mocks.clientQuery.mock.calls.some(([sql])=>String(sql).startsWith("UPDATE intent_evidence"))).toBe(false);
  });

  it("filters policy version after selecting each account's latest brief so repeated batches advance",async()=>{
    mocks.query
      .mockResolvedValueOnce({rows:[{accountId:41}]})
      .mockResolvedValueOnce({rows:[{accountId:42}]});
    let activeAccount=41;
    mocks.clientQuery.mockImplementation(async(sql:string,params?:unknown[])=>{
       if(sql.startsWith("SELECT name,domain,industry")){activeAccount=Number(params?.[1]);return {rows:[{name:`India Co ${activeAccount}`,domain:"indiaco.example",industry:"Textiles"}]};}
      if(sql.includes("SELECT event_type,occurred_at,source_url"))return {rows:[{
        id:activeAccount+100,event_type:"quarterly_financial",occurred_at:new Date("2026-09-01"),source_url:`https://example.com/india-${activeAccount}`,
        excerpt:`India Co ${activeAccount} reduced packaging and label production costs in India.`,confidence:90,context:{location:"India"},
      }]};
      if(sql.includes("SELECT p.id,p.name,c.id"))return {rows:[{id:1,name:"Printer",categoryId:10,category:"Commercial Printing",subcategory:null}]};
      if(sql.includes("SELECT e.event_type AS"))return {rows:[]};
      if(sql.includes("context->'opportunityBrief' AS brief"))return {rows:[{id:activeAccount+100,brief:oldBrief}]};
      return {rows:[],rowCount:1};
    });
    const first=await backfillStoredResearchOpportunities(7,1);
    const second=await backfillStoredResearchOpportunities(7,1);
    expect(first.accountIds).toEqual([41]);
    expect(second.accountIds).toEqual([42]);
    const candidateSql=String(mocks.query.mock.calls[0][0]);
    expect(candidateSql).toContain("WITH latest_briefs AS");
    expect(candidateSql.indexOf("DISTINCT ON")).toBeLessThan(candidateSql.indexOf("latest.brief->>'fitmentPolicyVersion'"));
    expect(candidateSql).toContain("approved.tenant_id=$1");
  });
});
