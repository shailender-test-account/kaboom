import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { afterAll, expect, it, vi } from "vitest";
import { pool } from "@workspace/db";
import { canonicalScopedAccountIntents } from "../routes/intent";

// Opt-in only: actual development data, no app startup, providers or writes.
// Run with INTENT_BATCH_BENCHMARK=baseline|compare pnpm --filter
// @workspace/api-server exec vitest run src/__tests__/intent-batch-benchmark.test.ts
const mode = process.env.INTENT_BATCH_BENCHMARK;
const directory = "../../generated-artifacts/intent-batch-benchmark";
afterAll(async () => { if (mode) await pool.end(); });

it.skipIf(!mode)("profiles fresh heavy/light five-account qualification and preserves the full result", async () => {
  if (process.env.NODE_ENV === "production") throw new Error("Development benchmark only");
  const client = await pool.connect();
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  const originalQuery = pool.query;
  const measurements: Array<{ sql: string; ms: number; rows: number; bytes: number }> = [];
  let queue: Promise<unknown> = Promise.resolve();
  // A read-only transaction guards even accidental writes. One connection also
  // gives every query the same snapshot and avoids changing the app pool config.
  pool.query = (async (sql: string, params?: unknown[]) => {
    if (typeof sql !== "string" || !/^\s*SELECT\b/i.test(sql)) throw new Error("Benchmark permits SELECT only");
    const start = performance.now();
    const pending = queue.then(() => client.query(sql, params));
    queue = pending.catch(() => {});
    const result = await pending;
    measurements.push({ sql, ms: performance.now() - start, rows: result.rows.length,
      bytes: Buffer.byteLength(JSON.stringify(result.rows)) });
    return result;
  }) as typeof pool.query;
  try {
    await mkdir(directory, { recursive: true });
    const baseline = mode === "compare" ? JSON.parse(await readFile(`${directory}/baseline.json`, "utf8")) : null;
    const tenantId = baseline?.tenantId ?? (await pool.query(`SELECT tenant_id FROM intent_evidence
      GROUP BY tenant_id ORDER BY count(*) DESC LIMIT 1`)).rows[0]?.tenant_id;
    expect(tenantId).toBeTypeOf("number");
    const heavy = baseline?.heavy ?? (await pool.query(`SELECT c.id FROM companies c
      JOIN intent_evidence e ON e.tenant_id=c.tenant_id AND e.account_id=c.id
      WHERE c.tenant_id=$1 AND e.evidence_kind='public_event' AND e.review_status<>'rejected'
        AND e.occurred_at>=NOW()-interval '3 months'
      GROUP BY c.id ORDER BY count(*) DESC,c.id LIMIT 5`, [tenantId])).rows.map(row => row.id);
    const light = baseline?.light ?? (await pool.query(`SELECT c.id FROM companies c
      WHERE c.tenant_id=$1 AND NOT EXISTS(SELECT 1 FROM intent_evidence e WHERE e.tenant_id=c.tenant_id AND e.account_id=c.id)
        AND NOT EXISTS(SELECT 1 FROM intent_signals s WHERE s.tenant_id=c.tenant_id AND s.account_id=c.id)
        AND NOT EXISTS(SELECT 1 FROM intent_inbound_submissions ib WHERE ib.tenant_id=c.tenant_id AND ib.account_id=c.id)
      ORDER BY c.id LIMIT 5`, [tenantId])).rows.map(row => row.id);
    const products = (await pool.query("SELECT id FROM intent_products WHERE tenant_id=$1 AND active=true", [tenantId])).rows.map(row => row.id);
    expect(heavy).toHaveLength(5);
    expect(light).toHaveLength(5);
    const clock = baseline?.clock ?? Date.now();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(clock);
    const batches: Record<string, unknown> = {};
    for (const [name, ids] of [["heavy", heavy], ["light", light]] as const) {
      const runs = [];
      for (let run = 0; run < 3; run++) {
        measurements.length = 0;
        const started = performance.now();
        const result = await canonicalScopedAccountIntents(tenantId, ids, products, null, []);
        const ms = performance.now() - started;
        const serialized = JSON.stringify([...result]);
        const digest = createHash("sha256").update(serialized).digest("hex");
        if (baseline) expect(digest, `${name} complete qualification output`).toBe(baseline.batches[name].runs[run].digest);
        runs.push({ ms, digest, queries: measurements.length,
          bytes: measurements.reduce((sum, query) => sum + query.bytes, 0),
          profile: measurements.map(query => ({ ...query, sql: query.sql.slice(0, 100) })) });
      }
      batches[name] = { runs };
    }
    const report = { tenantId, heavy, light, clock, batches };
    await writeFile(`${directory}/${mode === "compare" ? "after" : "baseline"}.json`, JSON.stringify(report, null, 2));
    console.info(JSON.stringify(report, null, 2));
  } finally {
    vi.useRealTimers();
    pool.query = originalQuery;
    await client.query("ROLLBACK");
    client.release();
  }
}, 180_000);
