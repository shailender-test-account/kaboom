import { beforeEach, afterEach, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("@workspace/integrations-openai-ai-server", () => ({
  openai: { chat: { completions: { create: mocked.create } } },
}));

const supported = {
  mode: "people",
  groups: [{ regions: ["north"], functions: ["IT"], products: ["HP Poly"] }],
  interpretation: "North India IT people with HP Poly evidence.",
  unsupported: [],
};
const completion = (plan: unknown) => ({ choices: [{ message: { content: JSON.stringify(plan) } }] });
const scope = { tenantId: 1, clientId: 9 };

beforeEach(() => {
  vi.resetModules();
  mocked.create.mockReset().mockResolvedValue(completion(supported));
});
afterEach(() => { vi.useRealTimers(); });

it("uses minimal reasoning and strict structured output without sending CRM records", async () => {
  const { interpretAnswerQuestion } = await import("./aiAnswerPlan");
  const question = "North India IT people interested in HP Poly";
  const plan = await interpretAnswerQuestion(question, scope);
  expect(plan.groups[0]).toMatchObject({ regions: ["north"], functions: ["IT"], products: ["HP Poly"] });
  const [request, options] = mocked.create.mock.calls[0];
  expect(request).toMatchObject({ model: "gpt-5-mini", reasoning_effort: "minimal",
    response_format: { type: "json_schema", json_schema: { strict: true } } });
  expect(request.messages).toHaveLength(2);
  expect(request.messages[1]).toEqual({ role: "user", content: question });
  expect(options).toMatchObject({ maxRetries: 0, timeout: 25_000 });
});

it("accepts an unsupported-only plan but never permits an empty unrestricted search", async () => {
  const { answerPlanSchema, interpretAnswerQuestion } = await import("./aiAnswerPlan");
  const unsupported = { mode: "accounts", groups: [], interpretation: "Top Hot accounts with forecasts",
    unsupported: ["Top-N ranking, Hot qualification and revenue forecasts are unsupported by AI Answer."] };
  expect(answerPlanSchema.safeParse(unsupported).success).toBe(true);
  expect(answerPlanSchema.safeParse({ ...unsupported, unsupported: [] }).success).toBe(false);
  mocked.create.mockResolvedValue(completion(unsupported));
  expect(await interpretAnswerQuestion("Show the top 10 Hot accounts with forecasted revenue.", scope)).toEqual(unsupported);
});

it("reuses the same scoped question and returns isolated plan copies", async () => {
  const { interpretAnswerQuestion } = await import("./aiAnswerPlan");
  const first = await interpretAnswerQuestion("North India IT Poly people", scope);
  first.unsupported.push("caller-only");
  first.groups[0].products.push("caller-only");
  const second = await interpretAnswerQuestion("North India IT Poly people", scope);
  expect(mocked.create).toHaveBeenCalledTimes(1);
  expect(second.unsupported).toEqual([]);
  expect(second.groups[0].products).toEqual(["HP Poly"]);
});

it("never shares cached interpretations across tenants or clients", async () => {
  const { interpretAnswerQuestion } = await import("./aiAnswerPlan");
  await interpretAnswerQuestion("IT Poly people", scope);
  await interpretAnswerQuestion("IT Poly people", { ...scope, tenantId: 2 });
  await interpretAnswerQuestion("IT Poly people", { ...scope, clientId: 10 });
  expect(mocked.create).toHaveBeenCalledTimes(3);
});

it("expires cached interpretations and reinterprets relative dates after India midnight", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-14T18:29:00Z"));
  const { interpretAnswerQuestion } = await import("./aiAnswerPlan");
  await interpretAnswerQuestion("IT Poly people today", scope);
  vi.setSystemTime(new Date("2026-10-14T18:31:00Z"));
  await interpretAnswerQuestion("IT Poly people today", scope);
  expect(mocked.create).toHaveBeenCalledTimes(2);
  vi.setSystemTime(new Date("2026-10-14T18:37:00Z"));
  await interpretAnswerQuestion("IT Poly people today", scope);
  expect(mocked.create).toHaveBeenCalledTimes(3);
});

it("shares in-flight interpretation but never caches provider failures", async () => {
  const { interpretAnswerQuestion } = await import("./aiAnswerPlan");
  let resolve!: (value: unknown) => void;
  mocked.create.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  const first = interpretAnswerQuestion("IT Poly people", scope);
  const second = interpretAnswerQuestion("IT Poly people", scope);
  await vi.waitFor(() => expect(mocked.create).toHaveBeenCalledTimes(1));
  resolve(completion(supported));
  const results = await Promise.all([first, second]);
  expect(results[0]).toEqual(results[1]);
  expect(results[0]).not.toBe(results[1]);
  mocked.create.mockRejectedValueOnce(new Error("provider unavailable"));
  await expect(interpretAnswerQuestion("A different question", scope)).rejects.toThrow("provider unavailable");
  await interpretAnswerQuestion("A different question", scope);
  expect(mocked.create).toHaveBeenCalledTimes(3);
});

it("preserves all-products, dates, score and independently grouped OR conditions", async () => {
  const { interpretAnswerQuestion, answerPlanSchema } = await import("./aiAnswerPlan");
  const complex = answerPlanSchema.parse({ mode: "people", interpretation: "Both services or an independent western finance group",
    unsupported: [], groups: [
      { regions: ["north"], functions: ["IT"], products: ["HP Poly", "HP Anyware Services"], productMatch: "all",
        interest: "declared", scoreMin: 20, since: "2026-09-01", until: "2026-09-30" },
      { states: ["Maharashtra"], functions: ["Finance"], products: ["HP Anyware Services"] },
    ] });
  mocked.create.mockResolvedValue(completion(complex));
  expect(await interpretAnswerQuestion("Both products with dates and score OR Finance in Maharashtra", scope)).toEqual(complex);
});

it("bounds cache size and rejects invalid dates without caching partial plans", async () => {
  const { interpretAnswerQuestion } = await import("./aiAnswerPlan");
  for (let i = 0; i < 129; i++) await interpretAnswerQuestion(`IT Poly people ${i}`, scope);
  await interpretAnswerQuestion("IT Poly people 0", scope);
  expect(mocked.create).toHaveBeenCalledTimes(130);
  mocked.create.mockResolvedValueOnce(completion({ ...supported, groups: [{ since: "2026-02-30" }] }));
  await expect(interpretAnswerQuestion("Invalid date", scope)).rejects.toThrow();
  await interpretAnswerQuestion("Invalid date", scope);
  expect(mocked.create).toHaveBeenCalledTimes(132);
});
