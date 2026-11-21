import { afterEach, describe, expect, it, vi } from "vitest";
const mocks=vi.hoisted(()=>({query:vi.fn(),release:vi.fn(),write:vi.fn(),mkdir:vi.fn(),end:vi.fn()}));
vi.mock("@workspace/db",()=>({pool:{connect:async()=>({query:mocks.query,release:mocks.release}),end:mocks.end}}));
vi.mock("node:fs",()=>({default:{writeFileSync:mocks.write,mkdirSync:mocks.mkdir}}));
const argv=process.argv;
afterEach(()=>{process.argv=argv;vi.unstubAllEnvs();vi.resetModules();vi.clearAllMocks();});

describe("local research reassessment command",()=>{
  it("exports before/after from a read-only tenant/account snapshot without writes or BI reads",async()=>{
    vi.stubEnv("NODE_ENV","development");
    process.argv=["node","script","9","12","generated-artifacts/review.json"];
    mocks.query.mockImplementation(async(sql:string,params?:unknown[])=>{
      if(sql.includes("FROM companies")) {expect(params).toEqual([9,12]);return {rows:[{name:"BBC",industry:"Media"}]};}
      if(sql.includes("FROM intent_products")) {expect(params).toEqual([9]);return {rows:[{id:1,name:"HP Business Laptops",category:"IT Hardware",categoryId:10,subcategory:null}]};}
      if(sql.includes("FROM intent_evidence")) {expect(params).toEqual([9,12]);return {rows:[{
        id:2,eventType:"hiring",excerpt:"BBC workforce grew by 2,000 people.",productId:1,reviewStatus:"approved",sourceUrl:"https://example.com/india",
        occurredAt:new Date(),confidence:90,context:{aiReview:{catalogProductIds:[1]}},rawEvidence:{excerpt:"BBC will cut 2,000 jobs across India."},
      }]};}
      return {rows:[]};
    });
    const {runResearchReassessment}=await import("../lib/researchReassessmentCommand");
    await runResearchReassessment(process.argv.slice(2));
    const statements=mocks.query.mock.calls.map(([sql])=>sql as string);
    expect(statements[0]).toContain("READ ONLY");
    expect(statements.at(-1)).toBe("ROLLBACK");
    expect(statements.some(sql=>/\b(UPDATE|INSERT|DELETE)\b/.test(sql))).toBe(false);
    expect(statements.some(sql=>/hp_excel|inbound_submissions|order_value|fiscal/i.test(sql))).toBe(false);
    const report=JSON.parse(mocks.write.mock.calls[0][1]);
    expect(report).toMatchObject({applied:false,mode:"preview_only",tenantId:9,accountId:12});
    expect(report.findings[0].proposed).toMatchObject({eventType:"layoffs",fitments:[],removedProductIds:[1]});
    expect(mocks.write.mock.calls[0][2]).toEqual({flag:"wx",mode:0o600});
    expect(mocks.release).toHaveBeenCalledOnce();
  });

  it("refuses production or an apply flag before querying",async()=>{
    vi.stubEnv("NODE_ENV","production");
    process.argv=["node","script","9","12","report.json","--apply"];
    const {runResearchReassessment}=await import("../lib/researchReassessmentCommand");
    await expect(runResearchReassessment(process.argv.slice(2))).rejects.toThrow("preview-only");
    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.write).not.toHaveBeenCalled();
  });
});
