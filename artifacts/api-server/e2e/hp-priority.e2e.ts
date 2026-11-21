import { randomUUID } from "node:crypto";
import { pool } from "@workspace/db";
import { test, expect } from "./fixtures/hp-crm";
const root = process.env.HP_CRM_E2E_URL || "http://localhost:80";
test("HP priority explains fresh Warm evidence and reconfirms an elapsed buying window", async ({ page, hp }) => {
  const submission = await pool.query(`INSERT INTO intent_inbound_submissions(tenant_id,client_id,account_id,contact_id,
    drive_file_id,row_key,file_name,form_type,classification,classification_reason,product_interest,purchase_timeframe_months,submitted_at)
    VALUES($1,$2,$3,$4,$5,$5,'Warm priority browser fixture','event_feedback','warm','fixture','HP Device as a Service',6,NOW())
    RETURNING id`, [hp.tenantId, hp.clientId, hp.companyId, hp.contactId, randomUUID()]);
  await page.goto(`${root}/analytics?clientId=${hp.clientId}`);
  await expect(page.getByTestId("hp-bi-dashboard")).toBeVisible();
  await expect(page.getByTestId(`account-priority-${hp.companyId}`)).toContainText("45.5/100");
  await expect(page.getByTestId(`flag-status-${hp.companyId}`)).toHaveText("Warm");
  await page.getByTestId(`row-account-${hp.companyId}`).click();
  await expect(page.getByTestId("account-priority")).toContainText("45.5/100 · Warm");
  await expect(page.getByTestId("account-priority")).toContainText("45.5/65");
  await expect(page.getByTestId("priority-routing")).toContainText("Needs attention");
  await page.getByText("How is this calculated?", { exact: true }).click();
  await expect(page.getByTestId("account-priority")).toContainText("No email sequence is started");
  await pool.query("UPDATE intent_inbound_submissions SET submitted_at=NOW()-interval '240 days' WHERE tenant_id=$1 AND id=$2",
    [hp.tenantId, submission.rows[0].id]);
  await page.goto(`${root}/analytics?clientId=${hp.clientId}`);
  await expect(page.getByTestId(`flag-status-${hp.companyId}`)).toHaveText("Cold");
  await expect(page.getByTestId(`account-priority-${hp.companyId}`)).toContainText("Needs reconfirmation");
  await page.getByTestId(`row-account-${hp.companyId}`).click();
  await expect(page.getByTestId("account-priority")).toContainText("Needs reconfirmation");
  await expect(page.getByTestId("account-priority")).toContainText("Declared qualification: Cold");
});
