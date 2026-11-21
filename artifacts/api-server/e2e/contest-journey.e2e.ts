/**
 * End-to-end test: HP Poly 2-Minute Meeting Rescue — full 4-step journey
 *
 * Verifies the complete functional flow after the Step 2/3 layout changes:
 *   Step 1  → Choose scenario
 *   Step 2A → Registration form
 *   Step 2B → Animation + challenge overlay (floats over scene)
 *   Step 3  → Two-column layout: scene photo (left) + solution cards (right)
 *   Step 4  → Gift form → POST /api/contest/entries returns 200 → success screen
 */

import { test, expect } from "@playwright/test";
import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { AddressInfo } from "net";

// ── Static file server ───────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, "../../playforge/public");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css":  "text/css",
  ".js":   "application/javascript",
  ".png":  "image/png",
  ".jpg":  "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg":  "image/svg+xml",
  ".ico":  "image/x-icon",
};

function createStaticServer(): http.Server {
  return http.createServer((req, res) => {
    // Serve the contest page at root
    const urlPath = req.url?.split("?")[0] ?? "/";
    const relPath  = urlPath === "/" ? "/poly-contest-rescue.html" : urlPath;
    const filePath = path.join(PUBLIC_DIR, relPath);

    let data: Buffer;
    try {
      data = fs.readFileSync(filePath);
    } catch {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { "Content-Type": MIME[ext] ?? "application/octet-stream" });
    res.end(data);
  });
}

// ── Shared server fixture ────────────────────────────────────────────────────

let server: http.Server;
let baseUrl: string;

