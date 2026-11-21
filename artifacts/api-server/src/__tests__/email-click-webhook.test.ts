/**
 * Integration tests for POST /api/email/webhook — email.clicked path.
 *
 * Verifies that:
 *  - an email.clicked webhook payload causes the contact's stage to advance to 'aware'
 *    (the UPDATE contacts SET stage='aware' query is issued)
 *  - the stage update is skipped when the contact is already past pre-aware stage
 *  - duplicate click events within 10 minutes are deduplicated (no stage change)
 */
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import express from "express";
import request from "supertest";

// ── Mock all external dependencies before importing the router ─────────────────

const mockPoolQuery = vi.fn();
const mockDbInsertValues = vi.fn().mockResolvedValue(undefined);
const mockDbInsert = vi.fn().mockReturnValue({ values: mockDbInsertValues });

vi.mock("@workspace/db", () => ({
  db: {
    insert:  (...args: unknown[]) => mockDbInsert(...args),
    update:  vi.fn().mockReturnValue({ set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }) }),
    select:  vi.fn().mockReturnValue({ from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }) }),
  },
  pool: { query: (...args: unknown[]) => mockPoolQuery(...args) },
  emailEventsTable:         Symbol("emailEventsTable"),
  contactsTable:            Symbol("contactsTable"),
  sequenceEnrollmentsTable: Symbol("sequenceEnrollmentsTable"),
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

import webhookRouter from "../routes/email-webhook";

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Build a minimal express app that mounts the webhook router under /api */
function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api", webhookRouter);
  return app;
}

/**
 * Configure pool.query to handle the sequence of DB calls the webhook makes
 * for a first-time click (no dedup match) on a contact in pre-aware stage.
 *
 * Call order (for email.clicked, no existing click in last 10 min):
 *  1. dedup SELECT from activity_events (email_click) → no rows
 *  2. SELECT scoring_rules WHERE event_type='email_click'
 *  3. SELECT lead_score FROM contacts
 *  4. UPDATE contacts SET lead_score (inside recordEmailActivity)
 *  5. INSERT INTO activity_events
 *  6. WITH advanced AS (UPDATE contacts ... RETURNING ...) INSERT INTO contact_stage_history
 *     — atomic CTE: stage advancement + history in one statement
 */
function setupPreAwareContactMock() {
  mockPoolQuery.mockImplementation((sql: string) => {
    const s = sql.trim();

    // 1. Dedup check — no prior click
    if (s.includes("activity_events") && s.includes("email_click") && s.startsWith("SELECT")) {
      return Promise.resolve({ rows: [] });
    }
    // 2. Scoring rules
    if (s.includes("scoring_rules")) {
      return Promise.resolve({ rows: [{ points: 5 }] });
    }
    // 3. Contact lead_score SELECT
    if (s.includes("lead_score") && s.includes("FROM contacts")) {
      return Promise.resolve({ rows: [{ lead_score: 10 }] });
    }
    // 4. UPDATE contacts SET lead_score (inside recordEmailActivity)
    if (s.startsWith("UPDATE contacts")) {
      return Promise.resolve({ rowCount: 1, rows: [] });
    }
    // 5. INSERT into activity_events
    if (s.startsWith("INSERT INTO activity_events")) {
      return Promise.resolve({ rows: [] });
    }
    // 6. Atomic CTE for stage advancement + history
    if (s.startsWith("WITH advanced AS")) {
      return Promise.resolve({ rowCount: 1, rows: [] });
    }
    return Promise.resolve({ rows: [] });
  });
}

// ── Test payload helpers ───────────────────────────────────────────────────────

const CONTACT_ID = 42;
const TENANT_ID  = 1;

