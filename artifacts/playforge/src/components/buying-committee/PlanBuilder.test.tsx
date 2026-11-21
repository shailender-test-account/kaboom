// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import PlanBuilder, { draftFromCopy, type Draft } from "./PlanBuilder";

const mocks = vi.hoisted(() => ({ save: vi.fn(), toast: vi.fn(), lookup: vi.fn(), accounts: vi.fn() }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock("./api", () => ({
  committeeCategories: ["Security", "Collaboration", "IT Hardware", "Business Services"],
  useBuyingAccounts: (filters: unknown) => {
    mocks.accounts(filters);
    return { data: { items: [{ id: 7, name: "Roster account", domain: null, segment: "GCC" }], total: 1, pageSize: 20, segments: ["GCC", "MNC", "Gov/Edu", "India Inc/PSU", "Unclassified"] } };
  },
  useBuyingSuggestions: () => ({ data: { designations: [] } }),
  useSaveBuyingPlan: () => ({ mutate: mocks.save, isPending: false }),
  committeeRequest: (...args: unknown[]) => mocks.lookup(...args),
}));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
const draft = (): Draft => ({
  name: "Committee draft", includeRoster: true, audienceIds: [],
  accounts: Object.fromEntries([1, 2, 3].map(id => [id, { id, name: `Account ${id}`, domain: null }])),
  categories: ["Security"], designations: ["CISO"], limitPerAccount: 3, domains: {},
});
const show = (initial = draft()) => {
  const onSaved = vi.fn();
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { mutations: { retry: false } } })}>
    <PlanBuilder clientId={9} databases={[]} maxRequests={20} countries={["India","United States","United Kingdom"]} initial={initial} onSaved={onSaved} onCancel={vi.fn()} />
  </QueryClientProvider>);
  return onSaved;
};
it("saves three selected accounts without domains and explains the remaining approval step", () => {
  mocks.save.mockImplementationOnce((_config, options) => options.onSuccess({ plan: { id: 17 } }));
  const onSaved = show();
  const save = screen.getByRole("button", { name: "Save draft" }) as HTMLButtonElement;
  expect(save.disabled).toBe(false);
  expect(screen.getByText(/You can save the draft now and add domains later/)).toBeTruthy();
  fireEvent.click(save);
  expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({
    accountIds: [1, 2, 3], domains: { "1": "", "2": "", "3": "" }, categories: ["Security"], designations: ["CISO"],
  }), expect.any(Object));
  expect(onSaved).toHaveBeenCalledWith(17);
  expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Draft saved", description: expect.stringContaining("before approval and sourcing") }));
});
it("preserves known domains and permits a draft with only some domains confirmed", () => {
  const initial = draft();
  initial.accounts[1].domain = "account-one.com";
  show(initial);
  fireEvent.change(screen.getByRole("textbox", { name: "Confirmed domain for Account 2" }), { target: { value: "account-two.com" } });
  fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
  expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({
    domains: { "1": "account-one.com", "2": "account-two.com", "3": "" },
  }), expect.any(Object));
});
it("still requires the plan's basic account, role, category and source selections", () => {
  for (const initial of [
    { ...draft(), accounts: {} },
    { ...draft(), categories: [] },
    { ...draft(), designations: [] },
    { ...draft(), includeRoster: false },
    { ...draft(), name: " " },
  ] as Draft[]) {
    show(initial);
    expect((screen.getByRole("button", { name: "Save draft" }) as HTMLButtonElement).disabled).toBe(true);
    cleanup();
  }
  expect(mocks.save).not.toHaveBeenCalled();
});
const evidence = {
  accountId: 1, legalName: "Account 1", parentName: "Parent Group", provider: null, requests: 0,
  warnings: ["Parent-company evidence needs review"],
  candidates: [{ domain: "parent-group.com", sourceUrl: "https://parent-group.com/legal",
    evidence: "Official legal subsidiaries page", relationship: "parent-company", origin: "CRM website" }],
};
it("keeps lookup suggestions out of the draft until explicit verification and confirmation, then persists only on Save", async () => {
  mocks.lookup.mockResolvedValue(evidence);
  show();
  expect(mocks.lookup).not.toHaveBeenCalled();
  fireEvent.click(screen.getAllByRole("button", { name: "Lookup website" })[0]);
  await screen.findByText("Official legal subsidiaries page");
  expect(mocks.lookup).toHaveBeenCalledWith("/domain-lookup", expect.objectContaining({ accountId: 1, clientId: 9, research: false, acknowledgeCost: false }));
  const domain = screen.getByRole("textbox", { name: "Confirmed domain for Account 1" }) as HTMLInputElement;
  expect(domain.value).toBe("");
  expect(screen.getByRole("link", { name: /Open website\/source/ }).getAttribute("href")).toBe("https://parent-group.com/legal");
  fireEvent.click(screen.getByRole("radio"));
  const confirm = screen.getByRole("button", { name: "Confirm domain for draft" }) as HTMLButtonElement;
  expect(confirm.disabled).toBe(true);
  expect(mocks.save).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("checkbox", { name: /I checked the official source/ }));
  fireEvent.click(confirm);
  expect(domain.value).toBe("parent-group.com");
  expect(mocks.save).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
  expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({ domains: { "1": "parent-group.com", "2": "", "3": "" } }), expect.any(Object));
});
it("requires fresh cost acknowledgement for each research attempt and does not attach results on errors", async () => {
  mocks.lookup.mockResolvedValueOnce({ ...evidence, candidates: [] }).mockRejectedValueOnce(new Error("Provider failed; request may have incurred cost"));
  show();
  fireEvent.click(screen.getAllByRole("button", { name: "Lookup website" })[0]);
  const research = await screen.findByRole("button", { name: "Research public website" }) as HTMLButtonElement;
  expect(research.disabled).toBe(true);
  fireEvent.click(screen.getByRole("checkbox", { name: /I acknowledge the provider cost/ }));
  fireEvent.click(research);
  await screen.findByRole("alert");
  await waitFor(() => expect(research.disabled).toBe(true));
  expect(mocks.lookup).toHaveBeenLastCalledWith("/domain-lookup", expect.objectContaining({ research: true, acknowledgeCost: true }));
  expect((screen.getByRole("textbox", { name: "Confirmed domain for Account 1" }) as HTMLInputElement).value).toBe("");
  expect(mocks.save).not.toHaveBeenCalled();
  expect(mocks.lookup).toHaveBeenCalledTimes(2);
});
it("paginates selected domains without losing selections or triggering lookups", () => {
  const initial = draft();
  initial.accounts = Object.fromEntries(Array.from({ length: 23 }, (_, i) => [i + 1, { id: i + 1, name: `Account ${i + 1}`, domain: null }]));
  show(initial);
  expect(screen.getAllByRole("button", { name: "Lookup website" })).toHaveLength(10);
  fireEvent.change(screen.getByRole("textbox", { name: "Confirmed domain for Account 1" }), { target: { value: "confirmed-domain.com" } });
  fireEvent.click(screen.getByRole("button", { name: "Next selected" }));
  expect(screen.queryByRole("textbox", { name: "Confirmed domain for Account 1" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Next selected" }));
  expect(screen.getAllByRole("button", { name: "Lookup website" })).toHaveLength(3);
  fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
  expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({ accountIds: Array.from({ length: 23 }, (_, i) => i + 1),
    domains: expect.objectContaining({ "1": "confirmed-domain.com", "23": "" }) }), expect.any(Object));
  expect(mocks.lookup).not.toHaveBeenCalled();
});
it("warns when selected legal companies share a parent domain, including URL variants", () => {
  const initial = draft();
  initial.domains = { "1": "https://www.parent-company.com/legal", "2": "parent-company.com" };
  show(initial);
  expect(screen.getByRole("alert").textContent).toContain("Selected legal accounts share parent-company.com");
  expect(screen.getByRole("alert").textContent).toContain("Approval remains blocked");
  expect(mocks.save).not.toHaveBeenCalled();
});
it("shows HP segment labels and sends a segment filter without clearing selected accounts", () => {
  show();
  expect(screen.getAllByText("GCC").length).toBeGreaterThan(0);
  fireEvent.change(screen.getByRole("combobox", { name: "HP segment" }), { target: { value: "Gov/Edu" } });
  expect(mocks.accounts).toHaveBeenLastCalledWith(expect.objectContaining({ segment: "Gov/Edu", page: 1 }));
  fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
  expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({ accountIds: [1, 2, 3] }), expect.any(Object));
});
it("saves the explicitly selected contact country with the draft", () => {
  show();
  fireEvent.change(screen.getByRole("combobox", { name: "Contact country" }), { target: { value: "United States" } });
  fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
  expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({ country: "United States" }), expect.any(Object));
});
it("opens a copied legacy plan without filling country or domains and requires explicit Save", () => {
  const copy = {config:{clientId:9,name:"Revised plan",includeRoster:true,audienceIds:[11],accountIds:[1,2],
    categories:["Security" as const],designations:["CISO"],limitPerAccount:3,domains:{"1":"reviewed.com","2":""}},
    accounts:[{id:1,name:"Reviewed company"},{id:2,name:"Incomplete company"}]};
  const initial=draftFromCopy(copy);
  show(initial);
  expect((screen.getByRole("combobox",{name:"Contact country"}) as HTMLSelectElement).value).toBe("");
  expect((screen.getByRole("textbox",{name:"Confirmed domain for Reviewed company"}) as HTMLInputElement).value).toBe("reviewed.com");
  expect((screen.getByRole("textbox",{name:"Confirmed domain for Incomplete company"}) as HTMLInputElement).value).toBe("");
  expect(mocks.save).not.toHaveBeenCalled();
  expect(mocks.lookup).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button",{name:"Save draft"}));
  expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining(copy.config),expect.any(Object));
  expect(copy.config.domains).toEqual({"1":"reviewed.com","2":""});
});
