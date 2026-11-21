/** A failed durable reservation/confirmation must never trigger provider retry/fallback. */
export class ResearchRequestAccountingError extends Error {
  constructor(cause: unknown) {
    super("Research request accounting failed; stopped without replaying the provider request.", { cause });
    this.name = "ResearchRequestAccountingError";
  }
}

export async function researchRequestHook(hook?: () => Promise<void>) {
  try {
    await hook?.();
  } catch (error) {
    throw new ResearchRequestAccountingError(error);
  }
}
