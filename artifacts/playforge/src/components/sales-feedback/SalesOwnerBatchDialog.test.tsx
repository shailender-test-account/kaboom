// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SalesOwnerBatchDialog } from "./SalesOwnerBatchDialog";
const s = vi.hoisted(() => ({ preview: vi.fn(), confirm: vi.fn() }));
vi.mock("@workspace/api-client-react", () => ({
  usePreviewSalesOwnerBatch: () => ({ mutate: s.preview, isPending: false }),
  useConfirmSalesOwnerBatch: () => ({ mutate: s.confirm, isPending: false }),
  getListSalesHotAccountsQueryKey: () => ["/api/sales/accounts"],
  getGetSalesAccountQueryKey: (id: number) => [`/api/sales/accounts/${id}`],
}));
const user = { id: 7, name: "Sales User", email: "sales@example.invalid" };
const row = { accountId: 5, accountName: "Orbit Labs", clientId: 2, clientName: "HP", assignableUsers: [user], proposedUsers: [] };
const saved = vi.fn();
function start() {
  render(<QueryClientProvider client={new QueryClient()}><SalesOwnerBatchDialog accountIds={[5]}
    onClose={() => {}} onSaved={saved} /></QueryClientProvider>);
  s.preview.mockImplementationOnce((_, options) => options.onSuccess({ rows: [row], reviewToken: null }));
  fireEvent.click(screen.getByText("Load accounts and eligible users"));
}
afterEach(() => { cleanup(); vi.resetAllMocks(); });
it("requires explicit review of account, client and users before confirmation, then refreshes affected caches", () => {
  start();
  expect(screen.getByText("Orbit Labs · HP")).toBeTruthy();
  expect(screen.queryByText("Confirm assignments")).toBeNull();
  fireEvent.click(screen.getByRole("checkbox"));
  s.preview.mockImplementationOnce((input, options) => {
    expect(input).toEqual({ data: { assignments: [{ accountId: 5, userIds: [7] }] } });
    options.onSuccess({ rows: [{ ...row, proposedUsers: [user] }], reviewToken: "reviewed-token" });
  });
  fireEvent.click(screen.getByText("Review assignments"));
  expect(screen.getByText("Assign to: Sales User (sales@example.invalid)")).toBeTruthy();
  expect(s.confirm).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText("Confirm assignments"));
  expect(s.confirm.mock.lastCall?.[0]).toEqual({ data: { reviewToken: "reviewed-token" } });
  s.confirm.mock.lastCall?.[1].onSuccess({ assignedAccounts: [5] });
  expect(saved).toHaveBeenCalledWith(1);
});
it("requires a new review after edits or a revoked-grant failure", () => {
  start(); fireEvent.click(screen.getByRole("checkbox"));
  const review = () => {
    s.preview.mockImplementationOnce((_, options) => options.onSuccess({ rows: [{ ...row, proposedUsers: [user] }], reviewToken: "token" }));
    fireEvent.click(screen.getByText("Review assignments"));
  };
  review();
  fireEvent.click(screen.getByText("Edit choices"));
  expect(screen.queryByText("Confirm assignments")).toBeNull();
  review();
  s.confirm.mockImplementationOnce((_, options) => options.onError({ data: { error: "Access changed. Nothing was saved." } }));
  fireEvent.click(screen.getByText("Confirm assignments"));
  expect(screen.getByRole("alert").textContent).toContain("Nothing was saved");
  expect(screen.queryByText("Confirm assignments")).toBeNull();
  expect(saved).not.toHaveBeenCalled();
});
