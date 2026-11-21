// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import ResearchQuality from "./ResearchQuality";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const diagnostics = {
  assessedCount: 3, storedFindingCount: 120, truncated: true,
  usableCount: 1, excludedCount: 2,
  exclusions: [{ reason: "wrong_account", label: "Source does not establish this account", count: 2 }],
  unverifiedPublicationDateCount: 1, insufficientOperationalEvidenceCount: 1,
};

describe("stored research quality", () => {
  it("shows bounded counts and reasons without starting a request on expansion", () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    render(<ResearchQuality diagnostics={diagnostics} />);
    expect(screen.getByText(/1 usable for business context · 2 excluded · 3 assessed/)).toBeTruthy();
    expect(screen.getByText(/latest 3 of 120/)).toBeTruthy();
    fireEvent.click(screen.getByText("Why findings were excluded or limited"));
    expect(screen.getByText(/Source does not establish this account: 2/)).toBeTruthy();
    expect(screen.getByText(/Publication date unverified: 1/)).toBeTruthy();
    expect(screen.getByText(/Insufficient operational evidence: 1/)).toBeTruthy();
    expect(screen.getByText(/not additional exclusions/)).toBeTruthy();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("distinguishes no stored results from stored findings that were all excluded", () => {
    const { rerender } = render(<ResearchQuality diagnostics={{ ...diagnostics,
      assessedCount: 0, usableCount: 0, excludedCount: 0, storedFindingCount: 0, truncated: false,
      exclusions: [], unverifiedPublicationDateCount: 0, insufficientOperationalEvidenceCount: 0,
    }} />);
    expect(screen.getByText(/No stored findings to assess/)).toBeTruthy();
    rerender(<ResearchQuality diagnostics={{ ...diagnostics, usableCount: 0, excludedCount: 3 }} />);
    expect(screen.getByText(/No useful account-specific business news/)).toBeTruthy();
  });

  it("does not invent quality counts for older responses", () => {
    const { container } = render(<ResearchQuality />);
    expect(container.innerHTML).toBe("");
  });
});
