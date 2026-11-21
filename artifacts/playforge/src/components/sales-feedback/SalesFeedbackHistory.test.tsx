// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import SalesFeedbackHistory from "./SalesFeedbackHistory";

const auth = vi.hoisted(() => ({ role: "admin" }));
vi.mock("@/contexts/AuthContext", () => ({ useAuthContext: () => ({ user: { id: 1, tenantId: 1, role: auth.role, sectionPermissions: null } }) }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); auth.role = "admin"; });

const entry = (o: object) => ({
  id: 1, clientId: 2, accountId: null, contactId: null, type: "telesales", occurredAt: "2026-01-02T05:00:00Z", repName: "Meera Pillai",
  feedback: "Wants 40 laptops after budget", product: null, timingMonths: null, proposedTemperature: "Warm", reviewStatus: "pending",
  reviewNote: null, approvedQualification: false, reviewedAt: null, reviewedBy: null, sourceId: 5, fileName: "tracker.xlsx",
  sheetName: "Lead Tracker", rowNumber: 9, rawFields: { Company: "Varuna Logistics" }, createdAt: "2026-01-03T00:00:00Z",
  accountName: null, contactName: null, nextAction: "Call back Monday", sourceName: "Pune desk", ...o,
});
const wrap = (ui: React.ReactNode) => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>);

it("never requests tenant-wide feedback for an unresolved target", () => {
  const f = vi.spyOn(globalThis, "fetch");
  const { container } = wrap(<SalesFeedbackHistory target={{ parentKey: "", clientId: 2 }} />);
  expect(f).not.toHaveBeenCalled();
  expect(container.innerHTML).toBe("");
});

it("narrows by account, uses the authoritative superseded flag and exposes audit history", async () => {
  const f = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify({
    items: [entry({ id: 1, superseded: true, reviewHistory: [{ decision: "approve", note: "Confirmed on call" }] }), entry({ id: 2, accountId: 44, contactId: 9, contactName: "Arjun Rao" })], total: 2, page: 1, pageSize: 10,
  }), { status: 200 }));
  wrap(<SalesFeedbackHistory target={{ companyId: 44 }} />);
  expect(await screen.findByTestId("feedback-entry-2")).toBeTruthy();
  expect(String(f.mock.calls[0][0])).toContain("accountId=44");
  expect(screen.getByTestId("unmatched-feedback-1")).toBeTruthy();
  expect(screen.getByTestId("superseded-feedback-1")).toBeTruthy();
  expect(screen.queryByTestId("superseded-feedback-2")).toBeNull();
  fireEvent.click(screen.getByTestId("button-audit-1"));
  expect(screen.getByTestId("audit-1").textContent).toContain("Confirmed on call");
  expect(screen.getByTestId("button-add-feedback-here")).toBeTruthy();
  expect(screen.getAllByText(/Call back Monday/).length).toBe(2);
});

it("Add feedback prefills the target and resolves the client from scoped options", async () => {
  const f = vi.spyOn(globalThis, "fetch").mockImplementation(async (u) => new Response(JSON.stringify(String(u).includes("/options")
    ? { clients: [{ id: 2, name: "HP India" }], accounts: [{ id: 44, name: "Varuna Logistics", clientId: 2 }], contacts: [{ id: 9, name: "Arjun Rao", companyId: 44, clientId: 2, email: null }], products: [], googleDriveConnected: true }
    : { items: [], total: 0, page: 1, pageSize: 10 }), { status: 200 }));
  wrap(<SalesFeedbackHistory target={{ contactId: 9 }} />);
  fireEvent.click(await screen.findByTestId("button-add-feedback-here"));
  await waitFor(() => expect((screen.getByTestId("select-manual-client") as HTMLSelectElement).value).toBe("2"));
  expect((screen.getByTestId("select-manual-contact") as HTMLSelectElement).value).toBe("9");
  expect((screen.getByTestId("select-manual-account") as HTMLSelectElement).value).toBe("44");
  expect(f.mock.calls.some(c => String(c[0]).includes("/options?contactId=9"))).toBe(true);
});

it("hides review controls from non-admins", async () => {
  auth.role = "manager";
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ items: [entry({})], total: 1, page: 1, pageSize: 10 }), { status: 200 }));
  wrap(<SalesFeedbackHistory target={{ contactId: 7 }} />);
  expect(await screen.findByTestId("feedback-entry-1")).toBeTruthy();
  expect(screen.queryByTestId("button-review-1")).toBeNull();
});

it("distinguishes the signed-in submitter from an imported spreadsheet rep and shows server dates", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ items: [
    entry({ id: 1 }),
    entry({ id: 2, sourceId: null, fileName: null, sheetName: null, rowNumber: null, rawFields: {}, repName: "Priya Nair", createdBy: 7, createdByName: "Priya Nair", createdAt: "2026-02-10T06:30:00Z" }),
    entry({ id: 3, sourceId: null, fileName: null, sheetName: null, rowNumber: null, rawFields: {}, repName: "Old Typed", createdBy: null, createdByName: null }),
  ], total: 3, page: 1, pageSize: 10 }), { status: 200 }));
  wrap(<SalesFeedbackHistory target={{ contactId: 7 }} />);
  await screen.findByTestId("feedback-entry-2");
  expect(screen.getByTestId("author-feedback-2").textContent).toBe("Priya Nair");
  expect(screen.getByTestId("submitted-feedback-2").textContent).toMatch(/submitted 10 Feb 2026.*by Priya Nair/);
  expect(screen.queryByTestId("author-feedback-1")).toBeNull();
  expect(screen.getByTestId("rep-feedback-1").textContent).toBe("Meera Pillai");
  expect(screen.getByTestId("submitted-feedback-1").textContent).toContain("no signed-in author");
  expect(screen.getByTestId("legacy-author-3")).toBeTruthy();
});
