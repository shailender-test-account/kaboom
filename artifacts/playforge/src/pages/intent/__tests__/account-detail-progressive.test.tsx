// @vitest-environment jsdom
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import AccountPage from "../account-detail";
import { mergeAccountCanonicalIntent, type IntentAccount } from "@/hooks/use-intent";

vi.mock("@/contexts/AuthContext", () => ({ useAuthContext: () => ({ user: { role: "editor" } }) }));
const monitored = vi.hoisted(() => ({ items: [] as any[] }));
vi.mock("../account-intelligence-overview", () => ({ useMonitoredAccounts: () => ({ data: monitored, isError: false }) }));
vi.mock("@/components/demo-engagement/DemoEngagementHistory", () => ({ default: () => null }));
vi.mock("../research-attribution-queue", () => ({ ResearchAttributionQueue: () => null }));
vi.mock("../research-corrections", () => ({ ResearchCorrections: () => null }));

function deferred() {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>(done => { resolve = done; });
  return { promise, resolve };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const clients: QueryClient[] = [];
afterEach(() => { cleanup(); clients.forEach(client => client.clear()); clients.length = 0; monitored.items = []; vi.unstubAllGlobals(); });

function setup() {
  window.history.replaceState({}, "", "/intent/accounts/4?client=2&categoryName=Security");
  const pending = { identity: deferred(), evidence: deferred(), research: deferred(), analysis: deferred() };
  const fetcher = vi.fn((input: RequestInfo | URL) => {
    const url = new URL(String(input), window.location.origin);
    const section = url.searchParams.get("section") as keyof typeof pending;
    if (section) return pending[section].promise.then(response => response.clone());
    if (url.pathname.endsWith("score-breakdown")) return Promise.resolve(json({ total: 0, contactPoints: 0, accountSignalPoints: 0, contacts: [], signals: [] }));
    return Promise.resolve(json({ latestRun: { completedAt: "2026-01-01" }, activeRunCount: 0 }));
  });
  vi.stubGlobal("fetch", fetcher);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  clients.push(client);
  const view = render(<QueryClientProvider client={client}><AccountPage id="4" /></QueryClientProvider>);
  return { ...view, pending, fetcher, client };
}

describe("progressive account details", () => {
  it("renders three distinct research cards, qualification, sources, then the signal feed", async () => {
    monitored.items = [{ id: 4, researchContext: {
      kind: "business_context", label: "Business context", summary: "Raw finance headline",
      businessDirections: [{ theme: "Cost discipline", signal: "India restructuring reported.",
        direction: "Operating efficiency may become a priority.", evidenceIds: [41] }],
      takeaways: [{ category: "Business Services", product: "HP Device as a Service",
        takeaway: "Conditional fit if device support is a material cost.", recommendation: "Confirm the cost baseline.",
        pitch: "Could lifecycle services reduce support overhead?", evidenceIds: [41] }],
      evidence: [{ id: 41, summary: "One original finance excerpt.", sourceUrl: "https://example.com/results", occurredAt: "2026-10-28" }],
      possibleNeeds: [], nextAction: "Validate the cost driver.", caution: "Research only—not declared intent.",
    } }];
    const { pending } = setup();
    await act(async () => pending.identity.resolve(json({ id: 4, name: "Acme" })));
    expect(await screen.findAllByTestId("account-research-summary")).toHaveLength(1);
    await act(async () => {
      pending.evidence.resolve(json({ evidence: { public: [], uploaded: [], companyKaboom: [], contactKaboom: [] }, contacts: [], scoreHistory: [] }));
      pending.research.resolve(json({}));
      pending.analysis.resolve(json({
        score: 50, tierKey: "warm",
        intentStatus: { accountStatus: "warm", accountExplanation: "Verified requirement", accountDrivingSignals: [], categories: [] },
      }));
    });
    await screen.findByRole("heading", { name: /Why confirmed buying intent is warm/i });
    expect(screen.getAllByTestId("account-research-summary")).toHaveLength(1);
    expect(screen.getAllByRole("region", { name: "Business signals and likely direction" })).toHaveLength(1);
    const summary = screen.getByTestId("account-research-summary");
    expect(within(summary).getAllByRole("article")).toHaveLength(3);
    expect(within(summary).getByRole("article", { name: "Key News" })).toBeInTheDocument();
    expect(within(summary).getByRole("article", { name: "Key Interpretation of News" })).toBeInTheDocument();
    expect(within(summary).getByRole("article", { name: "Potential HP Product Fit" })).toBeInTheDocument();
    expect(screen.getAllByText("Could lifecycle services reduce support overhead?")).toHaveLength(1);
    expect(screen.getAllByRole("region", { name: "Monitoring source excerpts" })).toHaveLength(1);
    expect(screen.queryByText("No additional validated priority")).not.toBeInTheDocument();
    expect(screen.queryByText("Business direction & solution opportunity")).not.toBeInTheDocument();
    expect(screen.queryByText("Strategic Priorities")).not.toBeInTheDocument();
    expect(screen.queryByText("HP Solution Hypotheses — Not Scored Intent")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Read source excerpt 41 for Business Services" })).toHaveAttribute("href", "#research-source-41");
    expect(document.getElementById("research-source-41")).toHaveTextContent("One original finance excerpt.");
    const qualification = document.getElementById("hotness-justification")!;
    const sources = document.getElementById("account-research-details")!;
    const feed = document.getElementById("evidence")!;
    expect(summary.compareDocumentPosition(qualification) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(qualification.compareDocumentPosition(sources) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(sources.nextElementSibling).toBe(feed);
  });
  it("keeps qualification and contact navigation usable while research is pending or fails", async () => {
    const { pending, fetcher } = setup();
    await act(async () => pending.identity.resolve(json({ id: 4, name: "Acme" })));
    await act(async () => {
      pending.evidence.resolve(json({ contacts: [{ id: 8, name: "Test Buyer", title: "Procurement", score: 10 }], evidence: { public: [], uploaded: [], companyKaboom: [], contactKaboom: [] }, scoreHistory: [] }));
      pending.analysis.resolve(json({
        score: 50, tierKey: "warm",
        canonicalCategoryIntent: { categoryName: "Security", score: 35, tier: "warm", rationale: "Declared requirement", source: "questionnaire" },
        intentStatus: { accountStatus: "warm", accountExplanation: "Verified requirement", accountDrivingSignals: [], categories: [] },
      }));
    });
    expect(await screen.findByText("Verified requirement")).toBeInTheDocument();
    expect(screen.getByTitle("Open Test Buyer")).toHaveAttribute("href", "/intent/contacts/8?client=2&categoryName=Security");
    expect(screen.getByText("Loading research brief…")).toBeInTheDocument();
    await act(async () => pending.research.resolve(json({ error: "Research temporarily unavailable" }, 503)));
    const retry = await screen.findByRole("button", { name: "Retry research brief" }, { timeout: 4000 });
    expect(screen.getByText("Verified requirement")).toBeInTheDocument();
    expect(screen.getByTitle("Open Test Buyer")).toBeInTheDocument();
    const before = fetcher.mock.calls.length;
    fetcher.mockImplementationOnce(() => Promise.resolve(json({ researchIntent: null, canonicalResearchIntent: null })));
    fireEvent.click(retry);
    await waitFor(() => expect(fetcher.mock.calls.length).toBe(before + 1));
    expect(String(fetcher.mock.calls.at(-1)?.[0])).toContain("section=research");
    await waitFor(() => expect(screen.queryByRole("button", { name: "Retry research brief" })).not.toBeInTheDocument());
    expect(screen.getByText("Verified requirement")).toBeInTheDocument();
    expect(screen.getByTitle("Open Test Buyer")).toBeInTheDocument();
  });

  it("merges independently loaded conclusions with the legacy canonical ordering", () => {
    const product: NonNullable<IntentAccount["canonicalCategoryIntent"]> = {
      categoryName: "Security", score: 35, tier: "warm", rationale: "Declared", source: "questionnaire",
    };
    const research: NonNullable<IntentAccount["canonicalCategoryIntent"]> = {
      categoryName: "IT Hardware", score: 90, tier: "hot", rationale: "Research", source: "research_propensity",
    };
    expect(mergeAccountCanonicalIntent(product, research)).toEqual(product);
    expect(mergeAccountCanonicalIntent(null, research)).toEqual(research);
    expect(mergeAccountCanonicalIntent(product, null)).toEqual(product);
    expect(mergeAccountCanonicalIntent({ ...product, source: "approved_signals" }, research)).toEqual(research);
    expect(mergeAccountCanonicalIntent({ ...product, source: "approved_signals" }, { ...research, tier: "cold", score: 99 })).toMatchObject({ categoryName: "Security" });
    expect(mergeAccountCanonicalIntent({ ...product, source: "approved_signals" }, { ...research, tier: "warm", score: 35 })).toMatchObject({ categoryName: "Security" });
  });

  it("renders identity and scoped navigation before evidence, without false Cold or empty states", async () => {
    const { pending, fetcher } = setup();
    expect(screen.getByText("Loading account identity…")).toBeInTheDocument();
    await act(async () => pending.identity.resolve(json({ id: 4, name: "Acme", domain: "acme.example", analysisScope: { selectedProductIds: [9] } })));
    expect(await screen.findByText("Acme")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Command Center/ })).toHaveAttribute("href", "/intent/accounts?client=2&categoryName=Security");
    expect(screen.getByText("Loading qualification…")).toBeInTheDocument();
    expect(screen.queryByText(/No confirmed buying-intent driver/)).not.toBeInTheDocument();
    expect(screen.queryByText(/No raw evidence records/)).not.toBeInTheDocument();
    await act(async () => pending.evidence.resolve(json({
      evidence: { uploaded: [{ id: 20, evidenceKind: "event_questionnaire", excerpt: "Original questionnaire answer", eventDate: "2026-10-01" }], public: [], companyKaboom: [], contactKaboom: [] },
      contacts: [], scoreHistory: [],
    })));
    expect((await screen.findAllByText("Original questionnaire answer")).length).toBeGreaterThan(0);
    expect(screen.getByText("Loading qualification…")).toBeInTheDocument();
    expect(screen.getByText("Loading research brief…")).toBeInTheDocument();
    const panelUrls = fetcher.mock.calls.map(([url]) => new URL(String(url), window.location.origin)).filter(url => url.searchParams.has("section"));
    expect(panelUrls).toHaveLength(4);
    panelUrls.forEach(url => {
      expect(url.searchParams.get("clientId")).toBe("2");
      expect(url.searchParams.get("categoryName")).toBe("Security");
    });
  });

  it("keeps identity visible and retries only a failed evidence panel", async () => {
    const { pending, fetcher } = setup();
    await act(async () => pending.identity.resolve(json({ id: 4, name: "Acme" })));
    await waitFor(() => expect(fetcher.mock.calls.some(([url]) => String(url).includes("section=evidence"))).toBe(true));
    await act(async () => pending.evidence.resolve(json({ error: "Evidence temporarily unavailable" }, 503)));
    const retry = await screen.findByRole("button", { name: "Retry supporting evidence" }, { timeout: 4000 });
    expect(screen.getByText("Acme")).toBeInTheDocument();
    const before = fetcher.mock.calls.length;
    fetcher.mockImplementationOnce(() => Promise.resolve(json({ evidence: { public: [], uploaded: [], companyKaboom: [], contactKaboom: [] }, contacts: [], scoreHistory: [] })));
    fireEvent.click(retry);
    await waitFor(() => expect(fetcher.mock.calls.length).toBe(before + 1));
    expect(String(fetcher.mock.calls.at(-1)?.[0])).toContain("section=evidence");
    await waitFor(() => expect(screen.queryByRole("button", { name: "Retry supporting evidence" })).not.toBeInTheDocument());
  });
});
