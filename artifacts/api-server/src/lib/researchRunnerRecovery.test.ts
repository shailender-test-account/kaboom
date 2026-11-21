import { expect, it } from "vitest";
import { ResearchRunnerRecovery, settleResearchBatch } from "./researchRunnerRecovery";

it("backs off failed ticks up to one minute and resets after recovery", () => {
  const recovery = new ResearchRunnerRecovery();
  expect(recovery.ready(0)).toBe(true);
  for (const delay of [5_000, 10_000, 20_000, 40_000, 60_000, 60_000]) {
    expect(recovery.failed(100)).toBe(delay);
    expect(recovery.ready(100 + delay - 1)).toBe(false);
    expect(recovery.ready(100 + delay)).toBe(true);
  }
  recovery.succeeded();
  expect(recovery.ready(0)).toBe(true);
  expect(recovery.failed(0)).toBe(5_000);
});

it("does not release a batch while another worker is still running", async () => {
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  const error = new Error("database disconnected");
  let settled = false;
  const batch = settleResearchBatch([Promise.reject(error), pending])
    .catch(value => { settled = true; expect(value).toBe(error); });
  await new Promise(resolve => setImmediate(resolve));
  expect(settled).toBe(false);
  finish();
  await batch;
  expect(settled).toBe(true);
});
