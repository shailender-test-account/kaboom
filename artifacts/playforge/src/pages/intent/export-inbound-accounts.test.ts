import { afterEach, describe, expect, it, vi } from "vitest";
import type { IntentInboundAccount } from "@/hooks/use-intent";
import { fetchInboundAccountsForExport, inboundAccountsCsv } from "./export-inbound-accounts";

const account = (id: number, name: string): IntentInboundAccount => ({
  account_id: id,
  client_id: 3,
  name,
  domain: null,
  classification: "hot",
  classification_reason: "Requested follow-up",
  form_type: "event_feedback",
  submitted_at: "2026-09-28T10:00:00.000Z",
  imported_at: "2026-09-28T10:00:00.000Z",
  response_count: 2,
  routes: [],
  respondents: [{
    id: 1, name: "Person One", title: "", email: "person@example.test",
    isPrimary: true, responseCount: 2, interests: [{
      submissionId: 11, selection: "HP Devices", category: "IT Hardware",
      classification: "hot", routingStatus: "pending", routingError: null,
      manualJourneyId: null, manualSequenceId: null, responseManuallyRouted: false,
    }],
  }],
});

afterEach(() => vi.unstubAllGlobals());

describe("inbound account CSV export", () => {
  it("escapes imported text and neutralizes spreadsheet formulas", () => {
    const csv = inboundAccountsCsv([account(12, '=SUM(1,2) "Demo"')]);
    expect(csv.startsWith("\uFEFF")).toBe(true);
    expect(csv).toContain("\"'=SUM(1,2) \"\"Demo\"\"\"");
    expect(csv).toContain("\"HP Devices\"");
    expect(csv).toContain("\"person@example.test\"");
  });

  it("exports every page using the same current filters, not only the visible page", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const query = new URL(url, "https://example.test").searchParams;
      expect(query.get("classification")).toBe("hot");
      expect(query.get("search")).toBe("group");
      expect(query.get("category")).toBe("IT Hardware");
      expect(query.get("pageSize")).toBe("100");
      const page = Number(query.get("page"));
      return new Response(JSON.stringify({
        accounts: [account(page, `Group ${page}`)], total: 2, totalPages: 2,
      }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const accounts = await fetchInboundAccountsForExport({
      classification: "hot", search: "group", category: "IT Hardware",
    });
    expect(accounts.map(row => row.account_id)).toEqual([1, 2]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("fails rather than downloading an incomplete export if the list changes", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        accounts: [account(1, "Group 1")], total: 2, totalPages: 2,
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        accounts: [], total: 2, totalPages: 2,
      }), { status: 200 })));
    await expect(fetchInboundAccountsForExport({ classification: "hot" }))
      .rejects.toThrow("changed during export");
  });
});