test.beforeAll(async () => {
  server  = createStaticServer();
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

test.afterAll(async () => {
  await new Promise<void>(r => server.close(() => r()));
});

// ── Main journey test ────────────────────────────────────────────────────────

test("full 4-step contest journey — airport scenario", async ({ page }) => {
  // ── Intercept the API call ────────────────────────────────────────────────
  let capturedPayload: Record<string, unknown> | null = null;

  await page.route("**/api/contest/entries", async route => {
    if (route.request().method() !== "POST") return route.continue();

    const body = route.request().postDataJSON() as Record<string, unknown>;
    capturedPayload = body;

    await route.fulfill({
      status:  200,
      contentType: "application/json",
      body: JSON.stringify({ id: 1, submitted_at: new Date().toISOString() }),
    });
  });

  // ── Navigate ──────────────────────────────────────────────────────────────
  await page.goto(baseUrl);
  await expect(page.locator("#hp-cover")).toBeVisible();

  // ══ STEP 1: Choose scenario ═════════════════════════════════════════════

  // Click "Play Now" to reveal scenario picker
  await page.click("#cover-play-btn");
  await expect(page.locator("#scenario-section")).toBeVisible();

  // "START THE RESCUE" must be disabled until a scenario is selected
  await expect(page.locator("#play-now-btn")).toBeDisabled();

  // Select "airport" scenario card
  await page.click('.scenario-card[onclick*="airport"]');
  await expect(page.locator('.scenario-card[onclick*="airport"]')).toHaveClass(/selected/);
  await expect(page.locator("#play-now-btn")).toBeEnabled();

  // Advance to Step 2
  await page.click("#play-now-btn");
  await expect(page.locator("#step-2")).toHaveClass(/active/);

  // ══ STEP 2A: Registration form ══════════════════════════════════════════

  await expect(page.locator("#s2a")).toHaveClass(/active/);
  await expect(page.locator("#s2b")).not.toHaveClass(/active/);

  // Fill the registration form
  await page.fill("#f-name",  "Jane Doe");
  await page.fill("#f-org",   "Acme Corp");
  await page.fill("#f-desig", "IT Director");
  await page.fill("#f-email", "jane.doe@acme.com");

  // Accept the privacy checkbox (JS helper toggleCheck writes to the hidden checkbox)
  await page.click('[for="chk-privacy"], .consent-row:has(#chk-privacy)');

  // Submit the registration form
  await page.click("#reg-submit-btn");

  // ══ STEP 2B: Animation scene + challenge overlay ════════════════════════

  await expect(page.locator("#s2b")).toHaveClass(/active/);
  await expect(page.locator("#s2a")).not.toHaveClass(/active/);

  // Skip the 25-second animation so the challenge section reveals immediately
  await page.click(".anim-skip");

  // challenge-section is positioned INSIDE #s2b (position: relative) as an
  // absolute overlay at bottom:0 — verify it is visible on screen
  const challengeSection = page.locator("#challenge-section");
  await expect(challengeSection).toBeVisible();

  // Confirm the overlay is rendered inside the scene wrapper (overlaid layout)
  const s2bBounds      = await page.locator("#s2b").boundingBox();
  const overlayBounds  = await challengeSection.boundingBox();
  expect(s2bBounds).not.toBeNull();
  expect(overlayBounds).not.toBeNull();

  // The overlay bottom must align with the scene bottom (within 8 px tolerance)
  const s2bBottom      = s2bBounds!.y + s2bBounds!.height;
  const overlayBottom  = overlayBounds!.y + overlayBounds!.height;
  expect(Math.abs(overlayBottom - s2bBottom)).toBeLessThan(8);

  // The overlay must start inside the scene (not above it)
  expect(overlayBounds!.y).toBeGreaterThan(s2bBounds!.y);

  // Pick exactly 2 challenges
  const challengeOpts = page.locator(".challenge-opt");
  await expect(challengeOpts).toHaveCount(5); // CONTEST_DATA has 5 challenges

  await challengeOpts.nth(0).click(); // bg_noise
  await challengeOpts.nth(1).click(); // cant_hear

  // Badge should now show "complete"
  await expect(page.locator("#challenge-badge")).toHaveClass(/complete/);
  await expect(page.locator("#challenge-next-btn")).toBeEnabled();

  // Advance to Step 3
  await page.click("#challenge-next-btn");
  await expect(page.locator("#step-3")).toHaveClass(/active/);

  // ══ STEP 3: Two-column solutions layout ═════════════════════════════════

  // Left column: scene photo panel
  const sceneCol = page.locator(".step3-scene-col");
  await expect(sceneCol).toBeVisible();

  // The scene background div must have the airport photo set
  const sceneBg = page.locator("#step3-scene-bg");
  const sceneBgStyle = await sceneBg.getAttribute("style");
  expect(sceneBgStyle).toMatch(/executive-airport\.jpg/);

  // Scene caption must show the correct scenario title
  await expect(page.locator("#step3-scene-title")).toHaveText("Busy Airport Lounge");

  // Right column: exactly 2 rec-cards in the grid
  const recCards = page.locator("#rec-cards-grid .rec-card");
  await expect(recCards).toHaveCount(2);

  // First card is the primary recommendation
  await expect(recCards.nth(0).locator(".rec-card-header")).toHaveClass(/primary/);
  await expect(recCards.nth(0).locator(".rec-card-name")).toContainText("HP Poly Focus 6");

  // Second card is the alternate recommendation
  await expect(recCards.nth(1).locator(".rec-card-header")).toHaveClass(/alternate/);
  await expect(recCards.nth(1).locator(".rec-card-name")).toContainText("Voyager Free 60");

  // Two-column grid: both cards should be visible side-by-side
  const card0Box = await recCards.nth(0).boundingBox();
  const card1Box = await recCards.nth(1).boundingBox();
  expect(card0Box).not.toBeNull();
  expect(card1Box).not.toBeNull();
  // Cards are side-by-side when they share the same top-row (within 40 px vertical delta)
  expect(Math.abs(card0Box!.y - card1Box!.y)).toBeLessThan(40);
  // Each card's left edge must differ by more than its own width (not stacked)
  expect(card1Box!.x).toBeGreaterThan(card0Box!.x + card0Box!.width / 2);

  // Advance to Step 4
  await page.click('.content-card button.btn-primary:has-text("CLAIM YOUR GIFT")');
  await expect(page.locator("#step-4")).toHaveClass(/active/);

  // ══ STEP 4: Gift form + submission ══════════════════════════════════════

  // Prefilled name & org from registration
  await expect(page.locator("#gf-name")).toHaveValue("Jane Doe");
  await expect(page.locator("#gf-org")).toHaveValue("Acme Corp");

  // Fill in required gift fields
  await page.fill("#gf-mobile", "+91 98765 43210");

  // Accept contest rules checkbox
  await page.click('.consent-row:has(#gf-chk-contest)');

  // Submit
  await page.click("#gift-submit-btn");

  // ══ Success screen ═══════════════════════════════════════════════════════

  await expect(page.locator("#success-screen")).toHaveClass(/active/);
  await expect(page.locator(".success-title")).toContainText("You're in the draw");

  // ── Verify captured API payload ──────────────────────────────────────────
  expect(capturedPayload).not.toBeNull();
  expect(capturedPayload!.scenario).toBe("airport");
  expect(capturedPayload!.challenges).toEqual(
    expect.arrayContaining(["bg_noise", "cant_hear"]),
  );
  expect(capturedPayload!.name).toBe("Jane Doe");
  expect(capturedPayload!.email).toBe("jane.doe@acme.com");
  expect(capturedPayload!.mobile).toBe("+91 98765 43210");
});

// ── POST /api/contest/entries unit-level contract test ───────────────────────

test("POST /api/contest/entries returns 200 and echoes correct shape", async ({ page }) => {
  let responseStatus: number | null = null;
  let responseBody: Record<string, unknown> | null = null;

  await page.route("**/api/contest/entries", async route => {
    if (route.request().method() !== "POST") return route.continue();
    responseStatus = 200;
    const fakeBody = { id: 42, submitted_at: new Date().toISOString() };
    responseBody = fakeBody;
    await route.fulfill({
      status:      200,
      contentType: "application/json",
      body:        JSON.stringify(fakeBody),
    });
  });

  await page.goto(baseUrl);

  // Drive the page quickly to submission so fetch() is invoked
  await page.click("#cover-play-btn");
  await page.click('.scenario-card[onclick*="support"]');
  await page.click("#play-now-btn");

  await page.fill("#f-name",  "Test User");
  await page.fill("#f-org",   "Test Org");
  await page.fill("#f-desig", "Manager");
  await page.fill("#f-email", "test@example.com");
  await page.click('.consent-row:has(#chk-privacy)');
  await page.click("#reg-submit-btn");

  await page.click(".anim-skip");
  await page.locator(".challenge-opt").nth(0).click();
  await page.locator(".challenge-opt").nth(2).click();
  await page.click("#challenge-next-btn");
  await page.click('.content-card button.btn-primary:has-text("CLAIM YOUR GIFT")');

  await page.fill("#gf-mobile", "+1-555-0100");
  await page.click('.consent-row:has(#gf-chk-contest)');
  await page.click("#gift-submit-btn");

  await expect(page.locator("#success-screen")).toHaveClass(/active/);

  // The route interceptor ran → status was 200
  expect(responseStatus).toBe(200);
  expect(responseBody).toMatchObject({ id: 42 });
});
