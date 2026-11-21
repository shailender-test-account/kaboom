// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import OverviewView from "./OverviewView";
import type { HpBiDashboard } from "./types";

vi.mock("recharts", () => Object.fromEntries(["Bar", "CartesianGrid", "ComposedChart", "Line", "ResponsiveContainer",
  "Tooltip", "XAxis", "YAxis", "Legend"].map(name => [name, () => null])));
const fixture = (lifecycle?: HpBiDashboard["summary"]["dealLifecycle"]) => ({
  year: 2026, summary: { accounts: 0, parentAccounts: 0, newAccounts: 0, contacts: 0, newContacts: 0,
    engagedContacts: 0, engagedAccounts: 0, touchpoints: 0, leads: 0, hot: 0, warm: 0, opportunities: 0,
    values: {}, prospectiveValues: {}, bookedValues: {}, score: null, dealLifecycle: lifecycle },
  quality: {}, segments: [], rads: [], months: [], quarters: [], categories: [], accounts: [],
}) as unknown as HpBiDashboard;
const markup = (data: HpBiDashboard) => renderToStaticMarkup(<OverviewView data={data} pageHint="" onEvidence={() => {}} onMetric={() => {}} />);

describe("HP dashboard deal cards", () => {
  it("opens matching evidence on every stage click, including repeated clicks and zero counts", () => {
    const onEvidence = vi.fn();
    render(<OverviewView data={fixture()} pageHint="" onEvidence={onEvidence} onMetric={() => {}} />);
    for (const [label, kind] of [["Touchpoints", "touchpoint"], ["Engaged contacts", "engaged_contacts"],
      ["Actual leads", "lead"], ["Hot leads", "hot"], ["Opportunities", "opportunity"]]) {
      const button = screen.getByRole("button", { name: `View ${label.toLowerCase()} records (0)` });
      fireEvent.click(button);
      expect(onEvidence).toHaveBeenLastCalledWith({ title: label, kind });
      fireEvent.click(button);
      expect(onEvidence).toHaveBeenLastCalledWith({ title: label, kind });
    }
    expect(onEvidence).toHaveBeenCalledTimes(10);
    cleanup();
  });
  it("renders all four metrics and their definitions", () => {
    const html = markup(fixture({ asOfDate: "2026-10-31", openDeals: 3, avgOpenDealAge: 20,
      avgDaysToClose: 12.5, closedDurationSamples: 2, winRate: 75, closedOutcomes: 4 }));
    for (const id of ["avg-days-to-close", "win-rate", "open-deals", "avg-open-deal-age"]) expect(html).toContain(`kpi-${id}`);
    expect(html).toContain("12.5 days");
    expect(html).toContain("75%");
    expect(html).toContain("20 days");
    expect(html).toContain("Open as of 2026-10-31");
    expect(html).toContain("expected close dates are not used");
  });
  it("does not turn missing durations or an undefined win rate into zero", () => {
    const html = markup(fixture());
    expect(html.match(/Not available/g)).toHaveLength(4);
    expect(html).not.toContain(">0%<");
    expect(html).not.toContain(">0 days<");
  });
});
