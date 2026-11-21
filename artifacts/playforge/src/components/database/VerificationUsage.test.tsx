// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { VerificationUsage } from "./VerificationUsage";

const auth = vi.hoisted(() => ({ role: "admin" }));
vi.mock("@/contexts/AuthContext", () => ({ useAuthContext: () => ({ user: { role: auth.role } }) }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); auth.role = "admin"; });

function mount() {
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <VerificationUsage />
  </QueryClientProvider>);
}
const initial = { requestLimit: 0, attempts: 3, responses: 1, legacyAttempts: 1, unconfirmedAttempts: 2, remaining: 0 };

describe("admin verification usage with real API hooks", () => {
  it("loads only on demand, saves the real contract, refreshes counts and survives remount", async () => {
    let data = { ...initial };
    const calls: { path: string; method: string; body?: unknown }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (path: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ path, method, body });
      if (method === "PATCH") data = { ...data, requestLimit: body.requestLimit, remaining: body.requestLimit - data.attempts };
      return Response.json(data);
    }));
    const first = mount();
    expect(calls).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Verification usage" }));
    await screen.findByText("Paid lookups are blocked. An admin must raise the ceiling to allow more requests.");
    expect(screen.getByText(/1 historical attempts/)).toBeTruthy();
    expect(screen.getByText(/not billed credits/)).toBeTruthy();
    const input = screen.getByLabelText("All-time request ceiling");
    fireEvent.change(input, { target: { value: "-1" } });
    expect((screen.getByRole("button", { name: "Save ceiling" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(input, { target: { value: "13" } });
    fireEvent.click(screen.getByRole("button", { name: "Save ceiling" }));
    await waitFor(() => expect(calls.filter(c => c.method === "GET")).toHaveLength(2));
    await waitFor(() => expect(screen.queryByText(/Paid lookups are blocked/)).toBeNull());
    expect(calls.find(c => c.method === "PATCH")).toEqual({
      path: "/api/contact-verification-usage", method: "PATCH", body: { requestLimit: 13 },
    });
    expect(data).toMatchObject({ attempts: 3, responses: 1, remaining: 10 });
    first.unmount();
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Verification usage" }));
    await waitFor(() => expect((screen.getByLabelText("All-time request ceiling") as HTMLInputElement).value).toBe("13"));
  });

  it("does not expose the admin view or issue requests for a non-admin", () => {
    auth.role = "member";
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    mount();
    expect(screen.queryByRole("button", { name: "Verification usage" })).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("shows a failed read without automatic retry and permits a manual refresh", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ error: "Unavailable" }, { status: 503 }))
      .mockResolvedValueOnce(Response.json(initial));
    vi.stubGlobal("fetch", fetch);
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Verification usage" }));
    await screen.findByRole("alert");
    expect(fetch).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText("Retry"));
    await screen.findByText("Reserved attempts");
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
