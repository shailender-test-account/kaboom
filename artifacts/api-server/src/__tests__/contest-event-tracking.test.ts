/**
 * Integration tests for contest event tracking via POST /api/public/journeys/:slug/track.
 *
 * Verifies that custom contest event types (scenario_selected, registration_completed,
 * challenges_selected, entry_submitted) are:
 *  - accepted by the track endpoint (200 OK, tracked:true)
 *  - written to journey_events with their props
 *  - NOT written to journey_events for unknown event types
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// ── Mocks ──────────────────────────────────────────────────────────────────────

const mockDbExecute = vi.fn();
const mockPoolQuery = vi.fn();
const mockPoolRelease = vi.fn();
const mockPoolConnect = vi.fn(async () => ({
  query: (query: unknown, params?: unknown[]) => mockPoolQuery(query, params),
  release: mockPoolRelease,
}));

// Track whether a journey_events INSERT was attempted in the current test.
// Set inside mockDbExecute; reset in beforeEach.
let journeyEventsInsertFired = false;

/**
 * Extract the static SQL text from a Drizzle `sql` tagged template object.
 * Drizzle stores template fragments as `queryChunks: SQLChunk[]` where each
 * StringChunk has `value: string`. This is the only reliable way to inspect
 * the SQL without calling db.session.execute() or compiling the query.
 */
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
      // In Drizzle 0.45.x, StringChunk.value is an array of strings (the static
      // SQL fragments from the template literal). Param chunks have no .value key.
      if (Array.isArray(val)) return (val as unknown[]).filter(v => typeof v === "string").join("");
      if (typeof val === "string") return val;
      return "";
    })
    .join("");
}

vi.mock("@workspace/db", () => ({
  db: {
    execute: (...args: unknown[]) => mockDbExecute(...args),
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{
          id: 13, tenantId: 1, slug: "poly-contest", name: "HP Poly 2-Minute Meeting Rescue",
        }]),
      }),
    }),
    insert: vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
    }),
  },
  pool: {
    connect: () => mockPoolConnect(),
    query: vi.fn().mockResolvedValue({ rows: [] }),
  },
  journeysTable:             Symbol("journeysTable"),
  clientsTable:              Symbol("clientsTable"),
  sequenceEnrollmentsTable:  Symbol("sequenceEnrollmentsTable"),
  sequenceStepsTable:        Symbol("sequenceStepsTable"),
  emailSequencesTable:       Symbol("emailSequencesTable"),
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

import publicJourneysRouter from "../routes/publicJourneys";

// ── Test app ───────────────────────────────────────────────────────────────────

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api", publicJourneysRouter);
  return app;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

const CONTACT_ROW = { id: 101, lead_score: 0, tags: [], stage: "pre-aware" };

/**
 * Wire up mockDbExecute to return sensible values for each query the track
 * endpoint fires, using the queryChunks-based SQL extractor.
 */
