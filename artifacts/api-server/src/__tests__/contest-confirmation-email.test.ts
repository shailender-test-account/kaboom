/**
 * Tests for POST /contest/entries — confirmation email behaviour.
 *
 * Covers:
 *  1. First submission → entry saved (201) + email sent
 *  2. Second submission for same address in dedup window → entry still saved (201)
 *     but email suppressed (claim INSERT returns no rows)
 *  3. Concurrent submissions for the same address → only the winner sends
 *  4. Email send failure → entry still saved and 201 returned
 *  5. Claim DB failure → fail-open: email still sent
 *  6. HTML-injection in name/scenario → special characters are escaped in email HTML
 */

import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import express from "express";
import request from "supertest";

// ── Mock external dependencies before importing the router ────────────────────

const mockPoolQuery = vi.fn();

vi.mock("@workspace/db", () => ({
  pool: { query: (...args: unknown[]) => mockPoolQuery(...args) },
}));

vi.mock("../lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
  requireRole: (..._roles: string[]) =>
    (_req: unknown, _res: unknown, next: () => void) => next(),
}));

const mockSendEmail = vi.fn();
vi.mock("../services/email", () => ({
  sendEmail: (...args: unknown[]) => mockSendEmail(...args),
}));

import contestRouter, { _resetIpBucketsForTesting, isCampaignClosed } from "../routes/contest";

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api", contestRouter);
  return app;
}

const VALID_BODY = {
  name: "Jane Smith",
  org: "Acme Corp",
  designation: "IT Manager",
  email: "jane@example.com",
  mobile: "+1-555-0100",
  scenario: "airport",
  challenges: ["bg_noise"],
};

/**
 * Configure pool.query so:
 *  - INSERT INTO contest_entries → returns a fake row
 *  - INSERT INTO contest_confirmation_claims (claimWins=true) → returns the claimed row
 *  - INSERT INTO contest_confirmation_claims (claimWins=false) → returns no rows (conflict)
 */
