// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import TenantSalesAccessHistory from "./TenantSalesAccessHistory";

const s = vi.hoisted(() => ({ params: {} as any, options: {} as any, data: undefined as any,
  isLoading: false, isError: false, isFetching: false, refetch: vi.fn() }));
vi.mock("@workspace/api-client-react", () => ({
  useListSalesAccessHistory: (params: any, options: any) => { s.params = params; s.options = options; return s; },
  useGetSalesOwnerHistory: () => ({}), useGetSalesVisibilityHistory: () => ({}),
}));
beforeEach(() => {
  s.data = { items: [{ id: 50, actorId: 9, actor: "Deleted user #9", targetId: 2,
    target: "Deleted account #2", kind: "owners", before: [], after: ["Deleted user #8"],
    requestedAt: "2026-01-01T00:00:00Z", recordedAt: "2026-01-01T00:00:01Z", outcome: "changed" }], nextBeforeId: 26 };
  s.isLoading = s.isError = s.isFetching = false; s.params = {}; vi.clearAllMocks();
});
afterEach(cleanup);
const open = () => {
  render(<TenantSalesAccessHistory members={[{ id: 9, firstName: "Current", lastName: "Admin" }]} />);
  fireEvent.click(screen.getByRole("button", { name: "Show team-wide sales access history" }));
};
it("loads only after opening and displays tombstones and the access-only scope", () => {
  render(<TenantSalesAccessHistory members={[]} />);
  expect(s.params).toEqual({});
  fireEvent.click(screen.getByTestId("button-toggle-sales-history"));
  expect(screen.getByText(/Ownership · Deleted account #2/)).toBeTruthy();
  expect(screen.getByText("Before: No explicit owners")).toBeTruthy();
  expect(screen.getByText(/Password and credential history is not included/)).toBeTruthy();
  expect(s.options.query.refetchInterval).toBe(30000);
});
it("keeps applied filters through paging and resets paging when filters change", () => {
  open();
  fireEvent.change(screen.getByLabelText("From (UTC)"), { target: { value: "2026-01-01" } });
  fireEvent.change(screen.getByLabelText("Through (UTC)"), { target: { value: "2026-01-31" } });
  fireEvent.change(screen.getByLabelText("Actor ID (optional)"), { target: { value: "9" } });
  fireEvent.change(screen.getByLabelText("Change type"), { target: { value: "owners" } });
  fireEvent.click(screen.getByText("Apply filters"));
  expect(s.params).toEqual({ dateFrom: "2026-01-01", dateTo: "2026-01-31", actorId: 9, kind: "owners", beforeId: undefined });
  fireEvent.click(screen.getByText("Older"));
  expect(s.params.beforeId).toBe(26);
  expect(s.params.actorId).toBe(9);
  fireEvent.click(screen.getByText("Newer"));
  expect(s.params.beforeId).toBeUndefined();
  fireEvent.click(screen.getByText("Older"));
  fireEvent.change(screen.getByLabelText("Change type"), { target: { value: "visibility" } });
  expect(s.params.kind).toBe("owners");
  fireEvent.click(screen.getByText("Apply filters"));
  expect(s.params.kind).toBe("visibility"); expect(s.params.beforeId).toBeUndefined();
  fireEvent.click(screen.getByText("Reset"));
  expect(s.params.actorId).toBeUndefined(); expect(s.params.kind).toBeUndefined();
});
it("rejects excessive date ranges without issuing a changed query", () => {
  open(); const original = s.params.dateFrom;
  fireEvent.change(screen.getByLabelText("From (UTC)"), { target: { value: "2000-01-01" } });
  fireEvent.click(screen.getByText("Apply filters"));
  expect(screen.getByRole("alert").textContent).toMatch(/366 days/);
  expect(s.params.dateFrom).toBe(original);
});
it("shows loading, empty and error states with retry, and disables duplicate page clicks", () => {
  s.isLoading = true; open(); expect(screen.getByRole("status").textContent).toMatch(/Loading/);
  cleanup(); s.isLoading = false; s.isError = true; open();
  fireEvent.click(screen.getByText("Retry")); expect(s.refetch).toHaveBeenCalledOnce();
  cleanup(); s.isError = false; s.data = { items: [], nextBeforeId: null }; open();
  expect(screen.getByText("No recorded changes match these filters.")).toBeTruthy();
  expect((screen.getByText("Older") as HTMLButtonElement).disabled).toBe(true);
  cleanup(); s.isFetching = true; open();
  expect((screen.getByText("Newer") as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByText("Refresh") as HTMLButtonElement).disabled).toBe(true);
});
