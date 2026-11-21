import {beforeEach,describe,expect,it,vi} from "vitest";
import AdmZip from "adm-zip";
import * as XLSX from "xlsx";

const mocks=vi.hoisted(()=>({
  query:vi.fn(),
  connect:vi.fn(),
  clientQuery:vi.fn(),
  release:vi.fn(),
  proxy:vi.fn(),
}));
vi.mock("@workspace/db",()=>({pool:{query:mocks.query,connect:mocks.connect},db:{}}));
vi.mock("@replit/connectors-sdk",()=>({ReplitConnectors:class{proxy=mocks.proxy;}}));
vi.mock("../services/queue",()=>({enqueueStep:vi.fn(),isTenantQueueAvailable:vi.fn(async()=>false)}));
// These non-HP routing fixtures isolate their legacy SQL adapter. Real HP
// person-level heat admission and delivery are covered by HP integration tests.
vi.mock("../lib/hpNurturePolicy",async importOriginal=>({
  ...await importOriginal<typeof import("../lib/hpNurturePolicy")>(),
  hpContactMayNurture:vi.fn(async()=>true),
}));
// These existing isolated Drive fixtures are not HP BI sources. Their mock
// pool intentionally has no clients table; keep the HP-specific hook disabled
// here while the dedicated HP integration suite tests the real client lookup.
vi.mock("../lib/hpBiImport", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/hpBiImport")>();
  return { ...actual, isHpClient: vi.fn(async () => null) };
});

import {
  canonicalizeInbound,classifyInbound,driveFolderId,groupInboundAffinityCohorts,groupInboundCategoryCohorts,groupInboundRuleCohorts,groupUnconfiguredInboundAffinities,hasInboundCompanyMapping,matchingInboundRoutingRule,parseInboundRows,routeInboundRespondent,routePendingWarmSubmissions,
  MissingInboundCompanyMappingError,parsePurchaseTimeframeMonths,previewInboundSource,repairInboundProductInterestClassifications,summarizeEventFeedback,syncInboundSource,
} from "../lib/inboundAccounts";
import {groupInboundRespondents} from "../lib/inboundRespondents";
import {getInboundContactPage,getInboundDashboard,inboundProductOptionsFromRows} from "../lib/inboundDashboard";
import {applyAccountCategoryReviews} from "../lib/inboundTaxonomy";

const result=(rows:any[])=>({rows,rowCount:rows.length});

