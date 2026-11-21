// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import GccProfiling from "./GccProfiling";
afterEach(cleanup);
it("shows all eight supplied directory fields, both email/phone values and source provenance", () => {
  render(<GccProfiling members={[{ id: 1, name: "Approved account", dimensions: { _gccProfiling: [
    { sourceRow: 9, fileName: "profiling.xlsx", sheet: "GCC", contactId: 42, values: { companyName: "Sheet company",
      name: "Example Person", title: "Head IT", email: "primary@example.invalid", email2: "alternate@example.invalid",
      phone: "9876543210", phone2: "9876543211", city: "Delhi" } },
    { sourceRow: 10, deleted: true, contactId: null },
  ] } }]} />);
  expect(screen.getByTestId("gcc-profiling").hasAttribute("open")).toBe(true);
  const row = screen.getByTestId("gcc-profile-row");
  expect(row.querySelectorAll("dt")).toHaveLength(8);
  expect(row.textContent).toContain("alternate@example.invalid");
  expect(row.textContent).toContain("9876543211");
  expect(row.textContent).toContain("profiling.xlsx / GCC / row 9");
  expect(screen.getByTestId("gcc-profiling").textContent).toContain("not responses, qualified leads");
});
it("does not show empty or deleted-only profiling collections", () => {
  render(<GccProfiling members={[{ id: 1, name: "A", dimensions: { _gccProfiling: [{ deleted: true }] } }]} />);
  expect(screen.queryByTestId("gcc-profiling")).toBeNull();
});
it("shows unlinked source people and shared identity warnings without hiding their supplied details", () => {
  render(<GccProfiling members={[{ id: 1, name: "A", dimensions: { _gccProfiling: [
    { sourceRow: 4, fileName: "profiling.xlsx", sheet: "GCC", contactId: null, identityReview: "Shared email",
      values: { name: "Another Person", email: "shared@example.invalid", phone: "9999999999", city: "Delhi" } },
  ] } }]} />);
  expect(screen.getByTestId("gcc-profile-row").textContent).toContain("Another Person");
  expect(screen.getByTestId("gcc-profile-row").textContent).toContain("shared@example.invalid");
  expect(screen.getByTestId("gcc-profile-row").textContent).toContain("9999999999");
  expect(screen.getByTestId("gcc-profile-row").textContent).toContain("Delhi");
  expect(screen.getByTestId("gcc-profile-row").textContent).toContain("Contact link pending review");
  expect(screen.getByTestId("gcc-identity-review").textContent).toContain("Shared email");
});
