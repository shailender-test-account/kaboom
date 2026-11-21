import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  QUESTIONNAIRE_DIMENSION_DEFAULTS,
  UPLOADED_ANSWER_APPROVAL_POLICY,
  UPLOADED_ANSWER_SIGNAL_TYPES,
  uploadedAnswerSignals,
} from "../lib/intentImportAnswers";
import { toJsonParameter } from "../lib/intentImportJson";
import { normalizeSpreadsheetDate, normalizeSpreadsheetTime } from "../lib/intentImportDateValues";

function strength(field: string, value: string): number {
  const signal = uploadedAnswerSignals({ [field]: value })[0];
  if (!signal) throw new Error(`Missing signal for ${field}`);
  return signal.strength;
}

describe("uploaded questionnaire answer scoring", () => {
  it("converts Excel serial date and time cells into readable values", () => {
    expect(normalizeSpreadsheetDate(45834)).toBe("2025-06-26T00:00:00.000Z");
    expect(normalizeSpreadsheetDate("45838")).toBe("2025-06-30T00:00:00.000Z");
    expect(normalizeSpreadsheetTime(0.41)).toBe("09:50:24");
    expect(normalizeSpreadsheetTime("14:05")).toBe("14:05:00");
  });

  it("weights known buying answers according to their meaning", () => {
    expect(strength("budget", "Budget approved")).toBeGreaterThan(strength("budget", "No budget"));
    expect(strength("purchase_timeframe", "Immediately")).toBeGreaterThan(strength("purchase_timeframe", "Next year"));
    expect(strength("decision_role", "Final decision maker")).toBeGreaterThan(strength("decision_role", "End user"));
    expect(strength("event_rating", "5/5")).toBeGreaterThan(strength("event_rating", "2/5"));
    expect(strength("business_challenge", "Replace an unreliable conferencing stack")).toBeGreaterThan(strength("business_challenge", "None"));
    expect(strength("qualification", "Sales qualified")).toBeGreaterThan(strength("qualification", "Unqualified"));
  });

  it("keeps knowledge intent non-scoring and applies the declared purchase-temperature rules", () => {
    const knowledge = uploadedAnswerSignals({ knowledge_interest: "AI-powered meeting rooms" })[0];
    expect(knowledge).toMatchObject({
      signalTypeKey: "questionnaire_knowledge_intent",
      strength: 0,
    });
    expect(strength("purchase_timeframe", "0-3 months")).toBe(100);
    expect(strength("purchase_timeframe", "3-6 months")).toBe(60);
    expect(strength("purchase_timeframe", "6 months +")).toBe(45);
    expect(strength("purchase_timeframe", "No plans")).toBe(5);
  });

  it("keeps multiple original answers while grouping them into stable signal dimensions", () => {
    const signals = uploadedAnswerSignals({
      event_rating: ["5/5", "4/5"],
      budget: "$50k-$100k",
      decision_role: "Influencer",
    });
    expect(signals).toHaveLength(4);
    expect(signals.filter(signal => signal.signalTypeKey === "questionnaire_rating")).toHaveLength(2);
    expect(signals.map(signal => signal.value)).toContain("$50k-$100k");
  });

  it("has an explicit approved-on-import policy for tenant-provided answers", () => {
    expect(UPLOADED_ANSWER_APPROVAL_POLICY.reviewStatus).toBe("approved");
    expect(UPLOADED_ANSWER_APPROVAL_POLICY.rationale).toContain("malformed or ambiguous rows are not ingested");
    expect(new Set(UPLOADED_ANSWER_SIGNAL_TYPES.map(([key]) => key)).size).toBe(UPLOADED_ANSWER_SIGNAL_TYPES.length);
  });

  it("applies configured answer rules without mutating the built-in defaults", () => {
    const configured = structuredClone(QUESTIONNAIRE_DIMENSION_DEFAULTS);
    const budget = configured.find((dimension) => dimension.key === "budget");
    if (!budget) throw new Error("Missing budget dimension");
    budget.rules = [{ id: "confirmed", label: "Confirmed budget", keywords: ["approved"], strength: 42 }];

    expect(uploadedAnswerSignals({ budget: "Budget approved" }, configured)[0]?.strength).toBe(42);
    expect(uploadedAnswerSignals({ budget: "Budget approved" })[0]?.strength).toBe(95);
  });

  it("keeps configured strengths bounded to the product-intent scale", () => {
    const configured = structuredClone(QUESTIONNAIRE_DIMENSION_DEFAULTS);
    const qualification = configured.find((dimension) => dimension.key === "qualification");
    if (!qualification) throw new Error("Missing qualification dimension");
    qualification.rules[0].strength = 999;

    expect(uploadedAnswerSignals({ qualification: "Unqualified" }, configured)[0]?.strength).toBe(100);
  });
});

describe("uploaded answer provenance and isolation", () => {
  it("serializes import summaries and error arrays as JSON rather than PostgreSQL array literals", () => {
    expect(toJsonParameter([])).toBe("[]");
    expect(toJsonParameter([{ rowNumber: 5, error: "No match" }])).toBe('[{"rowNumber":5,"error":"No match"}]');
  });

  it("links every imported answer signal to its import run and keeps product imports out of global recompute", () => {
    const routes = readFileSync(new URL("../routes/intent.ts", import.meta.url), "utf8");
    const commit = routes.slice(routes.indexOf('router.post("/intent/imports/commit"'), routes.indexOf('router.post("/intent/recompute"'));
    expect(commit).toContain("import_run_id");
    expect(commit).toContain("importRunId: importRun.rows[0].id");
    expect(commit).toContain("UPLOADED_ANSWER_APPROVAL_POLICY.reviewStatus");
    expect(commit).toContain("for (const entity of affected.values())");
    expect(commit).toContain('answer.field === "knowledge_interest"');
    expect(commit).toContain("item.inferredProducts");
    expect(commit).toContain("toJsonParameter(errors)");
    expect(commit).toContain("toJsonParameter(signalPayload)");
  });

  it("migrates direct import provenance and scopes duplicate files by product and audience", () => {
    const migration = readFileSync(new URL("../../../../lib/db/drizzle/0019_intent_import_provenance.sql", import.meta.url), "utf8");
    expect(migration).toContain("ADD COLUMN IF NOT EXISTS import_run_id");
    expect(migration).toContain("COALESCE(product_id, 0)");
    expect(migration).toContain("COALESCE(audience_id, 0)");
  });
});