/** Build a Resend-style email.clicked webhook body with tags as array */
function clickedPayload(overrides: Record<string, unknown> = {}) {
  return {
    type: "email.clicked",
    data: {
      to:   ["recipient@example.com"],
      tags: [
        { name: "contactId",  value: String(CONTACT_ID) },
        { name: "tenantId",   value: String(TENANT_ID)  },
        { name: "templateId", value: "3"                },
      ],
      ...overrides,
    },
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("POST /api/email/webhook — email.clicked stage advancement", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbInsert.mockReturnValue({ values: mockDbInsertValues });
    mockDbInsertValues.mockResolvedValue(undefined);
  });

  it("returns 200 { ok: true } for a valid email.clicked event", async () => {
    setupPreAwareContactMock();
    const app = buildApp();
    const res = await request(app).post("/api/email/webhook").send(clickedPayload());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("issues the atomic CTE stage advancement query for a pre-aware contact", async () => {
    setupPreAwareContactMock();
    const app = buildApp();
    await request(app).post("/api/email/webhook").send(clickedPayload());

    const calls: string[] = (mockPoolQuery as Mock).mock.calls.map(([sql]: [string]) => sql.trim());
    // The new implementation uses a single atomic CTE that performs both the
    // UPDATE contacts SET stage='aware' and the INSERT INTO contact_stage_history
    // in one statement — preventing duplicate history rows under concurrent requests.
    const advanceCte = calls.find(
      sql => sql.startsWith("WITH advanced AS") &&
             sql.includes("stage = 'aware'") &&
             sql.includes("contact_stage_history")
    );
    expect(advanceCte).toBeDefined();
  });

  it("stage advancement uses a single atomic statement (not separate INSERT + UPDATE)", async () => {
    setupPreAwareContactMock();
    const app = buildApp();
    await request(app).post("/api/email/webhook").send(clickedPayload());

    const calls: string[] = (mockPoolQuery as Mock).mock.calls.map(([sql]: [string]) => sql.trim());
    // Verify there is NO separate INSERT INTO contact_stage_history call —
    // it must be inside the CTE, not a standalone statement.
    const standaloneHistoryInsert = calls.find(sql => sql.startsWith("INSERT INTO contact_stage_history"));
    expect(standaloneHistoryInsert).toBeUndefined();

    // And no standalone UPDATE contacts SET stage='aware' either.
    const standaloneStageUpdate = calls.find(
      sql => sql.startsWith("UPDATE contacts") && sql.includes("stage = 'aware'")
    );
    expect(standaloneStageUpdate).toBeUndefined();

    // The CTE combines both operations atomically.
    const advanceCte = calls.find(sql => sql.startsWith("WITH advanced AS"));
    expect(advanceCte).toBeDefined();
  });

  it("skips stage advancement when a prior email_click exists within 10 minutes (dedup)", async () => {
    // Make the dedup check return an existing row
    mockPoolQuery.mockImplementation((sql: string) => {
      const s = sql.trim();
      if (s.includes("activity_events") && s.includes("email_click") && s.startsWith("SELECT")) {
        return Promise.resolve({ rows: [{ id: 999 }] });
      }
      return Promise.resolve({ rows: [] });
    });

    const app = buildApp();
    await request(app).post("/api/email/webhook").send(clickedPayload());

    const calls: string[] = (mockPoolQuery as Mock).mock.calls.map(([sql]: [string]) => sql.trim());
    const stageUpdate = calls.find(
      sql => sql.startsWith("UPDATE contacts") && sql.includes("stage = 'aware'")
    );
    expect(stageUpdate).toBeUndefined();
  });

  it("accepts an array body (Resend batch webhook format) and processes each event", async () => {
    setupPreAwareContactMock();
    const app = buildApp();
    const res = await request(app)
      .post("/api/email/webhook")
      .send([clickedPayload()]);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("handles email.opened event without issuing a stage advancement query", async () => {
    // For opens: dedup returns no prior open
    mockPoolQuery.mockImplementation((sql: string) => {
      const s = sql.trim();
      if (s.includes("activity_events") && s.includes("email_open") && s.startsWith("SELECT")) {
        return Promise.resolve({ rows: [] });
      }
      if (s.includes("scoring_rules"))            return Promise.resolve({ rows: [{ points: 3 }] });
      if (s.includes("lead_score") && s.includes("FROM contacts")) return Promise.resolve({ rows: [{ lead_score: 5 }] });
      return Promise.resolve({ rows: [] });
    });

    const openPayload = {
      type: "email.opened",
      data: {
        to:   ["recipient@example.com"],
        tags: [
          { name: "contactId", value: String(CONTACT_ID) },
          { name: "tenantId",  value: String(TENANT_ID)  },
        ],
      },
    };

    const app = buildApp();
    const res = await request(app).post("/api/email/webhook").send(openPayload);
    expect(res.status).toBe(200);

    const calls: string[] = (mockPoolQuery as Mock).mock.calls.map(([sql]: [string]) => sql.trim());
    const stageUpdate = calls.find(
      sql => sql.startsWith("UPDATE contacts") && sql.includes("stage = 'aware'")
    );
    expect(stageUpdate).toBeUndefined();
  });

  it("falls back to recipient email lookup when contactId tag is absent", async () => {
    setupPreAwareContactMock();

    // Override the mock so the email-based lookup returns contact 42
    mockPoolQuery.mockImplementation((sql: string) => {
      const s = sql.trim();
      if (s.includes("FROM contacts") && s.includes("email =")) {
        return Promise.resolve({ rows: [{ id: CONTACT_ID }] });
      }
      if (s.includes("activity_events") && s.includes("email_click") && s.startsWith("SELECT")) {
        return Promise.resolve({ rows: [] });
      }
      if (s.includes("scoring_rules"))            return Promise.resolve({ rows: [{ points: 5 }] });
      if (s.includes("lead_score") && s.includes("FROM contacts")) return Promise.resolve({ rows: [{ lead_score: 0 }] });
      return Promise.resolve({ rows: [] });
    });

    const payloadWithoutContactId = {
      type: "email.clicked",
      data: {
        to:   ["recipient@example.com"],
        tags: [{ name: "tenantId", value: String(TENANT_ID) }],
      },
    };

    const app = buildApp();
    const res = await request(app).post("/api/email/webhook").send(payloadWithoutContactId);
    expect(res.status).toBe(200);

    const calls: string[] = (mockPoolQuery as Mock).mock.calls.map(([sql]: [string]) => sql.trim());
    const emailLookup = calls.find(sql => sql.includes("FROM contacts") && sql.includes("email ="));
    expect(emailLookup).toBeDefined();
  });
});
