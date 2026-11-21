// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import RespondentRouteForm from "./RespondentRouteForm";

afterEach(cleanup);
const journeys = ["Infosys", "Future of Work", "2-Minute Meeting Rescue", "Future of SaaS and DaaS",
  "Future of Security", "The Managed Workspace"].map((name, id) => ({ id: id + 1, name }));
const sequences = [{ id: 57, name: "Future of Security", status: "draft", clientId: 9 }];
describe("respondent routing form", () => {
  it("offers all supplied client journeys and draft sequences and enables submission after selection", () => {
    const save = vi.fn();
    render(<RespondentRouteForm journeys={journeys} sequences={sequences} busy={false} onSubmit={save} />);
    const journey = screen.getByLabelText(/Journey · all/);
    expect(journey.querySelectorAll("option")).toHaveLength(7);
    expect(screen.getByRole("option", { name: "Future of Security · Draft" })).toBeTruthy();
    const button = screen.getByRole("button", { name: "Save route (no emails)" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.change(journey, { target: { value: "5" } });
    fireEvent.change(screen.getByLabelText(/Sequence · draft/), { target: { value: "57" } });
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    expect(save).toHaveBeenCalledWith({ journeyId: 5, sequenceId: 57 });
    expect(screen.getByText(/Does not enroll the contact/)).toBeTruthy();
  });
  it("explains genuinely missing options and does not allow an invalid submission", () => {
    const save = vi.fn();
    render(<RespondentRouteForm journeys={[]} sequences={[]} busy={false} onSubmit={save} />);
    expect(screen.getByText("No journeys available for this client.")).toBeTruthy();
    expect(screen.getByText(/No draft or active sequences/)).toBeTruthy();
    fireEvent.submit(screen.getByTestId("respondent-route-form"));
    expect(save).not.toHaveBeenCalled();
  });
  it("does not submit when saving or after selected options disappear", () => {
    const save = vi.fn();
    const { rerender } = render(<RespondentRouteForm journeys={journeys} sequences={sequences} busy={false} onSubmit={save} />);
    fireEvent.change(screen.getByLabelText(/Journey · all/), { target: { value: "5" } });
    fireEvent.change(screen.getByLabelText(/Sequence · draft/), { target: { value: "57" } });
    rerender(<RespondentRouteForm journeys={journeys} sequences={sequences} busy={true} onSubmit={save} />);
    fireEvent.submit(screen.getByTestId("respondent-route-form"));
    expect(save).not.toHaveBeenCalled();
    rerender(<RespondentRouteForm journeys={journeys} sequences={[]} busy={false} onSubmit={save} />);
    fireEvent.submit(screen.getByTestId("respondent-route-form"));
    expect(save).not.toHaveBeenCalled();
  });
});
