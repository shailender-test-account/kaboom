/** Wait for every worker before releasing the runner's non-overlap guard. */
export async function settleResearchBatch(work: Promise<unknown>[]) {
  const results = await Promise.allSettled(work);
  const failure = results.find(result => result.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
}

/** Cool down failed ticks without replaying any SQL or provider operation. */
export class ResearchRunnerRecovery {
  private failures = 0;
  private retryAt = 0;

  ready(now = Date.now()) { return now >= this.retryAt; }
  succeeded() { this.failures = 0; this.retryAt = 0; }
  failed(now = Date.now()) {
    this.failures = Math.min(this.failures + 1, 5);
    const delay = Math.min(5_000 * 2 ** (this.failures - 1), 60_000);
    this.retryAt = now + delay;
    return delay;
  }
}
