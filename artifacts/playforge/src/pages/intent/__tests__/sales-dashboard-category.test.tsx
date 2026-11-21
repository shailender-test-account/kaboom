// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  useSalesDashboard: vi.fn(),
  setLocation: vi.fn(),
}));

vi.mock("@/hooks/use-intent", () => ({
  useSalesDashboard: mocks.useSalesDashboard,
}));

vi.mock("wouter", () => ({
  Link: ({ href, children, ...props }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...props}>{children}</a>
  ),
  useLocation: () => ["/intent/sales-dashboard", mocks.setLocation],
  useSearch: () => window.location.search.replace(/^\?/, ""),
}));

vi.mock("lucide-react", () => {
  const Icon = (props: Record<string, unknown>) => React.createElement("span", props);
  return { Flame: Icon, Activity: Icon, Target: Icon, TrendingUp: Icon, Sparkles: Icon, Calendar: Icon, ArrowRight: Icon };
});

vi.mock("@/components/intent/ui", () => ({
  IntentPageHeader: () => <header />,
}));

vi.mock("@/components/ui/skeleton", () => ({
  Skeleton: (props: React.HTMLAttributes<HTMLDivElement>) => <div {...props} />,
}));

vi.mock("../opportunity-queue", () => ({
  OpportunityQueue: ({ categoryNames, legacyCategoryIds }: { categoryNames: string[]; legacyCategoryIds: number[] }) => (
    <div data-testid="mock-opportunity-queue" data-category-names={categoryNames.join(",")} data-legacy-category-ids={legacyCategoryIds.join(",")} />
  ),
}));

import SalesDashboardPage from "../sales-dashboard";

const categoryNames = ["IT Hardware", "Business Collaboration", "Security", "Business Services"];
const dashboard = {
  scope: { categoryIds: [1, 2, 3, 4], requestedCategoryIds: [], categoryName: "Security", categoryNames: ["Security"], label: "Security" },
  summary: { hotAccounts: 1, newSignals: 2, categoryOpportunities: 3, potentialPipeline: 4, leadForms: 5, units: 6 },
  categories: categoryNames.map(name => ({
    id: name,
    name,
    categoryName: name,
    legacyCategoryIds: [1],
    imageKey: name,
    score: 50,
    hotAccounts: 1,
    warmAccounts: 2,
    coldAccounts: 3,
    signals: 4,
    pipeline: 5,
    units: 6,
    accountCount: 7,
  })),
  topAccounts: [{
    id: 99,
    name: "Example Account",
    score: 80,
    tier: "hot",
    categoryId: 1,
    categoryIds: [1],
    categoryName: "Security",
  }],
  pipelineCoverage: { matchedSubmissions: 1, unmatchedSubmissions: 0, pricedProducts: 1, totalProducts: 1 },
};

describe("Sales Decision Cockpit category scope", () => {
  afterEach(cleanup);

  beforeEach(() => {
    window.history.replaceState({}, "", "/intent/sales-dashboard");
    mocks.setLocation.mockReset();
    mocks.useSalesDashboard.mockReset();
    mocks.useSalesDashboard.mockReturnValue({ data: dashboard, isLoading: false, error: null, refetch: vi.fn() });
  });

  it("uses exact shared category names for cards and the dashboard request", () => {
    window.history.replaceState({}, "", "/intent/sales-dashboard?categoryName=Security");
    render(<SalesDashboardPage />);

    expect(mocks.useSalesDashboard).toHaveBeenLastCalledWith({ categoryName: "Security" });
    expect(screen.getByTestId("sales-category-card-it-hardware")).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByTestId("sales-category-card-business-collaboration")).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByTestId("sales-category-card-security")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("sales-category-card-business-services")).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByTestId("mock-opportunity-queue")).toHaveAttribute("data-category-names", "Security");
  });

  it("updates and clears the selected name while preserving unrelated URL parameters", () => {
    window.history.replaceState({}, "", "/intent/sales-dashboard?categoryName=Security&view=summary");
    render(<SalesDashboardPage />);

    fireEvent.click(screen.getByTestId("sales-category-card-business-services"));
    let target = new URL(mocks.setLocation.mock.calls.at(-1)?.[0] ?? "", window.location.origin);
    expect(target.pathname).toBe("/intent/sales-dashboard");
    expect(target.searchParams.get("categoryName")).toBe("Business Services");
    expect(target.searchParams.get("view")).toBe("summary");

    fireEvent.click(screen.getByTestId("button-clear-category"));
    target = new URL(mocks.setLocation.mock.calls.at(-1)?.[0] ?? "", window.location.origin);
    expect(target.searchParams.has("categoryName")).toBe(false);
    expect(target.searchParams.get("view")).toBe("summary");
  });

  it("translates legacy ID scope to saved names and links with categoryName", () => {
    window.history.replaceState({}, "", "/intent/sales-dashboard?categoryIds=42");
    mocks.useSalesDashboard.mockReturnValue({
      data: {
        ...dashboard,
        scope: { ...dashboard.scope, categoryName: null, categoryNames: ["IT Hardware"] },
      },
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    });
    render(<SalesDashboardPage />);

    expect(mocks.useSalesDashboard).toHaveBeenLastCalledWith({ categoryIds: "42" });
    expect(screen.getByTestId("sales-category-card-it-hardware")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("mock-opportunity-queue")).toHaveAttribute("data-category-names", "IT Hardware");
    expect(new URL(screen.getByTestId("heat-category-it-hardware").getAttribute("href")!, window.location.origin).searchParams.get("categoryName")).toBe("IT Hardware");
    expect(new URL(screen.getByTestId("link-account-evidence-99").getAttribute("href")!, window.location.origin).searchParams.get("categoryName")).toBe("Security");
  });
});