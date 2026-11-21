// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import RosterMappingPanel from "./RosterMappingPanel";
import WorkbookProfile from "./WorkbookProfile";

const mutation = vi.hoisted(() => ({ mutate: vi.fn(), reset: vi.fn(), isPending: false, isError: false }));
vi.mock("@/hooks/useAuth", () => ({ useAuth: () => ({ user: { role: "member" } }) }));
vi.mock("@workspace/api-client-react", () => ({
  getGetHpRosterAnalysisQueryKey: () => ["roster"],
  useUpdateHpRosterAssociation: () => mutation,
  useGetHpRosterAnalysis: () => ({ isLoading: false, isError: false, isFetching: false, refetch: vi.fn(), data: { columns: [{ key: "hp_id", label: "UNIQUE ID", populatedRows: 5 }], sourceRows: 10, rosterAccounts: 4, fileName: "r.xlsx", responses: 3,
    accounts: [{ accountId: 1, name: "Alpha", parentKey: "a", responses: 3, hot: 1, warm: 1, cold: 0, status: "Hot", mapping: "review", targetAccountId: null, candidates: [{ accountId: 9, name: "Alpha Ltd", hpId: "H1", parentName: "Alpha", reason: "similar name" }] }] } }),
}));
afterEach(() => { cleanup(); mutation.mutate.mockClear(); mutation.reset.mockClear(); });

describe("RosterMappingPanel", () => {
  it("shows Cold 0 and disables select for non-admin", () => {
    render(<QueryClientProvider client={new QueryClient()}><RosterMappingPanel clientId={9} /></QueryClientProvider>);
    expect(screen.getByTestId("total-cold").textContent).toContain("Cold 0");
    expect((screen.getByTestId("button-select-1-9") as HTMLButtonElement).disabled).toBe(true);
  });
  it("requires an explicit confirmation before approving a suggested reporting link", () => {
    render(<QueryClientProvider client={new QueryClient()}><RosterMappingPanel clientId={9} admin /></QueryClientProvider>);
    fireEvent.click(screen.getByTestId("button-select-1-9"));
    expect(screen.getByTestId("roster-confirm").textContent).toContain("not a legal merge");
    expect(mutation.mutate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("button-roster-cancel"));
    expect(mutation.mutate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("button-select-1-9"));
    fireEvent.click(screen.getByTestId("button-roster-confirm"));
    expect(mutation.mutate).toHaveBeenCalledWith({ data: { clientId: 9, sourceAccountId: 1, targetAccountId: 9, expectedTargetAccountId: null, confirm: true } }, expect.any(Object));
  });
});
describe("WorkbookProfile", () => {
  it("shows all 41 fields and unsupplied values", () => {
    render(<WorkbookProfile members={[{ id: 1, name: "M", dimensions: {}, variants: [{ hp_id: "X1", _source: { fileName: "f", sheet: "s", row: 2 } }] }]} />);
    expect(screen.getByTestId("wb-hp_id").textContent).toContain("X1");
    expect(screen.getByTestId("wb-city").textContent).toContain("Not supplied");
    expect(screen.getByTestId("text-wb-filled").textContent).toContain("of 41");
  });
  it("preserves empty source-variant cells rather than filling them from another row", () => {
    render(<WorkbookProfile members={[{ id: 1, name: "M", dimensions: { city: "Mumbai" }, variants: [{ "CITY": "", "EMP SIZE": 0 }, { "CITY": "Delhi" }] }]} />);
    expect(screen.getByTestId("wb-city").textContent).toContain("Not supplied");
    expect(screen.getByTestId("wb-emp_size").textContent).toContain("0");
    fireEvent.change(screen.getByTestId("select-wb-variant"), { target: { value: "1" } });
    expect(screen.getByTestId("wb-city").textContent).toContain("Delhi");
  });
});
