/** Exercise the actual compiled server without a real database or provider key. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import { setTimeout as pause } from "node:timers/promises";

const probe = net.createServer();
await new Promise(resolve => probe.listen(0, "127.0.0.1", resolve));
const port = probe.address().port;
await new Promise(resolve => probe.close(resolve));
const child = spawn(process.execPath, ["deployment/render/server.mjs"], {
  cwd: process.cwd(),
  // Deliberately no inherited database/AI/provider/session secrets or credentials.
  env: {
    PATH: process.env.PATH, HOME: process.cwd(), PORT: String(port),
    DATABASE_URL: "postgresql://dpg-render-smoke-fixture-a/kaboom_render",
    SESSION_SECRET: "synthetic-hermetic-smoke-fixture-1234567890",
    RENDER_EXTERNAL_URL: "https://independent-copy.onrender.com",
    RENDER_DATA_READY: "false", LOG_LEVEL: "silent",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let output = "";
child.stdout.on("data", data => { output += data; });
child.stderr.on("data", data => { output += data; });
let exited = false;
const stopped = new Promise(resolve => child.once("exit", code => { exited = true; resolve(code); }));
try {
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (exited) throw new Error("Compiled server exited before becoming ready.");
    try {
      const response = await fetch(`${base}/api/healthz`);
      if (response.status === 200) { ready = true; break; }
    } catch {}
    await pause(100);
  }
  assert.ok(ready, "Compiled server should start without provider keys or an available database.");
  const html = await fetch(`${base}/`);
  assert.equal(html.status, 200);
  const body = await html.text();
  assert.match(body, /<html/i);
  const asset = body.match(/src="([^"]+\/assets\/[^"]+\.js)"/)?.[1]
    ?? body.match(/src="(\/assets\/[^"]+\.js)"/)?.[1];
  assert.ok(asset, "Built entry script must be present.");
  assert.equal((await fetch(new URL(asset, base))).status, 200);
  const deep = await fetch(`${base}/analytics/hp`, { headers: { accept: "text/html" } });
  assert.equal(deep.status, 200);
  const login = await fetch(`${base}/api/auth/login`, {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}",
  });
  assert.equal(login.status, 503);
  assert.match((await login.json()).error, /independent database/i);
  assert.equal((await fetch(`${base}/.env`)).status, 404);
  console.log("PASS: actual compiled server, process health, built frontend/assets, deep routing and restoration gate.");
  console.log("No real database or provider credentials were supplied.");
} catch (error) {
  // Only this hermetic fixture's output can be printed.
  console.error(output.slice(-3000));
  throw error;
} finally {
  if (!exited) child.kill("SIGTERM");
  await Promise.race([stopped, pause(12_000)]);
  if (!exited) child.kill("SIGKILL");
}
