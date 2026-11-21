/**
 * Tests for the intent_score_at snapshot feature.
 *
 * Covers three guarantees:
 *
 *  1. Snapshot written — after a live scoring run, persistIntentResult writes
 *     the formula score onto the most recent activity event via
 *     `UPDATE activity_events SET intent_score_at = $score`.
 *
 *  2. Admin-recompute skips snapshot — when source is ADMIN_RECOMPUTE (or
 *     BACKFILL), the snapshot UPDATE is NOT issued, so old events keep their
 *     existing intent_score_at value.
 *
 *  3. Timeline consistency — the contacts timeline endpoint returns
 *     `cumulativeScore` equal to the event's `intent_score_at` (formula
 *     snapshot) when that field is populated, which by extension equals the
 *     contact's current `intent_score`.
 */
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import express from "express";
import request from "supertest";

// ─── Shared constants ──────────────────────────────────────────────────────────

const TENANT_ID  = 1;
const CONTACT_ID = 42;
const EVENT_ID   = 100;
/** Formula score returned by the scoring engine in the live-run scenario. */
const FORMULA_SCORE = 37;

// ─── Module-level mock spies ───────────────────────────────────────────────────

const mockEvaluateRoutingRules = vi.fn().mockResolvedValue(undefined);
const mockDbExecute            = vi.fn();
const mockPoolQuery            = vi.fn();

// ─── vi.mock factories (hoisted) ──────────────────────────────────────────────

vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { id: 1, tenantId: TENANT_ID, role: "admin" };
    next();
  },
}));

vi.mock("@workspace/db", () => ({
  db: {
    select:  vi.fn().mockReturnValue({ from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }) }),
    insert:  vi.fn().mockReturnValue({ values: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([]) }) }),
    update:  vi.fn().mockReturnValue({ set: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([]) }) }) }),
    delete:  vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }),
    execute: (...args: unknown[]) => mockDbExecute(...args),
  },
  pool:                       { query: (...args: unknown[]) => mockPoolQuery(...args) },
  // Named table symbols referenced by contacts route imports
  contactsTable:              Symbol("contactsTable"),
  companiesTable:             Symbol("companiesTable"),
  activityEventsTable:        Symbol("activityEventsTable"),
  emailSequencesTable:        Symbol("emailSequencesTable"),
  sequenceEnrollmentsTable:   Symbol("sequenceEnrollmentsTable"),
  sequenceStepsTable:         Symbol("sequenceStepsTable"),
}));

vi.mock("../lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../lib/scoringEngine", () => ({
  evaluateRoutingRules: (...args: unknown[]) => mockEvaluateRoutingRules(...args),
}));

vi.mock("../utils/segmentFilter", () => ({
  buildContactsWhereClause: vi.fn().mockReturnValue(undefined),
}));

vi.mock("../services/queue", () => ({
  enqueueStep:             vi.fn().mockResolvedValue(undefined),
  isTenantQueueAvailable:  vi.fn().mockResolvedValue(false),
}));

// ─── Helpers ───────────────────────────────────────────────────────────────────

/** ISO timestamp N seconds ago. */
function secsAgo(n: number): string {
  return new Date(Date.now() - n * 1000).toISOString();
}

/** ISO timestamp N days ago. */
function daysAgo(n: number): string {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
}

/**
 * Returns the argument string passed as $1 to any pool.query call whose
 * SQL matches the UPDATE activity_events SET intent_score_at pattern.
 * Returns undefined when no such call was recorded.
 */
function capturedSnapshotScore(mockFn: Mock): number | undefined {
  for (const call of mockFn.mock.calls) {
    const sql: string = typeof call[0] === "string" ? call[0] : "";
    if (sql.includes("intent_score_at") && sql.includes("UPDATE activity_events")) {
      // The score is passed as the first positional parameter ($1).
      const params: unknown[] = call[1] ?? [];
      return params[0] as number | undefined;
    }
  }
  return undefined;
}

/**
 * Wires mockDbExecute and mockPoolQuery with the default responses needed for
 * a live scoring run that produces FORMULA_SCORE.
 *
 * - One page_view event created within the last 60 seconds so the snapshot
 *   UPDATE will match.
 * - Contact row with no prior intent_state so routing rules fire.
 */
