// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import AccountPriority from "./AccountPriority";
afterEach(cleanup);
it("shows weighted contributions, reconfirmation, routing and an expandable explanation", () => {
  render(<AccountPriority priority={{ score: 48, status: "Warm", declaredQualification: "Cold", needsReconfirmation: true,
    forms: 30, journey: 15, monitoring: 3, calculatedAt: "2026-11-01T12:00:00Z", nextReviewAt: "2026-11-02T12:00:00Z",
    warmForm: false, routing: { status: "Needs attention", reason: "No approved matching journey.", journeys: [] } }} />);
  expect(screen.getByText("48/100 · Warm")).toBeTruthy();
  expect(screen.getByText("30/65")).toBeTruthy();
  expect(screen.getByText("15/25")).toBeTruthy();
  expect(screen.getByText("3/10")).toBeTruthy();
  expect(screen.getByText(/Needs reconfirmation/)).toBeTruthy();
  expect(screen.getByTestId("priority-routing").textContent).toContain("Needs attention");
  const summary = screen.getByText("How is this calculated?");
  fireEvent.click(summary);
  expect(summary.closest("details")?.open).toBe(true);
  expect(screen.getByTestId("account-priority").textContent).toContain("A sequence requires an enabled saved rule");
  expect(screen.getByTestId("priority-score-equation").textContent).toContain("30 forms + 15 journey + 3 monitoring = 48/100");
});
