/**
 * Concurrency integration tests: two simultaneous atomic CTEs on the same
 * contact must produce exactly one contact_stage_history row.
 *
 * WHY: Two code paths both call an atomic CTE to advance a contact's stage:
 *
 *   Path A — advanceStageInDB (publicJourneys.ts): guards on
 *             `NOT ($3 = ANY(COALESCE(tags, '{}')))` — tag must not already exist.
 *
 *   Path B — email-webhook.ts: guards on
 *             `COALESCE(stage, 'pre-aware') = 'pre-aware'` — stage column value.
 *
 * Without a real-DB test the CTE atomicity guarantee is invisible to the test suite.
 * These tests use the real DATABASE_URL (dev PostgreSQL) — no mocks — so the
 * CTE atomicity is exercised end-to-end at the database level.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { pool } from "@workspace/db";
import { mergeAnonymousContact, advanceStageInDB } from "../routes/publicJourneys";

const TEST_TENANT_ID = 1; // seed tenant — guaranteed to exist

// ── Shared cleanup: close the pool after all suites finish ────────────────────
afterAll(async () => {
  await pool.end();
});

// ── Path B: email-webhook stage column guard ──────────────────────────────────

/**
 * The atomic CTE used in email-webhook.ts (Path B).
 *
 * Key invariant: the UPDATE filters on `COALESCE(stage, 'pre-aware') = 'pre-aware'`
 * so that once one connection wins the row-level lock and sets stage='aware', the
 * second concurrent execution finds no matching row and inserts nothing.
 */
const ADVANCE_TO_AWARE_CTE = `
  WITH advanced AS (
    UPDATE contacts
    SET stage = 'aware',
        tags  = CASE WHEN 'aware' = ANY(COALESCE(tags, '{}')) THEN tags
                     ELSE array_append(COALESCE(tags, '{}'), 'aware') END
    WHERE id = $2 AND tenant_id = $1
      AND COALESCE(stage, 'pre-aware') = 'pre-aware'
      AND NOT ('aware' = ANY(COALESCE(tags, '{}')))
    RETURNING id, tenant_id, lead_score
  )
  INSERT INTO contact_stage_history
    (tenant_id, contact_id, from_stage, to_stage, score_at_transition, created_at)
  SELECT tenant_id, id, 'pre-aware', 'aware', lead_score, NOW()
  FROM advanced
`;

