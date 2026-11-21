/**
 * Stress test: groupEnrollments with 55+ re-enrollments for one contact.
 *
 * Imports the production utility directly from
 * artifacts/playforge/src/lib/enrollmentGrouping.ts — the same function
 * used by EnrollmentsView's useMemo — so any regression in the real
 * implementation is caught here.
 *
 * Verifies:
 *  1. The grouping completes in ≤ 10 ms for 55 rows (a single heavily
 *     re-enrolled contact).
 *  2. No duplicate enrollment IDs appear in the sub-row list.
 *  3. Sub-rows are sorted newest-first (enrolled_at DESC).
 *  4. re_enrollment_number values assigned by the API (ROW_NUMBER OVER
 *     PARTITION BY contact_id ORDER BY enrolled_at ASC) cover 1 … N with
 *     no gaps when sorted — the UI relies on this to render "Original
 *     enrollment" vs "Re-enrollment #N" badges.
 *  5. The most recent enrollment is exposed as `latest`.
 *  6. Mixed-contact payloads are isolated correctly — no row leaks across
 *     contact groups.
 */

import { describe, it, expect } from "vitest";
import {
  groupEnrollments,
  type EnrollmentRow,
} from "../lib/enrollmentGrouping";

// ── Fixture builders ──────────────────────────────────────────────────────────

/** Build `count` enrollment rows for a single contact, oldest first. */
function buildStressRows(count: number, contactId = 1): EnrollmentRow[] {
  // Spread enrollments one day apart, starting `count` days ago
  const baseMs = Date.now() - count * 24 * 60 * 60 * 1000;
  return Array.from({ length: count }, (_, i) => {
    const enrolledMs = baseMs + i * 24 * 60 * 60 * 1000;
    const isLast = i === count - 1;
    return {
      id: i + 1,
      contact_id: contactId,
      sequence_id: 100,
      status: isLast ? "active" : "completed",
      current_step_id: null,
      enrolled_at: new Date(enrolledMs).toISOString(),
      completed_at: isLast
        ? null
        : new Date(enrolledMs + 3_600_000).toISOString(),
      first_name: "Alice",
      last_name: "Stress",
      email: "alice@stress.test",
      lead_score: 72,
      // Mirrors ROW_NUMBER() OVER (PARTITION BY contact_id ORDER BY enrolled_at ASC)
      re_enrollment_number: i + 1,
    };
  });
}

/** Build `count` single-enrollment rows for `count` distinct contacts. */
function buildOtherRows(count: number, startContactId = 2): EnrollmentRow[] {
  return Array.from({ length: count }, (_, i) => ({
    id: 1000 + i,
    contact_id: startContactId + i,
    sequence_id: 100,
    status: "completed" as const,
    current_step_id: null,
    enrolled_at: new Date(Date.now() - i * 3_600_000).toISOString(),
    completed_at: null,
    first_name: `Contact${startContactId + i}`,
    last_name: "Other",
    email: `contact${startContactId + i}@other.test`,
    lead_score: 10,
    re_enrollment_number: 1,
  }));
}

// ── Tests ─────────────────────────────────────────────────────────────────────

const STRESS_COUNT = 55; // above the 50+ threshold from the task spec

describe("groupEnrollments — stress test with 55 re-enrollments (single contact)", () => {
  it("completes in ≤ 10 ms for 55 rows", () => {
    const rows = buildStressRows(STRESS_COUNT);
    const start = performance.now();
    const grouped = groupEnrollments(rows);
    const elapsed = performance.now() - start;

    expect(grouped).toHaveLength(1);
    expect(elapsed).toBeLessThan(10);
  });

  it("produces exactly 55 sub-rows for the stress contact", () => {
    const rows = buildStressRows(STRESS_COUNT);
    const [group] = groupEnrollments(rows);
    expect(group.enrollments).toHaveLength(STRESS_COUNT);
  });

  it("contains no duplicate enrollment IDs", () => {
    const rows = buildStressRows(STRESS_COUNT);
    const [group] = groupEnrollments(rows);
    const ids = group.enrollments.map((e) => e.id);
    expect(new Set(ids).size).toBe(STRESS_COUNT);
  });

  it("sub-rows are sorted newest-first (enrolled_at DESC)", () => {
    const rows = buildStressRows(STRESS_COUNT);
    const [group] = groupEnrollments(rows);
    const subRows = group.enrollments;
    for (let i = 0; i < subRows.length - 1; i++) {
      expect(
        new Date(subRows[i].enrolled_at!).getTime(),
      ).toBeGreaterThanOrEqual(
        new Date(subRows[i + 1].enrolled_at!).getTime(),
      );
    }
  });

  it("latest is the most recent enrollment (active, run #55)", () => {
    const rows = buildStressRows(STRESS_COUNT);
    const [group] = groupEnrollments(rows);
    expect(group.latest.status).toBe("active");
    expect(group.latest.re_enrollment_number).toBe(STRESS_COUNT);
  });

  it("re_enrollment_number covers 1 … 55 with no gaps", () => {
    const rows = buildStressRows(STRESS_COUNT);
    const [group] = groupEnrollments(rows);
    const nums = group.enrollments
      .map((e) => e.re_enrollment_number)
      .sort((a, b) => a - b);
    expect(nums).toEqual(Array.from({ length: STRESS_COUNT }, (_, i) => i + 1));
  });

  it("run #1 has re_enrollment_number === 1 (rendered as 'Original enrollment')", () => {
    const rows = buildStressRows(STRESS_COUNT);
    const [group] = groupEnrollments(rows);
    const original = group.enrollments.find((e) => e.re_enrollment_number === 1);
    expect(original).toBeDefined();
  });
});

