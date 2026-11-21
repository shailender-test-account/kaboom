import {describe,it,expect} from "vitest";
import {hasCompleteMonitoredResearch,monitoredAccountContext} from "./monitoredAccountContext";

const complete=()=>({
  ...monitoredAccountContext([]),
  kind:"business_context" as const,
  evidence:[{id:1,summary:"Account-specific business news.",sourceUrl:"https://example.com/news",occurredAt:new Date().toISOString(),publishedAt:null}],
  businessDirections:[{theme:"Expansion",signal:"New site announced.",direction:"Deployment capacity may need to scale.",evidenceIds:[1]}],
  takeaways:[{category:"IT Hardware",product:"HP devices",takeaway:"A new site may require endpoints.",recommendation:"Validate affected roles before proposing devices.",evidenceIds:[1]}],
});

describe("dashboard research readiness",()=>{
  it("requires usable news, interpretation and recommendation together",()=>{
    expect(hasCompleteMonitoredResearch(complete())).toBe(true);
    expect(hasCompleteMonitoredResearch({...complete(),evidence:[]})).toBe(false);
    expect(hasCompleteMonitoredResearch({...complete(),businessDirections:[]})).toBe(false);
    expect(hasCompleteMonitoredResearch({...complete(),takeaways:[]})).toBe(false);
    expect(hasCompleteMonitoredResearch(monitoredAccountContext([]))).toBe(false);
  });
  it("requires citations to the displayed usable news, not unrelated evidence",()=>{
    const item=complete();
    expect(hasCompleteMonitoredResearch({...item,businessDirections:[{...item.businessDirections[0],evidenceIds:[999]}]})).toBe(false);
    expect(hasCompleteMonitoredResearch({...item,takeaways:[{...item.takeaways[0],evidenceIds:[999]}]})).toBe(false);
    expect(hasCompleteMonitoredResearch({...item,evidence:[{...item.evidence[0],sourceUrl:""}]})).toBe(false);
  });
});
