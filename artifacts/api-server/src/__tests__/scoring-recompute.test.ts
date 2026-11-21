/**
 * Tests for the admin score recompute guard.
 *
 * Verifies two complementary guarantees:
 *
 *  1. Route guard — POST /api/scoring/recompute always passes
 *     `source: "admin_recompute"` (SCORE_SOURCES.ADMIN_RECOMPUTE) to every
 *     `computeIntentScore` call.
 *
 *  2. Engine guard — `computeIntentScore` with source ADMIN_RECOMPUTE never
 *     calls `evaluateRoutingRules`, even when the contact's intent state
 *     changes, preventing accidental sequence/journey enrollment during bulk
 *     admin recomputes.
 */
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import express from "express";
import request from "supertest";

// ─── Shared constants ──────────────────────────────────────────────────────────

const TENANT_ID  = 1;
const CONTACT_ID = 10;

// ─── Module-level mock spies ───────────────────────────────────────────────────
// These are vi.fn() instances that back the vi.mock() factories below.
// Both Part 1 and Part 2 reference these directly to avoid the problem of
// re-fetching wrapper functions from the mock module objects.

const mockComputeIntentScore     = vi.fn().mockResolvedValue(undefined);
const mockEvaluateRoutingRules   = vi.fn().mockResolvedValue(undefined);
const mockDbExecute              = vi.fn();
const mockPoolQuery              = vi.fn();

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
  pool:                  { query: (...args: unknown[]) => mockPoolQuery(...args) },
  scoringRulesTable:     Symbol("scoringRulesTable"),
  scoreThresholdsTable:  Symbol("scoreThresholdsTable"),
}));

vi.mock("../lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// The route tests mock intentScoring so computeIntentScore is observable.
vi.mock("../lib/intentScoring", () => ({
  computeIntentScore: (...args: unknown[]) => mockComputeIntentScore(...args),
  SCORE_SOURCES: {
    BACKFILL:        "backfill",
    ADMIN_RECOMPUTE: "admin_recompute",
  },
}));

// scoringEngine is mocked for both the route tests AND the engine tests.
// The real intentScoring.ts imports evaluateRoutingRules from this module,
// so when Part 2 uses vi.importActual to load the real computeIntentScore,
// its dependency on evaluateRoutingRules still resolves to this mock.
vi.mock("../lib/scoringEngine", () => ({
  evaluateRoutingRules: (...args: unknown[]) => mockEvaluateRoutingRules(...args),
}));

import scoringRouter from "../routes/scoring";

// ══════════════════════════════════════════════════════════════════════════════
// Part 1 — Route-level: POST /api/scoring/recompute
// ══════════════════════════════════════════════════════════════════════════════

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api", scoringRouter);
  return app;
}

describe("POST /api/scoring/recompute — route guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // db.execute: return two contacts for the SELECT id FROM contacts query.
    mockDbExecute.mockImplementation((sqlObj: unknown) => {
      const raw = String(
        (sqlObj as any)?.queryChunks?.map((c: any) => c.value ?? "").join("") ?? sqlObj,
      );
      if (raw.includes("FROM contacts")) {
        return Promise.resolve({ rows: [{ id: CONTACT_ID }, { id: CONTACT_ID + 1 }] });
      }
      return Promise.resolve({ rows: [] });
    });
    mockComputeIntentScore.mockResolvedValue(undefined);
  });

  it("returns 200 with updated/errors/total counts", async () => {
    const app = buildApp();
    const res = await request(app).post("/api/scoring/recompute").send();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ updated: 2, errors: 0, total: 2 });
  });

  it("calls computeIntentScore once per contact", async () => {
    const app = buildApp();
    await request(app).post("/api/scoring/recompute").send();
    expect(mockComputeIntentScore).toHaveBeenCalledTimes(2);
  });

  it("always passes source: 'admin_recompute' (SCORE_SOURCES.ADMIN_RECOMPUTE) to computeIntentScore", async () => {
    const app = buildApp();
    await request(app).post("/api/scoring/recompute").send();

    const calls = mockComputeIntentScore.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      const options = call[2] as { source?: string } | undefined;
      expect(options).toBeDefined();
      expect(options?.source).toBe("admin_recompute");
    }
  });

  it("passes the contact id and tenant id alongside the source option", async () => {
    const app = buildApp();
    await request(app).post("/api/scoring/recompute").send();

    const firstCall = mockComputeIntentScore.mock.calls[0];
    expect(firstCall[0]).toBe(CONTACT_ID);
    expect(firstCall[1]).toBe(TENANT_ID);
    expect(firstCall[2]).toMatchObject({ source: "admin_recompute" });
  });

  it("counts per-contact errors without failing the entire request", async () => {
    mockComputeIntentScore
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("db timeout"));

    const app = buildApp();
    const res = await request(app).post("/api/scoring/recompute").send();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ updated: 1, errors: 1, total: 2 });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Part 2 — Engine-level: evaluateRoutingRules suppression
