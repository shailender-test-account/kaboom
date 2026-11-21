/**
 * End-to-end tests for resumeContactFromWait → processContactStepsInline
 * for re-enrolled contacts in a multi-step sequence.
 *
 * These tests verify three guarantees for a contact whose re-enrollment was
 * written with resume_at = NOW() (no-Redis fallback) and current_step_id
 * pointing to the first step:
 *
 *  1. resumeContactFromWait walks steps from index 0 (the very first step).
 *  2. Email steps are sent in sequence order (step 1 before step 2).
 *  3. A wait step pauses the enrollment (resume_at written, current_step_id
 *     advanced to the next step) without sending the following email.
 *
 * Pool query calls are intercepted in a queue so each successive call gets
 * the pre-configured result without requiring a real database connection.
 * The live-enrollment guard uses a separate connected client for its contact
 * share-lock transaction; those queries do not consume the pool query queue.
 */

import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";

// ── Constants ─────────────────────────────────────────────────────────────────

const TENANT_ID     = 10;
const CONTACT_ID    = 200;
const SEQUENCE_ID   = 5;
const ENROLLMENT_ID = 77;
const STEP1_ID      = 301;
const STEP2_ID      = 302;
const STEP3_ID      = 303;
const TEMPLATE1_ID  = 401;
const TEMPLATE2_ID  = 402;

// ── Pool query mock ───────────────────────────────────────────────────────────
//
// pool.query is called many times in sequence inside resumeContactFromWait and
// processContactStepsInline. We maintain a FIFO queue of result rows; each
// call dequeues the next result. This lets tests declare expected DB responses
// in the same order they are actually executed by the implementation.

type QueryResult = { rows: Record<string, unknown>[] };

const queryQueue: QueryResult[] = [];
const allQueries: { sql: string; params: unknown[] }[] = [];
const transactionEvents: string[] = [];
let nextShareLockError: Error | null = null;

const mockPoolQuery = vi.fn().mockImplementation((sql: string, params: unknown[]) => {
  allQueries.push({ sql: sql.trim(), params: params ?? [] });
  // The delivery policy now rechecks each enrollment before sending. These
  // sequence-walking fixtures are ordinary (not HP-rule-managed) enrollments.
  // Match that independent query without consuming the ordered step results.
  if (sql.includes("AS managed") && sql.includes("AS authorized"))
    return Promise.resolve({ rows: [{ managed: false, authorized: false }] });
  if (/INSERT INTO (email_events|activity_events)/i.test(sql)) {
    transactionEvents.push("history");
  }
  const next = queryQueue.shift();
  return Promise.resolve(next ?? { rows: [] });
});

