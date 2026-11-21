import { pool } from "@workspace/db";
import { test, expect } from "./fixtures/hp-crm";

const root = process.env.HP_CRM_E2E_URL || "http://localhost:80";

for (const initial of [false, true]) {
  test(`DNC starts ${initial}, toggles, refetches and survives reload in both states`, async ({ page, hp }) => {
    await pool.query("UPDATE contacts SET dnc=$1 WHERE id=$2 AND tenant_id=$3",
      [initial, hp.contactId, hp.tenantId]);
    const detailPath = `/api/contacts/${hp.contactId}`;
    const expectDnc = async (dnc: boolean) => {
      await expect(page.getByRole("button", { name: dnc ? "Remove DNC" : "Mark DNC", exact: true })).toBeVisible();
      await expect(page.getByText("DNC", { exact: true })).toHaveCount(dnc ? 1 : 0);
      await page.getByRole("tab", { name: /^Plays/ }).click();
      const enroll = page.getByRole("button", { name: "Enroll in play", exact: true });
      if (dnc) await expect(enroll).toBeDisabled();
      else await expect(enroll).toBeEnabled();
    };
    await page.goto(`${root}/crm/contacts/${hp.contactId}`);
    await expectDnc(initial);
    for (const dnc of [!initial, initial]) {
      const refetched = page.waitForResponse(r =>
        new URL(r.url()).pathname === detailPath && r.request().method() === "GET" && r.ok());
      await page.getByRole("button", { name: dnc ? "Mark DNC" : "Remove DNC", exact: true }).click();
      expect((await (await refetched).json()).dnc).toBe(dnc);
      await expectDnc(dnc);
      expect((await pool.query("SELECT dnc FROM contacts WHERE id=$1 AND tenant_id=$2",
        [hp.contactId, hp.tenantId])).rows[0].dnc).toBe(dnc);
      const reloaded = page.waitForResponse(r =>
        new URL(r.url()).pathname === detailPath && r.request().method() === "GET" && r.ok());
      await page.reload();
      expect((await (await reloaded).json()).dnc).toBe(dnc);
      await expectDnc(dnc);
    }
  });
}
