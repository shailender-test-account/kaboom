import { test as base, expect as playwrightExpect } from "@playwright/test";
import express from "express";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";

export const root = process.env.INTENT_DETAIL_E2E_URL || "http://localhost:80";
export const expect = playwrightExpect.configure({ timeout: 15_000 });
export const accounts = [
  { id: 41001, name: "Alpha fixture account", domain: "alpha.example.invalid", score: 50, tierKey: "warm", contacts: [] },
  { id: 41002, name: "Beta fixture account", domain: "beta.example.invalid", score: 50, tierKey: "warm", contacts: [] },
];
export type Section = "identity" | "evidence" | "analysis" | "research";
type Reply = { body: unknown; status?: number };
type Read = { path: string; query: Record<string, string>; section?: Section; id?: number };

function latch() {
  let release!: (reply: Reply) => void;
  const promise = new Promise<Reply>(resolve => { release = resolve; });
  return { promise, release };
}

class DetailControls {
  reads: Read[] = [];
  unexpected: string[] = [];
  writes: string[] = [];
  private held = new Map<string, ReturnType<typeof latch>>();
  private replies = new Map<string, Reply>();
  private pending = new Set<ReturnType<typeof latch>>();
  responded: string[] = [];

  key(id: number, section: Section) { return `${id}:${section}`; }
  hold(id: number, section: Section) {
    const gate = latch();
    this.held.set(this.key(id, section), gate);
    this.pending.add(gate);
    return {
      release: (body: unknown, status = 200) => {
        gate.release({ body, status });
        this.pending.delete(gate);
      },
    };
  }
  reply(id: number, section: Section, body: unknown, status = 200) {
    this.replies.set(this.key(id, section), { body, status });
  }
  count(id: number, section: Section) {
    return this.reads.filter(read => read.id === id && read.section === section).length;
  }
  async read(id: number, section: Section): Promise<Reply> {
    const key = this.key(id, section);
    const held = this.held.get(key);
    if (held) {
      this.held.delete(key);
      return held.promise;
    }
    const reply = this.replies.get(key);
    if (!reply) {
      this.unexpected.push(`Unconfigured panel ${key}`);
      return { status: 501, body: { error: `Unconfigured panel ${key}` } };
    }
    return reply;
  }
  close() {
    for (const gate of this.pending) gate.release({ status: 503, body: { error: "Fixture closed" } });
    this.pending.clear();
  }
}

export function evidence(id: number) {
  return {
    contacts: [{ id: id + 10, name: `Buyer ${id}`, title: "Procurement", score: 10 }],
    evidence: { public: [], companyKaboom: [], contactKaboom: [], uploaded: [
      { id: id + 20, evidenceKind: "event_questionnaire", excerpt: `Evidence for ${id}`, eventDate: "2026-10-01" },
    ] },
    scoreHistory: [],
  };
}
export function analysis(id: number) {
  return {
    score: 50, tierKey: "warm",
    canonicalCategoryIntent: { categoryName: "Security", score: 35, tier: "warm", rationale: `Qualification for ${id}`, source: "questionnaire" },
    intentStatus: { accountStatus: "warm", accountExplanation: `Qualification for ${id}`, accountDrivingSignals: [], categories: [] },
  };
}
export function identity(account: typeof accounts[number]) {
  return { id: account.id, name: account.name, domain: account.domain,
    analysisScope: { selectedProductIds: [41], selectedCategoryIds: [51] } };
}
export const research = { researchIntent: null, canonicalResearchIntent: null };