describe("inbound account qualification",()=>{
  beforeEach(()=>{
    vi.clearAllMocks();
    mocks.connect.mockResolvedValue({query:mocks.clientQuery,release:mocks.release});
  });
  it("gives saved inbound categories identical precedence in worker and dashboard shapes",()=>{
    const broad={id:1,client_id:8,match_type:"category" as const,classification:"all" as const,
      keywords:["HP Proactive Insights"],journey_id:39,sequence_id:15,
      product_name:null,category_name:"Legacy services"};
    const category={...broad,id:2,keywords:[],category_name:null,inbound_category_name:"Business Services"};
    const worker=[broad,category];
    const dashboard=[broad,{...category,category_name:"Business Services"}];
    const reviews={__categoryOverrides:{"HP Proactive Insights":"Business Services"}};
    expect(matchingInboundRoutingRule(worker,8,"HP Proactive Insights","warm",[],reviews)?.id).toBe(2);
    expect(matchingInboundRoutingRule(dashboard,8,"HP Proactive Insights","warm",[],reviews)?.id).toBe(2);
  });
  it("does not silently broaden Warm-only routes to Hot responses or other clients",()=>{
    const warm={id:1,client_id:8,match_type:"product" as const,classification:"warm" as const,
      keywords:[],journey_id:39,sequence_id:15,product_name:null,category_name:null,
      inbound_product_name:"HP Proactive Insights",inbound_category_name:"Business Services"};
    const reviews={__categoryOverrides:{"HP Proactive Insights":"Business Services"}};
    expect(matchingInboundRoutingRule([warm],8,"HP Proactive Insights","warm",[],reviews)?.id).toBe(1);
    expect(matchingInboundRoutingRule([warm],8,"HP Proactive Insights","hot",[],reviews)).toBeUndefined();
    expect(matchingInboundRoutingRule([{...warm,classification:"all"}],8,"HP Proactive Insights","hot",[],reviews)).toBeUndefined();
    expect(matchingInboundRoutingRule([{...warm,classification:"all"}],9,"HP Proactive Insights","hot",[],reviews)).toBeUndefined();
  });
  it("removes an account from Needs categorization when a duplicate response has a saved category",async()=>{
    const rows=[
      {submissionId:1,accountId:10,clientId:8,accountName:"Acme",contactId:21,
        productAffinity:"HP Proactive Insights",classification:"hot" as const,routingStatus:"pending",affinityReviews:{},updatedAt:new Date("2026-09-23")},
      {submissionId:2,accountId:10,clientId:8,accountName:"Acme",contactId:22,
        productAffinity:"HP Proactive Insights",classification:"hot" as const,routingStatus:"pending",
        affinityReviews:{__categoryOverrides:{"HP Proactive Insights":"Business Services"}},updatedAt:new Date("2026-09-26")},
      {submissionId:3,accountId:11,clientId:8,accountName:"Beta",contactId:23,
        productAffinity:"HP Proactive Insights",classification:"warm" as const,routingStatus:"pending",affinityReviews:{},updatedAt:new Date("2026-09-23")},
    ];
    mocks.query.mockImplementation(async(statement:string)=>
      result(statement.includes("intent_inbound_category_rules")?[]:rows));
    const dashboard=await getInboundDashboard(7,{dateRange:30,formType:"event_feedback"});
    expect(dashboard.cohorts.find(cohort=>cohort.categoryName==="Needs categorization")?.accounts)
      .toEqual([{id:11,name:"Beta"}]);
    expect(dashboard.cohorts.find(cohort=>cohort.categoryName==="Business Services")?.accounts)
      .toEqual([{id:10,name:"Acme"}]);
    const reviewed=applyAccountCategoryReviews(rows);
    expect(reviewed[0].affinityReviews).toMatchObject({__categoryOverrides:{"HP Proactive Insights":"Business Services"}});
    expect(reviewed[2].affinityReviews).toEqual({});
  });
  it("applies date, source type, and category to the same dashboard account set",async()=>{
    mocks.query.mockImplementation(async (statement:string)=>statement.includes("GROUP BY account_id")
      ?result([{account_id:10,classification:"hot"},{account_id:11,classification:"warm"}])
      :statement.includes("intent_inbound_category_rules")
      ?result([]):result([
      {submissionId:1,clientId:8,accountId:10,accountName:"Acme",contactId:21,
        productAffinity:"HP Wolf Security",classification:"hot",routingStatus:"pending",affinityReviews:{}},
      {submissionId:2,clientId:8,accountId:10,accountName:"Acme",contactId:22,
        productAffinity:"HP Managed Device Services",classification:"warm",routingStatus:"routed",affinityReviews:{}},
      {submissionId:3,clientId:8,accountId:11,accountName:"Beta",contactId:23,
        productAffinity:"HP Wolf Security",classification:"warm",routingStatus:"routed",affinityReviews:{}},
    ]));
    const dashboard=await getInboundDashboard(7,{dateRange:30,formType:"lead_form",category:"Security"});
    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining("intent_inbound_submissions"),[7,"lead_form",30,null]);
    expect(dashboard.summary).toEqual({accounts:2,hot:1,warm:1,cold:0,contacts:2});
    expect(dashboard.submissionIds).toEqual([1,3]);
    expect(dashboard.cohorts.map(cohort=>cohort.categoryName)).toEqual(["Security","Security"]);
  });
  it("explains why Warm response cohorts can exceed the exclusive Warm account summary",async()=>{
    const rows=[
      {submissionId:1,clientId:8,accountId:10,accountName:"Acme",contactId:21,
        productAffinity:"HP Anyware Services",classification:"warm",routingStatus:"routed",affinityReviews:{}},
      {submissionId:2,clientId:8,accountId:10,accountName:"Acme",contactId:21,
        productAffinity:"HP Anyware Services",classification:"warm",routingStatus:"routed",affinityReviews:{}},
      {submissionId:3,clientId:8,accountId:11,accountName:"Beta",contactId:22,
        productAffinity:"HP Anyware Services",classification:"warm",routingStatus:"error",affinityReviews:{}},
    ];
    mocks.query.mockImplementation(async(statement:string)=>
      statement.includes("GROUP BY account_id")
        ?result([{account_id:10,classification:"hot"},{account_id:11,classification:"warm"}])
        :result(statement.includes("intent_inbound_category_rules")?[]:rows));
    const dashboard=await getInboundDashboard(7,{formType:"event_feedback"});
    expect(dashboard.summary).toMatchObject({hot:1,warm:1});
    expect(dashboard.cohorts.find(cohort=>cohort.categoryName==="Business Services")).toMatchObject({
      classification:"warm",accountCount:2,alsoHotCount:1,routed:2,failed:1,
      accounts:[
        {id:10,name:"Acme",alsoHotOverall:true},
        {id:11,name:"Beta",failed:true},
      ],
    });
  });
  it("filters the dashboard to No Category without including unclear or rejected product answers",async()=>{
    mocks.query.mockImplementation(async(statement:string)=>statement.includes("intent_inbound_category_rules")
      ?result([]):result([
        {submissionId:1,clientId:8,accountId:10,accountName:"Acme",contactId:21,
          productAffinity:null,classification:"cold",routingStatus:"pending",affinityReviews:{}},
        {submissionId:2,clientId:8,accountId:11,accountName:"Beta",contactId:22,
          productAffinity:"N/A",classification:"cold",routingStatus:"pending",affinityReviews:{}},
        {submissionId:3,clientId:8,accountId:12,accountName:"Gamma",contactId:23,
          productAffinity:"Unrecognized product",classification:"warm",routingStatus:"pending",affinityReviews:{}},
        {submissionId:4,clientId:8,accountId:13,accountName:"Delta",contactId:24,
          productAffinity:"HP Wolf Security",classification:"warm",routingStatus:"pending",
          affinityReviews:{"HP Wolf Security":"rejected"}},
      ]));
    const dashboard=await getInboundDashboard(7,{category:"No Category"});
    expect(dashboard.submissionIds).toEqual([1,2]);
    expect(dashboard.cohorts).toMatchObject([{categoryName:"No Category",accountCount:2}]);
  });
  it("moves an individually categorized blank response to the selected cohort",async()=>{
    const rows=[
      {submissionId:1,clientId:8,accountId:10,accountName:"Acme",contactId:21,
        productAffinity:null,classification:"warm" as const,routingStatus:"routed",affinityReviews:{__missingCategory:"Security"}},
      {submissionId:2,clientId:8,accountId:11,accountName:"Beta",contactId:22,
        productAffinity:"N/A",classification:"hot" as const,routingStatus:"pending",affinityReviews:{}},
    ];
    mocks.query.mockImplementation(async(statement:string)=>result(
      statement.includes("intent_inbound_category_rules")?[]:rows));
    const all=await getInboundDashboard(7,{});
    expect(all.cohorts.find(cohort=>cohort.categoryName==="Security")).toMatchObject({
      classification:"warm",accounts:[{id:10,name:"Acme"}],routed:1,
    });
    expect(all.cohorts.find(cohort=>cohort.categoryName==="No Category")).toMatchObject({
      classification:"hot",accounts:[{id:11,name:"Beta"}],
    });
    expect((await getInboundDashboard(7,{category:"Security"})).submissionIds).toEqual([1]);
    expect((await getInboundDashboard(7,{category:"No Category"})).submissionIds).toEqual([2]);
    const categorizedRule={id:31,client_id:8,match_type:"category" as const,classification:"all" as const,
      inbound_category_name:"Security",category_name:null,keywords:[],journey_id:14,sequence_id:19,product_name:null};
    const noCategoryRule={...categorizedRule,id:32,inbound_category_name:"No Category"};
    expect(matchingInboundRoutingRule([noCategoryRule,categorizedRule],8,"","warm",[],rows[0].affinityReviews)?.id).toBe(31);
    expect(matchingInboundRoutingRule([noCategoryRule,categorizedRule],8,"","warm")?.id).toBe(32);
  });
  it("pages the distinct contacts behind the dashboard total with the same submission filter",async()=>{
    mocks.query.mockImplementation(async (statement:string)=>{
      if(statement.includes("intent_inbound_category_rules"))return result([]);
      if(statement.includes("SELECT DISTINCT ON (s.contact_id)"))return result([{
        id:21,name:"Alex Example",email:"alex@example.test",phone:null,title:"IT",
        accountId:10,accountName:"Acme",
      }]);
      return result([
        {submissionId:1,clientId:8,accountId:10,accountName:"Acme",contactId:21,
          productAffinity:"HP Wolf Security",classification:"hot",routingStatus:"pending",affinityReviews:{}},
        {submissionId:2,clientId:8,accountId:10,accountName:"Acme",contactId:22,
          productAffinity:"HP Managed Device Services",classification:"warm",routingStatus:"routed",affinityReviews:{}},
        {submissionId:3,clientId:8,accountId:11,accountName:"Beta",contactId:23,
          productAffinity:"HP Wolf Security",classification:"warm",routingStatus:"routed",affinityReviews:{}},
      ]);
    });
    const page=await getInboundContactPage(7,{dateRange:30,formType:"lead_form",category:"Security"},1,1);
    expect(page).toMatchObject({total:2,totalPages:2,page:1,pageSize:1,
      contacts:[{id:21,accountId:10,name:"Alex Example"}]});
    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining("SELECT DISTINCT ON (s.contact_id)"),[7,[1,3],1,0]);
  });
  it("scopes a dashboard and account tiers to one source rather than other source history",async()=>{
    mocks.query.mockImplementation(async(statement:string,params:any[]=[])=>
      statement.includes("intent_inbound_category_rules")?result([])
      :statement.includes("GROUP BY account_id")?result([{account_id:10,classification:"cold"}])
      :result([
        {submissionId:101,clientId:8,accountId:10,accountName:"Acme",contactId:21,
          productAffinity:"HP Wolf Security",classification:"cold",routingStatus:"pending",affinityReviews:{}},
      ]));
    const dashboard=await getInboundDashboard(7,{sourceId:42});
    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining("s.source_id=$4"),[7,null,null,42]);
    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining("AND ($3::int IS NULL OR source_id=$3)"),[7,[10],42]);
    expect(dashboard.submissionIds).toEqual([101]);
    expect(dashboard.summary.hot).toBe(0);
    expect(dashboard.summary.cold).toBe(1);
  });
  it("uses selected product and the three-month upper bound, not respondent seniority, to label Hot",()=>{
    expect(classifyInbound({productInterest:"HP Security Services",timeframe:"0-3 months",title:"IT Analyst"})).toMatchObject({
      classification:"hot",explicitInterest:true,purchaseTimeframeMonths:3,isDecisionMaker:false,
    });
    expect(classifyInbound({productInterest:"HP Security Services",timeframe:"6-12 months",title:"CIO"})).toMatchObject({
      classification:"cold",purchaseTimeframeMonths:12,
    });
    expect(classifyInbound({interest:"Wants to buy",timeframe:"within 3 months",title:"IT Director"}).classification).toBe("cold");
    for (const [timeframe, status] of [
      ["immediately", "hot"], ["3 months", "hot"], ["3.1 months", "warm"],
      ["4 months", "warm"], ["6 months", "warm"], ["6.1 months", "cold"],
      ["7 months", "cold"], ["", "cold"], ["not sure", "cold"],
    ] as const) expect(classifyInbound({productInterest:"HP Security Services",timeframe}).classification).toBe(status);
  });
  it("treats a selected product or service as explicit interest",()=>{
    expect(classifyInbound({productInterest:"HP Anyware Services",timeframe:"within 3 months",title:"Director IT"})).toMatchObject({
      classification:"hot",explicitInterest:true,purchaseTimeframeMonths:3,isDecisionMaker:true,
    });
    expect(classifyInbound({productInterest:"N/A",timeframe:"within 3 months",title:"Director IT"})).toMatchObject({
      classification:"cold",explicitInterest:false,
    });
  });
  it("uses Hot/Warm/Cold purchase bands and keeps missing product cold",()=>{
    expect(classifyInbound({demo:"Yes",title:"VP Technology"}).classification).toBe("cold");
    expect(classifyInbound({interest:"purchase",timeframe:"9 months",title:"CIO"}).classification).toBe("cold");
    for (const timeframe of ["More than 6 Months", "over 6 months", "after 6 months", "6+ months", "6 months+"]) {
      expect(classifyInbound({productInterest:"HP Proactive Insights",timeframe})).toMatchObject({
        classification:"cold",purchaseTimeframeMonths:7,
      });
    }
    expect(classifyInbound({productInterest:"HP Proactive Insights",timeframe:"more than 3 months"})).toMatchObject({
      classification:"cold",purchaseTimeframeMonths:null,
    });
    expect(classifyInbound({productInterest:"HP Proactive Insights",timeframe:"In 3-6 Months"})).toMatchObject({
      classification:"warm",purchaseTimeframeMonths:6,
    });
  });
  it("repairs older beyond-six-month answers before reconciling Hot labels without changing routing",async()=>{
    mocks.query.mockResolvedValue(result([]));
    await repairInboundProductInterestClassifications(7);
    const [timelineRepair,classificationRepair]=mocks.query.mock.calls.filter(([sql]) => String(sql).startsWith("UPDATE"));
    expect(timelineRepair[0]).toContain("jsonb_each_text(s.raw_fields)");
    expect(timelineRepair[0]).toContain("classification='cold'");
    expect(timelineRepair[0]).not.toContain("routing_status");
    expect(timelineRepair[1]).toEqual([7]);
    expect(classificationRepair[0]).toContain("purchase_timeframe_months BETWEEN 0 AND 3");
  });
  it("keeps demo-only responses without a product selection cold",()=>{
    expect(classifyInbound({demo:"requested",timeframe:"2 months",title:"IT Analyst"}).classification).toBe("cold");
  });
  it("keeps a productless account cold unless another respondent selects a product",async()=>{
    mocks.query.mockImplementation(async(statement:string)=>statement.includes("GROUP BY account_id")
      ?result([{account_id:10,classification:"cold"},{account_id:11,classification:"warm"}])
      :statement.includes("intent_inbound_category_rules")
      ?result([]):result([
        {submissionId:1,clientId:8,accountId:10,accountName:"Cold only",contactId:21,
          productAffinity:null,classification:"cold",routingStatus:"pending",affinityReviews:{}},
        {submissionId:2,clientId:8,accountId:11,accountName:"Mixed",contactId:22,
          productAffinity:null,classification:"cold",routingStatus:"routed",affinityReviews:{}},
        {submissionId:3,clientId:8,accountId:11,accountName:"Mixed",contactId:23,
          productAffinity:"HP Renew Services",classification:"warm",routingStatus:"routed",affinityReviews:{}},
      ]));
    const dashboard=await getInboundDashboard(7,{formType:"event_feedback",category:"No Category"});
    expect(dashboard.summary).toMatchObject({accounts:2,cold:1,warm:1,hot:0});
    expect(dashboard.submissionIds).toEqual([1,2]);
  });
  it("never routes Cold blank answers, even through legacy all-status category rules",()=>{
    const fallback={id:1,client_id:8,match_type:"fallback" as const,classification:"all" as const,
      inbound_category_name:null,product_name:null,category_name:null,keywords:[],journey_id:39,sequence_id:15};
    const noCategory={...fallback,id:2,match_type:"category" as const,inbound_category_name:"No Category"};
    expect(matchingInboundRoutingRule([fallback,noCategory],8,"","cold")).toBeUndefined();
    expect(matchingInboundRoutingRule([fallback],8,"","cold")).toBeUndefined();
    expect(matchingInboundRoutingRule([{...noCategory,classification:"warm"}],8,"","cold")).toBeUndefined();
  });
  it("normalizes common timeframes and Drive folder URLs",()=>{
    expect(parsePurchaseTimeframeMonths("1 year")).toBe(12);
    expect(parsePurchaseTimeframeMonths("ASAP")).toBe(0);
    expect(driveFolderId("https://drive.google.com/drive/folders/abcDEF_12345?usp=sharing")).toBe("abcDEF_12345");
  });
  it("keeps canonical aliases automatic and applies saved unusual mappings",()=>{
    expect(canonicalizeInbound({"Company Name":"Acme","Buying window?":"3 months","Special request":"Printers"},{"Buying window?":"timeframe","Special request":"productInterest"})).toEqual({
      companyName:"Acme",timeframe:"3 months",productInterest:"Printers",
    });
  });
  it("recognizes the uploaded ELC event-feedback headings",()=>{
    expect(canonicalizeInbound({
      "Name":"Mohammed Shamim",
      "Designation":"AVP IT",
      "Company Name":"Tata Communications Ltd",
      "Mob No.":"7208050060",
      "Please rate your overall experience with today's gathering of the Elite Leadership Club?":"Excellent",
      "How would you rate the Session by HP":"Excellent",
      "How would you rate the HP Productivity Solution Demo":"Excellent",
      "What topics would you want us to cover in upcoming events (s)?":"Cyber security on AI",
      "I’m interested to know more about the following HP Services. Please tick, where applicable:":"HP Security Services",
      "What is your estimated timeframe to purchase the services presented?":"In 0-3 Months",
      "We want to improve future interactions so that they can help us in purchase decision. Could you help us with suitable time so that the team can connect with you?":"2/12/26",
      "Suitable Time":"10:30",
      "Any exciting challenges that HP can resolve?":"Cost and delivery timeline",
      "Any other feedback/recommendations?":"NA",
    })).toMatchObject({
      name:"Mohammed Shamim",title:"AVP IT",companyName:"Tata Communications Ltd",phone:"7208050060",
      overallExperience:"Excellent",hpSessionRating:"Excellent",demoRating:"Excellent",
      futureTopics:"Cyber security on AI",productInterest:"HP Security Services",timeframe:"In 0-3 Months",
      followUpDate:"2/12/26",followUpTime:"10:30",challenges:"Cost and delivery timeline",feedback:"NA",
    });
  });
  it("recognizes Email ID without a saved mapping",()=>{
    expect(canonicalizeInbound({"Email ID":"person@example.test"})).toMatchObject({email:"person@example.test"});
    expect(canonicalizeInbound({"Desg.":"Director"})).toMatchObject({title:"Director"});
  });
  it("lists every respondent and prioritizes interested people before seniority",()=>{
    const base={accountId:8,contactEmail:null,affinityReviews:{},fieldMappings:{},
      classification:"warm" as const,routingStatus:"pending",routingError:null,
      manualSelection:null,manualJourneyId:null,manualSequenceId:null};
    const rows=[
      {...base,submissionId:1,contactId:11,contactName:"Senior",contactTitle:"Chief Technology Officer",
        productInterest:null,rawFields:{}},
      {...base,submissionId:2,contactId:12,contactName:"Junior",contactTitle:"IT Analyst",
        productInterest:"HP Security Services",rawFields:{}},
      {...base,submissionId:3,contactId:13,contactName:"Manager",contactTitle:"Director IT",
        productInterest:"HP Device-as-a-Service",rawFields:{}},
    ];
    const people=groupInboundRespondents(rows,[]).get(8)!;
    expect(people.map(person=>[person.name,person.isPrimary])).toEqual([
      ["Manager",true],["Junior",false],["Senior",false],
    ]);
    expect(people[0].interests[0].selection).toBe("HP Device-as-a-Service");
    expect(people[1].interests[0].selection).toBe("HP Security Services");
    const withoutManager=groupInboundRespondents(rows.filter(row=>row.contactId!==13),[]).get(8)!;
    expect(withoutManager[0].name).toBe("Junior");
    expect(withoutManager[0].isPrimary).toBe(true);
    const allInterested=groupInboundRespondents(rows.map(row=>row.contactId===11
      ?{...row,productInterest:"HP Fix Services"}:row),[]).get(8)!;
    expect(allInterested[0].name).toBe("Senior");
    const noInterests=groupInboundRespondents(rows.map(row=>({...row,productInterest:null})),[]).get(8)!;
    expect(noInterests.every(person=>!person.isPrimary)).toBe(true);
  });
  it("routes only the selected respondent's response to its chosen journey and sequence",async()=>{
    mocks.query.mockImplementation(async(sql:string)=>{
      if(sql.includes("FROM intent_inbound_submissions s"))return result([{
        id:17,client_id:8,contact_id:31,classification:"warm",product_interest:"HP Security Services",affinity_reviews:{},
        raw_fields:{},field_mappings:{},email:"person@example.test",dnc:false,
      }]);
      if(sql.includes("FROM journeys")||sql.includes("FROM email_sequences"))return result([{one:1}]);
      if(sql.startsWith("UPDATE sequence_enrollments SET resume_at"))return result([]);
      throw new Error(`Unexpected pool query: ${sql}`);
    });
    mocks.clientQuery.mockImplementation(async(sql:string)=>{
      if(sql.includes("SELECT product_interest,affinity_reviews"))return result([{classification:"warm",product_interest:"HP Security Services",affinity_reviews:{},contact_id:31}]);
      if(sql.includes("SELECT id FROM contacts"))return result([{id:31}]);
      if(sql.includes("FROM intent_inbound_manual_routes"))return result([]);
      if(sql.includes("FROM sequence_enrollments"))return result([]);
      if(sql.includes("FROM sequence_steps"))return result([{id:71}]);
      if(sql.includes("INSERT INTO sequence_enrollments"))return result([{id:99}]);
      return result([]);
    });
    expect(await routeInboundRespondent(7,17,"HP Security Services",39,15,{startSequence:true})).toEqual({routed:true});
    expect(mocks.clientQuery).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO journey_contacts"),[39,31]);
    expect(mocks.clientQuery).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO sequence_enrollments"),[15,31,71]);
    expect(mocks.clientQuery).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO intent_inbound_manual_routes"),
      [7,17,31,"HP Security Services",39,15]);
  });
  it("saves a draft sequence destination without enrolling, recovering email or scheduling delivery",async()=>{
    mocks.query.mockImplementation(async(sql:string,params:unknown[])=>{
      if(sql.includes("FROM intent_inbound_submissions s"))return result([{
        id:17,client_id:8,contact_id:31,classification:"warm",product_interest:"HP Security Services",affinity_reviews:{},
        raw_fields:{},field_mappings:{},email:null,dnc:false,
      }]);
      if(sql.includes("FROM journeys"))return result([{one:1}]);
      if(sql.includes("FROM email_sequences")){
        expect(params).toEqual([7,15,8,true]);
        expect(sql).toContain("client_id IS NULL OR client_id=$3");
        return result([{one:1}]);
      }
      throw new Error(`Unexpected pool query: ${sql}`);
    });
    mocks.clientQuery.mockImplementation(async(sql:string)=>{
      if(sql.includes("SELECT product_interest,affinity_reviews"))return result([{classification:"warm",product_interest:"HP Security Services",affinity_reviews:{},contact_id:31}]);
      if(sql.includes("SELECT id FROM contacts"))return result([{id:31}]);
      return result([]);
    });
    expect(await routeInboundRespondent(7,17,"HP Security Services",39,15)).toEqual({routed:true,emailStarted:false});
    expect(mocks.clientQuery).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO journey_contacts"),[39,31]);
    expect(mocks.clientQuery).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO intent_inbound_manual_routes"),
      [7,17,31,"HP Security Services",39,15]);
    expect(mocks.clientQuery.mock.calls.some(([sql])=>/sequence_enrollments|sequence_steps/.test(String(sql)))).toBe(false);
    expect(mocks.query.mock.calls.some(([sql])=>/^UPDATE contacts|resume_at/.test(String(sql)))).toBe(false);
  });
  it("summarizes ratings, ranked interests, follow-up demand, and repeated challenges",()=>{
    expect(summarizeEventFeedback([
      {product_interest:"HP Security Services; Device as a Service",event_feedback:{overallExperience:"Excellent",hpSessionRating:"Excellent",workshopRating:"Good",demoRating:"Excellent",futureTopics:"AI security; Hybrid work",followUpDate:"2026-10-02",followUpTime:"10:30",challenges:"Device security"}},
      {product_interest:"HP Security Services",event_feedback:{overallExperience:"Good",hpSessionRating:"Excellent",workshopRating:"Good",demoRating:"Good",futureTopics:"AI security",followUpDate:"2026-10-02",followUpTime:"10:30",challenges:"Device security"}},
      {product_interest:"N/A",event_feedback:{overallExperience:"Excellent",futureTopics:"Cloud modernization",challenges:"Cost control"}},
    ])).toMatchObject({
      responseCount:3,
      ratings:{overallExperience:[{label:"Excellent",count:2},{label:"Good",count:1}]},
      requestedServices:[{label:"HP Security Services",count:2},{label:"Device as a Service",count:1}],
      futureTopics:[
        {label:"AI security",count:2},
        {label:"Cloud modernization",count:1},
        {label:"Hybrid work",count:1},
      ],
      followUpRequests:[{date:"2026-10-02",time:"10:30",count:2}],
      challenges:[{label:"Device security",count:2},{label:"Cost control",count:1}],
    });
  });
  it("shows every selected service as a separate cohort, merging device-as-a-service aliases",()=>{
    const catalog=[
      {id:1,name:"HP Security Services",category:"Security",subcategory:null},
      {id:2,name:"HP Managed Device Services",category:"Software & Services",subcategory:"Computing Services"},
    ];
    const rows=[
      {clientId:8,accountId:10,contactId:21,productAffinity:"HP Security Services; Device as a Service",classification:"warm" as const,routingStatus:"pending"},
      {clientId:8,accountId:11,contactId:22,productAffinity:"HP Device-as-a-Service | HP Security Services",classification:"warm" as const,routingStatus:"routed"},
      {clientId:8,accountId:10,contactId:21,productAffinity:"HP Security Services, HP Security Services",classification:"warm" as const,routingStatus:"pending"},
    ];
    const cohorts=groupInboundAffinityCohorts(rows,catalog);
    expect(cohorts).toHaveLength(2);
    expect(cohorts.find(cohort=>cohort.productAffinity==="HP Security Services")).toMatchObject({
      accountCount:2,contactCount:2,routed:1,pending:2,keywords:["HP Security Services"],
    });
    expect(cohorts.find(cohort=>cohort.productAffinity==="HP Managed Device Services")).toMatchObject({
      accountCount:2,contactCount:2,routed:1,pending:1,
      keywords:["Device as a Service","HP Device-as-a-Service"],
    });
    const manual=groupInboundAffinityCohorts([{
      clientId:8,accountId:10,contactId:21,productAffinity:"HP Security Services; HP Device-as-a-Service",
      classification:"warm",routingStatus:"routed",manualSelection:"HP Security Services",
    }],catalog);
    expect(manual.find(cohort=>cohort.productAffinity==="HP Security Services")).toMatchObject({routed:1});
    expect(manual.find(cohort=>cohort.productAffinity==="HP Managed Device Services")).toMatchObject({pending:1,routed:0});
  });
  it("builds category cohorts from selected products for both statuses without needing routing rules",()=>{
    const catalog=[
      {id:1,name:"HP Security Services",category:"Security",subcategory:null},
      {id:2,name:"HP Managed Device Services",category:"Computing",subcategory:null},
      {id:3,name:"HP Anyware Services",category:"Computing",subcategory:null},
    ];
    const rows=[
      {clientId:8,accountId:10,contactId:21,productAffinity:"HP Managed Device Services; HP Anyware Services",classification:"hot" as const,routingStatus:"pending",accountName:"Acme"},
      {clientId:8,accountId:11,contactId:22,productAffinity:"HP Security Services",classification:"warm" as const,routingStatus:"routed",accountName:"Beta"},
      {clientId:8,accountId:12,contactId:23,productAffinity:"HP Security Services",classification:"warm" as const,routingStatus:"pending",affinityReviews:{"HP Security Services":"rejected"}},
    ];
    const grouped=groupInboundCategoryCohorts(rows,catalog);
    expect(grouped.find(group=>group.categoryName==="Business Services")).toMatchObject({
      classification:"hot",accountCount:1,pending:1,products:["HP Anyware","Managed Device Service / Device as a Service"],
    });
    expect(grouped.find(group=>group.categoryName==="Security")).toMatchObject({
      classification:"warm",accountCount:1,routed:1,products:["Endpoint Security"],
    });
    expect(grouped.find(group=>group.categoryName==="Needs categorization")).toMatchObject({
      classification:"warm",accountCount:1,products:["No product selected"],
    });
  });
  it("keeps Warm accounts without a usable or approved interest visible for review",()=>{
    const rows=[
      {clientId:8,accountId:20,accountName:"No selection",contactId:2,productAffinity:null,classification:"warm" as const,routingStatus:"pending"},
      {clientId:8,accountId:21,accountName:"Rejected selection",contactId:3,productAffinity:"HP Security Services",classification:"warm" as const,routingStatus:"pending",affinityReviews:{"HP Security Services":"rejected"}},
      {clientId:8,accountId:22,accountName:"Has selection",contactId:4,productAffinity:"HP Security Services",classification:"warm" as const,routingStatus:"pending"},
    ];
    const cohorts=groupInboundAffinityCohorts(rows,[]);
    expect(cohorts.find(cohort=>cohort.productAffinity==="No product selected")).toMatchObject({
      accountCount:2,keywords:[],accounts:[{id:20,name:"No selection"},{id:21,name:"Rejected selection"}],
    });
    expect(cohorts.find(cohort=>cohort.productAffinity==="HP Security Services")).toMatchObject({accountCount:1});
  });
  it("separates missing product answers from unrecognized or rejected product answers",()=>{
    const rows=[
      {clientId:8,accountId:20,contactId:2,productAffinity:null,classification:"warm" as const,routingStatus:"pending"},
      {clientId:8,accountId:21,contactId:3,productAffinity:"N/A",classification:"warm" as const,routingStatus:"pending"},
      {clientId:8,accountId:22,contactId:4,productAffinity:"Unknown service",classification:"warm" as const,routingStatus:"pending"},
      {clientId:8,accountId:23,contactId:5,productAffinity:"HP Wolf Security",classification:"warm" as const,routingStatus:"pending",affinityReviews:{"HP Wolf Security":"rejected"}},
    ];
    const cohorts=groupInboundCategoryCohorts(rows,[]);
    expect(cohorts.find(group=>group.categoryName==="No Category")).toMatchObject({accountCount:2,products:["No product selected"]});
    expect(cohorts.find(group=>group.categoryName==="Needs categorization")).toMatchObject({accountCount:2});
  });
  it("matches a No Category route only for unanswered interests, in its client and both lead statuses",()=>{
    const category={id:31,client_id:8,match_type:"category" as const,classification:"all" as const,
      inbound_category_name:"No Category",category_name:null,keywords:[],journey_id:14,sequence_id:19,product_name:null};
    const fallback={...category,id:32,match_type:"fallback" as const,inbound_category_name:null};
    expect(matchingInboundRoutingRule([fallback,category],8,"","warm")?.id).toBe(31);
    expect(matchingInboundRoutingRule([fallback,category],8,"N/A","hot")).toBeUndefined();
    expect(matchingInboundRoutingRule([fallback,category],8,"Unknown service","warm")?.id).toBe(32);
    expect(matchingInboundRoutingRule([category],9,"","warm")).toBeUndefined();
    expect(groupInboundRuleCohorts([category],[{
      submissionId:1,clientId:8,accountId:20,accountName:"Acme",productAffinity:null,
      submissionClassification:"warm",routingStatus:"pending",routingError:null,routedRuleId:null,
    }],[])[0]).toMatchObject({accountCount:1,pending:1});
  });
  it("shows saved rules above detected affinities with matched accounts and failure reasons",()=>{
    const rules=[{id:3,name:"HP Managed Device Services · warm",client_id:8,match_type:"product" as const,
      classification:"warm" as const,product_name:"HP Managed Device Services",category_name:null,keywords:["HP Device-as-a-Service"],
      journey_id:39,sequence_id:15,enabled:true}];
    expect(groupInboundRuleCohorts(rules,[{
      submissionId:17,clientId:8,accountId:3217,accountName:"Example",productAffinity:"HP Device-as-a-Service",
      submissionClassification:"warm",routingStatus:"error",routingError:"A contact email is required for email cadence",
      routedRuleId:null,
    },{
      submissionId:18,clientId:8,accountId:3217,accountName:"Example",productAffinity:"HP Device-as-a-Service",
      submissionClassification:"warm",routingStatus:"routed",routingError:null,routedRuleId:3,
    }])).toMatchObject([{ruleId:3,accountCount:1,routed:1,failed:1,
      accounts:[{id:3217,responses:2,failures:["A contact email is required for email cadence"]}]}]);
  });
  it("keeps discovery separate from configured cohorts, including partial and fallback matches",()=>{
    const catalog=[
      {id:1,name:"HP Security Services",category:"Security",subcategory:null},
      {id:2,name:"HP Managed Device Services",category:"Software & Services",subcategory:null},
    ];
    const rules=[
      {id:3,client_id:8,match_type:"product" as const,classification:"warm" as const,
        product_name:"HP Security Services",category_name:null,keywords:[],
        journey_id:39,sequence_id:15,enabled:true},
      {id:9,client_id:8,match_type:"fallback" as const,classification:"warm" as const,
        product_name:null,category_name:null,keywords:[],journey_id:39,sequence_id:15,enabled:true},
    ];
    const rows=[
      {clientId:8,accountId:10,contactId:21,productAffinity:"HP Security Services; HP Device-as-a-Service",
        classification:"warm" as const,submissionClassification:"warm" as const,routingStatus:"routed",
        routedRuleId:3},
      {clientId:8,accountId:11,contactId:22,productAffinity:null,
        classification:"warm" as const,submissionClassification:"warm" as const,routingStatus:"pending"},
    ];
    const discovery=groupUnconfiguredInboundAffinities(rows,catalog,rules);
    expect(discovery).toHaveLength(2);
    expect(discovery.find(group=>group.productAffinity==="HP Security Services")).toBeUndefined();
    expect(discovery.find(group=>group.productAffinity==="HP Managed Device Services")).toMatchObject({
      accountCount:1,pending:1,routed:0,
    });
    expect(discovery.find(group=>group.productAffinity==="No product selected")).toMatchObject({accountCount:1});
    expect(groupUnconfiguredInboundAffinities(rows,catalog,rules.map(rule=>({...rule,enabled:false})))
      .find(group=>group.productAffinity==="HP Security Services")).toMatchObject({accountCount:1});
  });
  it("recovers a valid form email before retrying a failed cadence enrollment",async()=>{
    const rule={id:3,client_id:8,match_type:"product",classification:"warm",keywords:["HP Device-as-a-Service"],
      journey_id:39,sequence_id:15,product_name:"HP Managed Device Services",category_name:null};
    mocks.query.mockImplementation(async(sql:string)=>{
      if(sql.includes("FROM intent_inbound_category_rules"))return result([]);
      if(sql.includes("FROM intent_inbound_routing_rules"))return result([rule]);
      if(sql.includes("FROM intent_inbound_submissions s"))return result([{
        id:17,client_id:8,contact_id:30192,product_interest:"HP Device-as-a-Service",affinity_reviews:{},
        classification:"warm",raw_fields:{"Email ID":"person@example.test"},source_mappings:{},
         email:null,dnc:false,account_id:12,
      }]);
      if(sql.startsWith("UPDATE contacts SET email="))return result([{email:"person@example.test"}]);
      if(sql.includes("AND company_id IS DISTINCT FROM"))return result([]);
      throw new Error(`Unexpected pool query: ${sql}`);
    });
    mocks.clientQuery.mockImplementation(async(sql:string)=>{
       if(sql.includes("SELECT routing_status"))return result([{routing_status:"error",classification:"warm",contact_id:30192,account_id:12}]);
      if(sql.includes("SELECT id FROM contacts"))return result([{id:30192}]);
      // Routing revalidates the saved published destination inside the same
      // transaction as membership/enrollment, after recovering the form email.
      if(sql.includes("SELECT r.id FROM intent_inbound_routing_rules"))return result([{id:rule.id}]);
      if(sql.includes("SELECT id FROM sequence_enrollments"))return result([{id:99}]);
      return result([]);
    });
    expect(await routePendingWarmSubmissions(7,undefined,3)).toEqual({routed:1,pending:0,failed:0});
    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining("UPDATE contacts SET email="),
      ["person@example.test",7,30192]);
  });
  it("does not assign a form email already owned by another contact",async()=>{
    mocks.query.mockImplementation(async(sql:string)=>{
      if(sql.includes("FROM intent_inbound_category_rules"))return result([]);
      if(sql.includes("FROM intent_inbound_routing_rules"))return result([{
        id:3,client_id:8,match_type:"product",classification:"warm",keywords:["HP Device-as-a-Service"],
        journey_id:39,sequence_id:15,product_name:"HP Managed Device Services",category_name:null,
      }]);
      if(sql.includes("FROM intent_inbound_submissions s"))return result([{
        id:18,client_id:8,contact_id:30193,product_interest:"HP Device-as-a-Service",
        affinity_reviews:{},classification:"warm",raw_fields:{"Email ID":"other@example.test"},
         source_mappings:{},email:null,dnc:false,account_id:12,
      }]);
      if(sql.startsWith("UPDATE contacts SET email="))return result([]);
      if(sql.includes("SELECT 1 FROM contacts"))return result([{one:1}]);
      if(sql.includes("UPDATE intent_inbound_submissions SET routing_status='error'"))return result([]);
      throw new Error(`Unexpected pool query: ${sql}`);
    });
    expect(await routePendingWarmSubmissions(7,undefined,3)).toEqual({routed:0,pending:0,failed:1});
    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining("Admin identity review required"),[7,18]);
    expect(mocks.connect).not.toHaveBeenCalled();
  });
  it("never routes a kept response after the other email owner disappears",async()=>{
    mocks.query.mockImplementation(async(sql:string)=>{
      if(sql.includes("FROM intent_inbound_category_rules"))return result([]);
      if(sql.includes("FROM intent_inbound_routing_rules"))return result([{
        id:3,client_id:8,match_type:"product",classification:"warm",keywords:["HP Device-as-a-Service"],
        journey_id:39,sequence_id:15,product_name:"HP Managed Device Services",category_name:null,
      }]);
      if(sql.includes("FROM intent_inbound_submissions s"))return result([{
        id:19,client_id:8,contact_id:31,account_id:12,identity_review:"keep",
        product_interest:"HP Device-as-a-Service",affinity_reviews:{},classification:"warm",
        raw_fields:{"Email ID":"disputed@example.test"},source_mappings:{},
        email:"source@example.test",dnc:false,
      }]);
      if(sql.includes("UPDATE intent_inbound_submissions SET routing_status='error'"))return result([]);
      throw new Error(`Unexpected pool query: ${sql}`);
    });
    expect(await routePendingWarmSubmissions(7,undefined,3)).toEqual({routed:0,pending:0,failed:1});
    expect(mocks.query.mock.calls.some(([sql])=>String(sql).includes("FROM contacts WHERE tenant_id=$1 AND lower(btrim(email))"))).toBe(false);
    expect(mocks.connect).not.toHaveBeenCalled();
  });
  it("blocks manual routing of a kept response even when no other email owner exists",async()=>{
    mocks.query.mockImplementation(async(sql:string)=>{
      if(sql.includes("FROM intent_inbound_submissions s"))return result([{
        id:19,client_id:8,contact_id:31,classification:"warm",account_id:12,identity_review:"keep",
        product_interest:"HP Device-as-a-Service",affinity_reviews:{},
        raw_fields:{"Email ID":"disputed@example.test"},field_mappings:{},
        email:"source@example.test",dnc:false,
      }]);
      throw new Error(`Unexpected pool query: ${sql}`);
    });
    expect(await routeInboundRespondent(7,19,"HP Device-as-a-Service",39,15))
      .toMatchObject({status:409,error:expect.stringContaining("blocked")});
    expect(mocks.connect).not.toHaveBeenCalled();
  });
  it("applies saved preview mappings and refreshes an existing row after the Drive file changes",async()=>{
    const source={
      id:4,tenant_id:7,client_id:8,folder_id:"folder-12345",
      form_type:"event_feedback",
      field_mappings:{"What are you hoping to achieve?":"productInterest","How soon is this needed?":"timeframe","Tell us more":"feedback"},
    };
    const file={id:"file-1",name:"responses.csv",mimeType:"text/csv",modifiedTime:"2026-09-23T10:00:00.000Z"};
    let csv=[
      "Timestamp,Company Name,Email,Job Title,Wants to buy,What are you hoping to achieve?,How soon is this needed?,Tell us more",
      "2026-09-23 09:00:00,Acme,alex@acme.test,IT Director,Yes,Printers,9 months,Initial feedback",
      "2026-09-23 09:05:00,Beta,sam@beta.test,IT Manager,Yes,Laptops,6 months,Beta feedback",
    ].join("\n");
    const submissions=new Map<string,{id:number;values:any[]}>();

    mocks.proxy.mockImplementation(async(_connector:string,pathname:string)=>{
      if(pathname.includes("/drive/v3/files?"))return new Response(JSON.stringify({files:[file]}),{status:200});
      if(pathname.includes("/drive/v3/files/file-1?"))return new Response(csv,{status:200});
      throw new Error(`Unexpected Drive request: ${pathname}`);
    });
    mocks.query.mockImplementation(async(sql:string)=>{
      if(sql.includes("FROM intent_inbound_category_rules"))return result([]);
      if(sql.includes("FROM intent_inbound_deleted_rows"))return result([]);
      if(sql.includes("SELECT folder_id,field_mappings"))return result([source]);
      if(sql.startsWith("SELECT * FROM intent_inbound_sources"))return result([source]);
      if(sql.includes("SELECT row_key,raw_fields FROM intent_inbound_submissions"))return result(
        [...submissions.entries()].map(([row_key,submission])=>({row_key,raw_fields:submission.values[20]})),
      );
      if(sql.includes("FROM intent_inbound_routing_rules"))return result([]);
      if(sql.includes("FROM intent_inbound_submissions s"))return result([]);
      if(sql.startsWith("UPDATE intent_inbound_sources"))return result([]);
      throw new Error(`Unexpected pool query: ${sql}`);
    });
    mocks.clientQuery.mockImplementation(async(sql:string,params:any[]=[] )=>{
      if(["BEGIN","COMMIT","ROLLBACK"].includes(sql))return result([]);
      if(sql.includes("pg_advisory_xact_lock")||sql.includes("FROM intent_inbound_deleted_rows"))return result([]);
      if(sql.startsWith("SELECT id FROM companies"))return result([{id:21}]);
      if(sql.includes("SELECT 1 FROM contacts"))return result([]);
      if(sql.startsWith("SELECT id FROM contacts"))return result([{id:31}]);
      if(sql.startsWith("SELECT id,company_id,client_id FROM contacts"))return result([]);
      if(sql.includes("SELECT identity_review,reviewed_email"))return result([]);
      if(sql.startsWith("UPDATE contacts"))return result([]);
      if(sql.includes("INSERT INTO intent_inbound_submissions")){
        const rowKey=String(params[7]);
        const existing=submissions.get(rowKey);
        const saved={id:existing?.id??41+submissions.size,values:[...params]};
        submissions.set(rowKey,saved);
        return result([{id:saved.id}]);
      }
      throw new Error(`Unexpected client query: ${sql}`);
    });

    const preview=await previewInboundSource(7,4);
    expect(preview.fields.find(field=>field.heading==="How soon is this needed?")).toMatchObject({
      automaticTarget:null,savedTarget:"timeframe",samples:expect.arrayContaining(["9 months"]),
    });
    expect(preview.fields.find(field=>field.heading==="Company Name")).toMatchObject({automaticTarget:"companyName"});
    expect(preview.fields.find(field=>field.heading==="Timestamp")).toMatchObject({automaticTarget:"submittedAt"});

    await syncInboundSource(7,4);
    const initialByEmail=new Map([...submissions.values()].map(submission=>[submission.values[20].Email,submission.id]));
    const legacySubmissions=[...submissions.values()];
    submissions.clear();
    legacySubmissions.forEach((submission,index)=>submissions.set(`legacy-content-key-${index}`,submission));
    csv=[
      "Timestamp,Company Name,Email,Job Title,Wants to buy,What are you hoping to achieve?,How soon is this needed?,Tell us more",
      "2026-09-23 08:55:00,,ignored@example.test,IT Director,Yes,Servers,1 month,Missing company",
      "2026-09-23 09:05:00,Beta,sam@beta.test,IT Manager,Yes,Laptops,6 months,Beta feedback",
      "2026-09-23 09:00:00,Acme,alex@acme.test,IT Director,Yes,Device as a Service,3 months,Updated feedback",
    ].join("\n");
    file.modifiedTime="2026-09-23T11:00:00.000Z";
    await syncInboundSource(7,4);

    expect(submissions.size).toBe(2);
    const refreshed=[...submissions.values()].find(submission=>submission.values[20].Email==="alex@acme.test")!;
    expect(refreshed.id).toBe(initialByEmail.get("alex@acme.test"));
    expect(refreshed.values[9]).toBe("event_feedback");
    expect(refreshed.values.slice(10,18)).toEqual([
      "hot",
      "Selected product or service with a purchase timeline of three months or less.",
      true,false,3,true,"Updated feedback","Device as a Service",
    ]);
    expect(mocks.proxy.mock.calls.filter(([,pathname])=>pathname.includes("/drive/v3/files/file-1?"))).toHaveLength(3);
  });
  it("holds a conflicting import for review instead of merging by name or phone",async()=>{
    const source={id:4,tenant_id:7,client_id:8,folder_id:"folder-12345",form_type:"lead_form",field_mappings:{}};
    mocks.proxy.mockImplementation(async(_connector:string,pathname:string)=>{
      if(pathname.includes("/drive/v3/files?"))return new Response(JSON.stringify({
        files:[{id:"file-1",name:"responses.csv",mimeType:"text/csv"}],
      }),{status:200});
      if(pathname.includes("/drive/v3/files/file-1?"))return new Response(
        "Company Name,Name,Email,Phone\nSource Co,Alex,owner@example.test,5550100",{status:200});
      throw new Error(`Unexpected Drive request: ${pathname}`);
    });
    mocks.query.mockImplementation(async(sql:string)=>{
      if(sql.includes("SELECT folder_id,field_mappings")||sql.startsWith("SELECT * FROM intent_inbound_sources"))return result([source]);
      if(sql.includes("SELECT row_key,raw_fields FROM intent_inbound_submissions")
        ||sql.includes("FROM intent_inbound_category_rules")||sql.includes("FROM intent_inbound_routing_rules")
        ||sql.includes("FROM intent_inbound_submissions s")||sql.startsWith("UPDATE intent_inbound_sources"))return result([]);
      throw new Error(`Unexpected pool query: ${sql}`);
    });
    mocks.clientQuery.mockImplementation(async(sql:string)=>{
      if(["BEGIN","COMMIT","ROLLBACK"].includes(sql)||sql.includes("pg_advisory_xact_lock")
        ||sql.includes("FROM intent_inbound_deleted_rows"))return result([]);
      if(sql.startsWith("SELECT id FROM companies"))return result([{id:21}]);
      if(sql.includes("SELECT 1 FROM contacts WHERE tenant_id=$1 AND lower(btrim(email))"))return result([{one:1}]);
      if(sql.includes("SELECT identity_review,reviewed_email"))return result([]);
      if(sql.includes("SELECT id,company_id,client_id FROM contacts"))return result([{id:32,company_id:22,client_id:8}]);
      if(sql.includes("INSERT INTO intent_inbound_submissions"))return result([{id:41}]);
      throw new Error(`Unexpected client query: ${sql}`);
    });
    expect(await syncInboundSource(7,4)).toMatchObject({imported:1});
    const insert=mocks.clientQuery.mock.calls.find(([sql])=>String(sql).includes("INSERT INTO intent_inbound_submissions"));
    expect(insert?.[1]).toMatchObject({3:21,4:null,21:null,25:"error"});
    expect(mocks.clientQuery.mock.calls.some(([sql])=>String(sql).includes("UPDATE contacts")
      ||String(sql).includes("INSERT INTO contacts"))).toBe(false);
  });
  it("preserves a kept review on re-sync when the email owner disappears",async()=>{
    const source={id:4,tenant_id:7,client_id:8,folder_id:"folder-12345",form_type:"lead_form",field_mappings:{}};
    const file={id:"file-1",name:"responses.csv",mimeType:"text/csv"};
    mocks.proxy.mockImplementation(async(_connector:string,pathname:string)=>{
      if(pathname.includes("/drive/v3/files?"))return new Response(JSON.stringify({files:[file]}),{status:200});
      if(pathname.includes("/drive/v3/files/file-1?"))
        return new Response("Company Name,Email,Phone,Timestamp\nAcme,disputed@example.test,5550100,2026-09-23 09:00:00",{status:200});
      throw new Error(`Unexpected Drive request: ${pathname}`);
    });
    mocks.query.mockImplementation(async(sql:string)=>{
      if(sql.includes("SELECT folder_id,field_mappings")||sql.startsWith("SELECT * FROM intent_inbound_sources"))return result([source]);
      if(sql.includes("SELECT row_key,raw_fields FROM intent_inbound_submissions"))return result([]);
      if(sql.includes("FROM intent_inbound_category_rules")||sql.includes("FROM intent_inbound_routing_rules")
        ||sql.includes("FROM intent_inbound_submissions s")||sql.startsWith("UPDATE intent_inbound_sources"))return result([]);
      throw new Error(`Unexpected pool query: ${sql}`);
    });
    mocks.clientQuery.mockImplementation(async(sql:string)=>{
      if(["BEGIN","COMMIT","ROLLBACK"].includes(sql)||sql.includes("pg_advisory_xact_lock")
        ||sql.includes("FROM intent_inbound_deleted_rows"))return result([]);
      if(sql.startsWith("SELECT id FROM companies"))return result([{id:21}]);
      if(sql.includes("SELECT identity_review,reviewed_email"))return result([{
        identity_review:"keep",reviewed_email:"disputed@example.test",reviewed_source_account_id:21,
        reviewed_source_contact_id:31,contact_id:31,account_id:21,
      }]);
      if(sql.includes("SELECT 1 FROM contacts WHERE tenant_id=$1 AND id=$2"))return result([{one:1}]);
      if(sql.includes("SELECT id,company_id,client_id FROM contacts"))return result([]);
      if(sql.includes("INSERT INTO intent_inbound_submissions"))return result([{id:41}]);
      throw new Error(`Unexpected client query: ${sql}`);
    });
    const run=await syncInboundSource(7,4);
    expect(run).toMatchObject({imported:1});
    expect(mocks.clientQuery.mock.calls.some(([sql])=>String(sql).includes("UPDATE contacts"))).toBe(false);
    const insert=mocks.clientQuery.mock.calls.find(([sql])=>String(sql).includes("INSERT INTO intent_inbound_submissions"));
    expect(insert?.[1]).toMatchObject({3:21,4:31,21:"keep",25:"error"});
    expect(insert?.[1][20]).toMatchObject({"Company Name":"Acme","Email":"disputed@example.test"});
  });
  describe("reviewed contact links across repeated Drive syncs",()=>{
    function setupReviewedSync(){
      const source={id:4,tenant_id:7,client_id:8,folder_id:"folder-12345",form_type:"lead_form",field_mappings:{}};
      const file={id:"file-1",name:"responses.csv",mimeType:"text/csv"};
      const csv=[
        "Company Name,Name,Email,Phone,Timestamp",
        "Source Co,Alex,disputed@example.test,5550100,2026-09-23 09:00:00",
        "Other Co,Sam,sam@example.test,5550200,2026-09-23 09:05:00",
      ].join("\n");
      const contacts=new Map([
        [31,{id:31,company_id:21,client_id:8,email:null as string|null,phone:"5550100"}],
        [32,{id:32,company_id:22,client_id:8,email:"disputed@example.test" as string|null,phone:"5559999"}],
        [33,{id:33,company_id:23,client_id:8,email:"sam@example.test" as string|null,phone:"5550200"}],
      ]);
      type Submission={id:number;row_key:string;raw_fields:Record<string,unknown>;account_id:number;contact_id:number|null;
        identity_review:string|null;reviewed_email:string|null;reviewed_source_account_id:number|null;
        reviewed_source_contact_id:number|null;routing_status:string;};
      const submissions=new Map<string,Submission>();
      const oldEnrollments=[{id:900,contact_id:31,sequence_id:15,status:"active"}];
      let nextId=41;
      mocks.proxy.mockImplementation(async(_connector:string,pathname:string)=>{
        if(pathname.includes("/drive/v3/files?"))return new Response(JSON.stringify({files:[file]}),{status:200});
        if(pathname.includes("/drive/v3/files/file-1?"))return new Response(csv,{status:200});
        throw new Error(`Unexpected Drive request: ${pathname}`);
      });
      mocks.query.mockImplementation(async(sql:string)=>{
        if(sql.startsWith("SELECT * FROM intent_inbound_sources"))return result([source]);
        if(sql.includes("SELECT row_key,raw_fields FROM intent_inbound_submissions"))return result(
          [...submissions.values()].map(({row_key,raw_fields})=>({row_key,raw_fields})));
        if(sql.includes("FROM intent_inbound_category_rules")||sql.includes("FROM intent_inbound_routing_rules")
          ||sql.includes("FROM intent_inbound_submissions s")||sql.startsWith("UPDATE intent_inbound_sources"))return result([]);
        throw new Error(`Unexpected pool query: ${sql}`);
      });
      mocks.clientQuery.mockImplementation(async(sql:string,params:any[]=[])=>{
        if(["BEGIN","COMMIT","ROLLBACK"].includes(sql)||sql.includes("pg_advisory_xact_lock")
          ||sql.includes("FROM intent_inbound_deleted_rows"))return result([]);
        if(sql.startsWith("SELECT id FROM companies")){
          const name=params[3];
          return result([{id:name==="Source Co"?21:23}]);
        }
        if(sql.includes("SELECT identity_review,reviewed_email")){
          const saved=submissions.get(params[3]);
          return result(saved?[saved]:[]);
        }
        if(sql.includes("SELECT 1 FROM contacts WHERE tenant_id=$1 AND id=$2")){
          const contact=contacts.get(params[1]);
          return result(contact&&contact.company_id===params[2]&&contact.phone===params[3]?[{one:1}]:[]);
        }
        if(sql.includes("SELECT 1 FROM contacts WHERE tenant_id=$1 AND lower(btrim(email))")){
          return result([...contacts.values()].some(c=>c.email?.toLowerCase()===params[1]&&c.company_id!==params[2])
            ?[{one:1}]:[]);
        }
        if(sql.startsWith("SELECT id FROM contacts")){
          const found=[...contacts.values()].find(c=>(c.company_id===params[3]||c.company_id==null)
            &&(c.email?.toLowerCase()===params[1]||c.phone===params[2]));
          return result(found?[{id:found.id}]:[]);
        }
        if(sql.startsWith("SELECT id,company_id,client_id FROM contacts")){
          return result([...contacts.values()].filter(c=>c.email?.toLowerCase()===params[1]
            &&c.company_id!==params[2]).map(({id,company_id,client_id})=>({id,company_id,client_id})));
        }
        if(sql.startsWith("UPDATE contacts SET")){
          const contact=contacts.get(params[11]);
          if(!contact)throw new Error("Unexpected contact update");
          contact.company_id=params[0];
          if(!contact.email&&params[9]&&!([...contacts.values()].some(c=>c.id!==contact.id&&c.email===params[9])))
            contact.email=params[9];
          return result([]);
        }
        if(sql.includes("INSERT INTO intent_inbound_submissions")){
          const existing=submissions.get(params[7]);
          const saved:Submission={
            id:existing?.id??nextId++,row_key:params[7],raw_fields:params[20],
            account_id:params[3],contact_id:params[4],identity_review:params[21],
            reviewed_email:params[22],reviewed_source_account_id:params[23],
            reviewed_source_contact_id:params[24],
            routing_status:existing?.routing_status==="routed"?"routed":params[25],
          };
          submissions.set(saved.row_key,saved);
          return result([{id:saved.id}]);
        }
        throw new Error(`Unexpected client query: ${sql}`);
      });
      const byEmail=(email:string)=>[...submissions.values()].find(row=>row.raw_fields.Email===email)!;
      const review=(action:"keep"|"relink")=>{
        const row=byEmail("disputed@example.test");
        row.identity_review=action;
        row.reviewed_email="disputed@example.test";
        row.reviewed_source_account_id=21;
        row.reviewed_source_contact_id=31;
        row.account_id=action==="keep"?21:22;
        row.contact_id=action==="keep"?31:32;
        row.routing_status=action==="keep"?"error":"routed";
      };
      const sync=()=>syncInboundSource(7,4);
      return {contacts,submissions,oldEnrollments,byEmail,review,sync};
    }
    it("keeps just the reviewed source link through repeated syncs, even if the email owner disappears",async()=>{
      const state=setupReviewedSync();
      await state.sync();
      const other={...state.byEmail("sam@example.test")};
      state.review("keep");
      const reviewedId=state.byEmail("disputed@example.test").id;
      await state.sync();
      state.contacts.get(32)!.email=null;
      await state.sync();
      expect(state.byEmail("disputed@example.test")).toMatchObject({
        id:reviewedId,account_id:21,contact_id:31,identity_review:"keep",routing_status:"error",
      });
      expect(state.contacts.get(31)!.email).toBeNull();
      expect(state.byEmail("sam@example.test")).toEqual(other);
      expect(state.oldEnrollments).toEqual([{id:900,contact_id:31,sequence_id:15,status:"active"}]);
      expect(mocks.clientQuery.mock.calls.filter(([sql])=>/sequence_enrollments|journey_contacts|email_messages/.test(String(sql)))).toEqual([]);
    });
    it("invalidates a keep review when the source phone evidence changes without touching the other response",async()=>{
      const state=setupReviewedSync();
      await state.sync();
      state.review("keep");
      const other={...state.byEmail("sam@example.test")};
      state.contacts.get(31)!.phone="5559990";
      await state.sync();
      expect(state.byEmail("disputed@example.test")).toMatchObject({
        account_id:21,contact_id:null,identity_review:null,reviewed_email:null,routing_status:"error",
      });
      expect(state.byEmail("sam@example.test")).toEqual(other);
      expect(state.oldEnrollments[0]).toMatchObject({contact_id:31,status:"active"});
      expect(mocks.clientQuery.mock.calls.filter(([sql])=>/sequence_enrollments|journey_contacts/.test(String(sql)))).toEqual([]);
    });
    it("keeps a relink while its owner is unique, then invalidates it when ownership changes",async()=>{
      const state=setupReviewedSync();
      await state.sync();
      state.review("relink");
      const reviewedId=state.byEmail("disputed@example.test").id;
      const other={...state.byEmail("sam@example.test")};
      await state.sync();
      expect(state.byEmail("disputed@example.test")).toMatchObject({
        id:reviewedId,account_id:22,contact_id:32,identity_review:"relink",routing_status:"routed",
      });
      state.contacts.get(32)!.email=null;
      state.contacts.set(34,{id:34,company_id:24,client_id:8,email:"disputed@example.test",phone:"5559998"});
      await state.sync();
      expect(state.byEmail("disputed@example.test")).toMatchObject({
        id:reviewedId,account_id:21,contact_id:null,identity_review:null,reviewed_email:null,routing_status:"routed",
      });
      expect(state.byEmail("sam@example.test")).toEqual(other);
      expect(state.oldEnrollments).toEqual([{id:900,contact_id:31,sequence_id:15,status:"active"}]);
      expect(mocks.clientQuery.mock.calls.filter(([sql])=>/sequence_enrollments|journey_contacts|email_messages/.test(String(sql)))).toEqual([]);
    });
  });
  it("counts every supported file when a Drive folder spans multiple pages",async()=>{
    const source={id:4,tenant_id:7,client_id:8,folder_id:"folder-12345",form_type:"lead_form",field_mappings:{}};
    const firstPageFiles=Array.from({length:1000},(_,index)=>({
      id:`file-${index}`,name:`response-${index}.csv`,mimeType:"text/csv",
    }));
    const secondPageFiles=[
      {id:"file-1000",name:"response-1000.xlsx",mimeType:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"},
      {id:"file-unsupported",name:"notes.txt",mimeType:"text/plain"},
    ];
    mocks.query.mockResolvedValue(result([source]));
    mocks.proxy.mockImplementation(async(_connector:string,pathname:string)=>{
      if(pathname.includes("pageToken=page-2")){
        return new Response(JSON.stringify({files:secondPageFiles}),{status:200});
      }
      if(pathname.includes("/drive/v3/files?")){
        return new Response(JSON.stringify({files:firstPageFiles,nextPageToken:"page-2"}),{status:200});
      }
      if(pathname.includes("/drive/v3/files/file-0?")){
        return new Response("Company Name,Email\nAcme,alex@acme.test",{status:200});
      }
      throw new Error(`Unexpected Drive request: ${pathname}`);
    });

    const preview=await previewInboundSource(7,4,1);

    expect(preview).toMatchObject({files:1001,scannedFiles:1});
    const listingRequests=mocks.proxy.mock.calls.map(([,pathname])=>pathname)
      .filter(pathname=>pathname.includes("/drive/v3/files?"));
    expect(listingRequests).toHaveLength(2);
    expect(listingRequests[0]).toContain("fields=nextPageToken,files(");
    expect(listingRequests[1]).toContain("pageToken=page-2");
  });
  it("still blocks sync when no file provides a company heading",async()=>{
    const source={id:4,tenant_id:7,client_id:8,folder_id:"folder-12345",form_type:"lead_form",field_mappings:{}};
    const file={id:"file-1",name:"responses.csv",mimeType:"text/csv"};
    mocks.query.mockResolvedValueOnce(result([source]));
    mocks.proxy.mockImplementation(async(_connector:string,pathname:string)=>{
      if(pathname.includes("/drive/v3/files?"))return new Response(JSON.stringify({files:[file]}),{status:200});
      if(pathname.includes("/drive/v3/files/file-1?"))return new Response("Email,Interest\nalex@acme.test,Printers",{status:200});
      throw new Error(`Unexpected Drive request: ${pathname}`);
    });

    await expect(syncInboundSource(7,4)).rejects.toBeInstanceOf(MissingInboundCompanyMappingError);
    expect(mocks.proxy.mock.calls.filter(([,pathname])=>pathname.includes("/drive/v3/files/file-1?"))).toHaveLength(1);
    expect(mocks.connect).not.toHaveBeenCalled();
  });
  it("parses two-column Word tables, including native Google Docs exports",()=>{
    const zip=new AdmZip();
    zip.addFile("word/document.xml",Buffer.from(`<?xml version="1.0"?><w:document xmlns:w="x"><w:body><w:tbl>
      <w:tr><w:tc><w:p><w:r><w:t>Client organisation</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Acme</w:t></w:r></w:p></w:tc></w:tr>
      <w:tr><w:tc><w:p><w:r><w:t>Buying window?</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>3 months</w:t></w:r></w:p></w:tc></w:tr>
    </w:tbl></w:body></w:document>`));
    expect(parseInboundRows("Native Google Doc","application/vnd.google-apps.document",zip.toBuffer())).toEqual([
      {"Client organisation":"Acme","Buying window?":"3 months"},
    ]);
  });
  it("parses native Google Sheets exports using their original Drive MIME type",()=>{
    const workbook=XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook,XLSX.utils.json_to_sheet([{"Company":"Acme","Custom need":"Printers"}]),"Responses");
    XLSX.utils.book_append_sheet(workbook,XLSX.utils.json_to_sheet([{"Company":"Beta","Custom need":"Laptops"}]),"Additional responses");
    const buffer=Buffer.from(XLSX.write(workbook,{type:"buffer",bookType:"xlsx"}));
    expect(parseInboundRows("Native Google Sheet","application/vnd.google-apps.spreadsheet",buffer)).toEqual([
      {"Company":"Acme","Custom need":"Printers"},
      {"Company":"Beta","Custom need":"Laptops"},
    ]);
  });
  it("routes by product, then category, then the client fallback",()=>{
    const base={keywords:[],journey_id:1,sequence_id:1};
    const rules=[
      {id:1,client_id:8,match_type:"category" as const,category_name:"Workplace",product_name:null,...base},
      {id:2,client_id:8,match_type:"product" as const,product_name:"Device as a Service",category_name:null,...base},
      {id:3,client_id:8,match_type:"fallback" as const,product_name:null,category_name:null,...base},
      {id:4,client_id:9,match_type:"fallback" as const,product_name:null,category_name:null,...base},
    ];
    expect(matchingInboundRoutingRule(rules,8,"Need Device as a Service for laptops")?.id).toBe(2);
    expect(matchingInboundRoutingRule(rules,8,"Workplace modernization")?.id).toBe(1);
    expect(matchingInboundRoutingRule(rules,8,"")?.id).toBe(3);
    expect(matchingInboundRoutingRule(rules,9,"")?.id).toBe(4);
  });
  it("matches inbound product and category rules using the dashboard taxonomy",()=>{
    const base={client_id:8,keywords:[],journey_id:1,sequence_id:1,product_name:null,category_name:null};
    const rules=[
      {id:1,match_type:"product" as const,inbound_product_name:"AI laptops",inbound_category_name:"IT Hardware",...base},
      {id:2,match_type:"category" as const,inbound_category_name:"Business Services",...base},
    ];
    expect(matchingInboundRoutingRule(rules,8,"Business notebooks for new hires")?.id).toBe(1);
    expect(matchingInboundRoutingRule(rules,8,"HP Managed Device Services")?.id).toBe(2);
    expect(matchingInboundRoutingRule(rules,8,"Poly Headsets")?.id).toBeUndefined();
    const options=inboundProductOptionsFromRows([
      {productAffinity:"HP Managed Device Services; Other need",affinityReviews:{}},
    ],{rules:[],useBuiltin:true});
    expect(options).toContainEqual({name:"Managed Device Service / Device as a Service",
      categoryName:"Business Services",subcategoryName:"Computing service"});
    expect(options).toContainEqual({name:"Other need",categoryName:"Needs categorization",subcategoryName:null});
  });
  it("keeps Hot and Warm affinity routing cohorts separate",()=>{
    const base={client_id:8,match_type:"product" as const,keywords:["HP Anyware Services"],journey_id:null,sequence_id:1,product_name:null,category_name:null};
    const rules=[
      {id:1,classification:"warm" as const,...base},
      {id:2,classification:"hot" as const,...base},
    ];
    expect(matchingInboundRoutingRule(rules,8,"HP Anyware Services","warm")?.id).toBe(1);
    expect(matchingInboundRoutingRule(rules,8,"HP Anyware Services","hot")).toBeUndefined();
  });
  it("routes a selected product through its catalog category without a literal category word",()=>{
    const catalog=[{id:2,name:"HP Managed Device Services",category:"Computing",subcategory:null}];
    const categoryRule={id:6,client_id:8,match_type:"category" as const,classification:"hot" as const,
      product_name:null,category_name:"Computing",keywords:[],journey_id:39,sequence_id:15};
    const fallback={...categoryRule,id:7,match_type:"fallback" as const,category_name:null};
    expect(matchingInboundRoutingRule([categoryRule,fallback],8,"HP Managed Device Services","hot",catalog)).toBeUndefined();
    expect(matchingInboundRoutingRule([categoryRule,fallback],8,"HP Managed Device Services","warm",catalog)?.id).toBeUndefined();
  });
  it("does not enroll pending responses into a sequence-only rule without a journey",async()=>{
    mocks.query.mockImplementation(async(sql:string)=>{
      if(sql.includes("FROM intent_inbound_category_rules"))return result([]);
      if(sql.includes("FROM intent_inbound_routing_rules"))return result([{
        id:6,client_id:8,match_type:"product",classification:"hot",keywords:[],
        product_name:"HP Security Services",category_name:null,journey_id:null,sequence_id:15,
      }]);
      if(sql.includes("FROM intent_inbound_submissions s"))return result([{
        id:42,client_id:8,contact_id:21,product_interest:"HP Security Services",affinity_reviews:{},
        classification:"hot",email:"contact@example.test",dnc:false,
      }]);
      throw new Error(`Unexpected query: ${sql}`);
    });
    expect(await routePendingWarmSubmissions(7)).toMatchObject({routed:0,pending:1,failed:0});
    expect(mocks.connect).not.toHaveBeenCalled();
    expect(mocks.query.mock.calls.find(([sql])=>String(sql).includes("FROM intent_inbound_routing_rules"))?.[0])
      .toContain("r.journey_id IS NOT NULL");
  });
});