describe("Path B — email-webhook: concurrent stage advancement — atomic CTE prevents duplicate history rows", () => {
  let testContactId: number;

  beforeAll(async () => {
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO contacts
         (tenant_id, first_name, last_name, email, stage, lead_score, tags)
       VALUES ($1, 'ConcurrencyTest', 'Contact', $2, 'pre-aware', 20, '{}')
       RETURNING id`,
      [TEST_TENANT_ID, `concurrency-test-${Date.now()}@__test__.invalid`]
    );
    testContactId = rows[0].id;
  });

  afterAll(async () => {
    if (testContactId) {
      await pool.query(
        `DELETE FROM contact_stage_history WHERE contact_id = $1`,
        [testContactId]
      );
      await pool.query(
        `DELETE FROM activity_events WHERE contact_id = $1`,
        [testContactId]
      );
      await pool.query(
        `DELETE FROM contacts WHERE id = $1`,
        [testContactId]
      );
    }
  });

  it("produces exactly one contact_stage_history row when the CTE fires twice concurrently", async () => {
    // Simulate two simultaneous email click events (e.g. Resend webhook fires twice,
    // or two browser tabs click an email link at the same instant).
    // Promise.all submits both queries to PostgreSQL without waiting for either
    // to complete first — this is the race condition the atomic CTE is designed to win.
    const [r1, r2] = await Promise.all([
      pool.query(ADVANCE_TO_AWARE_CTE, [TEST_TENANT_ID, testContactId]),
      pool.query(ADVANCE_TO_AWARE_CTE, [TEST_TENANT_ID, testContactId]),
    ]);

    // Exactly one execution must have advanced the stage (rowCount=1);
    // the other found no matching 'pre-aware' row and inserted nothing (rowCount=0).
    const totalInserted = (r1.rowCount ?? 0) + (r2.rowCount ?? 0);
    expect(totalInserted).toBe(1);

    // Confirm the database reflects exactly one history row — not two.
    const { rows: histRows } = await pool.query<{ cnt: string }>(
      `SELECT COUNT(*) AS cnt FROM contact_stage_history WHERE contact_id = $1`,
      [testContactId]
    );
    expect(Number(histRows[0].cnt)).toBe(1);

    // The contact stage must be 'aware', not stuck at 'pre-aware'.
    const { rows: contactRows } = await pool.query<{ stage: string }>(
      `SELECT stage FROM contacts WHERE id = $1`,
      [testContactId]
    );
    expect(contactRows[0].stage).toBe("aware");
  });

  it("is idempotent — re-running the CTE on an already-aware contact inserts zero rows", async () => {
    // After the first test the contact is already 'aware'.
    // A third (or nth) concurrent click must not produce another history row.
    const [r1, r2] = await Promise.all([
      pool.query(ADVANCE_TO_AWARE_CTE, [TEST_TENANT_ID, testContactId]),
      pool.query(ADVANCE_TO_AWARE_CTE, [TEST_TENANT_ID, testContactId]),
    ]);

    const totalInserted = (r1.rowCount ?? 0) + (r2.rowCount ?? 0);
    expect(totalInserted).toBe(0);

    // History count must still be exactly one — no new rows added.
    const { rows: histRows } = await pool.query<{ cnt: string }>(
      `SELECT COUNT(*) AS cnt FROM contact_stage_history WHERE contact_id = $1`,
      [testContactId]
    );
    expect(Number(histRows[0].cnt)).toBe(1);
  });
});

// ── Path A: advanceStageInDB (page-view) tag-presence guard ──────────────────

/**
 * The atomic CTE used in advanceStageInDB (publicJourneys.ts, Path A).
 *
 * Key invariant: the UPDATE filters on `NOT ($3 = ANY(COALESCE(tags, '{}')))`.
 * Once one connection wins the row-level lock and appends the stage tag,
 * the second concurrent execution finds the tag already present, matches
 * 0 rows, and inserts nothing into contact_stage_history.
 *
 * Parameters: $1=contactId, $2=tenantId, $3=stage, $4=fromStage,
 *             $5=scoreAtTransition, $6=activityEventId
 */
const ADVANCE_STAGE_PAGE_VIEW_CTE = `
  WITH advanced AS (
    UPDATE contacts
    SET tags = array_append(COALESCE(tags, '{}'), $3)
    WHERE id = $1 AND tenant_id = $2
      AND NOT ($3 = ANY(COALESCE(tags, '{}')))
    RETURNING id, tenant_id
  )
  INSERT INTO contact_stage_history
    (tenant_id, contact_id, from_stage, to_stage, score_at_transition, activity_event_id, created_at)
  SELECT tenant_id, id, $4, $3, $5, $6, NOW()
  FROM advanced
`;

describe("Path A — page-view advanceStageInDB: concurrent stage advancement — atomic CTE prevents duplicate history rows", () => {
  let testContactId: number;

  beforeAll(async () => {
    // Create a fresh contact in 'pre-aware' state with no tags — mirrors the
    // state a contact is in the first time they view a stage-tagged journey page.
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO contacts
         (tenant_id, first_name, last_name, email, stage, lead_score, tags)
       VALUES ($1, 'PageViewConcurrency', 'Contact', $2, 'pre-aware', 30, '{}')
       RETURNING id`,
      [TEST_TENANT_ID, `pageview-concurrency-${Date.now()}@__test__.invalid`]
    );
    testContactId = rows[0].id;
  });

  afterAll(async () => {
    if (testContactId) {
      await pool.query(
        `DELETE FROM contact_stage_history WHERE contact_id = $1`,
        [testContactId]
      );
      await pool.query(
        `DELETE FROM activity_events WHERE contact_id = $1`,
        [testContactId]
      );
      await pool.query(
        `DELETE FROM contacts WHERE id = $1`,
        [testContactId]
      );
    }
  });

  it("produces exactly one contact_stage_history row when the same page is viewed twice simultaneously", async () => {
    // Simulate two concurrent page-view requests for the same contact hitting
    // a stage-tagged journey page (e.g. a page tagged 'aware').
    // Promise.all dispatches both without waiting — exercising the real
    // tag-presence guard at the PostgreSQL level.
    const [r1, r2] = await Promise.all([
      pool.query(ADVANCE_STAGE_PAGE_VIEW_CTE, [
        testContactId, TEST_TENANT_ID, "aware", "pre-aware", 30, null,
      ]),
      pool.query(ADVANCE_STAGE_PAGE_VIEW_CTE, [
        testContactId, TEST_TENANT_ID, "aware", "pre-aware", 30, null,
      ]),
    ]);

    // Exactly one of the two concurrent executions must have appended the tag
    // (rowCount=1); the other found 'aware' already present and inserted nothing.
    const totalInserted = (r1.rowCount ?? 0) + (r2.rowCount ?? 0);
    expect(totalInserted).toBe(1);

    // The database must contain exactly one history row for this contact.
    const { rows: histRows } = await pool.query<{ cnt: string }>(
      `SELECT COUNT(*) AS cnt FROM contact_stage_history WHERE contact_id = $1`,
      [testContactId]
    );
    expect(Number(histRows[0].cnt)).toBe(1);

    // The contact must have exactly one 'aware' tag entry (not duplicated).
    const { rows: contactRows } = await pool.query<{ tags: string[] }>(
      `SELECT tags FROM contacts WHERE id = $1`,
      [testContactId]
    );
    const awareTags = (contactRows[0].tags ?? []).filter((t) => t === "aware");
    expect(awareTags).toHaveLength(1);
  });

  it("is idempotent — a third page view on an already-tagged contact inserts zero rows", async () => {
    // The contact now has 'aware' in their tags. Viewing the same stage-tagged
    // page again (or a retry) must not produce an additional history row.
    const [r1, r2] = await Promise.all([
      pool.query(ADVANCE_STAGE_PAGE_VIEW_CTE, [
        testContactId, TEST_TENANT_ID, "aware", "pre-aware", 30, null,
      ]),
      pool.query(ADVANCE_STAGE_PAGE_VIEW_CTE, [
        testContactId, TEST_TENANT_ID, "aware", "pre-aware", 30, null,
      ]),
    ]);

    const totalInserted = (r1.rowCount ?? 0) + (r2.rowCount ?? 0);
    expect(totalInserted).toBe(0);

    // History count must still be exactly one — no new rows added.
    const { rows: histRows } = await pool.query<{ cnt: string }>(
      `SELECT COUNT(*) AS cnt FROM contact_stage_history WHERE contact_id = $1`,
      [testContactId]
    );
    expect(Number(histRows[0].cnt)).toBe(1);
  });
});

