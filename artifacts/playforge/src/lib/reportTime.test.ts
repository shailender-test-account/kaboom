import { describe, expect, it } from "vitest";
import { formatReportDate, formatReportDateTime, formatReportDayLabel, formatReportTime } from "./reportTime";

describe("report times in GMT+05:30", () => {
  it("converts timestamp dates and times across the midnight boundary", () => {
    const instant = "2026-09-28T18:31:00.000Z";
    expect(formatReportDate(instant)).toBe("29 Sept 2026");
    expect(formatReportTime(instant)).toBe("00:01 GMT+05:30");
    expect(formatReportDateTime(instant)).toContain("29 Sept 2026, 00:01 GMT+05:30");
  });

  it("does not shift calendar-day bucket labels", () => {
    expect(formatReportDate("2026-09-28")).toBe("28 Sept 2026");
    expect(formatReportDayLabel("2026-09-28", true)).toBe("28 Sept 2026");
  });

  it("does not invent a timestamp for missing or invalid input", () => {
    expect(formatReportDateTime(null)).toBe("—");
    expect(formatReportDateTime("not-a-date")).toBe("—");
  });
});