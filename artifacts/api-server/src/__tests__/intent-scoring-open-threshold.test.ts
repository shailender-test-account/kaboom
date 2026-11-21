/**
 * Unit tests for maybeAdvanceToAware — email open threshold fallback.
 *
 * Verifies that a contact stuck at pre-aware is advanced to 'aware' when they
 * have ≥ 3 email_open events and no email_click events.  Also verifies that:
 *  - fewer than 3 opens do NOT trigger advancement
 *  - a click (even with opens < threshold) still triggers advancement
 *  - the reason stored in contact_stage_history distinguishes the two paths
 *  - contacts already past pre-aware are left alone
 */
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

// ── Mock all external deps before importing the module under test ──────────────

const mockPoolQuery = vi.fn();
const mockDbExecute = vi.fn();

vi.mock("@workspace/db", () => ({
  db:   { execute: (...args: unknown[]) => mockDbExecute(...args) },
  pool: { query: (...args: unknown[]) => mockPoolQuery(...args) },
}));

vi.mock("../lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../lib/scoringEngine", () => ({
  evaluateRoutingRules: vi.fn().mockResolvedValue(undefined),
}));

import { computeIntentScore } from "../lib/intentScoring";

// ── Helpers ────────────────────────────────────────────────────────────────────

const CONTACT_ID = 7;
const TENANT_ID  = 1;

/** ISO timestamp N days ago */
function daysAgo(n: number) {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
}

type EventRow = {
  event_type: string;
  score_delta: number | null;
  stage: string | null;
  created_at: string;
  duration_seconds: number | null;
  metadata: null;
};

function makeOpenEvent(daysBack = 1): EventRow {
  return {
    event_type: "email_open",
    score_delta: 3,
    stage: null,
    created_at: daysAgo(daysBack),
    duration_seconds: null,
    metadata: null,
  };
}

function makeClickEvent(daysBack = 1): EventRow {
  return {
    event_type: "email_click",
    score_delta: 8,
    stage: "aware",
    created_at: daysAgo(daysBack),
    duration_seconds: null,
    metadata: null,
  };
}

/**
 * Wire up mockDbExecute and mockPoolQuery for a contact in pre-aware stage
 * with the supplied event history.
 */
function setupMocks(events: EventRow[], stage: string | null = null) {
  mockDbExecute.mockImplementation((sqlObj: unknown) => {
    const raw = String((sqlObj as any)?.queryChunks?.map((c: any) => c.value ?? "").join("") ?? sqlObj);

    // evtRows query
    if (raw.includes("activity_events")) {
      return Promise.resolve({ rows: events });
    }
    // contact query (tags + stage + company_id)
    if (raw.includes("FROM contacts")) {
      return Promise.resolve({ rows: [{ tags: [], stage, company_id: null }] });
    }
    // intent_state / intent_score pre-read inside persistIntentResult
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
    // Atomic CTE: UPDATE contacts + INSERT INTO contact_stage_history in one query
    if (s.startsWith("WITH advanced AS")) {
      return Promise.resolve({ rowCount: 1, rows: [] });
    }
    // Company-colleague count
    if (s.includes("active_colleagues")) {
      return Promise.resolve({ rows: [{ active_colleagues: 0 }] });
    }
    return Promise.resolve({ rows: [], rowCount: 0 });
  });
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("maybeAdvanceToAware — email open threshold", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does NOT advance when open count is below the threshold (< 3)", async () => {
    setupMocks([makeOpenEvent(3), makeOpenEvent(2)], null); // 2 opens, no clicks

    await computeIntentScore(CONTACT_ID, TENANT_ID);

    const calls: string[] = (mockPoolQuery as Mock).mock.calls.map(([sql]: [string]) => sql.trim());
    const cteCall = calls.find(s => s.startsWith("WITH advanced AS"));
    expect(cteCall).toBeUndefined();
  });

  it("advances when open count meets the threshold (≥ 3) and no clicks", async () => {
    setupMocks([makeOpenEvent(5), makeOpenEvent(3), makeOpenEvent(1)], null); // 3 opens

    await computeIntentScore(CONTACT_ID, TENANT_ID);

    const calls: string[] = (mockPoolQuery as Mock).mock.calls.map(([sql]: [string]) => sql.trim());
    const cteCall = calls.find(s => s.startsWith("WITH advanced AS"));
    expect(cteCall).toBeDefined();
  });

  it("stores the open-threshold reason in the CTE query params", async () => {
    setupMocks([makeOpenEvent(5), makeOpenEvent(3), makeOpenEvent(1)], null);

    await computeIntentScore(CONTACT_ID, TENANT_ID);

    // The CTE query params are: [$1=contactId, $2=tenantId, $3=activityEventId, $4=reason]
    // reason is now at index 3 (param $4) after activity_event_id was added as $3.
    const calls = (mockPoolQuery as Mock).mock.calls as Array<[string, unknown[]]>;
    const cteCall = calls.find(([sql]) => sql.trim().startsWith("WITH advanced AS"));
    expect(cteCall).toBeDefined();

    const reason = cteCall![1][3];
    expect(typeof reason).toBe("string");
    expect(reason as string).toMatch(/open threshold/);
    expect(reason as string).not.toMatch(/advanced via click/);
  });

  it("advances via click path (not open threshold) when a click exists", async () => {
    // 1 click + 2 opens — click wins even though opens < threshold
    setupMocks([makeOpenEvent(3), makeOpenEvent(2), makeClickEvent(1)], null);

    await computeIntentScore(CONTACT_ID, TENANT_ID);

    const calls = (mockPoolQuery as Mock).mock.calls as Array<[string, unknown[]]>;
    const cteCall = calls.find(([sql]) => sql.trim().startsWith("WITH advanced AS"));
    expect(cteCall).toBeDefined();

    // reason is now at index 3 (param $4) after activity_event_id was added as $3.
    const reason = cteCall![1][3] as string;
    expect(reason).toMatch(/click/);
    expect(reason).not.toMatch(/open threshold/);
  });

  it("does NOT advance when the contact is already past pre-aware", async () => {
    setupMocks(
      [makeOpenEvent(5), makeOpenEvent(4), makeOpenEvent(3)],
      "aware", // already advanced
    );

    await computeIntentScore(CONTACT_ID, TENANT_ID);

    const calls: string[] = (mockPoolQuery as Mock).mock.calls.map(([sql]: [string]) => sql.trim());
    const cteCall = calls.find(s => s.startsWith("WITH advanced AS"));
    expect(cteCall).toBeUndefined();
  });

  it("advances with exactly 3 opens (boundary value)", async () => {
    setupMocks(
      [makeOpenEvent(7), makeOpenEvent(5), makeOpenEvent(2)],
      null,
    );

    await computeIntentScore(CONTACT_ID, TENANT_ID);

    const calls: string[] = (mockPoolQuery as Mock).mock.calls.map(([sql]: [string]) => sql.trim());
    const cteCall = calls.find(s => s.startsWith("WITH advanced AS"));
    expect(cteCall).toBeDefined();
  });
});
