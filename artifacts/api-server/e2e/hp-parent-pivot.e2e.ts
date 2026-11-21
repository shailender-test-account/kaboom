import { pool } from "@workspace/db";
import { test, expect } from "./fixtures/hp-crm";

const root = process.env.HP_CRM_E2E_URL || "http://localhost:80";
test("HP parent pivot intersects dates, segment, portfolio and RAD with evidence and complete export", async ({ page, hp }) => {
  test.setTimeout(150_000);
  await pool.query(`UPDATE hp_account_profiles SET gtm='GCC',ps_rad='R1',prt_rad='A1',ps_tam_k='100',prt_tam_k=NULL
    WHERE tenant_id=$1 AND client_id=$2`, [hp.tenantId, hp.clientId]);
  const parent = (await pool.query(`SELECT parent_key FROM hp_account_profiles WHERE company_id=$1`, [hp.companyId])).rows[0].parent_key as string;
  const gov = Number((await pool.query(`INSERT INTO companies(tenant_id,client_id,name) VALUES($1,$2,'Government Parent') RETURNING id`, [hp.tenantId, hp.clientId])).rows[0].id);
  await pool.query(`INSERT INTO hp_account_profiles(tenant_id,client_id,company_id,parent_key,parent_name,provenance,gtm,ps_rad,prt_rad,ps_tam_k,prt_tam_k)
    VALUES($1,$2,$3,'pivot-gov','Government Parent','manual','Gov/Edu','A1','R1','40','50')`, [hp.tenantId, hp.clientId, gov]);
  for (const [key, account, kind, product, date, value, currency] of [
    ["ps-touch", hp.companyId, "other", "HP laptop", "2026-09-15", null, null],
    ["print-touch", gov, "attendance", "HP printer", "2026-09-15", null, null],
    ["unknown-touch", gov, "other", null, "2026-09-15", null, null],
    ["previous-ps", hp.companyId, "other", "HP laptop", "2025-09-15", null, null],
    ["ps-lead", hp.companyId, "lead", "HP laptop", "2026-09-15", null, null],
    ["print-lead", gov, "lead", "HP printer", "2026-09-15", null, null],
    ["ps-opp", hp.companyId, "opportunity", "HP laptop", "2026-09-15", 20, "USD"],
    ["print-opp", gov, "opportunity", "HP printer", "2026-09-15", 100, "INR"],
  ] as const) {
    await pool.query(`INSERT INTO hp_bi_records(tenant_id,client_id,account_id,contact_id,kind,occurred_at,product,horizon_months,order_value,currency,source,source_key)
      VALUES($1,$2,$3,$4,$5,$6,$7,3,$8,$9,'pivot browser fixture',$10)`,
    [hp.tenantId, hp.clientId, account, account === hp.companyId ? hp.contactId : null, kind, `${date}T08:00:00Z`, product, value, currency, key]);
  }
  await page.goto(`${root}/analytics?clientId=${hp.clientId}`);
  await page.getByTestId("tab-parent-comparison").click();
  await expect(page.getByTestId("parent-comparison")).toBeVisible();
  await page.getByTestId("pivot-current-start").fill("2026-09-01");
  await page.getByTestId("pivot-current-end").fill("2026-09-30");
  await page.getByTestId("pivot-previous-start").fill("2025-09-01");
  await page.getByTestId("pivot-previous-end").fill("2025-09-30");
  await page.getByTestId("pivot-segment-GCC").check();
  await page.getByTestId("pivot-segment-Gov/Edu").check();
  await page.getByTestId("pivot-portfolio-PS").check();
  await page.getByTestId("pivot-portfolio-Print").check();
  await page.getByTestId("pivot-breakdown").selectOption("portfolio");
  await page.getByTestId("pivot-apply").click();
  await expect(page.getByTestId("pivot-total-current")).toHaveText("2");
  await expect(page.getByTestId("pivot-total-previous")).toHaveText("1");
  await expect(page.getByTestId("pivot-table")).toContainText("Government Parent");
  await expect(page.getByTestId("pivot-planning")).toContainText("$50K");
  await expect(page.getByTestId("pivot-planning")).toContainText("Not supplied");
  await page.getByTestId(`pivot-cell-${parent}-PS-current`).click();
  await expect(page.getByTestId("pivot-evidence-total")).toContainText("1");
  await expect(page.getByTestId("pivot-evidence")).toContainText("HP laptop");
  await page.getByTestId("pivot-evidence-back").click();
  await expect(page.getByTestId("pivot-evidence")).toBeHidden();
  await expect(page.getByTestId("pivot-current-start")).toHaveValue("2026-09-01");

  await page.getByTestId("pivot-metric").selectOption("opportunityValue");
  await page.getByTestId("pivot-apply").click();
  await expect(page.getByTestId("pivot-total-current")).toContainText("$20");
  await expect(page.getByTestId("pivot-total-current")).toContainText("₹100");
  const download = page.waitForEvent("download");
  await page.getByTestId("pivot-export").click();
  const saved = await download;
  expect(saved.suggestedFilename()).toBe("hp-parent-comparison.csv");

  await page.getByTestId("pivot-metric").selectOption("touchpoints");
  await page.getByTestId("pivot-parent-search").fill("Government");
  await page.getByTestId("pivot-parent-pivot-gov").check();
  await page.getByTestId("pivot-apply").click();
  await expect(page.getByTestId("pivot-table").getByTestId(`pivot-row-${parent}`)).toHaveCount(0);
  await expect(page.getByTestId("pivot-total-current")).toHaveText("1");
  await page.getByTestId("pivot-rad-basis").selectOption("PS");
  await page.getByTestId("pivot-rad-Retention").check();
  await page.getByTestId("pivot-apply").click();
  await expect(page.getByTestId("pivot-empty")).toBeVisible();
  await page.getByTestId("pivot-rad-basis").selectOption("Print");
  await page.getByTestId("pivot-apply").click();
  await expect(page.getByTestId("pivot-table")).toContainText("Government Parent");
  await expect(page.getByTestId("pivot-total-current")).toHaveText("1");
  await page.getByTestId("pivot-current-end").fill("2026-08-31");
  await expect(page.getByTestId("pivot-apply")).toBeDisabled();
  await expect(page.getByTestId("pivot-errors")).toBeVisible();
  await page.getByTestId("pivot-current-end").fill("2026-09-30");
  await page.screenshot({ path: "/tmp/hp-parent-pivot.png", fullPage: true });
  await page.setViewportSize({ width: 402, height: 874 });
  await expect(page.getByTestId("pivot-apply")).toBeVisible();
  await page.screenshot({ path: "/tmp/hp-parent-pivot-mobile.png", fullPage: true });
  await page.getByTestId("pivot-back").click();
  await expect(page.getByTestId("tab-content-overview")).toBeVisible();
});
