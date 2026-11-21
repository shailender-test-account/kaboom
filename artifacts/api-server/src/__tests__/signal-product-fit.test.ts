import { describe, expect, it } from "vitest";
import { analyzeProductFitment, deriveProductFitments, prepareProductFitmentSource } from "../lib/signalProductFit";

const catalog = [
  { id: 1, name: "ANC Headsets", category: "Audio & Collaboration", subcategory: "Headsets" },
  { id: 6, name: "ANC Earbuds", category: "Audio & Collaboration", subcategory: "Active Noise Cancellation" },
  { id: 2, name: "Business Laptops", category: "IT Hardware", subcategory: "Laptops" },
  { id: 3, name: "Contact Center Telephony", category: "Telecom & Voice", subcategory: "Telephony" },
  { id: 4, name: "Laser Printers", category: "Printing", subcategory: "Laser Printers" },
  { id: 5, name: "CRM Platform", category: "CRM Software", subcategory: "CRM" },
];

it("reuses source parsing without sharing product conclusions or accepting changed source text",()=>{
  const text="The India office issued an RFP for 500 laptops within 30 days. Separately it opened a new contact center in Pune with 200 agents.";
  const prepared=prepareProductFitmentSource(text);
  for(const product of catalog){
    expect(analyzeProductFitment({text},product,prepared)).toEqual(analyzeProductFitment({text},product));
    const corrected="The London office has no requirement for laptops.";
    expect(analyzeProductFitment({text:corrected},product,prepared)).toEqual(analyzeProductFitment({text:corrected},product));
  }
});

describe("signal-to-product fitment", () => {
  it("turns a 200-person contact-center launch into differentiated strong fits", () => {
    const fits = deriveProductFitments({
      eventType: "hiring",
      text: "The company is starting a new contact center with 200 people next quarter.",
      confidence: 90,
    }, catalog);
    expect(fits.map(fit => fit.productId)).toEqual([1, 3, 2]);
    expect(fits.find(fit => fit.productId === 1)?.points).toBe(70);
    expect(fits.find(fit => fit.productId === 2)?.points).toBeLessThan(70);
    expect(fits.some(fit => fit.productId === 4)).toBe(false);
  });

  it("does not manufacture laptop intent from one senior product-manager hire", () => {
    expect(deriveProductFitments({
      eventType: "hiring",
      text: "The company hired one senior product manager.",
      confidence: 92,
    }, catalog)).toEqual([]);
  });

  it("keeps generic funding as account context rather than product intent", () => {
    expect(deriveProductFitments({
      eventType: "funding",
      text: "The company raised a new funding round to support growth.",
      confidence: 88,
    }, catalog)).toEqual([]);
  });

  it("treats a product tender as Hot-grade direct intent", () => {
    const fits = deriveProductFitments({
      eventType: "technology_integration",
      text: "The company issued an RFP for 500 business laptops with delivery required this quarter.",
      confidence: 95,
    }, catalog);
    expect(fits).toEqual([expect.objectContaining({ productId: 2, level: "direct_intent", points: 70 })]);
  });

  it("does not make a product Hot when an RFP has no near-term timeframe", () => {
    const fits = deriveProductFitments({
      eventType: "technology_integration",
      text: "The company issued an RFP for 500 business laptops.",
      confidence: 95,
    }, catalog);
    expect(fits).toEqual([expect.objectContaining({ productId: 2, level: "confirmed_need", points: 55 })]);
  });

  it("does not combine unrelated buying and category text from distant page sections", () => {
    const fits = deriveProductFitments({
      eventType: "funding",
      text: "RPG Active Pharma acquired an API manufacturing business. The purchase closes this quarter. Several unrelated market stories follow. ".repeat(8) + "A technology index mentioned laptops and printers.",
      confidence: 90,
    }, catalog);
    expect(fits).toEqual([]);
  });

  it("does not infer ANC Earbuds from generic ANC or audio-family language", () => {
    const fits = deriveProductFitments({
      eventType: "technology_integration",
      text: "The company is evaluating ANC audio equipment for shared workspaces.",
      confidence: 90,
    }, catalog);
    expect(fits.map(fit => fit.productId)).not.toContain(6);
  });

  it("requires earbuds to be explicitly named before assigning an earbuds tender", () => {
    const fits = deriveProductFitments({
      eventType: "procurement",
      text: "The company issued a tender for 1,000 noise-cancelling earbuds with a closing date this month.",
      confidence: 95,
    }, catalog);
    expect(fits).toContainEqual(expect.objectContaining({ productId: 6, level: "direct_intent", points: 70 }));
  });
});