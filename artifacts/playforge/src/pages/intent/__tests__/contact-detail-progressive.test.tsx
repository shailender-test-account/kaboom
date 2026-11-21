// @vitest-environment jsdom
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import ContactPage from "../contact-detail";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
function deferred() {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>(done => { resolve = done; });
  return { promise, resolve };
}
const clients: QueryClient[] = [];
afterEach(() => { cleanup(); clients.forEach(client => client.clear()); clients.length = 0; vi.unstubAllGlobals(); });

function setup() {
  window.history.replaceState({}, "", "/intent/contacts/8?client=2&audience=3&categoryName=Security&product=9");
  const pending = { identity: deferred(), evidence: deferred(), recommendations: deferred(), analysis: deferred(), engagement: deferred() };
  const fetcher = vi.fn((input: RequestInfo | URL) => {
    const url = new URL(String(input), window.location.origin);
    const section = url.searchParams.get("section") as keyof typeof pending;
    if (section) return pending[section].promise.then(response => response.clone());
    return Promise.resolve(json({ total: 20, journeyPoints: 20, affinityPoints: 0, affinities: [] }));
  });
  vi.stubGlobal("fetch", fetcher);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  clients.push(client);
  const view = render(<QueryClientProvider client={client}><ContactPage id="8" /></QueryClientProvider>);
  return { ...view, pending, fetcher };
}

