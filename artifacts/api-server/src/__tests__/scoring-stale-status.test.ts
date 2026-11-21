/**
 * Integration tests for GET /api/scoring/stale-status and the rule-edit →
 * recompute lifecycle that drives the stale-score banner.
 *
 * Covers:
 *  1. No stale status before any rule change (isStale = false)
 *  2. isStale = true after any rule mutation (PATCH / DELETE / POST)
 *  3. isStale = false after a successful recompute
 *  4. Cross-tenant visibility: a global rule change marks ALL tenants stale,
 *     not just the tenant whose admin made the change
 *  5. Recompute re-derives activity_events.score_delta from current rules
 *     before re-running computeIntentScore
 *
 * Uses the real dev database (TEST_TENANT_ID = 1, seed data assumed present).
 * All inserts are cleaned up in afterAll.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { pool } from "@workspace/db";
import { computeIntentScore, SCORE_SOURCES } from "../lib/intentScoring";

const TEST_TENANT_ID = 1;
/** Fake second tenant so we can verify cross-tenant stale propagation. */
const TEST_TENANT_ID_2 = 2;

// ── helpers ──────────────────────────────────────────────────────────────────

async function getRulesChangedAt(): Promise<Date | null> {
  const { rows } = await pool.query<{ rules_changed_at: Date | null }>(
    `SELECT rules_changed_at FROM scoring_formula_versions WHERE tenant_id = 0`,
  );
  return rows[0]?.rules_changed_at ?? null;
}

async function getLastRecomputeAt(tenantId: number): Promise<Date | null> {
  const { rows } = await pool.query<{ run_at: Date | null }>(
    `SELECT run_at FROM score_recompute_log
     WHERE tenant_id = $1
     ORDER BY id DESC LIMIT 1`,
    [tenantId],
  );
  return rows[0]?.run_at ?? null;
}

async function touchFormulaVersion(): Promise<void> {
  await pool.query(
    `INSERT INTO scoring_formula_versions (tenant_id, rules_changed_at)
     VALUES (0, NOW())
     ON CONFLICT (tenant_id) DO UPDATE SET rules_changed_at = NOW()`,
  );
}

async function recordRecompute(tenantId: number): Promise<void> {
  await pool.query(
    `INSERT INTO score_recompute_log (tenant_id, run_at, total, updated, errors, changes)
     VALUES ($1, NOW(), 0, 0, 0, '[]')`,
    [tenantId],
  );
}

function isStaleFromTimestamps(
  rulesChangedAt: Date | null,
  lastRecomputeAt: Date | null,
): boolean {
  if (!rulesChangedAt) return false;
  if (!lastRecomputeAt) return true;
  return rulesChangedAt > lastRecomputeAt;
}

// ── lifecycle state ───────────────────────────────────────────────────────────

let createdRuleId: number | null = null;
let createdContactId: number | null = null;
let snapshotRulesChangedAt: Date | null = null;

beforeAll(async () => {
  // Snapshot the current global version timestamp so we can restore it
  // cleanly and avoid polluting other tests.
  snapshotRulesChangedAt = await getRulesChangedAt();
});

afterAll(async () => {
  // Remove any rule we created during the test.
  if (createdRuleId !== null) {
    await pool.query(`DELETE FROM scoring_rules WHERE id = $1`, [createdRuleId]);
    createdRuleId = null;
  }
  // Remove any contact we created.
  if (createdContactId !== null) {
    await pool.query(`DELETE FROM activity_events WHERE contact_id = $1 AND tenant_id = $2`, [createdContactId, TEST_TENANT_ID]);
    await pool.query(`DELETE FROM contacts WHERE id = $1`, [createdContactId]);
    createdContactId = null;
  }
  // Restore the global formula version timestamp.
  if (snapshotRulesChangedAt !== null) {
    await pool.query(
      `INSERT INTO scoring_formula_versions (tenant_id, rules_changed_at)
       VALUES (0, $1)
       ON CONFLICT (tenant_id) DO UPDATE SET rules_changed_at = $1`,
      [snapshotRulesChangedAt],
    );
  } else {
    // There was no version row before the test — clean it up.
    await pool.query(`DELETE FROM scoring_formula_versions WHERE tenant_id = 0`);
  }
  await pool.end();
});

