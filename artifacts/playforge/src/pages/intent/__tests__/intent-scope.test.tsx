// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildScopeQs, getScopeParams } from "@/lib/intent-scope";

const mocks = vi.hoisted(() => ({
  useIntentAccounts: vi.fn(),
  useIntentScopeOptions: vi.fn(),
  useIntentOverview: vi.fn(),
  setLocation: vi.fn(),
}));

vi.mock("@/hooks/use-intent", () => ({
  useIntentAccounts: mocks.useIntentAccounts,
  useIntentAccountBatches: mocks.useIntentAccounts,
  useIntentScopeOptions: mocks.useIntentScopeOptions,
  useIntentOverview: mocks.useIntentOverview,
}));

vi.mock("@/contexts/AuthContext", () => ({
  useAuthContext: () => ({ user: { firstName: "Test" } }),
}));

vi.mock("wouter", () => ({
  Link: ({ href, children, ...props }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...props}>{children}</a>
  ),
  useLocation: () => ["/intent", mocks.setLocation],
  useSearch: () => window.location.search.replace(/^\?/, ""),
}));

vi.mock("lucide-react", () => {
  const Icon = (props: Record<string, unknown>) => React.createElement("span", props);
  return {
    Radar: Icon,
    Search: Icon,
    Settings: Icon,
    Upload: Icon,
    CheckSquare: Icon,
    Building2: Icon,
    AlertCircle: Icon,
    ArrowRight: Icon,
    Plus: Icon,
    LayoutGrid: Icon,
    ChevronDown: Icon,
    ChevronRight: Icon,
    BarChart2: Icon,
    Filter: Icon,
    Flame: Icon,
    TrendingUp: Icon,
    ArrowUpRight: Icon,
    ArrowDownRight: Icon,
    Download: Icon,
    Bell: Icon,
    Minus: Icon,
    Lightbulb: Icon,
    Users: Icon,
    Target: Icon,
    Activity: Icon,
    ShieldCheck: Icon,
    DatabaseZap: Icon,
    ChevronLeft: Icon,
    ExternalLink: Icon,
    RefreshCw: Icon,
    Zap: Icon,
    Radio: Icon,
  };
});

