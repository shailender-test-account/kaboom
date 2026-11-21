// import path from "node:path";
// import { existsSync } from "node:fs";

// const authWrites = new Set([
//   "POST /api/auth/login", "POST /api/auth/logout", "POST /api/auth/logout-all",
//   "POST /api/auth/setup-password", "POST /api/auth/reset-password", "PATCH /api/auth/password",
// ]);
// const readReports = new Set(["POST /api/analytics/gtm-status", "POST /api/analytics/acquisition"]);
// const blockedReads = /^\/api\/(?:public|track|webhooks?|email-webhook|unsubscribe|contest|storage)(?:\/|$)/i;

// export function renderGuard(req, res, next) {
//   let route;
//   try { route = decodeURIComponent(req.path).replace(/\/+$/, "").toLowerCase() || "/"; }
//   catch { res.status(400).json({ error: "Invalid URL encoding" }); return; }
//   if (route.split("/").some(part => part.startsWith("."))) { res.sendStatus(404); return; }
//   if (route === "/api" || route === "/api/healthz") return next();
//   if (!route.startsWith("/api/")) return next();
//   if (!["GET", "HEAD", "OPTIONS"].includes(req.method)
//       && req.get("origin") && req.get("origin") !== process.env.BASE_URL) {
//     res.status(403).json({ error: "Cross-origin changes are not allowed." });
//     return;
//   }
//   if (process.env.RENDER_DATA_READY !== "true") {
//     res.status(503).json({ error: "Restore and verify the independent database before setting RENDER_DATA_READY=true." });
//     return;
//   }
//   if (blockedReads.test(route)) {
//     res.status(503).json({ error: "Public tracking, webhooks and external storage are disabled in this validation copy." });
//     return;
//   }
//   const method = req.method.toUpperCase();
//   if (["GET", "HEAD", "OPTIONS"].includes(method) || authWrites.has(`${method} ${route}`)
//       || readReports.has(`${method} ${route}`)) return next();
//   res.status(403).json({
//     error: "This Render copy is in read-only validation mode. Outreach, sync, imports and data changes are disabled.",
//     code: "RENDER_VALIDATION_READ_ONLY",
//   });
// }

// export function mountRenderFrontend(app, express, publicDir = path.resolve("artifacts/playforge/dist/public")) {
//   if (!existsSync(path.join(publicDir, "index.html"))) throw new Error("Build PlayForge before starting the Render server.");
//   app.set("trust proxy", 1);
//   app.disable("x-powered-by");
//   app.use((req, res, next) => {
//     res.setHeader("X-Content-Type-Options", "nosniff");
//     res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
//     next();
//   });
//   app.use(renderGuard);
//   app.use((req, res, next) => {
//     if (/^\/api(?:\/|$)/i.test(req.path)) return next();
//     return express.static(publicDir, { index: false, dotfiles: "deny", maxAge: 0 })(req, res, next);
//   });
//   app.use((req, res, next) => {
//     if (!["GET", "HEAD"].includes(req.method) || /^\/api(?:\/|$)/i.test(req.path)
//       || path.extname(req.path) || !req.accepts("html")) return next();
//     res.setHeader("Cache-Control", "no-store");
//     res.sendFile(path.join(publicDir, "index.html"));
//   });
// }

// export function renderCorsOrigin(origin, callback) {
//   callback(null, !origin || origin === process.env.BASE_URL);
// }

import path from "node:path";
import { existsSync } from "node:fs";

const authWrites = new Set([
  "POST /api/auth/login", "POST /api/auth/logout", "POST /api/auth/logout-all",
  "POST /api/auth/setup-password", "POST /api/auth/reset-password", "PATCH /api/auth/password",
]);
const readReports = new Set(["POST /api/analytics/gtm-status", "POST /api/analytics/acquisition"]);
const blockedReads = /^\/api\/(?:public|track|webhooks?|email-webhook|unsubscribe|contest|storage)(?:\/|$)/i;

export function renderGuard(req, res, next) {
  let route;
  try { route = decodeURIComponent(req.path).replace(/\/+$/, "").toLowerCase() || "/"; }
  catch { res.status(400).json({ error: "Invalid URL encoding" }); return; }
  if (route.split("/").some(part => part.startsWith("."))) { res.sendStatus(404); return; }
  if (route === "/api" || route === "/api/healthz") return next();
  if (!route.startsWith("/api/")) return next();
  if (!["GET", "HEAD", "OPTIONS"].includes(req.method)
      && req.get("origin") && req.get("origin") !== process.env.BASE_URL) {
    res.status(403).json({ error: "Cross-origin changes are not allowed." });
    return;
  }
  if (process.env.RENDER_DATA_READY !== "true") {
    res.status(503).json({ error: "Restore and verify the independent database before setting RENDER_DATA_READY=true." });
    return;
  }
  if (blockedReads.test(route)) {
    res.status(503).json({ error: "Public tracking, webhooks and external storage are disabled in this validation copy." });
    return;
  }
  const method = req.method.toUpperCase();
  if (["GET", "HEAD", "OPTIONS"].includes(method) || authWrites.has(`${method} ${route}`)
      || readReports.has(`${method} ${route}`)) return next();
  res.status(403).json({
    error: "This Render copy is in read-only validation mode. Outreach, sync, imports and data changes are disabled.",
    code: "RENDER_VALIDATION_READ_ONLY",
  });
}

export function mountRenderFrontend(app, express, publicDir = path.resolve("artifacts/playforge/dist/public")) {
  const hasFrontend = existsSync(path.join(publicDir, "index.html"));

  app.set("trust proxy", 1);
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    next();
  });
  app.use(renderGuard);

  if (!hasFrontend) return;

  app.use((req, res, next) => {
    if (/^\/api(?:\/|$)/i.test(req.path)) return next();
    return express.static(publicDir, { index: false, dotfiles: "deny", maxAge: 0 })(req, res, next);
  });
  app.use((req, res, next) => {
    if (!["GET", "HEAD"].includes(req.method) || /^\/api(?:\/|$)/i.test(req.path)
      || path.extname(req.path) || !req.accepts("html")) return next();
    res.setHeader("Cache-Control", "no-store");
    res.sendFile(path.join(publicDir, "index.html"));
  });
}

export function renderCorsOrigin(origin, callback) {
  callback(null, !origin || origin === process.env.BASE_URL);
}
