import { EventEmitter } from "node:events";
import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ connect: vi.fn() }));
vi.mock("@workspace/db", () => ({ pool: { connect: mocks.connect }, db: {} }));
vi.mock("../intentResearchRunner", () => ({ kickIntentResearchRunner: vi.fn() }));
vi.mock("../lib/intentProviders", () => ({
  providerConfigured: vi.fn(async () => true),
  providerRequestLimit: vi.fn(async () => 100),
}));
vi.mock("../lib/logger", () => ({ logger: { warn: vi.fn() } }));
vi.mock("../lib/monitoringResearchPolicy", () => ({ monitoringResearchAllowed: () => true }));

import { createProviderRun } from "../intentWeeklyResearchScheduler";
import { retryMonitoringRun } from "../lib/monitoringRetry";
import { selectMonitoringRoster } from "../lib/monitoringRosterAudience";

beforeEach(() => vi.clearAllMocks());

const paths = {
  schedule: () => createProviderRun(1, 2, "perplexity", [3], 10, "test-key", [], "warm",
    { eligible: 1, scheduled: 1, completed: 0, failed: 0, deferred: 0 }, false),
  retry: () => retryMonitoringRun(1, 2, 3, 4, "perplexity"),
  roster: () => selectMonitoringRoster(1, 2),
};

it.each(Object.entries(paths))("%s rejects checked-out disconnects and discards the session", async (_name, run) => {
  const error = new Error("socket disconnected");
  const client = Object.assign(new EventEmitter(), {
    query: vi.fn(async () => {
      client.emit("error", error);
      throw error;
    }), release: vi.fn(),
  });
  mocks.connect.mockResolvedValue(client);
  await expect(run()).rejects.toBe(error);
  expect(client.query).toHaveBeenCalledTimes(1);
  expect(client.release).toHaveBeenCalledWith(true);
  expect(client.listenerCount("error")).toBe(0);
  expect(mocks.connect).toHaveBeenCalledTimes(1);
});

it.each(Object.entries(paths))("%s keeps the original error if rollback also fails", async (_name, run) => {
  const error = new Error("original transaction failure");
  const client = Object.assign(new EventEmitter(), {
    query: vi.fn(async (sql: string) => { throw sql === "ROLLBACK" ? new Error("rollback failed") : error; }),
    release: vi.fn(),
  });
  mocks.connect.mockResolvedValue(client);
  await expect(run()).rejects.toBe(error);
  expect(client.query).toHaveBeenCalledWith("ROLLBACK");
  expect(client.release).toHaveBeenCalledWith(true);
});

it("does not replay a schedule transaction when the commit reply is lost", async () => {
  const error = new Error("commit reply lost");
  const client = Object.assign(new EventEmitter(), {
    query: vi.fn(async (sql: string) => {
      if (sql === "COMMIT") { client.emit("error", error); throw error; }
      return { rows: [{ id: 4 }], rowCount: 1 };
    }), release: vi.fn(),
  });
  mocks.connect.mockResolvedValue(client);
  await expect(paths.schedule()).rejects.toBe(error);
  expect(client.query.mock.calls.filter(([sql]) => sql.includes("INSERT INTO intent_research_runs"))).toHaveLength(1);
  expect(client.query).not.toHaveBeenCalledWith("ROLLBACK");
  expect(client.release).toHaveBeenCalledWith(true);
});
