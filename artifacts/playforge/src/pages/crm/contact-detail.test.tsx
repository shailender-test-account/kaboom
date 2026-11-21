// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Contact } from "@workspace/api-client-react";
import { TooltipProvider } from "@/components/ui/tooltip";
import ContactDetailPage from "./contact-detail";

vi.mock("@/contexts/AuthContext", () => ({ useAuthContext: () => ({ user: { role: "admin" } }) }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("wouter", () => ({ useLocation: () => ["/crm/contacts/17", vi.fn()], useSearch: () => "" }));
vi.mock("@/components/EngagementHistory", () => ({ default: () => null }));
vi.mock("@/components/AddToSegmentDialog", () => ({ AddToSegmentDialog: () => null }));

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("displays generated contact data, initializes the edit form, saves and refetches without sending score/debug fields", async () => {
  let contact: Contact = {
    id: 17, tenantId: 1, clientId: 2, clientName: "Example client",
    firstName: "Alex", lastName: "Example", email: "alex@example.invalid",
    phone: "123456", title: "Director", companyId: null, companyName: null,
    tags: ["customer"], leadScore: 42, status: "active", stage: "engage",
    createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-02T00:00:00.000Z",
    website: "https://example.invalid", linkedinUrl: null, city: "Pune", country: "India",
    intentScore: 42, rawIntentScore: 42, intentState: "Evaluating-Engage",
    engagementScore: 8, freqScore: 1.5, maxStageScore: 10,
    velocityBonus: 10, accountBonus: 10, accountColleagues: 2, distinctActiveDays: 3,
    gccAlternatives: [],
  };
  const patches: Record<string, unknown>[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    let data: unknown = url === "/api/contacts/17" ? contact : [];
    if (url.endsWith("/timeline")) data = {};
    if (init?.method === "PATCH") {
      const patch = JSON.parse(String(init.body));
      patches.push(patch);
      contact = { ...contact, ...patch };
      data = contact;
    }
    return new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } });
  }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={client}><TooltipProvider><ContactDetailPage id="17" /></TooltipProvider></QueryClientProvider>);
  expect(await screen.findByRole("heading", { name: "Alex Example" })).toBeTruthy();
  expect(screen.getByText("Example client")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /score breakdown/i }));
  expect(screen.getByText("Velocity bonus")).toBeTruthy();
  expect(screen.getByText("Account (ABM) bonus")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /edit contact/i }));
  const dialog = await screen.findByRole("dialog");
  expect(within(dialog).getByDisplayValue("https://example.invalid")).toBeTruthy();
  expect(within(dialog).getByDisplayValue("Pune")).toBeTruthy();
  expect(within(dialog).getByDisplayValue("India")).toBeTruthy();
  fireEvent.change(within(dialog).getByDisplayValue("Alex"), { target: { value: "Updated" } });
  fireEvent.click(within(dialog).getByRole("button", { name: /save/i }));
  expect(await screen.findByRole("heading", { name: "Updated Example" })).toBeTruthy();
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(patches).toHaveLength(1);
  expect(patches[0]).toMatchObject({
    firstName: "Updated", lastName: "Example", email: "alex@example.invalid",
    website: "https://example.invalid", city: "Pune", country: "India", stage: "engage",
  });
  for (const field of ["clientName", "intentScore", "rawIntentScore", "velocityBonus", "accountBonus", "accountColleagues", "gccAlternatives"]) {
    expect(patches[0]).not.toHaveProperty(field);
  }
  client.clear();
});
