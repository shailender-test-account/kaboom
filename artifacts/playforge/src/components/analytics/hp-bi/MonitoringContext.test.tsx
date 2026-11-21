// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import MonitoringContext, { MonitoringSourceEvidence } from "./MonitoringContext";
import ActivityEvidenceDialog from "./ActivityEvidenceDialog";
import type { HpBiDetail } from "./types";
afterEach(cleanup);
const contexts: NonNullable<HpBiDetail["monitoringContext"]> = [1, 2].map(id => ({
  accountId: id, accountName: `Legal account ${id}`, lastCheckedAt: "2026-10-15T10:00:00Z", runStatus: "completed",
  takeaways: [{ category: "Business Services", product: "HP Device as a Service",
    takeaway: `Device lifecycle opportunity for account ${id}; requirement unconfirmed.`,
    recommendation: "Compare lifecycle costs and confirm the operational owner.", evidenceIds: [id] }],
  businessDirections: [{ theme: "Cost discipline", signal: `India account ${id} reports restructuring.`,
    direction: "Operating efficiency may become a priority.", evidenceIds: [id] }],
  sourceEvidence: [{ id, summary: `Original source excerpt for account ${id}`, sourceUrl: `https://example.com/${id}`,
    occurredAt: "2026-10-10T10:00:00Z", publishedAt: "2026-10-09" }],
  findings: [],
}));
describe("BI monitoring solution takeaways", () => {
  it("shows parent research first, retains separately labeled members and never links pending parent research to a member", () => {
    render(<MonitoringContext contexts={[{ ...contexts[0], researchScope: "member" }, {
      accountId: 1, accountName: "3M COMPANY - WW", researchScope: "parent", analysisAccountId: null,
      memberAccountIds: [1], lastCheckedAt: null, runStatus: null, findings: [],
    }]} />);
    expect(screen.getByText("Parent organization · roster grouping")).toBeTruthy();
    expect(screen.getByText("Member company · separate findings")).toBeTruthy();
    expect(screen.getByText(/Parent research pending/)).toBeTruthy();
    const pending=screen.getAllByTestId("card-monitoring-account-1").find(card=>card.textContent?.includes("Parent research pending"));
    expect(pending?.textContent).not.toContain("Potential HP fit");
    expect(screen.getAllByRole("link", { name: "Open Intent Engine analysis" })).toHaveLength(1);
    expect(screen.getAllByTestId("card-monitoring-account-1")[0].textContent).toContain("3M COMPANY");
  });
  it("shows product takeaways and actions with citations, not news bullets", () => {
    render(<MonitoringContext contexts={contexts} clientId={9} />);
    expect(screen.getAllByText("Business Services · HP Device as a Service")).toHaveLength(2);
    expect(screen.getAllByText("Compare lifecycle costs and confirm the operational owner.")).toHaveLength(2);
    expect(screen.getByText(/does not change BI leads/)).toBeTruthy();
    const citation = screen.getByRole("link", { name: "Read source excerpt 1 for Business Services" });
    expect(document.getElementById(citation.getAttribute("href")!.slice(1))?.textContent).toContain("Original source excerpt for account 1");
    expect(screen.getAllByRole("link", { name: "Open original source" })[0].getAttribute("href")).toBe("https://example.com/1");
    expect(screen.getAllByRole("link", { name: "Open Intent Engine analysis" })[0].getAttribute("href")).toBe("/intent/accounts/1?clientId=9#account-research-details");
  });
  it("keeps contact cards scoped to the linked legal account", () => {
    const person = { id: 10, companyId: 2, name: "Person", email: null, title: null, score: 0, isNew: false };
    const detail = { clientId: 9, account: {}, members: [{ id: 1, name: "Legal account 1" }, { id: 2, name: "Legal account 2" }],
      contacts: [person], monitoringContext: contexts } as HpBiDetail;
    render(<ActivityEvidenceDialog value={{ person }} detail={detail} onClose={() => {}} dateText={v => v} />);
    expect(screen.getByText(/Device lifecycle opportunity for account 2/)).toBeTruthy();
    expect(screen.queryByText(/Device lifecycle opportunity for account 1/)).toBeNull();
  });
  it("does not fabricate recommendations from legacy raw news", () => {
    render(<MonitoringContext contexts={[{ ...contexts[0], takeaways: [], sourceEvidence: [] }]} />);
    expect(screen.getByText(/No source-backed HP product recommendation/)).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Potential HP fit and pitch" })?.querySelector("li")).toBeNull();
  });
  it("supports excerpts at the bottom of the account while retaining precise citation targets", () => {
    render(<><MonitoringContext contexts={contexts} sourcePrefix="bottom" />
      <div>Rest of account</div><MonitoringSourceEvidence contexts={contexts} sourcePrefix="bottom" /></>);
    expect(screen.getByRole("link", { name: "Read source excerpt 1 for Business Services" }).getAttribute("href")).toBe("#bottom-1-1");
    expect(document.getElementById("bottom-1-1")?.textContent).toContain("Original source excerpt");
    expect(screen.getAllByLabelText("Monitoring source excerpts")).toHaveLength(2);
  });
  it("does not repeat a legal-account research card when the input contains duplicate accounts", () => {
    render(<MonitoringContext contexts={[contexts[0], contexts[0], contexts[0]]} />);
    expect(screen.getAllByTestId("card-monitoring-account-1")).toHaveLength(1);
    expect(screen.getAllByText("Business Services · HP Device as a Service")).toHaveLength(1);
  });
});