export const test = base.extend<{ detail: DetailControls }>({
  detail: async ({ page }, use) => {
    const controls = new DetailControls();
    const token = randomUUID();
    const user = { id: 1, tenantId: 1, tenantName: "Private browser fixture", email: "browser@example.invalid",
      firstName: "Browser", lastName: "Fixture", role: "editor", avatarUrl: null };
    const app = express();
    // Test-only loopback service, never imported by application code. No DB,
    // production routers, background workers or provider clients are loaded.
    app.use((req, res, next) => {
      if (req.headers["x-fixture-token"] !== token) { res.sendStatus(401); return; }
      if (req.method !== "GET") {
        controls.writes.push(`${req.method} ${req.path}`);
        res.sendStatus(405);
        return;
      }
      controls.reads.push({ path: req.path, query: Object.fromEntries(new URL(req.url, "http://fixture").searchParams) });
      next();
    });
    app.get("/api/auth/me", (_req, res) => res.json(user));
    // Shared header/sidebar reads are fixture-only; no workspace API escapes.
    app.get("/api/notifications", (_req, res) => res.json({ notifications: [], unreadCount: 0 }));
    app.get("/api/intent/inbound/source", (_req, res) => res.json({ source: null }));
    app.get("/api/intent/scope-options", (_req, res) => res.json({
      clients: [{ id: 21, name: "Fixture client" }], audiences: [{ id: 31, name: "Fixture audience" }],
      segments: [], accounts, categories: [], subcategories: [], products: [],
    }));
    app.get("/api/intent/overview", (_req, res) => res.json({
      totalAccounts: 2, activeSignals30d: 0, hotAccounts: 0, qualificationDeferred: true,
    }));
    app.get("/api/intent/accounts", (_req, res) => res.json({ accounts, hasMore: false, nextCursor: null, scanned: 2 }));
    app.get("/api/intent/accounts/:id", async (req, res) => {
      const id = Number(req.params.id), section = req.query.section as Section;
      if (!accounts.some(account => account.id === id) || !["identity", "evidence", "analysis", "research"].includes(section)) {
        controls.unexpected.push(`Invalid account panel ${req.originalUrl}`);
        res.sendStatus(400);
        return;
      }
      Object.assign(controls.reads.at(-1)!, { id, section });
      const reply = await controls.read(id, section);
      res.status(reply.status ?? 200).json(reply.body);
      controls.responded.push(controls.key(id, section));
    });
    app.get("/api/intent/accounts/:id/score-breakdown", (_req, res) => res.json({
      total: 0, contactPoints: 0, accountSignalPoints: 0, contacts: [], signals: [],
    }));
    app.get("/api/intent/opportunities/monitored-accounts", (_req, res) => res.json({ items: [] }));
    app.get("/api/intent/research/summary", (_req, res) => res.json({
      latestRun: { completedAt: "2026-01-01" }, activeRunCount: 0,
    }));
    app.get(["/api/intent/research/attribution-review", "/api/intent/research/attribution-review/history",
      "/api/intent/accounts/:id/research-corrections"], (_req, res) => res.json({ items: [], nextCursor: null }));
    app.use((req, res) => {
      controls.unexpected.push(`${req.method} ${req.originalUrl}`);
      res.sendStatus(501);
    });
    const server = app.listen(0, "127.0.0.1");
    try {
      await new Promise<void>(resolve => server.once("listening", resolve));
      const api = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      // Prove this private service cannot supply identity without its secret
      // per-test header. The browser only gets it via Playwright interception.
      const unauthenticated = await fetch(`${api}/api/auth/me`);
      expect(unauthenticated.status).toBe(401);
      await page.addInitScript(() => localStorage.setItem("onboarding_dismissed", "true"));
      await page.route("**/*", async route => {
        const request = route.request(), url = new URL(request.url());
        if (request.method() !== "GET") {
          controls.writes.push(`${request.method()} ${url.pathname}`);
          await route.abort();
        } else if (url.pathname.startsWith("/api/")) {
          const response = await route.fetch({ url: `${api}${url.pathname}${url.search}`,
            headers: { ...request.headers(), connection: "close", "x-fixture-token": token } });
          await route.fulfill({ response });
        } else if (url.origin === new URL(root).origin && request.method() === "GET") {
          await route.continue();
        } else {
          // No provider traffic may escape, even via a non-/api endpoint.
          if (!["font", "image", "stylesheet"].includes(request.resourceType())) controls.unexpected.push(request.url());
          await route.abort();
        }
      });
      await use(controls);
    } finally {
      controls.close();
      await page.unrouteAll({ behavior: "wait" });
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      expect(controls.writes, "Navigation must never research/send/enroll or mutate anything").toEqual([]);
      expect(controls.unexpected, "All API reads and external requests must be explicitly isolated").toEqual([]);
    }
  },
});
