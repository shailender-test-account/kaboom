// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { HotFollowUpWorklist } from "./HotFollowUpWorklist";
const hooks = vi.hoisted(() => ({ list: vi.fn(), mutate: vi.fn(), refetch: vi.fn() }));
vi.mock("@/contexts/AuthContext", () => ({ useAuthContext: () => ({ user: { id: 7, tenantId: 1, email: "rep@example.invalid", firstName: "Asha", lastName: "Menon", role: "member", sectionPermissions: null, avatarUrl: null } }) }));
vi.mock("@/hooks/use-hot-follow-ups", () => ({
  useHotFollowUps: hooks.list,
  useUpdateHotFollowUp: () => ({ mutate: hooks.mutate, isPending: false, isError: false }),
}));
const item = {
  id: 1, clientId: 2, accountId: 3, contactId: 4, contactName: "Individual Buyer", accountName: "HP Account",
  phone: null, email: null, status: "open", assigneeId: null, assigneeName: null,
  createdAt: "2026-11-01T10:00:00Z", completedAt: null, completionNote: null,
  evidence: [{ product: "Device service", months: 2, at: "2026-11-01T10:00:00Z", reference: "sales-feedback:8" }],
  journeys: [{ id: 9, name: "Buyer journey" }], sequences: [{ id: 10, name: "Buyer nurture", status: "completed" }],
};
const result = () => ({
  data: { items: [item], total: 26, page: 1, pageSize: 25, assignees: [{ id: 5, name: "Caller" }] },
  isLoading: false, isError: false, isFetching: false, refetch: hooks.refetch,
});
beforeEach(() => { hooks.list.mockReturnValue(result()); hooks.mutate.mockReset(); hooks.refetch.mockReset(); });
afterEach(cleanup);
describe("HP individual Hot worklist", () => {
  it("sends the exact contact scope and exposes attribution, missing phone and route context", () => {
    render(<HotFollowUpWorklist scope={{ contactId: 4 }} canWrite={false} />);
    expect(hooks.list).toHaveBeenLastCalledWith({ contactId: 4, status: "open", page: 1 });
    expect(screen.getByText("Individual Buyer")).toBeTruthy();
    expect(screen.getByTestId("hot-evidence-1").textContent).toContain("sales-feedback:8");
    expect(screen.getByText(/No phone/)).toBeTruthy();
    expect(screen.getByText("Buyer journey").getAttribute("href")).toBe("/journeys/9");
    expect(screen.queryByTestId("select-hot-assignee-1")).toBeNull();
    expect(screen.queryByTestId("button-hot-complete-1")).toBeNull();
  });
  it("assigns using numeric IDs and requires a completion note without starting a call", () => {
    render(<HotFollowUpWorklist scope={{ accountId: 3 }} canWrite />);
    fireEvent.change(screen.getByTestId("select-hot-assignee-1"), { target: { value: "5" } });
    expect(hooks.mutate).toHaveBeenCalledWith({ id: 1, body: { assigneeId: 5 } });
    fireEvent.click(screen.getByTestId("button-hot-complete-1"));
    expect((screen.getByTestId("button-hot-save-1") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByTestId("input-hot-note-1"), { target: { value: "  Buyer asked for a callback  " } });
    fireEvent.click(screen.getByTestId("button-hot-save-1"));
    expect(hooks.mutate).toHaveBeenLastCalledWith({ id: 1, body: { complete: true, note: "Buyer asked for a callback" } }, expect.any(Object));
  });
  it("retains parent/client scope through paging and resets the page for completion history", () => {
    render(<HotFollowUpWorklist scope={{ clientId: 2, parentKey: "parent" }} canWrite />);
    fireEvent.click(screen.getByTestId("button-hot-next"));
    expect(hooks.list).toHaveBeenLastCalledWith({ clientId: 2, parentKey: "parent", status: "open", page: 2 });
    fireEvent.click(screen.getByTestId("filter-hot-status-completed"));
    expect(hooks.list).toHaveBeenLastCalledWith({ clientId: 2, parentKey: "parent", status: "completed", page: 1 });
  });
  it("surfaces load failures with a working retry", () => {
    hooks.list.mockReturnValue({ ...result(), data: undefined, isError: true, error: new Error("Denied") });
    render(<HotFollowUpWorklist scope={{}} canWrite={false} />);
    expect(screen.getByRole("alert").textContent).toContain("Denied");
    fireEvent.click(screen.getByTestId("button-hot-retry"));
    expect(hooks.refetch).toHaveBeenCalledOnce();
  });
});
