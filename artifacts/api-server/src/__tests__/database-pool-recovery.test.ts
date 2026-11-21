import pg from "pg";
import { afterEach, expect, it, vi } from "vitest";
import { createDatabasePool } from "../../../../lib/db/src/pool";

afterEach(() => vi.restoreAllMocks());

it("handles a real pg pool's idle error, evicts the client and acquires a replacement", async () => {
  // Exercise pg-pool's actual idle-client error path without touching a database.
  vi.spyOn(pg.Client.prototype, "connect").mockImplementation(function (this: pg.Client, callback?: any): any {
    queueMicrotask(() => callback(null));
  });
  vi.spyOn(pg.Client.prototype, "end").mockImplementation(async () => {});
  const log = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  const pool = createDatabasePool("postgresql://test:secret@localhost/test");
  try {
    expect(pool.options.connectionTimeoutMillis).toBe(10_000);
    const client = await pool.connect();
    client.release();
    expect(pool.idleCount).toBe(1);
    expect(() => client.emit("error", Object.assign(new Error("contains secret"), { code: "ECONNRESET" }))).not.toThrow();
    expect(pool.totalCount).toBe(0);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("database_idle_connection_error"));
    expect(log.mock.calls.flat().join("")).not.toContain("secret");
    const replacement = await pool.connect();
    expect(replacement).not.toBe(client);
    replacement.release();
  } finally {
    await pool.end();
  }
});

it("keeps acquisition failures visible to callers", async () => {
  const error = Object.assign(new Error("authentication timeout"), { code: "ETIMEDOUT" });
  vi.spyOn(pg.Client.prototype, "connect").mockImplementation(function (callback?: any): any {
    queueMicrotask(() => callback(error));
  });
  const pool = createDatabasePool("postgresql://localhost/test");
  try {
    await expect(pool.connect()).rejects.toBe(error);
  } finally {
    await pool.end();
  }
});
