// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SalesAccountDetailPanel, SalesHotAccounts } from "./SalesHotAccounts";

const s = vi.hoisted(() => ({ mutate: vi.fn(), detail: {} as any, options: {} as any, list: {} as any, params: vi.fn() }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@workspace/api-client-react", () => ({
  useListSalesHotAccounts: (params: unknown) => { s.params(params); return s.list; },
  useGetSalesAccountOptions: () => s.options,
  useGetSalesAccount: () => s.detail,
  useReplaceSalesAccountOwners: () => ({ mutate: s.mutate, isPending: false }),
  getListSalesHotAccountsQueryKey: () => ["/api/sales/accounts"],
  getGetSalesAccountOptionsQueryKey: () => ["/api/sales/accounts/options"],
  getGetSalesAccountQueryKey: (id: number) => [`/api/sales/accounts/${id}`],
  getGetSalesOwnerHistoryQueryKey: (id: number) => [`/api/sales/accounts/${id}/owner-history`],
  useGetSalesOwnerHistory: () => ({}),
  useGetSalesVisibilityHistory: () => ({}),
}));
const data = {
  account: { id: 5, clientId: 2, name: "Orbit Labs", clientName: "HP", hotContacts: 1,
    owners: [{ userId: 3, name: "Rita Rao", email: "rita@example.invalid", source: "roster" }, { userId: 3, name: "Rita Rao", email: "rita@example.invalid", source: "assigned" }],
    evidence: [{ contactId: 9, product: "Laptops", months: 3, at: "2024-01-02", source: "call", fresh: false }] },
  contacts: [{ id: 9, name: "Dev Shah", email: "dev@example.invalid", phone: null, suppressed: false }],
  assignedUserIds: [3], assignableUsers: [{ id: 3, name: "Rita Rao", email: "rita@example.invalid" }, { id: 4, name: "Sam Iyer", email: "sam@example.invalid" }], canAssign: true,
};
const wrap = () => render(<QueryClientProvider client={new QueryClient()}><SalesAccountDetailPanel id={5} onClose={() => {}} /></QueryClientProvider>);
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it("saves explicit owners and can remove an assignment for a roster owner", () => {
  s.detail = { data, isLoading: false, isError: false, refetch: vi.fn() };
  wrap();
  expect(screen.getByText(/needs reconfirmation/)).toBeTruthy();
  const rita = screen.getByTestId("checkbox-owner-3") as HTMLInputElement;
  expect(rita.disabled).toBe(false);
  fireEvent.click(rita);
  fireEvent.click(screen.getByTestId("checkbox-owner-4"));
  fireEvent.click(screen.getByTestId("button-save-owners"));
  expect(s.mutate.mock.lastCall?.[0]).toEqual({ id: 5, data: { userIds: [4] } });
});
it("hides cached account details when the detail request errors", () => {
  s.detail = { data, isLoading: false, isError: true, refetch: vi.fn() };
  wrap();
  expect(screen.getByTestId("detail-error")).toBeTruthy();
  expect(screen.queryByText("Dev Shah")).toBeNull();
  expect(screen.queryByText("dev@example.invalid")).toBeNull();
  expect(screen.queryByText("Orbit Labs")).toBeNull();
});
it("lets an administrator remove an existing owner who lost required access", () => {
  s.detail = { data: { ...data, assignableUsers: data.assignableUsers.filter(user => user.id !== 3) },
    isLoading: false, isError: false, refetch: vi.fn() };
  wrap();
  expect(screen.getByText(/no longer eligible/)).toBeTruthy();
  fireEvent.click(screen.getByTestId("checkbox-owner-3"));
  fireEvent.click(screen.getByTestId("button-save-owners"));
  expect(s.mutate.mock.lastCall?.[0]).toEqual({ id: 5, data: { userIds: [] } });
});
it("keeps the unassigned filter and batch selection hidden from non-admin sales users", () => {
  s.options = { data: { canAssign: false, visibility: "owned", clients: [] } };
  s.list = { data: { items: [{ ...data.account, owners: [] }], total: 1, page: 1, pageSize: 25, visibility: "owned" } };
  render(<QueryClientProvider client={new QueryClient()}><SalesHotAccounts /></QueryClientProvider>);
  expect(screen.queryByText("Unassigned owners only")).toBeNull();
  expect(screen.queryByLabelText("Select Orbit Labs")).toBeNull();
});
it("lets admins select at most 25 accounts and clears selection when filters change", () => {
  s.options = { data: { canAssign: true, visibility: "all", clients: [] } };
  s.list = { data: { items: Array.from({ length: 26 }, (_, i) => ({ ...data.account, id: i + 1, name: `Account ${i + 1}`, owners: [] })),
    total: 26, page: 1, pageSize: 25, visibility: "all" } };
  render(<QueryClientProvider client={new QueryClient()}><SalesHotAccounts /></QueryClientProvider>);
  fireEvent.click(screen.getByText("Unassigned owners only"));
  expect(s.params.mock.lastCall?.[0].unassigned).toBe(true);
  for (let i = 1; i <= 25; i++) fireEvent.click(screen.getByLabelText(`Select Account ${i}`));
  expect((screen.getByLabelText("Select Account 26") as HTMLInputElement).disabled).toBe(true);
  expect(screen.getByText("Assign selected (25/25)")).toBeTruthy();
  fireEvent.change(screen.getByTestId("input-accounts-search"), { target: { value: "changed filter" } });
  expect((screen.getByText("Assign selected (0/25)") as HTMLButtonElement).disabled).toBe(true);
});
it("shows ownership history only in administrator controls", () => {
  s.detail = { data: { ...data, canAssign: false }, isLoading: false, isError: false };
  wrap();
  expect(screen.queryByTestId("sales-owners-history")).toBeNull();
});

it("row Add feedback passes the account and client; hidden without write access", () => {
  s.options = { data: { canAssign: false, visibility: "owned", clients: [] } };
  s.list = { data: { items: [data.account], total: 1, page: 1, pageSize: 25, visibility: "owned" } };
  const onAdd = vi.fn();
  const { unmount } = render(<QueryClientProvider client={new QueryClient()}><SalesHotAccounts onAddFeedback={onAdd} /></QueryClientProvider>);
  expect(screen.getByTestId("text-hot-contacts-5").textContent).toBe("1");
  fireEvent.click(screen.getByTestId("button-row-feedback-5"));
  expect(onAdd).toHaveBeenCalledWith({ clientId: 2, accountId: 5 });
  unmount();
  render(<QueryClientProvider client={new QueryClient()}><SalesHotAccounts /></QueryClientProvider>);
  expect(screen.queryByTestId("button-row-feedback-5")).toBeNull();
});
