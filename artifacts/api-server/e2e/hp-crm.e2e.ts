import type { Page } from "@playwright/test";
import { pool } from "@workspace/db";
import { importHpWorkbook } from "../src/lib/hpBiImport";
import { hpWorkbook } from "../src/lib/testFixtures/hpCrm";
import { test, expect } from "./fixtures/hp-crm";

const root = process.env.HP_CRM_E2E_URL || "http://localhost:80";
const select = async (page: Page, id: string, label: string) => {
  await page.getByTestId(id).click();
  await page.getByRole("option", { name: label, exact: true }).click();
};
const save = async (page: Page, method: "POST" | "PATCH") => {
  const response = page.waitForResponse(r => /\/api\/deals(?:\/\d+)?$/.test(r.url()) && r.request().method() === method);
  await page.getByTestId("button-save-deal").click();
  const result = await response;
  expect(result.status()).toBe(method === "POST" ? 201 : 200);
  await expect(page.getByTestId("dialog-deal-editor")).toBeHidden();
  return result.json();
};
const report = async (page: Page, client: number, year = 2024) => {
  await page.goto(`${root}/analytics?clientId=${client}`);
  await expect(page.getByTestId("hp-bi-dashboard")).toBeVisible();
  // This correction regression exercises the original chronology layout;
  // the structured account layout is now the dashboard default.
  await page.getByTestId("layout-original").click();
  const loaded = page.waitForResponse(r => new URL(r.url()).pathname === "/api/analytics/hp-bi"
    && new URL(r.url()).searchParams.get("year") === String(year));
  await page.getByTestId("select-year").selectOption(String(year));
  await loaded;
  await expect(page.getByTestId("table-month-outcomes")).toBeVisible();
};
const edit = async (page: Page, id: number) => {
  await page.goto(`${root}/crm/deals`);
  await page.getByTestId(`button-edit-deal-${id}`).click();
  await expect(page.getByTestId("dialog-deal-editor")).toBeVisible();
};
const remove = async (page: Page, id: number) => {
  await edit(page, id);
  await page.getByTestId("button-delete-deal").click();
  const removed = page.waitForResponse(r => r.url().endsWith(`/api/deals/${id}`) && r.request().method() === "DELETE");
  await page.getByTestId("button-confirm-delete-deal").click();
  expect((await removed).status()).toBe(204);
  await expect(page.getByTestId(`card-deal-${id}`)).toHaveCount(0);
};

