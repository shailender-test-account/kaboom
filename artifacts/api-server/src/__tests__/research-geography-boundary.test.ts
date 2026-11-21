import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ query: vi.fn(), connect: vi.fn(), clientQuery: vi.fn() }));
vi.mock("@workspace/db", () => ({ pool: { query: mocks.query, connect: mocks.connect }, db: {} }));
vi.mock("../lib/alwaysOnIntent", async importOriginal => ({
  ...await importOriginal<typeof import("../lib/alwaysOnIntent")>(),
  ensureIntentDefaults: vi.fn(),
}));
import { isIndiaCentricEvidence, isResearchGeographyEligible } from "../lib/researchGeography";
import { autoReviewPendingResearch } from "../lib/researchEvidenceAutoReview";
import { interpretResearchOpportunity, rebuildResearchOpportunityLocally, refreshStoredResearchOpportunity } from "../lib/researchOpportunityInterpreter";
import { evaluateTwoLevelIntentStatus } from "../lib/twoLevelIntentStatus";
import type { ProviderEvent } from "../lib/intentProviders";

const bbc = "BBC announces restructuring and cuts at its London and UK operations.";
const exxon = "ExxonMobil announces a new manufacturing facility and 500 jobs in Texas, United States.";
const hyderabad = "Office Co announces a new Hyderabad office for 500 employees with a laptop deployment.";
const officeUk = "Office Co announces restructuring and cuts at its London and UK operations.";
const officeUs = "Office Co announces a new manufacturing facility and 500 jobs in Texas, United States.";
function event(excerpt: string, country = "India"): ProviderEvent {
  return { eventType: "branch_opening", excerpt, occurredAt: new Date().toISOString(), confidence: 90,
    sourceUrl: "https://example.com/news", context: { scope: { country }, query: "India expansion" } };
}
const catalog = [{ id: 1, name: "Business laptop", categoryId: 1, category: "IT Hardware", subcategory: null }];

