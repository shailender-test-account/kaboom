/**
 * Integration tests for GET /api/public/click/:token — deleted/unpublished journey guard.
 *
 * Verifies that:
 *  - a valid click token for a deleted journey returns a 404 HTML page with a clear message
 *    rather than silently redirecting to / or /j/<slug>
 *  - a valid click token for a published journey still redirects to /j/<slug>
 *  - the 404 is returned for both the human path AND the bot-classified path
 */
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import express from "express";
import cookieParser from "cookie-parser";
import request from "supertest";

// ── Mock external dependencies before importing the router ─────────────────────

const mockPoolQuery = vi.fn();

vi.mock("@workspace/db", () => ({
  db: {
    execute: vi.fn().mockResolvedValue({ rows: [] }),
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }),
    }),
    insert: vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) }),
    update: vi.fn().mockReturnValue({ set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }) }),
  },
  pool: { query: (...args: unknown[]) => mockPoolQuery(...args) },
  journeysTable: Symbol("journeysTable"),
  clientsTable: Symbol("clientsTable"),
  sequenceEnrollmentsTable: Symbol("sequenceEnrollmentsTable"),
  sequenceStepsTable: Symbol("sequenceStepsTable"),
  emailSequencesTable: Symbol("emailSequencesTable"),
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
  ObjectStorageService: class {
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    constructor() {}
  },
}));

vi.mock("../lib/stageUtils", () => ({
  STAGE_RANK: { "pre-aware": 0, aware: 1, "pre-engage": 2, engage: 3, "advance-engage": 4, action: 5 },
  computeSequentialStageAdvancement: vi.fn().mockReturnValue({ stagesToAdd: [] }),
}));

vi.mock("../lib/botDetection", () => ({
  classifyRequest: vi.fn().mockReturnValue({ isBot: false, reason: null }),
  CLICK_BOT_TIMING_WINDOW_SEC: 15,
}));

import publicJourneysRouter from "../routes/publicJourneys";
import { generateClickToken } from "../services/email";
import { classifyRequest } from "../lib/botDetection";

// ── Test app ───────────────────────────────────────────────────────────────────

function buildApp() {
  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use("/api", publicJourneysRouter);
  return app;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Configure mockPoolQuery to return different values based on the SQL string.
 * Journey-existence query → rows argument; all other queries → default empty.
 */
function setupPoolMocks({
  journeyExists,
}: {
  journeyExists: boolean;
}) {
  (mockPoolQuery as Mock).mockImplementation(async (sql: string) => {
    // Journey existence check
    if (sql.includes("FROM journeys WHERE slug")) {
      return { rows: journeyExists ? [{ id: 42 }] : [] };
    }
    // Honeypot / bot_sessions check
    if (sql.includes("FROM bot_sessions")) {
      return { rows: [] };
    }
    // scoring_rules for click points
    if (sql.includes("FROM scoring_rules")) {
      return { rows: [] };
    }
    // activity_events INSERT RETURNING id
    if (sql.includes("INSERT INTO activity_events")) {
      return { rows: [{ id: 1 }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
}

describe("GET /api/public/click/:token — deleted-journey 404 guard", () => {
  const CONTACT_ID = 7;
  const TENANT_ID = 1;

  beforeEach(() => {
    vi.clearAllMocks();
    // Default: human request (not bot)
    (classifyRequest as Mock).mockReturnValue({ isBot: false, reason: null });
  });

  it("returns 404 with a clear message when the journey slug no longer exists (human path)", async () => {
    setupPoolMocks({ journeyExists: false });
    const token = generateClickToken(CONTACT_ID, TENANT_ID, "deleted-slug");
    const app = buildApp();

    const res = await request(app).get(`/api/public/click/${token}`);

    expect(res.status).toBe(404);
    expect(res.text).toContain("no longer available");
    // Must NOT redirect to the journey
    expect(res.headers.location).toBeUndefined();
  });

  it("returns 404 with a clear message when the journey slug no longer exists (bot-classified path)", async () => {
    setupPoolMocks({ journeyExists: false });
    // Classify request as a bot
    (classifyRequest as Mock).mockReturnValue({ isBot: true, reason: "timing" });
    const token = generateClickToken(CONTACT_ID, TENANT_ID, "deleted-slug");
    const app = buildApp();

    const res = await request(app).get(`/api/public/click/${token}`);

    expect(res.status).toBe(404);
    expect(res.text).toContain("no longer available");
    expect(res.headers.location).toBeUndefined();
  });

  it("redirects to /j/<slug> when the journey is published (human path)", async () => {
    setupPoolMocks({ journeyExists: true });
    const token = generateClickToken(CONTACT_ID, TENANT_ID, "live-slug");
    const app = buildApp();

    const res = await request(app).get(`/api/public/click/${token}`);

    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/\/j\/live-slug/);
  });

  it("returns 302 to /j/<slug> when the journey is published (bot path)", async () => {
    setupPoolMocks({ journeyExists: true });
    (classifyRequest as Mock).mockReturnValue({ isBot: true, reason: "timing" });
    const token = generateClickToken(CONTACT_ID, TENANT_ID, "live-slug");
    const app = buildApp();

    const res = await request(app).get(`/api/public/click/${token}`);

    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/\/j\/live-slug/);
  });

  it("returns a redirect to / for a completely invalid (tampered) token", async () => {
    const app = buildApp();
    const res = await request(app).get("/api/public/click/not-a-valid-token.abc");
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/");
  });
});
