import { EventEmitter } from "node:events";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(), connect: vi.fn(), defaults: vi.fn(), subject: vi.fn(),
  fetch: vi.fn(), warn: vi.fn(),
}));
vi.mock("@workspace/db", () => ({ pool: { query: mocks.query, connect: mocks.connect } }));
vi.mock("../lib/alwaysOnIntent", () => ({ ensureIntentDefaults: mocks.defaults, eventFingerprint: vi.fn() }));
vi.mock("../lib/hpParentResearch", () => ({ resolveHpResearchSubject: mocks.subject }));
vi.mock("../lib/logger", () => ({ logger: { warn: mocks.warn } }));
vi.mock("../lib/researchOpportunityInterpreter", () => ({
  RESEARCH_FITMENT_POLICY_VERSION: 6,
  refreshStoredResearchOpportunity: vi.fn(async () => null),
}));
vi.mock("../lib/intentProviders", async original => ({
  ...await original<typeof import("../lib/intentProviders")>(),
  fetchPerplexityEvents: mocks.fetch,
}));

import { processRunAccount, startIntentResearchRunner, kickIntentResearchRunner } from "../intentResearchRunner";

const run = {
  id: 2, tenant_id: 3, client_id: 4, audience_id: null,
  provider: "perplexity" as const, request_count: 0,
  confirmed_request_count: 0, request_limit: 10, summary: {},
};
const account = { id: 5, account_id: 6, attempts: 1 };

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetAllMocks();
  vi.stubEnv("COPIED_DATA_SAFE_MODE", "true");
  vi.stubEnv("MONITORING_RESEARCH_ENABLED", "true");
  mocks.query.mockResolvedValue({ rows: [{ id: 5 }], rowCount: 1 });
  mocks.subject.mockResolvedValue({ scope: "member", accountId: 6 });
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

it("marks failed work retryable without advancing recency or requesting research", async () => {
  mocks.defaults.mockRejectedValue(new Error("authentication timeout"));
  await processRunAccount(run, account);
  const failure = mocks.query.mock.calls.find(([sql]) => sql.includes("SET status='failed'"));
  expect(failure?.[1][1]).toBe("authentication timeout");
  expect(failure?.[1].slice(2)).toEqual([3, 5, 1]);
  expect(mocks.fetch).not.toHaveBeenCalled();
  expect(mocks.query.mock.calls.some(([sql]) => sql.includes("last_researched_at"))).toBe(false);
  expect(mocks.query.mock.calls.some(([sql]) => sql.includes("status='completed'"))).toBe(false);
});

