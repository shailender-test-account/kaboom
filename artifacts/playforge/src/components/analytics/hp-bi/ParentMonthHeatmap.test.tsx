// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import ParentMonthHeatmap, { filterHeatmapRecords } from "./ParentMonthHeatmap";
import type { HpBiRecord } from "./types";

const h = vi.hoisted(() => ({ heat: vi.fn(), detail: vi.fn() }));
vi.mock("@workspace/api-client-react", () => ({ useGetHpParentHeatmap: h.heat,
  getGetHpParentHeatmapQueryKey: (params: unknown) => ["/api/analytics/hp-bi/heatmap", params] }));
vi.mock("./api", () => ({ useHpBiDetail: h.detail }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const months = Array.from({ length: 12 }, (_, i) => {
  const d = new Date(Date.UTC(2024, 10 + i, 1)), e = new Date(Date.UTC(2024, 11 + i, 1));
  return { month: i + 1, label: `M${i + 1}`, start: d.toISOString(), end: e.toISOString(), isFuture: i >= 10 };
});
const cells = [5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2];
const heat = { year: 2025, metric: "touchpoints", total: 40, page: 1, pageSize: 25, maxCell: 10, months,
  rows: [{ parentKey: "p1", parentName: "Alpha Group", memberCount: 2, cells, total: 7 }] };
const rec = (o: Partial<HpBiRecord>): HpBiRecord => ({ id: "r", accountId: 1, contactId: 1, kind: "digital", occurredAt: "2024-11-10T00:00:00Z",
  category: null, product: null, horizonMonths: null, orderValue: null, currency: null, source: "s", sourceName: null, status: null, ...o });
const records = [rec({ id: "click", status: "email_click" }), rec({ id: "open", status: "email_open" }),
  rec({ id: "dec", status: "email_click", occurredAt: "2024-12-10T00:00:00Z" })];
const detail = { account: {}, members: [{ id: 1, name: "L" }], months: [], records, contacts: [{ id: 1, name: "Asha", email: null, title: null, companyId: 1, score: 1, isNew: false }] };
const filters = { clientId: 1, year: 2025 };

function setup() {
  h.heat.mockReturnValue({ data: heat, isLoading: false, isError: false, refetch: vi.fn() });
  h.detail.mockReturnValue({ data: detail, isLoading: false, isError: false, refetch: vi.fn() });
  return render(<ParentMonthHeatmap filters={filters} />);
}

describe("ParentMonthHeatmap", () => {
  it("renders 12 months, zero and future behavior", () => {
    setup();
    for (let m = 1; m <= 12; m++) expect(screen.getByTestId(`heatmap-cell-p1-${m}`)).toBeTruthy();
    expect((screen.getByTestId("heatmap-cell-p1-2") as HTMLButtonElement).disabled).toBe(false);
    const future = screen.getByTestId("heatmap-cell-p1-11") as HTMLButtonElement;
    expect(future.disabled).toBe(true); expect(future.textContent).toBe("–");
    expect((screen.getByTestId("heatmap-cell-p1-12") as HTMLButtonElement).disabled).toBe(false);
  });
  it("uses global scale and metric selection", () => {
    setup();
    expect(screen.getByTestId("heatmap-cell-p1-1").getAttribute("style")).toContain("rgb");
    fireEvent.change(screen.getByTestId("heatmap-metric"), { target: { value: "emailOpens" } });
    expect(h.heat.mock.calls.at(-1)![0].metric).toBe("emailOpens");
  });
  it("requests no detail until a cell is opened; opens, isolates, and goes back", () => {
    setup();
    expect(h.detail.mock.calls[0][1]).toBe(false);
    fireEvent.click(screen.getByTestId("heatmap-cell-p1-1"));
    expect(screen.getByTestId("heatmap-evidence").textContent).toContain("Alpha Group");
    expect(screen.getByTestId("contact-activity-record-click")).toBeTruthy();
    expect(screen.queryByTestId("contact-activity-record-dec")).toBeNull();
    fireEvent.click(screen.getByTestId("heatmap-back"));
    expect(screen.queryByTestId("heatmap-evidence")).toBeNull();
  });
  it("opens FY totals with annual records instead of the last selected month", () => {
    setup();
    fireEvent.click(screen.getByTestId("heatmap-total-p1"));
    expect(screen.getByTestId("heatmap-evidence").textContent).toContain("Full FY2025");
    expect(screen.getByTestId("contact-activity-record-dec")).toBeTruthy();
    expect(screen.getByTestId("contact-activity-record-click")).toBeTruthy();
  });
  it("clicks exclude opens", () => {
    expect(filterHeatmapRecords(records, "emailClicks", months[0]).map(r => r.id)).toEqual(["click"]);
    expect(filterHeatmapRecords(records, "emailOpens", months[0]).map(r => r.id)).toEqual(["open"]);
  });
  it("email metrics require digital kind; hot requires lead kind and hot status", () => {
    const rs = [rec({ id: "x", kind: "content", status: "email_click" }), rec({ id: "y", kind: "other", status: "email_open" }),
      rec({ id: "hl", kind: "lead", status: "hot" }), rec({ id: "wl", kind: "lead", status: "warm" }), rec({ id: "dh", kind: "digital", status: "hot" })];
    expect(filterHeatmapRecords(rs, "emailClicks", months[0])).toEqual([]);
    expect(filterHeatmapRecords(rs, "emailOpens", months[0])).toEqual([]);
    expect(filterHeatmapRecords(rs, "hot", months[0]).map(r => r.id)).toEqual(["hl"]);
  });
});
