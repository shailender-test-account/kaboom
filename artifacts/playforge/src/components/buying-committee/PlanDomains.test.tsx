// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import PlanDomains from "./PlanDomains";
import type { CommitteePlan, CommitteeTarget } from "./api";
const mocks = vi.hoisted(() => ({ save: vi.fn(), toast: vi.fn() }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock("./api", () => ({ useSaveBuyingPlan: () => ({ mutate: mocks.save, isPending: false }) }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
const plan: CommitteePlan = { id: 10, client_id: 9, name: "Draft", status: "draft", revision: 1, approved_at: null, created_at: "",
  config: { clientId: 9, name: "Draft", includeRoster: true, audienceIds: [4], accountIds: [1, 2], categories: ["Security"], designations: ["CISO"], limitPerAccount: 3, domains: { "1": "first.com", "2": "" } } };
const targets: CommitteeTarget[] = [1, 2].map(id => ({ id, company_id: id, name: `Company ${id}`, domain: id === 1 ? "first.com" : "", status: "pending", requests: 0, responses: 0, found: 0, error: null }));
it("edits domains in place and saves without altering reviewed accounts, categories or roles", () => {
  const dirty = vi.fn();
  render(<PlanDomains plan={plan} targets={targets} onDirtyChange={dirty} />);
  expect((screen.getByRole("button", { name: "Save domains" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByRole("textbox", { name: "Domain for Company 2" }), { target: { value: "second.com" } });
  expect(dirty).toHaveBeenLastCalledWith(true);
  fireEvent.click(screen.getByRole("button", { name: "Save domains" }));
  expect(mocks.save).toHaveBeenCalledWith({ ...plan.config, domains: { "1": "first.com", "2": "second.com" } }, expect.any(Object));
});
it("can reset inline changes and leaves invalid inputs available for correction after an error", () => {
  mocks.save.mockImplementationOnce((_cfg, options) => options.onError(new Error("Enter a valid company domain")));
  const dirty = vi.fn();
  render(<PlanDomains plan={plan} targets={targets} onDirtyChange={dirty} />);
  const field = screen.getByRole("textbox", { name: "Domain for Company 2" }) as HTMLInputElement;
  fireEvent.change(field, { target: { value: "not a domain" } });
  fireEvent.click(screen.getByRole("button", { name: "Save domains" }));
  expect(screen.getByRole("alert").textContent).toContain("Enter a valid company domain");
  expect(field.value).toBe("not a domain");
  fireEvent.click(screen.getByRole("button", { name: "Reset changes" }));
  expect(field.value).toBe("");
  expect(dirty).toHaveBeenLastCalledWith(false);
});
