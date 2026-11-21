// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import MonitoringQualityWarning from "./MonitoringQualityWarning";
import MonitoringBatchAccounts from "./MonitoringBatchAccounts";
import MonitoringHistoryAccounts from "./MonitoringHistoryAccounts";

const state = vi.hoisted(() => ({ batch: {} as any, history: {} as any }));
vi.mock("@workspace/api-client-react", () => ({
  useGetMonitoringBatchAccounts: () => state.batch,
  useGetMonitoringHistoryAccounts: () => state.history,
}));
afterEach(cleanup);
const quality = { accountId: 123, assessedCount: 2, usableCount: 0, excludedCount: 2,
  exclusions: [{ reason: "source_furniture", label: "Directory or index, not account news", count: 2 }] };
it("shows an actionable source warning separately from completion, with reasons and no research action", () => {
  render(<MonitoringQualityWarning quality={quality}/>);
  expect(screen.getByText("Completed check · no usable business news")).toBeTruthy();
  expect(screen.getByText("Directory or index, not account news: 2")).toBeTruthy();
  expect(screen.getByRole("link").getAttribute("href")).toBe("/intent/accounts/123");
  expect(screen.getByText(/Provider completion and intent are unchanged/)).toBeTruthy();
  expect(screen.queryByRole("button")).toBeNull();
});
it("distinguishes zero saved sources from exclusions and suppresses warnings for usable or absent quality", () => {
  const { rerender } = render(<MonitoringQualityWarning quality={{ ...quality, assessedCount: 0, excludedCount: 0, exclusions: [] }}/>);
  expect(screen.getByText(/No business articles were saved/)).toBeTruthy();
  expect(screen.queryByRole("list")).toBeNull();
  rerender(<MonitoringQualityWarning quality={{ ...quality, usableCount: 1 }}/>);
  expect(screen.queryByLabelText("Research quality warning")).toBeNull();
  rerender(<MonitoringQualityWarning/>);
  expect(screen.queryByLabelText("Research quality warning")).toBeNull();
});
it("renders the warning in both selected-run and daily account views with parent analysis links", () => {
  state.batch = { data: { totalAccounts: 1, items: [{
    accountId: 456, accountName: "Member", available: true, status: "completed", provider: "tavily",
    completedAt: "2026-11-03T00:00:00Z", runId: 10, researchQuality: quality,
  }] } };
  const { unmount } = render(<MonitoringBatchAccounts selection={{ configId: 1, runId: 10, scheduleName: "HP daily", status: "completed" }} onClose={() => {}}/>);
  expect(screen.getByLabelText("Research quality warning")).toBeTruthy();
  expect(screen.getByText(/completed · tavily/)).toBeTruthy();
  expect(screen.getByText("Review saved sources and exclusions in account analysis").getAttribute("href")).toBe("/intent/accounts/123");
  unmount();
  state.history = { data: { totalAccounts: 1, totalChecks: 1, items: [{
    accountId: 123, accountName: "Parent", completedChecks: 1, failedChecks: 1, attempts: [
      { runId: 9, status: "failed", provider: "tavily", completedAt: "2026-11-03T00:00:00Z" },
      { runId: 10, status: "completed", provider: "perplexity", completedAt: "2026-11-03T01:00:00Z", researchQuality: quality },
    ],
  }] } };
  render(<MonitoringHistoryAccounts date="2026-11-03" status="completed" scheduleName="HP daily" onClose={() => {}}/>);
  expect(screen.getAllByLabelText("Research quality warning")).toHaveLength(1);
  expect(screen.getByText(/tavily · failed/)).toBeTruthy();
  expect(screen.getByText(/perplexity · completed/)).toBeTruthy();
});
