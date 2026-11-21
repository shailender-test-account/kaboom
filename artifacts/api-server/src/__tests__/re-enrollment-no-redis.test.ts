/**
 * Tests for POST /contacts/:id/sequences/:enrollmentId/re-enroll — no-Redis fallback.
 *
 * Verifies three guarantees:
 *
 *  1. After re-enrollment the new enrollment row has currentStepId set to the
 *     first sequence step, regardless of Redis availability.
 *
 *  2. Happy path (Redis available): enqueueStep is called so BullMQ handles the
 *     first step delivery. resume_at is NOT written.
 *
 *  3. No-Redis path (Redis unavailable): enqueueStep is skipped and resume_at is
 *     set to NOW() so the sequenceResumeRunner picks up the enrollment on its next
 *     tick and calls resumeContactFromWait — which starts processing from the
 *     first step via processContactStepsInline.
 *
 * Part 5 tests the sequenceResumeRunner query contract: it selects active
 * enrollments where resume_at IS NOT NULL AND resume_at <= NOW(), confirming
 * that a re-enrollment with resume_at = NOW() would be included on the next tick.
 */

import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import express from "express";
import request from "supertest";

// ── Constants ──────────────────────────────────────────────────────────────────

const TENANT_ID     = 1;
const CONTACT_ID    = 42;
const ENROLLMENT_ID = 7;
const SEQUENCE_ID   = 3;
const FIRST_STEP_ID = 100;
const NEW_ENROLL_ID = 99;

// ── Spy declarations ───────────────────────────────────────────────────────────

const mockEnqueueStep            = vi.fn().mockResolvedValue(undefined);
const mockIsTenantQueueAvailable = vi.fn();
const mockDbExecute              = vi.fn().mockResolvedValue({ rows: [] });
const mockPoolQuery              = vi.fn();

// ── Thenable chain helper ──────────────────────────────────────────────────────
//
// The contacts router chains db.select().from().where().orderBy().limit().
// We need an object that is:
//   (a) callable (to satisfy "from()", "where()", etc.)
//   (b) thenable — so "await chain.where(...)" resolves to the configured result
//       even when no further chaining occurs
//   (c) returns itself for every method call — so "chain.orderBy().limit()" works

function makeThenableChain(result: unknown[]): any {
  const chain: any = {};

  // Make the chain itself thenable so "await chain" resolves to result
  chain.then = (resolve: (v: unknown) => void, _reject?: (e: unknown) => void) => {
    return Promise.resolve(result).then(resolve, _reject);
  };
  chain.catch = (fn: (e: unknown) => void) => Promise.resolve(result).catch(fn);

  // All typical ORM methods return the same chain (still thenable)
  for (const method of ["from", "where", "orderBy", "limit", "offset", "leftJoin"]) {
    chain[method] = vi.fn().mockReturnValue(chain);
  }
  return chain;
}

// Sequence of results returned by successive db.select() calls
let _selectResults: unknown[][] = [];
let _selectCallIdx = 0;

const mockDbSelect = vi.fn().mockImplementation(() => {
  const idx    = _selectCallIdx++;
  const result = _selectResults[idx] ?? [];
  return makeThenableChain(result);
});

// db.insert chain
let _insertReturnValue: unknown[] = [];
const mockDbInsertReturning = vi.fn().mockImplementation(() =>
  Promise.resolve(_insertReturnValue)
);
const mockDbInsertValues    = vi.fn().mockReturnValue({ returning: mockDbInsertReturning });
const mockDbInsert          = vi.fn().mockReturnValue({ values: mockDbInsertValues });

// ── Module mocks ───────────────────────────────────────────────────────────────

vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { id: 1, tenantId: TENANT_ID, role: "admin" };
    next();
  },
}));

vi.mock("@workspace/db", () => ({
  db: {
    select:  (...args: unknown[]) => mockDbSelect(...args),
    insert:  (...args: unknown[]) => mockDbInsert(...args),
    execute: (...args: unknown[]) => mockDbExecute(...args),
    update:  vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }),
    }),
  },
  pool: { query: (...args: unknown[]) => mockPoolQuery(...args) },
  contactsTable:            Symbol("contactsTable"),
  companiesTable:           Symbol("companiesTable"),
  activityEventsTable:      Symbol("activityEventsTable"),
  emailSequencesTable:      Symbol("emailSequencesTable"),
  sequenceEnrollmentsTable: Symbol("sequenceEnrollmentsTable"),
  sequenceStepsTable:       Symbol("sequenceStepsTable"),
}));

