import { randomUUID } from "node:crypto";
import { pool } from "@workspace/db";
import { ensureHpAccountRegister, hpDimensions } from "../src/lib/hpBiImport";
import { test, expect } from "./fixtures/hp-crm";

const root = process.env.HP_CRM_E2E_URL || "http://localhost:80";

test("HP roster suggestions require confirmation and only change BI reporting grouping", async ({ page, hp }) => {
  test.setTimeout(180_000);
  const targetId = hp.companyId;
  const targetName = "Example Private Limited";
  const sourceName = "Example Pvt Ltd";
  const emptyRow = Object.fromEntries(Object.values(hpDimensions).map(label => [label, ""]));
  const row2 = { ...emptyRow, "UNIQUE ID": "UI-ROSTER-ONE", "SUBSIDIARY_LEGAL_NAME": targetName,
    "TOP_ID": "UI-PARENT", "TOP_NAME": "Example group", "FY25 GTM": "GCC", "CITY": "Delhi", "EMP SIZE": 0,
    _source: { fileName: "ui-roster.xlsx", sheet: "Accounts", row: 2 } };
  const row3 = { ...emptyRow, "UNIQUE ID": "UI-ROSTER-ONE", "SUBSIDIARY_LEGAL_NAME": targetName,
    "TOP_ID": "UI-PARENT", "TOP_NAME": "Example group", "FY25 GTM": "GCC", "CITY": "",
    _source: { fileName: "ui-roster.xlsx", sheet: "Accounts", row: 3 } };
  await pool.query("UPDATE companies SET name=$3 WHERE tenant_id=$1 AND id=$2", [hp.tenantId, targetId, targetName]);
  await pool.query(`UPDATE hp_account_profiles SET hp_id='UI-ROSTER-ONE',legal_name=$3,top_id='UI-PARENT',
    top_name='Example group',gtm='GCC',parent_key='ui:roster',parent_name='Example group',variants=$4::jsonb
    WHERE tenant_id=$1 AND company_id=$2`, [hp.tenantId, targetId, targetName, JSON.stringify([row2, row3])]);
  const sourceId = Number((await pool.query(
    "INSERT INTO companies(tenant_id,client_id,name) VALUES($1,$2,$3) RETURNING id",
    [hp.tenantId, hp.clientId, sourceName],
  )).rows[0].id);
  await ensureHpAccountRegister(hp.tenantId, hp.clientId);
  const original = (await pool.query(
    "SELECT parent_key,parent_name FROM hp_account_profiles WHERE tenant_id=$1 AND company_id=$2",
    [hp.tenantId, sourceId],
  )).rows[0];
  for (const classification of ["hot", "warm", "cold"]) {
    const key = randomUUID();
    await pool.query(`INSERT INTO intent_inbound_submissions(tenant_id,client_id,account_id,drive_file_id,row_key,
      file_name,form_type,classification,classification_reason,submitted_at)
      VALUES($1,$2,$3,$4,$4,'source-fixture.xlsx','event_feedback',$5,'isolated UI fixture','2024-01-01')`,
    [hp.tenantId, hp.clientId, sourceId, key, classification]);
  }
  const identitySnapshot = async () => ({
    companies: (await pool.query("SELECT id,name FROM companies WHERE tenant_id=$1 AND id=ANY($2::int[]) ORDER BY id",
      [hp.tenantId, [sourceId, targetId]])).rows,
    contacts: (await pool.query("SELECT id,company_id FROM contacts WHERE tenant_id=$1 AND company_id=$2 ORDER BY id",
      [hp.tenantId, sourceId])).rows,
    submissions: (await pool.query("SELECT id,account_id,classification FROM intent_inbound_submissions WHERE tenant_id=$1 AND account_id=$2 ORDER BY id",
      [hp.tenantId, sourceId])).rows,
  });
  const identities = await identitySnapshot();

  // This unrelated history widget is outside the fixture's reporting scope.
  // The roster-analysis and account-detail reporting APIs remain real fixture routers.
  await page.route("**/api/engagement-history**", route =>
    route.fulfill({ status: 501, contentType: "application/json", body: JSON.stringify({ error: "Outside this test scope" }) }));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${root}/analytics?clientId=${hp.clientId}`);
  await expect(page.getByTestId("hp-bi-dashboard")).toBeVisible();
  await expect(page.getByTestId("select-year")).toHaveValue("2026");
  await page.getByTestId("tab-roster").click();
  const panel = page.getByTestId("roster-panel");
  await expect(panel).toBeVisible();
  await expect(page.getByTestId("roster-column-count")).toContainText("41 columns captured");
  await expect(panel.locator("[data-testid^='roster-col-']")).toHaveCount(41);
  await expect(page.getByTestId("total-hot")).toContainText("Hot 1");
  await expect(page.getByTestId("total-warm")).toContainText("Warm 1");
  await expect(page.getByTestId("total-cold")).toContainText("Cold 1");
  const row = page.getByTestId(`roster-row-${sourceId}`);
  await expect(row).toContainText("Needs review");
  await expect(row).toContainText("Similar legal name — review required");
  await expect(page.getByTestId(`button-select-${sourceId}-${targetId}`)).toBeVisible();
  await page.screenshot({ path: "/tmp/hp-roster-analysis-panel-desktop.png", fullPage: true });
  await page.setViewportSize({ width: 402, height: 874 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: "/tmp/hp-roster-analysis-panel-mobile.png", fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });

  await page.getByTestId(`button-select-${sourceId}-${targetId}`).click();
  await expect(page.getByTestId("roster-confirm")).toContainText("not a legal merge");
  await expect(page.getByTestId("roster-confirm")).toContainText("company, contact, submission and enrollment identities remain unchanged");
  await page.getByTestId("button-roster-cancel").click();
  await expect(page.getByTestId("roster-confirm")).toHaveCount(0);
  expect((await pool.query("SELECT parent_key,parent_name FROM hp_account_profiles WHERE tenant_id=$1 AND company_id=$2",
    [hp.tenantId, sourceId])).rows[0]).toEqual(original);
  expect(await identitySnapshot()).toEqual(identities);

  await page.getByTestId(`button-select-${sourceId}-${targetId}`).click();
  const linkedResponse = page.waitForResponse(r => new URL(r.url()).pathname === "/api/analytics/hp-bi/roster-analysis"
    && r.request().method() === "POST");
  await page.getByTestId("button-roster-confirm").click();
  expect((await linkedResponse).status()).toBe(200);
  await expect(row).toContainText("Reporting link");
  const linked = (await pool.query(
    "SELECT parent_key,parent_name,dimensions FROM hp_account_profiles WHERE tenant_id=$1 AND company_id=$2",
    [hp.tenantId, sourceId],
  )).rows[0];
  expect(linked.parent_key).toBe("ui:roster");
  expect(linked.parent_name).toBe("Example group");
  expect(linked.dimensions._rosterAssociation.accountId).toBe(targetId);
  expect(await identitySnapshot()).toEqual(identities);

  await row.getByRole("button", { name: sourceName, exact: true }).click();
  const sheet = page.getByTestId("sheet-account-detail");
  await expect(sheet).toBeVisible();
  await expect(page.getByTestId("select-year")).toHaveValue("2026");
  await expect(page.getByTestId("section-opportunity")).toContainText("0 leads");
  await expect(page.getByTestId("source-gtm-responses").locator("li")).toHaveCount(3);
  await expect(page.getByTestId("source-gtm-responses")).toContainText("Hot");
  await expect(page.getByTestId("source-gtm-responses")).toContainText("Warm");
  await expect(page.getByTestId("source-gtm-responses")).toContainText("Cold");
  await expect(page.getByTestId("source-gtm-responses")).toContainText("Product not provided");
  const profile = page.getByTestId("workbook-profile");
  await expect(profile).toBeVisible();
  await expect(profile).toContainText("all 41 columns");
  await expect(profile.locator("[data-testid^='wb-']")).toHaveCount(41);
  await expect(page.getByTestId("select-wb-variant").locator("option").nth(0)).toContainText("ui-roster.xlsx / Accounts / row 2");
  await expect(page.getByTestId("select-wb-variant").locator("option").nth(1)).toContainText("ui-roster.xlsx / Accounts / row 3");
  await expect(page.getByTestId("text-wb-filled")).toContainText("row 2");
  await expect(page.getByTestId("wb-city")).toContainText("Delhi");
  await expect(page.getByTestId("wb-emp_size")).toContainText("0");
  await page.screenshot({ path: "/tmp/hp-roster-analysis-workbook-profile-desktop.png", fullPage: true });
  await page.getByTestId("select-wb-variant").selectOption("1");
  await expect(page.getByTestId("select-wb-variant")).toHaveValue("1");
  await expect(page.getByTestId("text-wb-filled")).toContainText("row 3");
  await expect(page.getByTestId("wb-city")).toContainText("Not supplied");
  await expect(page.getByTestId("wb-city")).not.toContainText("Delhi");
  await expect(page.getByTestId("wb-emp_size")).toContainText("Not supplied");
  await page.setViewportSize({ width: 402, height: 874 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByTestId("select-wb-variant").selectOption("0");
  await expect(page.getByTestId("wb-city")).toContainText("Delhi");
  await page.screenshot({ path: "/tmp/hp-roster-analysis-workbook-profile-mobile.png", fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByTestId("button-detail-back").click();
  await expect(sheet).toBeHidden();
  await expect(panel).toBeVisible();

  await page.getByTestId(`button-unlink-${sourceId}`).click();
  await expect(page.getByTestId("roster-confirm")).toContainText("Confirm unlink");
  const unlinkResponse = page.waitForResponse(r => new URL(r.url()).pathname === "/api/analytics/hp-bi/roster-analysis"
    && r.request().method() === "POST");
  await page.getByTestId("button-roster-confirm").click();
  expect((await unlinkResponse).status()).toBe(200);
  await expect(page.getByTestId("roster-confirm")).toHaveCount(0);
  await expect(row).toContainText("Needs review");
  const restored = (await pool.query(
    "SELECT parent_key,parent_name,dimensions FROM hp_account_profiles WHERE tenant_id=$1 AND company_id=$2",
    [hp.tenantId, sourceId],
  )).rows[0];
  expect(restored.parent_key).toBe(original.parent_key);
  expect(restored.parent_name).toBe(original.parent_name);
  expect(restored.dimensions._rosterAssociation).toBeUndefined();
  expect(await identitySnapshot()).toEqual(identities);
  await expect(page.getByTestId("total-hot")).toContainText("Hot 1");
  await expect(page.getByTestId("total-warm")).toContainText("Warm 1");
  await expect(page.getByTestId("total-cold")).toContainText("Cold 1");

  await page.getByTestId(`button-find-roster-${sourceId}`).click();
  await expect(page.getByRole("dialog", { name: "Find a roster account" })).toBeVisible();
  await page.getByTestId("input-roster-search").fill("UI-ROSTER-ONE");
  const manualSelect = page.getByTestId(`manual-roster-select-${targetId}`);
  await expect(manualSelect).toBeVisible();
  await manualSelect.click();
  await expect(page.getByTestId("roster-confirm")).toContainText("not a legal merge");
  await page.getByTestId("button-roster-cancel").click();
  await expect(page.getByTestId("roster-confirm")).toHaveCount(0);
  expect((await pool.query("SELECT parent_key,parent_name FROM hp_account_profiles WHERE tenant_id=$1 AND company_id=$2",
    [hp.tenantId, sourceId])).rows[0]).toEqual(original);
  expect(await identitySnapshot()).toEqual(identities);
});

