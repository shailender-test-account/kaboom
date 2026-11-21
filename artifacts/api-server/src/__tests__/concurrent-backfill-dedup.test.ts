/**
 * Concurrency integration test: two simultaneous `computeIntentScore` calls with
 * `source: 'backfill'` for the same contact+state transition+day must produce
 * exactly one `sequence_enrollment_skipped` row in activity_events.
 *
 * WHY: `persistIntentResult` uses a SELECT-then-INSERT pattern to guard against
 * duplicate `sequence_enrollment_skipped` events during non-live scoring runs.
 * Without a concurrency test this guarantee is invisible to the test suite.
 *
 * A partial unique index on activity_events (or ON CONFLICT DO NOTHING) is the
 * database-level fix. This test exercises that fix end-to-end so regressions are
 * caught before they ship.
 *
 * Uses the real DATABASE_URL (dev PostgreSQL) — no mocks.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { pool } from "@workspace/db";
import { computeIntentScore, SCORE_SOURCES } from "../lib/intentScoring";

const TEST_TENANT_ID = 1; // seed tenant — guaranteed to exist

afterAll(async () => {
  await pool.end();
});

describe("concurrent backfill scoring — no duplicate sequence_enrollment_skipped events", () => {
  let testContactId: number;

  beforeAll(async () => {
    // Create a contact with no intent_state so any computed state triggers a
    // transition (oldIntentState = null ≠ computed state).
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO contacts
         (tenant_id, first_name, last_name, email, stage, lead_score, tags, intent_state)
       VALUES ($1, 'BackfillConcurrency', 'Contact', $2, 'aware', 25, '{aware}', NULL)
       RETURNING id`,
      [TEST_TENANT_ID, `backfill-concurrency-${Date.now()}@__test__.invalid`],
    );
    testContactId = rows[0].id;

    // Insert activity events old enough to force a 'Dormant' intent state
    // (daysSinceLastEvent > 30 → intentState = 'Dormant', always ≠ NULL).
    // Two events on different days so distinctActiveDays = 2 (needed so the
    // frequency-breadth multiplier is non-trivial), both 35+ days in the past.
    await pool.query(
      `INSERT INTO activity_events
         (tenant_id, contact_id, event_type, description, stage, score_delta, created_at)
       VALUES
         ($1, $2, 'page_view', 'Test page view', 'aware', 5, NOW() - INTERVAL '36 days'),
         ($1, $2, 'page_view', 'Test page view', 'aware', 5, NOW() - INTERVAL '35 days')`,
      [TEST_TENANT_ID, testContactId],
    );
  });

  afterAll(async () => {
    if (testContactId) {
      await pool.query(
        `DELETE FROM contact_stage_history WHERE contact_id = $1`,
        [testContactId],
      );
      await pool.query(
        `DELETE FROM activity_events WHERE contact_id = $1`,
        [testContactId],
      );
      await pool.query(
        `DELETE FROM contacts WHERE id = $1`,
        [testContactId],
      );
    }
  });

  it("produces exactly one sequence_enrollment_skipped row when two backfill runs fire simultaneously", async () => {
    // Fire two concurrent backfill scoring calls for the same contact.
    // Both will compute 'Dormant' (events are >30 days old), read intent_state=NULL
    // from the contacts row, detect a transition, and race to insert the
    // sequence_enrollment_skipped event.
    //
    // The partial unique index (or ON CONFLICT DO NOTHING) must ensure only one
    // row lands in activity_events regardless of which call wins the race.
    const [r1, r2] = await Promise.all([
      computeIntentScore(testContactId, TEST_TENANT_ID, { source: SCORE_SOURCES.BACKFILL }),
      computeIntentScore(testContactId, TEST_TENANT_ID, { source: SCORE_SOURCES.BACKFILL }),
    ]);

    // Both calls must agree on the computed intent state.
    expect(r1.intentState).toBe("Dormant");
    expect(r2.intentState).toBe("Dormant");

    // At least one call must have recorded that routing rules were suppressed.
    // (The second call may or may not flag suppression depending on read order.)
    expect(r1.routingRulesSuppressed || r2.routingRulesSuppressed).toBe(true);

    // ── Core assertion: exactly one sequence_enrollment_skipped row ──────────
    const { rows } = await pool.query<{ cnt: string }>(
      `SELECT COUNT(*) AS cnt
         FROM activity_events
        WHERE contact_id = $1
          AND tenant_id  = $2
          AND event_type = 'sequence_enrollment_skipped'
          AND source     = $3
          AND date_trunc('day', created_at AT TIME ZONE 'UTC')
                = date_trunc('day', NOW() AT TIME ZONE 'UTC')`,
      [testContactId, TEST_TENANT_ID, SCORE_SOURCES.BACKFILL],
    );
    expect(Number(rows[0].cnt)).toBe(1);
  });

  it("unique index + ON CONFLICT DO NOTHING prevents a duplicate insert at the database level", async () => {
    // This test exercises the partial unique index directly via raw SQL, bypassing
    // application code entirely. It proves the database-level fix works independent
    // of any SELECT check timing.
    //
    // After the first test there is already one sequence_enrollment_skipped row
    // for this contact+source+'Dormant'+today. Attempting a second INSERT with
    // identical key values must produce 0 new rows (ON CONFLICT DO NOTHING).
    const dupInsert = `
      INSERT INTO activity_events
        (tenant_id, contact_id, event_type, description, source, score_delta, created_at, metadata)
      VALUES ($1, $2, 'sequence_enrollment_skipped',
              'Duplicate dedup test row', $3, 0, NOW(),
              '{"reason":"backfill_suppressed","old_intent_state":null,"new_intent_state":"Dormant"}'::jsonb)
      ON CONFLICT DO NOTHING
    `;

    // Fire two concurrent duplicate INSERTs — neither should land because the
    // unique index key (tenant_id, contact_id, source, new_intent_state, day)
    // already exists from the first test.
    const [ins1, ins2] = await Promise.all([
      pool.query(dupInsert, [TEST_TENANT_ID, testContactId, SCORE_SOURCES.BACKFILL]),
      pool.query(dupInsert, [TEST_TENANT_ID, testContactId, SCORE_SOURCES.BACKFILL]),
    ]);

    expect(ins1.rowCount ?? 0).toBe(0);
    expect(ins2.rowCount ?? 0).toBe(0);

    // Total count must still be exactly one — the row from the first test.
    const { rows } = await pool.query<{ cnt: string }>(
      `SELECT COUNT(*) AS cnt
         FROM activity_events
        WHERE contact_id = $1
          AND tenant_id  = $2
          AND event_type = 'sequence_enrollment_skipped'
          AND source     = $3
          AND date_trunc('day', created_at AT TIME ZONE 'UTC')
                = date_trunc('day', NOW() AT TIME ZONE 'UTC')`,
      [testContactId, TEST_TENANT_ID, SCORE_SOURCES.BACKFILL],
    );
    expect(Number(rows[0].cnt)).toBe(1);
  });
});