test("CRM UI corrections update HP dates, currencies, evidence and parent views without resurrecting Excel mirrors",
  async ({ page, hp }) => {
    test.setTimeout(240_000);
    await page.goto(`${root}/crm/deals`);
    await page.getByTestId("button-new-deal").click();
    await page.getByTestId("input-deal-title").fill("Browser fixture deal");
    await select(page, "select-deal-client", "HP");
    await select(page, "select-deal-stage", "Proposal");
    await select(page, "select-deal-meaning", "Total order value");
    await page.getByTestId("input-deal-value").fill("100");
    await page.getByTestId("input-deal-currency").fill("INR");
    await page.getByTestId("check-opportunity").check();
    await page.getByTestId("input-opportunity-date").fill("2024-01-31");
    // This expected date must never replace either actual reporting date.
    await page.getByTestId("input-expected-close").fill("2024-06-15");
    await page.getByTestId(`picker-account-option-${hp.companyId}`).click();
    await page.getByTestId(`picker-contact-option-${hp.contactId}`).click();
    const deal = await save(page, "POST");
    await page.reload();
    await page.getByTestId(`button-edit-deal-${deal.id}`).click();
    await expect(page.getByTestId("picker-account-current")).toContainText("CRM A");
    await expect(page.getByTestId("picker-contact-current")).toContainText("Alice Fixture");
    await select(page, "select-deal-stage", "Won");
    await save(page, "PATCH");
    await report(page, hp.clientId);
    await expect(page.getByTestId("row-month-3").locator("td").nth(1)).toHaveText("1");
    await expect(page.getByTestId("link-evidence-month-4-won")).toHaveText("0");
    await expect(page.getByTestId("text-booked-q2")).toHaveText("None recorded");

    await edit(page, deal.id);
    await page.getByTestId("input-outcome-date").fill("2024-02-01");
    await page.getByTestId("input-deal-booked").fill("75");
    await save(page, "PATCH");
    await importHpWorkbook(hp.tenantId, hp.clientId, hpWorkbook(
      ["recordId", "hpId", "kind", "occurredAt", "orderValue", "currency", "externalEventId"],
      [["MIRROR-OPP", "CRM-A", "opportunity", "2024-01-31", 100, "INR", `crm:deal:${deal.id}:opportunity`],
        ["MIRROR-WON", "CRM-A", "closed_won", "2024-02-01", 75, "INR", `crm:deal:${deal.id}:outcome`]],
    ), "browser-mirrors.xlsx", "activities", {}, null);
    const mirrorIds = (await pool.query("SELECT id FROM hp_bi_records WHERE tenant_id=$1 ORDER BY id", [hp.tenantId])).rows;
    await page.goto(`${root}/crm/deals`);
    await page.getByTestId("button-new-deal").click();
    await page.getByTestId("input-deal-title").fill("Second currency fixture");
    await select(page, "select-deal-client", "HP");
    await select(page, "select-deal-stage", "Proposal");
    await select(page, "select-deal-meaning", "Total order value");
    await page.getByTestId("input-deal-value").fill("30");
    await page.getByTestId("input-deal-currency").fill("USD");
    await page.getByTestId("check-opportunity").check();
    await page.getByTestId("input-opportunity-date").fill("2024-01-31");
    await page.getByTestId(`picker-account-option-${hp.siblingId}`).click();
    const second = await save(page, "POST");
    await report(page, hp.clientId);
    // Opportunity ToV is shown in the dated breakdown, not a standalone KPI.
    // Both fixture opportunities were recorded in January (FY month 3).
    await expect(page.getByTestId("row-month-3")).toContainText("₹100");
    await expect(page.getByTestId("kpi-opps")).toContainText("2");
    await expect(page.getByTestId("row-month-3")).toContainText("$30");
    await expect(page.getByTestId("kpi-booked")).toContainText("₹75");
    await expect(page.getByTestId("kpi-booked")).not.toContainText("$30");
    await expect(page.getByTestId("row-month-3")).toContainText("₹100");
    await expect(page.getByTestId("row-month-4")).toContainText("₹75");
    await expect(page.getByTestId("link-evidence-month-4-won")).toHaveText("1");
    await page.getByTestId("link-evidence-month-4-won").click();
    const won = page.getByTestId(`row-evidence-crm:deal:${deal.id}:outcome`);
    await expect(won).toContainText("01 Feb 2024");
    await expect(won).toContainText("INR 75");
    await expect(won).toContainText("opp. date 2024-01-31 / outcome date 2024-02-01");
    await expect(page.getByTestId("text-evidence-total")).toHaveText("1 records");
    await page.keyboard.press("Escape");
    await remove(page, second.id);

    // Correct account, both actual dates, ToV, currency and independent booked amount.
    await edit(page, deal.id);
    await page.getByTestId(`picker-account-option-${hp.siblingId}`).click();
    await page.getByTestId(`picker-contact-option-${hp.siblingContact}`).click();
    await page.getByTestId("input-opportunity-date").fill("2024-11-01");
    await page.getByTestId("input-outcome-date").fill("2024-11-02");
    await page.getByTestId("input-deal-value").fill("200");
    await page.getByTestId("input-deal-currency").fill("USD");
    await page.getByTestId("input-deal-booked").fill("60");
    await save(page, "PATCH");
    await page.reload();
    await page.getByTestId(`button-edit-deal-${deal.id}`).click();
    await expect(page.getByTestId("picker-account-current")).toContainText("CRM B");
    await expect(page.getByTestId("picker-contact-current")).toContainText("Bob Fixture");
    await expect(page.getByTestId("input-opportunity-date")).toHaveValue("2024-11-01");
    await expect(page.getByTestId("input-outcome-date")).toHaveValue("2024-11-02");
    await expect(page.getByTestId("deal-history")).toContainText("actualOpportunityDate");
    await page.setViewportSize({ width: 390, height: 844 });
    const dialog = page.getByTestId("dialog-deal-editor");
    await expect.poll(async () => {
      const b = await dialog.boundingBox();
      return !!b && b.x >= 0 && b.x + b.width <= 390;
    }, { message: "Mobile editor must settle entirely inside the viewport" }).toBe(true);
    expect(await dialog.evaluate(e => e.scrollWidth <= e.clientWidth + 1)).toBe(true);
    await page.getByTestId("button-save-deal").scrollIntoViewIfNeeded();
    await expect(page.getByTestId("button-save-deal")).toBeInViewport();
    await page.getByTestId("button-cancel-deal").click();
    await page.setViewportSize({ width: 1440, height: 1000 });

    await report(page, hp.clientId);
    await expect(page.getByTestId("row-month-3").locator("td").nth(1)).toHaveText("0");
    await expect(page.getByTestId("link-evidence-month-4-won")).toHaveText("0");
    await expect(page.getByTestId("text-booked-q2")).toHaveText("None recorded");
    await page.getByTestId("link-evidence-month-4-won").click();
    await expect(page.getByTestId("text-evidence-total")).toHaveText("0 records");
    await page.keyboard.press("Escape");
    await page.getByTestId("select-year").selectOption("2025");
    await expect(page.getByTestId("row-month-1")).toContainText("$200");
    await expect(page.getByTestId("text-booked-q1")).toContainText("$60");
    await expect(page.getByTestId("row-month-1")).not.toContainText("₹");
    await page.locator('[data-testid^="row-account-"]').click();
    await expect(page.getByTestId("list-records")).toContainText(`crm:deal:${deal.id}:opportunity`);
    await expect(page.getByTestId("list-records")).toContainText("USD 200");
    await expect(page.getByTestId("list-records")).toContainText("USD 60");
    await expect(page.getByTestId("list-records")).toContainText("02 Nov 2024");
    await page.keyboard.press("Escape");

    await edit(page, deal.id);
    await select(page, "select-deal-stage", "Negotiation");
    await expect(page.getByTestId("input-outcome-date")).toHaveValue("");
    const reopened = await save(page, "PATCH");
    expect(reopened).toMatchObject({ actualOutcomeDate: null, bookedValue: null });
    await report(page, hp.clientId, 2025);
    await expect(page.getByTestId("link-evidence-month-1-won")).toHaveText("0");
    await expect(page.getByTestId("text-booked-q1")).toHaveText("None recorded");
    await expect(page.getByTestId("row-month-1")).toContainText("$200");
    await page.locator('[data-testid^="row-account-"]').click();
    await expect(page.getByTestId("list-records")).not.toContainText(`crm:deal:${deal.id}:outcome`);
    await page.keyboard.press("Escape");

    await remove(page, deal.id);
    for (const year of [2024, 2025]) {
      await report(page, hp.clientId, year);
      await expect(page.getByTestId("row-month-1").locator("td").nth(1)).toHaveText("0");
      await expect(page.getByTestId("row-month-3").locator("td").nth(1)).toHaveText("0");
      await expect(page.getByTestId("text-booked-q1")).toHaveText("None recorded");
      await expect(page.getByTestId("text-booked-q2")).toHaveText("None recorded");
      await page.locator('[data-testid^="row-account-"]').click();
      await expect(page.getByText("No records for this fiscal year.", { exact: true })).toBeVisible();
      await page.keyboard.press("Escape");
    }
    expect((await pool.query("SELECT id FROM hp_bi_records WHERE tenant_id=$1 ORDER BY id", [hp.tenantId])).rows).toEqual(mirrorIds);
    expect((await pool.query("SELECT action FROM deal_audit WHERE tenant_id=$1 AND deal_id=$2 ORDER BY id DESC LIMIT 1",
      [hp.tenantId, deal.id])).rows[0].action).toBe("deleted");
  });
