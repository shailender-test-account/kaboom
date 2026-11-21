// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import MonitoringRetryControls from "./MonitoringRetryControls";

const state = vi.hoisted(() => ({ role: "admin", safetyPaused: false, failed: false, pending: false,
  mutate: vi.fn(), invalidate: vi.fn(), error: null as any }));
vi.mock("@/contexts/AuthContext", () => ({ useAuthContext: () => ({ user: { role: state.role } }) }));
vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => ({ invalidateQueries: state.invalidate }) }));
vi.mock("@workspace/api-client-react", () => ({
  useGetMonitoringRetryOptions: () => ({ isError: state.failed, refetch: vi.fn(),
    data: { safetyPaused: state.safetyPaused, engines: [
      { provider: "perplexity", label: "Perplexity / Web Search", configured: true },
      { provider: "tavily", label: "Tavily", configured: true },
      { provider: "newsapi", label: "NewsAPI", configured: false },
    ] } }),
  useRetryMonitoringRun: () => ({ mutate: state.mutate, isPending: state.pending, error: state.error, reset: vi.fn() }),
}));
const schedule: any = { id: 9, latestRun: { providers: [{ runId: 42, provider: "tavily", status: "failed", accountsFailed: 66 }] } };
afterEach(() => { cleanup(); state.role = "admin"; state.safetyPaused = false; state.failed = false; state.pending = false;
  state.error = null; state.mutate.mockReset(); state.invalidate.mockReset(); });
it("defaults to Perplexity without starting a retry until clicked, then refreshes progress", () => {
  render(<MonitoringRetryControls schedule={schedule} />);
  const button = screen.getByRole("button", { name: "Retry unfinished accounts" }) as HTMLButtonElement;
  expect(button.disabled).toBe(false);
  expect((screen.getByLabelText("Retry engine") as HTMLSelectElement).value).toBe("perplexity");
  expect(state.mutate).not.toHaveBeenCalled();
  expect((screen.getByRole("option", { name: /NewsAPI/ }) as HTMLOptionElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText("Retry engine"), { target: { value: "perplexity" } });
  fireEvent.click(button);
  expect(state.mutate.mock.calls[0][0]).toEqual({ id: 9, data: { runId: 42, provider: "perplexity" } });
  state.mutate.mock.calls[0][1].onSuccess({ accountsQueued: 66, duplicate: false });
  expect(state.invalidate).toHaveBeenCalledWith({ queryKey: ["intent"] });
});
it("allows an explicit alternative engine", () => {
  render(<MonitoringRetryControls schedule={schedule} />);
  fireEvent.change(screen.getByLabelText("Retry engine"), { target: { value: "tavily" } });
  fireEvent.click(screen.getByRole("button", { name: "Retry unfinished accounts" }));
  expect(state.mutate.mock.calls[0][0]).toEqual({ id: 9, data: { runId: 42, provider: "tavily" } });
});
it("hides recovery controls from non-admins", () => {
  state.role = "editor";
  render(<MonitoringRetryControls schedule={schedule} />);
  expect(screen.queryByLabelText("Retry engine")).toBeNull();
});
it("blocks copied-data research and explains why", () => {
  state.safetyPaused = true;
  render(<MonitoringRetryControls schedule={schedule} />);
  fireEvent.change(screen.getByLabelText("Retry engine"), { target: { value: "perplexity" } });
  expect(screen.getByRole("alert").textContent).toContain("copied-data safety mode");
  expect((screen.getByRole("button", { name: "Retry unfinished accounts" }) as HTMLButtonElement).disabled).toBe(true);
});
it("provides a recoverable engine-loading error and surfaces server retry errors", () => {
  state.failed = true;
  const view = render(<MonitoringRetryControls schedule={schedule} />);
  expect(screen.getByRole("button", { name: "Retry loading engines" })).toBeTruthy();
  view.unmount();
  state.failed = false; state.error = { message: "HTTP error", data: { error: "Some accounts are still being processed." } };
  render(<MonitoringRetryControls schedule={schedule} />);
  expect(screen.getByRole("alert").textContent).toContain("still being processed");
});
