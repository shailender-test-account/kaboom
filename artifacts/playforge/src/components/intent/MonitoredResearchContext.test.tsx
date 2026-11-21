// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import MonitoredResearchContext from "./MonitoredResearchContext";
afterEach(cleanup);
const context = {
  kind: "expansion" as const, label: "Workplace expansion · validate needs",
  summary: "Raw news headline should not be the takeaway",
  analysisPoints: ["Legacy copied news paragraph"],
  takeaways: [{ category: "IT Hardware", product: "HP business PCs",
    takeaway: "New workplace may require endpoints; net-new demand unconfirmed.",
    recommendation: "Confirm users, owner and rollout timing.", pitch: "Match devices to the actual roles.", evidenceIds: [1] }],
  businessDirections: [{ theme: "Infrastructure", signal: "India site investment reported.",
    direction: "Capacity build-out may follow.", evidenceIds: [1] }],
  possibleNeeds: [],
  evidence: [{ id: 1, summary: "Original India office announcement", occurredAt: "2026-10-09", publishedAt: "2026-10-08", sourceUrl: "https://example.com/source" }],
  nextAction: "Validate the operational requirement.",
  caution: "Research context only—not confirmed buying intent.",
};
describe("monitored HP solution takeaways", () => {
  it("shows actionable product bullets on cards with links to account-bottom excerpts, not copied headlines", () => {
    render(<MonitoredResearchContext context={context} sourcePage="/intent/accounts/1" />);
    expect(screen.getByText("IT Hardware · HP business PCs")).toBeTruthy();
    expect(screen.getByText("Confirm users, owner and rollout timing.")).toBeTruthy();
    expect(screen.queryByText(context.summary)).toBeNull();
    expect(screen.queryByText(context.analysisPoints[0])).toBeNull();
    expect(screen.queryByText("Original India office announcement")).toBeNull();
    expect(screen.getByRole("link", { name: "Read source excerpt 1 for IT Hardware" }).getAttribute("href")).toBe("/intent/accounts/1#research-source-1");
    expect(screen.getByText("Match devices to the actual roles.")).toBeTruthy();
    expect(screen.getByRole("region", { name: "Business signals and likely direction" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Potential HP fit and pitch" })).toBeTruthy();
  });
  it("shows cited original excerpts, actual publication dates and original-source links at the bottom", () => {
    render(<MonitoredResearchContext context={context} detailed />);
    expect(document.getElementById("research-source-1")?.textContent).toContain("Original India office announcement");
    expect(screen.getByRole("link", { name: "Open original source" }).getAttribute("href")).toBe("https://example.com/source");
    expect(screen.queryByText("IT Hardware · HP business PCs")).toBeNull();
    expect(screen.queryByText("Capacity build-out may follow.")).toBeNull();
  });
  it("does not present unsafe links, raw legacy analysis or unsubstantiated recommendations", () => {
    render(<MonitoredResearchContext context={{ ...context, takeaways: [], evidence: [{ ...context.evidence[0], sourceUrl: "javascript:alert(1)" }] }} detailed />);
    expect(screen.queryByText(/No source-backed HP product recommendation/)).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.queryByText(context.summary)).toBeNull();
  });
  it("keeps a distinct cited interpretation and pitch with each individual source",()=>{
    render(<MonitoredResearchContext context={{...context,evidence:[{...context.evidence[0],
      businessDirections:context.businessDirections,takeaways:context.takeaways,
      analysisNote:"The article was read; device volumes and budget remain unconfirmed."}]}} detailed />);
    expect(screen.getByText("This news: interpretation & HP entry pitch")).toBeTruthy();
    expect(screen.getByText("Capacity build-out may follow.")).toBeTruthy();
    expect(screen.getByText("Match devices to the actual roles.")).toBeTruthy();
    expect(screen.getByText(/device volumes and budget remain unconfirmed/)).toBeTruthy();
  });
});
