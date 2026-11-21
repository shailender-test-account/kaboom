import { describe, expect, it } from "vitest";
import { parseBulkUserRows, parseUserCsv } from "./bulkUsers";

describe("bulk user upload preview", () => {
  it("normalizes spreadsheet headers, quoted names and email case", () => {
    const rows = parseUserCsv('First Name,Last Name,Email Address\n"Jo, Jr",Doe,JO@example.invalid', []);
    expect(rows).toEqual([{ rowNumber: 2, firstName: "Jo, Jr", lastName: "Doe", email: "jo@example.invalid", errors: [] }]);
  });
  it("flags every repeated email and existing users without silently skipping rows", () => {
    const rows = parseUserCsv("first_name,last_name,email\nA,B,same@example.invalid\nC,D,SAME@example.invalid", ["same@example.invalid"]);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.errors).toContain("Duplicate email in this batch.");
      expect(row.errors).toContain("Email is already registered.");
    }
  });
  it("prevents missing names, malformed emails and unexpected access columns", () => {
    expect(parseUserCsv("first_name,last_name,email\nA,,bad", [])[0].errors).toHaveLength(2);
    expect(() => parseUserCsv("first_name,last_name,email,role\nA,B,a@example.invalid,admin", [])).toThrow("Choose access settings below");
    expect(() => parseUserCsv("first_name,email\nA,a@example.invalid", [])).toThrow("lastName");
    expect(parseBulkUserRows([["first_name", "last_name", "email"], ["A", "B", "a@example.invalid", "extra"]], [])[0].errors).toContain("Unexpected extra column.");
  });
  it("rejects empty, malformed and oversized imports", () => {
    expect(() => parseUserCsv("", [])).toThrow();
    expect(() => parseUserCsv('first_name,last_name,email\n"unfinished', [])).toThrow("Could not read CSV");
    const rows = [["first_name", "last_name", "email"], ...Array.from({ length: 51 }, (_, i) => ["A", "B", `user${i}@example.invalid`])];
    expect(() => parseBulkUserRows(rows, [])).toThrow("up to 50");
  });
});
