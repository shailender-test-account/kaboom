/**
 * Tests for the poly-contest journey startup seed.
 *
 * Covers:
 *  1. ensurePolyContestJourney() — the CTE seed function:
 *     - runs the correct SQL (WITH existing_hp / new_hp / hp_client CTE)
 *     - uses ON CONFLICT (slug) DO NOTHING for idempotency
 *     - does not throw when pool.query rejects (non-fatal)
 *
 *  2. GET /api/public/journeys/poly-contest:
 *     - returns 200 when journey is published and found
 *     - returns 404 when journey is absent (pre-seed state)
 *
 *  3. POST /api/public/journeys/poly-contest/track:
 *     - returns 200 / tracked:true after seed (journey exists)
 *     - returns 404 when journey is absent (pre-seed state)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import type { Pool } from "pg";

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockDbExecute = vi.fn();
const mockDbSelect  = vi.fn();

vi.mock("@workspace/db", () => ({
  db: {
    execute: (...args: unknown[]) => mockDbExecute(...args),
    select: (...args: unknown[]) => mockDbSelect(...args),
    insert: vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
    }),
  },
  pool: { query: vi.fn().mockResolvedValue({ rows: [] }) },
  journeysTable:            Symbol("journeysTable"),
  clientsTable:             Symbol("clientsTable"),
  sequenceEnrollmentsTable: Symbol("sequenceEnrollmentsTable"),
  sequenceStepsTable:       Symbol("sequenceStepsTable"),
  emailSequencesTable:      Symbol("emailSequencesTable"),
}));

vi.mock("../lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../lib/scoringEngine", () => ({
  evaluateRoutingRules: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../lib/intentScoring", () => ({
  computeIntentScore: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../lib/objectStorage", () => ({
  ObjectStorageService: class { constructor() {} },
}));

vi.mock("../lib/stageUtils", () => ({
  STAGE_RANK: { "pre-aware": 0, aware: 1, "pre-engage": 2, engage: 3, "advance-engage": 4, action: 5 },
  computeSequentialStageAdvancement: vi.fn().mockReturnValue({ stagesToAdd: [] }),
}));

vi.mock("../lib/botDetection", () => ({
  classifyRequest: vi.fn().mockReturnValue({ isBot: false, reason: null }),
  CLICK_BOT_TIMING_WINDOW_SEC: 15,
}));

// ── Imports after mocks ──────────────────────────────────────────────────────

import publicJourneysRouter from "../routes/publicJourneys";
import { ensurePolyContestJourney } from "../lib/ensurePolyContestJourney";

// ── Helpers ──────────────────────────────────────────────────────────────────

function extractSqlText(query: unknown): string {
  if (typeof query === "string") return query;
  const obj = query as Record<string, unknown> | null;
  if (!obj || typeof obj !== "object") return "";
  const chunks = obj["queryChunks"];
  if (!Array.isArray(chunks)) return "";
  return chunks
    .map((c: unknown) => {
      if (!c || typeof c !== "object") return "";
      const ch = c as Record<string, unknown>;
      const val = ch["value"];
      if (Array.isArray(val)) return (val as unknown[]).filter(v => typeof v === "string").join("");
      if (typeof val === "string") return val;
      return "";
    })
    .join("");
}

/** Build a minimal mock pg Pool. */
function buildMockPool(queryImpl: (sql: string) => Promise<unknown>) {
  return {
    query: vi.fn().mockImplementation(queryImpl),
  } as unknown as Pool;
}

/** Captured-SQL helper. */
function capturePool(): { pool: Pool; capturedSql: () => string } {
  let captured = "";
  const pool = buildMockPool(async (sql) => {
    captured = sql;
    return { rows: [], rowCount: 0, command: "INSERT", oid: 0, fields: [] };
  });
  return { pool, capturedSql: () => captured };
}

const PUBLISHED_JOURNEY = {
  id: 13, tenantId: 1, clientId: 9, slug: "poly-contest", name: "Poly Contest",
  status: "published", startDate: null, endDate: null, theme: "light",
  navigationMode: "free", headerBtnText: "Book a Demo", headerBtnType: "url",
  headerBtnUrl: null, headerTagline: null, headerLogoUrl: null,
  headerLogoShowBg: true, viewerBg: null, scenarioVideos: null,
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
};

function makeSelectChain(resolvedValue: unknown[]) {
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(resolvedValue),
    }),
  };
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api", publicJourneysRouter);
  return app;
}

// ── 1. ensurePolyContestJourney unit tests ───────────────────────────────────

