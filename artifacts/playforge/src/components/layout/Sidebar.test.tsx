// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Sidebar } from "./Sidebar";

const mocks = vi.hoisted(() => ({ location: "/", role: "admin", navigate: vi.fn() }));
vi.mock("wouter", () => ({ useLocation: () => [mocks.location, mocks.navigate] }));
vi.mock("@/contexts/AuthContext", () => ({
  useAuthContext: () => ({
    user: { firstName: "Test", lastName: "User", email: "test@example.invalid", role: mocks.role },
    logout: vi.fn(),
  }),
}));
vi.mock("@/components/BrandLogo", () => ({ BrandLogo: () => <span>Brand</span> }));
const view = () => <TooltipProvider><Sidebar /></TooltipProvider>;
beforeEach(() => {
  mocks.location = "/";
  mocks.role = "admin";
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals(); });

it("has only one Sales destination in expanded and collapsed navigation", () => {
  render(view());
  expect(screen.getAllByRole("button", { name: "Sales Dashboard" })).toHaveLength(1);
  expect(screen.queryByRole("button", { name: "Sales Feedback" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Sales Dashboard" }));
  expect(mocks.navigate).toHaveBeenCalledWith("/sales-dashboard");
  fireEvent.click(screen.getByRole("button", { name: "Collapse sidebar" }));
  expect(screen.getAllByRole("button", { name: "Sales Dashboard" })).toHaveLength(1);
  expect(screen.queryByRole("button", { name: "Sales Feedback" })).toBeNull();
});

it("puts Buying Committee in main navigation and keeps secondary tools hidden under More", () => {
  render(view());
  fireEvent.click(screen.getByRole("button", { name: "Buying Committee" }));
  expect(mocks.navigate).toHaveBeenCalledWith("/intent/buying-committee");
  expect(screen.queryByRole("button", { name: "Call Campaigns" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Intent Engine" })).toBeNull();
  expect(screen.queryByRole("link", { name: "HP Poly Contest" })).toBeNull();
  const more = screen.getByRole("button", { name: "More" });
  expect(more.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(more);
  expect(more.getAttribute("aria-expanded")).toBe("true");
  expect(screen.getByRole("button", { name: "Intent Engine" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "DNC / Negative List" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Contest Entries" })).toBeTruthy();
  const contest = screen.getByRole("link", { name: "HP Poly Contest" });
  expect(contest.getAttribute("href")).toBe("/poly-contest-rescue.html");
  expect(contest.getAttribute("target")).toBe("_blank");
  fireEvent.click(screen.getByRole("button", { name: "Call Campaigns" }));
  expect(mocks.navigate).toHaveBeenCalledWith("/calls");
  fireEvent.click(more);
  expect(screen.queryByRole("button", { name: "Call Campaigns" })).toBeNull();
});

it.each([false, true])("keeps Analytics, Continuous Monitoring and Autonomous GTM OS adjacent (compact: %s)", (compact) => {
  mocks.location = "/intent/monitoring";
  render(view());
  if (compact) fireEvent.click(screen.getByRole("button", { name: "Collapse sidebar" }));
  const analytics = screen.getByRole("button", { name: "Analytics" });
  const monitoring = screen.getByRole("button", { name: "Continuous Monitoring" });
  const gtm = screen.getByRole("button", { name: "Autonomous GTM OS" });
  expect(analytics.nextElementSibling).toBe(monitoring);
  expect(monitoring.nextElementSibling).toBe(gtm);
  expect(screen.getAllByRole("button", { name: "Analytics" })).toHaveLength(1);
  expect(monitoring.getAttribute("aria-current")).toBe("page");
  expect(screen.queryByRole("button", { name: "Intent Engine" })).toBeNull();
  expect(screen.getByRole("button", { name: "More" }).getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(monitoring);
  expect(mocks.navigate).toHaveBeenCalledWith("/intent/monitoring");
});

it("keeps Contest Entries restricted to admins", () => {
  mocks.role = "viewer";
  render(view());
  fireEvent.click(screen.getByRole("button", { name: "More" }));
  expect(screen.queryByRole("button", { name: "Contest Entries" })).toBeNull();
  expect(screen.getByRole("link", { name: "HP Poly Contest" })).toBeTruthy();
});

it("highlights Buying Committee without also selecting Intent Engine", () => {
  mocks.location = "/intent/buying-committee";
  render(view());
  expect(screen.getByRole("button", { name: "Buying Committee" }).getAttribute("aria-current")).toBe("page");
  expect(screen.queryByRole("button", { name: "Intent Engine" })).toBeNull();
});

it("opens More on a secondary route and only selects the most specific route", () => {
  const { rerender } = render(view());
  mocks.location = "/calls/dnc";
  rerender(view());
  expect(screen.getByRole("button", { name: "More" }).getAttribute("aria-expanded")).toBe("true");
  expect(screen.getByRole("button", { name: "DNC / Negative List" }).getAttribute("aria-current")).toBe("page");
  expect(screen.getByRole("button", { name: "Call Campaigns" }).hasAttribute("aria-current")).toBe(false);
});

it("keeps secondary tools inside a More menu when the sidebar is collapsed", () => {
  render(view());
  fireEvent.click(screen.getByTitle("Collapse sidebar"));
  expect(screen.getByRole("button", { name: "Buying Committee" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Call Campaigns" })).toBeNull();
  fireEvent.keyDown(screen.getByRole("button", { name: "More" }), { key: "Enter" });
  expect(screen.getByRole("menuitem", { name: "DNC / Negative List" })).toBeTruthy();
  expect(screen.getByRole("menuitem", { name: "Contest Entries" })).toBeTruthy();
  expect(screen.getByRole("menuitem", { name: "HP Poly Contest" }).getAttribute("target")).toBe("_blank");
  fireEvent.click(screen.getByRole("menuitem", { name: "Call Campaigns" }));
  expect(mocks.navigate).toHaveBeenCalledWith("/calls");
});
