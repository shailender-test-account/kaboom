import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks=vi.hoisted(()=>({
  query:vi.fn(),
  rebuild:vi.fn(),
}));

vi.mock("@workspace/db",()=>({pool:{query:mocks.query},db:{}}));
vi.mock("../lib/researchOpportunityInterpreter",()=>({
  RESEARCH_FITMENT_POLICY_VERSION:6,
  rebuildStoredResearchOpportunityLocally:mocks.rebuild,
  refreshStoredResearchOpportunity:vi.fn(),
}));

import { enqueueOutdatedResearchBriefs, processPolicyRebuildRun } from "../intentResearchRunner";

const run={
  id:77,tenant_id:9,client_id:null,audience_id:null,provider:"local_policy_rebuild" as const,
  request_count:0,confirmed_request_count:0,request_limit:0,
  summary:{maintenance:"brief_policy_rebuild"},
};

describe("research brief policy maintenance",()=>{
  beforeEach(()=>{
    vi.clearAllMocks();
    mocks.rebuild.mockResolvedValue("rebuilt");
  });

  it("detects old briefs globally and enqueues each account in its own tenant",async()=>{
    mocks.query
      .mockResolvedValueOnce({rows:[{tenant_id:4,account_id:41},{tenant_id:8,account_id:82}]})
      .mockResolvedValue({rows:[]});

    await expect(enqueueOutdatedResearchBriefs()).resolves.toBe(2);

    const detection=String(mocks.query.mock.calls[0][0]);
    expect(detection).toContain("DISTINCT ON (e.tenant_id,e.account_id)");
    expect(detection).toContain("approved.tenant_id=latest.tenant_id");
    expect(detection).toContain("maintenance.idempotency_key=$3");
    expect(mocks.query.mock.calls[0][1]).toEqual([6,100,"brief-policy:6"]);
    expect(mocks.query.mock.calls[1][1]).toEqual([4,"local_policy_rebuild","brief-policy:6",6,41]);
    expect(mocks.query.mock.calls[2][1]).toEqual([8,"local_policy_rebuild","brief-policy:6",6,82]);
    expect(String(mocks.query.mock.calls[1][0])).toContain("ON CONFLICT (tenant_id,run_id,account_id) DO NOTHING");
  });

  it("claims a bounded tenant-scoped batch and completes idempotent local rebuilds",async()=>{
    mocks.query
      .mockResolvedValueOnce({rows:[{id:501,account_id:41,attempts:1}]})
      .mockResolvedValueOnce({rows:[]})
      .mockResolvedValueOnce({rows:[{request_count:0,confirmed_request_count:0,request_limit:0}]})
      .mockResolvedValueOnce({rows:[{status:"completed",summary:{outcome:"rebuilt"},error:null}]})
      .mockResolvedValue({rows:[]});

    await processPolicyRebuildRun(run);

    expect(mocks.rebuild).toHaveBeenCalledWith(9,41);
    expect(mocks.query.mock.calls[0][1]).toEqual([9,77,10,4]);
    const completion=mocks.query.mock.calls.find(([sql])=>String(sql).includes("jsonb_build_object('outcome'"));
    expect(completion?.[1]).toEqual(["rebuilt",6,9,77,501]);
  });

  it("persists retry state and stops retrying after the maximum attempt",async()=>{
    mocks.rebuild.mockRejectedValue(new Error("bad stored evidence"));
    mocks.query
      .mockResolvedValueOnce({rows:[{id:501,account_id:41,attempts:5}]})
      .mockResolvedValueOnce({rows:[]})
      .mockResolvedValueOnce({rows:[{request_count:0,confirmed_request_count:0,request_limit:0}]})
      .mockResolvedValueOnce({rows:[{status:"failed",summary:{},error:"bad stored evidence"}]})
      .mockResolvedValue({rows:[]});

    await processPolicyRebuildRun(run);

    const failure=mocks.query.mock.calls.find(([sql])=>String(sql).includes("attempts<$1"));
    expect(failure?.[1]).toEqual([5,"bad stored evidence",9,77,501]);
    expect(String(failure?.[0])).toContain("THEN 'pending' ELSE 'failed'");
  });
});