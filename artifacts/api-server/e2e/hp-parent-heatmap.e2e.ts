import { pool } from "@workspace/db";
import { test, expect } from "./fixtures/hp-crm";

const root = process.env.HP_CRM_E2E_URL || "http://localhost:80";
test("parent month heatmap uses canonical counts and opens only the selected month and action", async ({ page, hp }) => {
  test.setTimeout(120_000);
  for (const [key, kind, status, date] of [
    ["open", "digital", "email_open", "2026-07-08T06:49:22Z"],
    ["click", "digital", "email_click", "2026-07-08T07:05:00Z"],
    ["august-click", "digital", "email_click", "2026-08-08T07:05:00Z"],
    ["hot", "lead", null, "2026-09-23T08:00:00Z"],
    ["hot-copy", "lead", null, "2026-09-23T08:01:00Z"],
  ] as const) {
    await pool.query(`INSERT INTO hp_bi_records(tenant_id,client_id,account_id,contact_id,kind,status,occurred_at,product,horizon_months,source,source_name,source_key,external_event_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,'HP laptop',3,'heatmap fixture','HP workplace / Overview',$8,$9)`,
    [hp.tenantId, hp.clientId, hp.companyId, hp.contactId, kind, status, date, `heatmap:${key}`, `heatmap:${key}`]);
  }
  await page.goto(`${root}/analytics?clientId=${hp.clientId}`);
  await page.getByTestId("select-year").selectOption("2026");
  await page.getByTestId("tab-heatmap").click();
  const heatmap = page.getByTestId("hp-parent-month-heatmap");
  await expect(heatmap).toContainText("Nov 2025");
  await expect(heatmap).toContainText("Oct 2026");
  const july = page.locator('[data-testid^="heatmap-cell-"][data-testid$="-9"]').first();
  await expect(july).toHaveText("2");
  await page.getByTestId("heatmap-metric").selectOption("emailClicks");
  await expect(july).toHaveText("1");
  await july.click();
  await expect(page.getByTestId("heatmap-evidence")).toContainText("Jul 2026");
  await expect(page.getByTestId("contact-activity-records")).toContainText("heatmap:click");
  await expect(page.getByTestId("contact-activity-records")).not.toContainText("heatmap:open");
  await expect(page.getByTestId("contact-activity-records")).not.toContainText("heatmap:august-click");
  await expect(page.getByTestId(`contact-activity-person-${hp.contactId}`)).toBeVisible();
  await page.getByTestId("heatmap-back").click();
  await expect(page.getByTestId("heatmap-evidence")).toBeHidden();
  await expect(page.getByTestId("heatmap-metric")).toHaveValue("emailClicks");
  await expect(page.getByTestId("select-year")).toHaveValue("2026");
  await page.getByTestId("heatmap-metric").selectOption("hot");
  const september = page.locator('[data-testid^="heatmap-cell-"][data-testid$="-11"]').first();
  await expect(september).toHaveText("2");
  await september.click();
  await expect(page.getByTestId("contact-activity-summary")).toContainText("2 source records from 1 distinct identified person");
  await page.getByTestId("heatmap-back").click();
  await page.getByTestId("heatmap-metric").selectOption("engagedContacts");
  await expect(july).toHaveText("1");
  await page.screenshot({ path: "/tmp/hp-parent-heatmap-desktop.png", fullPage: true });
  await page.getByTestId("input-search").fill("No matching parent exists");
  await expect(page.getByTestId("heatmap-status")).toContainText("No parent groups");
  await page.getByTestId("input-search").fill("");
  await expect(july).toHaveText("1");
  await page.setViewportSize({ width: 402, height: 874 });
  await page.screenshot({ path: "/tmp/hp-parent-heatmap-mobile.png", fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 2)).toBe(true);
  await july.click();
  await expect(page.getByTestId("heatmap-evidence")).toBeVisible();
  await page.getByTestId("heatmap-back").click();
  await page.getByTestId("select-year").selectOption("2027");
  await expect(page.locator('[data-testid^="heatmap-cell-"]').first()).toBeDisabled();
  await expect(page.locator('[data-testid^="heatmap-cell-"]').first()).toHaveText("–");
});
