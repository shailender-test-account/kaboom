// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { Children, isValidElement, type ReactNode } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import JourneysPage from "./index";

const state = vi.hoisted(() => ({ clientsError: false, journeysError: false }));
vi.mock("./viewer", () => ({ slugify: (v: string) => v.toLowerCase().replaceAll(" ", "-") }));
vi.mock("wouter", () => ({ useLocation: () => ["/journeys", vi.fn()] }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: string[] }) => ({
    data: queryKey[0] === "clients" ? [
      { id: 9, name: "HP" }, { id: 742, name: "HP New" }, { id: 800, name: "No journeys client" },
    ] : [
      { id: 4, name: "HDFC", clientId: 9, clientName: "HP", status: "published" },
      { id: 523, name: "The Future of Work", clientId: 742, clientName: "HP New", status: "draft" },
    ].map(j => ({ ...j, description: null, slug: j.name, pageCount: 0, totalViews: 0,
      createdAt: "2026-10-01", linkedPlays: [], linkedPlaysCount: 0, clientLogoUrl: null })),
    isLoading: false,
    isError: queryKey[0] === "clients" ? state.clientsError : state.journeysError,
    refetch: vi.fn(),
  }),
  useMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock("@/components/ui/select", () => ({
  Select: ({ children, value, onValueChange, disabled }: {
    children: ReactNode; value: string; onValueChange: (v: string) => void; disabled?: boolean;
  }) => {
    const trigger = Children.toArray(children).find(c => isValidElement<{ "aria-label"?: string }>(c) && c.props["aria-label"]);
    return <select aria-label={isValidElement<{ "aria-label"?: string }>(trigger) ? trigger.props["aria-label"] : ""}
      value={value} disabled={disabled} onChange={e => onValueChange(e.target.value)}>{children}</select>;
  },
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  SelectItem: ({ value, children }: { value: string; children: ReactNode }) => <option value={value}>{children}</option>,
}));
afterEach(() => { cleanup(); state.clientsError = false; state.journeysError = false; });

it("lists all registry clients and keeps HP distinct from HP New when filtering journeys", () => {
  render(<JourneysPage />);
  expect(screen.getByRole("option", { name: "HP" })).toBeDefined();
  expect(screen.getByRole("option", { name: "No journeys client" })).toBeDefined();
  fireEvent.change(screen.getByLabelText("Filter by client"), { target: { value: "9" } });
  expect(screen.getByText("HDFC")).toBeDefined();
  expect(screen.queryByText("The Future of Work")).toBeNull();
  fireEvent.change(screen.getByLabelText("Filter by client"), { target: { value: "742" } });
  expect(screen.getByText("The Future of Work")).toBeDefined();
  expect(screen.queryByText("HDFC")).toBeNull();
});
it("intersects client, status and text filters and shows an honest empty state", () => {
  render(<JourneysPage />);
  fireEvent.change(screen.getByLabelText("Filter by client"), { target: { value: "9" } });
  fireEvent.change(screen.getByLabelText("Filter by status"), { target: { value: "draft" } });
  expect(screen.getByText("No journeys match your filters for HP")).toBeDefined();
  fireEvent.change(screen.getByLabelText("Filter by status"), { target: { value: "all" } });
  fireEvent.change(screen.getByPlaceholderText("Search journeys..."), { target: { value: "Future" } });
  expect(screen.queryByText("The Future of Work")).toBeNull();
  fireEvent.change(screen.getByLabelText("Filter by client"), { target: { value: "all" } });
  expect(screen.getByText("The Future of Work")).toBeDefined();
});
it("does not describe failed client or journey loads as missing data", () => {
  state.clientsError = true; state.journeysError = true;
  render(<JourneysPage />);
  expect(screen.getByText("Unable to load the client list.")).toBeDefined();
  expect(screen.getByText("Unable to load journeys.")).toBeDefined();
  expect((screen.getByLabelText("Filter by client") as HTMLSelectElement).disabled).toBe(true);
  expect(screen.queryByText("No journeys yet — create your first one")).toBeNull();
});
