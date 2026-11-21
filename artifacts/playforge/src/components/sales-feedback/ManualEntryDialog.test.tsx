// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ManualEntryDialog } from "./ManualEntryDialog";

vi.mock("@/contexts/AuthContext", () => ({ useAuthContext: () => ({ user: { id: 7, tenantId: 1, email: "priya@example.invalid", firstName: "Priya", lastName: "Nair", role: "member", sectionPermissions: null, avatarUrl: null } }) }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const accountA = { id: 10, name: "Abbott", clientId: 1 };
const accountZ = { id: 20, name: "Zebra", clientId: 1 };
const contactA = { id: 11, name: "Alice", email: "alice@example.invalid", companyId: 10, clientId: 1 };
const contactZ = { id: 21, name: "Zoe", email: "zoe@example.invalid", companyId: 20, clientId: 1 };
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={client}><ManualEntryDialog open onOpenChange={vi.fn()} defaultClientId={1} /></QueryClientProvider>);
}
function mockOptions(failContacts = false) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    if (init?.method === "POST") return new Response(JSON.stringify({ id: 123 }), { status: 201 });
    const q = new URL(String(url), "http://localhost").searchParams;
    if (failContacts && q.get("accountId")) return new Response(JSON.stringify({ error: "Contact access denied" }), { status: 403 });
    const account = q.get("accountId");
    return new Response(JSON.stringify({
      clients: [{ id: 1, name: "HP" }, { id: 2, name: "Other client" }],
      accounts: q.get("clientId") === "2" ? [] : q.get("accountPage") === "2" || q.get("search") === "Zebra" ? [accountZ] : [accountA],
      contacts: account === "10" ? [contactA] : account === "20" ? [contactZ] : [],
      accountsHasMore: q.get("accountPage") !== "2" && !q.get("search"),
      contactsHasMore: false, products: [], googleDriveConnected: false,
    }), { status: 200 });
  });
}
const select = (id: string) => screen.getByTestId(id) as HTMLSelectElement;

it("loads contacts for the chosen account, resets them when changing account, and saves matching IDs", async () => {
  const fetcher = mockOptions();
  mount();
  await screen.findByRole("option", { name: "Abbott" });
  expect(select("select-manual-contact").disabled).toBe(true);
  fireEvent.change(select("select-manual-account"), { target: { value: "10" } });
  await screen.findByRole("option", { name: /Alice/ });
  fireEvent.change(select("select-manual-contact"), { target: { value: "11" } });
  await waitFor(() => expect(select("select-manual-contact").disabled).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: "Next accounts" }));
  await screen.findByRole("option", { name: "Zebra" });
  expect(select("select-manual-account").value).toBe("10");
  fireEvent.change(select("select-manual-account"), { target: { value: "20" } });
  expect(select("select-manual-contact").value).toBe("");
  await screen.findByRole("option", { name: /Zoe/ });
  expect(screen.queryByRole("option", { name: /Alice/ })).toBeNull();
  fireEvent.change(select("select-manual-contact"), { target: { value: "21" } });
  expect(screen.queryByTestId("input-manual-rep")).toBeNull();
  expect(screen.getByTestId("text-manual-author").textContent).toContain("Priya Nair");
  fireEvent.change(screen.getByTestId("input-manual-feedback"), { target: { value: "Spoke to Zoe" } });
  await waitFor(() => expect((screen.getByTestId("button-save-manual") as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByTestId("button-save-manual"));
  await waitFor(() => expect(fetcher.mock.calls.some(([, init]) => init?.method === "POST")).toBe(true));
  const body = JSON.parse(String(fetcher.mock.calls.find(([, init]) => init?.method === "POST")?.[1]?.body));
  expect(body).toMatchObject({ clientId: 1, accountId: 20, contactId: 21 });
  expect(body).not.toHaveProperty("repName");
  expect(fetcher.mock.calls.some(([url]) => String(url).includes("accountId=20"))).toBe(true);
});

it("searches beyond the first accounts page and clears account/contact when client changes", async () => {
  mockOptions();
  mount();
  await screen.findByRole("option", { name: "Abbott" });
  fireEvent.change(screen.getByTestId("input-manual-search"), { target: { value: "Zebra" } });
  await screen.findByRole("option", { name: "Zebra" });
  fireEvent.change(select("select-manual-account"), { target: { value: "20" } });
  await screen.findByRole("option", { name: /Zoe/ });
  fireEvent.change(select("select-manual-client"), { target: { value: "2" } });
  await screen.findByText("No matching accounts.");
  expect(select("select-manual-account").value).toBe("");
  expect(select("select-manual-contact").value).toBe("");
  expect(select("select-manual-contact").disabled).toBe(true);
  expect(screen.queryByRole("option", { name: /Zoe/ })).toBeNull();
});

it("shows a contact-fetch error rather than an empty list or contacts from another account", async () => {
  mockOptions(true);
  mount();
  await screen.findByRole("option", { name: "Abbott" });
  fireEvent.change(select("select-manual-account"), { target: { value: "10" } });
  await screen.findByRole("alert");
  expect(select("select-manual-contact").disabled).toBe(true);
  expect(screen.queryByRole("option", { name: /Alice/ })).toBeNull();
  expect(screen.queryByText("No contacts saved for this account.")).toBeNull();
});

it("shows the signed-in author as non-editable and prefills account-scoped contacts", async () => {
  const fetcher = mockOptions();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><ManualEntryDialog open onOpenChange={vi.fn()} prefill={{ clientId: 1, accountId: 10 }} /></QueryClientProvider>);
  await screen.findByRole("option", { name: /Alice/ });
  expect(select("select-manual-client").value).toBe("1");
  expect(select("select-manual-account").value).toBe("10");
  const author = screen.getByTestId("text-manual-author");
  expect(author.textContent).toContain("Priya Nair");
  expect(author.querySelector("input")).toBeNull();
  expect(fetcher.mock.calls.some(([url]) => String(url).includes("accountId=10"))).toBe(true);
});
