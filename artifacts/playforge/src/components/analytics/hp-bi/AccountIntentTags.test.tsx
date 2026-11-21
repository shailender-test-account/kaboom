// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import AccountIntentTags from "./AccountIntentTags";
import type { HpBiDetail } from "./types";
vi.mock("@/components/EngagementHistory", () => ({
  default: ({ target }: { target: { parentKey: string; clientId: number } }) =>
    <div data-testid="scoped-source-history">{target.parentKey} · client {target.clientId}</div>,
}));
afterEach(cleanup);
it("labels saved source types and opens client-scoped respondent history", () => {
  const detail = {
    clientId: 9, account: { parentKey: "concentrix", gtm: { formTypes: ["event_feedback"] } },
    intentSources: { gtm: [{ category: "Business Services", product: "Device as a Service", status: "Warm" }], journey: [] },
    monitoringContext: [], members: [],
  } as unknown as HpBiDetail;
  render(<AccountIntentTags d={detail} />);
  expect(screen.getByText(/Sources: Event Feedback Form \/ questionnaire/)).toBeTruthy();
  expect(screen.queryByTestId("scoped-source-history")).toBeNull();
  fireEvent.click(screen.getByTestId("open-gtm-source-details"));
  expect(screen.getByTestId("scoped-source-history").textContent).toBe("concentrix · client 9");
});
