// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { InboundProvenance } from "@workspace/api-client-react";
import InboundSourceProvenance from "./InboundSourceProvenance";

const provenance: InboundProvenance = { retainedSubmissionId: 2, savedReviewCount: 1, copies: [
  { submissionId: 1, fileName: "original.csv", fileUrl: "https://drive.google.com/file/d/original_123/view",
    sourceName: "GTM forms", rowKey: "row:2", submittedAt: "2026-09-23T16:56:03Z", importedAt: "2026-09-23T17:58:35Z",
    sourceModifiedAt: "2026-09-23T17:50:00Z", hasSavedReviews: false },
  { submissionId: 2, fileName: "copied.csv", fileUrl: null, sourceName: "GTM forms", rowKey: "row:3",
    submittedAt: null, importedAt: null, sourceModifiedAt: null, hasSavedReviews: true },
] };
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("compact original-file audit view", () => {
  it("stays absent for non-imports and single copies", () => {
    const view = render(<InboundSourceProvenance />);
    expect(view.container.textContent).toBe("");
    view.rerender(<InboundSourceProvenance provenance={{ ...provenance, copies: provenance.copies.slice(0, 1) }} />);
    expect(view.container.textContent).toBe("");
  });
  it("starts collapsed and identifies the review owner without increasing response counts", () => {
    render(<InboundSourceProvenance provenance={provenance} />);
    const details = screen.getByTestId("provenance-2");
    expect(details.hasAttribute("open")).toBe(false);
    expect(screen.getByTestId("provenance-toggle-2").textContent).toBe("Original files · 2 source copies · 1 response");
    fireEvent.click(screen.getByTestId("provenance-toggle-2"));
    expect(details.hasAttribute("open")).toBe(true);
    expect(screen.getByTestId("text-provenance-review-owner").textContent).toContain("Retained copy #2 holds all compatible saved reviews (1)");
    expect(screen.getByTestId("link-original-file-1").getAttribute("rel")).toBe("noopener noreferrer");
    expect(screen.getByTestId("source-copy-2").textContent).toContain("Unavailable");
  });
  it("opens and closes read-only source records locally without network requests or mutations", () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    render(<InboundSourceProvenance provenance={provenance} />);
    fireEvent.click(screen.getByTestId("provenance-toggle-2"));
    fireEvent.click(screen.getByTestId("link-source-record-1"));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Source record #1")).toBeTruthy();
    expect(within(dialog).getByText("row:2")).toBeTruthy();
    expect(dialog.textContent).toContain("consolidated into #2");
    fireEvent.click(screen.getByTestId("button-source-record-back"));
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByTestId("link-source-record-2"));
    expect(screen.getByRole("dialog").textContent).toContain("retained copy with all compatible saved reviews");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("renders missing reviews and refuses unsafe file links", () => {
    render(<InboundSourceProvenance provenance={{ ...provenance, savedReviewCount: 0,
      copies: provenance.copies.map(c => ({ ...c, hasSavedReviews: false, fileUrl: "javascript:alert(1)" })) }} />);
    expect(screen.queryByTestId("link-original-file-1")).toBeNull();
    expect(screen.getByTestId("text-provenance-review-owner").textContent).toContain("has no saved reviews");
    fireEvent.click(screen.getByTestId("link-source-record-2"));
    expect(screen.getByRole("dialog").textContent).toContain("no saved reviews are present");
  });
});
