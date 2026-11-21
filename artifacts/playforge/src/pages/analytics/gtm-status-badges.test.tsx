// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GtmStatusBadge, useGtmStatuses } from "@/components/analytics/GtmStatusBadge";
import { AccountsAnalyticsPanel } from "@/components/analytics/AccountsAnalyticsPanel";
import { ContactListPanel } from "./index";
import { InboundJourneyPanel } from "./InboundJourneyPanel";

const respondent = { id: 11, first_name: "Ada", last_name: "Respondent", email: "ada@example.test", company_name: "Example Co" };
const nonrespondent = { id: 12, first_name: "Nia", last_name: "Nonrespondent", email: "nia@example.test", company_name: "Example Co" };
const hot = { status: "hot" as const, updatedAt: "2026-04-01T10:00:00.000Z" };

const json = (body: unknown) => ({ ok: true, json: async () => body }) as Response;
const event = (id: number, name: string) => ({
  id: String(id), eventType: "page_view", description: "Viewed journey",
  createdAt: "2026-04-02T10:00:00.000Z", contactId: id, contactName: name,
  email: null, scoreDelta: 0, totalScore: 0, tags: [], stage: null,
});

function ContactRows() {
  const { data, isLoading, isError } = useGtmStatuses([12, 11, 12]);
  return <ContactListPanel contacts={[respondent, nonrespondent]} loading={false}
    onSelect={() => {}} gtmStatuses={data ?? {}} gtmLoading={isLoading} gtmError={isError} />;
}

let client: QueryClient;
const requests = vi.fn();

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  requests.mockReset();
  vi.stubGlobal("fetch", requests.mockImplementation(async (input: string, init?: RequestInit) => {
    if (input === "/api/analytics/gtm-status") {
      expect(init?.method).toBe("POST");
      expect(init?.credentials).toBe("include");
      expect(JSON.parse(String(init?.body))).toEqual({ contactIds: [11, 12] });
      // The endpoint returns respondents by contact ID; nonrespondents have no key.
      return json({ contacts: { "11": hot } });
    }
    if (input.startsWith("/api/analytics/inbound-account-journey?")) {
      return json({ accountName: "Example Co", hasMore: false, events: [
        event(11, "Ada Respondent"), event(12, "Nia Nonrespondent"),
      ] });
    }
    if (input.startsWith("/api/analytics/accounts?")) {
      return json({ items: [{
        id: 7, name: "Example Co", clientName: null, contactCount: 2,
        activityScore: 0, intentScore: 0, gtmStatus: hot, lastActivity: null,
        journeyCount: 0, eventCount: 0, journeyName: null, keyContactName: "Ada Respondent",
      }], page: 1, hasMore: false, total: 1 });
    }
    if (input === "/api/analytics/accounts/7?clientId=1") {
      expect(init?.credentials).toBe("include");
      return json({
        account: {
          id: 7, name: "Example Co", clientName: null, contactCount: 2,
          activityScore: 0, intentScore: 0, gtmStatus: hot, lastActivity: null,
          journeyCount: 0, eventCount: 0, journeyName: null, keyContactName: "Ada Respondent",
        },
        contacts: [
          { id: 11, name: "Ada Respondent", leadScore: 0, stage: null, lastActivity: null,
            leadForm: true, eventFeedback: false, journey: false, gtmStatus: hot },
          { id: 12, name: "Nia Nonrespondent", leadScore: 0, stage: null, lastActivity: null,
            leadForm: false, eventFeedback: false, journey: true, gtmStatus: null },
        ],
        journeys: [], contactCount: 2,
      });
    }
    if (input.startsWith("/api/analytics/accounts/7/activity?")) {
      return json({ items: [], page: 1, hasMore: false });
    }
    if (input === "/api/analytics/acquisition") return json({ contacts: {}, accounts: {} });
    throw new Error(`Unexpected request: ${input}`);
  }));
});

afterEach(() => {
  cleanup();
  client.clear();
  vi.unstubAllGlobals();
});

