// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import MonitoringHistory from "./MonitoringHistory";

const state = vi.hoisted(() => ({ result: {} as any, calls: [] as any[], accountCalls: [] as any[], accounts: {} as any, refetch: vi.fn() }));
vi.mock("@workspace/api-client-react", () => ({
  getGetMonitoringHistoryQueryKey: (p: any) => ["history", p],
  useGetMonitoringHistory: (p: any, o: any) => { state.calls.push([p, o]); return { refetch: state.refetch, ...state.result }; },
  useGetMonitoringHistoryAccounts: (p: any) => { state.accountCalls.push(p); return { refetch: state.refetch, ...state.accounts }; },
}));
afterEach(() => { cleanup(); state.calls = []; state.result = {}; state.accounts = {}; state.accountCalls = []; state.refetch.mockClear(); });
const schedules = [{ id: 4, name: "HP daily" }];

it("shows zero totals and an empty state", () => {
  state.result = { data: { timeZone: "Asia/Kolkata", days: 30, totalCompletedAccounts: 0, totalCompletedChecks: 0, totalFailedChecks: 0, items: [] } };
  render(<MonitoringHistory schedules={schedules} />);
  expect(screen.getByTestId("text-history-total-accounts").textContent).toBe("0");
  expect(screen.getByTestId("history-empty")).toBeTruthy();
  expect(state.calls[0][0]).toEqual({ days: 30 });
  expect(state.calls[0][1].query.refetchInterval).toBe(30000);
});
it("opens summary cards across the entire selected date range", () => {
  state.result = { data: { totalCompletedAccounts: 2, totalCompletedChecks: 3, totalFailedChecks: 1,
    items: [{date:"2026-10-29",completedAccounts:1,completedChecks:2,failedChecks:1},
      {date:"2026-10-28",completedAccounts:1,completedChecks:1,failedChecks:0}] } };
  state.accounts = { data: {totalAccounts:2,totalChecks:3,items:[]} };
  render(<MonitoringHistory schedules={schedules}/>);
  fireEvent.click(screen.getByLabelText("View unique accounts completed in selected range"));
  expect(state.accountCalls.at(-1)).toMatchObject({date:"2026-10-28",endDate:"2026-10-29",status:"completed",page:1});
  fireEvent.click(screen.getByLabelText("View completed checks in selected range"));
  expect(state.accountCalls.at(-1)).toMatchObject({endDate:"2026-10-29",status:"completed"});
  fireEvent.click(screen.getByLabelText("View failed checks in selected range"));
  expect(state.accountCalls.at(-1)).toMatchObject({date:"2026-10-28",endDate:"2026-10-29",status:"failed"});
});
it("shows loading skeleton and error retry", () => {
  state.result = { isLoading: true };
  render(<MonitoringHistory schedules={schedules} />);
  expect(screen.getByTestId("history-loading")).toBeTruthy();
  cleanup(); state.result = { isError: true };
  render(<MonitoringHistory schedules={schedules} />);
  fireEvent.click(screen.getByTestId("button-history-retry"));
  expect(state.refetch).toHaveBeenCalled();
});
it("explains zero activity even when the API supplies calendar rows", () => {
  state.result = { data: { totalCompletedAccounts:0,totalCompletedChecks:0,totalFailedChecks:0,
    items:[{date:"2026-10-29",completedAccounts:0,completedChecks:0,failedChecks:0}] } };
  render(<MonitoringHistory schedules={schedules}/>);
  expect(screen.getByTestId("history-no-activity")).toBeTruthy();
  expect(screen.getByTestId("row-history-2026-10-29")).toBeTruthy();
});
it("passes schedule and range filters and pages rows at 10", () => {
  const items = Array.from({ length: 12 }, (_, i) => ({ date: `2025-03-${String(i + 1).padStart(2, "0")}`, completedAccounts: 2, completedChecks: 3, failedChecks: 1 }));
  state.result = { data: { timeZone: "Asia/Kolkata", days: 30, totalCompletedAccounts: 5, totalCompletedChecks: 36, totalFailedChecks: 12, items } };
  render(<MonitoringHistory schedules={schedules} />);
  expect(screen.getAllByTestId(/^row-history-/)).toHaveLength(10);
  expect(screen.getByTestId("row-history-2025-03-12")).toBeTruthy();
  fireEvent.click(screen.getByTestId("button-history-next"));
  expect(screen.getAllByTestId(/^row-history-/)).toHaveLength(2);
  fireEvent.change(screen.getByTestId("select-history-schedule"), { target: { value: "4" } });
  fireEvent.click(screen.getByTestId("button-history-days-7"));
  expect(state.calls.at(-1)[0]).toEqual({ days: 7, configId: 4 });
});
it("opens completed/failed accounts with scoped pagination, analysis links and resets on scope changes", () => {
  state.result={data:{items:[{date:"2026-10-29",completedAccounts:21,completedChecks:22,failedChecks:1}]}};
  state.accounts={data:{totalAccounts:21,totalChecks:22,items:[{
    accountId:5,accountName:"Example account",completedChecks:2,failedChecks:1,
    attempts:[{runId:10,provider:"tavily",status:"failed",completedAt:"2026-10-29T00:00:00Z"},
      {runId:11,provider:"perplexity",status:"completed",completedAt:"2026-10-29T01:00:00Z"}],
  }]}};
  render(<MonitoringHistory schedules={schedules}/>);
  expect(state.accountCalls).toHaveLength(0);
  fireEvent.change(screen.getByLabelText("Schedule"),{target:{value:"4"}});
  fireEvent.click(screen.getByLabelText("View completed accounts for 2026-10-29"));
  expect(state.accountCalls.at(-1)).toEqual({date:"2026-10-29",status:"completed",configId:4,page:1,pageSize:20});
  expect(screen.getByRole("link").getAttribute("href")).toBe("/intent/accounts/5");
  expect(screen.getByText(/tavily · failed/)).toBeTruthy();
  expect(screen.getByText(/perplexity · completed/)).toBeTruthy();
  fireEvent.click(screen.getByLabelText("Next account page"));
  expect(state.accountCalls.at(-1).page).toBe(2);
  fireEvent.click(screen.getByLabelText("View failed checks for 2026-10-29"));
  expect(state.accountCalls.at(-1)).toMatchObject({status:"failed",page:1});
  fireEvent.click(screen.getByText("Close account list"));
  expect(screen.queryByTestId("history-accounts")).toBeNull();
  fireEvent.click(screen.getByLabelText("View completed checks for 2026-10-29"));
  fireEvent.click(screen.getByTestId("button-history-days-7"));
  expect(screen.queryByTestId("history-accounts")).toBeNull();
});
it("shows loading, reloadable errors and empty account pages without triggering research", () => {
  state.result={data:{items:[{date:"2026-10-29",completedAccounts:1,completedChecks:1,failedChecks:0}]}};
  state.accounts={isLoading:true};
  render(<MonitoringHistory schedules={schedules}/>);
  expect((screen.getByLabelText("View failed checks for 2026-10-29") as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByLabelText("View completed accounts for 2026-10-29"));
  expect(screen.getByText("Loading accounts…")).toBeTruthy();
  state.accounts={isError:true};
  fireEvent.click(screen.getByLabelText("View completed checks for 2026-10-29"));
  fireEvent.click(screen.getByText("Reload account list"));
  expect(state.refetch).toHaveBeenCalledOnce();
  state.accounts={data:{totalAccounts:0,totalChecks:0,items:[]}};
  fireEvent.click(screen.getByLabelText("View completed accounts for 2026-10-29"));
  expect(screen.getByText("No accounts on this page.")).toBeTruthy();
});
