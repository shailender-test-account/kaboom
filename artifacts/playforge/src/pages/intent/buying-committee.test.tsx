// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import BuyingCommitteePage from "./buying-committee";

vi.mock("@/components/intent/ui", () => ({ IntentPageHeader: () => null }));
vi.mock("@/components/buying-committee/PlanBuilder", () => ({ default: () => null, draftFromPlan: vi.fn(), emptyDraft: () => ({}) }));
vi.mock("@/components/buying-committee/PlanDomains", () => ({ default: () => null }));
vi.mock("@/components/buying-committee/CommitteeContacts", () => ({ default: () => null }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function setup(path: string, missing = false) {
  const fetcher = vi.fn(async (url: string, _init?: RequestInit) => {
    const u = new URL(url, "http://localhost");
    let body: unknown;
    let status = 200;
    if (u.pathname.endsWith("/options")) body = { clients: [{ id: 1, name: "HP" }, { id: 9, name: "HP India" }], databases: [], countries: ["India"], canManage: false, configured: true, maxRequests: 20 };
    else if (/\/plans\/\d+$/.test(u.pathname)) {
      status = missing ? 404 : 200;
      body = missing ? { error: "Buying committee plan not found." } : {
        plan: { id: 301, client_id: 9, name: "Exact older plan", status: "approved", revision: 1, approved_at: null,
          config: { clientId: 9, accountIds: [11], country: "India", categories: ["Security"], designations: ["CISO"], limitPerAccount: 3 } },
        targets: [{ id: 1, company_id: 11, name: "Legal account", domain: "example.com", status: "pending", requests: 0, responses: 0, found: 0 }],
      };
    } else if (u.pathname.endsWith("/plans")) body = { items: [], total: 101 };
    else throw new Error(`Unexpected read: ${url}`);
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetcher);
  const memory = memoryLocation({ path, record: true });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const view = render(<QueryClientProvider client={client}><Router hook={memory.hook}><BuyingCommitteePage /></Router></QueryClientProvider>);
  return { fetcher, memory, view };
}

it("opens an older plan on direct load/reload, resolves its real client and remains view-only", async () => {
  let current = setup("/intent/buying-committee?planId=301");
  expect(screen.getByRole("heading", { name: "Buying Committee", level: 1 })).toBeTruthy();
  expect(screen.queryByText("INTENT ENGINE")).toBeNull();
  await screen.findByText("Exact older plan");
  expect((screen.getByRole("combobox", { name: "Client" }) as HTMLSelectElement).value).toBe("9");
  expect(screen.getByText("View only. Admins can edit, approve and source plans.")).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Source selected|Approve plan|New plan/ })).toBeNull();
  await waitFor(() => expect(current.fetcher.mock.calls.some(([u]) => u === "/api/buying-committee/plans?clientId=9&page=1")).toBe(true));
  expect(current.fetcher.mock.calls.some(([u]) => u.includes("page=2") || u.includes("clientId=1&"))).toBe(false);
  expect(current.fetcher.mock.calls.every(([, init]) => (init as RequestInit).method === "GET")).toBe(true);
  const back = vi.spyOn(window.history, "back").mockImplementation(() => {});
  fireEvent.click(screen.getByRole("button", { name: "Back" }));
  // jsdom may have only one history entry; the fallback is a same-app route.
  expect(back.mock.calls.length > 0 || current.memory.history?.at(-1) === "/analytics").toBe(true);
  current.view.unmount();
  current = setup("/intent/buying-committee?planId=301");
  await screen.findByText("Exact older plan");
});

it.each(["abc", "0", "-3", "3.5", "", "2147483648", "9007199254740993"])("rejects malformed plan ID %s without reading a plan or choosing another client", async id => {
  const { fetcher } = setup(`/intent/buying-committee?planId=${id}`);
  await screen.findByRole("alert");
  expect(screen.getByText(/Invalid buying committee plan link/)).toBeTruthy();
  expect(fetcher.mock.calls.every(([url]) => url.endsWith("/options"))).toBe(true);
});

it("shows missing/foreign IDs as unavailable without falling back to the first client's plans", async () => {
  const { fetcher } = setup("/intent/buying-committee?planId=999", true);
  await screen.findByText(/Buying committee plan not found/);
  expect(fetcher.mock.calls.some(([url]) => url.includes("/plans?"))).toBe(false);
  expect(fetcher.mock.calls.every(([, init]) => (init as RequestInit).method === "GET")).toBe(true);
});