describe("groupEnrollments — mixed payload (55 stress contact + 10 others)", () => {
  it("completes in ≤ 10 ms for 65 total rows across 11 contacts", () => {
    const rows = [...buildStressRows(STRESS_COUNT), ...buildOtherRows(10)];
    const start = performance.now();
    const grouped = groupEnrollments(rows);
    const elapsed = performance.now() - start;

    expect(grouped).toHaveLength(11);
    expect(elapsed).toBeLessThan(10);
  });

  it("stress contact group has 55 rows — no leakage from other contacts", () => {
    const rows = [...buildStressRows(STRESS_COUNT), ...buildOtherRows(10)];
    const grouped = groupEnrollments(rows);
    const stressGroup = grouped.find((g) => g.contactId === 1)!;
    expect(stressGroup).toBeDefined();
    expect(stressGroup.enrollments).toHaveLength(STRESS_COUNT);
    for (const e of stressGroup.enrollments) {
      expect(e.contact_id).toBe(1);
    }
  });

  it("each other-contact group has exactly 1 row", () => {
    const rows = [...buildStressRows(STRESS_COUNT), ...buildOtherRows(10)];
    const grouped = groupEnrollments(rows);
    const otherGroups = grouped.filter((g) => g.contactId !== 1);
    expect(otherGroups).toHaveLength(10);
    for (const g of otherGroups) {
      expect(g.enrollments).toHaveLength(1);
    }
  });

  it("overall group list is sorted with the most-recently-enrolled contact first", () => {
    const rows = [...buildStressRows(STRESS_COUNT), ...buildOtherRows(10)];
    const grouped = groupEnrollments(rows);
    for (let i = 0; i < grouped.length - 1; i++) {
      expect(
        new Date(grouped[i].latest.enrolled_at!).getTime(),
      ).toBeGreaterThanOrEqual(
        new Date(grouped[i + 1].latest.enrolled_at!).getTime(),
      );
    }
  });
});

// ── 200 contacts × 5 re-enrollments = 1 000 rows ─────────────────────────────

const LARGE_CONTACTS = 200;
const RE_ENROLLMENTS_PER_CONTACT = 5;
const LARGE_TOTAL = LARGE_CONTACTS * RE_ENROLLMENTS_PER_CONTACT; // 1 000

/**
 * Build a realistic 1 000-row payload: 200 contacts each enrolled 5 times,
 * interleaved (as the API returns them — ORDER BY enrolled_at DESC across all
 * contacts) so the grouping function sees an unsorted mix, not pre-grouped
 * blocks.
 */
function buildLargePayload(): EnrollmentRow[] {
  const rows: EnrollmentRow[] = [];
  // Assign each contact×enrollment a unique timestamp so sorting is deterministic
  // interleave by enrollment round rather than by contact so input is unsorted
  for (let round = 0; round < RE_ENROLLMENTS_PER_CONTACT; round++) {
    for (let c = 0; c < LARGE_CONTACTS; c++) {
      const contactId = 10_000 + c;
      const enrollmentIndex = round; // 0-based within this contact
      const enrolledMs =
        Date.now() -
        // oldest enrollments furthest in the past
        (RE_ENROLLMENTS_PER_CONTACT - round) * 7 * 24 * 60 * 60 * 1000 +
        c * 60 * 1000; // spread contacts 1 min apart within same round
      const isLatest = round === RE_ENROLLMENTS_PER_CONTACT - 1;
      rows.push({
        id: c * RE_ENROLLMENTS_PER_CONTACT + round + 1,
        contact_id: contactId,
        sequence_id: 200,
        status: isLatest ? "active" : "completed",
        current_step_id: null,
        enrolled_at: new Date(enrolledMs).toISOString(),
        completed_at: isLatest
          ? null
          : new Date(enrolledMs + 3_600_000).toISOString(),
        first_name: `First${c}`,
        last_name: `Last${c}`,
        email: `contact${c}@load.test`,
        lead_score: (c % 100) + 1,
        re_enrollment_number: enrollmentIndex + 1,
      });
    }
  }
  return rows;
}

