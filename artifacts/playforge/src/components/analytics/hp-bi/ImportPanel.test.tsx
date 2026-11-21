// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import ImportPanel, { ImportFlow } from "./ImportPanel";

const mocks = vi.hoisted(() => ({ preview: vi.fn(), run: vi.fn(), toast: vi.fn() }));
vi.mock("./api", () => ({
  usePreviewHpImport: () => ({ mutateAsync: mocks.preview }),
  useImportHpAccounts: () => ({ mutate: mocks.run, isPending: false }),
}));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock("./MappingPresets", () => ({
  MappingPresets: ({ onApply }: any) => <div>
    <button onClick={() => onApply({ mappings: { "Old ID": "hpId" }, headers: ["Old ID", "Name"] })}>Apply missing preset</button>
    <button onClick={() => onApply({ mappings: { ID: "unsupported" }, headers: ["ID", "Name"] })}>Apply invalid preset</button>
    <button onClick={() => onApply({ mappings: { ID: "hpId" }, headers: ["ID", "Name"] })}>Apply valid preset</button>
  </div>,
}));
vi.mock("./ui", () => ({
  ErrorBox: ({ message }: any) => <div role="alert">{message}</div>,
  Chip: () => null, Empty: () => null, Skel: () => null,
}));
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals(); });
const result = { rows: 1, uniqueAccounts: 1, headers: ["ID", "Name"], samples: [], errors: [], warnings: [], importKind: "accounts",
  impact: { legalAccounts: 1, sourceParentGroups: 1, duplicateRows: 0, newAccounts: 1, existingMatches: 0,
    conflicts: 0, resultingLegalAccounts: 1, resultingParentGroups: 1, hierarchyReviews: 0, conflictExamples: [], note: "Synthetic impact" } };
