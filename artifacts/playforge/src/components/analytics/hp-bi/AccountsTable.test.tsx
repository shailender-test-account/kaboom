// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import AccountsTable from "./AccountsTable";
import type { HpBiDashboard } from "./types";
import { hpBiQuery } from "./api";

afterEach(cleanup);
it("marks completed monitoring history and opens the account details",()=>{
  const onOpen=vi.fn();
  const row={...data.accounts[0],lastMonitoredAt:"2026-11-05T01:00:00.000Z",monitoringCheckedMembers:1};
  render(<AccountsTable data={{...data,accounts:[row]}} fetching={false} onOpen={onOpen} onPage={vi.fn()}/>);
  expect(screen.getByText("Monitoring history available")).toBeTruthy();
  fireEvent.click(screen.getByRole("button",{name:/View monitoring details for/}));
  expect(onOpen).toHaveBeenCalledTimes(1);
  expect(onOpen).toHaveBeenCalledWith(row.parentKey);
});
it("distinguishes historical touchpoints from zero selected-year activity",()=>{
  const row={...data.accounts[0],touchpoints:0,touchpointsAllDates:9};
  render(<AccountsTable data={{...data,accounts:[row]}} fetching={false} onOpen={vi.fn()} onPage={vi.fn()}/>);
  expect(screen.getByText("9 touchpoints · all dates")).toBeTruthy();
  expect(screen.queryByText("No engagement")).toBeNull();
});
it("shows actual form provenance, including both types, without a second qualification column", () => {
  const accounts = [
    { ...data.accounts[0], gtm: { formTypes: ["lead_form"] } },
    { ...data.accounts[0], id: 2, gtm: { formTypes: ["event_feedback"] } },
    { ...data.accounts[0], id: 3, gtm: { formTypes: ["event_feedback", "lead_form"] } },
  ];
  render(<AccountsTable data={{ ...data, accounts } as HpBiDashboard} fetching={false} onOpen={vi.fn()} onPage={vi.fn()} />);
  expect(screen.getByTestId("gtm-source-1").textContent).toBe("Lead Form");
  expect(screen.getByTestId("gtm-source-2").textContent).toBe("Event Feedback Form");
  expect(screen.getByTestId("gtm-source-3").textContent).toContain("Lead Form");
  expect(screen.getByTestId("gtm-source-3").textContent).toContain("Event Feedback Form");
  expect(screen.queryByRole("button", { name: "Sort by GTM qualification" })).toBeNull();
  expect(screen.getByTestId("flag-status-1")).toBeTruthy();
});
it("shows the assigned HP owners beside the account, including roles and subsidiary attribution", () => {
  const row = { id: 1, parentKey: "p", name: "Group", parentName: "Group", memberCount: 2,
    salesPeople: [{ role: "EAM", email: "supplied@hp.example", accounts: [{ id: 7, name: "Subsidiary One", hpId: "HP-7" }] }],
    contacts: 0, values: {}, score: 0 };
  render(<AccountsTable data={{ ...data, accounts: [row] } as HpBiDashboard} fetching={false} onOpen={vi.fn()} onPage={vi.fn()} />);
  expect(screen.getByTestId("th-hp-sales-person").textContent).toBe("HP salesperson");
  expect(screen.getByTestId("hp-sales-person-1").textContent).toContain("EAM: supplied@hp.example");
  expect(screen.getByTestId("hp-sales-person-1").textContent).toContain("Subsidiary One");
  expect(screen.queryByTestId("gtm-status-1")).toBeNull();
  expect(screen.getByTestId("gtm-source-1").textContent).toBe("No source response");
});
it("reports missing roster assignment without inventing a salesperson", () => {
  render(<AccountsTable data={data} fetching={false} onOpen={vi.fn()} onPage={vi.fn()} />);
  expect(screen.getByTestId("hp-sales-person-1").textContent).toBe("Not assigned in roster");
});
const data = { accounts: [{ id: 1, parentKey: "parent-one", parentName: "Parent One", name: "Parent One", memberCount: 1,
  contacts: 48, engagedContacts: 6, touchpoints: 9, leads: 2, hot: 2, opportunities: 0, closedWon: 0, closedLost: 0,
  values: {}, bookedValues: {}, score: 0 }], total: 1, page: 1, pageSize: 25 } as HpBiDashboard;
