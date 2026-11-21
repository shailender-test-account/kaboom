import { pool } from "@workspace/db";
import { test, expect } from "./fixtures/hp-crm";

const root = process.env.HP_CRM_E2E_URL || "http://localhost:80";
test("contact flags identify actual contributors and clickable details retain report context", async ({ page, hp }) => {
  test.setTimeout(120_000);
  const journey = Number((await pool.query(`INSERT INTO journeys(tenant_id,client_id,name,slug)
    VALUES($1,$2,'Contributor fixture',$3) RETURNING id`, [hp.tenantId, hp.clientId, `contribution-${hp.tenantId}`])).rows[0].id);
  try {
    const form = Number((await pool.query(`INSERT INTO form_submissions(tenant_id,contact_id,journey_id,field_values,submitted_at)
      VALUES($1,$2,$3,'{}','2026-07-08T07:00:00Z') RETURNING id`, [hp.tenantId, hp.siblingContact, journey])).rows[0].id);
    const hot = Number((await pool.query(`INSERT INTO hp_bi_records(tenant_id,client_id,account_id,contact_id,kind,occurred_at,product,horizon_months,source,source_key)
      VALUES($1,$2,$3,$4,'lead','2026-07-08T08:00:00Z','HP Laptop',3,'questionnaire','fixture-hot') RETURNING id`,
      [hp.tenantId, hp.clientId, hp.companyId, hp.contactId])).rows[0].id);
    await pool.query(`INSERT INTO hp_bi_records(tenant_id,client_id,account_id,contact_id,kind,occurred_at,product,horizon_months,source,source_key)
      VALUES($1,$2,$3,$4,'lead','2026-08-08T08:00:00Z','HP Print',9,'questionnaire','fixture-warm')`,
      [hp.tenantId, hp.clientId, hp.siblingId, hp.siblingContact]);
    await page.goto(`${root}/analytics?clientId=${hp.clientId}`);
    await page.getByTestId("select-year").selectOption("2026");
    await page.locator('[data-testid^="account-metric-"][data-testid$="-contacts"]').first().click();
    const activity = page.getByTestId("contact-activity");
    await expect(activity.getByTestId("contact-contribution-summary")).toContainText("Among 2 contacts");
    await expect(activity.getByTestId("contribution-filter-forms")).toHaveText("2 form contributors");
    await expect(activity.getByTestId("contribution-filter-hot")).toHaveText("1 Hot contributors");
    await expect(activity.getByTestId("contribution-filter-warm")).toHaveText("1 Warm contributors");
    await expect(activity.getByTestId(`person-flag-${hp.contactId}-hot`)).toBeVisible();
    await expect(activity.getByTestId(`person-flag-${hp.siblingContact}-warm`)).toBeVisible();
    await activity.getByTestId(`person-flag-${hp.contactId}-hot`).click();
    await expect(activity.getByTestId(`contact-activity-record-hp:${hot}`)).toBeVisible();
    await activity.getByTestId(`inspect-record-hp:${hot}`).click();
    await expect(page.getByTestId("activity-evidence-inspection")).toContainText("HP Laptop");
    await expect(page.getByTestId("activity-evidence-inspection")).toContainText("Purchase timeframe (months)");
    await page.getByTestId("activity-inspection-back").click();
    await expect(activity.getByTestId(`contact-activity-person-${hp.contactId}`)).toHaveAttribute("aria-pressed", "true");
    await activity.getByTestId("contribution-filter-forms").click();
    await expect(activity.getByTestId(`contact-activity-record-form:${form}`)).toBeVisible();
    await activity.getByTestId("contribution-reset").click();
    await expect(activity.getByTestId(`person-flag-${hp.siblingContact}-forms`)).toBeVisible();
    await page.screenshot({ path: "/tmp/hp-contact-contributors-desktop.png", fullPage: true });
    await page.getByTestId("button-detail-back").click();
    await page.getByTestId("tab-heatmap").click();
    await page.locator('[data-testid^="heatmap-cell-"][data-testid$="-9"]').first().click();
    await expect(page.getByTestId("contribution-filter-hot")).toHaveText("1 Hot contributors");
    await expect(page.getByTestId("contribution-filter-warm")).toHaveText("0 Warm contributors");
    await expect(page.getByTestId("contribution-filter-forms")).toHaveText("2 form contributors");
    await page.getByTestId("contribution-filter-forms").click();
    await expect(page.getByTestId(`contact-activity-record-form:${form}`)).toBeVisible();
    await expect(page.getByTestId(`person-flag-${hp.siblingContact}-warm`)).toHaveCount(0);
    await page.setViewportSize({ width: 402, height: 874 });
    await page.screenshot({ path: "/tmp/hp-contact-contributors-mobile.png", fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2)).toBe(true);
    await page.getByTestId("heatmap-back").click();
    await expect(page.getByTestId("select-year")).toHaveValue("2026");
  } finally {
    await pool.query("DELETE FROM form_submissions WHERE tenant_id=$1", [hp.tenantId]);
    await pool.query("DELETE FROM journeys WHERE tenant_id=$1", [hp.tenantId]);
  }
});
