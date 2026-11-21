import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { describe, expect, it } from "vitest";

const migrationsFolder = fileURLToPath(new URL("../../../../lib/db/drizzle/", import.meta.url));
const journal = JSON.parse(
  fs.readFileSync(fileURLToPath(new URL("../../../../lib/db/drizzle/meta/_journal.json", import.meta.url)), "utf8"),
) as { entries: Array<{ idx: number; tag: string; when: number }> };
const intentTables = [
  "intent_signal_types",
  "intent_tiers",
  "intent_signals",
  "intent_entity_scores",
  "intent_score_history",
  "intent_recommendations",
  "intent_recommendation_outcomes",
  "intent_import_runs",
  "intent_recompute_queue",
];

function identifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

describe("Intent migration discovery", () => {
  it("applies the journaled Intent migration on a clean schema", async () => {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) throw new Error("DATABASE_URL is required for the migration integration test");

    const suffix = `${process.pid}_${Date.now()}`;
    const appSchema = `intent_migration_app_${suffix}`;
    const trackerSchema = `intent_migration_tracker_${suffix}`;
    // This test is for the Intent migration, not every later feature. A
    // journal-limited copy also prevents unrelated later ALTERs from falling
    // through search_path into the shared public development schema.
    const isolatedMigrations = fs.mkdtempSync(path.join(os.tmpdir(), "intent-migrations-"));
    fs.mkdirSync(path.join(isolatedMigrations, "meta"));
    fs.writeFileSync(path.join(isolatedMigrations, "meta", "_journal.json"),
      JSON.stringify({ ...journal, entries: journal.entries.filter(entry => entry.idx <= 15) }));
    for (const entry of journal.entries.filter(candidate => candidate.idx <= 15)) {
      fs.copyFileSync(path.join(migrationsFolder, `${entry.tag}.sql`),
        path.join(isolatedMigrations, `${entry.tag}.sql`));
    }
    const admin = new pg.Pool({ connectionString: databaseUrl });
    let isolated: pg.Pool | undefined;

    try {
      await admin.query(`CREATE SCHEMA ${identifier(appSchema)}`);
      await admin.query(`CREATE SCHEMA ${identifier(trackerSchema)}`);
      await admin.query(
        `CREATE TABLE ${identifier(trackerSchema)}.__drizzle_migrations (
           id serial PRIMARY KEY,
           hash text NOT NULL,
           created_at bigint
         )`,
      );
      for (const entry of journal.entries.filter((candidate) => candidate.idx < 13)) {
        const sql = fs.readFileSync(`${migrationsFolder}${entry.tag}.sql`, "utf8");
        const hash = crypto.createHash("sha256").update(sql).digest("hex");
        await admin.query(
          `INSERT INTO ${identifier(trackerSchema)}.__drizzle_migrations(hash,created_at) VALUES($1,$2)`,
          [hash, entry.when],
        );
      }
      isolated = new pg.Pool({
        connectionString: databaseUrl,
        options: `-c search_path=${appSchema},public`,
      });
      await isolated.query(
        `CREATE TABLE contacts (
           id integer PRIMARY KEY,
           tenant_id integer NOT NULL,
           company_id integer
         );
         CREATE TABLE activity_events (
           id serial PRIMARY KEY,
           contact_id integer,
           event_type text NOT NULL,
           description text NOT NULL,
           created_at timestamptz NOT NULL DEFAULT NOW()
         );`,
      );

      await migrate(drizzle(isolated), {
        migrationsFolder: isolatedMigrations,
        migrationsSchema: trackerSchema,
      });

      const tables = await isolated.query<{ table_name: string }>(
        `SELECT table_name
         FROM information_schema.tables
         WHERE table_schema=$1 AND table_name = ANY($2::text[])
         ORDER BY table_name`,
        [appSchema, intentTables],
      );
      expect(tables.rows.map((row) => row.table_name)).toEqual([...intentTables].sort());

      const applied = await admin.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM ${identifier(trackerSchema)}.__drizzle_migrations`,
      );
      expect(applied.rows[0]?.count).toBe(16);

      await isolated.query(
        `INSERT INTO contacts(id,tenant_id,company_id,is_anonymous)
         VALUES(7001,77,8001,false),(7002,77,8002,false),(7003,77,8003,true),(7004,88,8004,false);
         INSERT INTO activity_events(tenant_id,contact_id,event_type,description,is_bot)
         VALUES
           (77,7001,'page_view','valid',false),
           (77,7002,'page_view','bot',true),
           (77,7003,'page_view','anonymous',false),
           (77,7004,'page_view','cross tenant',false),
           (77,7999,'page_view','missing contact',false);`,
      );
      const queued = await isolated.query<{ account_id: number | null; contact_id: number | null; status: string }>(
        `SELECT account_id,contact_id,status
         FROM intent_recompute_queue
         WHERE tenant_id=77
         ORDER BY contact_id NULLS LAST,account_id NULLS LAST`,
      );
      expect(queued.rows).toEqual([
        { account_id: null, contact_id: 7001, status: "pending" },
        { account_id: 8001, contact_id: null, status: "pending" },
      ]);

      await isolated.query(
        `UPDATE intent_recompute_queue
         SET status='claimed',claimed_at=NOW()
         WHERE tenant_id=77;
         INSERT INTO activity_events(tenant_id,contact_id,event_type,description,is_bot)
         VALUES(77,7001,'email_open','new activity during lease',false);`,
      );
      const refreshed = await isolated.query<{ count: number; pending: number }>(
        `SELECT count(*)::int AS count,
                count(*) FILTER (WHERE status='pending' AND claimed_at IS NULL)::int AS pending
         FROM intent_recompute_queue
         WHERE tenant_id=77`,
      );
      expect(refreshed.rows[0]).toEqual({ count: 2, pending: 2 });
    } finally {
      await isolated?.end();
      await admin.query(`DROP SCHEMA IF EXISTS ${identifier(appSchema)} CASCADE`);
      await admin.query(`DROP SCHEMA IF EXISTS ${identifier(trackerSchema)} CASCADE`);
      await admin.end();
      fs.rmSync(isolatedMigrations, { recursive: true, force: true });
    }
  }, 120_000);
});