import { expect, it } from "vitest";
import { opportunityCategory } from "./hpBiOpportunityFilter";

it("matches canonical supplied categories and the Collaboration display alias", () => {
  const config = { rules: [], useBuiltin: true };
  expect(opportunityCategory("Collaboration", null, config)).toBe("Business Collaboration");
  expect(opportunityCategory("Security", "laptop", config)).toBe("Security");
  expect(opportunityCategory(null, "AI laptops", config)).toBe("IT Hardware");
  expect(opportunityCategory(null, "Unspecified", config)).not.toBe("IT Hardware");
});
it("uses saved category mappings instead of inventing intent from account metadata", () => {
  const config = { rules: [{ categoryName: "Business Services", terms: ["Custom service"] }], useBuiltin: false };
  expect(opportunityCategory(null, "Custom service", config)).toBe("Business Services");
  expect(opportunityCategory("Unknown", null, config)).toBeNull();
});