describe(`groupEnrollments — large payload (${LARGE_CONTACTS} contacts × ${RE_ENROLLMENTS_PER_CONTACT} re-enrollments = ${LARGE_TOTAL} rows)`, () => {
  it(`completes in ≤ 30 ms for ${LARGE_TOTAL} rows`, () => {
    const rows = buildLargePayload();
    expect(rows).toHaveLength(LARGE_TOTAL);

    const start = performance.now();
    const grouped = groupEnrollments(rows);
    const elapsed = performance.now() - start;

    expect(grouped).toHaveLength(LARGE_CONTACTS);
    expect(elapsed).toBeLessThan(30);
  });

  it("every contact group has exactly 5 enrollments — no row leakage", () => {
    const rows = buildLargePayload();
    const grouped = groupEnrollments(rows);
    for (const g of grouped) {
      expect(g.enrollments).toHaveLength(RE_ENROLLMENTS_PER_CONTACT);
    }
  });

  it("all enrollment IDs across groups are unique — no duplication", () => {
    const rows = buildLargePayload();
    const grouped = groupEnrollments(rows);
    const allIds = grouped.flatMap((g) => g.enrollments.map((e) => e.id));
    expect(new Set(allIds).size).toBe(LARGE_TOTAL);
  });

  it("latest is always status=active (round 5 of 5) for every contact", () => {
    const rows = buildLargePayload();
    const grouped = groupEnrollments(rows);
    for (const g of grouped) {
      expect(g.latest.status).toBe("active");
      expect(g.latest.re_enrollment_number).toBe(RE_ENROLLMENTS_PER_CONTACT);
    }
  });

  it("sub-rows within every group are sorted newest-first", () => {
    const rows = buildLargePayload();
    const grouped = groupEnrollments(rows);
    for (const g of grouped) {
      const enrs = g.enrollments;
      for (let i = 0; i < enrs.length - 1; i++) {
        expect(
          new Date(enrs[i].enrolled_at ?? 0).getTime(),
        ).toBeGreaterThanOrEqual(
          new Date(enrs[i + 1].enrolled_at ?? 0).getTime(),
        );
      }
    }
  });

  it("re_enrollment_number values within each group cover 1…5 with no gaps", () => {
    const rows = buildLargePayload();
    const grouped = groupEnrollments(rows);
    const expected = Array.from(
      { length: RE_ENROLLMENTS_PER_CONTACT },
      (_, i) => i + 1,
    );
    for (const g of grouped) {
      const nums = g.enrollments
        .map((e) => e.re_enrollment_number)
        .sort((a, b) => a - b);
      expect(nums).toEqual(expected);
    }
  });

  it("groups are sorted newest-latest-enrollment first across all contacts", () => {
    const rows = buildLargePayload();
    const grouped = groupEnrollments(rows);
    for (let i = 0; i < grouped.length - 1; i++) {
      expect(
        new Date(grouped[i].latest.enrolled_at ?? 0).getTime(),
      ).toBeGreaterThanOrEqual(
        new Date(grouped[i + 1].latest.enrolled_at ?? 0).getTime(),
      );
    }
  });
});

describe("groupEnrollments — edge cases", () => {
  it("returns empty array for empty input", () => {
    expect(groupEnrollments([])).toEqual([]);
  });

  it("handles a single enrollment row correctly", () => {
    const [row] = buildStressRows(1);
    const grouped = groupEnrollments([row]);
    expect(grouped).toHaveLength(1);
    expect(grouped[0].enrollments).toHaveLength(1);
    expect(grouped[0].latest).toBe(grouped[0].enrollments[0]);
  });

  it("handles null enrolled_at without throwing", () => {
    const rows: EnrollmentRow[] = [
      {
        id: 1, contact_id: 5, sequence_id: 1, status: "completed",
        current_step_id: null, enrolled_at: null, completed_at: null,
        first_name: "No", last_name: "Date", email: "nodate@test.com",
        lead_score: 0, re_enrollment_number: 1,
      },
      {
        id: 2, contact_id: 5, sequence_id: 1, status: "active",
        current_step_id: null,
        enrolled_at: new Date(Date.now()).toISOString(),
        completed_at: null,
        first_name: "No", last_name: "Date", email: "nodate@test.com",
        lead_score: 0, re_enrollment_number: 2,
      },
    ];
    const grouped = groupEnrollments(rows);
    expect(grouped).toHaveLength(1);
    expect(grouped[0].enrollments).toHaveLength(2);
    // The row with a real enrolled_at should be latest (newest)
    expect(grouped[0].latest.id).toBe(2);
  });
});
