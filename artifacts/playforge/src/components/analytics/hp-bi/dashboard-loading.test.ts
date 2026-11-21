import { beforeEach, expect, it, vi } from "vitest";
import { useQuery } from "@tanstack/react-query";
import { useHpBiDashboard, hpBiQuery } from "./api";
import type { HpBiFilters } from "./types";

vi.mock("@tanstack/react-query", () => ({
  useQuery: vi.fn(), useMutation: vi.fn(), useQueryClient: vi.fn(),
}));
beforeEach(() => vi.mocked(useQuery).mockClear());
const filters: HpBiFilters = { clientId: 42, year: 2026, page: 1, pageSize: 5 };
const options = () => vi.mocked(useQuery).mock.calls.at(-1)![0] as any;

it("requests a bounded page and disables fullscreen refresh and focus reloads", async () => {
  const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({ ok: true, json: async () => ({}) } as Response);
  try {
    useHpBiDashboard(filters, true, false);
    const config = options();
    expect(config.refetchInterval).toBe(false);
    expect(config.refetchOnWindowFocus).toBe(false);
    await config.queryFn({ signal: new AbortController().signal });
    const url = new URL(String(fetchMock.mock.calls[0][0]), "http://fixture.invalid");
    expect(url.searchParams.get("pageSize")).toBe("5");
    expect(url.searchParams.get("page")).toBe("1");
    useHpBiDashboard(filters);
    expect(options().refetchInterval).toBe(60_000);
  } finally {
    fetchMock.mockRestore();
  }
});

it("retains the current page while paging but never shows another scope's data", () => {
  const previous = { accounts: [{ id: 1 }] };
  useHpBiDashboard({ ...filters, page: 2 });
  const placeholder = options().placeholderData;
  expect(placeholder(previous, { queryKey: ["hp-bi", filters] })).toBe(previous);
  for (const changes of [{ clientId: 43 }, { year: 2027 }, { segment: "GCC" }, { search: "Other" }, { pageSize: 25 },
    { salesPerson: "owner@example.invalid" }, { opportunity: "Security" }]) {
    expect(placeholder(previous, { queryKey: ["hp-bi", { ...filters, ...changes }] })).toBeUndefined();
  }
});

it("serializes both HP dropdown filters for dashboard, drilldowns and exports", () => {
  const params = new URLSearchParams(hpBiQuery({ ...filters, salesPerson: "owner+hp@example.invalid", opportunity: "Business Collaboration" }));
  expect(params.get("salesPerson")).toBe("owner+hp@example.invalid");
  expect(params.get("opportunity")).toBe("Business Collaboration");
  expect(new URLSearchParams(hpBiQuery(filters)).has("opportunity")).toBe(false);
});
