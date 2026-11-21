import { pool } from "@workspace/db";
import { test, expect } from "./fixtures/hp-crm";

const root = process.env.HP_CRM_E2E_URL || "http://localhost:80";
test("account metric clicks expose scoped person, action, timestamp and source evidence", async ({ page, hp }) => {
  test.setTimeout(120_000);
  const inactive = (await pool.query(`SELECT id FROM contacts WHERE tenant_id=$1 AND client_id=$2 AND company_id<>$3 AND NOT is_anonymous LIMIT 1`,
    [hp.tenantId, hp.clientId, hp.companyId])).rows[0];
  for (const [key, kind, status, date, contact] of [
    ["open", "digital", "email_open", "2026-07-08T06:49:22Z", hp.contactId],
    ["click", "digital", "email_click", "2026-07-08T07:05:00Z", hp.contactId],
    ["lead-one", "lead", null, "2026-09-23T08:00:00Z", hp.contactId],
    ["lead-copy", "lead", null, "2026-09-23T08:01:00Z", hp.contactId],
    ["account-response", "other", null, "2026-09-23T08:00:00Z", null],
  ] as const) {
    await pool.query(`INSERT INTO hp_bi_records(tenant_id,client_id,account_id,contact_id,kind,status,occurred_at,product,horizon_months,source,source_name,source_key,external_event_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,'HP laptop',3,'questionnaire / activity fixture','HP workplace / Overview',$8,$9)`,
    [hp.tenantId, hp.clientId, hp.companyId, contact, kind, status, date, `contact-drill:${key}`, `fixture:${key}`]);
  }
  await page.goto(`${root}/analytics?clientId=${hp.clientId}`);
  await page.getByTestId("select-year").selectOption("2026");
  await page.getByTestId(`account-metric-${hp.companyId}-touchpoints`).click();
  await expect(page.getByTestId("contact-activity-summary")).toContainText("3 source records from 1 distinct identified person");
  await expect(page.getByTestId("contact-activity-records")).toContainText("Email link click");
  await expect(page.getByTestId("contact-activity-records")).toContainText("Email open (not a verified click)");
  await expect(page.getByTestId("contact-activity-records")).toContainText("12:35:00");
  await expect(page.getByTestId("contact-activity-records")).toContainText("IST");
  await expect(page.getByTestId("contact-activity-records")).toContainText("fixture:click");
  await page.getByTestId(`contact-activity-person-${hp.contactId}`).click();
  await expect(page.getByTestId("contact-activity-records")).not.toContainText("fixture:account-response");
  await expect(page.getByTestId("contact-activity-records")).toContainText("fixture:click");
  await page.getByTestId("contact-activity-all-people").click();
  await expect(page.getByTestId("contact-activity-records")).toContainText("fixture:account-response");

  await page.getByTestId("detail-metric-hot").click();
  await expect(page.getByTestId("contact-activity-summary")).toContainText("2 source records from 1 distinct identified person");
  await expect(page.getByTestId("contact-activity-records")).toContainText("fixture:lead-one");
  await expect(page.getByTestId("contact-activity-records")).toContainText("fixture:lead-copy");
  await expect(page.getByTestId("contact-activity-records")).not.toContainText("fixture:click");
  await page.getByTestId("detail-metric-contacts").click();
  expect(inactive).toBeTruthy();
  await expect(page.getByTestId(`contact-activity-person-${inactive.id}`)).toBeVisible();
  await page.getByTestId(`contact-activity-person-${inactive.id}`).click();
  await expect(page.getByTestId("contact-activity-records")).not.toContainText("fixture:click");
  await page.getByTestId("contact-activity-all-people").click();
  await page.getByTestId("detail-metric-touchpoints").click();
  await page.screenshot({ path: "/tmp/hp-contact-evidence-desktop.png", fullPage: true });
  await page.setViewportSize({ width: 402, height: 874 });
  await expect(page.getByTestId("contact-activity")).toBeVisible();
  await page.screenshot({ path: "/tmp/hp-contact-evidence-mobile.png", fullPage: true });
  await page.getByTestId("button-detail-back").click();
  await expect(page.getByTestId("sheet-account-detail")).toBeHidden();
  await expect(page.getByTestId("select-year")).toHaveValue("2026");
  await page.getByTestId(`account-metric-${hp.companyId}-hot`).click();
  await expect(page.getByTestId("contact-activity-summary")).toContainText("2 source records from 1 distinct identified person");
});
