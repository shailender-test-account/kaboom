import { pool } from "@workspace/db";
import { test, expect } from "./fixtures/hp-crm";

const root = process.env.HP_CRM_E2E_URL || "http://localhost:80";
test("HP shared register retains scores and preferences, flags blanks, reuses account creation and exposes scoped AI Answer",
  async ({ page, hp }) => {
    test.setTimeout(180_000);
    await pool.query("UPDATE contacts SET intent_score=77 WHERE tenant_id=$1 AND id=$2", [hp.tenantId, hp.contactId]);
    await pool.query(`INSERT INTO hp_bi_records(tenant_id,client_id,account_id,contact_id,kind,occurred_at,product,source,source_key)
      VALUES($1,$2,$3,$4,'interest','2025-02-01','HP Poly','offline','browser-interest')`,
    [hp.tenantId, hp.clientId, hp.companyId, hp.contactId]);
    await page.goto(`${root}/analytics?clientId=${hp.clientId}`);
    await expect(page.getByTestId("hp-bi-dashboard")).toBeVisible();
    await expect(page.getByTestId(`row-account-${hp.companyId}`)).toBeVisible();
    await page.getByTestId(`row-account-${hp.companyId}`).click();
    await expect(page.getByTestId("account-missing-fields")).toContainText("CITY");
    await expect(page.getByTestId("list-recorded-interests")).toContainText("HP Poly");
    await expect(page.getByTestId("list-recorded-interests")).toContainText("Alice Fixture");
    // Same real company route as CRM, with only authentication isolated.
    const created = await page.evaluate(async ({ clientId }) => {
      const make = async () => {
        const r = await fetch("/api/companies", { method: "POST", credentials: "include",
          headers: { "Content-Type": "application/json" }, body: JSON.stringify({ clientId, name: "Incomplete HP account" }) });
        return { status: r.status, body: await r.json() };
      };
      return Promise.all([make(), make()]);
    }, { clientId: hp.clientId });
    expect(created.map(r => r.status).sort()).toEqual([200, 201]);
    expect(created[0].body.id).toBe(created[1].body.id);
    await page.goto(`${root}/analytics?clientId=${hp.clientId}`);
    await expect(page.getByTestId(`row-account-${created[0].body.id}`)).toContainText("Needs completion");
    await page.getByTestId("filter-needs-completion").check();
    await expect(page.getByTestId(`row-account-${created[0].body.id}`)).toBeVisible();
    const original = (await pool.query("SELECT company_id,intent_score FROM contacts WHERE tenant_id=$1 AND id=$2",
      [hp.tenantId, hp.contactId])).rows[0];
    expect(original.company_id).toBe(hp.companyId); expect(Number(original.intent_score)).toBe(77);
    await page.getByTestId("button-hp-ai-answer").click();
    await expect(page.getByTestId("page-ai-answer")).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/ai-answer\\?clientId=${hp.clientId}$`));
    await expect(page.getByTestId("select-client")).toContainText("HP");
    await page.screenshot({ path: "/tmp/hp-register-ai-answer.png", fullPage: true });
  });
