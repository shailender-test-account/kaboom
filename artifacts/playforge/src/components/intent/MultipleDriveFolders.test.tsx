// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import MultipleDriveFolders from "./MultipleDriveFolders";
const { create } = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("@/hooks/use-intent", () => ({ useCreateIntentInboundSource: () => ({ mutateAsync: create }) }));
afterEach(cleanup);
beforeEach(() => { create.mockReset(); });
function setup() {
  const onSaved = vi.fn();
  render(<MultipleDriveFolders clients={[{ id: 9, name: "HP" }]} clientId={9} onSaved={onSaved} onCancel={vi.fn()} />);
  for (const [n, folder] of [[1, "leads"], [2, "events"]] as const) {
    fireEvent.change(screen.getByLabelText(`Folder ${n} name`), { target: { value: folder } });
    fireEvent.change(screen.getByLabelText(`Folder ${n} URL`), { target: { value: `https://drive.google.com/drive/folders/${folder}` } });
  }
  return onSaved;
}
it("saves separate URLs with independent response types and a shared client", async () => {
  const onSaved = setup();
  create.mockImplementation(async data => ({ source: { ...data, id: data.name === "leads" ? 1 : 2 } }));
  fireEvent.click(screen.getByText("Save folders"));
  await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
  expect(create).toHaveBeenNthCalledWith(1, expect.objectContaining({ clientId: 9, name: "leads", formType: "lead_form", fieldMappings: {} }));
  expect(create).toHaveBeenNthCalledWith(2, expect.objectContaining({ clientId: 9, name: "events", formType: "event_feedback" }));
});
it("retains successes and retries only the failed folder", async () => {
  const onSaved = setup();
  create.mockResolvedValueOnce({ source: { id: 1, name: "leads" } }).mockRejectedValueOnce(new Error("Folder already configured"));
  fireEvent.click(screen.getByText("Save folders"));
  await screen.findByText("Folder already configured");
  expect(onSaved).not.toHaveBeenCalled();
  expect((screen.getByLabelText("Folder 1 URL") as HTMLInputElement).disabled).toBe(false);
  expect(screen.getByLabelText("Folder 1 URL").closest("fieldset")?.disabled).toBe(true);
  create.mockResolvedValueOnce({ source: { id: 2, name: "events" } });
  fireEvent.click(screen.getByText("Save folders"));
  await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
  expect(create).toHaveBeenCalledTimes(3);
  expect(create.mock.calls[2][0].name).toBe("events");
});
it("rejects duplicate folder identities before saving", () => {
  setup();
  fireEvent.change(screen.getByLabelText("Folder 2 URL"), { target: { value: "https://drive.google.com/open?id=leads" } });
  fireEvent.click(screen.getByText("Save folders"));
  expect(screen.getByRole("alert").textContent).toContain("Each folder must be unique");
  expect(create).not.toHaveBeenCalled();
});