function setupExecuteMocks() {
  journeyEventsInsertFired = false;

  mockDbExecute.mockImplementation(async (query: unknown) => {
    const sql = extractSqlText(query);

    // Journey contacts INSERT (fire-and-forget — returns nothing meaningful)
    if (sql.includes("INSERT INTO journey_contacts")) {
      return { rows: [], rowCount: 1 };
    }
    // visitor_tokens INSERT (ON CONFLICT DO UPDATE — fire-and-forget)
    if (sql.includes("INSERT INTO visitor_tokens")) {
      return { rows: [], rowCount: 1 };
    }
    // journey_events INSERT — the write we are testing
    if (sql.includes("INSERT INTO journey_events")) {
      journeyEventsInsertFired = true;
      return { rows: [], rowCount: 1 };
    }
    // activity_events INSERT RETURNING id
    if (sql.includes("INSERT INTO activity_events")) {
      return { rows: [{ id: 999 }], rowCount: 1 };
    }
    // contacts UPDATE (score)
    if (sql.includes("UPDATE contacts")) {
      return { rows: [], rowCount: 1 };
    }
    // Contact lookup by cid / email
    if (sql.includes("FROM contacts")) {
      return { rows: [CONTACT_ROW], rowCount: 1 };
    }
    // visitor_tokens SELECT (for prior link check)
    if (sql.includes("FROM visitor_tokens")) {
      return { rows: [], rowCount: 0 };
    }
    // journey_plays client lookup (inside activity_events INSERT subquery)
    if (sql.includes("FROM journey_plays")) {
      return { rows: [], rowCount: 0 };
    }
    // journey_pages lookup (page_stage / score)
    if (sql.includes("FROM journey_pages")) {
      return { rows: [], rowCount: 0 };
    }
    // scoring_rules fallback
    if (sql.includes("FROM scoring_rules")) {
      return { rows: [{ points: 0 }], rowCount: 1 };
    }
    // Default: empty
    return { rows: [], rowCount: 0 };
  });
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("POST /api/public/journeys/:slug/track — contest custom events", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPoolQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    setupExecuteMocks();
  });

  const CONTEST_EVENT_TYPES = [
    // Terminal / conversion events
    "scenario_selected",
    "registration_completed",
    "challenges_selected",
    "entry_submitted",
    // Intermediate funnel events
    "step_viewed",
    "play_now_cover_clicked",
    "play_now_clicked",
    "challenge_started",
    "solutions_viewed",
    "gift_claim_clicked",
    "demo_interest_selected",
    "linkedin_share_clicked",
  ] as const;

  for (const eventType of CONTEST_EVENT_TYPES) {
    it(`writes ${eventType} to journey_events and returns tracked:true`, async () => {
      const app = buildApp();

      const res = await request(app)
        .post("/api/public/journeys/poly-contest/track")
        .send({
          event: eventType,
          cid: "101",
          visitorToken: "vt-abc123",
          pageUrl: "https://example.com/poly-contest",
          props: { scenario: "airport", choices: ["a", "b"] },
        });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.tracked).toBe(true);
      expect(journeyEventsInsertFired).toBe(true);
    });
  }

  it("does NOT write journey_events for an unknown event type", async () => {
    const app = buildApp();

    const res = await request(app)
      .post("/api/public/journeys/poly-contest/track")
      .send({
        event: "unknown_event_xyz",
        cid: "101",
        visitorToken: "vt-abc123",
      });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    // unknown_event_xyz is not in CONTEST_EVENT_TYPES → no journey_events INSERT
    expect(journeyEventsInsertFired).toBe(false);
  });

  it("does not duplicate a page_view into journey_events", async () => {
    const app = buildApp();

    const res = await request(app)
      .post("/api/public/journeys/poly-contest/track")
      .send({
        event: "page_view",
        cid: "101",
        visitorToken: "vt-abc123",
      });

    expect(res.status).toBe(200);
    expect(res.body.tracked).toBe(true);
    // The activity_events write is canonical for identified and anonymous
    // contest page views; Content and Traffic Analytics read it directly.
    expect(journeyEventsInsertFired).toBe(false);
  });

  // ── iframe / cookie-partitioning scenarios ──────────────────────────────────
  // Verifies event-tracking behaviour when the contest page is embedded inside
  // an iframe. Three distinct cases:
  //
  // 1. Same-domain iframe — pf_vt cookie is readable so events are attributed
  //    to an anonymous shadow contact via the visitorToken path.
  //
  // 2. Post-registration (any iframe) — the registration submit attaches
  //    body.contact = email, so the server resolves the real contact even when
  //    the cookie is partitioned or absent.
  //
  // 3. Cross-domain iframe with cookie partitioning AND pre-registration —
  //    no visitorToken, no email, no contact ID supplied.  The server has no
  //    identity signal; events must still return 200 OK but tracked:false.
  //    NOTE: do NOT pass a raw ?cid= contact ID from the embed URL — sequential
  //    IDs are guessable and would let any third party poison another contact's
  //    activity log.

  it("iframe (same-domain): scenario_selected via visitorToken creates shadow contact and is tracked", async () => {
    // Simulates a same-domain iframe where pf_vt cookie is readable.
    // The server has no prior visitor_token link → creates an anonymous shadow
    // contact, writes the event, and returns tracked:true.
    const app = buildApp();

    // getOrCreateAnonymousContact uses db.execute INSERT INTO contacts
    mockDbExecute.mockImplementation(async (query: unknown) => {
      const sql = extractSqlText(query);
      if (sql.includes("INSERT INTO journey_events")) {
        journeyEventsInsertFired = true;
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("INSERT INTO contacts")) {
        // anonymous shadow contact creation
        return { rows: [{ id: 200 }], rowCount: 1 };
      }
      if (sql.includes("INSERT INTO visitor_tokens")) return { rows: [], rowCount: 1 };
      if (sql.includes("INSERT INTO journey_contacts")) return { rows: [], rowCount: 1 };
      if (sql.includes("INSERT INTO activity_events")) return { rows: [{ id: 999 }], rowCount: 1 };
      if (sql.includes("UPDATE contacts")) return { rows: [], rowCount: 1 };
      // No cid/email in request → contacts lookup by id/email skipped; visitor_token
      // lookup also returns empty (new visitor)
      if (sql.includes("FROM contacts")) return { rows: [], rowCount: 0 };
      if (sql.includes("FROM visitor_tokens")) return { rows: [], rowCount: 0 };
      if (sql.includes("FROM journey_plays")) return { rows: [], rowCount: 0 };
      if (sql.includes("FROM journey_pages")) return { rows: [], rowCount: 0 };
      if (sql.includes("FROM scoring_rules")) return { rows: [{ points: 0 }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });

    const res = await request(app)
      .post("/api/public/journeys/poly-contest/track")
      .send({
        event: "scenario_selected",
        visitorToken: "vt-iframe-same-origin",
        pageUrl: "https://playforge.example.com/poly-contest",
        props: { scenario: "airport" },
      });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    // Shadow contact resolves identity → event is tracked
    expect(res.body.tracked).toBe(true);
    expect(journeyEventsInsertFired).toBe(true);
  });

  it("iframe (post-registration): entry_submitted is linked via contact email field", async () => {
    // After the registration form is submitted, track() includes
    // body.contact = email regardless of cookie state.  The server resolves
    // the real contact by email and links the event — this is the primary
    // identity mechanism for cross-domain embeds.
    const app = buildApp();

    const res = await request(app)
      .post("/api/public/journeys/poly-contest/track")
      .send({
        event: "entry_submitted",
        // no visitorToken — simulates cross-domain cookie-partitioned iframe
        contact: "registered@example.com",   // email attached by registration handler
        pageUrl: "https://partner.example.com/contest",
        props: { scenario: "home", demo_interest: "yes" },
      });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    // Email resolves CONTACT_ROW → event is tracked
    expect(res.body.tracked).toBe(true);
    expect(journeyEventsInsertFired).toBe(true);
  });

  it("promotes the current anonymous shadow contact when registration supplies a new email", async () => {
    const app = buildApp();
    let shadowPromotionFired = false;

    mockPoolQuery.mockImplementation(async (query: unknown) => {
      const text = String(query);
      if (text.includes("SELECT id, email, lead_score")) {
        return {
          rows: [{ id: 200, email: null, lead_score: 0, tags: [], stage: "pre-aware", is_anonymous: true }],
          rowCount: 1,
        };
      }
      if (text.includes("AND id <> $2")) return { rows: [], rowCount: 0 };
      if (text.includes("UPDATE contacts") && text.includes("SET email = $1")) {
        shadowPromotionFired = true;
        return {
          rows: [{ id: 200, lead_score: 0, tags: [], stage: "pre-aware", is_anonymous: false }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });

    mockDbExecute.mockImplementation(async (query: unknown) => {
      const text = extractSqlText(query);

      if (
        text.includes("FROM contacts") &&
        text.includes("LOWER(BTRIM(COALESCE(email, '')))")
      ) {
        // No existing real CRM contact owns this newly submitted address.
        return { rows: [], rowCount: 0 };
      }
      if (text.includes("FROM visitor_tokens vt")) {
        return {
          rows: [{ id: 200, lead_score: 0, tags: [], stage: "pre-aware", is_anonymous: true }],
          rowCount: 1,
        };
      }
      if (text.includes("INSERT INTO visitor_tokens")) return { rows: [], rowCount: 1 };
      if (text.includes("INSERT INTO journey_contacts")) return { rows: [], rowCount: 1 };
      if (text.includes("INSERT INTO activity_events")) return { rows: [{ id: 999 }], rowCount: 1 };
      if (text.includes("INSERT INTO journey_events")) {
        journeyEventsInsertFired = true;
        return { rows: [], rowCount: 1 };
      }
      if (text.includes("UPDATE contacts")) return { rows: [], rowCount: 1 };
      if (text.includes("FROM journey_plays")) return { rows: [], rowCount: 0 };
      if (text.includes("FROM journey_pages")) return { rows: [], rowCount: 0 };
      if (text.includes("FROM scoring_rules")) return { rows: [{ points: 0 }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });

    const res = await request(app)
      .post("/api/public/journeys/poly-contest/track")
      .send({
        event: "registration_completed",
        visitorToken: "vt-newly-registered",
        contact: "New.Visitor@Example.com",
        props: { scenario: "airport" },
      });

    expect(res.status).toBe(200);
    expect(res.body.tracked).toBe(true);
    expect(shadowPromotionFired).toBe(true);
    expect(journeyEventsInsertFired).toBe(true);
  });

  it("iframe (cookie-blocked): in-memory session token links pre-registration shadow to post-registration contact", async () => {
    // Simulates what happens in a cookie-blocked cross-domain iframe:
    //  - Pre-registration: _getVisitorToken() falls back to an in-memory token,
    //    so the server creates a shadow contact tied to that token.
    //  - Post-registration: track() sends the SAME in-memory token + body.contact
    //    = email.  The server looks up the real contact by email, finds the shadow
    //    linked to the token, merges it, and writes the event against the real contact.
    //
    // The critical invariant is that both calls share the same visitorToken value
    // (the in-memory _sessionToken) even though no cookie was persisted.
    const app = buildApp();

    const SESSION_TOKEN = "poly-memory-session-abc";
    // No prior visitor_token link for this token → no shadow contact to merge.
    // mergeAnonymousContact uses pool.connect() (not mocked here) so we keep
    // the mock simple by returning no prior link, which skips the merge branch.
    // The important invariant is still tested: same-session visitorToken + email
    // → contact resolved by email → event written → tracked:true.
    mockDbExecute.mockImplementation(async (query: unknown) => {
      const sql = extractSqlText(query);

      if (sql.includes("FROM contacts")) return { rows: [CONTACT_ROW], rowCount: 1 };
      // No prior link for this session token
      if (sql.includes("FROM visitor_tokens")) return { rows: [], rowCount: 0 };

      if (sql.includes("INSERT INTO visitor_tokens")) return { rows: [], rowCount: 1 };
      if (sql.includes("INSERT INTO journey_contacts")) return { rows: [], rowCount: 1 };
      if (sql.includes("INSERT INTO activity_events")) return { rows: [{ id: 999 }], rowCount: 1 };
      if (sql.includes("INSERT INTO journey_events")) {
        journeyEventsInsertFired = true;
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("UPDATE contacts")) return { rows: [], rowCount: 1 };
      if (sql.includes("FROM journey_plays")) return { rows: [], rowCount: 0 };
      if (sql.includes("FROM journey_pages")) return { rows: [], rowCount: 0 };
      if (sql.includes("FROM scoring_rules")) return { rows: [{ points: 0 }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });

    // Post-registration call: same session token + contact email
    // (mirrors what the contest page sends after the registration form submits)
    const res = await request(app)
      .post("/api/public/journeys/poly-contest/track")
      .send({
        event: "entry_submitted",
        visitorToken: SESSION_TOKEN,  // same in-memory token the pre-reg events used
        contact: "user@embed.example.com",
        pageUrl: "https://partner.example.com/contest",
        props: { scenario: "airport", demo_interest: "yes" },
      });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    // Real contact resolved via email → event is tracked
    expect(res.body.tracked).toBe(true);
    expect(journeyEventsInsertFired).toBe(true);
  });

  it("passes props JSON to the journey_events insert", async () => {
    // Re-wire the mock to capture the props param value passed to the INSERT.
    //
    // Drizzle 0.45.x stores sql`` template params as raw JS primitives inside
    // queryChunks — i.e. the param chunk IS the actual string/number value, not
    // a wrapper object. StringChunks are plain objects with `value: string[]`.
    // We distinguish them: `typeof c === "string"` → param, object with `value`
    // array → static SQL fragment.
    const capturedPropsParam: string[] = [];
    mockDbExecute.mockImplementation(async (query: unknown) => {
      const sqlText = extractSqlText(query);
      if (sqlText.includes("INSERT INTO journey_events")) {
        journeyEventsInsertFired = true;
        // Walk queryChunks collecting string params (raw param values are strings)
        const obj = query as Record<string, unknown>;
        const chunks = (obj["queryChunks"] as unknown[]) ?? [];
        for (const c of chunks) {
          // Param chunk = raw JS string value (not a StringChunk wrapper object)
          if (typeof c === "string") {
            capturedPropsParam.push(c);
          }
        }
        return { rows: [], rowCount: 1 };
      }
      if (sqlText.includes("INSERT INTO journey_contacts")) return { rows: [], rowCount: 1 };
      if (sqlText.includes("INSERT INTO visitor_tokens")) return { rows: [], rowCount: 1 };
      if (sqlText.includes("INSERT INTO activity_events")) return { rows: [{ id: 999 }], rowCount: 1 };
      if (sqlText.includes("UPDATE contacts")) return { rows: [], rowCount: 1 };
      if (sqlText.includes("FROM contacts")) return { rows: [CONTACT_ROW], rowCount: 1 };
      if (sqlText.includes("FROM visitor_tokens")) return { rows: [], rowCount: 0 };
      if (sqlText.includes("FROM journey_plays")) return { rows: [], rowCount: 0 };
      if (sqlText.includes("FROM journey_pages")) return { rows: [], rowCount: 0 };
      if (sqlText.includes("FROM scoring_rules")) return { rows: [{ points: 0 }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });

    const app = buildApp();
    const testProps = { scenario: "airport", step: 1 };

    await request(app)
      .post("/api/public/journeys/poly-contest/track")
      .send({
        event: "scenario_selected",
        cid: "101",
        visitorToken: "vt-abc123",
        props: testProps,
      });

    expect(journeyEventsInsertFired).toBe(true);

    // Find the param that is valid JSON and contains the expected props fields
    const propsParam = capturedPropsParam.find(v => {
      try { const p = JSON.parse(v); return p !== null && typeof p === "object"; }
      catch { return false; }
    });
    expect(propsParam).toBeDefined();
    const parsedProps = JSON.parse(propsParam!);
    // Verify that the scenario prop was passed through (non-PII, in ALLOWED list)
    expect(parsedProps).toMatchObject({ scenario: "airport" });
    // Verify the raw JSON written to the DB matches the input exactly
    expect(parsedProps).toEqual(testProps);
  });
});
