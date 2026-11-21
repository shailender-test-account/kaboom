import { pool } from "@workspace/db";
import { test, expect } from "./fixtures/hp-crm";

const root = process.env.HP_CRM_E2E_URL || "http://localhost:80";
test("HP account screen edits the selected legal member contact and manages its journeys and sequence history",
  async ({ page, hp }) => {
    test.setTimeout(180_000);
    let journeyId = 0, seq = 0, play = 0;
    try {
      await pool.query("UPDATE contacts SET intent_score=77 WHERE id=$1", [hp.contactId]);
      play = Number((await pool.query("INSERT INTO abm_plays(tenant_id,client_id,name) VALUES($1,$2,'HP management play') RETURNING id",
        [hp.tenantId, hp.clientId])).rows[0].id);
      journeyId = Number((await pool.query("INSERT INTO journeys(tenant_id,client_id,name,slug) VALUES($1,$2,'HP managed journey',$3) RETURNING id",
        [hp.tenantId, hp.clientId, `manage-browser-${hp.tenantId}`])).rows[0].id);
      // No email steps: no jobs or messages can be sent from this fixture.
      seq = Number((await pool.query("INSERT INTO email_sequences(tenant_id,play_id,name,status) VALUES($1,$2,'HP managed sequence','active') RETURNING id",
        [hp.tenantId, play])).rows[0].id);
      await page.goto(`${root}/analytics?clientId=${hp.clientId}`);
      await expect(page.getByTestId("hp-bi-dashboard")).toBeVisible();
      await page.getByTestId(`row-account-${hp.companyId}`).click();
      const panel = page.getByTestId("manage-account-panel");
      await expect(panel).toBeVisible();
      await page.getByTestId("select-manage-contact").selectOption(String(hp.siblingContact));
      await page.getByTestId("button-edit-managed-contact").click();
      await expect(page.getByTestId("input-managed-firstName")).toHaveValue("Bob");
      await page.getByTestId("input-managed-firstName").fill("Robert");
      await page.getByTestId("input-managed-title").fill("Procurement Director");
      await page.getByTestId("button-save-managed-contact").click();
      await expect(page.getByTestId("button-edit-managed-contact")).toBeVisible();
      const corrected = (await pool.query("SELECT first_name,title,company_id FROM contacts WHERE id=$1", [hp.siblingContact])).rows[0];
      expect(corrected).toMatchObject({ first_name: "Robert", title: "Procurement Director", company_id: hp.siblingId });
      await page.getByTestId("select-manage-journey").selectOption(String(journeyId));
      await page.getByTestId("button-add-managed-journey").click();
      await expect(page.getByTestId(`button-remove-journey-${journeyId}`)).toBeVisible();
      await expect(page.getByTestId(`link-journey-${journeyId}`)).toHaveAttribute("href", `/journeys/${journeyId}`);
      await page.getByTestId(`button-remove-journey-${journeyId}`).click();
      await page.getByTestId("confirm-manage-action").click();
      await expect(page.getByTestId(`button-remove-journey-${journeyId}`)).toHaveCount(0);
      await page.getByTestId("select-manage-sequence").selectOption(String(seq));
      await page.getByTestId("button-enroll-managed-sequence").click();
      await expect(page.getByTestId("dialog-manage-confirm")).toContainText(/message|email/i);
      expect((await pool.query("SELECT count(*)::int n FROM sequence_enrollments WHERE sequence_id=$1", [seq])).rows[0].n).toBe(0);
      await page.getByTestId("confirm-manage-action").click();
      const cancel = panel.locator('[data-testid^="button-cancel-enrollment-"]');
      await expect(cancel).toHaveCount(1);
      await expect(page.getByTestId(`link-sequence-${seq}`)).toHaveAttribute("href", `/sequences/${seq}`);
      await cancel.click(); await page.getByTestId("confirm-manage-action").click();
      await expect(cancel).toHaveCount(0);
      await expect(panel).toContainText("cancelled");
      await page.screenshot({ path: "/tmp/hp-manage-account-panel.png", fullPage: true });
      await page.reload();
      await page.getByTestId(`row-account-${hp.companyId}`).click();
      await page.getByTestId("select-manage-contact").selectOption(String(hp.siblingContact));
      await expect(panel).toContainText("cancelled");
      await page.getByTestId("button-edit-managed-contact").click();
      await expect(page.getByTestId("input-managed-firstName")).toHaveValue("Robert");
      await page.getByTestId("button-cancel-edit-managed-contact").click();
      const original = (await pool.query("SELECT first_name,company_id,intent_score FROM contacts WHERE id=$1", [hp.contactId])).rows[0];
      expect(original.first_name).toBe("Alice"); expect(original.company_id).toBe(hp.companyId); expect(Number(original.intent_score)).toBe(77);
    } finally {
      if (seq) {
        await pool.query("DELETE FROM sequence_enrollments WHERE sequence_id=$1", [seq]);
        await pool.query("DELETE FROM email_sequences WHERE id=$1", [seq]);
      }
      if (journeyId) {
        await pool.query("DELETE FROM journey_contacts WHERE journey_id=$1", [journeyId]);
        await pool.query("DELETE FROM journeys WHERE id=$1", [journeyId]);
      }
      if (play) await pool.query("DELETE FROM abm_plays WHERE id=$1", [play]);
    }
  });
