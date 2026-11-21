// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import SalesDashboardPage from "./sales-dashboard";

const state = vi.hoisted(() => ({
  user: { role: "viewer", sectionPermissions: { sales: "manage" } } as any,
  list: vi.fn(), options: vi.fn(), hot: vi.fn(), visibility: "all" as "all" | "owned",
}));
vi.mock("@/contexts/AuthContext", () => ({ useAuthContext: () => ({user: state.user}) }));
vi.mock("@/hooks/use-sales-feedback", () => ({
  useFeedbackList: (filters: any) => { state.list(filters); return {data:{items:[],total:0,page:1,pageSize:25}}; },
  useFeedbackOptions: (...args: any[]) => { state.options(...args); return {data:{
    clients:[{id:2,name:"HP"}],products:[],googleDriveConnected:false,
    accounts:[{id:11,clientId:2,name:"Saved account"}],
    contacts:[{id:21,clientId:2,companyId:11,name:"Saved contact",email:"sample@example.invalid"}],
  }}; },
}));
vi.mock("@/components/sales-feedback/HotFollowUpWorklist", () => ({
  HotFollowUpWorklist: (props: any) => { state.hot(props); return <div>Saved Hot follow-ups</div>; },
}));
vi.mock("@/components/sales-feedback/ManualEntryDialog", () => ({
  ManualEntryDialog: (props: any) => props.open ? <div data-testid="prefill">{JSON.stringify(props.prefill ?? {})}</div> : null,
}));
vi.mock("@/components/sales-feedback/ReviewDialog", () => ({ReviewDialog:()=>null}));
vi.mock("@/components/sales-feedback/SourcesPanel", () => ({SourcesPanel:()=> <div>Saved Drive sources</div>}));
vi.mock("@workspace/api-client-react", () => ({
  useGetSalesAccountOptions: () => ({ data: { clients: [], visibility: state.visibility, canAssign: false } }),
  getGetSalesAccountOptionsQueryKey: () => ["/api/sales/accounts/options"],
}));
vi.mock("@/components/sales-feedback/SalesHotAccounts", () => ({ SalesHotAccounts: () => <div>Hot accounts view</div> }));
vi.mock("@/components/sales-feedback/FeedbackEntryCard", () => ({FeedbackEntryCard:()=>null}));
beforeEach(() => {
  window.history.replaceState({}, "", "/sales-dashboard");
  state.user={role:"viewer",sectionPermissions:{sales:"manage"}};
  state.visibility="all";
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });
it("opens the real Hot queue by default and keeps feedback and sources in one workspace", () => {
  render(<SalesDashboardPage/>);
  expect(screen.getByRole("heading",{name:"Sales Dashboard"})).toBeTruthy();
  expect(screen.getByText("Hot accounts view")).toBeTruthy();
  expect(screen.queryByTestId("text-hot-scope")).toBeNull();
  fireEvent.click(screen.getByRole("tab",{name:"Call follow-ups"}));
  expect(window.location.search).toBe("?tab=hot");
  expect(screen.getByText("Saved Hot follow-ups")).toBeTruthy();
  expect(screen.getByTestId("text-hot-scope").textContent).toContain("HP only");
  expect(state.hot.mock.lastCall?.[0]).toMatchObject({scope:{},canWrite:true});
  expect(state.list).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("tab",{name:"Feedback"}));
  expect(state.list.mock.lastCall?.[0].status).toBeUndefined();
  expect(screen.getByText("No feedback has been recorded yet.")).toBeTruthy();
  expect(window.location.search).toBe("?tab=feed");
  fireEvent.click(screen.getByRole("tab",{name:"Drive sources"}));
  expect(screen.getByText("Saved Drive sources")).toBeTruthy();
});
it("shows existing accounts and contacts and prefills the exact feedback identity", () => {
  window.history.replaceState({}, "", "/sales-dashboard?tab=contacts");
  render(<SalesDashboardPage/>);
  expect(screen.getByText("Saved contact")).toBeTruthy();
  const buttons=screen.getAllByRole("button",{name:/Log feedback/i});
  fireEvent.click(buttons[buttons.length-1]);
  expect(JSON.parse(screen.getByTestId("prefill").textContent!)).toEqual({clientId:2,accountId:11,contactId:21});
});
it("lets Sales viewers see records but hides all feedback-write controls", () => {
  state.user={role:"viewer",sectionPermissions:{sales:"view"}};
  window.history.replaceState({}, "", "/sales-dashboard?tab=contacts");
  render(<SalesDashboardPage/>);
  expect(screen.getByText("Saved contact")).toBeTruthy();
  expect(screen.queryByRole("button",{name:/Log feedback/i})).toBeNull();
});
it("hides Drive sources for owned-only users", () => {
  state.visibility="owned";
  render(<SalesDashboardPage/>);
  expect(screen.queryByRole("tab",{name:"Drive sources"})).toBeNull();
  expect(screen.getByRole("tab",{name:"Feedback"})).toBeTruthy();
  expect(screen.getByRole("tab",{name:"Accounts & contacts"})).toBeTruthy();
});
