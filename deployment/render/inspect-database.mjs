import { createRequire } from "node:module";
import { configureEnvironment } from "./runtime.mjs";
const require = createRequire(new URL("../../artifacts/api-server/package.json", import.meta.url));
const { Pool } = require("pg");

// No dump, DDL, migration, seed, record contents or provider calls.
configureEnvironment();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 10_000 });
const required = ["tenants", "users", "user_sessions", "companies", "contacts",
  "journeys", "sequences", "sequence_steps", "abm_plays", "form_submissions"];
let client;
try {
  client = await pool.connect();
  await client.query("BEGIN READ ONLY");
  await client.query("SET LOCAL statement_timeout = '10s'");
  const { rows } = await client.query(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = ANY($1::text[])",
    [required],
  );
  const present = new Set(rows.map(row => row.table_name));
  const counts = {};
  for (const table of required) {
    if (!present.has(table)) { counts[table] = "MISSING"; continue; }
    const result = await client.query(`SELECT count(*)::text AS count FROM "${table}"`);
    counts[table] = result.rows[0].count;
  }
  await client.query("ROLLBACK");
  console.log(JSON.stringify({ readOnly: true, counts, note: "Counts are not a full schema or data-integrity verification." }, null, 2));
  if (required.some(table => !present.has(table))) process.exitCode = 1;
} catch {
  console.error("Read-only database inspection failed. Check the independent Render connection, access and timeouts.");
  process.exitCode = 1;
} finally {
  client?.release();
  await pool.end();
}
