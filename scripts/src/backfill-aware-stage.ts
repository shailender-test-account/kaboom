/**
 * backfill-aware-stage.ts
 *
 * One-time idempotent backfill: advances contacts that are still at stage='pre-aware'
 * but have at least one real email_click activity event to stage='aware'.
 *
 * Idempotency guarantees:
 *   - contacts UPDATE only fires when COALESCE(stage,'pre-aware') = 'pre-aware'
 *   - contact_stage_history is inserted ONLY when the UPDATE actually mutated a row
 *     (rowCount check), so re-runs never add duplicate history rows
 *   - tags dedup uses CASE instead of a guard filter so a stray 'aware' tag alone
 *     cannot block stage advancement
 *
 * Usage:
 *   pnpm --filter @workspace/scripts run backfill-aware-stage
 *   # Optionally scope to a single tenant:
 *   TENANT_ID=1 pnpm --filter @workspace/scripts run backfill-aware-stage
 */

import pg from "pg";

const { Pool } = pg;

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("ERROR: DATABASE_URL environment variable is not set.");
  process.exit(1);
}

const tenantFilter = process.env.TENANT_ID ? parseInt(process.env.TENANT_ID, 10) : null;

const pool = new Pool({ connectionString: DATABASE_URL });

async function run(): Promise<void> {
  const client = await pool.connect();
  try {
    console.log("=== Backfill: advance pre-aware contacts with email_click to aware ===");
    if (tenantFilter) {
      console.log(`Scoped to tenant_id = ${tenantFilter}`);
    } else {
      console.log("Running across ALL tenants");
    }

    const tenantClause = tenantFilter ? `AND c.tenant_id = ${tenantFilter}` : "";

    // Find all contacts stuck at pre-aware who have at least one email_click event.
    const { rows: candidates } = await client.query<{
      id: number;
      tenant_id: number;
    }>(
      `SELECT c.id, c.tenant_id
       FROM contacts c
       WHERE COALESCE(c.stage, 'pre-aware') = 'pre-aware'
         ${tenantClause}
         AND EXISTS (
           SELECT 1
           FROM activity_events ae
           WHERE ae.contact_id = c.id
             AND ae.tenant_id  = c.tenant_id
             AND ae.event_type = 'email_click'
         )
       ORDER BY c.tenant_id, c.id`
    );

    if (candidates.length === 0) {
      console.log("No contacts need backfilling — nothing to do.");
      return;
    }

    console.log(`Found ${candidates.length} candidate contact(s) to process.`);

    let advancedCount = 0;
    let alreadyAwareCount = 0;

    for (const contact of candidates) {
      // Atomic CTE: UPDATE and INSERT happen in one statement — the INSERT only
      // fires when the UPDATE RETURNING produces a row, so if this runs twice the
      // second pass yields 0 RETURNING rows and 0 history inserts (no duplicates).
      const { rowCount } = await client.query(
        `WITH advanced AS (
           UPDATE contacts
           SET stage = 'aware',
               tags  = CASE
                         WHEN 'aware' = ANY(COALESCE(tags, '{}'))
                         THEN tags
                         ELSE array_append(COALESCE(tags, '{}'), 'aware')
                       END
           WHERE id        = $1
             AND tenant_id = $2
             AND COALESCE(stage, 'pre-aware') = 'pre-aware'
           RETURNING id, tenant_id, lead_score
         )
         INSERT INTO contact_stage_history
           (tenant_id, contact_id, from_stage, to_stage, score_at_transition, created_at)
         SELECT tenant_id, id, 'pre-aware', 'aware', lead_score, NOW()
         FROM advanced`,
        [contact.id, contact.tenant_id]
      );

      if ((rowCount ?? 0) > 0) {
        advancedCount++;
        console.log(
          `  ✓ contact id=${contact.id} tenant_id=${contact.tenant_id} → advanced to aware`
        );
      } else {
        // UPDATE fired but rowCount=0 means the row was already at a non-pre-aware
        // stage between candidate-fetch and now (race condition or prior partial run).
        alreadyAwareCount++;
        console.log(
          `  ~ contact id=${contact.id} tenant_id=${contact.tenant_id} — stage already advanced, skipped`
        );
      }
    }

    console.log(`\nDone.`);
    console.log(`  Advanced : ${advancedCount}`);
    console.log(`  Skipped  : ${alreadyAwareCount} (stage already beyond pre-aware)`);
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch((err) => {
  console.error("Backfill failed:", err);
  process.exit(1);
});
