import { test as base, expect as playwrightExpect } from "@playwright/test";
import express from "express";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { pool } from "@workspace/db";
import dealsRouter from "../../src/routes/deals";
import hpRouter from "../../src/routes/hpBi";
import aiAnswerRouter from "../../src/routes/aiAnswer";
import companiesRouter from "../../src/routes/companies";
import engagementHistoryRouter from "../../src/routes/engagementHistory";
import contactsRouter from "../../src/routes/contacts";
import notesRouter from "../../src/routes/notes";
import scoringRouter from "../../src/routes/scoring";
import committeeRouter from "../../src/routes/buyingCommittee";
import salesFeedbackRouter from "../../src/routes/salesFeedback";
import hotFollowUpsRouter from "../../src/routes/hotFollowUps";
import { registerInboundSubmissionDateRoute } from "../../src/routes/inboundSubmissionDate";
import { cleanHpCrmTenant, seedHpCrmAccounts } from "../../src/lib/testFixtures/hpCrm";

type Fixture = Awaited<ReturnType<typeof seedHpCrmAccounts>> & { tenantId: number; clientId: number };
// Cold analytics bundles can take longer when the backend suite runs alongside
// this gate. Wait for the actual condition; never retry or bypass an assertion.
export const expect = playwrightExpect.configure({ timeout: 15_000 });
export const test = base.extend<{ hp: Fixture }>({
  hp: async ({ page }, use) => {
    let tenantId: number | undefined;
    let server: ReturnType<express.Application["listen"]> | undefined;
    const token = randomUUID();
    const unexpected: string[] = [];
    try {
      tenantId = Number((await pool.query(
        "INSERT INTO tenants(name,slug) VALUES('HP browser fixture',$1) RETURNING id",
        [`hp-browser-${randomUUID()}`],
      )).rows[0].id);
      const clientId = Number((await pool.query(
        "INSERT INTO clients(tenant_id,name) VALUES($1,'HP') RETURNING id", [tenantId],
      )).rows[0].id);
      const accounts = await seedHpCrmAccounts(tenantId, clientId);
      const user = { id: null, tenantId, tenantName: "HP browser fixture", email: "browser@example.invalid",
        firstName: "Browser", lastName: "Fixture", role: "admin", avatarUrl: null };
      const app = express();
      app.use(express.json());
      // Private, loopback-only test server. No auth bypass is added to production.
      app.use((req: any, res, next) => {
        if (req.headers["x-fixture-token"] !== token) { res.sendStatus(401); return; }
        req.isAuthenticated = () => true;
        req.user = user;
        req.log = { warn() {} };
        next();
      });
      app.get("/api/auth/me", (_req, res) => res.json(user));
      app.get("/api/clients", async (_req, res) => res.json((await pool.query(
        'SELECT id,name FROM clients WHERE tenant_id=$1', [tenantId],
      )).rows));
      // Unrelated chrome is deliberately isolated, not reporting or deal data.
      app.get("/api/notifications", (_req, res) => res.json({ notifications: [], unreadCount: 0 }));
      app.get("/api/intent/inbound/source", (_req, res) => res.json({ source: null }));
      // Analytics mounts legacy background readers before it identifies HP.
      // Do not fake their data or let them touch the workspace API.
      app.get(["/api/analytics/inbound-account-options", "/api/analytics/traffic", "/api/analytics/landing-urls"],
        (_req, res) => res.status(501).json({ error: "Legacy analytics is outside the isolated HP regression scope." }));
       app.get(["/api/analytics/dashboard/summary", "/api/analytics/dashboard/panels", "/api/analytics/calls/top-opportunities"],
         (_req, res) => res.status(501).json({ error: "Unrelated dashboard chrome is outside the isolated fixture scope." }));
       const submissionDateRouter = express.Router();
       registerInboundSubmissionDateRoute(submissionDateRouter);
       // HP account details also read the committee panel. Exercise the real
       // tenant-scoped read; keep sourcing and other paid/mutation routes blocked.
       app.use("/api", (req, res, next) => {
         if (req.method === "GET" && ["/buying-committee/contacts", "/buying-committee/options"].includes(req.path)) {
           committeeRouter(req, res, next);
         } else next();
       });
       // Account history now reads feedback and individual Hot follow-ups.
       // Exercise the real fixture-tenant reads; imports, sources, reviews and
       // follow-up mutations remain outside this correction test's allowlist.
       app.use("/api", (req, res, next) => {
         if (req.method === "GET" && req.path === "/sales-feedback/hot-follow-ups")
           hotFollowUpsRouter(req, res, next);
         else if (req.method === "GET" && ["/sales-feedback", "/sales-feedback/"].includes(req.path))
           salesFeedbackRouter(req, res, next);
         else next();
       });
          app.use("/api", dealsRouter, hpRouter, aiAnswerRouter, companiesRouter, submissionDateRouter, engagementHistoryRouter,
            contactsRouter, notesRouter, scoringRouter);
      app.use((req, res) => { unexpected.push(`${req.method} ${req.path}`); res.sendStatus(501); });
      app.use((err: Error, _req: any, res: any, _next: any) => res.status(500).json({ error: err.message }));
      server = app.listen(0, "127.0.0.1");
      await new Promise<void>(resolve => server!.once("listening", resolve));
      const api = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const origin = new URL(process.env.HP_CRM_E2E_URL || "http://localhost:80").origin;
      await page.addInitScript(() => localStorage.setItem("onboarding_dismissed", "true"));
      await page.route("**/*", async route => {
        const request = route.request(), url = new URL(request.url());
        if (url.pathname.startsWith("/api/")) {
          const response = await route.fetch({ url: `${api}${url.pathname}${url.search}`,
            // Avoid reusing a socket at Node's idle keep-alive timeout during
            // slow bundle navigation. Do not retry mutations on lost replies.
            headers: { ...request.headers(), connection: "close", "x-fixture-token": token } });
          await route.fulfill({ response });
        } else if (url.origin === origin) {
          await route.continue();
        } else {
          // Fonts and third-party assets may not leave the test, nor can sends.
          if (!["image", "font", "stylesheet"].includes(request.resourceType())) unexpected.push(request.url());
          await route.abort();
        }
      });
      await use({ tenantId, clientId, ...accounts });
      expect(unexpected, "New API/external requests must be explicitly scoped in the fixture").toEqual([]);
    } finally {
      await page.unrouteAll({ behavior: "wait" });
      if (server) await new Promise<void>((resolve, reject) => server!.close(e => e ? reject(e) : resolve()));
      if (tenantId) await cleanHpCrmTenant(tenantId);
    }
  },
});