function withQuery(ui: React.ReactElement) {
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

describe("Analytics qualification badge scope", () => {
  it("shows the filtered total and next page above the account list", async () => {
    requests.mockImplementation(async (input: string) => {
      if (input.startsWith("/api/analytics/accounts?")) {
        const page = Number(new URL(input, "http://localhost").searchParams.get("page"));
        return json({
          items: [{
            id: page === 1 ? 7 : 8, name: `Account ${page}`, clientName: "HP", contactCount: 0,
            activityScore: 0, intentScore: null, gtmStatus: null, lastActivity: null,
            journeyCount: 0, eventCount: 0, journeyName: null, keyContactName: null,
          }],
          page, hasMore: true, total: 45,
        });
      }
      if (input === "/api/analytics/acquisition") return json({ contacts: {}, accounts: {} });
      throw new Error(`Unexpected request: ${input}`);
    });
    withQuery(<AccountsAnalyticsPanel filters={{ clientId: "1", inboundOnly: "1" }} />);
    await screen.findByTestId("button-open-account-7");
    expect(screen.getAllByTestId("text-Accounts-page")[0]).toHaveTextContent("Page 1 of 3 · Showing 1–20 of 45 accounts");
    fireEvent.click(screen.getAllByTestId("button-Accounts-next")[0]);
    await screen.findByTestId("button-open-account-8");
    expect(screen.getAllByTestId("text-Accounts-page")[0]).toHaveTextContent("Page 2 of 3 · Showing 21–40 of 45 accounts");
  });

  it("uses POST contact IDs for the contact list, without inheriting the employer's Hot status", async () => {
    withQuery(<ContactRows />);
    const ada = screen.getByRole("button", { name: /Ada Respondent/ });
    const nia = screen.getByRole("button", { name: /Nia Nonrespondent/ });
    await waitFor(() => expect(within(ada).getByText("GTM OS Contact qualification · Hot")).toBeInTheDocument());
    expect(within(nia).getByText("GTM OS Contact qualification · Not classified")).toHaveAttribute(
      "title", "No inbound contact qualification recorded",
    );
    expect(within(nia).queryByText(/qualification · Hot/)).not.toBeInTheDocument();
    expect(requests).toHaveBeenCalledTimes(1);
  });

  it("shows the same contact-specific result in inbound journey rows", async () => {
    withQuery(<InboundJourneyPanel clientId="1" accountId="7" playId="" journeyId=""
      dateFrom="" dateTo="" onContact={() => {}} />);
    const ada = await screen.findByRole("button", { name: "Ada Respondent" });
    const nia = screen.getByRole("button", { name: "Nia Nonrespondent" });
    await waitFor(() => expect(ada.parentElement).toHaveTextContent("GTM OS Contact qualification · Hot"));
    expect(nia.parentElement).toHaveTextContent("GTM OS Contact qualification · Not classified");
    expect(nia.parentElement).not.toHaveTextContent("qualification · Hot");
  });

  it("retains account qualification wording on account rows", async () => {
    withQuery(<AccountsAnalyticsPanel filters={{ clientId: "1" }} />);
    const account = await screen.findByTestId("button-open-account-7");
    expect(within(account).getByText("GTM OS Account qualification · Hot")).toHaveAttribute(
      "title", expect.stringContaining("GTM OS account qualification"),
    );
    expect(within(account).queryByText(/GTM OS Contact qualification/)).not.toBeInTheDocument();
    // The shared badge defaults to account scope for account callers.
    const { container } = withQuery(<GtmStatusBadge status={hot} />);
    expect(container).toHaveTextContent("GTM OS Account qualification · Hot");
  });

  it("keeps account qualification in the detail sheet without assigning it to nonrespondents", async () => {
    withQuery(<AccountsAnalyticsPanel filters={{ clientId: "1" }} />);
    fireEvent.click(await screen.findByTestId("button-open-account-7"));

    const ada = await screen.findByTestId("button-account-contact-11");
    const nia = screen.getByTestId("button-account-contact-12");
    expect(within(ada).getByText("GTM OS Contact qualification · Hot")).toBeInTheDocument();
    expect(within(nia).queryByText(/GTM OS Contact qualification · Hot/)).not.toBeInTheDocument();
    expect(within(nia).queryByText(/GTM OS Contact qualification/)).not.toBeInTheDocument();

    const sheet = screen.getByRole("dialog");
    expect(within(sheet).getByText("GTM OS Account qualification · Hot")).toHaveAttribute(
      "title", expect.stringContaining("GTM OS account qualification"),
    );
    expect(requests).toHaveBeenCalledWith("/api/analytics/accounts/7?clientId=1", expect.anything());
  });
});