function setupMocks({ claimWins = true }: { claimWins?: boolean } = {}) {
  mockPoolQuery.mockImplementation((sql: string) => {
    const s = (sql as string).trim();

    // Entry insert
    if (s.includes("INSERT INTO contest_entries")) {
      return Promise.resolve({
        rows: [{ id: 1, submitted_at: new Date().toISOString() }],
      });
    }
    // Confirmation claim insert
    if (s.includes("contest_confirmation_claims")) {
      return Promise.resolve({
        rows: claimWins ? [{ email_normalized: "jane@example.com" }] : [],
      });
    }
    return Promise.resolve({ rows: [] });
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  mockSendEmail.mockResolvedValue(true);
  // Reset the in-memory IP rate-limiter so each test starts with a clean slate
  _resetIpBucketsForTesting();
});

describe("POST /api/contest/entries — confirmation email", () => {
  it("returns 201 and sends a confirmation email for a valid first submission", async () => {
    setupMocks({ claimWins: true });

    const res = await request(buildApp())
      .post("/api/contest/entries")
      .send(VALID_BODY);

    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);

    // Give the fire-and-forget promise a tick to settle
    await new Promise(r => setTimeout(r, 10));

    expect(mockSendEmail).toHaveBeenCalledOnce();
    const [opts] = mockSendEmail.mock.calls[0] as any[];
    expect(opts.to).toBe(VALID_BODY.email);
    expect(opts.fromName).toBe("HP Poly");
    expect(opts.skipUnsubscribeFooter).toBe(true);
    expect(opts.subject).toContain("2-Minute Meeting Rescue");
  });

  it("returns 201 but suppresses the email when the dedup claim is already held", async () => {
    setupMocks({ claimWins: false }); // ON CONFLICT DO NOTHING → no rows returned

    const res = await request(buildApp())
      .post("/api/contest/entries")
      .send(VALID_BODY);

    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);

    await new Promise(r => setTimeout(r, 10));

    // Entry was still saved but email must NOT be sent
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it("returns 201 even when sendEmail fails", async () => {
    setupMocks({ claimWins: true });
    mockSendEmail.mockResolvedValue(false); // simulates provider rejection

    const res = await request(buildApp())
      .post("/api/contest/entries")
      .send(VALID_BODY);

    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
  });

  it("returns 201 and sends when the claim DB call throws (fail-open)", async () => {
    // Entry insert succeeds; claim insert rejects with a DB error
    mockPoolQuery.mockImplementation((sql: string) => {
      const s = (sql as string).trim();
      if (s.includes("INSERT INTO contest_entries")) {
        return Promise.resolve({
          rows: [{ id: 2, submitted_at: new Date().toISOString() }],
        });
      }
      if (s.includes("contest_confirmation_claims")) {
        return Promise.reject(new Error("DB connection lost"));
      }
      return Promise.resolve({ rows: [] });
    });

    const res = await request(buildApp())
      .post("/api/contest/entries")
      .send(VALID_BODY);

    expect(res.status).toBe(201);

    await new Promise(r => setTimeout(r, 10));

    // Fail-open: email should still fire despite DB error on the claim
    expect(mockSendEmail).toHaveBeenCalledOnce();
  });

  it("HTML-escapes a hostile name before interpolating it into the email body", async () => {
    setupMocks({ claimWins: true });

    const xssName = '<script>alert("xss")</script>';
    await request(buildApp())
      .post("/api/contest/entries")
      .send({ ...VALID_BODY, name: xssName });

    await new Promise(r => setTimeout(r, 10));

    expect(mockSendEmail).toHaveBeenCalledOnce();
    const [opts] = mockSendEmail.mock.calls[0] as any[];
    // The raw script tag must not appear verbatim in the email HTML
    expect(opts.html).not.toContain("<script>");
    // The escaped version should be present instead
    expect(opts.html).toContain("&lt;script&gt;");
  });

  it("HTML-escapes an unrecognised scenario string used in the fallback title", async () => {
    setupMocks({ claimWins: true });

    const xssScenario = '"><img src=x onerror=alert(1)>';
    await request(buildApp())
      .post("/api/contest/entries")
      .send({ ...VALID_BODY, scenario: xssScenario });

    await new Promise(r => setTimeout(r, 10));

    expect(mockSendEmail).toHaveBeenCalledOnce();
    const [opts] = mockSendEmail.mock.calls[0] as any[];
    expect(opts.html).not.toContain("<img src=x");
    expect(opts.html).toContain("&gt;");
  });

  it("returns 201 and does not crash when sendEmail itself throws (fire-and-forget rejection)", async () => {
    setupMocks({ claimWins: true });
    // Simulate sendEmail rejecting with a network error
    mockSendEmail.mockRejectedValue(new Error("network timeout"));

    const res = await request(buildApp())
      .post("/api/contest/entries")
      .send(VALID_BODY);

    // The entry must still be saved and 201 returned
    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);

    // Wait for the fire-and-forget promise chain to settle
    await new Promise(r => setTimeout(r, 20));

    // sendEmail was called (and threw), but the server did not crash — the
    // outer .catch() swallows the rejection and logs it instead
    expect(mockSendEmail).toHaveBeenCalledOnce();
  });

  it("returns 410 and does not save an entry or send an email after the campaign ends", async () => {
    setupMocks({ claimWins: true });
    // Set a deadline firmly in the past
    process.env.CONTEST_END_DATE = "2000-01-01T00:00:00Z";

    const res = await request(buildApp())
      .post("/api/contest/entries")
      .send(VALID_BODY);

    expect(res.status).toBe(410);
    expect(res.body.error).toMatch(/contest has ended/i);

    await new Promise(r => setTimeout(r, 10));

    // No DB insert, no email
    expect(mockPoolQuery).not.toHaveBeenCalled();
    expect(mockSendEmail).not.toHaveBeenCalled();

    delete process.env.CONTEST_END_DATE;
  });

  it("returns 201 normally when CONTEST_END_DATE is in the future", async () => {
    setupMocks({ claimWins: true });
    // Set a deadline firmly in the future
    process.env.CONTEST_END_DATE = "2099-12-31T23:59:59Z";

    const res = await request(buildApp())
      .post("/api/contest/entries")
      .send(VALID_BODY);

    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);

    await new Promise(r => setTimeout(r, 10));
    expect(mockSendEmail).toHaveBeenCalledOnce();

    delete process.env.CONTEST_END_DATE;
  });

  it("returns 201 normally when CONTEST_END_DATE is not set", async () => {
    setupMocks({ claimWins: true });
    delete process.env.CONTEST_END_DATE;

    const res = await request(buildApp())
      .post("/api/contest/entries")
      .send(VALID_BODY);

    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
  });

  it("ignores an unparseable CONTEST_END_DATE and accepts the entry (gate disabled)", async () => {
    setupMocks({ claimWins: true });
    process.env.CONTEST_END_DATE = "not-a-date";

    const res = await request(buildApp())
      .post("/api/contest/entries")
      .send(VALID_BODY);

    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);

    delete process.env.CONTEST_END_DATE;
  });

  it("concurrent claims — only the first INSERT winner sends the email", async () => {
    // Simulate two simultaneous requests: the first claim wins, the second loses.
    let claimCallCount = 0;
    mockPoolQuery.mockImplementation((sql: string) => {
      const s = (sql as string).trim();
      if (s.includes("INSERT INTO contest_entries")) {
        return Promise.resolve({
          rows: [{ id: claimCallCount + 10, submitted_at: new Date().toISOString() }],
        });
      }
      if (s.includes("contest_confirmation_claims")) {
        claimCallCount++;
        // First claim wins; second is a conflict (no rows returned)
        return Promise.resolve({
          rows: claimCallCount === 1 ? [{ email_normalized: "jane@example.com" }] : [],
        });
      }
      return Promise.resolve({ rows: [] });
    });

    const app = buildApp();
    const [res1, res2] = await Promise.all([
      request(app).post("/api/contest/entries").send(VALID_BODY),
      request(app).post("/api/contest/entries").send(VALID_BODY),
    ]);

    expect(res1.status).toBe(201);
    expect(res2.status).toBe(201);

    await new Promise(r => setTimeout(r, 20));

    // Exactly one confirmation email should have been sent
    expect(mockSendEmail).toHaveBeenCalledOnce();
  });
});