// ── Path A: multi-step concurrent advancement (pre-aware → engage) ────────────

/**
 * Replicates the advanceStageInDB loop for a fixed target of 'engage',
 * which requires three atomic CTE executions in sequence:
 *   pre-aware → aware → pre-engage → engage
 *
 * Under concurrent load two requests can interleave across loop iterations.
 * The tag-presence guard in the CTE ensures each step is idempotent:
 * whichever request appends the tag first wins; the other inserts 0 rows.
 *
 * Expected total contact_stage_history rows = 3 (one per intermediate stage).
 */
async function runMultiStepAdvancement(
  contactId: number,
  tenantId: number,
  scoreAtTransition: number,
): Promise<void> {
  // Mirrors the stagesToAdd loop inside advanceStageInDB for
  // pre-aware → engage: ["aware", "pre-engage", "engage"]
  const stages = ["aware", "pre-engage", "engage"];
  const fromStages = ["pre-aware", "aware", "pre-engage"];

  for (let i = 0; i < stages.length; i++) {
    const stage = stages[i]!;
    const fromStage = fromStages[i]!;
    await pool
      .query(
        `WITH advanced AS (
           UPDATE contacts
           SET tags = array_append(COALESCE(tags, '{}'), $3)
           WHERE id = $1 AND tenant_id = $2
             AND NOT ($3 = ANY(COALESCE(tags, '{}')))
           RETURNING id, tenant_id
         )
         INSERT INTO contact_stage_history
           (tenant_id, contact_id, from_stage, to_stage, score_at_transition, activity_event_id, created_at)
         SELECT tenant_id, id, $4, $3, $5, NULL, NOW()
         FROM advanced`,
        [contactId, tenantId, stage, fromStage, scoreAtTransition],
      )
      .catch(() => {});
  }

  // Mirror the final stage column UPDATE from advanceStageInDB
  await pool
    .query(
      `UPDATE contacts SET stage = 'engage'
       WHERE id = $1 AND tenant_id = $2
         AND CASE COALESCE(stage, 'pre-aware')
               WHEN 'action'         THEN 5
               WHEN 'advance-engage' THEN 4
               WHEN 'engage'         THEN 3
               WHEN 'pre-engage'     THEN 2
               WHEN 'aware'          THEN 1
               ELSE 0 END < 3`,
      [contactId, tenantId],
    )
    .catch(() => {});
}

