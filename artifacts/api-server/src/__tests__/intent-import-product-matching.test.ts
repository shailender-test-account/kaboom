import { describe, expect, it } from "vitest";
import { inferCategoriesFromInterest, inferProductsFromInterest } from "../lib/intentImportProductMatching";

const catalog = [
  { id: 1, name: "Noise-Cancelling Conference Devices", category: "Virtual Collaboration", subcategory: "Active Noise Cancellation" },
  { id: 2, name: "Business Laptops", category: "IT Hardware", subcategory: "Laptops" },
  { id: 3, name: "Room Video Systems", category: "Virtual Collaboration", subcategory: "Video Conferencing" },
  { id: 4, name: "Conference Services", category: "Virtual Collaboration", subcategory: "Teleconferencing" },
];

describe("questionnaire product inference", () => {
  it("matches multiple named services without requiring an upload-time product", () => {
    const matches = inferProductsFromInterest(
      "Noise-Cancelling Conference Devices; Business Laptops",
      catalog,
    );
    expect(matches.map(match => match.id)).toEqual([2, 1]);
    expect(matches.every(match => match.confidence === 100)).toBe(true);
  });

  it("expands an explicit subcategory answer to products in that subcategory", () => {
    expect(inferProductsFromInterest("We want to explore video conferencing", catalog))
      .toEqual([expect.objectContaining({ id: 3, matchedOn: "subcategory" })]);
  });

  it("does not manufacture a product match from an unrelated knowledge topic", () => {
    expect(inferProductsFromInterest("Leadership and sustainability trends", catalog)).toEqual([]);
  });

  it("does not infer a generic product from one shared word", () => {
    expect(inferProductsFromInterest("Noise-Cancelling Conference Devices", catalog).map(match => match.id)).toEqual([1]);
  });

  it("does not assign an ambiguous keyword-only answer to an arbitrary catalog product", () => {
    const ambiguousCatalog = [
      ...catalog,
      { id: 5, name: "ANC Earphones", category: "Virtual Collaboration", subcategory: "Personal Audio" },
    ];
    expect(inferProductsFromInterest("Need ANC audio gear", ambiguousCatalog)).toEqual([]);
  });

  it("incorporates an ambiguous DaaS answer at category level without choosing a SKU", () => {
    const deviceCatalog = [
      { id: 1, name: "Business Laptops", category: "IT Hardware", subcategory: "Laptops" },
      { id: 2, name: "Desktop Workstations", category: "IT Hardware", subcategory: "Workstations" },
      { id: 3, name: "CRM Platform", category: "CRM Software", subcategory: "CRM" },
    ];
    expect(inferProductsFromInterest("HP Device-as-a-Service", deviceCatalog)).toEqual([]);
    expect(inferCategoriesFromInterest("HP Device-as-a-Service", deviceCatalog)).toEqual([
      expect.objectContaining({ category: "IT Hardware", confidence: 82 }),
    ]);
  });

  it("maps HP Device-as-a-Service to the managed device-services catalog entry", () => {
    const hpCatalog = [
      ...catalog,
      { id: 8, name: "HP Managed Device Services", category: "Software & Services", subcategory: "Computing Services" },
    ];
    expect(inferProductsFromInterest("HP Device-as-a-Service", hpCatalog)).toEqual([
      expect.objectContaining({ id: 8, confidence: 95 }),
    ]);
    expect(inferCategoriesFromInterest("HP Device-as-a-Service", hpCatalog)).toEqual([
      expect.objectContaining({ category: "Software & Services", confidence: 95 }),
    ]);
  });

  it("does not expand a named service into every product in a shared category for opportunities", () => {
    const serviceCatalog = [
      { id: 10, name: "HP Security Services", category: "Security", subcategory: null },
      { id: 11, name: "Technology Consulting", category: "Services", subcategory: null },
      { id: 12, name: "Strategy Consulting", category: "Services", subcategory: null },
      { id: 13, name: "Systems Implementation", category: "Services", subcategory: null },
      { id: 14, name: "Data Migration Services", category: "Services", subcategory: null },
    ];
    expect(inferProductsFromInterest("HP Security Services", serviceCatalog, { includeCategoryMatches: false })
      .map(match => match.id)).toEqual([10]);
    expect(inferProductsFromInterest("Services", serviceCatalog, { includeCategoryMatches: false })).toEqual([]);
  });
});