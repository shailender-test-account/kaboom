import {expect,it} from "vitest";
import {monitoredAccountContext,type MonitoringFinding} from "./monitoredAccountContext";
import {monitoringBusinessDirections} from "./monitoringBusinessDirections";
import {monitoringFindingAnalysis} from "./monitoringFindingAnalysis";

const now=new Date("2026-11-04T00:00:00Z");
function source(excerpt:string,url="https://example.com/news/india-summit"):MonitoringFinding{
  return {id:1,excerpt,sourceUrl:url,occurredAt:"2026-10-01T00:00:00Z",reviewStatus:"approved",
    eventType:"partnership",context:{scope:{country:"India"},publishedDate:"2026-10-01"},
    raw_evidence:{excerpt,context:{publishedDate:"2026-10-01"}}};
}
const account={name:"Concentrix",clientName:"HP"};
it("retains joint story citations without requiring one quotation to occur in both articles",()=>{
  const a=source("Concentrix India announced engineering automation for a Pune product team.","https://example.com/product");
  const b={...source("Concentrix India established customer voice operations in Hyderabad for regulated banking support.","https://example.com/voice"),id:2};
  const usable=monitoringFindingAnalysis([a,b],now,account).findings;
  const point={theme:"Joint operating direction",signal:"Engineering and service workflows are developing in India.",
    direction:"Validate the distinct workloads before proposing endpoints.",sourceQuote:a.excerpt,sourceUrls:[a.sourceUrl!,b.sourceUrl!]};
  expect(monitoringBusinessDirections(usable,[point]).find(p=>p.theme===point.theme)?.evidenceIds).toEqual([1,2]);
  expect(monitoringBusinessDirections(usable,[{...point,sourceQuote:"An invented quote not present in either article."}])
    .some(p=>p.theme===point.theme)).toBe(false);
});
it("interprets Bentley's India AI engineering direction without equating hiring or cloud AI with an order",()=>{
  const finding=source("Bentley Systems Engineering India is seeking an engineering manager to lead our AI Acceleration team in Pune, moving practical AI ideas into secure product capabilities for infrastructure design.");
  const before=JSON.stringify(finding);
  const context=monitoredAccountContext([finding],now,{name:"BENTLEY SYSTEMS",clientName:"HP"});
  expect(context.businessDirections.some(p=>p.theme==="AI engineering & product development")).toBe(true);
  expect(context.takeaways?.find(p=>p.category==="IT Hardware")?.pitch).toContain("benchmark HP Z");
  expect(context.takeaways?.find(p=>p.category==="IT Hardware")?.recommendation).toContain("cloud-versus-local");
  expect(context.evidence[0].takeaways[0].evidenceIds).toEqual([1]);
  expect(JSON.stringify(finding)).toBe(before);
});
it("retains per-story interpretation beyond the first five sources",()=>{
  const topics=["bridge deck structural analysis load distribution", "rail signalling timetables passenger safety controls",
    "water drainage flood prediction rainfall networks","energy grid transmission substation fault diagnosis",
    "airport terminal passenger movement baggage handling","industrial factory maintenance robotic assembly throughput",
    "highway lane junction traffic routing congestion"];
  const findings=Array.from({length:7},(_,i)=>({...source(
    `Bentley Systems India engineers develop AI automation for ${topics[i]}.`,
    `https://example.com/bentley-${i}`),id:i+1}));
  const context=monitoredAccountContext(findings,now,{name:"Bentley Systems",clientName:"HP"});
  // Distinct stories can share a theme, but each source retains its own cited analysis.
  for(const evidence of context.evidence) {
    expect(evidence.businessDirections.length).toBeGreaterThan(0);
    expect(evidence.takeaways[0].evidenceIds).toEqual([evidence.id]);
  }
  expect(context.evidence.length).toBeGreaterThan(5);
});
it("derives cited commercial hypotheses from a saved India event without asserting procurement",()=>{
  const finding=source("Concentrix joins the Credit & Collections Summit India 2026 in Mumbai as Silver Partner.");
  const original=JSON.stringify(finding);
  const context=monitoredAccountContext([finding],now,account);
  expect(context.evidence).toHaveLength(1);
  expect(context.businessDirections[0].theme).toBe("Market positioning");
  expect(context.businessDirections[0].direction).toContain("not an operational requirement");
  expect(context.takeaways?.map(point=>point.category).sort()).toEqual(["Business Collaboration","Security"]);
  expect(context.takeaways?.every(point=>point.evidenceIds.includes(1)&&point.pitch&&point.recommendation)).toBe(true);
  expect(JSON.stringify(finding)).toBe(original);
});
it("does not force HP recommendations for an unrelated event audience or a different client",()=>{
  const finding=source("Concentrix is the Silver Partner of the India Retail Summit in Mumbai.");
  expect(monitoredAccountContext([finding],now,account).takeaways).toEqual([]);
  expect(monitoredAccountContext([finding],now,{...account,clientName:"Other"}).takeaways).toBeUndefined();
});
it("does not infer sponsorship or an HP pitch from a denial",()=>{
  const context=monitoredAccountContext([source("Concentrix is not a sponsor of the India Credit & Collections Summit in Mumbai.")],now,account);
  expect(context.businessDirections).toEqual([]);
  expect(context.takeaways).toEqual([]);
});
it("does not treat a syndicated company-news index as a single attributable event",()=>{
  const finding=source("Concentrix India news: acquisitions, product announcements and financial results.",
    "https://in.tradingview.com/symbols/FWB-CO8/news/");
  const context=monitoredAccountContext([finding],now,account);
  expect(context.evidence).toHaveLength(0);
  expect(context.diagnostics.exclusions.some(item=>item.reason==="source_furniture")).toBe(true);
});
it("interprets Genpact's India regulatory news without inventing capex or a security incident",()=>{
  const finding=source("The Karnataka High Court has upheld the Enforcement Directorate’s seizure of Genpact India’s Gurugram head office while directing reconsideration of a No Objection Certificate (NOC) for a proposed $100-million investment in GIFT City.",
    "https://www.moneycontrol.com/news/business/genpact-india-court-decision.html");
  const context=monitoredAccountContext([finding],now,{name:"GENPACT",clientName:"HP"});
  expect(context.evidence).toHaveLength(1);
  expect(context.businessDirections.some(point=>point.theme==="Regulatory constraints & investment timing")).toBe(true);
  expect(context.takeaways?.find(point=>point.category==="Business Services")).toMatchObject({evidenceIds:[1]});
  expect(context.takeaways?.find(point=>point.category==="Business Services")?.pitch).toContain("If the proposed India investment proceeds");
  expect(context.takeaways?.some(point=>point.category==="Security")).toBe(false);
});
it("does not let recently refreshed vacancy directories crowd out actual business articles",()=>{
  const jobs=Array.from({length:6},(_,index)=>({...source(
    "Genpact Careers India: current finance jobs and open roles in India.",
    `https://jobs${index}.example.com/companies/genpact-jobs`),id:index+10}));
  const news={...source("Genpact India faces a court decision on a proposed investment requiring approval in GIFT City.",
    "https://example.com/business/genpact-investment.html"),occurredAt:"2026-09-19T00:00:00Z",
    context:{publishedDate:"2026-09-19"}};
  const context=monitoredAccountContext([...jobs,news],now,{name:"Genpact",clientName:"HP"});
  expect(context.evidence.map(point=>point.id)).toEqual([1]);
  expect(context.businessDirections.some(point=>point.theme==="Regulatory constraints & investment timing")).toBe(true);
});
