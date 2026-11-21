import type { Page } from "@playwright/test";
import { pool } from "@workspace/db";
import { hpWorkbook } from "../src/lib/testFixtures/hpCrm";
import { expect, test } from "./fixtures/hp-crm";

const root = process.env.HP_CRM_E2E_URL || "http://localhost:80";
const headers = ["UNIQUE ID", "SUBSIDIARY_LEGAL_NAME", "TOP_ID", "TOP_NAME", "FY25 GTM", "PS RAD"];
const workbook = (name: string) => hpWorkbook(headers, [
  ["CRM-A", "CRM A", "CRM-P", "CRM Parent", "GCC", "R1"],
  ["ROSTER-NEW", name, "CRM-P", "CRM Parent", "GCC", "R1"],
]);
const upload = async (page: Page, name: string) => page.getByTestId("input-import-file").setInputFiles({
  name, mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: workbook("New Legal Entity"),
});

test("HP roster preview requires current approval, imports owned and new legal accounts once", async ({ page, hp }) => {
  test.setTimeout(240_000);
  // The fixture seeds CRM-owned profiles through the importer for repeatability.
  // Remove only its seed import marker and contacts so this journey starts from
  // the requested no-roster-import, zero-contact CRM baseline.
  await pool.query("DELETE FROM contacts WHERE tenant_id=$1 AND client_id=$2", [hp.tenantId, hp.clientId]);
  await pool.query("DELETE FROM hp_bi_imports WHERE tenant_id=$1 AND client_id=$2 AND kind='accounts'", [hp.tenantId, hp.clientId]);

  await page.goto(`${root}/analytics?clientId=${hp.clientId}`);
  await expect(page.getByTestId("hp-bi-dashboard")).toBeVisible();
  const coverage = page.getByTestId("roster-coverage");
  await expect(coverage).toContainText("Existing CRM baseline — no account workbook imported");
  await expect(coverage).toContainText("2 legal accounts / 1 parent groups");
  await expect(coverage).toContainText("Accounts without contacts or activity remain included");
  await expect(page.getByTestId("kpi-score")).toContainText("Unavailable");
  await expect(page.locator('[data-testid^="row-account-"]').first().locator("td").nth(12)).toHaveText("—");
  await expect(page.getByTestId("text-pagination")).toContainText("1 parent groups");
  await page.screenshot({ path: test.info().outputPath("initial-dashboard.png"), fullPage: true });

  // Inspect the actual modal at a phone-sized viewport before starting the import.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByTestId("button-import").click();
  const dialog = page.getByTestId("dialog-hp-import");
  await expect(dialog).toBeVisible();
  await expect.poll(async () => {
    const b = await dialog.boundingBox();
    return !!b && b.x >= 0 && b.x + b.width <= 390;
  }).toBe(true);
  expect(await dialog.evaluate(e => e.scrollWidth <= e.clientWidth + 1)).toBe(true);
  await page.setViewportSize({ width: 1280, height: 900 });

  await upload(page, "hp-roster-small.xlsx");
  await page.getByTestId("button-preview-import").click();
  const impact = page.getByTestId("roster-import-impact");
  await expect(impact).toBeVisible();
  await expect(page.getByTestId("text-preview-counts")).toContainText("2 rows / 2 unique accounts");
  await expect(impact).toContainText("2 distinct legal accounts / 1 source parent groups / 0 consolidated duplicate rows");
  await expect(impact).toContainText("1 new CRM accounts / 1 existing matches / 0 held for identity review");
  await expect(impact).toContainText("3 legal accounts / 1 parent groups");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(async () => {
    const b = await dialog.boundingBox();
    return !!b && b.x >= 0 && b.x + b.width <= 390;
  }).toBe(true);
  expect(await dialog.evaluate(e => e.scrollWidth <= e.clientWidth + 1)).toBe(true);
  await page.screenshot({ path: test.info().outputPath("mobile-import-preview.png"), fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });
  const run = page.getByTestId("button-run-import");
  await expect(run).toBeDisabled();
  await page.getByTestId("check-approve-roster").check();
  await expect(run).toBeEnabled();

  // Replacing the file after approval must invalidate both the preview and approval.
  await page.getByTestId("input-import-file").setInputFiles({
    name: "hp-roster-revised.xlsx",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer: workbook("New Legal Entity Revised"),
  });
  await expect(impact).toBeHidden();
  await expect(page.getByTestId("check-approve-roster")).toHaveCount(0);
  await expect(run).toHaveCount(0);
  await page.getByTestId("button-preview-import").click();
  await expect(impact).toContainText("1 new CRM accounts / 1 existing matches / 0 held for identity review");
  await page.getByTestId("check-approve-roster").check();
  const firstImportResponse = page.waitForResponse(r => r.url().includes("/api/analytics/hp-bi/import?")
    && r.request().method() === "POST");
  await run.click();
  const firstResult = await (await firstImportResponse).json();
  expect(firstResult.created).toBe(1);
  await expect(page.getByText("Import complete", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Close" }).click();
  await expect(dialog).toBeHidden();

  await expect(coverage).toContainText("Imported account roster");
  await expect(coverage).toContainText("3 legal accounts / 1 parent groups");
  await page.getByTestId("input-search").fill("New Legal Entity Revised");
  await expect(page.getByTestId("kpi-accounts")).toContainText("1");
  const importedRow = page.locator('[data-testid^="row-account-"]').first();
  await expect(importedRow).toBeVisible();
  await page.getByTestId("input-search").fill("");
  await expect(page.getByTestId("kpi-accounts")).toContainText("3");
  const parentRow = page.locator('[data-testid^="row-account-"]').first();
  await parentRow.click();
  await expect(page.getByTestId("sheet-account-detail")).toBeVisible();
  await expect(page.getByTestId("select-member")).toContainText("New Legal Entity Revised");
  await page.getByTestId("select-member").selectOption({ label: "New Legal Entity Revised" });
  await expect(page.getByText("No contacts linked.", { exact: true })).toBeVisible();
  await expect(page.getByTestId("sheet-account-detail").getByText("Unavailable", { exact: true })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("new-legal-account-detail.png"), fullPage: true });
  await page.keyboard.press("Escape");

  // Same source rows are idempotent: no additional CRM company is created.
  await page.getByTestId("input-search").fill("");
  await page.getByTestId("button-import").click();
  await upload(page, "hp-roster-repeat.xlsx");
  await page.getByTestId("button-preview-import").click();
  await expect(page.getByTestId("roster-import-impact")).toContainText("0 new CRM accounts / 2 existing matches / 0 held for identity review");
  await page.getByTestId("check-approve-roster").check();
  const secondImportResponse = page.waitForResponse(r => r.url().includes("/api/analytics/hp-bi/import?")
    && r.request().method() === "POST");
  await page.getByTestId("button-run-import").click();
  const secondResult = await (await secondImportResponse).json();
  expect(secondResult.created).toBe(0);
  await expect(page.getByText("Import complete", { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(async () => {
    const b = await dialog.boundingBox();
    return !!b && b.x >= 0 && b.x + b.width <= 390;
  }).toBe(true);
  expect(await dialog.evaluate(e => e.scrollWidth <= e.clientWidth + 1)).toBe(true);
});

test("HP large roster preview stays responsive, then imports only the synthetic approval workbook", async ({ page, hp }) => {
  test.setTimeout(240_000);
  await pool.query("DELETE FROM contacts WHERE tenant_id=$1 AND client_id=$2", [hp.tenantId, hp.clientId]);
  await pool.query("DELETE FROM hp_bi_imports WHERE tenant_id=$1 AND client_id=$2 AND kind='accounts'", [hp.tenantId, hp.clientId]);
  await page.goto(`${root}/analytics?clientId=${hp.clientId}`);
  await expect(page.getByTestId("hp-bi-dashboard")).toBeVisible();
  const dialog = page.getByTestId("dialog-hp-import");
  await page.getByTestId("button-import").click();
  await expect(dialog).toBeVisible();
  const requests: string[] = [];
  page.on("request", req => {
    const u = new URL(req.url());
    if (req.method() === "GET" && u.pathname === "/api/analytics/hp-bi") requests.push(req.url());
  });
  const original = await import("node:fs/promises").then(fs =>
    fs.readFile(new URL("../../../attached_assets/1H25_Enduser_NAL_-_NEW_GTM_JAN25_1791205352447.xlsx", import.meta.url)));
  await page.getByTestId("input-import-file").setInputFiles({
    name: "1H25_Enduser_NAL_-_NEW_GTM_JAN25_1791205352447.xlsx",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer: original,
  });
  await page.getByTestId("button-preview-import").click();
  const progress = page.getByTestId("text-import-progress");
  await expect(progress).toBeVisible();
  await expect(progress).toContainText("0s");
  await expect.poll(() => progress.textContent()).toContain("1s");
  await page.getByTestId("select-import-kind").focus();
  expect(await page.getByTestId("select-import-kind").evaluate(e => document.activeElement === e)).toBe(true);
  await page.screenshot({ path: test.info().outputPath("large-roster-progress.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(async () => {
    const b = await dialog.boundingBox();
    return !!b && b.x >= 0 && b.x + b.width <= 390;
  }).toBe(true);
  expect(await dialog.evaluate(e => e.scrollWidth <= e.clientWidth + 1)).toBe(true);
  await expect(progress).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 900 });
  const counts = page.getByTestId("text-preview-counts");
  await expect(counts).toContainText("16348 rows");
  const impact = page.getByTestId("roster-import-impact");
  await expect(impact).toContainText("9,478 distinct legal accounts / 1,629 source parent groups");
  await expect(progress).toBeHidden();
  expect(requests, "dashboard must remain paused while import dialog is open").toEqual([]);
  await page.screenshot({ path: test.info().outputPath("large-roster-full-preview.png"), fullPage: true });

  // Replacing the full roster discards its preview; only the small synthetic workbook is imported.
  await upload(page, "hp-roster-small.xlsx");
  await expect(impact).toBeHidden();
  await page.getByTestId("button-preview-import").click();
  await expect(counts).toContainText("2 rows / 2 unique accounts");
  await expect(impact).toContainText("1 new CRM accounts / 1 existing matches / 0 held for identity review");
  const run = page.getByTestId("button-run-import");
  await expect(run).toBeDisabled();
  await page.getByTestId("check-approve-roster").check();
  const imported = page.waitForResponse(r => r.url().includes("/api/analytics/hp-bi/import?")
    && r.request().method() === "POST");
  await run.click();
  expect((await (await imported).json()).created).toBe(1);
  await expect(page.getByText("Import complete", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Close" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId("roster-coverage")).toContainText("Imported account roster");
  await expect(page.getByTestId("roster-coverage")).toContainText("3 legal accounts / 1 parent groups");
});
