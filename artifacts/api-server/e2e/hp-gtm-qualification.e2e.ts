import { pool } from "@workspace/db";
import { test, expect } from "./fixtures/hp-crm";

const root = process.env.HP_CRM_E2E_URL || "http://localhost:80";
test("HP analytics uses upload dates and persists submission-date edits with fiscal totals", async ({ page, hp }) => {
  test.setTimeout(120_000);
  await pool.query(`INSERT INTO intent_inbound_submissions(tenant_id,client_id,account_id,drive_file_id,
    row_key,file_name,form_type,classification,classification_reason,product_interest,purchase_timeframe_months,created_at)
    VALUES($1,$2,$3,'gtm-browser','row1','HP feedback.xlsx','event_feedback','hot','Within six months','HP Anyware Services',6,'2027-03-15T08:00:00Z') RETURNING id`,
  [hp.tenantId, hp.clientId, hp.companyId]);
  await page.goto(`${root}/analytics?clientId=${hp.clientId}`);
  await page.getByTestId("select-year").selectOption("2027");
  await expect(page.getByTestId("hp-bi-dashboard")).toBeVisible();
  await page.getByTestId("hp-gtm-qualification-toggle").click();
  await expect(page.getByTestId("gtm-hot-accounts")).toHaveText("1 Hot accounts");
  await expect(page.getByTestId("gtm-upload-date-responses")).toContainText("1 product responses");
  await expect(page.getByTestId("kpi-hot")).toContainText("1");
  await expect(page.getByTestId(`gtm-status-${hp.companyId}`)).toHaveText("Hot");
  await page.getByTestId(`row-account-${hp.companyId}`).click();
  const detail = page.getByTestId("account-gtm-qualification");
  await expect(detail).toContainText("HP Anyware Services");
  await expect(detail).toContainText("Purchase timeframe: 6 months");
  await expect(detail).toContainText("Upload/import date used");
  await detail.getByRole("button", { name: "Edit submission date" }).click();
  await detail.getByLabel("Submission date", { exact: true }).fill("2026-10-31");
  await detail.getByRole("button", { name: "Save date", exact: true }).click();
  await expect(detail).toContainText("Manually corrected");
  await expect(page.getByTestId("kpi-hot")).toContainText("0");
  await page.reload();
  await page.getByTestId(`row-account-${hp.companyId}`).click();
  await expect(page.getByTestId("account-gtm-qualification")).toContainText("Manually corrected");
  await detail.scrollIntoViewIfNeeded();
  await page.screenshot({ path: "/tmp/hp-gtm-qualification.png" });
});
