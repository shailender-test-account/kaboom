import { pool } from "@workspace/db";
import { test, expect } from "./fixtures/hp-crm";

const root = process.env.HP_CRM_E2E_URL || "http://localhost:80";
test("HP cards explain their metrics, deep dive and return without losing filters", async ({ page, hp }) => {
  test.setTimeout(120_000);
  for (const [kind, amount] of [["lead", 100], ["opportunity", 200], ["closed_won", 150]] as const) {
    await pool.query(`INSERT INTO hp_bi_records(tenant_id,client_id,account_id,contact_id,kind,occurred_at,
      product,horizon_months,order_value,currency,source,source_key)
      VALUES($1,$2,$3,$4,$5,'2027-01-15','HP Anyware Services',3,$6,'INR','browser navigation fixture',$5)`,
    [hp.tenantId, hp.clientId, hp.companyId, hp.contactId, kind, amount]);
  }
  await page.goto(`${root}/analytics?clientId=${hp.clientId}`);
  await page.getByTestId("select-year").selectOption("2027");
  await expect(page.getByTestId("kpi-hot")).toContainText("1");
  for (const section of ["roster-coverage", "hp-gtm-qualification"]) {
    const toggle = page.getByTestId(`${section}-toggle`);
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
  }
  const summary = page.getByTestId("dialog-metric-summary");
  for (const key of ["accounts", "contacts", "touchpoints", "leads", "hot", "opps", "opp-value",
    "prospective", "booked", "closed-won", "closed-lost", "score"]) {
    const card = page.getByTestId(`kpi-${key}`);
    await expect(card).toHaveAttribute("role", "button");
    await card.click();
    await expect(summary).toBeVisible();
    await expect(summary.getByTestId("text-summary-value")).not.toBeEmpty();
    await expect(summary.getByTestId("button-summary-action")).toBeVisible();
    await summary.getByTestId("button-summary-back").click();
    await expect(summary).toBeHidden();
  }
  await page.getByTestId("kpi-hot").focus();
  await page.keyboard.press("Enter");
  await expect(summary).toContainText("purchase horizon");
  await summary.getByTestId("button-summary-action").click();
  const evidence = page.getByTestId("dialog-evidence");
  await expect(page.getByTestId("text-evidence-total")).toHaveText("1 records");
  await expect(evidence).toContainText("HP Anyware Services");
  await page.getByTestId("button-evidence-back").click();
  await expect(summary).toContainText("Hot leads");
  await page.getByTestId("button-summary-back").click();

  await page.getByTestId("kpi-prospective").click();
  await expect(page.getByTestId("text-summary-value")).toContainText("100");
  await page.getByTestId("button-summary-action").click();
  await expect(page.getByTestId("text-evidence-total")).toHaveText("1 records");
  await expect(evidence).toContainText("INR 100");
  await expect(evidence).not.toContainText("INR 200");
  await page.getByTestId("button-evidence-back").click();
  await page.getByTestId("button-summary-back").click();

  await page.getByTestId("kpi-accounts").click();
  await page.getByTestId("button-summary-action").click();
  await page.getByTestId(`row-account-${hp.companyId}`).click();
  await expect(page.getByTestId("sheet-account-detail")).toBeVisible();
  await page.getByTestId("button-detail-back").click();
  await expect(page.getByTestId("sheet-account-detail")).toBeHidden();
  await page.getByTestId("button-accounts-back").click();
  await expect(summary).toContainText("Legal accounts");
  await page.getByTestId("button-summary-back").click();

  await page.getByTestId("select-year").selectOption("2026");
  await expect(page.getByTestId("kpi-hot")).toContainText("0");
  await page.getByTestId("kpi-score").click();
  await page.getByTestId("button-summary-action").click();
  await page.getByTestId("button-scoring-back").click();
  await expect(summary).toContainText("Mean current intent score");
  await expect(page.getByTestId("select-year")).toHaveValue("2026");
  await page.getByTestId("button-summary-back").click();
  await page.getByTestId("select-year").selectOption("2027");
  await expect(page.getByTestId("kpi-hot")).toContainText("1");
  await page.screenshot({ path: "/tmp/hp-card-navigation.png", fullPage: true });
  await page.setViewportSize({ width: 402, height: 874 });
  await page.getByTestId("kpi-leads").click();
  await expect(summary).toBeVisible();
  await expect(page.getByTestId("button-summary-action")).toBeVisible();
  await page.screenshot({ path: "/tmp/hp-card-mobile.png" });
  await page.getByTestId("button-summary-back").click();
});