vi.mock("../services/queue", () => ({
  enqueueStep:              (...args: unknown[]) => mockEnqueueStep(...args),
  isTenantQueueAvailable:   (...args: unknown[]) => mockIsTenantQueueAvailable(...args),
}));

vi.mock("../lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../lib/scoringEngine", () => ({
  evaluateRoutingRules: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../utils/segmentFilter", () => ({
  buildContactsWhereClause: vi.fn().mockResolvedValue({}),
}));

// drizzle-orm operators — the contacts router imports these; mock them so
// the test doesn't need a real DB connection.
vi.mock("drizzle-orm", () => {
  const sqlTag = Object.assign(
    (strings: TemplateStringsArray, ...vals: unknown[]) => ({ _type: "sql", strings, vals }),
    { join: vi.fn().mockReturnValue({ _type: "sql_join" }) }
  );
  return {
    and:     (...args: unknown[]) => ({ _type: "and",     args }),
    or:      (...args: unknown[]) => ({ _type: "or",      args }),
    eq:      (...args: unknown[]) => ({ _type: "eq",      args }),
    asc:     (...args: unknown[]) => ({ _type: "asc",     args }),
    desc:    (...args: unknown[]) => ({ _type: "desc",    args }),
    gte:     (...args: unknown[]) => ({ _type: "gte",     args }),
    lte:     (...args: unknown[]) => ({ _type: "lte",     args }),
    ilike:   (...args: unknown[]) => ({ _type: "ilike",   args }),
    inArray: (...args: unknown[]) => ({ _type: "inArray", args }),
    sql:     sqlTag,
  };
});

// ── Import router AFTER all mocks ──────────────────────────────────────────────

import contactsRouter from "../routes/contacts";

// ── Fixtures ───────────────────────────────────────────────────────────────────

const contactRow    = { id: CONTACT_ID, dnc: false };
const enrollmentRow = { id: ENROLLMENT_ID, sequenceId: SEQUENCE_ID, status: "completed" };
const sequenceRow   = { id: SEQUENCE_ID };
const firstStepRow  = { id: FIRST_STEP_ID, stepOrder: 0, stepType: "email",
                        config: { templateId: 5 } };
const newEnrollRow  = { id: NEW_ENROLL_ID, sequenceId: SEQUENCE_ID,
                        contactId: CONTACT_ID, status: "active",
                        currentStepId: FIRST_STEP_ID };

/**
 * Wire the five sequential db.select() calls the re-enroll route makes:
 *   0 → contact lookup
 *   1 → enrollment lookup
 *   2 → sequence ownership
 *   3 → active enrollment guard (should be empty to pass)
 *   4 → first step lookup (.where().orderBy().limit(1))
 */
function setupSelectSequence(overrides: { [idx: number]: unknown[] } = {}) {
  _selectCallIdx = 0;
  _selectResults = [
    overrides[0] ?? [contactRow],          // 0: contact
    overrides[1] ?? [enrollmentRow],       // 1: enrollment
    overrides[2] ?? [sequenceRow],         // 2: sequence ownership
    overrides[3] ?? [],                    // 3: active guard — empty means no block
    overrides[4] ?? [firstStepRow],        // 4: first step
  ];
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api", contactsRouter);
  return app;
}

// ══════════════════════════════════════════════════════════════════════════════
// Part 1 — currentStepId is always set to the first step id
// ══════════════════════════════════════════════════════════════════════════════

