import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock("@workspace/db", () => ({
  pool: { query: mocks.query },
  db: {},
  clientsTable: Symbol("clientsTable"),
  playsTable: Symbol("playsTable"),
  contactsTable: Symbol("contactsTable"),
  companiesTable: Symbol("companiesTable"),
  dealsTable: Symbol("dealsTable"),
  activityEventsTable: Symbol("activityEventsTable"),
  emailSequencesTable: Symbol("emailSequencesTable"),
}));
vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { id: 3, tenantId: 7, role: "admin" };
    next();
  },
}));
vi.mock("../utils/segmentFilter", () => ({
  buildContactsWhereClause: vi.fn(),
}));

import analyticsRouter from "../routes/analytics";

const app = express()
  .use(express.json())
  .use(analyticsRouter)
  .use((error: Error, _req: any, res: any, _next: any) => {
    res.status(500).json({ error: error.message });
  });

const result = (rows: any[]) => ({ rows, rowCount: rows.length });

describe("POST /analytics/gtm-status", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.query.mockImplementation(async (query: string, params: unknown[]) => {
      if (query.includes("FROM intent_inbound_submissions s")) {
        expect(query).toContain("s.tenant_id = $1");
        expect(query).toContain("s.contact_id = ANY($2::int[])");
        expect(query).toContain("c.id = s.contact_id AND c.tenant_id = s.tenant_id");
        expect(query).toContain("c.company_id = s.account_id");
        expect(query).toContain("s.form_type IN ('lead_form', 'event_feedback')");
        expect(query).toContain("GROUP BY s.contact_id");
        expect(query.indexOf("bool_or(s.classification = 'hot')"))
          .toBeLessThan(query.indexOf("bool_or(s.classification = 'warm')"));
        expect(params).toEqual([7, [1, 2, 3, 4, 5, 6, 7]]);
        return result([
          { contact_id: 1, status: "hot", updated_at: new Date("2026-04-01T10:00:00Z") },
          { contact_id: 2, status: "warm", updated_at: new Date("2026-04-02T10:00:00Z") },
          { contact_id: 3, status: "cold", updated_at: new Date("2026-04-03T10:00:00Z") },
          // Contact 4 works at the Hot account but never answered a form.
          // Contact 5 belongs to another tenant, 6 was linked to another
          // account, and 7 has no company. None have eligible submissions.
        ]);
      }
      throw new Error(`Unexpected SQL: ${query}`);
    });
  });

  it("returns each respondent's status, never inheriting a Hot employer's status", async () => {
    const response = await request(app)
      .post("/analytics/gtm-status")
      .send({ contactIds: [1, 2, 3, 4, 5, 6, 7] })
      .expect(200);

    expect(response.body).toEqual({
      contacts: {
        "1": { status: "hot", updatedAt: "2026-04-01T10:00:00.000Z" },
        "2": { status: "warm", updatedAt: "2026-04-02T10:00:00.000Z" },
        "3": { status: "cold", updatedAt: "2026-04-03T10:00:00.000Z" },
      },
    });
    expect(response.body.contacts).not.toHaveProperty("4");
    expect(response.body.contacts).not.toHaveProperty("5");
    expect(response.body.contacts).not.toHaveProperty("6");
    expect(response.body.contacts).not.toHaveProperty("7");
    expect(mocks.query).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed, unsafe, non-positive, and over-limit ID lists", async () => {
    const invalidBodies = [
      {},
      { contactIds: null },
      { contactIds: "1" },
      { contactIds: [0] },
      { contactIds: [-1] },
      { contactIds: [1.5] },
      { contactIds: ["1"] },
      { contactIds: [Number.MAX_SAFE_INTEGER + 1] },
      { contactIds: Array.from({ length: 201 }, (_, index) => index + 1) },
    ];

    for (const body of invalidBodies) {
      await request(app).post("/analytics/gtm-status").send(body).expect(400);
    }
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("returns an empty map without querying for an empty ID list", async () => {
    const response = await request(app)
      .post("/analytics/gtm-status")
      .send({ contactIds: [] })
      .expect(200);

    expect(response.body).toEqual({ contacts: {} });
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("accepts the maximum 200 IDs in a single bounded request", async () => {
    mocks.query.mockResolvedValue(result([]));
    const contactIds = Array.from({ length: 200 }, (_, index) => index + 1);

    const response = await request(app)
      .post("/analytics/gtm-status")
      .send({ contactIds })
      .expect(200);

    expect(response.body).toEqual({ contacts: {} });
    expect(mocks.query).toHaveBeenCalledTimes(1);
    expect(mocks.query.mock.calls[0][1]).toEqual([7, contactIds]);
  });
});

describe("POST /analytics/acquisition provenance", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.query.mockImplementation(async (query: string) => {
      if (query.includes("FROM companies co WHERE co.tenant_id=$1")) {
        return result([{ id: 100, created_at: new Date("2026-09-03T07:48:00Z"), inbound_manual: false, monitored: false }]);
      }
      if (query.includes("SELECT 'contact' AS entity_type")) {
        return result([{
          entity_type: "account", entity_id: 100, id: 31,
          acquired_at: new Date("2026-09-23T17:59:00Z"),
          form_name: "Feedback.xlsx", form_type: "event_feedback",
        }]);
      }
      if (query.includes("FROM intent_monitoring_segments ims")) return result([]);
      throw new Error(`Unexpected SQL: ${query}`);
    });
  });

  it("keeps account creation separate from the first sourced form response", async () => {
    const response = await request(app).post("/analytics/acquisition")
      .send({ contactIds: [], accountIds: [100] }).expect(200);
    expect(response.body.accounts["100"]).toMatchObject({
      recordCreatedAt: "2026-09-03T07:48:00.000Z",
      firstAcquiredAt: "2026-09-23T17:59:00.000Z",
      sources: ["event_feedback"],
      leadForms: [],
      eventFeedback: [{ id: 31, formName: "Feedback.xlsx" }],
    });
  });
});