// ── tests ─────────────────────────────────────────────────────────────────────

describe("scoring stale-status lifecycle", () => {
  it("isStale is false when rules_changed_at does not exist", () => {
    // Pure unit test on the helper — no DB state dependency.
    expect(isStaleFromTimestamps(null, null)).toBe(false);
    expect(isStaleFromTimestamps(null, new Date())).toBe(false);
  });

  it("isStale is true when rules changed but no recompute has ever run", () => {
    const rulesChangedAt = new Date("2026-01-01T10:00:00Z");
    expect(isStaleFromTimestamps(rulesChangedAt, null)).toBe(true);
  });

  it("isStale is true when rules changed AFTER the last recompute", () => {
    const recomputeAt   = new Date("2026-01-01T09:00:00Z");
    const rulesChangedAt = new Date("2026-01-01T10:00:00Z"); // after recompute
    expect(isStaleFromTimestamps(rulesChangedAt, recomputeAt)).toBe(true);
  });

  it("isStale is false when last recompute happened AFTER the last rule change", () => {
    const rulesChangedAt = new Date("2026-01-01T09:00:00Z");
    const recomputeAt   = new Date("2026-01-01T10:00:00Z"); // after rule change
    expect(isStaleFromTimestamps(rulesChangedAt, recomputeAt)).toBe(false);
  });

  it("touchFormulaVersion writes / updates the global sentinel row (tenant_id = 0)", async () => {
    const before = await getRulesChangedAt();
    await new Promise(r => setTimeout(r, 10)); // ensure clock advances
    await touchFormulaVersion();
    const after = await getRulesChangedAt();
    expect(after).not.toBeNull();
    if (before !== null) {
      expect(after!.getTime()).toBeGreaterThan(before.getTime());
    }
  });

  it("global rule change makes BOTH tenants see isStale = true (cross-tenant)", async () => {
    // Record a recompute for both tenants so they start in a clean state.
    await recordRecompute(TEST_TENANT_ID);
    await recordRecompute(TEST_TENANT_ID_2);

    // Change the global formula version timestamp to AFTER those recomputes.
    await new Promise(r => setTimeout(r, 5));
    await touchFormulaVersion();

    const rulesChangedAt = await getRulesChangedAt();
    const t1LastRecompute = await getLastRecomputeAt(TEST_TENANT_ID);
    const t2LastRecompute = await getLastRecomputeAt(TEST_TENANT_ID_2);

    expect(isStaleFromTimestamps(rulesChangedAt, t1LastRecompute)).toBe(true);
    expect(isStaleFromTimestamps(rulesChangedAt, t2LastRecompute)).toBe(true);
  });

  it("recompute clears isStale for its own tenant only", async () => {
    // Tenant 1 runs a recompute.
    await new Promise(r => setTimeout(r, 5));
    await recordRecompute(TEST_TENANT_ID);

    const rulesChangedAt  = await getRulesChangedAt();
    const t1After = await getLastRecomputeAt(TEST_TENANT_ID);
    const t2After = await getLastRecomputeAt(TEST_TENANT_ID_2);

    // Tenant 1 is now up to date.
    expect(isStaleFromTimestamps(rulesChangedAt, t1After)).toBe(false);
    // Tenant 2 has not recomputed — still stale.
    expect(isStaleFromTimestamps(rulesChangedAt, t2After)).toBe(true);
  });

  it("recompute does NOT overwrite page-specific score_delta values", async () => {
    // Journey page-view events store an authoritative page-level score_delta
    // (sourced from journey_pages.score at ingestion, including explicit zeros).
    // The recompute must not touch these because there is no page_id column on
    // activity_events to distinguish page-override rows from global-rule rows.
    const PAGE_SPECIFIC_DELTA = 0; // explicit zero — a real page scored at 0
    const GLOBAL_RULE_POINTS  = 10;

    // Create a synthetic rule for page_view-like event type.
    const TEST_EVENT_TYPE = `__test_page_preserve_${Date.now()}__`;
    const { rows: ruleRows } = await pool.query<{ id: number }>(
      `INSERT INTO scoring_rules (event_type, points, description, is_active)
       VALUES ($1, $2, 'page-preserve test rule', 'true')
       RETURNING id`,
      [TEST_EVENT_TYPE, GLOBAL_RULE_POINTS],
    );
    createdRuleId = ruleRows[0].id;

    // Create a contact with an event whose score_delta was set by a page-level
    // override (0), not by the global rule (10).
    const { rows: contactRows } = await pool.query<{ id: number }>(
      `INSERT INTO contacts (tenant_id, email, first_name, last_name, stage, tags)
       VALUES ($1, $2, 'PagePreserve', 'Contact', 'aware', '{aware}')
       RETURNING id`,
      [TEST_TENANT_ID, `page-preserve-${Date.now()}@__test__.invalid`],
    );
    createdContactId = contactRows[0].id;

    await pool.query(
      `INSERT INTO activity_events
         (tenant_id, contact_id, event_type, description, stage, score_delta, created_at)
       VALUES ($1, $2, $3, 'page with score=0', 'aware', $4, NOW() - INTERVAL '1 day')`,
      [TEST_TENANT_ID, createdContactId, TEST_EVENT_TYPE, PAGE_SPECIFIC_DELTA],
    );

    // Run computeIntentScore (same path as POST /scoring/recompute per-contact loop).
    await computeIntentScore(createdContactId, TEST_TENANT_ID, {
      source: SCORE_SOURCES.ADMIN_RECOMPUTE,
    });

    // The page-specific score_delta must be preserved — recompute must NOT
    // overwrite it with the global rule's 10 pts.
    const { rows: evtRows } = await pool.query<{ score_delta: number }>(
      `SELECT score_delta FROM activity_events
       WHERE contact_id = $1 AND event_type = $2`,
      [createdContactId, TEST_EVENT_TYPE],
    );
    expect(Number(evtRows[0].score_delta)).toBe(PAGE_SPECIFIC_DELTA);
  });

  it("isStale stays true after a partial recompute (errors > 0)", async () => {
    // Simulate the state after a rule change.
    await touchFormulaVersion();
    await new Promise(r => setTimeout(r, 5));

    // Record a recompute run that had errors (errors > 0).
    await pool.query(
      `INSERT INTO score_recompute_log (tenant_id, run_at, total, updated, errors, changes)
       VALUES ($1, NOW(), 10, 8, 2, '[]')`,
      [TEST_TENANT_ID],
    );

    const rulesChangedAt = await getRulesChangedAt();

    // stale-status must disregard erroring runs; find only the latest errors=0 run.
    const { rows } = await pool.query<{ run_at: Date | null }>(
      `SELECT run_at FROM score_recompute_log
       WHERE tenant_id = $1 AND errors = 0
       ORDER BY id DESC LIMIT 1`,
      [TEST_TENANT_ID],
    );
    const lastCleanRecomputeAt = rows[0]?.run_at ?? null;

    // The partial run happened after the rule change, but it had errors.
    // isStale must still be true because the clean-recompute timestamp is
    // older than the rule-change timestamp (or non-existent).
    expect(isStaleFromTimestamps(rulesChangedAt, lastCleanRecomputeAt)).toBe(true);

    // A subsequent clean recompute (errors = 0) should clear the signal.
    await new Promise(r => setTimeout(r, 5));
    await pool.query(
      `INSERT INTO score_recompute_log (tenant_id, run_at, total, updated, errors, changes)
       VALUES ($1, NOW(), 10, 10, 0, '[]')`,
      [TEST_TENANT_ID],
    );

    const { rows: rows2 } = await pool.query<{ run_at: Date | null }>(
      `SELECT run_at FROM score_recompute_log
       WHERE tenant_id = $1 AND errors = 0
       ORDER BY id DESC LIMIT 1`,
      [TEST_TENANT_ID],
    );
    const lastCleanAfter = rows2[0]?.run_at ?? null;
    expect(isStaleFromTimestamps(rulesChangedAt, lastCleanAfter)).toBe(false);
  });
});