describe("source-only research geography boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT name,domain")) return { rows: [{ name: "BBC", domain: "bbc.com" }] };
      if (sql.includes("SELECT p.id")) return { rows: catalog };
      return { rows: [] };
    });
  });
  it.each([bbc, exxon])("blocks foreign activity despite nested India metadata: %s", async excerpt => {
    const row = event(excerpt);
    row.context = { ...row.context, location: "India", companyName: "India account",
      opportunityBrief: { whyNow: "India opportunity" }, aiReview: { rationale: "Hyderabad demand" },
      rawEvent: { company: { country: "India" }, query: "India", metadata: { market: "India" } },
      originalExcerpt: excerpt };
    expect(isIndiaCentricEvidence(row)).toBe(false);
    expect(isResearchGeographyEligible(row)).toBe(false);
    expect(await interpretResearchOpportunity(7, { name: "BBC India" }, [row], "India")).toBeNull();
    expect(mocks.query).not.toHaveBeenCalled();
    expect(rebuildResearchOpportunityLocally({ company: { name: "BBC India" }, evidence: [row],
      catalog, firstParty: [], storedBrief: { whyNow: "India" } })).toBeNull();
    expect(evaluateTwoLevelIntentStatus([{ id: 1, evidenceKind: "public_event", eventType: row.eventType,
      excerpt, sourceUrl: row.sourceUrl!, occurredAt: row.occurredAt, confidence: 90,
      reviewStatus: "approved", context: row.context }]).accountStatus).toBe("cold");
  });
  it("cannot replace original UK text with an AI-generated Hyderabad claim", () => {
    expect(isIndiaCentricEvidence({ excerpt: hyderabad, context: { sourceTitle: "India opportunity" },
      raw_evidence: { excerpt: bbc, context: { sourceTitle: "BBC UK restructuring" } } })).toBe(false);
    expect(isIndiaCentricEvidence({ excerpt: "India Co opened a London office.", companyName: "India Co" })).toBe(false);
  });
  it("allows the Hyderabad announcement, including explicit structured event location", () => {
    expect(isResearchGeographyEligible(event(hyderabad))).toBe(true);
    expect(isIndiaCentricEvidence({ excerpt: "The company announces a new office.",
      context: { rawEvent: { data: { city: "Hyderabad" } } } })).toBe(true);
    expect(rebuildResearchOpportunityLocally({ company: { name: "Office Co" },
      evidence: [event(hyderabad)], catalog, firstParty: [], storedBrief: null })?.sourceUrls)
      .toEqual(["https://example.com/news"]);
  });
  it("retains Global-mode interpretation of BBC and ExxonMobil events", () => {
    for (const excerpt of [bbc, exxon]) {
      const row = event(excerpt, "Global");
      expect(isResearchGeographyEligible(row)).toBe(true);
      expect(rebuildResearchOpportunityLocally({ company: { name: "Global Co" },
        evidence: [row], catalog, firstParty: [], storedBrief: null })).not.toBeNull();
    }
  });

  it("stores a mixed-source India brief on the eligible row, never the newer foreign row",async()=>{
    vi.stubEnv("OPENAI_API_KEY","");
    vi.stubEnv("AI_INTEGRATIONS_OPENAI_API_KEY","");
    mocks.connect.mockResolvedValue({query:mocks.clientQuery,release:vi.fn()});
    mocks.clientQuery.mockImplementation(async(sql:string)=>{
      if(sql.includes("SELECT name,domain,industry"))return {rows:[{name:"Office Co",domain:"office.example",industry:null}]};
      if(sql.includes("FROM intent_evidence"))return {rows:[
        {id:102,event_type:"branch_opening",occurred_at:new Date(),source_url:"https://example.com/foreign",
          excerpt:bbc,confidence:80,context:{scope:{country:"India"}},raw_evidence:{excerpt:bbc,context:{}},reviewed_by:null},
        {id:101,event_type:"branch_opening",occurred_at:new Date(),source_url:"https://example.com/news",
          excerpt:hyderabad,confidence:80,context:{scope:{country:"India"}},raw_evidence:{excerpt:hyderabad,context:{}},reviewed_by:null},
      ]};
      return {rows:[]};
    });
    try{
      const brief=await refreshStoredResearchOpportunity(7,8,"India");
      expect(brief).toMatchObject({geographyPolicyVersion:1,sourceUrls:["https://example.com/news"]});
      const update=mocks.clientQuery.mock.calls.find(([sql])=>String(sql).startsWith("UPDATE intent_evidence"));
      expect(update?.[1]?.slice(1)).toEqual([7,8,101]);
      expect(String(update?.[0])).not.toContain("SELECT id");
    }finally{vi.unstubAllEnvs();}
  });
  it("leaves out-of-market automated reviews pending without calling AI or writing signals", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-key-not-used");
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT name,domain")) return { rows: [{ name: "BBC", domain: "bbc.com" }] };
      if (sql.includes("FROM intent_evidence")) return { rows: [
        { id: 1, event_type: "layoffs", excerpt: bbc, occurred_at: new Date(), context: { scope: { country: "India" } } },
        { id: 2, event_type: "branch_opening", excerpt: exxon, occurred_at: new Date(), context: { country: "India" } },
      ] };
      return { rows: catalog };
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      expect(await autoReviewPendingResearch(7, 1)).toEqual({ reviewed: 0, approved: 0, rejected: 0, pending: 2 });
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(mocks.connect).not.toHaveBeenCalled();
    } finally { fetchSpy.mockRestore(); vi.unstubAllEnvs(); }
  });

  it.each([["India", 1, 2], ["Global", 3, 0]] as const)(
    "reviews only eligible sources in %s mode even when AI review fails", async (country, reviewed, pending) => {
      vi.stubEnv("OPENAI_API_KEY", "test-key-not-used");
      // All three belong to this account; geography is the boundary under test.
      const sources = [officeUk, officeUs, hyderabad];
      mocks.query.mockImplementation(async (sql: string) => {
        if (sql.includes("SELECT name,domain")) return { rows: [{ name: "Office Co", domain: "office.example" }] };
        if (sql.includes("FROM intent_evidence")) return { rows: sources.map((excerpt, index) => ({
          id: index + 1, event_type: "branch_opening", excerpt, source_url: "https://example.com/news",
          occurred_at: new Date(), context: { scope: { country } },
        })) };
        return { rows: catalog };
      });
      mocks.connect.mockResolvedValue({ query: mocks.clientQuery, release: vi.fn() });
      mocks.clientQuery.mockImplementation(async (sql: string) =>
        ({ rows: sql.startsWith("SELECT id") || sql.includes("RETURNING id") ? [{ id: 99 }] : [] }));
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Simulated provider failure"));
      try {
        expect(await autoReviewPendingResearch(7, 1)).toMatchObject({ reviewed, approved: reviewed, pending });
        const prompt = JSON.parse(String(fetchSpy.mock.calls[0][1]?.body)).messages[1].content;
        expect(prompt.includes(officeUk)).toBe(country === "Global");
        expect(prompt.includes(officeUs)).toBe(country === "Global");
        expect(prompt).toContain(hyderabad);
        const updated = mocks.clientQuery.mock.calls.filter(([sql]) => /^\s*UPDATE intent_evidence/.test(String(sql)));
        expect(updated).toHaveLength(reviewed);
        expect(updated.every(([, params]) => params[5] === "approved")).toBe(true);
      } finally { fetchSpy.mockRestore(); vi.unstubAllEnvs(); }
    },
  );

  it("reviews an older India record behind more retained foreign records than the batch limit",async()=>{
    vi.stubEnv("OPENAI_API_KEY","test-key-not-used");
    mocks.query.mockImplementation(async(sql:string)=>{
      if(sql.includes("SELECT name,domain"))return {rows:[{name:"Office Co",domain:"office.example"}]};
      if(sql.includes("FROM intent_evidence"))return {rows:[...Array.from({length:50},(_,id)=>({
        id:id+1,event_type:"branch_opening",excerpt:bbc,occurred_at:new Date(),context:{country:"India"},
      })),{id:51,event_type:"branch_opening",excerpt:hyderabad,occurred_at:new Date(),context:{country:"India"}}]};
      return {rows:catalog};
    });
    mocks.connect.mockResolvedValue({query:mocks.clientQuery,release:vi.fn()});
    mocks.clientQuery.mockResolvedValue({rows:[{id:99}]});
    const fetchSpy=vi.spyOn(globalThis,"fetch").mockRejectedValue(new Error("Simulated provider failure"));
    try{
      expect(await autoReviewPendingResearch(7,8,1)).toMatchObject({reviewed:1,approved:1,pending:50});
      const update=mocks.clientQuery.mock.calls.find(([sql])=>/^\s*UPDATE intent_evidence/.test(String(sql)));
      expect(update?.[1]?.[8]).toBe(51);
      const pendingRead=mocks.query.mock.calls.find(([sql])=>String(sql).includes("FROM intent_evidence"));
      expect(String(pendingRead?.[0])).not.toContain("LIMIT");
    }finally{fetchSpy.mockRestore();vi.unstubAllEnvs();}
  });
});
