import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks=vi.hoisted(()=>({query:vi.fn()}));
vi.mock("@workspace/db",()=>({pool:{query:mocks.query},db:{}}));
import { readProductIntentActivity } from "../lib/alwaysOnIntent";

const now=new Date();
const earlier=new Date(now.getTime()-86_400_000);
const signal=(overrides:Record<string,unknown>={})=>({
  account_id:8,source:"public_event",summary:"The India business is expanding its Hyderabad office.",
  occurred_at:earlier,evidence_id:99,has_activity_evidence:false,...overrides,
});
const source=(overrides:Record<string,unknown>={})=>signal({
  has_activity_evidence:true,evidence_excerpt:"India expansion",
  evidence_context:{scope:{country:"India"},aiReview:true},
  raw_evidence:{excerpt:"The India business is expanding in Hyderabad.",context:{}},...overrides,
});

describe("bounded activity source reads",()=>{
  beforeEach(()=>vi.clearAllMocks());
  it("shares a source across products/accounts regardless of row order, keeping each latest signal date",async()=>{
    mocks.query.mockResolvedValue({rows:[
      signal({account_id:9,occurred_at:now}),
      source({account_id:null}),
      signal({occurred_at:now}),
    ]});
    const result=await readProductIntentActivity(7,[1,2],[8,9]);
    expect([...result]).toEqual([[9,now],[8,now]]);
    expect(mocks.query).toHaveBeenCalledTimes(1);
    expect(mocks.query.mock.calls[0][1]).toEqual([7,[1,2],[8,9]]);
    const sql=mocks.query.mock.calls[0][0];
    expect(sql).toContain("UNION ALL");
    expect(sql).toContain("AND review_status='approved'");
    expect(sql).toContain("SELECT DISTINCT payload_evidence_id");
    expect(sql).toContain("GREATEST(linked.approved_id,");
    expect(sql).toContain("linked.review_count=0 OR linked.approved_id IS NOT NULL");
    expect(sql).toContain("s.expires_at IS NULL OR s.expires_at>NOW()");
  });
  it("ignores rewritten India text on foreign original sources without suppressing first-party activity",async()=>{
    mocks.query.mockResolvedValue({rows:[
      signal({occurred_at:now}),
      source({raw_evidence:{excerpt:"The London office plans a UK expansion.",context:{}}}),
      signal({source:"questionnaire",occurred_at:earlier}),
    ]});
    expect((await readProductIntentActivity(7,[1],[8])).get(8)).toEqual(earlier);
  });
  it("does not cache summary fallbacks when evidence has no excerpt",async()=>{
    mocks.query.mockResolvedValue({rows:[
      source({evidence_excerpt:null,evidence_context:{scope:{country:"India"}},
        raw_evidence:{excerpt:null,context:{}},summary:"The London office is expanding.",occurred_at:now}),
      signal({summary:"The Hyderabad office in India is expanding."}),
    ]});
    expect((await readProductIntentActivity(7,[1],[8])).get(8)).toEqual(earlier);
  });
  it("keeps freshness signal-specific and re-reads review/source changes on every call",async()=>{
    mocks.query.mockResolvedValueOnce({rows:[
      signal({summary:"The India office expansion was completed in 2020.",occurred_at:now}),
      source(),
    ]}).mockResolvedValueOnce({rows:[source({raw_evidence:{excerpt:"A UK London expansion.",context:{}}})]});
    expect((await readProductIntentActivity(7,[1],[8])).get(8)).toEqual(earlier);
    expect((await readProductIntentActivity(7,[1],[8])).has(8)).toBe(false);
    expect(mocks.query).toHaveBeenCalledTimes(2);
  });
  it("does not load payloads for empty scopes",async()=>{
    expect((await readProductIntentActivity(7,[],[8])).size).toBe(0);
    expect((await readProductIntentActivity(7,[1],[])).size).toBe(0);
    expect(mocks.query).not.toHaveBeenCalled();
  });
});