describe("Path A — multi-step: two concurrent advancements from pre-aware to engage produce no duplicate history rows", () => {
  let testContactId: number;

  beforeAll(async () => {
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO contacts
         (tenant_id, first_name, last_name, email, stage, lead_score, tags)
       VALUES ($1, 'MultiStepConcurrency', 'Contact', $2, 'pre-aware', 40, '{}')
       RETURNING id`,
      [TEST_TENANT_ID, `multi-step-concurrency-${Date.now()}@__test__.invalid`],
    );
    testContactId = rows[0].id;
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

  it("produces exactly 3 contact_stage_history rows (one per intermediate stage) when two advancements to 'engage' fire simultaneously", async () => {
    // Two concurrent multi-step advancements: each walks pre-aware → aware →
    // pre-engage → engage in a loop. Promise.all dispatches both without
    // waiting so their CTE executions can interleave at the DB level.
    await Promise.all([
      runMultiStepAdvancement(testContactId, TEST_TENANT_ID, 40),
      runMultiStepAdvancement(testContactId, TEST_TENANT_ID, 40),
    ]);

    // The contact must have reached 'engage' (not stuck at an intermediate stage).
    const { rows: contactRows } = await pool.query<{
      stage: string;
      tags: string[];
    }>(
      `SELECT stage, tags FROM contacts WHERE id = $1`,
      [testContactId],
    );
    expect(contactRows[0].stage).toBe("engage");

    // Each of the three intermediate stages must appear exactly once in tags.
    const tags: string[] = contactRows[0].tags ?? [];
    for (const s of ["aware", "pre-engage", "engage"]) {
      expect(tags.filter((t) => t === s)).toHaveLength(1);
    }

    // Exactly 3 history rows — one per stage transition, no duplicates.
    const { rows: histRows } = await pool.query<{ cnt: string }>(
      `SELECT COUNT(*) AS cnt FROM contact_stage_history WHERE contact_id = $1`,
      [testContactId],
    );
    expect(Number(histRows[0].cnt)).toBe(3);
  });

  it("is idempotent — re-running the advancement on an already-at-engage contact inserts zero new rows", async () => {
    // Contact is already at 'engage' with all three stage tags. Another
    // concurrent pair of advancement calls must not produce extra history rows.
    await Promise.all([
      runMultiStepAdvancement(testContactId, TEST_TENANT_ID, 40),
      runMultiStepAdvancement(testContactId, TEST_TENANT_ID, 40),
    ]);

    const { rows: histRows } = await pool.query<{ cnt: string }>(
      `SELECT COUNT(*) AS cnt FROM contact_stage_history WHERE contact_id = $1`,
      [testContactId],
    );
    // Still exactly 3 — no new rows inserted.
    expect(Number(histRows[0].cnt)).toBe(3);
  });
});

// ── Path A: loop restart from mid-chain contact (regression guard) ────────────

/**
 * Replicates what happens when a server restart or a duplicate page-view event
 * causes advanceStageInDB to be called again for a contact that is already
 * partway through a staged advancement.
 *
 * The contact starts at "aware" (already has the "aware" tag).
 * The advancement targets "engage", so the expected loop steps are:
 *   ["pre-engage", "engage"]  — "aware" must not be re-added.
 *
 * Expected contact_stage_history rows = 2 (pre-engage + engage only).
 * Expected tags: ["aware", "pre-engage", "engage"] — each exactly once.
 */
describe("Path A — mid-chain restart: loop restarted from 'aware' targeting 'engage' produces no duplicate tags or history rows", () => {
  let testContactId: number;

  beforeAll(async () => {
    // Contact is already at 'aware' — simulates a contact who was partially
    // advanced before a server restart or duplicate event.
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO contacts
         (tenant_id, first_name, last_name, email, stage, lead_score, tags)
       VALUES ($1, 'MidChainRestart', 'Contact', $2, 'aware', 35, ARRAY['aware'])
       RETURNING id`,
      [TEST_TENANT_ID, `mid-chain-restart-${Date.now()}@__test__.invalid`],
    );
    testContactId = rows[0].id;
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

  it("does not duplicate the 'aware' tag or add a spurious history row when the loop restarts from a mid-chain contact", async () => {
    // Simulate advanceStageInDB walking pre-engage → engage for a contact that
    // already has 'aware'. The CTE tag-presence guard must skip 'aware' entirely.
    const stages = ["pre-engage", "engage"];
    const fromStages = ["aware", "pre-engage"];

    for (let i = 0; i < stages.length; i++) {
      await pool.query(
        `WITH advanced AS (
           UPDATE contacts
           SET tags = array_append(COALESCE(tags, '{}'), $3)
           WHERE id = $1 AND tenant_id = $2
             AND NOT ($3 = ANY(COALESCE(tags, '{}')))
           RETURNING id, tenant_id
         )
         INSERT INTO contact_stage_history
           (tenant_id, contact_id, from_stage, to_stage, score_at_transition, activity_event_id, created_at)
         SELECT tenant_id, id, $4, $3, $5, NULL, NOW()
         FROM advanced`,
        [testContactId, TEST_TENANT_ID, stages[i], fromStages[i], 35],
      );
    }

    // Final stage column update
    await pool.query(
      `UPDATE contacts SET stage = 'engage'
       WHERE id = $1 AND tenant_id = $2
         AND CASE COALESCE(stage, 'pre-aware')
               WHEN 'action'         THEN 5
               WHEN 'advance-engage' THEN 4
               WHEN 'engage'         THEN 3
               WHEN 'pre-engage'     THEN 2
               WHEN 'aware'          THEN 1
               ELSE 0 END < 3`,
      [testContactId, TEST_TENANT_ID],
    );

    // Exactly 2 history rows (pre-engage + engage); NOT 3 — 'aware' was already present.
    const { rows: histRows } = await pool.query<{ cnt: string }>(
      `SELECT COUNT(*) AS cnt FROM contact_stage_history WHERE contact_id = $1`,
      [testContactId],
    );
    expect(Number(histRows[0].cnt)).toBe(2);

    // Tags must each appear exactly once — no 'aware' duplicate.
    const { rows: contactRows } = await pool.query<{ tags: string[]; stage: string }>(
      `SELECT tags, stage FROM contacts WHERE id = $1`,
      [testContactId],
    );
    const tags: string[] = contactRows[0].tags ?? [];
    for (const s of ["aware", "pre-engage", "engage"]) {
      expect(tags.filter((t) => t === s)).toHaveLength(1);
    }
    expect(contactRows[0].stage).toBe("engage");
  });

  it("is idempotent — re-running the same loop steps on an already-at-engage contact inserts zero new rows", async () => {
    // The contact is now at 'engage'. Restarting the loop again (e.g. a duplicate
    // event or server restart) must not add any new tags or history rows.
    const stages = ["pre-engage", "engage"];
    const fromStages = ["aware", "pre-engage"];

    for (let i = 0; i < stages.length; i++) {
      await pool.query(
        `WITH advanced AS (
           UPDATE contacts
           SET tags = array_append(COALESCE(tags, '{}'), $3)
           WHERE id = $1 AND tenant_id = $2
             AND NOT ($3 = ANY(COALESCE(tags, '{}')))
           RETURNING id, tenant_id
         )
         INSERT INTO contact_stage_history
           (tenant_id, contact_id, from_stage, to_stage, score_at_transition, activity_event_id, created_at)
         SELECT tenant_id, id, $4, $3, $5, NULL, NOW()
         FROM advanced`,
        [testContactId, TEST_TENANT_ID, stages[i], fromStages[i], 35],
      );
    }

    // Still exactly 2 history rows — no new rows.
    const { rows: histRows } = await pool.query<{ cnt: string }>(
      `SELECT COUNT(*) AS cnt FROM contact_stage_history WHERE contact_id = $1`,
      [testContactId],
    );
    expect(Number(histRows[0].cnt)).toBe(2);

    // Tags still each appear exactly once.
    const { rows: contactRows } = await pool.query<{ tags: string[] }>(
      `SELECT tags FROM contacts WHERE id = $1`,
      [testContactId],
    );
    const tags: string[] = contactRows[0].tags ?? [];
    for (const s of ["aware", "pre-engage", "engage"]) {
      expect(tags.filter((t) => t === s)).toHaveLength(1);
    }
  });
});

// ── Cross-path race: Path B (email-webhook) vs Path A (page-view) ────────────
//
// Production guard after fix
// ──────────────────────────
// Path A (advanceStageInDB CTE loop body):
//   guards on `NOT ($stage = ANY(COALESCE(tags, '{}')))` — tag array only.
//   Does NOT update the stage column inside the CTE; stage column is set in
//   a separate final UPDATE after the loop completes.
//
// Path B (email-webhook CTE, FIXED):
//   guards on BOTH `COALESCE(stage, 'pre-aware') = 'pre-aware'`
//              AND `NOT ('aware' = ANY(COALESCE(tags, '{}')))` — tag array.
//
// With both paths keying off the tag array, whichever CTE appends 'aware'
// first acquires the PostgreSQL row lock and wins. The second CTE, in either
// ordering, finds the tag already present and matches 0 rows → 0 history rows.
//
// Result: exactly 1 contact_stage_history row regardless of which path wins.

/**
 * Path B CTE as it appears in email-webhook.ts after the cross-path guard fix.
 * Must be kept in sync with the production query when either changes.
 */
const PATH_B_ADVANCE_TO_AWARE_FIXED = `
  WITH advanced AS (
    UPDATE contacts
    SET stage = 'aware',
        tags  = CASE WHEN 'aware' = ANY(COALESCE(tags, '{}')) THEN tags
                     ELSE array_append(COALESCE(tags, '{}'), 'aware') END
    WHERE id = $2 AND tenant_id = $1
      AND COALESCE(stage, 'pre-aware') = 'pre-aware'
      AND NOT ('aware' = ANY(COALESCE(tags, '{}')))
    RETURNING id, tenant_id, lead_score
  )
  INSERT INTO contact_stage_history
    (tenant_id, contact_id, from_stage, to_stage, score_at_transition, created_at)
  SELECT tenant_id, id, 'pre-aware', 'aware', lead_score, NOW()
  FROM advanced
`;

describe("Cross-path concurrency — Path B (email-webhook) + Path A (advanceStageInDB) simultaneously advance to 'aware'", () => {
  // ── helpers ────────────────────────────────────────────────────────────────

  async function makeCrossPathContact(label: string): Promise<number> {
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO contacts
         (tenant_id, first_name, last_name, email, stage, lead_score, tags)
       VALUES ($1, 'CrossPath', $2, $3, 'pre-aware', 25, '{}')
       RETURNING id`,
      [TEST_TENANT_ID, label, `cross-path-${label}-${Date.now()}@__test__.invalid`],
    );
    return rows[0]!.id;
  }

  async function cleanupCrossPathContact(id: number): Promise<void> {
    await pool.query(`DELETE FROM contact_stage_history WHERE contact_id = $1`, [id]).catch(() => {});
    await pool.query(`DELETE FROM activity_events WHERE contact_id = $1`, [id]).catch(() => {});
    await pool.query(`DELETE FROM contacts WHERE id = $1`, [id]).catch(() => {});
  }

  // ── Ordering 1 (B → A): Path B runs first ─────────────────────────────────
  //
  // Path B CTE:
  //   stage='pre-aware', tag not present → both guards pass.
  //   Sets stage='aware', appends tag, inserts 1 history row.
  //
  // advanceStageInDB (Path A) runs after:
  //   fetches current state (tag 'aware' now present).
  //   computeSequentialStageAdvancement returns stagesToAdd=[] → exits early.
  //   Inserts 0 history rows.
  //
  // Expected: exactly 1 history row, stage='aware', one 'aware' tag.

  it("Ordering 1 (B→A sequential): Path B first → exactly 1 history row, consistent final state", async () => {
    const contactId = await makeCrossPathContact("B-then-A");
    try {
      await pool.query(PATH_B_ADVANCE_TO_AWARE_FIXED, [TEST_TENANT_ID, contactId]);
      await advanceStageInDB(contactId, TEST_TENANT_ID, "aware");

      const { rows: hist } = await pool.query<{ cnt: string }>(
        `SELECT COUNT(*) AS cnt FROM contact_stage_history WHERE contact_id = $1`,
        [contactId],
      );
      expect(Number(hist[0].cnt)).toBe(1);

      const { rows: contact } = await pool.query<{ stage: string; tags: string[] }>(
        `SELECT stage, tags FROM contacts WHERE id = $1`,
        [contactId],
      );
      expect(contact[0].stage).toBe("aware");
      expect((contact[0].tags ?? []).filter((t) => t === "aware")).toHaveLength(1);
    } finally {
      await cleanupCrossPathContact(contactId);
    }
  });

  // ── Ordering 2 (A → B): Path A runs first ─────────────────────────────────
  //
  // advanceStageInDB (Path A) runs first:
  //   tag not present → CTE appends 'aware', inserts 1 history row.
  //   Final UPDATE sets stage column to 'aware'.
  //
  // Path B CTE runs after:
  //   stage='aware' → COALESCE guard fails (stage is no longer 'pre-aware').
  //   tag 'aware' present → tag guard also fails.
  //   Matches 0 rows → inserts 0 history rows.
  //
  // Expected: exactly 1 history row, stage='aware', one 'aware' tag.

  it("Ordering 2 (A→B sequential): Path A (advanceStageInDB) first → exactly 1 history row, consistent final state", async () => {
    const contactId = await makeCrossPathContact("A-then-B");
    try {
      await advanceStageInDB(contactId, TEST_TENANT_ID, "aware");
      const { rowCount: rB } = await pool.query(
        PATH_B_ADVANCE_TO_AWARE_FIXED,
        [TEST_TENANT_ID, contactId],
      );

      // Path B must have been blocked by the tag guard — 0 rows inserted.
      expect(rB ?? 0).toBe(0);

      const { rows: hist } = await pool.query<{ cnt: string }>(
        `SELECT COUNT(*) AS cnt FROM contact_stage_history WHERE contact_id = $1`,
        [contactId],
      );
      expect(Number(hist[0].cnt)).toBe(1);

      const { rows: contact } = await pool.query<{ stage: string; tags: string[] }>(
        `SELECT stage, tags FROM contacts WHERE id = $1`,
        [contactId],
      );
      expect(contact[0].stage).toBe("aware");
      expect((contact[0].tags ?? []).filter((t) => t === "aware")).toHaveLength(1);
    } finally {
      await cleanupCrossPathContact(contactId);
    }
  });

  // ── Ordering 3 (concurrent): Promise.all ──────────────────────────────────
  //
  // Both paths submit their UPDATE to PostgreSQL without waiting for the other.
  // PostgreSQL serialises the two UPDATEs at the row level; only two orderings
  // are possible (whichever acquires the row lock first):
  //
  //   Path B wins the lock:
  //     Path B appends tag + sets stage. Path A's CTE then finds tag present → 0 rows.
  //     advanceStageInDB's initial SELECT sees the tag and returns early.
  //     → 1 history row total.
  //
  //   Path A wins the lock (CTE):
  //     Path A appends tag. Path B's CTE then finds tag present (tag guard) → 0 rows.
  //     Path A's subsequent final-stage UPDATE sets stage='aware'.
  //     → 1 history row total.
  //
  // With the shared tag guard the result is exactly 1 in both orderings.

  it("Ordering 3 (concurrent Promise.all): exactly 1 history row regardless of which path wins the lock", async () => {
    const contactId = await makeCrossPathContact("concurrent");
    try {
      await Promise.all([
        advanceStageInDB(contactId, TEST_TENANT_ID, "aware"),
        pool.query(PATH_B_ADVANCE_TO_AWARE_FIXED, [TEST_TENANT_ID, contactId]),
      ]);

      const { rows: hist } = await pool.query<{ cnt: string }>(
        `SELECT COUNT(*) AS cnt FROM contact_stage_history WHERE contact_id = $1`,
        [contactId],
      );
      expect(Number(hist[0].cnt)).toBe(1);

      const { rows: contact } = await pool.query<{ stage: string; tags: string[] }>(
        `SELECT stage, tags FROM contacts WHERE id = $1`,
        [contactId],
      );
      expect(contact[0].stage).toBe("aware");
      expect((contact[0].tags ?? []).filter((t) => t === "aware")).toHaveLength(1);
    } finally {
      await cleanupCrossPathContact(contactId);
    }
  });

  // ── Idempotency: both paths re-run on an already-aware contact ─────────────
  //
  // Once the contact is at 'aware' (stage='aware', tag='aware' in array),
  // any subsequent call from either path must insert zero new history rows.

  it("Idempotency: both paths re-running on an already-aware contact insert zero new rows", async () => {
    const contactId = await makeCrossPathContact("idempotent");
    try {
      // Bring the contact to 'aware' via Path A (clean, single-row state).
      await advanceStageInDB(contactId, TEST_TENANT_ID, "aware");

      // Both paths re-run concurrently against the now-aware contact.
      await Promise.all([
        advanceStageInDB(contactId, TEST_TENANT_ID, "aware"),
        pool.query(PATH_B_ADVANCE_TO_AWARE_FIXED, [TEST_TENANT_ID, contactId]),
      ]);

      const { rows: hist } = await pool.query<{ cnt: string }>(
        `SELECT COUNT(*) AS cnt FROM contact_stage_history WHERE contact_id = $1`,
        [contactId],
      );
      expect(Number(hist[0].cnt)).toBe(1);

      const { rows: contact } = await pool.query<{ stage: string; tags: string[] }>(
        `SELECT stage, tags FROM contacts WHERE id = $1`,
        [contactId],
      );
      expect(contact[0].stage).toBe("aware");
      expect((contact[0].tags ?? []).filter((t) => t === "aware")).toHaveLength(1);
    } finally {
      await cleanupCrossPathContact(contactId);
    }
  });
});

// ── Concurrent merge + stage advancement race ─────────────────────────────────
//
// These tests exercise the production code paths directly:
//   - advanceStageInDB (exported from publicJourneys.ts) — the real helper
//   - mergeAnonymousContact (exported from publicJourneys.ts) — wrapped in a
//     serializable transaction with SELECT … FOR UPDATE to prevent orphaned
//     contact_stage_history rows.
//
// Three orderings are tested deterministically using sequential awaits (not
// just Promise.all) to guarantee each interleaving is actually exercised.
//
// For each test we create fresh contacts so state never bleeds between cases.
//
// Helper: create a real + shadow contact pair and return their IDs.
async function makeContactPair(label: string): Promise<{ realId: number; shadowId: number }> {
  const ts = Date.now();
  const { rows: r } = await pool.query<{ id: number }>(
    `INSERT INTO contacts
       (tenant_id, first_name, last_name, email, stage, lead_score, tags)
     VALUES ($1, 'Real', $2, $3, 'pre-aware', 50, '{}')
     RETURNING id`,
    [TEST_TENANT_ID, label, `${label}-real-${ts}@__test__.invalid`],
  );
  const { rows: s } = await pool.query<{ id: number }>(
    `INSERT INTO contacts
       (tenant_id, first_name, last_name, stage, lead_score, tags, is_anonymous)
     VALUES ($1, 'Shadow', $2, 'pre-aware', 10, '{}', TRUE)
     RETURNING id`,
    [TEST_TENANT_ID, label],
  );
  return { realId: r[0]!.id, shadowId: s[0]!.id };
}

// Helper: clean up a contact pair (shadow may already be deleted by merge).
async function cleanupContactPair(realId: number, shadowId: number): Promise<void> {
  await pool.query(
    `DELETE FROM contact_stage_history WHERE contact_id IN ($1, $2)`,
    [realId, shadowId],
  ).catch(() => {});
  await pool.query(
    `DELETE FROM activity_events WHERE contact_id IN ($1, $2)`,
    [realId, shadowId],
  ).catch(() => {});
  await pool.query(
    `DELETE FROM contacts WHERE id IN ($1, $2)`,
    [realId, shadowId],
  ).catch(() => {});
}

describe("merge + advanceStageInDB race: contact_stage_history always ends up on the real contact with no duplicates", () => {
  /**
   * Ordering 1 — stage advancement completes BEFORE merge begins.
   *
   * advanceStageInDB(shadowId) runs to completion first (CTE appends the tag
   * and inserts a history row with contact_id = shadowId).  mergeAnonymousContact
   * then re-attributes that row to realId and deletes the shadow.
   *
   * Expected: 1 history row on real, 0 on shadow, shadow contact deleted.
   */
  it("Ordering 1: advance fires first → history row is re-attributed to the real contact by the merge", async () => {
    const { realId, shadowId } = await makeContactPair("MergeOrdering1");
    try {
      // Sequential: advance shadow first, then merge.
      await advanceStageInDB(shadowId, TEST_TENANT_ID, "aware");
      await mergeAnonymousContact(TEST_TENANT_ID, shadowId, realId);

      // Shadow must no longer exist — merge completed its DELETE.
      const { rows: shadowExists } = await pool.query<{ cnt: string }>(
        `SELECT COUNT(*) AS cnt FROM contacts WHERE id = $1`,
        [shadowId],
      );
      expect(Number(shadowExists[0].cnt)).toBe(0);

      // Exactly 1 history row must exist on the real contact.
      const { rows: realHist } = await pool.query<{ cnt: string }>(
        `SELECT COUNT(*) AS cnt FROM contact_stage_history WHERE contact_id = $1 AND to_stage = 'aware'`,
        [realId],
      );
      expect(Number(realHist[0].cnt)).toBe(1);

      // Zero history rows on the (deleted) shadow.
      const { rows: shadowHist } = await pool.query<{ cnt: string }>(
        `SELECT COUNT(*) AS cnt FROM contact_stage_history WHERE contact_id = $1`,
        [shadowId],
      );
      expect(Number(shadowHist[0].cnt)).toBe(0);
    } finally {
      await cleanupContactPair(realId, shadowId);
    }
  });

  /**
   * Ordering 2 — merge completes BEFORE stage advancement.
   *
   * mergeAnonymousContact runs to completion first: shadow row is deleted.
   * advanceStageInDB(shadowId) then fires against the now-deleted shadow.
   * Its CTE UPDATE matches 0 rows → 0 history rows inserted.  No orphan.
   *
   * Expected: 0 history rows total, shadow contact deleted.
   */
  it("Ordering 2: merge completes first → late advanceStageInDB against deleted shadow inserts zero rows", async () => {
    const { realId, shadowId } = await makeContactPair("MergeOrdering2");
    try {
      // Sequential: merge first, then attempt to advance the now-gone shadow.
      await mergeAnonymousContact(TEST_TENANT_ID, shadowId, realId);
      await advanceStageInDB(shadowId, TEST_TENANT_ID, "aware");

      // Shadow must no longer exist.
      const { rows: shadowExists } = await pool.query<{ cnt: string }>(
        `SELECT COUNT(*) AS cnt FROM contacts WHERE id = $1`,
        [shadowId],
      );
      expect(Number(shadowExists[0].cnt)).toBe(0);

      // No history rows on either contact — the CTE found no matching contacts row.
      const { rows: totalHist } = await pool.query<{ cnt: string }>(
        `SELECT COUNT(*) AS cnt FROM contact_stage_history WHERE contact_id IN ($1, $2)`,
        [realId, shadowId],
      );
      expect(Number(totalHist[0].cnt)).toBe(0);
    } finally {
      await cleanupContactPair(realId, shadowId);
    }
  });

  /**
   * Ordering 3 — concurrent execution (Promise.all).
   *
   * mergeAnonymousContact wraps all its statements in a serializable transaction
   * that begins with SELECT … FOR UPDATE on the shadow contacts row.  This lock
   * blocks any concurrent advanceStageInDB CTE that targets the same shadow until
   * the transaction commits (by which point the shadow is deleted).
   *
   * Two outcomes are possible depending on which operation acquires the row first:
   *
   *   Case A: advanceStageInDB CTE runs BEFORE the merge transaction begins →
   *     tag appended, history row inserted with contact_id = shadowId; merge then
   *     acquires the lock, moves the history row to realId, deletes shadow.
   *     Result: 1 history row on real.
   *
   *   Case B: merge transaction acquires the lock first →
   *     advanceStageInDB CTE blocks on UPDATE contacts WHERE id = shadowId until
   *     the transaction commits (shadow deleted); CTE matches 0 rows → 0 rows inserted.
   *     Result: 0 history rows.
   *
   * In BOTH cases:
   *   • Shadow contact is deleted (merge completed).
   *   • Zero history rows remain on the shadow contact.
   *   • Total 'aware' rows across both contacts ≤ 1 (no duplicate).
   *   • Any row that exists belongs to realId.
   */
  it("Ordering 3 (concurrent): Promise.all — shadow deleted, no orphaned history rows, any row on real", async () => {
    const { realId, shadowId } = await makeContactPair("MergeOrdering3");
    try {
      // Fire both concurrently without swallowing errors at the test level.
      await Promise.all([
        advanceStageInDB(shadowId, TEST_TENANT_ID, "aware"),
        mergeAnonymousContact(TEST_TENANT_ID, shadowId, realId),
      ]);

      // ── Invariant A: merge completed — shadow contact no longer exists ──────
      // If the shadow still exists the merge silently failed; remaining
      // assertions would be meaningless.
      const { rows: shadowExists } = await pool.query<{ cnt: string }>(
        `SELECT COUNT(*) AS cnt FROM contacts WHERE id = $1`,
        [shadowId],
      );
      expect(Number(shadowExists[0].cnt)).toBe(0);

      // ── Invariant B: zero history rows on the shadow contact ─────────────────
      const { rows: shadowHist } = await pool.query<{ cnt: string }>(
        `SELECT COUNT(*) AS cnt FROM contact_stage_history WHERE contact_id = $1`,
        [shadowId],
      );
      expect(Number(shadowHist[0].cnt)).toBe(0);

      // ── Invariant C: no duplicate 'aware' rows across both IDs ───────────────
      // Case A → 1 row on real; Case B → 0 rows.  Never 2.
      const { rows: totalHist } = await pool.query<{ cnt: string }>(
        `SELECT COUNT(*) AS cnt
         FROM contact_stage_history
         WHERE contact_id IN ($1, $2) AND to_stage = 'aware'`,
        [realId, shadowId],
      );
      const totalAware = Number(totalHist[0].cnt);
      expect(totalAware).toBeLessThanOrEqual(1);

      // ── Invariant D: any existing row belongs to the real contact ────────────
      const { rows: realHist } = await pool.query<{ cnt: string }>(
        `SELECT COUNT(*) AS cnt FROM contact_stage_history WHERE contact_id = $1`,
        [realId],
      );
      expect(Number(realHist[0].cnt)).toBe(totalAware);
    } finally {
      await cleanupContactPair(realId, shadowId);
    }
  });
});
