import { test, expect } from "./fixtures/hp-crm";

const root = process.env.HP_CRM_E2E_URL || "http://localhost:80";

test("HP account detail switches between structured and original layouts without losing reporting context", async ({ page, hp }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1440, height: 1000 });
  // Engagement history is unrelated to this layout journey and is intentionally
  // outside the fixture's real reporting-router scope.
  await page.route("**/api/engagement-history**", route =>
    route.fulfill({ status: 501, contentType: "application/json", body: JSON.stringify({ error: "Outside this test scope" }) }));
  await page.goto(`${root}/analytics?clientId=${hp.clientId}`);
  await expect(page.getByTestId("hp-bi-dashboard")).toBeVisible();
  await expect(page.getByTestId("tab-bi")).toBeVisible();
  await expect(page.getByTestId("select-year")).toHaveValue("2026");
  await expect(page.getByTestId("layout-structured")).toHaveAttribute("aria-pressed", "true");
  await page.getByTestId("filter-basis-PS").click();
  await expect(page.getByTestId("account-metric-" + hp.companyId + "-hot")).toBeVisible();
  await page.getByTestId("account-metric-" + hp.companyId + "-hot").click();

  const sheet = page.getByTestId("sheet-account-detail");
  await expect(sheet).toBeVisible();
  const structured = page.getByTestId("structured-account");
  await expect(structured).toBeVisible();
  await expect(page.getByTestId("detail-metric-hot")).toHaveAttribute("aria-pressed", "true");
  const sections = await structured.locator("section[data-testid^='section-']").evaluateAll(nodes =>
    nodes.map(node => node.getAttribute("data-testid")));
  expect(sections).toEqual(["section-context", "section-opportunity", "section-engagement", "section-journey", "section-relationship"]);
  await expect(page.getByTestId("section-opportunity")).toContainText("Account Opportunity");
  await expect(page.getByTestId("opportunity-buyers")).toContainText("Not available");
  await expect(page.getByTestId("opportunity-whitespace")).toContainText("unknown");
  await expect(page.getByTestId("section-opportunity")).toContainText("Account totals (FY)");
  await expect(page.getByTestId("table-quarters")).toBeVisible();
  await expect(page.getByTestId("list-detail-months")).toBeVisible();
  await expect(page.getByTestId("relationship-score")).toBeVisible();

  await page.screenshot({ path: "/tmp/hp-account-layout-structured-desktop.png", fullPage: true });
  await page.setViewportSize({ width: 402, height: 874 });
  await expect(sheet).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: "/tmp/hp-account-layout-structured-mobile.png", fullPage: true });

  const firstMonth = page.getByTestId("list-detail-months").locator("li").first();
  await firstMonth.locator("button").click();
  await expect(page.getByText(/evidence only/)).toBeVisible();
  await page.getByRole("button", { name: "Back to full fiscal year" }).click();
  await expect(page.getByText(/evidence only/)).toHaveCount(0);

  await page.getByTestId("details-edit-context").locator("summary").click();
  await expect(page.getByTestId("form-profile")).toBeVisible();
  await page.getByTestId("details-edit-context").locator("summary").click();
  await page.getByTestId("section-journey").locator("details").last().locator("summary").click();
  await expect(page.getByTestId("form-record")).toBeVisible();
  await page.getByTestId("section-journey").locator("details").last().locator("summary").click();

  await page.getByTestId("select-year").selectOption("2027");
  await expect(page.getByTestId("section-journey")).toContainText("FY2027 (Nov 2026 - Oct 2027)");
  await page.getByTestId("select-year").selectOption("2026");
  await expect(page.getByTestId("select-year")).toHaveValue("2026");
  await expect(page.getByTestId("detail-metric-hot")).toHaveAttribute("aria-pressed", "true");
  await page.getByTestId("button-detail-back").click();
  await expect(sheet).toBeHidden();

  await page.getByTestId("layout-original").click();
  await expect(page.getByTestId("layout-original")).toHaveAttribute("aria-pressed", "true");
  await page.getByTestId("account-metric-" + hp.companyId + "-hot").click();
  await expect(sheet).toBeVisible();
  await expect(page.getByTestId("structured-account")).toHaveCount(0);
  await expect(page.getByText("Category matrix", { exact: true })).toBeVisible();
  await expect(page.getByText("Monthly records, Nov to Oct", { exact: true })).toBeVisible();
  await page.getByTestId("button-detail-back").click();
  await expect(sheet).toBeHidden();

  await page.reload();
  await expect(page.getByTestId("hp-bi-dashboard")).toBeVisible();
  await expect(page.getByTestId("layout-original")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("select-year")).toHaveValue("2026");
  await expect(page.getByTestId("filter-segment-Overall")).toHaveAttribute("aria-selected", "true");
  await page.getByTestId("filter-basis-PS").click();
  await page.getByTestId("layout-structured").click();
  await expect(page.getByTestId("layout-structured")).toHaveAttribute("aria-pressed", "true");
  await page.getByTestId("account-metric-" + hp.companyId + "-hot").click();
  await expect(page.getByTestId("structured-account")).toBeVisible();
  await expect(page.getByTestId("detail-metric-hot")).toHaveAttribute("aria-pressed", "true");
});