function wireForLiveScoringRun(
  { eventCreatedAt = secsAgo(5) }: { eventCreatedAt?: string } = {},
): void {
  mockDbExecute.mockImplementation((sqlObj: unknown) => {
    const raw = String(
      (sqlObj as any)?.queryChunks?.map((c: any) => c.value ?? "").join("") ?? sqlObj,
    );

    // Activity events for computeIntentScore
    if (raw.includes("FROM activity_events") || (raw.includes("activity_events") && raw.includes("score_delta"))) {
      return Promise.resolve({
        rows: [
          {
            event_type:       "page_view",
            score_delta:      5,
            stage:            "aware",
            created_at:       eventCreatedAt,
            duration_seconds: 180,
            metadata:         null,
          },
        ],
      });
    }
    // Contact row (tags, stage, company_id)
    if (raw.includes("FROM contacts") && !raw.includes("intent_state")) {
      return Promise.resolve({
        rows: [{ tags: [], stage: null, company_id: null }],
      });
    }
    // persistIntentResult pre-read: intent_state null → state changes → routing rules fire
    if (raw.includes("intent_state") || raw.includes("intent_score")) {
      return Promise.resolve({ rows: [{ intent_state: null, intent_score: null }] });
    }
    // UPDATE contacts in persistIntentResult
    if (raw.includes("UPDATE contacts")) {
      return Promise.resolve({ rows: [] });
    }
    return Promise.resolve({ rows: [] });
  });

  mockPoolQuery.mockImplementation((sqlStr: string, params?: unknown[]) => {
    const s = typeof sqlStr === "string" ? sqlStr.trim() : "";

    // Colleague count subquery used for account ABM bonus
    if (s.includes("active_colleagues")) {
      return Promise.resolve({ rows: [{ active_colleagues: 0 }] });
    }
    // maybeAdvanceToAware: SELECT id FROM activity_events for trigger event
    if (s.startsWith("SELECT id FROM activity_events")) {
      return Promise.resolve({ rows: [] });
    }
    // maybeAdvanceToAware: WITH advanced AS (UPDATE contacts …)
    if (s.startsWith("WITH advanced AS")) {
      // rowCount = 0 means stage was already non-pre-aware; no advance needed.
      return Promise.resolve({ rowCount: 0, rows: [] });
    }
    // score_history INSERT
    if (s.includes("INSERT INTO score_history")) {
      return Promise.resolve({ rows: [], rowCount: 1 });
    }
    // intent_score_at snapshot UPDATE — record but return success
    if (s.includes("intent_score_at") && s.includes("UPDATE activity_events")) {
      return Promise.resolve({ rows: [], rowCount: 1 });
    }
    // sequence_enrollment_skipped checks / inserts (non-live path)
    if (s.includes("sequence_enrollment_skipped")) {
      return Promise.resolve({ rows: [], rowCount: 0 });
    }
    return Promise.resolve({ rows: [], rowCount: 0 });
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// Part 1 — Engine-level: intent_score_at snapshot on live scoring run
// ══════════════════════════════════════════════════════════════════════════════

describe("persistIntentResult — intent_score_at snapshot", () => {
  let realComputeIntentScore: typeof import("../lib/intentScoring").computeIntentScore;
  let realScoreSources: typeof import("../lib/intentScoring").SCORE_SOURCES;

  beforeEach(async () => {
    vi.clearAllMocks();

    const actual = await vi.importActual<typeof import("../lib/intentScoring")>(
      "../lib/intentScoring",
    );
    realComputeIntentScore = actual.computeIntentScore;
    realScoreSources       = actual.SCORE_SOURCES;
  });

  it("writes intent_score_at to the most recent activity event on a live run", async () => {
    // Wire DB so the scoring engine runs and produces a non-zero score.
    wireForLiveScoringRun();

    const result = await realComputeIntentScore(CONTACT_ID, TENANT_ID);

    // The intent score must be computed (non-zero for a page_view with stage=aware).
    expect(result.intentScore).toBeGreaterThan(0);

    // pool.query must have been called with the snapshot UPDATE.
    const snapshotScore = capturedSnapshotScore(mockPoolQuery);
    expect(snapshotScore).toBeDefined();
    // The score written to intent_score_at must match the computed intent score.
    expect(snapshotScore).toBe(result.intentScore);
  });

  it("does NOT write intent_score_at when source is ADMIN_RECOMPUTE", async () => {
    wireForLiveScoringRun();

    await realComputeIntentScore(CONTACT_ID, TENANT_ID, {
      source: realScoreSources.ADMIN_RECOMPUTE,
    });

    // No snapshot UPDATE should have been issued.
    const snapshotScore = capturedSnapshotScore(mockPoolQuery);
    expect(snapshotScore).toBeUndefined();
  });

  it("does NOT write intent_score_at when source is BACKFILL", async () => {
    wireForLiveScoringRun();

    await realComputeIntentScore(CONTACT_ID, TENANT_ID, {
      source: realScoreSources.BACKFILL,
    });

    const snapshotScore = capturedSnapshotScore(mockPoolQuery);
    expect(snapshotScore).toBeUndefined();
  });

  it("writes intent_score_at when no source is provided (live path)", async () => {
    wireForLiveScoringRun();

    const result = await realComputeIntentScore(CONTACT_ID, TENANT_ID);

    const snapshotScore = capturedSnapshotScore(mockPoolQuery);
    expect(snapshotScore).toBe(result.intentScore);
  });

  it("restricts snapshot to events created in the last 60 seconds (query structure)", async () => {
    wireForLiveScoringRun();
    await realComputeIntentScore(CONTACT_ID, TENANT_ID);

    // Find the snapshot query call and assert the SQL contains the 60-second guard.
    const snapshotCall = mockPoolQuery.mock.calls.find(
      (call) =>
        typeof call[0] === "string" &&
        call[0].includes("intent_score_at") &&
        call[0].includes("UPDATE activity_events"),
    );
    expect(snapshotCall).toBeDefined();
    const snapshotSql: string = snapshotCall![0];
    expect(snapshotSql).toContain("60 seconds");
    // The SELECT sub-query must target the correct contact and tenant.
    expect(snapshotCall![1]).toEqual(expect.arrayContaining([CONTACT_ID, TENANT_ID]));
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Part 2 — Route-level: GET /contacts/:id/timeline cumulativeScore consistency
// ══════════════════════════════════════════════════════════════════════════════

import contactsRouter from "../routes/contacts";

function buildContactsApp() {
  const app = express();
  app.use(express.json());
  app.use("/api", contactsRouter);
  return app;
}

describe("GET /contacts/:id/timeline — cumulativeScore from intent_score_at", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /**
   * Wires mockDbExecute for the contacts timeline route.
   * Returns a contact with intent_score = FORMULA_SCORE and an activity event
   * with intent_score_at = FORMULA_SCORE so cumulativeScore should match.
   */
  function wireTimelineRoute({
    intentScoreAt = FORMULA_SCORE,
    stageHistoryRows = [] as any[],
     gtmRows = [] as any[],
   }: { intentScoreAt?: number | null; stageHistoryRows?: any[]; gtmRows?: any[] } = {}): void {
    const contactCreatedAt = daysAgo(10);
    const eventCreatedAt   = secsAgo(30);

    mockDbExecute.mockImplementation((sqlObj: unknown) => {
      const raw = String(
        (sqlObj as any)?.queryChunks?.map((c: any) => c.value ?? "").join("") ?? sqlObj,
      );

      // SELECT * FROM contacts — return the contact row
      if (raw.includes("FROM contacts c") && raw.includes("WHERE c.id")) {
        return Promise.resolve({
          rows: [{
            id:           CONTACT_ID,
            tenant_id:    TENANT_ID,
             company_id:   99,
            email:        "test@example.com",
            name:         "Test User",
            intent_score: FORMULA_SCORE,
            intent_state: "Stuck-Aware",
            stage:        "aware",
            tags:         ["aware", "warm"],
            created_at:   contactCreatedAt,
          }],
        });
      }

      // SELECT ... FROM activity_events ae LEFT JOIN journeys ... — return one page_view
      if (raw.includes("FROM activity_events ae") || (raw.includes("activity_events") && raw.includes("journey_name"))) {
        return Promise.resolve({
          rows: [{
            id:              EVENT_ID,
            event_type:      "page_view",
            description:     "Visited Solution Demo",
            score_delta:     5,
            stage:           "aware",
            page_name:       "Solution Demo",
            source:          null,
            created_at:      eventCreatedAt,
            journey_id:      null,
            journey_name:    null,
            sequence_id:     null,
            sequence_name:   null,
            metadata:        null,
            intent_score_at: intentScoreAt,
          }],
        });
      }

      // Call logs query
      if (raw.includes("call_logs") || raw.includes("vapi_call_id")) {
        return Promise.resolve({ rows: [] });
      }
      if (raw.includes("FROM intent_inbound_submissions")) {
        return Promise.resolve({ rows: gtmRows });
      }

      return Promise.resolve({ rows: [] });
    });

    mockPoolQuery.mockImplementation((sqlStr: string) => {
      const s = typeof sqlStr === "string" ? sqlStr.trim() : "";

      // contact_stage_history query
      if (s.includes("contact_stage_history")) {
        return Promise.resolve({ rows: stageHistoryRows });
      }

      return Promise.resolve({ rows: [] });
    });
  }

  it("keeps account GTM qualification separate from the journey stage and exposes their update dates", async () => {
    const stageDate = secsAgo(60);
    const qualificationDate = daysAgo(2);
    wireTimelineRoute({
      stageHistoryRows: [{
        id: 7, from_stage: "pre-aware", to_stage: "aware",
        score_at_transition: 12, created_at: stageDate, activity_event_id: null,
      }],
      gtmRows: [{ status: "hot", updated_at: qualificationDate }],
    });

    const res = await request(buildContactsApp()).get(`/api/contacts/${CONTACT_ID}/timeline`);
    expect(res.status).toBe(200);
    expect(res.body.contact.stage).toBe("aware");
    expect(res.body.stageHistory.at(-1).achievedAt).toBe(stageDate);
    expect(res.body.contact.gtmStatus).toEqual({
      status: "hot", updatedAt: qualificationDate,
    });
  });

  it("returns last event cumulativeScore equal to contact intent_score when intent_score_at is set", async () => {
    wireTimelineRoute({ intentScoreAt: FORMULA_SCORE });

    const app = buildContactsApp();
    const res = await request(app).get(`/api/contacts/${CONTACT_ID}/timeline`);

    expect(res.status).toBe(200);
    const { timeline } = res.body;
    expect(Array.isArray(timeline)).toBe(true);
    expect(timeline.length).toBeGreaterThan(0);

    // Find the most recent non-stage-change activity event.
    const activityEvents = timeline.filter((e: any) => !e.isPureStageChange);
    const lastActivity = activityEvents[activityEvents.length - 1];

    expect(lastActivity).toBeDefined();
    // cumulativeScore must match the snapshotted formula score = contact intent_score.
    expect(lastActivity.cumulativeScore).toBe(FORMULA_SCORE);
  });

  it("falls back to delta accumulation when intent_score_at is null and no stage history", async () => {
    // intent_score_at is null; score_delta = 5 → cumulativeScore should be 5.
    wireTimelineRoute({ intentScoreAt: null, stageHistoryRows: [] });

    const app = buildContactsApp();
    const res = await request(app).get(`/api/contacts/${CONTACT_ID}/timeline`);

    expect(res.status).toBe(200);
    const activityEvents = res.body.timeline.filter((e: any) => !e.isPureStageChange);
    const lastActivity = activityEvents[activityEvents.length - 1];

    expect(lastActivity).toBeDefined();
    // Delta accumulation: only event has score_delta=5, so cumulativeScore=5.
    expect(lastActivity.cumulativeScore).toBe(5);
  });

  it("prefers intent_score_at over stage-history interpolation when both are available", async () => {
    const stageHistoryRows = [{
      id:                   1,
      from_stage:           "pre-aware",
      to_stage:             "aware",
      score_at_transition:  12, // different from FORMULA_SCORE
      created_at:           daysAgo(5),
      activity_event_id:    null,
      trigger_event_type:   null,
      trigger_page_name:    null,
      trigger_description:  null,
    }];

    wireTimelineRoute({ intentScoreAt: FORMULA_SCORE, stageHistoryRows });

    const app = buildContactsApp();
    const res = await request(app).get(`/api/contacts/${CONTACT_ID}/timeline`);

    expect(res.status).toBe(200);
    const activityEvents = res.body.timeline.filter((e: any) => !e.isPureStageChange);
    const lastActivity = activityEvents[activityEvents.length - 1];

    // FORMULA_SCORE (37) must win over the stage-history interpolation (12).
    expect(lastActivity.cumulativeScore).toBe(FORMULA_SCORE);
  });

  it("returns 404 when contact is not found", async () => {
    mockDbExecute.mockResolvedValue({ rows: [] });
    mockPoolQuery.mockResolvedValue({ rows: [] });

    const app = buildContactsApp();
    const res = await request(app).get(`/api/contacts/9999/timeline`);

    expect(res.status).toBe(404);
  });
});
