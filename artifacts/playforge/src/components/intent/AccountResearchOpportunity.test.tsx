// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import AccountResearchOpportunity from "./AccountResearchOpportunity";

afterEach(cleanup);
describe("account detail research opportunity action", () => {
  it("shows only news and interpretation while hiding the HP product-fit card", () => {
    const categories=["IT Hardware","Business Collaboration","Security","Business Services"];
    render(<AccountResearchOpportunity name="Account" context={{
      kind:"business_context",label:"Context",summary:"India operating change",nextAction:"Validate scope",
      caution:"Hypotheses only",possibleNeeds:[],
      evidence:[{id:1,summary:"Account India announced an office and endpoint-control change.",sourceUrl:"https://example.com/news",occurredAt:"2026-10-29"}],
      businessDirections:[{theme:"Workplace modernization",signal:"India workplace change.",direction:"Endpoint and room readiness may need review.",evidenceIds:[1]}],
      takeaways:categories.map((category,index)=>({category,product:`HP solution ${index+1}`,takeaway:`Relevant operational dependency ${index+1}`,
        recommendation:`Confirm owner and scope ${index+1}`,pitch:`Discovery entry pitch ${index+1}?`,evidenceIds:[1]})),
    }} />);
    expect(screen.getAllByRole("article")).toHaveLength(2);
    expect(screen.queryByRole("article",{name:"Potential HP Product Fit"})).toBeNull();
    expect(screen.queryByText("Discovery entry pitch 1?")).toBeNull();
    expect(screen.getByRole("link",{name:"Read source excerpt 1 for Workplace modernization"})).toBeTruthy();
    expect(screen.getByRole("article",{name:"Key Interpretation of News"}).textContent).toContain("readiness may need review");
  });
  it("opens and closes the needs-validation guide without declaring qualification or sending outreach", () => {
    render(<AccountResearchOpportunity name="D E Shaw Development India" context={{
      kind: "expansion", label: "Workplace expansion · validate needs",
      summary: "New Hyderabad office: 600,000 square feet; expected in 2027.",
      possibleNeeds: ["Meeting-room equipment"], evidence: [],
      nextAction: "Validate fit-out timing with procurement.",
      caution: "Research only—not confirmed buying intent.",
    }} />);
    expect(screen.getAllByRole("article")).toHaveLength(2);
    expect(screen.queryByText("Business direction & solution opportunity")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Validate needs" }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByRole("dialog").textContent).toContain("600,000");
    expect(screen.getByText(/nothing is saved, no outreach is sent/)).toBeTruthy();
    expect(screen.getByText(/Confirm the site opening/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close guide" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("shows two explanatory cards without inventing news when research is absent", () => {
    render(<AccountResearchOpportunity name="Unmonitored account" />);
    expect(screen.getByRole("article", { name: "Key News" })).toBeTruthy();
    expect(screen.getByRole("article", { name: "Key Interpretation of News" })).toBeTruthy();
    expect(screen.queryByRole("article", { name: "Potential HP Product Fit" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Validate needs" })).toBeNull();
    expect(screen.getByText(/No usable account-specific news is available to interpret/)).toBeTruthy();
  });
  it("does not repeat the same news or source URL in the news bullets", () => {
    const source = { id: 1, summary: "India site expansion announced.", sourceUrl: "https://example.com/news", occurredAt: "2026-10-29" };
    render(<AccountResearchOpportunity name="Account" context={{
      kind: "business_context", label: "Context", summary: "Context", nextAction: "Validate", caution: "Research only", possibleNeeds: [],
      evidence: [source, { ...source, id: 2 }, { ...source, id: 3, summary: "Another excerpt from the same report." }],
    }} />);
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    expect(screen.getByRole("link", { name: "Read excerpt [1]" }).getAttribute("href")).toBe("#research-source-1");
  });
  it("retains source-specific saved interpretation when the account roll-up is empty", () => {
    render(<AccountResearchOpportunity name="Account" lastCheckedAt="2026-11-05" context={{
      kind:"business_context",label:"Context",summary:"India expansion",nextAction:"Validate",caution:"Research only",possibleNeeds:[],
      evidence:[{id:1,summary:"Account announced an India expansion.",sourceUrl:"https://example.com/news",occurredAt:"2026-11-05",
        analysisNote:"The announcement suggests an operational scaling discussion; procurement is not established."}],
    }}/>);
    expect(screen.getByRole("article",{name:"Key Interpretation of News"}).textContent).toContain("operational scaling discussion");
    expect(screen.getByTestId("research-completion-status").textContent).toContain("1 usable saved source");
  });
  it("shows stored source analysis instead of a generic no-direction message while deep analysis is pending", () => {
    render(<AccountResearchOpportunity name="Account" context={{
      kind:"business_context",label:"Context",summary:"India expansion",nextAction:"Validate",caution:"Research only",possibleNeeds:[],
      evidence:[{id:1,summary:"Account announced an India expansion.",sourceUrl:"https://example.com/news",occurredAt:"2026-11-05"}],
      analysisPoints:["Source fact: India office expansion.", "Operational implication: validate the affected teams."],
    }}/>);
    expect(screen.getByText("Operational implication: validate the affected teams.")).toBeTruthy();
    expect(screen.getByText(/pending analysis, not a finding of no business direction/)).toBeTruthy();
  });
  it("explains completed checks with excluded findings without fabricating a successful news result", () => {
    render(<AccountResearchOpportunity name="Account" lastCheckedAt="2026-11-05" context={{
      kind:"no_recent_findings",label:"No recent findings",summary:"No usable account news was found.",nextAction:"Review coverage",caution:"Research only",possibleNeeds:[],evidence:[],
      diagnostics:{assessedCount:41,excludedCount:41,usableCount:0,storedFindingCount:41,truncated:false,unverifiedPublicationDateCount:0,
        insufficientOperationalEvidenceCount:0,exclusions:[{reason:"wrong_account",label:"Source does not establish this account",count:41}]},
    }}/>);
    expect(screen.getByTestId("research-completion-status").textContent).toContain("Completion does not guarantee relevant news");
    expect(screen.getByRole("article",{name:"Key News"}).textContent).toContain("41 saved findings assessed; 41 excluded");
    expect(screen.getByRole("article",{name:"Key Interpretation of News"}).textContent).toContain("No usable account news was found");
  });
});