it("draws cell gridlines and prevents stale repeated page clicks while loading",()=>{
  const onPage=vi.fn();
  const paged={...data,page:2,pageSize:5,total:30};
  const view=render(<AccountsTable data={paged} fetching={true} onOpen={vi.fn()} onPage={onPage}/>);
  expect(screen.getByTestId("table-accounts").className).toContain("[&_td]:border");
  expect(screen.getByTestId("table-accounts").className).toContain("[&_th]:border");
  expect(screen.getByRole("status").textContent).toContain("Loading accounts");
  fireEvent.click(screen.getByRole("button",{name:"Next page"}));
  expect(onPage).not.toHaveBeenCalled();
  view.rerender(<AccountsTable data={paged} fetching={false} onOpen={vi.fn()} onPage={onPage}/>);
  fireEvent.click(screen.getByRole("button",{name:"Next page"}));
  expect(onPage).toHaveBeenCalledWith(3);
  fireEvent.click(screen.getByRole("button",{name:"Previous page"}));
  expect(onPage).toHaveBeenLastCalledWith(1);
});
it("keeps large parent owner cells compact without losing the remaining owners",()=>{
  const accounts=Array.from({length:30},(_,index)=>({id:index+1,name:`Member ${index+1}`,hpId:null}));
  const salesPeople=Array.from({length:8},(_,index)=>({role:"EAM",email:`owner${index}@hp.example`,accounts}));
  const row={...data.accounts[0],memberCount:30,salesPeople};
  const onOpen=vi.fn();
  render(<AccountsTable data={{...data,accounts:[row]}} fetching={false} onOpen={onOpen} onPage={vi.fn()}/>);
  const cell=screen.getByTestId("hp-sales-person-1");
  expect(cell.textContent).toContain("+28 more member accounts");
  const details=cell.querySelector("details")!;
  expect(details.open).toBe(false);
  fireEvent.click(screen.getByText("Show 6 more HP owners"));
  expect(onOpen).not.toHaveBeenCalled();
  expect(cell.textContent).toContain("owner7@hp.example");
});
it("opens each account metric directly without also opening the parent overview", () => {
  const onOpen = vi.fn(), onMetric = vi.fn();
  render(<AccountsTable data={data} fetching={false} onOpen={onOpen} onMetric={onMetric} onPage={vi.fn()} />);
  for (const metric of ["contacts", "engagedContacts", "touchpoints", "leads", "hot", "opportunities", "closedWon", "closedLost"]) {
    fireEvent.click(screen.getByTestId(`account-metric-1-${metric}`));
    expect(onMetric).toHaveBeenLastCalledWith("parent-one", metric);
  }
  expect(onOpen).not.toHaveBeenCalled();
  fireEvent.keyDown(screen.getByTestId("account-metric-1-hot"), { key: "Enter" });
  expect(onOpen).not.toHaveBeenCalled();
  fireEvent.click(screen.getByTestId("row-account-1"));
  expect(onOpen).toHaveBeenCalledWith("parent-one");
});
it("offers every column, reversible numeric/date sorting and accessible sort indicators", () => {
  const onSort = vi.fn();
  const { rerender } = render(<AccountsTable data={data} fetching={false} onOpen={vi.fn()} onPage={vi.fn()} onSort={onSort} />);
  fireEvent.click(screen.getByTestId("sort-account-score"));
  expect(onSort).toHaveBeenLastCalledWith("score", "desc");
  rerender(<AccountsTable data={data} fetching={false} onOpen={vi.fn()} onPage={vi.fn()} onSort={onSort} sortBy="score" sortDir="desc" />);
  expect(screen.getByTestId("sort-account-score").closest("th")?.getAttribute("aria-sort")).toBe("descending");
  fireEvent.click(screen.getByTestId("sort-account-score"));
  expect(onSort).toHaveBeenLastCalledWith("score", "asc");
  fireEvent.click(screen.getByTestId("sort-account-lastActivity"));
  expect(onSort).toHaveBeenLastCalledWith("lastActivity", "desc");
  fireEvent.change(screen.getByLabelText("Sort accounts by"), { target: { value: "name" } });
  expect(onSort).toHaveBeenLastCalledWith("name", "asc");
  expect(screen.getAllByTestId(/^sort-account-/)).toHaveLength(16);
});
it("offers all qualification choices and clears back to All",()=>{
  const onQualification=vi.fn();
  const {rerender}=render(<AccountsTable data={data} fetching={false} onOpen={vi.fn()} onPage={vi.fn()} onSort={vi.fn()} onQualification={onQualification}/>);
  const select=screen.getByLabelText("Filter account table by qualification");
  expect([...select.querySelectorAll("option")].map(option=>option.textContent)).toEqual(["All","Hot","Warm","Cold"]);
  fireEvent.change(select,{target:{value:"Warm"}});
  expect(onQualification).toHaveBeenLastCalledWith("Warm");
  rerender(<AccountsTable data={data} fetching={false} onOpen={vi.fn()} onPage={vi.fn()} onSort={vi.fn()} qualification="Warm" onQualification={onQualification}/>);
  fireEvent.change(screen.getByLabelText("Filter account table by qualification"),{target:{value:""}});
  expect(onQualification).toHaveBeenLastCalledWith(undefined);
});
it("sends sorting together with filters and pagination to the server", () => {
  const params = new URLSearchParams(hpBiQuery({ clientId: 9, year: 2026, search: "Account", sortBy: "lastActivity", sortDir: "asc",
    sortCurrency: "USD", page: 2, pageSize: 25,qualification:"Hot" }));
  for (const [key, value] of Object.entries({ clientId: "9", search: "Account", sortBy: "lastActivity", sortDir: "asc", sortCurrency: "USD", page: "2" }))
    expect(params.get(key)).toBe(value);
  expect(params.get("qualification")).toBe("Hot");
});
it("shows multiple routed journey names, honest pending/error states and journey sorting", () => {
  const onSort = vi.fn();
  const withJourneys = { ...data, accounts: [
    { ...data.accounts[0], journeys: [{ id: 4, name: "Security nurture" }, { id: 5, name: "Services nurture" }], pendingJourneyRoutes: 2 },
    { ...data.accounts[0], id: 2, parentKey: "parent-two", journeys: [], failedJourneyRoutes: 1 },
    { ...data.accounts[0], id: 3, parentKey: "parent-three", journeys: [], unavailableJourneyRoutes: 1 },
  ] };
  render(<AccountsTable data={withJourneys} fetching={false} onOpen={vi.fn()} onPage={vi.fn()} onSort={onSort} />);
  expect(screen.getByTestId("account-journeys-1").textContent).toContain("Security nurture");
  expect(screen.getByTestId("account-journeys-1").textContent).toContain("Services nurture");
  expect(screen.getByTestId("account-journeys-1").textContent).toContain("2 responses not routed");
  expect(screen.getByTestId("account-journeys-2").textContent).toContain("Routing error");
  expect(screen.getByTestId("account-journeys-3").textContent).toContain("Routed journey unavailable");
  fireEvent.click(screen.getByTestId("sort-account-journey"));
  expect(onSort).toHaveBeenCalledWith("journey", "asc");
});
it("shows datewise labels and explicit currency selection for amounts", () => {
  const onSort = vi.fn(), onCurrency = vi.fn();
  const { rerender } = render(<AccountsTable data={data} fetching={false} onOpen={vi.fn()} onPage={vi.fn()} onSort={onSort} sortBy="lastActivity" />);
  expect(screen.getByRole("option", { name: "Newest first" })).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Account sort order"), { target: { value: "asc" } });
  expect(onSort).toHaveBeenLastCalledWith("lastActivity", "asc");
  rerender(<AccountsTable data={{ ...data, sortCurrencies: ["INR", "USD"] }} fetching={false} onOpen={vi.fn()} onPage={vi.fn()} onSort={onSort}
    sortBy="values" onSortCurrency={onCurrency} />);
  fireEvent.change(screen.getByLabelText("Currency for amount sorting"), { target: { value: "USD" } });
  expect(onCurrency).toHaveBeenCalledWith("USD");
});
it("shows last monitored date, partial parent coverage and unmonitored rows", () => {
  const rows = [{ ...data.accounts[0], id: 5, memberCount: 3, lastMonitoredAt: "2025-03-04T20:00:00Z", monitoringCheckedMembers: 1, monitoringTotalMembers: 3 },
    { ...data.accounts[0], id: 6, lastMonitoredAt: null }];
  render(<AccountsTable data={{ ...data, accounts: rows } as HpBiDashboard} fetching={false} onOpen={vi.fn()} onPage={vi.fn()} />);
  const partial = screen.getByTestId("text-last-monitored-5");
  expect(partial.textContent).toContain("05 Mar 2025");
  expect(partial.textContent).toContain("1/3 checked");
  expect(partial.title).toContain("01:30 GMT+05:30");
  expect(partial.title).toContain("latest member date");
  expect(screen.getByTestId("text-last-monitored-6").textContent).toBe("No completed monitoring history");
});
