// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import FirstPartySourceButton from "../FirstPartySourceButton";

const clients: QueryClient[] = [];
afterEach(() => { cleanup(); clients.forEach(client => client.clear()); clients.length = 0; vi.unstubAllGlobals(); });
function setup(kind: "inbound_submission" | "intent_evidence" = "inbound_submission", formType = "event_feedback") {
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
    id: 21, kind, formType, sourceName: "HP event responses", fileName: "Event questionnaire.xlsx",
    submittedAt: "2026-09-23T10:00:00Z", importedAt: "2026-10-01T09:00:00Z", dateOrigin: "source",
    contactId: 8, contactName: "Test Buyer", classification: "warm", product: "Device as a Service",
    horizonMonths: 6, reason: "Selected product with a purchase timeframe over three and up to six months.",
    answers: { "Selected solution": "Device as a Service", "Purchase timeline": "4–6 months", "__internal": "Hidden metadata" },
    feedback: { "Follow-up requested": "Yes" },
  }), { status: 200, headers: { "Content-Type": "application/json" } }));
  vi.stubGlobal("fetch", fetcher);
  const client = new QueryClient({ defaultOptions: { queries: { retryDelay: 0, gcTime: 0 } } });
  clients.push(client);
  render(<QueryClientProvider client={client}><FirstPartySourceButton accountId="4"
    scope={{ clientId: 2, audienceId: 3, productId: 9 }} signal={{
      evidenceId: 0, signalType: "lead_form", quote: "Selected product", occurredAt: "2026-09-23", strength: "moderate",
      firstPartySource: { kind, id: 21, formType },
    }} /></QueryClientProvider>);
  return { fetcher, client };
}
it("labels the actual response type and only fetches the exact scoped source after a click", async () => {
  const { fetcher } = setup();
  expect(fetcher).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "View event questionnaire source response" }));
  expect(await screen.findByRole("heading", { name: "Event questionnaire · Original response" })).toBeInTheDocument();
  expect(await screen.findByText("Event questionnaire.xlsx")).toBeInTheDocument();
  expect(screen.getByRole("region", { name: "Original submitted answers" })).toHaveTextContent("4–6 months");
  expect(screen.queryByText("Hidden metadata")).not.toBeInTheDocument();
  expect(screen.getByText("Recorded qualification")).toBeInTheDocument();
  const url = new URL(String(fetcher.mock.calls[0][0]), window.location.origin);
  expect(url.pathname).toContain("/intent/accounts/4");
  expect(Object.fromEntries(url.searchParams)).toMatchObject({
    section: "first-party-source", sourceKind: "inbound_submission", sourceId: "21", clientId: "2", audienceId: "3", productId: "9",
  });
  const link = screen.getByRole("link", { name: "Test Buyer" });
  expect(link).toHaveAttribute("href", "/intent/contacts/8?clientId=2&audienceId=3&productId=9");
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it("retains a real lead-form label for a lead-form source", async () => {
  setup("intent_evidence", "lead_form");
  fireEvent.click(screen.getByRole("button", { name: "View lead form source response" }));
  expect(await screen.findByText("Event questionnaire.xlsx")).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Lead form · Original response" })).toBeInTheDocument();
});
it("shows a retryable error instead of inventing a source when the response is unavailable", async () => {
  const { fetcher } = setup();
  fetcher.mockImplementation(async () => new Response(JSON.stringify({ error: "Source response not found" }), {
    status: 404, headers: { "Content-Type": "application/json" },
  }));
  fireEvent.click(screen.getByRole("button", { name: "View event questionnaire source response" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Source response could not be loaded");
  expect(screen.getByRole("button", { name: "Retry source response" })).toBeInTheDocument();
  expect(screen.queryByText("Test Buyer")).not.toBeInTheDocument();
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
});