function setup() {
  render(<QueryClientProvider client={new QueryClient()}><ImportFlow clientId={1} /></QueryClientProvider>);
  file("first.xlsx");
}
function file(name: string) {
  fireEvent.change(screen.getByTestId("input-import-file"), { target: { files: [new File(["data"], name)] } });
}
async function preview(approve = true) {
  await act(async () => { fireEvent.click(screen.getByTestId("button-preview-import")); });
  const confirmation = screen.queryByTestId("check-approve-roster") as HTMLInputElement | null;
  if (approve && confirmation && !confirmation.disabled && !confirmation.checked) fireEvent.click(confirmation);
}
function deferred() {
  let resolve!: (v: typeof result) => void;
  let reject!: (v: Error) => void;
  const promise = new Promise<typeof result>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
describe("HP matching queue", () => {
  it("reads its own current count, labels held rows and sends email conflicts to contact review", async () => {
    const fetcher = vi.fn(async (_url: unknown) => ({ ok: true, json: async () => [
      { id: 1, reason: "Email identity is conflicting or ambiguous; use contact identity review first",
        payload: { fields: { name: "Test Person", companyName: "Test Company" } } },
      { id: 2, reason: "Ambiguous legal-account name; review the HP identity before importing",
        payload: { roster: true, values: { name: "Held Company", hp_id: "123", aliases: ["Hidden raw alias"] } } },
    ] }));
    vi.stubGlobal("fetch", fetcher);
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ImportPanel open onClose={() => {}} clientId={1} unresolved={99} />
    </QueryClientProvider>);
    const tab = await screen.findByText("Matching queue (2)");
    fireEvent.click(tab);
    expect(await screen.findByText("Held Company")).toBeTruthy();
    expect(screen.getByText("HP ID: 123")).toBeTruthy();
    expect(screen.getByText(/other accepted accounts remain imported/)).toBeTruthy();
    expect(screen.getByText(/Choosing a legal account here cannot resolve this conflict/)).toBeTruthy();
    expect(screen.getByText("Open contact identity review in Inbound Accounts").getAttribute("href")).toBe("/intent/inbound-accounts");
    expect(screen.queryByTestId("button-resolve-1")).toBeNull();
    expect(screen.getByTestId("button-resolve-2")).toBeTruthy();
    expect(fetcher.mock.calls.every(([url]) => String(url).includes("/matches?clientId=1"))).toBe(true);
  });
});
describe("HP import preview safety", () => {
  it("requires explicit impact approval before importing accounts", async () => {
    mocks.preview.mockResolvedValue(result);
    setup(); await preview(false);
    expect((screen.getByTestId("button-run-import") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId("check-approve-roster"));
    expect((screen.getByTestId("button-run-import") as HTMLButtonElement).disabled).toBe(false);
  });
  it("requires a new preview after a preset or mapping is changed and blocks mismatches", async () => {
    mocks.preview.mockResolvedValue(result);
    setup(); await preview();
    expect((screen.getByTestId("button-run-import") as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByText("Apply missing preset"));
    expect(screen.getByText(/Missing mapped heading/)).toBeTruthy();
    expect((screen.getByTestId("button-run-import") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByText("Remove missing mapping")); await preview();
    expect((screen.getByTestId("button-run-import") as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByText("Apply invalid preset"));
    expect(screen.getByText(/Unsupported target/)).toBeTruthy();
    await preview();
    expect((screen.getByTestId("button-run-import") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByText("Remove invalid mapping")); await preview();
    fireEvent.change(screen.getByTestId("select-map-ID"), { target: { value: "hpId" } });
    expect((screen.getByTestId("button-run-import") as HTMLButtonElement).disabled).toBe(true);
    await preview(); fireEvent.click(screen.getByTestId("button-run-import"));
    expect(mocks.run).toHaveBeenCalledWith(expect.objectContaining({ kind: "accounts", mappings: { ID: "hpId" } }), expect.anything());
  });
  it("ignores responses from another file even when its mappings are identical", async () => {
    const old = deferred(); mocks.preview.mockReturnValueOnce(old.promise).mockResolvedValue(result);
    setup(); await preview(); file("second.xlsx");
    await act(async () => old.resolve(result));
    expect(screen.queryByTestId("button-run-import")).toBeNull();
    await preview();
    expect((screen.getByTestId("button-run-import") as HTMLButtonElement).disabled).toBe(false);
  });
  it("does not let an old preview unlock changed-away-and-back mappings", async () => {
    const old = deferred();
    mocks.preview.mockResolvedValueOnce(result).mockReturnValueOnce(old.promise);
    setup(); await preview(); await preview();
    fireEvent.change(screen.getByTestId("select-map-ID"), { target: { value: "hpId" } });
    fireEvent.change(screen.getByTestId("select-map-ID"), { target: { value: "" } });
    await act(async () => old.resolve(result));
    expect((screen.getByTestId("button-run-import") as HTMLButtonElement).disabled).toBe(true);
  });
  it("ignores old failures and out-of-order replies after kind changes", async () => {
    const old = deferred(), next = deferred();
    mocks.preview.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
    setup(); await preview();
    fireEvent.change(screen.getByTestId("select-import-kind"), { target: { value: "activities" } });
    await preview();
    await act(async () => next.resolve({ ...result, importKind: "activities" }));
    await act(async () => old.reject(new Error("Old file failed")));
    expect(screen.queryByText("Old file failed")).toBeNull();
    expect((screen.getByTestId("button-run-import") as HTMLButtonElement).disabled).toBe(false);
    expect(mocks.preview.mock.calls[1][0].kind).toBe("activities");
  });
  it("retains preset mappings for a repeat upload but does not reuse its preview", async () => {
    mocks.preview.mockResolvedValue(result);
    setup(); fireEvent.click(screen.getByText("Apply valid preset")); await preview();
    fireEvent.click(screen.getByTestId("button-run-import"));
    await act(async () => mocks.run.mock.calls[0][1].onSuccess({ imported: 1, created: 0, rows: 1, linkedContacts: 0, unresolved: 0 }));
    file("repeat.xlsx");
    expect(screen.queryByTestId("button-run-import")).toBeNull();
    await preview();
    expect(mocks.preview.mock.calls[1][0].mappings).toEqual({ ID: "hpId" });
  });
  it("never unlocks an import when preview returns validation errors", async () => {
    mocks.preview.mockResolvedValue({ ...result, errors: ["Invalid source row"] });
    setup(); await preview();
    expect((screen.getByTestId("button-run-import") as HTMLButtonElement).disabled).toBe(true);
  });
});