//
// These tests call the REAL computeIntentScore (via vi.importActual) to
// verify that the NON_LIVE_SOURCES guard inside persistIntentResult works.
// The real implementation's import of evaluateRoutingRules resolves to the
// module-level mockEvaluateRoutingRules spy (via the vi.mock above), so we
// can assert on it directly.
// ══════════════════════════════════════════════════════════════════════════════

describe("computeIntentScore engine — evaluateRoutingRules suppression", () => {
  let realComputeIntentScore: typeof import("../lib/intentScoring").computeIntentScore;
  let realScoreSources: typeof import("../lib/intentScoring").SCORE_SOURCES;

  /** ISO timestamp N days ago */
  function daysAgo(n: number) {
    return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
  }

  beforeEach(async () => {
    vi.clearAllMocks();

    // Pull the REAL computeIntentScore implementation.
    const actual = await vi.importActual<typeof import("../lib/intentScoring")>(
      "../lib/intentScoring",
    );
    realComputeIntentScore = actual.computeIntentScore;
    realScoreSources       = actual.SCORE_SOURCES;

    // Wire db.execute so the real function can run end-to-end.
    // We supply one page_view event so intent state moves from null →
    // something, making the test meaningful: routing rules WOULD fire on a
    // live source but must NOT fire on a suppressed source.
    mockDbExecute.mockImplementation((sqlObj: unknown) => {
      const raw = String(
        (sqlObj as any)?.queryChunks?.map((c: any) => c.value ?? "").join("") ?? sqlObj,
      );

      // Activity events — one meaningful page_view so intent state changes
      if (raw.includes("activity_events") || raw.includes("FROM ae")) {
        return Promise.resolve({
          rows: [
            {
              event_type:       "page_view",
              score_delta:      5,
              stage:            "aware",
              created_at:       daysAgo(2),
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
      // persistIntentResult pre-read: return null intent_state so state
      // is guaranteed to change → evaluateRoutingRules would run on live path.
      if (raw.includes("intent_state") || raw.includes("intent_score")) {
        return Promise.resolve({ rows: [{ intent_state: null, intent_score: null }] });
      }
      // UPDATE contacts in persistIntentResult
      if (raw.includes("UPDATE contacts")) {
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });

    mockPoolQuery.mockImplementation((sql: string) => {
      const s = sql.trim();
      if (s.includes("active_colleagues")) {
        return Promise.resolve({ rows: [{ active_colleagues: 0 }] });
      }
      if (s.startsWith("WITH advanced AS")) {
        return Promise.resolve({ rowCount: 1, rows: [] });
      }
      if (s.startsWith("INSERT INTO activity_events")) {
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });
  });

  it("does NOT call evaluateRoutingRules when source is ADMIN_RECOMPUTE", async () => {
    await realComputeIntentScore(CONTACT_ID, TENANT_ID, {
      source: realScoreSources.ADMIN_RECOMPUTE,
    });

    expect(mockEvaluateRoutingRules).not.toHaveBeenCalled();
  });

  it("does NOT call evaluateRoutingRules when source is BACKFILL", async () => {
    await realComputeIntentScore(CONTACT_ID, TENANT_ID, {
      source: realScoreSources.BACKFILL,
    });

    expect(mockEvaluateRoutingRules).not.toHaveBeenCalled();
  });

  it("DOES call evaluateRoutingRules when source is omitted (live path) and intent state changes", async () => {
    await realComputeIntentScore(CONTACT_ID, TENANT_ID);

    // With the mocked events, intent state moves from null → non-null, so
    // evaluateRoutingRules must be invoked exactly once.
    expect(mockEvaluateRoutingRules).toHaveBeenCalledTimes(1);
  });

  it("DOES call evaluateRoutingRules when source is an unknown/custom string (live path)", async () => {
    await realComputeIntentScore(CONTACT_ID, TENANT_ID, {
      source: "some_other_source" as any,
    });

    expect(mockEvaluateRoutingRules).toHaveBeenCalledTimes(1);
  });

  it("returns routingRulesSuppressed: true when source is ADMIN_RECOMPUTE and intent state changed", async () => {
    const result = await realComputeIntentScore(CONTACT_ID, TENANT_ID, {
      source: realScoreSources.ADMIN_RECOMPUTE,
    });

    expect(result).toBeDefined();
    if (result) {
      expect(result.routingRulesSuppressed).toBe(true);
    }
  });
});