describe("progressive contact detail", () => {
  it("paints identity and scope-preserving navigation before all supporting panels", async () => {
    const { pending, fetcher } = setup();
    expect(fetcher).toHaveBeenCalledTimes(1);
    await act(async () => pending.identity.resolve(json({ id: 8, name: "Test Buyer", title: "Buyer", companyId: 4, companyName: "Acme", email: "buyer@example.test", phone: "123" })));
    expect(await screen.findByText("Test Buyer")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Acme/ })).toHaveAttribute("href", "/intent/accounts/4?client=2&audience=3&categoryName=Security&product=9");
    expect(screen.getByRole("link", { name: /Buying Contacts/ })).toHaveAttribute("href", "/intent/contacts?client=2&audience=3&categoryName=Security&product=9");
    expect(screen.getByRole("link", { name: "buyer@example.test" })).toHaveAttribute("href", "mailto:buyer@example.test");
    expect(screen.getByText("Loading contact score…")).toBeInTheDocument();
    expect(screen.getByText("Loading supporting evidence…")).toBeInTheDocument();
    expect(screen.getByText("Loading recommendations…")).toBeInTheDocument();
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(6));
    fetcher.mock.calls.forEach(([input]) => {
      const url = new URL(String(input), window.location.origin);
      expect(url.searchParams.get("clientId")).toBe("2");
      expect(url.searchParams.get("audienceId")).toBe("3");
      expect(url.searchParams.get("categoryName")).toBe("Security");
      expect(url.searchParams.get("productId")).toBe("9");
    });
  });

  it("shows the contact's GTM answers and journey timeline independently of account research, with bounded paging", async () => {
    const { pending, fetcher } = setup();
    await act(async () => pending.identity.resolve(json({ id: 8, name: "Test Buyer", companyId: 4 })));
    await act(async () => pending.engagement.resolve(json({
      gtmStatus: "Hot",
      gtmEvidence: { items: [{
        id: "inbound:1", sourceType: "event_feedback", sourceName: "HP Event response",
        occurredAt: "2026-10-29T09:00:00Z", qualification: "Hot", product: "Device as a Service",
        horizonMonths: 3, journey: null, answers: { "Required solution": "Device as a Service", "Purchase timeline": "3 months" },
        feedback: { "Follow-up requested": "Yes" }, reason: "Product selected and purchase within 3 months",
      }], total: 26, page: 1, pageSize: 25, hasMore: true },
      timeline: { items: [{
        id: "activity:1", occurredAt: "2026-10-29T10:00:00Z", kind: "page_view", source: "Journey browsing",
        description: "Viewed solution page", journey: "HP DaaS Journey", page: "Device lifecycle",
        stage: "engage", product: null, scoreDelta: 5, oldScore: null, newScore: null, isBot: false,
      }, {
        id: "email:1", occurredAt: "2026-10-29T09:00:00Z", kind: "email_open", source: "Email",
        description: "Automated open", journey: null, page: null, stage: null,
        product: null, scoreDelta: null, oldScore: null, newScore: null, isBot: true,
      }], total: 2, page: 1, pageSize: 25, hasMore: false },
    })));
    expect(await screen.findByRole("region", { name: "GTM score evidence" })).toHaveTextContent("Purchase timeframe");
    expect(screen.getByText("Follow-up requested")).toBeInTheDocument();
    expect(screen.getByText("Contact qualification: Hot")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "KABOOM journey timeline" })).toHaveTextContent("HP DaaS Journey");
    expect(screen.getByText("+5 points")).toBeInTheDocument();
    expect(screen.getByText(/Bot \/ automated/)).toBeInTheDocument();
    expect(screen.getByText("Loading supporting evidence…")).toBeInTheDocument();
    fetcher.mockImplementationOnce(() => Promise.resolve(json({
      gtmStatus: "Cold", gtmEvidence: { items: [], total: 26, page: 2, pageSize: 25, hasMore: false },
      timeline: { items: [], total: 0, page: 1, pageSize: 25, hasMore: false },
    })));
    fireEvent.click(screen.getByRole("button", { name: "Next responses" }));
    await waitFor(() => expect(fetcher.mock.calls.some(([url]) => String(url).includes("gtmPage=2"))).toBe(true));
    const url = new URL(String(fetcher.mock.calls.at(-1)?.[0]), window.location.origin);
    expect(url.searchParams.get("section")).toBe("engagement");
    expect(url.searchParams.get("clientId")).toBe("2");
    expect(url.searchParams.get("audienceId")).toBe("3");
  });

  it("preserves every evidence group and contact score when recommendations fail; retries only that panel", async () => {
    const { pending, fetcher } = setup();
    await act(async () => pending.identity.resolve(json({ id: 8, name: "Test Buyer", companyId: 4, companyName: "Acme" })));
    await act(async () => {
      pending.analysis.resolve(json({ score: 61, tierKey: "warm", tierLabel: "Warm" }));
      pending.evidence.resolve(json({ scoreHistory: [], evidence: {
        contactKaboom: [{ summary: "Visited journey" }],
        public: [{ excerpt: "Public evidence", provider: "Research provider", sourceUrl: "https://example.test/source" }],
        uploaded: [{ excerpt: "Original form response", evidenceKind: "event_questionnaire" }],
      }, signals: [{ summary: "Company signal", source: "manual" }] }));
      pending.recommendations.resolve(json({ error: "Recommendations unavailable" }, 503));
    });
    expect(await screen.findByText("Visited journey")).toBeInTheDocument();
    expect(screen.getByText("Public evidence")).toBeInTheDocument();
    expect(screen.getByText("Original form response")).toBeInTheDocument();
    expect(screen.getByText("Company signal")).toBeInTheDocument();
    expect(screen.getByText("61")).toBeInTheDocument();
    const retry = await screen.findByRole("button", { name: "Retry recommendations" }, { timeout: 4000 });
    const before = fetcher.mock.calls.length;
    fetcher.mockImplementationOnce(() => Promise.resolve(json({ recommendations: [{ id: 1, title: "Discuss requirements", summary: "Use the cited form", status: "pending" }] })));
    fireEvent.click(retry);
    expect(await screen.findByText("Discuss requirements")).toBeInTheDocument();
    expect(fetcher.mock.calls.length).toBe(before + 1);
    expect(String(fetcher.mock.calls.at(-1)?.[0])).toContain("section=recommendations");
    expect(screen.getByText("61")).toBeInTheDocument();
  });

  it("keeps identity and recommendations usable after evidence fails and retries only evidence", async () => {
    const { pending, fetcher } = setup();
    await act(async () => pending.identity.resolve(json({ id: 8, name: "Test Buyer" })));
    await act(async () => {
      pending.evidence.resolve(json({ error: "Evidence unavailable" }, 503));
      pending.recommendations.resolve(json({ recommendations: [{ id: 1, title: "Read-only advice" }] }));
    });
    const retry = await screen.findByRole("button", { name: "Retry supporting evidence" }, { timeout: 4000 });
    expect(screen.getByText("Test Buyer")).toBeInTheDocument();
    expect(screen.getByText("Read-only advice")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Account/ })).not.toBeInTheDocument();
    const before = fetcher.mock.calls.length;
    fetcher.mockImplementationOnce(() => Promise.resolve(json({ scoreHistory: [], evidence: {} })));
    fireEvent.click(retry);
    expect(await screen.findByText("No recent evidence signals.")).toBeInTheDocument();
    expect(fetcher.mock.calls.length).toBe(before + 1);
    expect(String(fetcher.mock.calls.at(-1)?.[0])).toContain("section=evidence");
  });
});
