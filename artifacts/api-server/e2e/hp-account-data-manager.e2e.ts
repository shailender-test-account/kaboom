import { pool } from "@workspace/db";
import { test, expect } from "./fixtures/hp-crm";

const root = process.env.HP_CRM_E2E_URL || "http://localhost:80";
test("HP account manager saves the exact legal member, imports datasets and combines response projections", async ({ page, hp }) => {
  test.setTimeout(120_000);
  for (const [kind, ref] of [["lead", "inbound:991"], ["other", "inbound:991:response"]]) {
    await pool.query(`INSERT INTO hp_bi_records(tenant_id,client_id,account_id,contact_id,kind,occurred_at,product,horizon_months,source,source_key,external_event_id)
      VALUES($1,$2,$3,$4,$5,'2026-09-23T08:00:00Z','HP Laptop',3,'questionnaire',$6,$6)`,
      [hp.tenantId, hp.clientId, hp.companyId, hp.contactId, kind, ref]);
  }
  const original = (await pool.query("SELECT company_id,top_200 FROM hp_account_profiles WHERE tenant_id=$1", [hp.tenantId])).rows;
  const sibling = original.find(r => Number(r.company_id) === hp.siblingId);
  const primary = original.find(r => Number(r.company_id) === hp.companyId);
  await page.goto(`${root}/analytics?clientId=${hp.clientId}`);
  await page.getByTestId("select-year").selectOption("2026");
  await page.getByTestId("tab-data-manager").click();
  const manager = page.getByTestId("account-data-manager");
  await expect(manager.getByTestId(`row-manager-${hp.companyId}`)).toHaveCount(1);
  await expect(manager.getByTestId(`row-manager-${hp.siblingId}`)).toHaveCount(1);
  await manager.getByTestId(`button-edit-${hp.siblingId}`).click();
  await manager.getByTestId("select-top200").selectOption(sibling.top_200 ? "no" : "yes");
  await manager.getByTestId("input-abm").fill("Reviewed fixture classification");
  await manager.getByTestId("button-save-profile").click();
  await expect(page.getByText("Profile saved", { exact: true })).toBeVisible();
  const stored = (await pool.query("SELECT company_id,top_200,abm_classification FROM hp_account_profiles WHERE tenant_id=$1", [hp.tenantId])).rows;
  expect(stored.find(r => Number(r.company_id) === hp.siblingId)).toMatchObject({
    top_200: !sibling.top_200, abm_classification: "Reviewed fixture classification",
  });
  expect(stored.find(r => Number(r.company_id) === hp.companyId).top_200).toBe(primary.top_200);
  await manager.getByTestId("button-manager-back").click();
  await expect(manager.getByTestId(`row-manager-${hp.siblingId}`)).toContainText("Reviewed fixture classification");
  await page.reload();
  await page.getByTestId("tab-data-manager").click();
  await expect(manager.getByTestId(`row-manager-${hp.siblingId}`)).toContainText("Reviewed fixture classification");

  await manager.getByTestId("input-import-file").setInputFiles({
    name: "account-manager-fixture.csv", mimeType: "text/csv",
    buffer: Buffer.from(`accountName,hpId,top200\nManager added fixture,MANAGER-${hp.tenantId},true\n`),
  });
  await manager.getByTestId("button-preview-import").click();
  await expect(manager.getByTestId("roster-import-impact")).toContainText("1");
  await manager.getByTestId("check-approve-roster").check();
  await manager.getByTestId("button-run-import").click();
  await expect(page.getByText("Import complete", { exact: true })).toBeVisible();
  await manager.getByTestId("input-manager-search").fill("Manager added fixture");
  await expect(manager.getByTestId("table-manager")).toContainText("Manager added fixture");
  await expect(manager.locator('[data-testid^="row-manager-"]')).toHaveCount(1);
  await page.screenshot({ path: "/tmp/hp-account-manager-desktop.png", fullPage: true });
  await page.setViewportSize({ width: 402, height: 874 });
  await page.screenshot({ path: "/tmp/hp-account-manager-mobile.png", fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2)).toBe(true);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.getByTestId("tab-bi").click();
  await page.getByTestId("select-year").selectOption("2026");
  await page.locator('[data-testid^="account-metric-"][data-testid$="-contacts"]').first().click();
  const timeline = page.getByTestId("contact-activity-records");
  await expect(timeline.locator('[data-testid^="contact-activity-record-"]')).toHaveCount(1);
  await expect(timeline).toContainText("2 source records in 1 entries");
  await timeline.getByLabel("Show each source record separately").check();
  await expect(timeline.locator('[data-testid^="contact-activity-record-"]')).toHaveCount(2);
});