describe("ensurePolyContestJourney(pool)", () => {
  it("runs the CTE that resolves or creates the HP client then inserts the journey", async () => {
    const { pool, capturedSql } = capturePool();
    await ensurePolyContestJourney(pool);

    const sql = capturedSql();
    expect(sql).toMatch(/existing_hp/);
    expect(sql).toMatch(/new_hp/);
    expect(sql).toMatch(/hp_client/);
    expect(sql).toMatch(/LOWER\(name\)\s*=\s*'hp'/i);
    expect(sql).toMatch(/tenant_id\s*=\s*1/);
    expect(sql).toMatch(/INSERT INTO journeys/i);
    expect(sql).toMatch(/ON CONFLICT \(slug\) DO NOTHING/i);
    expect(sql).toMatch(/poly-contest/);
    expect(sql).toMatch(/published/);
  });

  it("includes an INSERT INTO clients branch for when no HP client exists", async () => {
    const { pool, capturedSql } = capturePool();
    await ensurePolyContestJourney(pool);
    const sql = capturedSql();
    // new_hp CTE must contain an INSERT INTO clients so the fallback branch runs
    expect(sql).toMatch(/INSERT INTO clients/i);
    expect(sql).toMatch(/new_hp/);
  });

  it("issues adoption UPDATE, then repair UPDATE, then the atomic CTE insert", async () => {
    const { pool } = capturePool();
    await ensurePolyContestJourney(pool);
    const calls = (pool.query as ReturnType<typeof vi.fn>).mock.calls;
    // 3 calls: adoption slug-rename → repair draft→published → CTE seed INSERT
    expect(calls).toHaveLength(3);
    expect(String(calls[0][0])).toMatch(/UPDATE journeys/i);
    expect(String(calls[0][0])).toMatch(/2-minute-meeting-rescue/);
    // Repair step: publishes poly-contest if it exists with wrong status
    expect(String(calls[1][0])).toMatch(/UPDATE journeys/i);
    expect(String(calls[1][0])).toMatch(/poly-contest/);
    expect(String(calls[1][0])).toMatch(/published/);
    expect(String(calls[2][0])).toMatch(/INSERT INTO journeys/i);
  });

  it("skips the insert when an existing contest journey is adopted", async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [{ id: 37 }] });
    const pool = { query } as unknown as Parameters<typeof ensurePolyContestJourney>[0];
    await ensurePolyContestJourney(pool);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("is non-fatal: resolves without throwing when pool.query rejects", async () => {
    const failPool = {
      query: vi.fn().mockRejectedValue(new Error("DB connection refused")),
    } as unknown as Pool;

    await expect(ensurePolyContestJourney(failPool)).resolves.toBeUndefined();
  });
});

// ── 2. GET /api/public/journeys/poly-contest ─────────────────────────────────

describe("GET /api/public/journeys/poly-contest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbExecute.mockResolvedValue({ rows: [] });
  });

  it("returns 200 with slug and name after seed (journey is published)", async () => {
    mockDbSelect.mockReturnValue(makeSelectChain([PUBLISHED_JOURNEY]));

    const app = buildApp();
    const res = await request(app).get("/api/public/journeys/poly-contest");

    expect(res.status).toBe(200);
    expect(res.body.slug).toBe("poly-contest");
    expect(res.body.name).toBe("Poly Contest");
  });

  it("returns 404 before seed (journey absent — pre-production state)", async () => {
    mockDbSelect.mockReturnValue(makeSelectChain([]));

    const app = buildApp();
    const res = await request(app).get("/api/public/journeys/poly-contest");

    expect(res.status).toBe(404);
  });
});

// ── 3. POST /api/public/journeys/poly-contest/track ──────────────────────────

describe("POST /api/public/journeys/poly-contest/track", () => {
  let journeyEventsInsertFired: boolean;

  beforeEach(() => {
    vi.clearAllMocks();
    journeyEventsInsertFired = false;

    mockDbExecute.mockImplementation(async (query: unknown) => {
      const sql = extractSqlText(query);
      if (sql.includes("INSERT INTO journey_events"))  { journeyEventsInsertFired = true; }
      if (sql.includes("INSERT INTO activity_events")) return { rows: [{ id: 999 }], rowCount: 1 };
      if (sql.includes("FROM contacts"))               return { rows: [{ id: 101, lead_score: 0, tags: [], stage: "pre-aware" }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
  });

  it("returns 200 / tracked:true after seed when journey exists", async () => {
    mockDbSelect.mockReturnValue(makeSelectChain([{ id: 13, tenantId: 1, slug: "poly-contest" }]));

    const app = buildApp();
    const res = await request(app)
      .post("/api/public/journeys/poly-contest/track")
      .send({
        event: "scenario_selected",
        cid: "101",
        visitorToken: "vt-seed-test",
        pageUrl: "https://kaboom-ai.com/poly-contest-rescue.html",
        props: { scenario: "airport" },
      });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.tracked).toBe(true);
    expect(journeyEventsInsertFired).toBe(true);
  });

  it("returns 404 before seed (journey absent — pre-production state)", async () => {
    mockDbSelect.mockReturnValue(makeSelectChain([]));

    const app = buildApp();
    const res = await request(app)
      .post("/api/public/journeys/poly-contest/track")
      .send({ event: "scenario_selected", visitorToken: "vt-seed-test" });

    expect(res.status).toBe(404);
    expect(journeyEventsInsertFired).toBe(false);
  });
});
