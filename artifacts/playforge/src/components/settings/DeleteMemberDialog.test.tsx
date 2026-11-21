// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TeamMember } from "@workspace/api-client-react";
import DeleteMemberDialog from "./DeleteMemberDialog";

const mocks = vi.hoisted(() => ({
  mutate: vi.fn(), invalidateQueries: vi.fn(), toast: vi.fn(),
  state: { isPending: false, isError: false, error: null as Error | null },
}));
vi.mock("@workspace/api-client-react", () => ({
  useDeleteTeamMember: () => ({ ...mocks.state, mutate: mocks.mutate }),
  getListTeamAccessQueryKey: () => ["/api/team-access"],
}));
vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => ({ invalidateQueries: mocks.invalidateQueries }) }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: mocks.toast }) }));

const member = { id: 123, firstName: "Test", lastName: "Member", email: "member@example.invalid", role: "viewer" } as TeamMember;

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(mocks.state, { isPending: false, isError: false, error: null });
});
afterEach(cleanup);

describe("permanent user deletion confirmation", () => {
  it("requires the exact email and does nothing on cancel", () => {
    const onClose = vi.fn();
    render(<DeleteMemberDialog member={member} onClose={onClose} />);
    const remove = screen.getByRole("button", { name: "Delete user permanently" }) as HTMLButtonElement;
    expect(remove.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Type their email address to confirm"), { target: { value: "other@example.invalid" } });
    expect(remove.disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(mocks.mutate).not.toHaveBeenCalled();
  });

  it("deletes only the selected ID and refreshes the team after success", () => {
    const onClose = vi.fn();
    render(<DeleteMemberDialog member={member} onClose={onClose} />);
    fireEvent.change(screen.getByLabelText("Type their email address to confirm"), { target: { value: member.email } });
    fireEvent.click(screen.getByRole("button", { name: "Delete user permanently" }));
    expect(mocks.mutate).toHaveBeenCalledWith({ id: member.id }, expect.any(Object));
    expect(onClose).not.toHaveBeenCalled();
    mocks.mutate.mock.calls[0][1].onSuccess();
    expect(mocks.invalidateQueries).toHaveBeenCalledWith({ queryKey: ["/api/team-access"] });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("disables repeat requests and cancellation while deletion is pending", () => {
    mocks.state.isPending = true;
    render(<DeleteMemberDialog member={member} onClose={vi.fn()} />);
    expect((screen.getByRole("button", { name: "Deleting…" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows a server refusal without closing the confirmation", () => {
    mocks.state.isError = true;
    mocks.state.error = new Error("Administrator access required");
    const onClose = vi.fn();
    render(<DeleteMemberDialog member={member} onClose={onClose} />);
    expect(screen.getByRole("alert").textContent).toContain("Administrator access required");
    expect(onClose).not.toHaveBeenCalled();
  });
});
