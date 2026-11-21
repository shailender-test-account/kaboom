// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import GccContactAlternatives from "./GccContactAlternatives";
afterEach(cleanup);
it("shows differing versions, source provenance, blank fields and the consent warning without outreach links", () => {
  render(<GccContactAlternatives records={[
    { alternateEmail: "alternate@example.invalid", alternatePhone: "9876543211",
      fileName: "first.xlsx", fileHash: "a", sheet: "GCC", sourceRow: 8, importedAt: "2026-10-01" },
    { alternateEmail: "changed@example.invalid", alternatePhone: null,
      fileName: "second.xlsx", fileHash: "b", sheet: "GCC", sourceRow: 9, importedAt: null },
  ]} />);
  expect(screen.getAllByTestId("gcc-contact-source")).toHaveLength(2);
  const section = screen.getByTestId("gcc-contact-alternatives");
  for (const text of ["alternate@example.invalid", "changed@example.invalid", "9876543211",
    "Not supplied", "first.xlsx / GCC / row 8", "second.xlsx / GCC / row 9",
    "not verified addresses or consent to outreach", "Primary contact details are unchanged"]) {
    expect(section.textContent).toContain(text);
  }
  expect(section.querySelectorAll("a,button,input")).toHaveLength(0);
});
it("hides the section when no alternatives are supplied", () => {
  const { rerender } = render(<GccContactAlternatives records={[]} />);
  expect(screen.queryByTestId("gcc-contact-alternatives")).toBeNull();
  rerender(<GccContactAlternatives records={undefined} />);
  expect(screen.queryByTestId("gcc-contact-alternatives")).toBeNull();
});