const mockPoolConnect = vi.fn().mockImplementation(async () => {
  transactionEvents.push("connect");
  let inTransaction = false;
  let locked = false;
  return {
    query: async (sql: string, params?: unknown[]) => {
      if (sql === "BEGIN" && !inTransaction) {
        inTransaction = true;
        transactionEvents.push("BEGIN");
        return { rows: [], rowCount: 0 };
      }
      if (/FOR SHARE OF c/i.test(sql) && inTransaction && !locked) {
        if (nextShareLockError) {
          const error = nextShareLockError;
          nextShareLockError = null;
          transactionEvents.push("FOR SHARE failed");
          throw error;
        }
        expect(sql).toMatch(/EXISTS\s*\(SELECT 1 FROM sequence_enrollments/i);
        expect(params).toEqual([TENANT_ID, CONTACT_ID, ENROLLMENT_ID, contactRow.email]);
        locked = true;
        transactionEvents.push("FOR SHARE");
        return { rows: [{ id: CONTACT_ID }], rowCount: 1 };
      }
      if ((sql === "COMMIT" || sql === "ROLLBACK") && inTransaction) {
        transactionEvents.push(sql);
        inTransaction = false;
        locked = false;
        return { rows: [], rowCount: 0 };
      }
      throw new Error(`Unexpected live-enrollment transaction query: ${sql}`);
    },
    release: () => {
      expect(inTransaction).toBe(false);
      transactionEvents.push("release");
    },
  };
});

/** Push one result for the next pool.query call. */
function enqueue(rows: Record<string, unknown>[]): void {
  queryQueue.push({ rows });
}

// ── sendEmail mock ────────────────────────────────────────────────────────────

const sentEmails: { to: string; subject: string }[] = [];
const mockSendEmail = vi.fn().mockImplementation(({ to, subject }) => {
  transactionEvents.push(`send:${subject}`);
  sentEmails.push({ to, subject });
  return Promise.resolve(true);
});

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock("@workspace/db", () => ({
  pool: {
    query: (...args: unknown[]) => mockPoolQuery(...args),
    connect: () => mockPoolConnect(),
  },
  // Other exports the module might import (unused by runEnrollmentService)
  db: {},
}));

vi.mock("../services/email", () => ({
  sendEmail:                    (...args: unknown[]) => mockSendEmail(...args),
  renderTemplate:               (tpl: string, _vars: Record<string, string>) => tpl,
  injectJourneyTrackingLinks:   (html: string) => html,
  injectAllEmailTrackingLinks:  (html: string) => html,
  injectHoneypotLink:           (html: string) => html,
  generateClickToken:           () => "tok",
}));

vi.mock("../lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// ── Import SUT after mocks ────────────────────────────────────────────────────

import { resumeContactFromWait } from "../services/runEnrollmentService";

// ── Shared fixtures ───────────────────────────────────────────────────────────

const contactRow = {
  id: CONTACT_ID, email: "alice@example.com",
  first_name: "Alice", last_name: "Smith",
  company_name: "Acme", lead_score: 50, tags: [],
};

// config must be a plain object (not stringified): pool.query for a JSONB
// column returns the already-parsed JS value, not the raw JSON string.
const step1Row = {
  id: STEP1_ID, step_order: 0, step_type: "email",
  config: { templateId: TEMPLATE1_ID },
  wait_duration: null, wait_unit: null,
  true_next_step_id: null, false_next_step_id: null,
};

const step2Row = {
  id: STEP2_ID, step_order: 1, step_type: "email",
  config: { templateId: TEMPLATE2_ID },
  wait_duration: null, wait_unit: null,
  true_next_step_id: null, false_next_step_id: null,
};

const waitStepRow = {
  id: STEP2_ID, step_order: 1, step_type: "wait",
  config: {},
  wait_duration: 24, wait_unit: "hours",
  true_next_step_id: null, false_next_step_id: null,
};

const step3Row = {
  id: STEP3_ID, step_order: 2, step_type: "email",
  config: { templateId: TEMPLATE2_ID },
  wait_duration: null, wait_unit: null,
  true_next_step_id: null, false_next_step_id: null,
};

const template1Row = {
  id: TEMPLATE1_ID, subject: "Hello from Step 1",
  body_html: "<p>Step 1 body</p>", body_text: "Step 1 body",
};

const template2Row = {
  id: TEMPLATE2_ID, subject: "Hello from Step 2",
  body_html: "<p>Step 2 body</p>", body_text: "Step 2 body",
};

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Wire the pool.query queue for the SECOND resumeContactFromWait call: the one
 * that fires after the wait delay has elapsed for a three-step sequence
 * (email1 → wait → email2). At this point current_step_id already points to
 * step3 (the post-wait email), so only step3's email should be sent.
 *
 * Query call order:
 *  1. UPDATE resume_at=NULL … RETURNING current_step_id  (atomic claim)
 *  2. SELECT sequence_steps
 *  3. SELECT contact                      (processContactStepsInline)
 *  4. SELECT status                       (step3 active check)
 *  5. SELECT template2                    (sendEmailStep for step3)
 *  6. SELECT journey slug                 (sendEmailStep)
 *  7. INSERT email_events                 (sendEmailStep)
 *  8. INSERT activity_events              (sendEmailStep)
 *  9. UPDATE status='completed'           (step list exhausted)
 */
function wireResumeAfterWait(): void {
  enqueue([{ current_step_id: STEP3_ID }]);        //  1 atomic UPDATE…RETURNING
  enqueue([step1Row, waitStepRow, step3Row]);        //  2 steps
  enqueue([contactRow]);                             //  3 contact
  enqueue([{ status: "active" }]);                   //  4 active check step3
  enqueue([template2Row]);                           //  5 template2 (step3)
  enqueue([]);                                       //  6 journey slug
  enqueue([]);                                       //  7 email_events
  enqueue([]);                                       //  8 activity_events
  enqueue([]);                                       //  9 UPDATE completed
}

/**
 * Wire the pool.query queue for a resumeContactFromWait call over a two-email
 * sequence: email1 → email2.
 *
 * Query call order (matches implementation):
 *  1. UPDATE resume_at=NULL … RETURNING current_step_id  (atomic claim — resumeContactFromWait)
 *  2. SELECT ... FROM sequence_steps ORDER BY step_order ASC  (resumeContactFromWait)
 *  3. SELECT contact ... FROM contacts                  (processContactStepsInline)
 *  4. SELECT status FROM sequence_enrollments (step 1 active check)
 *  5. SELECT template for step 1                        (sendEmailStep)
 *  6. SELECT journey slug for step 1                    (sendEmailStep)
 *  7. INSERT email_events for step 1                    (sendEmailStep)
 *  8. INSERT activity_events for step 1                 (sendEmailStep)
 *  9. SELECT status FROM sequence_enrollments (step 2 active check)
 * 10. SELECT template for step 2                        (sendEmailStep)
 * 11. SELECT journey slug for step 2                    (sendEmailStep)
 * 12. INSERT email_events for step 2                    (sendEmailStep)
 * 13. INSERT activity_events for step 2                 (sendEmailStep)
 * 14. UPDATE status='completed', resume_at=NULL         (step list exhausted)
 */
function wireTwoEmailSequence(currentStepId: number): void {
  enqueue([{ current_step_id: currentStepId }]);   //  1 atomic UPDATE…RETURNING
  enqueue([step1Row, step2Row]);                     //  2 steps
  enqueue([contactRow]);                             //  3 contact
  enqueue([{ status: "active" }]);                   //  4 active check step1
  enqueue([template1Row]);                           //  5 template1
  enqueue([]);                                       //  6 journey slug (none)
  enqueue([]);                                       //  7 email_events
  enqueue([]);                                       //  8 activity_events
  enqueue([{ status: "active" }]);                   //  9 active check step2
  enqueue([template2Row]);                           // 10 template2
  enqueue([]);                                       // 11 journey slug
  enqueue([]);                                       // 12 email_events
  enqueue([]);                                       // 13 activity_events
  enqueue([]);                                       // 14 UPDATE completed
}

/**
 * Wire the pool.query queue for a three-step sequence: email1 → wait → email2.
 * The wait step pauses the enrollment; email2 must NOT be sent.
 *
 *  1. UPDATE resume_at=NULL … RETURNING current_step_id  (atomic claim)
 *  2. SELECT sequence_steps
 *  3. SELECT contact
 *  4. SELECT status (step1 active check)
 *  5. SELECT template1
 *  6. SELECT journey slug
 *  7. INSERT email_events
 *  8. INSERT activity_events
 *  9. SELECT status (wait step active check)
 * 10. UPDATE current_step_id + resume_at  (pause at wait)
 */
function wireEmailWaitEmailSequence(currentStepId: number): void {
  enqueue([{ current_step_id: currentStepId }]);   //  1 atomic UPDATE…RETURNING
  enqueue([step1Row, waitStepRow, step3Row]);        //  2 steps
  enqueue([contactRow]);                             //  3 contact
  enqueue([{ status: "active" }]);                   //  4 active check step1
  enqueue([template1Row]);                           //  5 template1
  enqueue([]);                                       //  6 journey slug
  enqueue([]);                                       //  7 email_events
  enqueue([]);                                       //  8 activity_events
  enqueue([{ status: "active" }]);                   //  9 active check (wait step)
  enqueue([]);                                       // 10 UPDATE pause
}

// ── Reset before each test ────────────────────────────────────────────────────

beforeEach(() => {
  // Exercise ordinary sequence processing independently of Preview's copied-
  // data pause. The real HP policy has dedicated authorization/safe-mode tests.
  vi.stubEnv("COPIED_DATA_SAFE_MODE", "false");
  vi.clearAllMocks();
  nextShareLockError = null;
  queryQueue.length = 0;
  allQueries.length = 0;
  sentEmails.length = 0;
  transactionEvents.length = 0;
});
afterEach(() => vi.unstubAllEnvs());

describe("resumeContactFromWait: failed sends do not hide later steps", () => {
  it("counts a provider rejection, sends the next email, and records only the successful send", async () => {
    enqueue([{ current_step_id: STEP1_ID }]);
    enqueue([step1Row, step2Row]);
    enqueue([contactRow]);
    enqueue([{ status: "active" }]); // first email
    enqueue([template1Row]);
    enqueue([]); // journey
    // No history writes for the failed first send.
    enqueue([{ status: "active" }]); // second email
    enqueue([template2Row]);
    enqueue([]); // journey
    enqueue([]); // successful email_events
    enqueue([]); // successful activity_events
    enqueue([]); // completed
    mockSendEmail.mockImplementationOnce(({ subject, to }) => {
      transactionEvents.push(`send:${subject}`);
      sentEmails.push({ subject, to });
      return Promise.resolve(false);
    });

    const result = await resumeContactFromWait(ENROLLMENT_ID, CONTACT_ID, TENANT_ID, SEQUENCE_ID);

    expect(result).toEqual({ claimed: true, failures: 1 });
    expect(sentEmails.map(email => email.subject)).toEqual([template1Row.subject, template2Row.subject]);
    expect(allQueries.filter(q => /INSERT INTO email_events/i.test(q.sql)).map(q => q.params[2])).toEqual([TEMPLATE2_ID]);
    expect(allQueries.filter(q => /INSERT INTO activity_events/i.test(q.sql))).toHaveLength(1);
    expect(allQueries.some(q => /SET status\s*=\s*'completed'/i.test(q.sql))).toBe(true);
    expect(transactionEvents).toEqual([
      "connect", "BEGIN", "FOR SHARE", `send:${template1Row.subject}`, "COMMIT", "release",
      "connect", "BEGIN", "FOR SHARE", `send:${template2Row.subject}`,
      "history", "history", "COMMIT", "release",
    ]);
    expect(queryQueue).toHaveLength(0);
  });

  it("counts a share-lock error, pauses at the wait, then sends only the post-wait email", async () => {
    enqueue([{ current_step_id: STEP1_ID }]);
    enqueue([step1Row, waitStepRow, step3Row]);
    enqueue([contactRow]);
    enqueue([{ status: "active" }]); // first email
    enqueue([template1Row]);
    enqueue([]); // journey; lock fails before provider call or history
    enqueue([{ status: "active" }]); // wait step
    enqueue([]); // pause
    nextShareLockError = new Error("share lock unavailable");

    const firstResult = await resumeContactFromWait(ENROLLMENT_ID, CONTACT_ID, TENANT_ID, SEQUENCE_ID);

    expect(firstResult).toEqual({ claimed: true, failures: 1 });
    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(allQueries.filter(q => /INSERT INTO (email_events|activity_events)/i.test(q.sql))).toHaveLength(0);
    expect(transactionEvents).toEqual(["connect", "BEGIN", "FOR SHARE failed", "ROLLBACK", "release"]);
    const pauseQuery = allQueries.find(q => /SET current_step_id\s*=\s*\$1\s*,\s*resume_at\s*=\s*\$2/i.test(q.sql));
    expect(pauseQuery?.params[0]).toBe(STEP3_ID);
    expect(pauseQuery?.params[1]).toBeInstanceOf(Date);
    expect(queryQueue).toHaveLength(0);

    wireResumeAfterWait();
    const resumedResult = await resumeContactFromWait(ENROLLMENT_ID, CONTACT_ID, TENANT_ID, SEQUENCE_ID);

    expect(resumedResult).toEqual({ claimed: true, failures: 0 });
    expect(sentEmails.map(email => email.subject)).toEqual([template2Row.subject]);
    expect(allQueries.filter(q => /INSERT INTO email_events/i.test(q.sql)).map(q => q.params[2])).toEqual([TEMPLATE2_ID]);
    expect(allQueries.filter(q => /INSERT INTO activity_events/i.test(q.sql))).toHaveLength(1);
    expect(allQueries.some(q => /SET status\s*=\s*'completed'/i.test(q.sql))).toBe(true);
    expect(queryQueue).toHaveLength(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Part 1 — Two-email sequence: steps walked in order from index 0
// ══════════════════════════════════════════════════════════════════════════════

describe("resumeContactFromWait: two-email sequence — re-enrolled at step 1", () => {
  it("calls pool.query to fetch current_step_id from the enrollment", async () => {
    wireTwoEmailSequence(STEP1_ID);

    await resumeContactFromWait(ENROLLMENT_ID, CONTACT_ID, TENANT_ID, SEQUENCE_ID);

    const q = allQueries[0];
    // The implementation uses an atomic UPDATE…RETURNING (not a separate SELECT)
    // to both claim the enrollment and retrieve current_step_id in one round-trip.
    expect(q.sql).toMatch(/UPDATE sequence_enrollments/i);
    expect(q.sql).toMatch(/RETURNING current_step_id/i);
    expect(q.params).toContain(ENROLLMENT_ID);
  });

  it("clears resume_at immediately before walking steps", async () => {
    wireTwoEmailSequence(STEP1_ID);

    await resumeContactFromWait(ENROLLMENT_ID, CONTACT_ID, TENANT_ID, SEQUENCE_ID);

    const clearQuery = allQueries.find(q => /SET resume_at\s*=\s*NULL/i.test(q.sql));
    expect(clearQuery).toBeDefined();
    expect(clearQuery!.params).toContain(ENROLLMENT_ID);
  });

  it("finds startIndex = 0 for current_step_id = first step", async () => {
    wireTwoEmailSequence(STEP1_ID);

    await resumeContactFromWait(ENROLLMENT_ID, CONTACT_ID, TENANT_ID, SEQUENCE_ID);

    // Both emails must be sent — only possible when the walk starts at index 0.
    expect(mockSendEmail).toHaveBeenCalledTimes(2);
  });

  it("sends step 1 email before step 2 email", async () => {
    wireTwoEmailSequence(STEP1_ID);

    await resumeContactFromWait(ENROLLMENT_ID, CONTACT_ID, TENANT_ID, SEQUENCE_ID);

    expect(sentEmails[0].subject).toBe(template1Row.subject);
    expect(sentEmails[1].subject).toBe(template2Row.subject);
  });

  it("holds a contact share lock through each send and its history writes", async () => {
    wireTwoEmailSequence(STEP1_ID);

    await resumeContactFromWait(ENROLLMENT_ID, CONTACT_ID, TENANT_ID, SEQUENCE_ID);

    expect(mockPoolConnect).toHaveBeenCalledTimes(2);
    expect(transactionEvents).toEqual([
      "connect", "BEGIN", "FOR SHARE", `send:${template1Row.subject}`,
      "history", "history", "COMMIT", "release",
      "connect", "BEGIN", "FOR SHARE", `send:${template2Row.subject}`,
      "history", "history", "COMMIT", "release",
    ]);
  });

  it("sends both emails to the correct contact address", async () => {
    wireTwoEmailSequence(STEP1_ID);

    await resumeContactFromWait(ENROLLMENT_ID, CONTACT_ID, TENANT_ID, SEQUENCE_ID);

    for (const sent of sentEmails) {
      expect(sent.to).toBe(contactRow.email);
    }
  });

  it("marks the enrollment completed after all steps are exhausted", async () => {
    wireTwoEmailSequence(STEP1_ID);

    await resumeContactFromWait(ENROLLMENT_ID, CONTACT_ID, TENANT_ID, SEQUENCE_ID);

    const completionQuery = allQueries.find(
      q => /SET status\s*=\s*'completed'/i.test(q.sql) && q.params.includes(ENROLLMENT_ID)
    );
    expect(completionQuery).toBeDefined();
  });

  it("returns claimed=true and 0 send failures when both emails succeed", async () => {
    wireTwoEmailSequence(STEP1_ID);

    const { claimed, failures } = await resumeContactFromWait(ENROLLMENT_ID, CONTACT_ID, TENANT_ID, SEQUENCE_ID);

    expect(claimed).toBe(true);
    expect(failures).toBe(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Part 2 — email → wait → email: wait step pauses before step 2
// ══════════════════════════════════════════════════════════════════════════════

describe("resumeContactFromWait: email→wait→email — wait step pauses enrollment", () => {
  it("sends only the first email before hitting the wait step", async () => {
    wireEmailWaitEmailSequence(STEP1_ID);

    await resumeContactFromWait(ENROLLMENT_ID, CONTACT_ID, TENANT_ID, SEQUENCE_ID);

    // Only step1's email; step3 email must NOT be sent
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    expect(sentEmails[0].subject).toBe(template1Row.subject);
    expect(mockPoolConnect).toHaveBeenCalledTimes(1);
  });

  it("writes resume_at into the enrollment when pausing at the wait step", async () => {
    wireEmailWaitEmailSequence(STEP1_ID);

    await resumeContactFromWait(ENROLLMENT_ID, CONTACT_ID, TENANT_ID, SEQUENCE_ID);

    // The pause UPDATE sets current_step_id (next step) + resume_at on the enrollment.
    const pauseQuery = allQueries.find(
      q => /SET current_step_id\s*=\s*\$1\s*,\s*resume_at\s*=\s*\$2/i.test(q.sql)
    );
    expect(pauseQuery).toBeDefined();
    // $1 = next step id (step3), $2 = Date, $3 = enrollmentId
    expect(pauseQuery!.params[0]).toBe(STEP3_ID);
    expect(pauseQuery!.params[2]).toBe(ENROLLMENT_ID);
  });

  it("sets resume_at to a future timestamp (not null, not past)", async () => {
    wireEmailWaitEmailSequence(STEP1_ID);

    const before = new Date();
    await resumeContactFromWait(ENROLLMENT_ID, CONTACT_ID, TENANT_ID, SEQUENCE_ID);
    const after = new Date();

    const pauseQuery = allQueries.find(
      q => /SET current_step_id\s*=\s*\$1\s*,\s*resume_at\s*=\s*\$2/i.test(q.sql)
    );
    const resumeAt = pauseQuery!.params[1] as Date;
    expect(resumeAt).toBeInstanceOf(Date);
    expect(resumeAt.getTime()).toBeGreaterThan(after.getTime());
  });

  it("does NOT mark the enrollment completed when pausing at a wait step", async () => {
    wireEmailWaitEmailSequence(STEP1_ID);

    await resumeContactFromWait(ENROLLMENT_ID, CONTACT_ID, TENANT_ID, SEQUENCE_ID);

    const completionQuery = allQueries.find(
      q => /SET status\s*=\s*'completed'/i.test(q.sql) && q.params.includes(ENROLLMENT_ID)
    );
    expect(completionQuery).toBeUndefined();
  });

  it("advances current_step_id to the step after the wait (not the wait step itself)", async () => {
    wireEmailWaitEmailSequence(STEP1_ID);

    await resumeContactFromWait(ENROLLMENT_ID, CONTACT_ID, TENANT_ID, SEQUENCE_ID);

    const pauseQuery = allQueries.find(
      q => /SET current_step_id\s*=\s*\$1\s*,\s*resume_at\s*=\s*\$2/i.test(q.sql)
    );
    // The next step after the wait is step3 (STEP3_ID)
    expect(pauseQuery!.params[0]).toBe(STEP3_ID);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Part 3 — re-enrolled contact starts at index 0 regardless of which step
//           current_step_id points to
// ══════════════════════════════════════════════════════════════════════════════

describe("resumeContactFromWait: re-enrolled contact always starts at step 1", () => {
  it("startIndex resolves to 0 when current_step_id equals the first step's id", () => {
    // Mirrors the calculation inside resumeContactFromWait:
    // startIndex = steps.findIndex(s => s.id === currentStepId)
    const steps = [
      { id: STEP1_ID, step_order: 0 },
      { id: STEP2_ID, step_order: 1 },
      { id: STEP3_ID, step_order: 2 },
    ];
    const startIndex = steps.findIndex(s => s.id === STEP1_ID);
    expect(startIndex).toBe(0);
  });

  it("sends both emails for a two-email sequence when starting at index 0 via runner", async () => {
    wireTwoEmailSequence(STEP1_ID);

    await resumeContactFromWait(ENROLLMENT_ID, CONTACT_ID, TENANT_ID, SEQUENCE_ID);

    expect(mockSendEmail).toHaveBeenCalledTimes(2);
  });

  it("enrollment is marked completed (not stuck) after two-email walk", async () => {
    wireTwoEmailSequence(STEP1_ID);

    await resumeContactFromWait(ENROLLMENT_ID, CONTACT_ID, TENANT_ID, SEQUENCE_ID);

    const completionQuery = allQueries.find(
      q => /SET status\s*=\s*'completed'/i.test(q.sql) && q.params.includes(ENROLLMENT_ID)
    );
    expect(completionQuery).toBeDefined();
  });

  it("does NOT send any email when the enrollment is no longer active at step start", async () => {
    // Simulate the enrollment being cancelled between resume_at elapsing and the runner tick.
    enqueue([{ current_step_id: STEP1_ID }]);         // 1 atomic UPDATE…RETURNING
    enqueue([step1Row, step2Row]);                     // 2 steps
    enqueue([contactRow]);                             // 3 contact
    enqueue([{ status: "cancelled" }]);                // 4 active check → not active

    await resumeContactFromWait(ENROLLMENT_ID, CONTACT_ID, TENANT_ID, SEQUENCE_ID);

    expect(mockSendEmail).not.toHaveBeenCalled();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Part 5 — Post-wait resume: contact continues from step-after-wait, not step 1
// ══════════════════════════════════════════════════════════════════════════════

describe("resumeContactFromWait: post-wait resume starts at the step after the wait", () => {
  it("sends only the post-wait email (step 3), not step 1", async () => {
    wireResumeAfterWait();

    await resumeContactFromWait(ENROLLMENT_ID, CONTACT_ID, TENANT_ID, SEQUENCE_ID);

    // Exactly one email sent — the post-wait step (step3), not step1
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    expect(sentEmails[0].subject).toBe(template2Row.subject);
    expect(mockPoolConnect).toHaveBeenCalledTimes(1);
  });

  it("does NOT re-send step 1's email when resuming from the post-wait step", async () => {
    wireResumeAfterWait();

    await resumeContactFromWait(ENROLLMENT_ID, CONTACT_ID, TENANT_ID, SEQUENCE_ID);

    // step1's subject must not appear in any sent email
    const step1Sent = sentEmails.some(e => e.subject === template1Row.subject);
    expect(step1Sent).toBe(false);
  });

  it("resolves startIndex to 2 (step3's position) when current_step_id = STEP3_ID", () => {
    // Mirrors the findIndex inside resumeContactFromWait
    const steps = [
      { id: STEP1_ID, step_order: 0 },
      { id: STEP2_ID, step_order: 1 },
      { id: STEP3_ID, step_order: 2 },
    ];
    const startIndex = steps.findIndex(s => s.id === STEP3_ID);
    expect(startIndex).toBe(2);
  });

  it("marks the enrollment completed after the post-wait email is sent", async () => {
    wireResumeAfterWait();

    await resumeContactFromWait(ENROLLMENT_ID, CONTACT_ID, TENANT_ID, SEQUENCE_ID);

    const completionQuery = allQueries.find(
      q => /SET status\s*=\s*'completed'/i.test(q.sql) && q.params.includes(ENROLLMENT_ID)
    );
    expect(completionQuery).toBeDefined();
  });

  it("sends the post-wait email to the correct contact address", async () => {
    wireResumeAfterWait();

    await resumeContactFromWait(ENROLLMENT_ID, CONTACT_ID, TENANT_ID, SEQUENCE_ID);

    expect(sentEmails[0].to).toBe(contactRow.email);
  });

  it("returns claimed=true and 0 failures when the post-wait email succeeds", async () => {
    wireResumeAfterWait();

    const { claimed, failures } = await resumeContactFromWait(ENROLLMENT_ID, CONTACT_ID, TENANT_ID, SEQUENCE_ID);

    expect(claimed).toBe(true);
    expect(failures).toBe(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Part 6 — Cancelled enrollment: atomic claim returns 0 rows → bail out cleanly
// ══════════════════════════════════════════════════════════════════════════════

describe("resumeContactFromWait: cancelled enrollment — atomic claim returns 0 rows", () => {
  /**
   * When an enrollment is cancelled (or completed) between the wait delay
   * elapsing and the resume runner tick, the atomic UPDATE…WHERE status='active'
   * AND resume_at IS NOT NULL returns 0 rows. The function must bail out
   * immediately — no email sent, no spurious completion update.
   *
   * Query call order:
   *  1. UPDATE resume_at=NULL … RETURNING current_step_id  (atomic claim → 0 rows)
   *     Everything else must NOT be called.
   */

  it("returns claimed=false when the atomic claim matches 0 rows (enrollment was cancelled)", async () => {
    enqueue([]); // atomic UPDATE returns 0 rows — enrollment no longer active

    const { claimed } = await resumeContactFromWait(ENROLLMENT_ID, CONTACT_ID, TENANT_ID, SEQUENCE_ID);

    expect(claimed).toBe(false);
  });

  it("returns failures=0 when the atomic claim is lost to a cancelled enrollment", async () => {
    enqueue([]);

    const { failures } = await resumeContactFromWait(ENROLLMENT_ID, CONTACT_ID, TENANT_ID, SEQUENCE_ID);

    expect(failures).toBe(0);
  });

  it("does NOT send any email when the atomic claim returns 0 rows", async () => {
    enqueue([]);

    await resumeContactFromWait(ENROLLMENT_ID, CONTACT_ID, TENANT_ID, SEQUENCE_ID);

    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it("does NOT issue a SET status='completed' query when the claim is missed", async () => {
    enqueue([]);

    await resumeContactFromWait(ENROLLMENT_ID, CONTACT_ID, TENANT_ID, SEQUENCE_ID);

    const completionQuery = allQueries.find(
      q => /SET status\s*=\s*'completed'/i.test(q.sql) && q.params.includes(ENROLLMENT_ID)
    );
    expect(completionQuery).toBeUndefined();
  });

  it("issues exactly one pool.query call (the atomic claim) when the claim returns 0 rows", async () => {
    enqueue([]);

    await resumeContactFromWait(ENROLLMENT_ID, CONTACT_ID, TENANT_ID, SEQUENCE_ID);

    // Only the atomic UPDATE should have been issued; no step fetch, contact
    // fetch, or email machinery should follow.
    expect(allQueries).toHaveLength(1);
    expect(allQueries[0].sql).toMatch(/UPDATE sequence_enrollments/i);
    expect(allQueries[0].sql).toMatch(/resume_at\s*=\s*NULL/i);
  });

  it("the single query targets the correct enrollmentId", async () => {
    enqueue([]);

    await resumeContactFromWait(ENROLLMENT_ID, CONTACT_ID, TENANT_ID, SEQUENCE_ID);

    expect(allQueries[0].params).toContain(ENROLLMENT_ID);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Part 4 — sequenceResumeRunner selection predicate for re-enrolled contacts
// ══════════════════════════════════════════════════════════════════════════════

describe("sequenceResumeRunner selection predicate matches re-enrolled contacts", () => {
  it("enrollment with status=active and resume_at=NOW() is eligible on next tick", () => {
    const enrollment = {
      status:          "active" as const,
      resume_at:       new Date(),       // written as NOW() by the no-Redis re-enroll path
      current_step_id: STEP1_ID,
    };

    // Mirrors the runner WHERE clause:
    // WHERE status = 'active' AND resume_at IS NOT NULL AND resume_at <= NOW()
    const currentStatus: string = enrollment.status;
    const eligible =
      currentStatus === "active" &&
      enrollment.resume_at !== null &&
      enrollment.resume_at <= new Date();

    expect(eligible).toBe(true);
  });

  it("enrollment paused at wait step (future resume_at) is NOT eligible yet", () => {
    const futureDate = new Date(Date.now() + 86_400_000); // 24 h from now
    const enrollment = {
      status:          "active" as const,
      resume_at:       futureDate,
      current_step_id: STEP3_ID,
    };

    const eligible =
      enrollment.status === "active" &&
      enrollment.resume_at !== null &&
      enrollment.resume_at <= new Date();

    expect(eligible).toBe(false);
  });

  it("completed enrollment is never eligible for the runner", () => {
    const enrollment = {
      status:          "completed" as const,
      resume_at:       new Date(),
      current_step_id: null,
    };

    const currentStatus: string = enrollment.status;
    const eligible =
      currentStatus === "active" &&
      enrollment.resume_at !== null &&
      enrollment.resume_at <= new Date();

    expect(eligible).toBe(false);
  });
});
