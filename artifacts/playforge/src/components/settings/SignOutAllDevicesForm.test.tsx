// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SignOutAllDevicesForm } from "./SignOutAllDevicesForm";

const mocks = vi.hoisted(() => ({
  mutateAsync: vi.fn(), reset: vi.fn(), refetch: vi.fn(), toast: vi.fn(),
  cancelQueries: vi.fn(), clear: vi.fn(), isPending: false, isError: false,
}));
vi.mock("@workspace/api-client-react", () => ({
  useLogoutAllDevices: () => ({ ...mocks, error: { data: { error: "Current password is incorrect" } } }),
}));
vi.mock("@/contexts/AuthContext", () => ({ useAuthContext: () => ({ refetch: mocks.refetch }) }));
vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => mocks }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: mocks.toast }) }));
beforeEach(() => {
  vi.clearAllMocks();
  mocks.isPending = false; mocks.isError = false;
  mocks.mutateAsync.mockResolvedValue(undefined);
});
afterEach(cleanup);

function fill() {
  fireEvent.change(screen.getByLabelText("Current password"), { target: { value: "Original-password-123!" } });
  fireEvent.click(screen.getByRole("checkbox"));
}

it("requires password and confirmation and cancels without a request", () => {
  const cancel = vi.fn();
  render(<SignOutAllDevicesForm onCancel={cancel} />);
  const submit = screen.getByRole("button", { name: "Sign out all devices" }) as HTMLButtonElement;
  expect(submit.disabled).toBe(true);
  fireEvent.change(screen.getByLabelText("Current password"), { target: { value: "Original-password-123!" } });
  expect(submit.disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(cancel).toHaveBeenCalledOnce();
  expect(mocks.mutateAsync).not.toHaveBeenCalled();
});

it("sends only the reauthentication contract and clears private state before refreshing auth", async () => {
  render(<SignOutAllDevicesForm onCancel={vi.fn()} />);
  fill();
  fireEvent.click(screen.getByRole("button", { name: "Sign out all devices" }));
  await waitFor(() => expect(mocks.refetch).toHaveBeenCalledOnce());
  expect(mocks.mutateAsync).toHaveBeenCalledWith({ data: { currentPassword: "Original-password-123!", confirm: true } });
  expect(mocks.reset).toHaveBeenCalledOnce();
  expect(mocks.cancelQueries).toHaveBeenCalledOnce();
  expect(mocks.clear).toHaveBeenCalledOnce();
  expect(mocks.clear.mock.invocationCallOrder[0]).toBeLessThan(mocks.refetch.mock.invocationCallOrder[0]);
  expect((screen.getByLabelText("Current password") as HTMLInputElement).value).toBe("");
});

it("keeps failures visible without clearing authentication", async () => {
  mocks.isError = true;
  mocks.mutateAsync.mockRejectedValue(new Error("incorrect password"));
  render(<SignOutAllDevicesForm onCancel={vi.fn()} />);
  fill();
  fireEvent.click(screen.getByRole("button", { name: "Sign out all devices" }));
  await waitFor(() => expect(mocks.mutateAsync).toHaveBeenCalledOnce());
  expect(screen.getByRole("alert").textContent).toBe("Current password is incorrect");
  expect(mocks.clear).not.toHaveBeenCalled();
  expect(mocks.refetch).not.toHaveBeenCalled();
});

it("disables repeat submission while signing out", () => {
  mocks.isPending = true;
  render(<SignOutAllDevicesForm onCancel={vi.fn()} />);
  expect((screen.getByRole("button", { name: "Signing out…" }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByLabelText("Current password") as HTMLInputElement).disabled).toBe(true);
  expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(true);
});