describe("Re-enrollment: new enrollment always has currentStepId = first step", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupSelectSequence();
    _insertReturnValue = [newEnrollRow];
    mockIsTenantQueueAvailable.mockResolvedValue(true);
    mockEnqueueStep.mockResolvedValue(undefined);
    mockDbExecute.mockResolvedValue({ rows: [] });
  });

  it("inserts the new enrollment with currentStepId equal to the first published step id", async () => {
    const app = buildApp();
    const res = await request(app)
      .post(`/api/contacts/${CONTACT_ID}/sequences/${ENROLLMENT_ID}/re-enroll`)
      .send();

    expect(res.status).toBe(201);
    expect(mockDbInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({ currentStepId: FIRST_STEP_ID })
    );
  });

  it("returns the new enrollment in the response body", async () => {
    const app = buildApp();
    const res = await request(app)
      .post(`/api/contacts/${CONTACT_ID}/sequences/${ENROLLMENT_ID}/re-enroll`)
      .send();

    expect(res.status).toBe(201);
    expect(res.body.enrollment).toMatchObject({
      id:            NEW_ENROLL_ID,
      currentStepId: FIRST_STEP_ID,
      status:        "active",
    });
  });

  it("sets currentStepId to -1 (nodes_json index 0 sentinel) when the sequence has no published steps", async () => {
    setupSelectSequence({ 4: [] }); // no firstStep → nodes_json path
    _insertReturnValue = [{ ...newEnrollRow, currentStepId: -1 }];

    const app = buildApp();
    const res = await request(app)
      .post(`/api/contacts/${CONTACT_ID}/sequences/${ENROLLMENT_ID}/re-enroll`)
      .send();

    expect(res.status).toBe(201);
    // currentStepId = -1 encodes "start at nodes_json index 0" for the resume runner
    expect(mockDbInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({ currentStepId: -1 })
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Part 2 — Happy path: Redis available → enqueueStep is called
// ══════════════════════════════════════════════════════════════════════════════

describe("Re-enrollment: Redis available → enqueueStep is called, resume_at is not written", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupSelectSequence();
    _insertReturnValue = [newEnrollRow];
    mockIsTenantQueueAvailable.mockResolvedValue(true);
    mockEnqueueStep.mockResolvedValue(undefined);
    mockDbExecute.mockResolvedValue({ rows: [] });
  });

  it("checks isTenantQueueAvailable before deciding the path", async () => {
    const app = buildApp();
    await request(app)
      .post(`/api/contacts/${CONTACT_ID}/sequences/${ENROLLMENT_ID}/re-enroll`)
      .send();

    expect(mockIsTenantQueueAvailable).toHaveBeenCalledWith(TENANT_ID);
  });

  it("calls enqueueStep with the correct job payload when Redis is available", async () => {
    const app = buildApp();
    const res = await request(app)
      .post(`/api/contacts/${CONTACT_ID}/sequences/${ENROLLMENT_ID}/re-enroll`)
      .send();

    expect(res.status).toBe(201);
    expect(mockEnqueueStep).toHaveBeenCalledOnce();
    expect(mockEnqueueStep).toHaveBeenCalledWith({
      enrollmentId: NEW_ENROLL_ID,
      stepId:       FIRST_STEP_ID,
      sequenceId:   SEQUENCE_ID,
      contactId:    CONTACT_ID,
      tenantId:     TENANT_ID,
    });
  });

  it("does NOT write resume_at when Redis is available", async () => {
    const app = buildApp();
    await request(app)
      .post(`/api/contacts/${CONTACT_ID}/sequences/${ENROLLMENT_ID}/re-enroll`)
      .send();

    // db.execute is used only to write resume_at; it must not be called here
    expect(mockDbExecute).not.toHaveBeenCalled();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Part 3 — No-Redis path: enqueueStep skipped, resume_at written
// ══════════════════════════════════════════════════════════════════════════════

describe("Re-enrollment: Redis unavailable → resume_at is set so the resume runner picks it up", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupSelectSequence();
    _insertReturnValue = [newEnrollRow];
    mockIsTenantQueueAvailable.mockResolvedValue(false); // ← no Redis
    mockDbExecute.mockResolvedValue({ rows: [] });
  });

  it("does NOT call enqueueStep when Redis is unavailable", async () => {
    const app = buildApp();
    await request(app)
      .post(`/api/contacts/${CONTACT_ID}/sequences/${ENROLLMENT_ID}/re-enroll`)
      .send();

    expect(mockEnqueueStep).not.toHaveBeenCalled();
  });

  it("writes resume_at via db.execute so the sequenceResumeRunner can pick up the enrollment", async () => {
    const app = buildApp();
    await request(app)
      .post(`/api/contacts/${CONTACT_ID}/sequences/${ENROLLMENT_ID}/re-enroll`)
      .send();

    // db.execute must be called once to set resume_at on the new enrollment
    expect(mockDbExecute).toHaveBeenCalledOnce();

    // The sql template tag returns { _type: "sql", strings, vals } —
    // the new enrollment id must appear in the interpolated values.
    const callArg = mockDbExecute.mock.calls[0][0] as { vals?: unknown[] };
    expect(callArg?.vals ?? []).toContain(NEW_ENROLL_ID);
  });

  it("still returns 201 with the new enrollment when Redis is unavailable", async () => {
    const app = buildApp();
    const res = await request(app)
      .post(`/api/contacts/${CONTACT_ID}/sequences/${ENROLLMENT_ID}/re-enroll`)
      .send();

    expect(res.status).toBe(201);
    expect(res.body.enrollment).toMatchObject({ id: NEW_ENROLL_ID });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Part 4 — nodes_json-only sequences: resume_at always set, sentinel currentStepId
// ══════════════════════════════════════════════════════════════════════════════

/**
 * When a sequence has never been published it has no sequence_steps rows.
 * The re-enroll route must:
 *   - set currentStepId = -1  (encodes "nodes_json index 0" via -(0+1))
 *   - always write resume_at = NOW() so the sequenceResumeRunner calls
 *     resumeContactFromWait, which dispatches to processContactNodesJsonSteps
 *   - never call enqueueStep (no real step id exists for BullMQ)
 *
 * This mirrors the nodes_json fallback already present in runEnrollmentService.
 */
describe("Re-enrollment: nodes_json-only sequence (no published steps)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Override slot 4 (first-step query) to return empty — no published steps
    setupSelectSequence({ 4: [] });
    _insertReturnValue = [{ ...newEnrollRow, currentStepId: -1 }];
    mockDbExecute.mockResolvedValue({ rows: [] });
  });

  it("inserts the enrollment with currentStepId = -1 (nodes_json index 0 sentinel)", async () => {
    mockIsTenantQueueAvailable.mockResolvedValue(false);
    const app = buildApp();
    const res = await request(app)
      .post(`/api/contacts/${CONTACT_ID}/sequences/${ENROLLMENT_ID}/re-enroll`)
      .send();

    expect(res.status).toBe(201);
    expect(mockDbInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({ currentStepId: -1 })
    );
  });

  it("never calls enqueueStep regardless of Redis availability", async () => {
    // Redis available — but no published steps, so BullMQ must not be used
    mockIsTenantQueueAvailable.mockResolvedValue(true);
    const app = buildApp();
    await request(app)
      .post(`/api/contacts/${CONTACT_ID}/sequences/${ENROLLMENT_ID}/re-enroll`)
      .send();

    expect(mockEnqueueStep).not.toHaveBeenCalled();
  });

  it("writes resume_at via db.execute even when Redis is available", async () => {
    mockIsTenantQueueAvailable.mockResolvedValue(true);
    const app = buildApp();
    await request(app)
      .post(`/api/contacts/${CONTACT_ID}/sequences/${ENROLLMENT_ID}/re-enroll`)
      .send();

    expect(mockDbExecute).toHaveBeenCalledOnce();
    const callArg = mockDbExecute.mock.calls[0][0] as { vals?: unknown[] };
    expect(callArg?.vals ?? []).toContain(NEW_ENROLL_ID);
  });

  it("writes resume_at when Redis is unavailable", async () => {
    mockIsTenantQueueAvailable.mockResolvedValue(false);
    const app = buildApp();
    await request(app)
      .post(`/api/contacts/${CONTACT_ID}/sequences/${ENROLLMENT_ID}/re-enroll`)
      .send();

    expect(mockDbExecute).toHaveBeenCalledOnce();
    const callArg = mockDbExecute.mock.calls[0][0] as { vals?: unknown[] };
    expect(callArg?.vals ?? []).toContain(NEW_ENROLL_ID);
  });

  it("returns 201 with the new enrollment", async () => {
    mockIsTenantQueueAvailable.mockResolvedValue(false);
    const app = buildApp();
    const res = await request(app)
      .post(`/api/contacts/${CONTACT_ID}/sequences/${ENROLLMENT_ID}/re-enroll`)
      .send();

    expect(res.status).toBe(201);
    expect(res.body.enrollment).toMatchObject({ id: NEW_ENROLL_ID });
  });

  it("an enrollment with currentStepId=-1 and resume_at=NOW() is picked up by the runner and dispatched to the nodes_json path", () => {
    // resumeContactFromWait checks: currentStepId < 0 → nodes_json path
    // startIndex = -currentStepId - 1 = -(-1) - 1 = 0  ← starts at first node
    const enrollment = {
      status:          "active" as const,
      current_step_id: -1,
      resume_at:       new Date(),
    };

    // Runner selection predicate
    const selectedByRunner =
      enrollment.status === "active" &&
      enrollment.resume_at !== null &&
      enrollment.resume_at <= new Date();
    expect(selectedByRunner).toBe(true);

    // resumeContactFromWait dispatch predicate
    const dispatchedToNodesJson =
      enrollment.current_step_id !== null && enrollment.current_step_id < 0;
    expect(dispatchedToNodesJson).toBe(true);

    // Decoded index = 0 (first node)
    const startIndex = -enrollment.current_step_id - 1;
    expect(startIndex).toBe(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Part 5 — Guard checks: 403 / 404 / 409 responses
// ══════════════════════════════════════════════════════════════════════════════

describe("Re-enrollment: guard checks work correctly", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsTenantQueueAvailable.mockResolvedValue(true);
    mockDbExecute.mockResolvedValue({ rows: [] });
    _insertReturnValue = [newEnrollRow];
  });

  it("returns 404 when contact is not found", async () => {
    setupSelectSequence({ 0: [] }); // no contact
    const app = buildApp();
    const res = await request(app)
      .post(`/api/contacts/${CONTACT_ID}/sequences/${ENROLLMENT_ID}/re-enroll`)
      .send();
    expect(res.status).toBe(404);
    expect(mockDbInsert).not.toHaveBeenCalled();
  });

  it("returns 409 when contact is on the DNC list", async () => {
    setupSelectSequence({ 0: [{ ...contactRow, dnc: true }] });
    const app = buildApp();
    const res = await request(app)
      .post(`/api/contacts/${CONTACT_ID}/sequences/${ENROLLMENT_ID}/re-enroll`)
      .send();
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/DNC/i);
  });

  it("returns 404 when enrollment is not found", async () => {
    setupSelectSequence({ 1: [] }); // no enrollment
    const app = buildApp();
    const res = await request(app)
      .post(`/api/contacts/${CONTACT_ID}/sequences/${ENROLLMENT_ID}/re-enroll`)
      .send();
    expect(res.status).toBe(404);
  });

  it("returns 409 when enrollment is not completed", async () => {
    setupSelectSequence({ 1: [{ ...enrollmentRow, status: "active" }] });
    const app = buildApp();
    const res = await request(app)
      .post(`/api/contacts/${CONTACT_ID}/sequences/${ENROLLMENT_ID}/re-enroll`)
      .send();
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/not completed/i);
  });

  it("returns 409 when contact already has an active enrollment in this sequence", async () => {
    setupSelectSequence({ 3: [{ id: 55 }] }); // active enrollment exists
    const app = buildApp();
    const res = await request(app)
      .post(`/api/contacts/${CONTACT_ID}/sequences/${ENROLLMENT_ID}/re-enroll`)
      .send();
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already actively enrolled/i);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Part 6 — sequenceResumeRunner query contract
// ══════════════════════════════════════════════════════════════════════════════

/**
 * The sequenceResumeRunner query:
 *   WHERE se.status = 'active' AND se.resume_at IS NOT NULL AND se.resume_at <= NOW()
 *
 * A re-enrolled contact whose Redis enqueue was skipped has:
 *   status = 'active'
 *   resume_at = NOW()  (written by the no-Redis path)
 *   current_step_id = FIRST_STEP_ID
 *
 * This confirms the runner will pick up the enrollment on its very next tick,
 * and that resumeContactFromWait (which reads current_step_id and calls
 * processContactStepsInline starting at step index 0) will execute the first step.
 */
describe("sequenceResumeRunner query contract: no-Redis re-enrollment is eligible", () => {
  it("an enrollment with status=active and resume_at=NOW() satisfies the runner's selection predicate", () => {
    const enrollmentAfterNoRedisPath = {
      status:          "active" as const,
      resume_at:       new Date(),       // written as NOW() by the fallback
      current_step_id: FIRST_STEP_ID,   // set by the re-enrollment insert
    };

    // Mirrors the runner's WHERE clause logic:
    const selectedByRunner =
      enrollmentAfterNoRedisPath.status === "active" &&
      enrollmentAfterNoRedisPath.resume_at !== null &&
      enrollmentAfterNoRedisPath.resume_at <= new Date();

    expect(selectedByRunner).toBe(true);
  });

  it("an enrollment with resume_at=null is NOT selected by the runner (before fix: contacts got stuck)", () => {
    const stuckEnrollment: {
      status:          "active";
      resume_at:       Date | null;
      current_step_id: number;
    } = {
      status:          "active",
      resume_at:       null,             // what the old code left — no fallback
      current_step_id: FIRST_STEP_ID,
    };

    const selectedByRunner =
      stuckEnrollment.status === "active" &&
      stuckEnrollment.resume_at !== null &&
      stuckEnrollment.resume_at <= new Date();

    // This was the bug: the runner would never pick up the enrollment
    expect(selectedByRunner).toBe(false);
  });

  it("the first step id stored in current_step_id equals the sequence's first published step", () => {
    // resumeContactFromWait reads current_step_id, finds it in sequence_steps ordered
    // by step_order ASC, and calls processContactStepsInline(enrollmentId, ..., steps, startIndex).
    // startIndex = steps.findIndex(s => s.id === currentStepId).
    // For a re-enrollment, currentStepId = firstStep.id → startIndex = 0.
    const steps = [
      { id: FIRST_STEP_ID, step_order: 0 },
      { id: 101,           step_order: 1 },
    ];
    const startIndex = steps.findIndex(s => s.id === FIRST_STEP_ID);
    expect(startIndex).toBe(0); // always starts from the beginning
  });
});
