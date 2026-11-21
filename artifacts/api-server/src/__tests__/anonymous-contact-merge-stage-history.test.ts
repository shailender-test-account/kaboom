/**
 * Integration test: anonymous contact merge preserves all stage history rows.
 *
 * WHY: When an anonymous shadow contact is merged into a known contact on
 * identification, `mergeAnonymousContact` in publicJourneys.ts must re-parent
 * every `contact_stage_history` row from the anonymous contact to the real
 * contact.  Without this step the timeline shows fewer transitions than
 * actually happened — any stage advances made while the visitor was anonymous
 * are silently dropped after identification.
 *
 * These tests call the REAL exported `mergeAnonymousContact` function against
 * the real DATABASE_URL (dev PostgreSQL) — no SQL is duplicated, no mocks
 * are used for the function under test.
 *
 * Test coverage:
 *   1. All stage history rows from the anonymous contact appear under the real
 *      contact after merge (basic re-parenting via the production function).
 *   2. Multiple intermediate stage advances made while anonymous are all
 *      preserved after identification (the key regression scenario).
 *   3. Any pre-existing stage history rows on the real contact are not touched.
 *   4. The anonymous contact is deleted after the merge completes.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { pool } from "@workspace/db";
import { mergeAnonymousContact } from "../routes/publicJourneys";

const TEST_TENANT_ID = 1; // seed tenant — guaranteed to exist

// ── Shared cleanup ─────────────────────────────────────────────────────────────
afterAll(async () => {
  await pool.end();
});

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Insert a contact_stage_history row directly (no activity_event_id required).
 * Returns the new row's id.
 */
