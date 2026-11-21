// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import SalesUserVisibility from "./SalesUserVisibility";

const s = vi.hoisted(() => ({ mutate: vi.fn(), data: { visibility: "owned" } as any }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@workspace/api-client-react", () => ({
  useGetMemberSalesAccess: () => ({ data: s.data, isLoading: false, isError: false }),
  useSetMemberSalesAccess: () => ({ mutate: s.mutate, isPending: false }),
  getGetSalesAccountOptionsQueryKey: () => ["/api/sales/accounts/options"],
  getListSalesHotAccountsQueryKey: () => ["/api/sales/accounts"],
  getGetMemberSalesAccessQueryKey: (id: number) => [`/api/team-access/${id}/sales-access`],
  getGetSalesVisibilityHistoryQueryKey: (id: number) => [`/api/team-access/${id}/sales-access/history`],
  useGetSalesOwnerHistory: () => ({}),
  useGetSalesVisibilityHistory: () => ({}),
}));
const wrap = (ui: any) => render(<QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>);
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it("saves all-account visibility with its own button", () => {
  wrap(<SalesUserVisibility memberId={7} isAdmin={false} />);
  expect(screen.getByRole("radio", { name: /Own accounts/ }).getAttribute("aria-checked")).toBe("true");
  const btn = screen.getByRole("button", { name: "Save sales visibility" }) as HTMLButtonElement;
  expect(btn.disabled).toBe(true);
  fireEvent.click(screen.getByRole("radio", { name: /All accounts/ }));
  fireEvent.click(btn);
  expect(s.mutate.mock.lastCall?.[0]).toEqual({ id: 7, data: { visibility: "all" } });
});
it("shows admins as all accounts, read-only", () => {
  wrap(<SalesUserVisibility memberId={1} isAdmin />);
  expect(screen.getByRole("radio", { name: /All accounts/ }).getAttribute("aria-checked")).toBe("true");
  expect((screen.getByRole("radio", { name: /Own accounts/ }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.queryByRole("button", { name: "Save sales visibility" })).toBeNull();
});
