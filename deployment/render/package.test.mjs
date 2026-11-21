import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import path from "node:path";
import { configureEnvironment } from "./runtime.mjs";
import { mountRenderFrontend, renderCorsOrigin } from "./http.mjs";
const require = createRequire(new URL("../../artifacts/api-server/package.json", import.meta.url));
const express = require("express");
const session = require("express-session");
const request = require("supertest");

function environment(overrides = {}) {
  return { DATABASE_URL: "postgresql://dpg-independent-a/kaboom_render",
    SESSION_SECRET: "a".repeat(40), RENDER_EXTERNAL_URL: "https://independent-copy.onrender.com", ...overrides };
}
test("independent settings enforce paused automation, without editing the supplied secret", () => {
  const env = environment({ COPIED_DATA_SAFE_MODE: "false", MONITORING_RESEARCH_ENABLED: "true",
    HP_RULE_SEQUENCE_ROUTING_ENABLED: "true", UPSTASH_REDIS_URL: "synthetic", CONNECTORS_HOSTNAME: "synthetic" });
  assert.equal(configureEnvironment(env), "https://independent-copy.onrender.com");
  assert.equal(env.COPIED_DATA_SAFE_MODE, "true");
  assert.equal(env.MONITORING_RESEARCH_ENABLED, "false");
  assert.equal(env.HP_RULE_SEQUENCE_ROUTING_ENABLED, "false");
  assert.equal(env.AUTO_APPLY_SCHEMA_DRIFT, "false");
  assert.equal(env.USER_WELCOME_EMAIL_ENABLED, "false");
  assert.equal(env.UPSTASH_REDIS_URL, undefined);
  assert.equal(env.CONNECTORS_HOSTNAME, undefined);
  assert.equal(env.SESSION_SECRET, "a".repeat(40));
  assert.equal(env.OPENAI_API_KEY, undefined);
});
test("refuses missing and malformed configuration without exposing secret values", () => {
  for (const patch of [{ DATABASE_URL: "" }, { DATABASE_URL: "not-a-url" },
    { DATABASE_URL: "https://dpg-independent-a/db" }, { SESSION_SECRET: "short" },
    { BASE_URL: "http://independent-copy.onrender.com" }, { BASE_URL: "https://example.invalid/app" }]) {
    assert.throws(() => configureEnvironment(environment(patch)));
  }
});
test("refuses original database hosts and original application URLs", () => {
  for (const host of ["helium", "localhost", "original.neon.tech"]) {
    assert.throws(() => configureEnvironment(environment({ DATABASE_URL: `postgresql://${host}/original` })));
  }
  for (const url of ["https://kaboomremix.com", "https://kaboom-remix.replit.app",
    "https://workspace.replit.dev", "https://copy.invalid/?secret=example"]) {
    assert.throws(() => configureEnvironment(environment({ BASE_URL: url })));
  }
});
test("accepts Render external PostgreSQL hosts and an independent custom origin", () => {
  const env = environment({
    DATABASE_URL: "postgresql://dpg-new-a.oregon-postgres.render.com/kaboom_render",
    BASE_URL: "https://independent.example.invalid/",
  });
  assert.equal(configureEnvironment(env), "https://independent.example.invalid");
});

