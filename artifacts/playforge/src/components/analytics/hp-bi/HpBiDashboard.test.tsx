// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import HpBiDashboard from "./HpBiDashboard";
import { useHpBiDashboard } from "./api";

vi.mock("@/hooks/useAuth",()=>({useAuth:()=>({user:{role:"admin"},isLoading:false})}));
vi.mock("./api", () => ({
  useHpBiDashboard: vi.fn(() => ({ data: undefined, isLoading: false, isError: false })),
  useHpBiFilterOptions: vi.fn(() => ({ data: { salesPeople: ["owner@example.invalid"] }, isLoading: false, isError: false })),
  hpBiQuery: vi.fn(() => ""),
}));
// Isolate year selection from closed overlays and their query/auth providers.
vi.mock("./EvidenceDialog", () => ({ default: () => null }));
vi.mock("./AccountDetail", () => ({ default: ({ layout, parentKey, onClose }: { layout: string; parentKey: string | null; onClose: () => void }) => <div data-testid="detail-layout">{layout}{parentKey && <>
  <span data-testid="restored-parent">{parentKey}</span>
  <a data-committee-plan-link href="/intent/buying-committee?planId=301" onClick={e => e.preventDefault()}>Exact sourcing plan</a>
  <button onClick={onClose}>Close account</button>
</>}</div> }));
vi.mock("./ImportPanel", () => ({ default: () => null }));

afterEach(() => { cleanup(); localStorage.clear(); window.history.replaceState(null, "", "/"); vi.useRealTimers(); vi.clearAllMocks(); });

it("pulses Present outside fullscreen, stops on entry and resumes after exit", () => {
  const descriptor = Object.getOwnPropertyDescriptor(document, "fullscreenElement");
  let fullscreenElement: Element | null = null;
  Object.defineProperty(document, "fullscreenElement", { configurable: true, get: () => fullscreenElement });
  try {
    render(<HpBiDashboard clientId={9} />);
    const root = screen.getByTestId("hp-bi-dashboard");
    const button = screen.getByTestId("button-fullscreen");
    const requestFullscreen = vi.fn();
    Object.defineProperty(root, "requestFullscreen", { configurable: true, value: requestFullscreen });
    expect(button.classList.contains("hpbi-present-cue")).toBe(true);
    expect(button.title).toBe("View dashboard in full screen");
    fireEvent.click(button);
    expect(requestFullscreen).toHaveBeenCalledOnce();
    fullscreenElement = root;
    fireEvent(document, new Event("fullscreenchange"));
    expect(button.textContent).toBe("Exit");
    expect(button.classList.contains("hpbi-present-cue")).toBe(false);
    fullscreenElement = null;
    fireEvent(document, new Event("fullscreenchange"));
    expect(button.textContent).toBe("Present");
    expect(button.classList.contains("hpbi-present-cue")).toBe(true);
  } finally {
    if (descriptor) Object.defineProperty(document, "fullscreenElement", descriptor);
    else Reflect.deleteProperty(document, "fullscreenElement");
  }
});

it("restores the HP account and filters on Back and saves return context only on the source history entry", async () => {
  window.history.replaceState({ hpCommitteeReturn: { clientId: 9, parentKey: "owned-parent", tab: "bi", metric: "touchpoints",
    filters: { clientId: 9, year: 2025, segment: "GCC", page: 3, pageSize: 5, search: "sample", basis: "PS" } } }, "", "/analytics");
  render(<HpBiDashboard clientId={9} />);
  expect((await screen.findByTestId("restored-parent")).textContent).toBe("owned-parent");
  expect(useHpBiDashboard).toHaveBeenLastCalledWith(expect.objectContaining({ year: 2025, segment: "GCC", page: 3, search: "sample", basis: "PS" }), true, true);
  fireEvent.click(screen.getByText("Exact sourcing plan"));
  expect(new URLSearchParams(window.location.search).get("clientId")).toBe("9");
  expect(window.history.state.hpCommitteeReturn.parentKey).toBe("owned-parent");
  fireEvent.click(screen.getByText("Close account"));
  expect(window.history.state.hpCommitteeReturn).toBeUndefined();
});

it("does not restore a return card belonging to a different selected client", () => {
  window.history.replaceState({ hpCommitteeReturn: { clientId: 1, parentKey: "wrong-parent", filters: { year: 2025 } } }, "", "/analytics");
  render(<HpBiDashboard clientId={9} />);
  expect(screen.queryByTestId("restored-parent")).toBeNull();
});

