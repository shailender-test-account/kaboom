// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import SalesAccessHistory from "./SalesAccessHistory";

const s = vi.hoisted(() => ({ owners: vi.fn(), visibility: vi.fn(), result: {} as any }));
vi.mock("@workspace/api-client-react", () => ({
  useGetSalesOwnerHistory: (...args: unknown[]) => { s.owners(...args); return s.result; },
  useGetSalesVisibilityHistory: (...args: unknown[]) => { s.visibility(...args); return s.result; },
}));
const data = { target: "Account fixture", nextBeforeId: 26, items: [{
  id: 27, actor: "Administrator fixture", before: ["Own accounts"], after: ["All accounts"],
  outcome: "changed", requestedAt: "2026-11-13T10:00:00Z", recordedAt: "2026-11-13T10:00:01Z",
}] };
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it("loads only the requested history when opened and supports older/newer pages", () => {
  s.result = { data };
  render(<SalesAccessHistory id={7} kind="owners" />);
  expect(s.owners.mock.lastCall?.[2].query.enabled).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Show ownership history" }));
  expect(s.owners.mock.lastCall?.[2].query.enabled).toBe(true);
  expect(s.visibility.mock.lastCall?.[2].query.enabled).toBe(false);
  expect(screen.getByText("Administrator fixture")).toBeTruthy();
  expect(screen.getByText("Before: Own accounts")).toBeTruthy();
  expect(screen.getByText("After: All accounts")).toBeTruthy();
  expect(screen.getByText(/Requested/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Older" }));
  expect(s.owners.mock.lastCall?.[1]).toEqual({ beforeId: 26 });
  fireEvent.click(screen.getByRole("button", { name: "Newer" }));
  expect(s.owners.mock.lastCall?.[1]).toEqual({ beforeId: undefined });
});
it("hides previously cached entries on read failure and permits retry", () => {
  const refetch = vi.fn();
  s.result = { data, isError: true, refetch };
  render(<SalesAccessHistory id={7} kind="visibility" />);
  fireEvent.click(screen.getByRole("button", { name: "Show visibility history" }));
  expect(screen.queryByText("Administrator fixture")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(refetch).toHaveBeenCalledOnce();
});
it("shows empty and loading states without inventing history", () => {
  s.result = { isLoading: true };
  const view = render(<SalesAccessHistory id={7} kind="visibility" />);
  fireEvent.click(screen.getByRole("button", { name: "Show visibility history" }));
  expect(screen.getByRole("status").textContent).toBe("Loading history…");
  s.result = { data: { ...data, items: [], nextBeforeId: null } };
  view.rerender(<SalesAccessHistory id={7} kind="visibility" />);
  expect(screen.getByText("No recorded changes.")).toBeTruthy();
});
