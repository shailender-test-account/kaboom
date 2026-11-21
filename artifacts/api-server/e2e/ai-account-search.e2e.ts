import { pool } from "@workspace/db";
import { test, expect } from "./fixtures/hp-crm";

const root = process.env.HP_CRM_E2E_URL || "http://localhost:80";
test("reported AI Search question returns distinct engaged HP accounts instead of a people-only clarification",
  async ({ page, hp }) => {
    test.setTimeout(120_000);
    await pool.query(`INSERT INTO hp_bi_records(tenant_id,client_id,account_id,kind,occurred_at,source,source_key)
      VALUES($1,$2,$3,'attendance','2024-01-01','Attended HP event','ai-account-attendance')`,
    [hp.tenantId, hp.clientId, hp.companyId]);
    await pool.query(`INSERT INTO hp_bi_records(tenant_id,client_id,account_id,contact_id,kind,occurred_at,source,source_key)
      VALUES($1,$2,$3,$4,'digital','2026-10-01','Downloaded brochure','ai-account-download')`,
    [hp.tenantId, hp.clientId, hp.companyId, hp.contactId]);
    await pool.query(`INSERT INTO hp_bi_records(tenant_id,client_id,account_id,kind,occurred_at,source,source_key)
      VALUES($1,$2,$3,'invitation','2026-10-01','Invited only','ai-account-invitation')`,
    [hp.tenantId, hp.clientId, hp.siblingId]);
    await page.goto(`${root}/ai-answer?clientId=${hp.clientId}`);
    await expect(page.getByTestId("page-ai-answer")).toBeVisible();
    await page.getByTestId("input-question").fill("sjow me all accounts which have engaged with us at least once");
    await page.getByTestId("button-ask").click();
    await expect(page.getByTestId(`card-account-${hp.companyId}`)).toBeVisible();
    await expect(page.getByTestId(`card-account-${hp.siblingId}`)).toHaveCount(0);
    await expect(page.getByTestId("text-answer")).toContainText("1 matching account");
    await expect(page.getByTestId(`card-account-${hp.companyId}`)).toContainText("2 matching records");
    await expect(page.getByTestId(`card-account-${hp.companyId}`)).toContainText("Attended HP event");
    await expect(page.getByTestId("state-clarification")).toHaveCount(0);
    await page.screenshot({ path: "/tmp/ai-account-search-fixed.png", fullPage: true });
  });