async function insertStageHistory(
  tenantId: number,
  contactId: number,
  fromStage: string,
  toStage: string,
  scoreAtTransition: number,
  createdAtOffsetSeconds: number,
): Promise<number> {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO contact_stage_history
       (tenant_id, contact_id, from_stage, to_stage, score_at_transition, created_at)
     VALUES ($1, $2, $3, $4, $5, NOW() - ($6 * INTERVAL '1 second'))
     RETURNING id`,
    [tenantId, contactId, fromStage, toStage, scoreAtTransition, createdAtOffsetSeconds],
  );
  return rows[0].id;
}

// ── Suite ──────────────────────────────────────────────────────────────────────

describe("mergeAnonymousContact — contact_stage_history re-parenting", () => {
  let anonymousContactId: number;
  let realContactId: number;

  // Stage history IDs seeded on the anonymous contact (multiple intermediate
  // advances to cover the regression scenario)
  let anonHistoryIds: number[];

  // Stage history ID seeded on the real contact before the merge
  let realPreExistingHistoryId: number;

  beforeAll(async () => {
    // Create the anonymous shadow contact (mirrors getOrCreateAnonymousContact)
    const anonResult = await pool.query<{ id: number }>(
      `INSERT INTO contacts
         (tenant_id, first_name, last_name, tags, stage, source, is_anonymous, lead_score)
       VALUES ($1, 'Anonymous', 'Visitor', ARRAY[]::text[], 'pre-aware',
               'anonymous_tracking', TRUE, 15)
       RETURNING id`,
      [TEST_TENANT_ID],
    );
    anonymousContactId = anonResult.rows[0].id;

    // Create the real (known) contact that the visitor will be identified as
    const realResult = await pool.query<{ id: number }>(
      `INSERT INTO contacts
         (tenant_id, first_name, last_name, email, stage, lead_score, tags)
       VALUES ($1, 'MergeTest', 'RealContact', $2, 'pre-aware', 5, ARRAY[]::text[])
       RETURNING id`,
      [TEST_TENANT_ID, `merge-stage-test-${Date.now()}@__test__.invalid`],
    );
    realContactId = realResult.rows[0].id;

    // Seed multiple stage-history rows on the anonymous contact, simulating
    // three sequential page-view-driven stage advances before identification:
    //   pre-aware → aware          (first journey page view)
    //   aware     → pre-engage     (deeper page view)
    //   pre-engage → engage        (high-intent page view)
    const h1 = await insertStageHistory(TEST_TENANT_ID, anonymousContactId, "pre-aware",  "aware",      5,  300);
    const h2 = await insertStageHistory(TEST_TENANT_ID, anonymousContactId, "aware",      "pre-engage", 10, 200);
    const h3 = await insertStageHistory(TEST_TENANT_ID, anonymousContactId, "pre-engage", "engage",     15, 100);
    anonHistoryIds = [h1, h2, h3];

    // Seed one history row on the real contact BEFORE the merge — it must
    // remain untouched after the merge completes.
    realPreExistingHistoryId = await insertStageHistory(
      TEST_TENANT_ID, realContactId, "pre-aware", "aware", 5, 50,
    );
  });

  afterAll(async () => {
    // Collect all known history row IDs and delete them.  After the merge the
    // anonymous rows belong to realContactId, so deleting by id is safe.
    const allHistoryIds = [...(anonHistoryIds ?? []), realPreExistingHistoryId].filter(Boolean);
    if (allHistoryIds.length) {
      await pool.query(
        `DELETE FROM contact_stage_history WHERE id = ANY($1::int[])`,
        [allHistoryIds],
      );
    }

    // Delete contacts — anonymous may already be gone after the merge
    await pool.query(
      `DELETE FROM contacts WHERE id = ANY($1::int[]) AND tenant_id = $2`,
      [[anonymousContactId, realContactId].filter(Boolean), TEST_TENANT_ID],
    );
  });

  it("all stage history rows from the anonymous contact appear under the real contact after the production merge", async () => {
    // Sanity-check: before the merge the anonymous contact owns its 3 rows
    const { rows: beforeAnon } = await pool.query<{ cnt: string }>(
      `SELECT COUNT(*) AS cnt FROM contact_stage_history WHERE contact_id = $1`,
      [anonymousContactId],
    );
    expect(Number(beforeAnon[0].cnt)).toBe(3);

    // Call the REAL production function — no SQL reimplementation
    await mergeAnonymousContact(TEST_TENANT_ID, anonymousContactId, realContactId);

    // After merge: real contact owns the 3 re-parented rows + its own pre-existing row
    const { rows: afterReal } = await pool.query<{ id: number; from_stage: string; to_stage: string }>(
      `SELECT id, from_stage, to_stage
       FROM contact_stage_history
       WHERE contact_id = $1
       ORDER BY created_at ASC`,
      [realContactId],
    );
    expect(afterReal).toHaveLength(4); // 3 anonymous + 1 pre-existing

    // All three originally-anonymous rows must be present by ID
    const returnedIds = afterReal.map((r) => r.id);
    for (const histId of anonHistoryIds) {
      expect(returnedIds).toContain(histId);
    }

    // The pre-existing real-contact row must still be present
    expect(returnedIds).toContain(realPreExistingHistoryId);
  });

  it("all three intermediate stage advances made while anonymous are preserved (regression check)", async () => {
    // The anonymous contact had three sequential advances before identification:
    //   pre-aware → aware → pre-engage → engage
    // All must appear in the real contact's history after merge.
    const { rows } = await pool.query<{ from_stage: string; to_stage: string }>(
      `SELECT from_stage, to_stage
       FROM contact_stage_history
       WHERE id = ANY($1::int[])
       ORDER BY created_at ASC`,
      [anonHistoryIds],
    );

    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ from_stage: "pre-aware",  to_stage: "aware"      });
    expect(rows[1]).toMatchObject({ from_stage: "aware",      to_stage: "pre-engage" });
    expect(rows[2]).toMatchObject({ from_stage: "pre-engage", to_stage: "engage"     });
  });

  it("the anonymous contact no longer owns any stage history rows after the merge", async () => {
    const { rows } = await pool.query<{ cnt: string }>(
      `SELECT COUNT(*) AS cnt FROM contact_stage_history WHERE contact_id = $1`,
      [anonymousContactId],
    );
    expect(Number(rows[0].cnt)).toBe(0);
  });

  it("the anonymous shadow contact is deleted after the merge", async () => {
    const { rows } = await pool.query<{ id: number }>(
      `SELECT id FROM contacts WHERE id = $1 AND tenant_id = $2`,
      [anonymousContactId, TEST_TENANT_ID],
    );
    expect(rows).toHaveLength(0);
  });
});
