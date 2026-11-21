// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import DemoEngagementHistory from "./DemoEngagementHistory";
import { DEMO_ENGAGEMENT_SCOPE } from "./model";

const auth = vi.hoisted(() => ({ tenantId: 1 }));
vi.mock("@/contexts/AuthContext", () => ({
  useAuthContext: () => ({ user: { tenantId: auth.tenantId } }),
}));
beforeEach(() => {
  auth.tenantId = 1;
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-15T12:00:00Z"));
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

it("shows the same total and stage on account and contact cards", () => {
  const view = render(<DemoEngagementHistory contactId={DEMO_ENGAGEMENT_SCOPE.contactId} />);
  expect(screen.getByText("495")).toBeTruthy();
  expect(screen.getByText("Total demo points")).toBeTruthy();
  expect(screen.getByText("9 visits · 45 scored actions")).toBeTruthy();
  expect(screen.getAllByText("Advanced Engage").length).toBeGreaterThan(0);
  expect(screen.getByText("Demo activity · not live customer data")).toBeTruthy();
  view.rerender(<DemoEngagementHistory companyId={DEMO_ENGAGEMENT_SCOPE.companyId} />);
  expect(screen.getByText("495")).toBeTruthy();
  expect(screen.getByTestId("demo-engagement")).toBeTruthy();
});
it("shows per-action and cumulative points, actual named pages and transparent weights", () => {
  render(<DemoEngagementHistory contactId={DEMO_ENGAGEMENT_SCOPE.contactId} />);
  for (const label of ["Recency weight", "Frequency weight", "Weighted demo index"]) {
    expect(screen.getByText(label)).toBeTruthy();
  }
  expect(screen.getAllByText("Email click")).toHaveLength(9);
  expect(screen.getAllByText("Journey landing")).toHaveLength(9);
  expect(screen.getAllByText("Scroll depth")).toHaveLength(9);
  expect(screen.getAllByText("Running total 495").length).toBeGreaterThan(0);
  expect(screen.getAllByText("HDFC · 8 Strategic Shifts for HDFC")).toHaveLength(9);
  expect(screen.getAllByText("HDFC · How to solve the AI Readiness Gap-See Solutions")).toHaveLength(9);
  expect(screen.getByText(/No demo activity is saved to analytics/)).toBeTruthy();
  expect(document.querySelectorAll("details[open]")).toHaveLength(1);
});
it("does not show the demo for unrelated records or a different tenant", () => {
  const view = render(<DemoEngagementHistory contactId={1} />);
  expect(screen.queryByTestId("demo-engagement")).toBeNull();
  auth.tenantId = 2;
  view.rerender(<DemoEngagementHistory contactId={DEMO_ENGAGEMENT_SCOPE.contactId} />);
  expect(screen.queryByTestId("demo-engagement")).toBeNull();
});
