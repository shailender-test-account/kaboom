import { describe, expect, it } from "vitest";
import { describeMatch, queueCount } from "./matchPresentation";

describe("HP held-row presentation", () => {
  it("shows a roster's legal name and HP ID without expanding aliases or variants", () => {
    const result = describeMatch({ reason: "Ambiguous legal-account name", payload: {
      roster: true, fileName: "roster.xlsx", values: { name: "Example Limited", hp_id: "111333",
        top_name: "Example Parent", aliases: ["Large alias payload"], variants: [{ raw: "row" }] },
    } });
    expect(result).toMatchObject({ roster: true, contactReview: false, title: "Example Limited" });
    expect(result.details).toEqual([["HP ID", "111333"], ["Parent", "Example Parent"], ["Source", "roster.xlsx"]]);
  });
  it("routes email conflicts to contact review rather than legal-account resolution", () => {
    const result = describeMatch({ reason: "Email identity is conflicting or ambiguous; use contact identity review first",
      payload: { fields: { name: "Test Person", companyName: "Example Company", email: "test@example.invalid" } } });
    expect(result.contactReview).toBe(true);
    expect(result.title).toBe("Example Company");
    expect(describeMatch({ reason: "Contact is already owned by a conflicting account/client or is anonymous" }).contactReview).toBe(true);
  });
  it("replaces stale dashboard counts and never claims a capped list is the full queue", () => {
    expect(queueCount(Array(12).fill({}), 1)).toBe("12");
    expect(queueCount([], 1)).toBe("0");
    expect(queueCount(undefined, 1)).toBe("1");
    expect(queueCount(Array(100).fill({}), 1)).toBe("100+");
    expect(queueCount(Array(100).fill({}), 150)).toBe("100+");
  });
});
