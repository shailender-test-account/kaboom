import { describe, expect, it } from "vitest";
import { currentFiscalYear, dateText, hasPeriodRecords, moneyLines } from "./format";

describe("HP business date and money presentation", () => {
  it("defaults to the current Nov–Oct fiscal year in India, including the exact rollover", () => {
    expect(currentFiscalYear(new Date("2026-10-11T08:00:00Z"))).toBe(2026);
    expect(currentFiscalYear(new Date("2026-10-31T18:29:59Z"))).toBe(2026);
    expect(currentFiscalYear(new Date("2026-10-31T18:30:00Z"))).toBe(2027);
    expect(currentFiscalYear(new Date("2027-01-01T00:00:00Z"))).toBe(2027);
    expect(currentFiscalYear(new Date("2027-11-01T00:00:00Z"))).toBe(2028);
  });
  it("shows the India business day even in a browser with another timezone", () => {
    expect(dateText("2027-01-30T18:30:00.000Z")).toContain("31");
    expect(dateText("2027-01-31T18:30:00.000Z")).toContain("Feb");
  });
  it("retains separate explicit currencies and zero amounts", () => {
    expect(moneyLines({ INR: 100, USD: 0 })).toHaveLength(2);
    expect(moneyLines({ USD: 0 })[0]).toContain("0");
  });
  it("does not hide recorded outcomes or zero-valued prospective records in future periods", () => {
    const empty = { touchpoints: 0, leads: 0, opportunities: 0 };
    expect(hasPeriodRecords(empty)).toBe(false);
    expect(hasPeriodRecords({ ...empty, closedWon: 1 })).toBe(true);
    expect(hasPeriodRecords({ ...empty, prospectiveValues: { USD: 0 } })).toBe(true);
  });
});