it("opens the dashboard and reporting query on the current fiscal year, while allowing manual selection", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-11T08:00:00Z"));
  render(<HpBiDashboard clientId={9} />);
  const select = screen.getByTestId("select-year") as HTMLSelectElement;
  expect(select.value).toBe("2026");
  expect(screen.getByTestId("text-fy").textContent).toContain("FY2026");
  expect(useHpBiDashboard).toHaveBeenLastCalledWith(expect.objectContaining({ year: 2026 }), true, true);
  fireEvent.change(select, { target: { value: "2027" } });
  expect(select.value).toBe("2027");
  expect(useHpBiDashboard).toHaveBeenLastCalledWith(expect.objectContaining({ year: 2027 }), true, true);
});

it("switches account presentation back without changing reporting filters and persists per client", async () => {
  window.history.replaceState({ hpCommitteeReturn: { clientId: 9, parentKey: "layout-parent", tab: "bi", filters: {} } }, "", "/analytics");
  const { unmount } = render(<HpBiDashboard clientId={9} />);
  fireEvent.change(screen.getByTestId("select-year"), { target: { value: "2027" } });
  expect((await screen.findByTestId("detail-layout")).textContent).toContain("structured");
  fireEvent.click(screen.getByTestId("layout-original"));
  expect(screen.getByTestId("detail-layout").textContent).toContain("original");
  expect(screen.getByTestId("layout-original").getAttribute("aria-pressed")).toBe("true");
  expect((screen.getByTestId("select-year") as HTMLSelectElement).value).toBe("2027");
  expect(useHpBiDashboard).toHaveBeenLastCalledWith(expect.objectContaining({ clientId: 9, year: 2027 }), true, true);
  unmount();
  const next = render(<HpBiDashboard clientId={9} />);
  expect((await screen.findByTestId("detail-layout")).textContent).toContain("original");
  next.rerender(<HpBiDashboard clientId={10} />);
  expect(screen.getByTestId("detail-layout").textContent).toContain("structured");
  fireEvent.click(screen.getByTestId("layout-original"));
  fireEvent.click(screen.getByTestId("layout-structured"));
  expect(localStorage.getItem("hpbi-account-layout:10")).toBe("structured");
});

it("aligns labeled fields in a responsive grid and preserves each filter interaction", () => {
  vi.useFakeTimers();
  render(<HpBiDashboard clientId={9} />);
  const fields = screen.getByTestId("filter-bar");
  expect(screen.getByTestId("filter-fields").className).toContain("grid");
  for (const label of ["HP Salesperson", "Opportunity", "Dimension", "Dimension value", "Search accounts"]) {
    const control = screen.getByLabelText(label);
    expect(fields.contains(control)).toBe(true);
    expect(control.className).toContain("h-9");
    expect(control.className).toContain("w-full");
  }
  expect((screen.getByLabelText("Dimension value") as HTMLInputElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText("HP Salesperson"), { target: { value: "owner@example.invalid" } });
  fireEvent.change(screen.getByLabelText("Opportunity"), { target: { value: "Security" } });
  fireEvent.click(screen.getByTestId("filter-segment-GCC"));
  fireEvent.click(screen.getByTestId("filter-basis-PS"));
  fireEvent.click(screen.getByTestId("check-new-only"));
  fireEvent.change(screen.getByLabelText("Search accounts"), { target: { value: "Example" } });
  fireEvent.change(screen.getByLabelText("Filter accounts by qualification"), { target: { value: "Hot" } });
  fireEvent.change(screen.getByLabelText("Filter accounts by GTM source"), { target: { value: "event_feedback" } });
  fireEvent.change(screen.getByLabelText("Filter accounts by monitoring coverage"), { target: { value: "never" } });
  vi.advanceTimersByTime(400);
  // Flush the debounced state by interacting after the timer.
  fireEvent.click(screen.getByTestId("check-abm-only"));
  expect(useHpBiDashboard).toHaveBeenLastCalledWith(expect.objectContaining({
    salesPerson: "owner@example.invalid", opportunity: "Security", segment: "GCC", basis: "PS",
    newOnly: true, abmOnly: true, search: "Example", qualification: "Hot", gtmSource: "event_feedback", monitoring: "never", page: 1,
  }), true, true);
  fireEvent.click(screen.getByRole("button", { name: "Clear" }));
  expect(useHpBiDashboard).toHaveBeenLastCalledWith(expect.objectContaining({
    qualification: undefined, gtmSource: undefined, monitoring: undefined, search: undefined, page: 1,
    salesPerson: "owner@example.invalid", opportunity: "Security", segment: "GCC",
  }), true, true);
});