let directory;
let app;
const previousReady = process.env.RENDER_DATA_READY;
const previousBase = process.env.BASE_URL;
before(() => {
  const output = path.resolve("generated-artifacts");
  mkdirSync(output, { recursive: true });
  directory = mkdtempSync(path.join(output, "render-http-fixture-"));
  mkdirSync(path.join(directory, "assets"));
  writeFileSync(path.join(directory, "index.html"), "<!doctype html><title>Synthetic render fixture</title>");
  writeFileSync(path.join(directory, "assets", "main.js"), "console.log('synthetic fixture');");
  writeFileSync(path.join(directory, ".env"), "SYNTHETIC_DO_NOT_SERVE");
  process.env.RENDER_DATA_READY = "true";
  process.env.BASE_URL = "https://independent-copy.onrender.com";
  app = express();
  mountRenderFrontend(app, express, directory);
  app.use(express.json());
  app.use(session({ secret: "synthetic-session-fixture-only-1234567890", resave: false,
    saveUninitialized: false, cookie: { httpOnly: true, secure: true, sameSite: "lax" } }));
  app.get("/api/healthz", (_req, res) => res.json({ status: "ok" }));
  app.get("/api/example", (_req, res) => res.json({ synthetic: true }));
  app.get("/api/public/click/:token", (_req, res) => res.json({ unsafe: true }));
  app.post("/api/auth/login", (req, res) => { req.session.synthetic = true; res.json({ ok: true }); });
  app.patch("/api/auth/password", (_req, res) => res.json({ synthetic: true }));
  app.post("/api/analytics/gtm-status", (_req, res) => res.json({ synthetic: true }));
  app.post("/api/analytics/acquisition", (_req, res) => res.json({ synthetic: true }));
  app.post("/api/sequences/send", (_req, res) => res.json({ unsafe: true }));
  app.use((_req, res) => res.status(404).json({ error: "Not found" }));
});
after(() => {
  if (directory) rmSync(directory, { recursive: true, force: true });
  if (previousReady === undefined) delete process.env.RENDER_DATA_READY; else process.env.RENDER_DATA_READY = previousReady;
  if (previousBase === undefined) delete process.env.BASE_URL; else process.env.BASE_URL = previousBase;
});
test("serves frontend root, deep SPA routes and built assets", async () => {
  for (const url of ["/", "/analytics/hp", "/crm/contacts/123"]) {
    const response = await request(app).get(url).set("Accept", "text/html").expect(200);
    assert.match(response.text, /Synthetic render fixture/);
  }
  await request(app).get("/assets/main.js").expect(200);
});
test("API and missing assets do not fall through to frontend HTML", async () => {
  const response = await request(app).get("/api/missing").set("Accept", "text/html").expect(404);
  assert.equal(response.body.error, "Not found");
  await request(app).get("/assets/missing.js").set("Accept", "text/html").expect(404);
  await request(app).get("/.env").expect(404);
  await request(app).get("/.git/config").expect(404);
});
test("database gate locks API reads and login but retains process health and frontend", async () => {
  process.env.RENDER_DATA_READY = "false";
  try {
    await request(app).get("/api/healthz").expect(200);
    await request(app).get("/").set("Accept", "text/html").expect(200);
    await request(app).get("/api/example").expect(503);
    await request(app).post("/api/auth/login").send({}).expect(503);
  } finally { process.env.RENDER_DATA_READY = "true"; }
});
test("login cookie is secure behind the HTTPS proxy, and first-login password change is allowed", async () => {
  const response = await request(app).post("/api/auth/login").set("X-Forwarded-Proto", "https")
    .set("Origin", process.env.BASE_URL).send({}).expect(200);
  const cookie = response.headers["set-cookie"].join("; ");
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /Secure/i);
  assert.match(cookie, /SameSite=Lax/i);
  await request(app).patch("/api/auth/password").set("Origin", process.env.BASE_URL).send({}).expect(200);
});
test("read-only reports work without granting mutation or outbound access", async () => {
  await request(app).get("/api/example").expect(200);
  for (const url of ["/api/analytics/gtm-status", "/api/analytics/acquisition"]) {
    await request(app).post(url).send({}).expect(200);
  }
  for (const url of ["/api/sequences/send", "/api/intent/monitoring/run",
    "/api/sales-feedback", "/api/auth/forgot-password", "/api/users"]) {
    const response = await request(app).post(url).send({}).expect(403);
    assert.equal(response.body.code, "RENDER_VALIDATION_READ_ONLY");
  }
  await request(app).delete("/api/companies/123").expect(403);
  await request(app).get("/api/public/click/synthetic").expect(503);
  await request(app).get("/api/track/open").expect(503);
  await request(app).get("/api/storage/signed-url").expect(503);
  await request(app).post("/API/sequences/send").send({}).expect(403);
  await request(app).get("/API/PUBLIC/click/synthetic").expect(503);
});
test("cross-origin changes are rejected before reaching authentication", async () => {
  await request(app).post("/api/auth/login").set("Origin", "https://unrelated.example.invalid").send({}).expect(403);
  for (const [origin, expected] of [[undefined, true], [process.env.BASE_URL, true],
    ["https://unrelated.example.invalid", false]]) {
    renderCorsOrigin(origin, (error, allowed) => { assert.equal(error, null); assert.equal(allowed, expected); });
  }
});
test("template never auto-migrates, and its default gate stays off", () => {
  const yaml = readFileSync(new URL("./render.yaml", import.meta.url), "utf8");
  assert.doesNotMatch(yaml, /^\s*(?:preDeployCommand|initialDeployHook):/m);
  assert.match(yaml, /healthCheckPath: \/api\/healthz/);
  assert.match(yaml, /RENDER_DATA_READY\s+value: "false"/);
  const entry = readFileSync(new URL("./entry.ts", import.meta.url), "utf8");
  assert.doesNotMatch(entry, /start\w*(?:Runner|Worker|Scheduler)|ensurePolyContest|applyRawSqlMigrations/);
});
