import express from "express";
import request from "supertest";
import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  rows: [] as { id: number; tenant_id: number; lead_score: number; dnc: boolean }[],
  execute: vi.fn(),
  update: vi.fn(),
  routing: vi.fn(),
}));
vi.mock("@workspace/db", async () => ({
  ...await import("../../../../lib/db/src/schema"),
  pool: {},
  db: { execute: state.execute, update: state.update },
}));
vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (req: any, res: any, next: any) => {
    if (!req.get("x-test-tenant")) { res.sendStatus(401); return; }
    req.user = { tenantId: Number(req.get("x-test-tenant")), role: "admin" };
    next();
  },
}));
vi.mock("../lib/scoringEngine", () => ({ evaluateRoutingRules: state.routing }));
vi.mock("../lib/deleteCrmEntity", () => ({ deleteContactAndHistory: vi.fn() }));
vi.mock("../utils/segmentFilter", () => ({ buildContactsWhereClause: vi.fn() }));
vi.mock("../services/queue", () => ({ enqueueStep: vi.fn(), isTenantQueueAvailable: vi.fn() }));

import router from "../routes/contacts";

const app = express().use(express.json()).use(router).use((err: Error, _req: any, res: any, _next: any) =>
  res.status(500).json({ error: err.message }));
const dialect = new PgDialect();
const read = (tenant = 7, id = 42) => request(app).get(`/contacts/${id}`).set("x-test-tenant", String(tenant));
const patch = (dnc: boolean, tenant = 7) =>
  request(app).patch("/contacts/42").set("x-test-tenant", String(tenant)).send({ dnc });

beforeEach(() => {
  vi.clearAllMocks();
  state.rows = [{ id: 42, tenant_id: 7, lead_score: 0, dnc: false }];
  state.execute.mockImplementation(async (query) => {
    const { sql, params } = dialect.sqlToQuery(query);
    if (/SELECT c\.\*,/.test(sql)) {
      expect(sql).toContain("c.tenant_id =");
      return { rows: state.rows.filter(r => r.id === params[0] && r.tenant_id === params[1]) };
    }
    if (/^SELECT id, tenant_id, lead_score FROM contacts/.test(sql)) {
      return { rows: state.rows.filter(r => r.id === params[0]) };
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  });
  state.update.mockImplementation(() => ({
    set: (values: { dnc: boolean }) => ({
      where: (condition: any) => ({
        returning: async () => {
          const { params } = dialect.sqlToQuery(condition);
          const row = state.rows.find(r => r.id === params[0])!;
          row.dnc = values.dnc;
          return [{ id: row.id, tenantId: row.tenant_id, dnc: row.dnc }];
        },
      }),
    }),
  }));
});

describe("contact detail DNC persistence", () => {
  it.each([false, true])("returns persisted dnc=%s on every fresh detail request", async (dnc) => {
    state.rows[0].dnc = dnc;
    for (let i = 0; i < 2; i++) {
      const response = await read();
      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty("dnc", dnc);
    }
  });

  it.each([false, true])("toggles from %s and survives refetch and a fresh request", async (initial) => {
    state.rows[0].dnc = initial;
    for (const dnc of [!initial, initial]) {
      const updated = await patch(dnc);
      expect(updated.status).toBe(200);
      expect(updated.body.dnc).toBe(dnc);
      expect(state.rows[0].dnc).toBe(dnc);
      expect((await read()).body.dnc).toBe(dnc);
      expect((await read()).body.dnc).toBe(dnc);
    }
    expect(state.routing).not.toHaveBeenCalled();
  });

  it.each([false, true])("cannot read or change another tenant's dnc=%s", async (dnc) => {
    state.rows[0].dnc = dnc;
    expect((await read(8)).status).toBe(404);
    expect((await patch(!dnc, 8)).status).toBe(404);
    expect(state.update).not.toHaveBeenCalled();
    expect(state.rows[0].dnc).toBe(dnc);
    expect((await read()).body.dnc).toBe(dnc);
  });

  it("retains missing-contact and unauthenticated responses", async () => {
    expect((await read(7, 999)).status).toBe(404);
    expect((await request(app).get("/contacts/42")).status).toBe(401);
    expect((await request(app).patch("/contacts/42").send({ dnc: true })).status).toBe(401);
    expect(state.update).not.toHaveBeenCalled();
  });
});