it("surfaces a failure to save retry state rather than reporting a completed account", async () => {
  const error = new Error("connection lost");
  mocks.defaults.mockRejectedValue(error);
  mocks.query.mockImplementation(async sql => {
    if (sql.includes("SET status='failed'")) throw error;
    return { rows: [{ id: 5 }], rowCount: 1 };
  });
  await expect(processRunAccount(run, account)).rejects.toBe(error);
  expect(mocks.fetch).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it("still completes valid zero-result checks exactly once without inventing requests", async () => {
  const client = Object.assign(new EventEmitter(), {
    query: vi.fn().mockResolvedValue({ rows: [{ id: 5 }], rowCount: 1 }), release: vi.fn(),
  });
  mocks.connect.mockResolvedValue(client);
  mocks.fetch.mockResolvedValue({
    rows: [], stats: { requests: 0, pages: 0, retries: 0, rateLimited: 0, recordsFetched: 0, recordsNormalized: 0, failures: [] },
  });
  await processRunAccount(run, account);
  expect(mocks.fetch).toHaveBeenCalledTimes(1);
  const completions = mocks.query.mock.calls.filter(([sql]) => sql.includes("UPDATE companies company SET last_researched_at"));
  expect(completions).toHaveLength(1);
  expect(completions[0][1].slice(1)).toEqual([3, 5, 1, 6]);
  expect(mocks.query.mock.calls.some(([sql]) => sql.includes("SET status='failed'"))).toBe(false);
  expect(mocks.query.mock.calls.some(([sql]) => sql.includes("request_count=request_count+1"))).toBe(false);
  expect(client.release).toHaveBeenCalledOnce();
});

it.each(["BEGIN", "COMMIT"])("handles an evidence transaction disconnect during %s without completing or replaying research", async phase => {
  const error = new Error("evidence transaction connection dropped");
  const client = Object.assign(new EventEmitter(), {
    query: vi.fn(async (sql: string) => {
      if (sql === phase) {
        client.emit("error", error);
        throw error;
      }
      return { rows: [{ id: 5 }], rowCount: 1 };
    }),
    release: vi.fn(),
  });
  mocks.connect.mockResolvedValue(client);
  mocks.fetch.mockResolvedValue({ rows: [], stats: { requests: 1, failures: [] } });
  await processRunAccount(run, account);
  expect(mocks.fetch).toHaveBeenCalledTimes(1);
  expect(client.release).toHaveBeenCalledWith(true);
  expect(client.listenerCount("error")).toBe(0);
  expect(client.query).not.toHaveBeenCalledWith("ROLLBACK");
  expect(mocks.query.mock.calls.some(([sql]) => sql.includes("last_researched_at"))).toBe(false);
  const failure = mocks.query.mock.calls.find(([sql]) => sql.includes("SET status='failed'"));
  expect(failure?.[1][1]).toBe(error.message);
  expect(failure?.[1].slice(2)).toEqual([3, 5, 1]);
});

it("discards an evidence client when rollback fails and preserves the original failure", async () => {
  const error = new Error("evidence write failed");
  const client = Object.assign(new EventEmitter(), {
    query: vi.fn(async (sql: string) => {
      if (sql === "COMMIT") throw error;
      if (sql === "ROLLBACK") throw new Error("rollback connection dropped");
      return { rows: [{ id: 5 }], rowCount: 1 };
    }), release: vi.fn(),
  });
  mocks.connect.mockResolvedValue(client);
  mocks.fetch.mockResolvedValue({ rows: [], stats: { requests: 1, failures: [] } });
  await processRunAccount(run, account);
  expect(client.release).toHaveBeenCalledWith(true);
  const failure = mocks.query.mock.calls.find(([sql]) => sql.includes("SET status='failed'"));
  expect(failure?.[1][1]).toBe(error.message);
});

it("stops new requests after a failed heartbeat, without overlapping heartbeats", async () => {
  let proceed!: () => void;
  const pending = new Promise<void>(resolve => { proceed = resolve; });
  mocks.query.mockImplementation(async sql => {
    if (sql.includes("SET started_at=NOW()")) throw new Error("heartbeat connection lost");
    return { rows: [{ id: 5 }], rowCount: 1 };
  });
  mocks.fetch.mockImplementation(async (_tenant, scope) => {
    await pending;
    await scope.beforeRequest();
  });
  const work = processRunAccount(run, account);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(mocks.query.mock.calls.filter(([sql]) => sql.includes("SET started_at=NOW()"))).toHaveLength(1);
  proceed();
  await work;
  expect(mocks.query.mock.calls.some(([sql]) => sql.includes("request_count=request_count+1"))).toBe(false);
  expect(mocks.query.mock.calls.some(([sql]) => sql.includes("SET status='failed'"))).toBe(true);
});

it("handles a checked-out parent connection error and prevents another provider request", async () => {
  const client = Object.assign(new EventEmitter(), {
    query: vi.fn().mockResolvedValue({ rows: [] }), release: vi.fn(),
  });
  mocks.connect.mockResolvedValue(client);
  mocks.subject.mockResolvedValue({ scope: "parent", accountId: 10 });
  mocks.fetch.mockImplementation(async (_tenant, scope) => {
    client.emit("error", new Error("connection terminated"));
    await scope.beforeRequest();
  });
  await processRunAccount(run, account);
  expect(client.release).toHaveBeenCalledWith(true);
  expect(client.listenerCount("error")).toBe(0);
  expect(mocks.query.mock.calls.some(([sql]) => sql.includes("request_count=request_count+1"))).toBe(false);
  expect(mocks.query.mock.calls.some(([sql]) => sql.includes("SET status='failed'"))).toBe(true);
});

it("does not run paused automation, including explicit wakeups", async () => {
  vi.stubEnv("MONITORING_RESEARCH_ENABLED", "false");
  startIntentResearchRunner();
  await vi.advanceTimersByTimeAsync(15_000);
  kickIntentResearchRunner();
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.query).not.toHaveBeenCalled();
});

it("backs off failed database ticks and keeps wakeups from bypassing the cooldown", async () => {
  mocks.query.mockRejectedValue(new Error("authentication timeout"));
  startIntentResearchRunner();
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.query).toHaveBeenCalledTimes(1);
  kickIntentResearchRunner();
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.query).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(mocks.query).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(mocks.query).toHaveBeenCalledTimes(2);
  mocks.query.mockResolvedValue({ rows: [] });
  await vi.advanceTimersByTimeAsync(5_000);
  expect(mocks.query).toHaveBeenCalledTimes(3);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(mocks.query).toHaveBeenCalledTimes(4);
  expect(mocks.fetch).not.toHaveBeenCalled();
});
