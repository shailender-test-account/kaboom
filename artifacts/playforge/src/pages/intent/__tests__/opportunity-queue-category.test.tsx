// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  useIntentScopeOptions: vi.fn(),
  useOpportunities: vi.fn(),
  useOpportunityHandoff: vi.fn(),
  useOpportunityHandoffs: vi.fn(),
  downloadHotOpportunities: vi.fn(),
}));

vi.mock("@/hooks/use-intent", () => ({
  useIntentScopeOptions: mocks.useIntentScopeOptions,
}));

vi.mock("@/hooks/use-opportunities", () => ({
  downloadHotOpportunities: mocks.downloadHotOpportunities,
  useOpportunities: mocks.useOpportunities,
  useOpportunityHandoff: mocks.useOpportunityHandoff,
  useOpportunityHandoffs: mocks.useOpportunityHandoffs,
}));

vi.mock("wouter", () => ({
  Link: ({ href, children, ...props }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...props}>{children}</a>
  ),
}));

vi.mock("lucide-react", () => {
  const Icon = (props: Record<string, unknown>) => React.createElement("span", props);
  return {
    ArrowDownToLine: Icon,
    ArrowRight: Icon,
    ChevronLeft: Icon,
    ChevronRight: Icon,
    ExternalLink: Icon,
    FileSpreadsheet: Icon,
    Search: Icon,
    X: Icon,
  };
});

vi.mock("@/components/ui/skeleton", () => ({
  Skeleton: (props: React.HTMLAttributes<HTMLDivElement>) => <div {...props} />,
}));

import { OpportunityQueue } from "../opportunity-queue";

describe("Opportunity Queue category scope", () => {
  afterEach(cleanup);

  beforeEach(() => {
    mocks.useIntentScopeOptions.mockReturnValue({
      data: { clients: [], products: [], categories: [] },
    });
    mocks.useOpportunities.mockReset();
    mocks.useOpportunities.mockReturnValue({
      data: { items: [], hasMore: false, nextCursor: null, page: 1, pageSize: 10 },
      isLoading: false,
      isFetching: false,
      error: null,
      refetch: vi.fn(),
    });
    mocks.useOpportunityHandoff.mockReturnValue({ mutateAsync: vi.fn(), isPending: false });
    mocks.useOpportunityHandoffs.mockReturnValue({ data: [], isLoading: false, error: null, refetch: vi.fn() });
    mocks.downloadHotOpportunities.mockReset();
  });

  it("sends the selected canonical category name and restores the dashboard scope on clear", () => {
    render(<OpportunityQueue categoryNames={["Security"]} />);

    expect(mocks.useOpportunities).toHaveBeenLastCalledWith(expect.objectContaining({ categoryName: "Security" }));
    fireEvent.change(screen.getByTestId("select-opportunity-category"), { target: { value: "Business Services" } });
    expect(mocks.useOpportunities).toHaveBeenLastCalledWith(expect.objectContaining({ categoryName: "Business Services" }));

    fireEvent.click(screen.getByTestId("button-reset-opportunity-filters"));
    expect(mocks.useOpportunities).toHaveBeenLastCalledWith(expect.objectContaining({ categoryName: "Security" }));
  });

  it("keeps numeric legacy category links usable when no saved-name mapping is available", () => {
    render(<OpportunityQueue legacyCategoryIds={[42]} />);
    expect(mocks.useOpportunities).toHaveBeenLastCalledWith(expect.objectContaining({ categoryId: 42 }));
  });
});