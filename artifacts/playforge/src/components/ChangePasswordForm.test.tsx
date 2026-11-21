// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ChangePasswordForm } from "./ChangePasswordForm";

const mocks = vi.hoisted(() => ({ mutateAsync: vi.fn(), reset: vi.fn(), refetch: vi.fn(), toast: vi.fn() }));
vi.mock("@workspace/api-client-react", () => ({
  useChangeOwnPassword: () => ({ ...mocks, isPending: false, isError: false }),
}));
vi.mock("@/contexts/AuthContext", () => ({ useAuthContext: () => ({ refetch: mocks.refetch }) }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: mocks.toast }) }));
beforeEach(() => { vi.clearAllMocks(); mocks.mutateAsync.mockResolvedValue({ ok: true }); });
afterEach(cleanup);

function fill() {
  fireEvent.change(screen.getByLabelText("Temporary password"), { target: { value: "Temporary-123!" } });
  fireEvent.change(screen.getByLabelText("New password"), { target: { value: "Personal-456!" } });
  fireEvent.change(screen.getByLabelText("Confirm new password"), { target: { value: "Personal-456!" } });
}

it("keeps a visible success confirmation until the user continues", async () => {
  render(<ChangePasswordForm required />);
  fill();
  fireEvent.click(screen.getByRole("button", { name: "Set password and continue" }));
  await waitFor(() => expect(screen.getByRole("status").textContent).toContain("changed successfully"));
  expect(mocks.mutateAsync).toHaveBeenCalledWith({ data: { currentPassword: "Temporary-123!", newPassword: "Personal-456!" } });
  expect(mocks.reset).toHaveBeenCalledOnce();
  expect(mocks.refetch).not.toHaveBeenCalled();
  expect(screen.queryByLabelText("Temporary password")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Continue to workspace" }));
  await waitFor(() => expect(mocks.refetch).toHaveBeenCalledOnce());
});

it("rejects mismatched confirmation without sending a request", () => {
  render(<ChangePasswordForm required />);
  fill();
  fireEvent.change(screen.getByLabelText("Confirm new password"), { target: { value: "Different-789!" } });
  fireEvent.click(screen.getByRole("button", { name: "Set password and continue" }));
  expect(screen.getByRole("alert").textContent).toContain("do not match");
  expect(mocks.mutateAsync).not.toHaveBeenCalled();
});

it("keeps the optional change confirmation open until Done", async () => {
  const onSuccess = vi.fn();
  render(<ChangePasswordForm onSuccess={onSuccess} />);
  fireEvent.change(screen.getByLabelText("Current password"), { target: { value: "Temporary-123!" } });
  fireEvent.change(screen.getByLabelText("New password"), { target: { value: "Personal-456!" } });
  fireEvent.change(screen.getByLabelText("Confirm new password"), { target: { value: "Personal-456!" } });
  fireEvent.click(screen.getByRole("button", { name: "Update password" }));
  await waitFor(() => expect(screen.getByRole("status").textContent).toContain("changed successfully"));
  expect(onSuccess).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Done" }));
  await waitFor(() => expect(onSuccess).toHaveBeenCalledOnce());
});
