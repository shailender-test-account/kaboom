// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MappingPresets } from "./MappingPresets";
import type { HpMappingPreset } from "@workspace/api-client-react";

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function mount(onApply = vi.fn(), kind: "accounts" | "activities" = "accounts", canSave = true) {
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MappingPresets clientId={11} kind={kind} headers={["ID", "Name"]} mappings={{ ID: "hpId" }} canSave={canSave} onApply={onApply} />
  </QueryClientProvider>);
}
describe("Saved preset controls with real request hooks", () => {
  it("saves, reloads, applies, updates, renames and deletes with the current client scope", async () => {
    let data: HpMappingPreset[] = [];
    const requests: { path: string; method: string; body: any }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (path: string, init?: RequestInit) => {
      const method = init?.method ?? "GET", body = init?.body ? JSON.parse(init.body as string) : undefined;
      requests.push({ path, method, body });
      if (method === "POST") {
        data = [{ id: 1, ...body, createdAt: "2026-10-06T00:00:00Z", updatedAt: "2026-10-06T00:00:00Z" }];
        return Response.json(data[0]);
      }
      if (method === "PATCH") { data = [{ ...data[0], ...body }]; return Response.json(data[0]); }
      if (method === "DELETE") { data = []; return new Response(null, { status: 204 }); }
      return Response.json(data);
    }));
    const initial = mount();
    await waitFor(() => expect((screen.getByLabelText("Mapping preset") as HTMLSelectElement).disabled).toBe(false));
    fireEvent.change(screen.getByLabelText("Preset name"), { target: { value: "Monthly" } });
    fireEvent.click(screen.getByText("Save as new"));
    await screen.findByRole("option", { name: "Monthly" });
    expect(requests.find(r => r.method === "POST")).toMatchObject({
      path: "/api/analytics/hp-bi/mapping-presets?clientId=11",
      body: { name: "Monthly", kind: "accounts", headers: ["ID", "Name"], mappings: { ID: "hpId" } },
    });
    initial.unmount();
    const apply = vi.fn(); mount(apply);
    await screen.findByRole("option", { name: "Monthly" });
    fireEvent.change(screen.getByLabelText("Mapping preset"), { target: { value: "1" } });
    expect(apply).toHaveBeenCalledWith(expect.objectContaining({ name: "Monthly", mappings: { ID: "hpId" } }));
    fireEvent.click(screen.getByText("Update mappings"));
    await waitFor(() => expect(requests.filter(r => r.method === "PATCH")).toHaveLength(1));
    await waitFor(() => expect((screen.getByLabelText("Preset name") as HTMLInputElement).disabled).toBe(false));
    fireEvent.change(screen.getByLabelText("Preset name"), { target: { value: "Renamed" } });
    fireEvent.click(screen.getByText("Rename"));
    await screen.findByRole("option", { name: "Renamed" });
    expect(requests.filter(r => r.method === "PATCH")[1].body).toEqual({ name: "Renamed" });
    fireEvent.click(screen.getByText("Delete"));
    expect(screen.getByText(/Imported accounts and activities will not be deleted/)).toBeTruthy();
    fireEvent.click(screen.getByText("Confirm delete"));
    await waitFor(() => expect(screen.queryByRole("option", { name: "Renamed" })).toBeNull());
    expect(requests.some(r => r.method === "DELETE" && r.path.endsWith("/1?clientId=11"))).toBe(true);
    expect(apply).toHaveBeenCalledTimes(1); // deleting doesn't erase current mappings
  });
  it("separates activity listing and prevents saving unresolved mappings", async () => {
    const fetcher = vi.fn(async () => Response.json([])); vi.stubGlobal("fetch", fetcher);
    mount(vi.fn(), "activities", false);
    await waitFor(() => expect(fetcher).toHaveBeenCalled());
    expect(fetcher.mock.calls[0]).toEqual(expect.arrayContaining(["/api/analytics/hp-bi/mapping-presets?clientId=11&kind=activities"]));
    fireEvent.change(screen.getByLabelText("Preset name"), { target: { value: "Activity preset" } });
    expect((screen.getByText("Save as new") as HTMLButtonElement).disabled).toBe(true);
  });
});