vi.mock("@/components/ui/button", () => ({
  Button: ({ asChild: _asChild, children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { asChild?: boolean }) => (
    <button {...props}>{children}</button>
  ),
}));

vi.mock("@/components/ui/input", () => ({
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
}));

vi.mock("@/components/ui/select", () => ({
  Select: ({ value, onValueChange, children }: { value: string; onValueChange: (value: string) => void; children: React.ReactNode }) => (
    <select value={value} onChange={event => onValueChange(event.target.value)}>{children}</select>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectItem: ({ value, children }: { value: string; children: React.ReactNode }) => <option value={value}>{children}</option>,
}));

vi.mock("@/components/ui/skeleton", () => ({
  Skeleton: (props: React.HTMLAttributes<HTMLDivElement>) => <div {...props} />,
}));

vi.mock("../audience-builder-modal", () => ({ AudienceBuilderModal: () => null }));
vi.mock("../research-workflow", () => ({ IntentResearchWorkflow: () => null }));

import IntentPage from "../index";
import IntentAccountsPage from "../accounts";

describe("intent category scope encoding", () => {
  it("round-trips canonical category names and keeps catalog-ID links", () => {
    const categoryName = getScopeParams(new URLSearchParams("categoryName=Business+Collaboration"));
    expect(categoryName.categoryName).toBe("Business Collaboration");
    expect(buildScopeQs(categoryName)).toBe("categoryName=Business+Collaboration");

    expect(getScopeParams(new URLSearchParams("category=42")).categoryIds).toBe("42");
    expect(buildScopeQs({ categoryIds: "42" })).toBe("categories=42");
  });
});

describe("Intent scope controls", () => {
  afterEach(cleanup);

  beforeEach(() => {
    window.history.replaceState({}, "", "/intent");
    mocks.setLocation.mockReset();
    mocks.useIntentScopeOptions.mockReturnValue({
      data: {
        clients: [],
        audiences: [{ id: 9, name: "High-fit audience" }],
        segments: [],
        categories: [
          { id: 1, name: "IT Hardware" },
          { id: 2, name: "Virtual Collaboration" },
        ],
        subcategories: [
          { id: 11, categoryId: 1, name: "Laptops" },
          { id: 12, categoryId: 1, name: "Workstations" },
          { id: 21, categoryId: 2, name: "Audio Conferencing" },
        ],
        products: [
          { id: 101, categoryId: 1, subcategoryId: 11, name: "Business Laptops", active: true },
          { id: 102, categoryId: 1, subcategoryId: 12, name: "Desktop Workstations", active: true },
          { id: 201, categoryId: 2, subcategoryId: 21, name: "Conference Phones", active: true },
        ],
        accountCount: 3,
      },
      isLoading: false,
      isError: false,
    });
    mocks.useIntentAccounts.mockReset();
    mocks.useIntentAccounts.mockImplementation((params: Record<string, unknown>) => ({
      data: {
        accounts: [],
        total: params.audienceId === "9" || params.categoryIds || params.subcategoryIds || params.productId ? 1 : 3,
        totalPages: 1,
        page: 1,
        pageSize: 50,
      },
      isLoading: false,
      isError: false,
      error: null,
    }));
    mocks.useIntentOverview.mockReset();
    mocks.useIntentOverview.mockImplementation((params: Record<string, unknown>) => ({
      data: {
        totalAccounts: params.audienceId === "9" || params.categoryIds || params.subcategoryIds || params.productId ? 1 : 3,
      },
      isLoading: false,
    }));
  });

  it("loads only Hot and Warm accounts in the initial Command Center page", () => {
    render(<IntentPage />);

    expect(mocks.useIntentAccounts).toHaveBeenLastCalledWith(expect.objectContaining({
      tier: "hot,warm",
      page: 1,
      pageSize: 5,
    }));
  });

  it("makes Command Center account names detail links with scope intact", () => {
    window.history.replaceState({}, "", "/intent?client=9&audience=4");
    mocks.useIntentAccounts.mockReturnValue({ data: { accounts: [{ id: 11, name: "Clickable account", tierKey: "hot", score: 100 }] }, isLoading: false });
    render(<IntentPage />);
    expect(screen.getByRole("link", { name: "Clickable account" })).toHaveAttribute("href", "/intent/accounts/11?client=9&audience=4");
  });

  it("commits an audience scope without changing the category scope", () => {
    render(<IntentPage />);

    fireEvent.change(screen.getByTestId("select-audience-scope"), {
      target: { value: "audience:9" },
    });
    fireEvent.click(screen.getByTestId("button-apply-intent-scope"));

    expect(mocks.setLocation).toHaveBeenCalledWith("/intent?audience=9");
  });

  it("applies a selected shared category name in the URL scope", () => {
    render(<IntentPage />);

    fireEvent.click(screen.getByTestId("category-card-it-hardware"));
    fireEvent.click(screen.getByTestId("button-apply-intent-scope"));

    expect(mocks.setLocation).toHaveBeenCalledWith("/intent?categoryName=IT+Hardware");
  });

  it("preserves legacy catalog-ID deep links", () => {
    window.history.replaceState({}, "", "/intent?categories=1");
    render(<IntentPage />);

    expect(screen.getByTestId("select-category-scope")).toHaveValue("legacy:1");
    expect(mocks.useIntentAccounts).toHaveBeenLastCalledWith(expect.objectContaining({ categoryIds: "1" }));
    fireEvent.click(screen.getByTestId("button-apply-intent-scope"));

    expect(mocks.setLocation).toHaveBeenCalledWith("/intent?category=1");
  });
});

describe("Account category controls", () => {
  afterEach(cleanup);

  beforeEach(() => {
    window.history.replaceState({}, "", "/intent/accounts");
    mocks.setLocation.mockReset();
    mocks.useIntentScopeOptions.mockReturnValue({
      data: {
        clients: [],
        audiences: [],
        segments: [],
        categories: [
          { id: 1, name: "IT Hardware" },
          { id: 2, name: "Business Collaboration" },
        ],
        subcategories: [],
        products: [],
        accountCount: 3,
      },
      isLoading: false,
      isError: false,
    });
    mocks.useIntentAccounts.mockReturnValue({
      data: { accounts: [], total: 3, totalPages: 1, page: 1, pageSize: 50 },
      isLoading: false,
      isError: false,
    });
    mocks.useIntentOverview.mockReturnValue({
      data: { totalAccounts: 3, hotAccounts: 1, tierBreakdown: [{ tierKey: "warm", count: 1 }, { tierKey: "cold", count: 1 }] },
      isLoading: false,
    });
  });

  it("searches while typing and resets pagination without dropping scope", async () => {
    window.history.replaceState({}, "", "/intent/accounts?client=9&categoryName=Security&page=3");
    render(<IntentAccountsPage />);
    fireEvent.change(screen.getByPlaceholderText("Search account..."), { target: { value: "Genpact" } });
    await waitFor(() => expect(mocks.setLocation).toHaveBeenCalledWith("/intent?client=9&categoryName=Security&search=Genpact"));
  });

  it("loads another batch only when requested, including after an empty filtered batch",()=>{
    const fetchNextPage=vi.fn();
    mocks.useIntentAccounts.mockReturnValue({data:{accounts:[],total:0,totalPages:1},
      isLoading:false,isError:false,hasNextPage:true,isFetchingNextPage:false,fetchNextPage});
    mocks.useIntentOverview.mockClear();
    render(<IntentAccountsPage/>);
    expect(fetchNextPage).not.toHaveBeenCalled();
    expect(mocks.useIntentOverview).not.toHaveBeenCalled();
    expect(screen.getByText(/No matches in this batch/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button",{name:/Load more/}));
    expect(fetchNextPage).toHaveBeenCalledTimes(1);
  });

  it("does not offer another batch after the server reports the end",()=>{
    mocks.useIntentAccounts.mockReturnValue({data:{accounts:[],total:0,totalPages:1},
      isLoading:false,isError:false,hasNextPage:false,isFetchingNextPage:false});
    render(<IntentAccountsPage/>);
    expect(screen.getByRole("button",{name:/Load more/})).toBeDisabled();
  });

  it("submits a search immediately from the visible Search button", () => {
    render(<IntentAccountsPage />);
    fireEvent.change(screen.getByPlaceholderText("Search account..."), { target: { value: "Ford" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(mocks.setLocation).toHaveBeenCalledWith("/intent?search=Ford");
  });

  it("replaces product selection with category cards and applies the category immediately", () => {
    render(<IntentAccountsPage />);

    expect(screen.queryByText("All Products")).not.toBeInTheDocument();
    expect(screen.getByTestId("account-category-card-it-hardware")).toBeInTheDocument();
    expect(screen.getByTestId("account-category-card-business-collaboration")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("account-category-card-it-hardware"));

    expect(mocks.setLocation).toHaveBeenCalledWith("/intent?categoryName=IT+Hardware");
  });
});