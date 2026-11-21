import { pool } from "@workspace/db";
import { test, expect } from "./fixtures/hp-crm";

const root = process.env.HP_CRM_E2E_BASE_URL ?? "http://localhost:80";
test("route a contact from the HP account card and retain its memberships after reload", async ({ page, hp }) => {
  test.setTimeout(90_000);
  const play = Number((await pool.query(`INSERT INTO abm_plays(tenant_id,client_id,name) VALUES($1,$2,'Routing fixture play') RETURNING id`,
    [hp.tenantId, hp.clientId])).rows[0].id);
  const journey = Number((await pool.query(`INSERT INTO journeys(tenant_id,client_id,name,slug,status)
    VALUES($1,$2,'HP routing fixture journey',$3,'published') RETURNING id`,
    [hp.tenantId, hp.clientId, `routing-${hp.tenantId}`])).rows[0].id);
  // Intentionally no steps: this test cannot send a message.
  const sequence = Number((await pool.query(`INSERT INTO email_sequences(tenant_id,play_id,name,status)
    VALUES($1,$2,'HP routing fixture sequence','active') RETURNING id`, [hp.tenantId, play])).rows[0].id);
  const deal = Number((await pool.query(`INSERT INTO deals(tenant_id,client_id,company_id,title)
    VALUES($1,$2,$3,'HP routing fixture opportunity') RETURNING id`, [hp.tenantId, hp.clientId, hp.companyId])).rows[0].id);
  await page.goto(`${root}/analytics?clientId=${hp.clientId}`);
  await page.getByTestId(`row-account-${hp.companyId}`).click();
  const history = page.getByTestId("engagement-history").first();
  await expect(history).toBeVisible();
  await history.getByTestId(`route-history-contact-${hp.contactId}`).click();
  const routing = history.getByTestId("inline-contact-routing");
  await routing.getByTestId("select-manage-journey").selectOption(String(journey));
  await routing.getByTestId("button-add-managed-journey").click();
  await expect(history.getByTestId(`history-contact-${hp.contactId}`)).toContainText("HP routing fixture journey");
  await routing.getByTestId("select-manage-sequence").selectOption(String(sequence));
  await routing.getByTestId("button-enroll-managed-sequence").click();
  await expect(routing.getByTestId("dialog-manage-confirm")).toContainText("Messages may start sending");
  await routing.getByTestId("confirm-manage-action").click();
  await expect(history.getByTestId(`history-contact-${hp.contactId}`)).toContainText("HP routing fixture sequence");
  await routing.getByTestId("select-manage-opportunity").selectOption(String(deal));
  await routing.getByTestId("button-link-managed-opportunity").click();
  await expect(history.getByTestId(`history-contact-${hp.contactId}`)).toContainText("HP routing fixture opportunity");
  await expect(routing.getByTestId("select-manage-journey").locator(`option[value="${journey}"]`)).toHaveCount(0);
  await expect(routing.getByTestId("select-manage-sequence").locator(`option[value="${sequence}"]`)).toHaveCount(0);
  await page.goto(`${root}/analytics?clientId=${hp.clientId}`);
  await page.getByTestId(`row-account-${hp.companyId}`).click();
  const refreshed = page.getByTestId("engagement-history").first();
  await expect(refreshed).toBeVisible();
  await expect(refreshed.getByTestId(`history-contact-${hp.contactId}`)).toContainText("HP routing fixture journey");
  await expect(refreshed.getByTestId(`history-contact-${hp.contactId}`)).toContainText("HP routing fixture sequence");
  await expect(refreshed.getByTestId(`history-contact-${hp.contactId}`)).toContainText("HP routing fixture opportunity");
  await refreshed.getByRole("link", { name: "HP routing fixture opportunity" }).click();
  await expect(page.getByTestId("dialog-deal-editor")).toBeVisible();
  await expect(page.getByTestId("opportunity-linked-contacts")).toContainText("Stakeholder");
  expect(Number((await pool.query("SELECT count(*) FROM journey_contacts WHERE journey_id=$1 AND contact_id=$2",
    [journey, hp.contactId])).rows[0].count)).toBe(1);
  expect(Number((await pool.query("SELECT count(*) FROM sequence_enrollments WHERE sequence_id=$1 AND contact_id=$2",
    [sequence, hp.contactId])).rows[0].count)).toBe(1);
});
