// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import AccountLocations from "./AccountLocations";

afterEach(cleanup);
const source = (city: string, extra = {}) => ({ contactId: 42, values: { city }, ...extra });
it("separates account profile cities from all GCC contact locations", () => {
  render(<AccountLocations members={[
    { id: 1, name: "A", dimensions: { CITY: "Pune", _gccProfiling: [
      source("Mumbai"), source("mumbai"), source("Delhi"), source("Chennai", { deleted: true }),
    ] } },
    { id: 2, name: "B", dimensions: { city: "Hyderabad", _gccProfiling: [source("Bengaluru")] } },
  ]} />);
  const node = screen.getByTestId("account-locations");
  expect(node.textContent).toContain("Pune, Hyderabad");
  expect(node.textContent).toContain("Mumbai, Delhi, Bengaluru");
  expect(node.textContent).toContain("account profile");
  expect(node.textContent).toContain("GCC contact locations");
  expect(node.textContent).not.toContain("Chennai");
  expect(node.textContent).not.toContain("mumbai");
});
it("keeps unspecified cities blank and ignores deleted or invalid source records", () => {
  render(<AccountLocations members={[{ id: 1, name: "A", dimensions: { CITY: "N/A", _gccProfiling: [
    source(""), source("NULL"), source("Delhi", { deleted: true }), null,
  ] } }]} />);
  expect(screen.getByTestId("account-locations").textContent).toBe("Not available");
});
it("retains the location on a pending identity row without treating it as a confirmed contact", () => {
  render(<AccountLocations members={[{ id: 1, name: "A", dimensions: { _gccProfiling: [
    source("Delhi", { contactId: null, identityReview: "Shared email" }),
  ] } }]} />);
  expect(screen.getByTestId("account-locations").textContent).toContain("Delhi");
});
