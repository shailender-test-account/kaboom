import { pool } from "@workspace/db";
import { test, expect } from "./fixtures/hp-crm";

const root = process.env.HP_CRM_E2E_URL || "http://localhost:80";
test("saved HP parent views preserve settings across reload and enforce client ownership", async ({ page, hp }) => {
  test.setTimeout(180_000);
  const parent = (await pool.query("SELECT parent_key FROM hp_account_profiles WHERE company_id=$1", [hp.companyId])).rows[0].parent_key;
  const base = `/api/analytics/hp-bi/pivot/views?clientId=${hp.clientId}`;
  await page.goto(`${root}/analytics?clientId=${hp.clientId}`);
  await page.getByTestId("tab-parent-comparison").click();
  await expect(page.getByTestId("pivot-view-select")).toBeEnabled();
  await page.getByTestId(`pivot-parent-${parent}`).check();
  await page.getByTestId("pivot-segment-GCC").check();
  await page.getByTestId("pivot-portfolio-PS").check();
  await page.getByTestId("pivot-rad-basis").selectOption("Print");
  await page.getByTestId("pivot-rad-Acquisition").check();
  await page.getByTestId("pivot-metric").selectOption("leads");
  await page.getByTestId("pivot-breakdown").selectOption("segment_portfolio");
  await page.getByTestId("pivot-preset-cal").click();
  await page.getByTestId("pivot-view-name").fill("Annual review");
  const created = page.waitForResponse(r => r.url().endsWith(base) && r.request().method() === "POST");
  await page.getByTestId("pivot-view-create").click();
  const response = await created;
  expect(response.status()).toBe(201);
  const view = await response.json();
  expect(view.config).toMatchObject({ datePolicy: "cal", parents: [parent], segments: ["GCC"], portfolios: ["PS"],
    rads: ["Acquisition"], basis: "Print", metric: "leads", breakdown: "segment_portfolio" });
  expect(view.config).not.toHaveProperty("currentStart");
  await page.reload();
  await page.getByTestId("tab-parent-comparison").click();
  await page.getByTestId("pivot-view-select").selectOption(String(view.id));
  await expect(page.getByTestId("pivot-metric")).toHaveValue("leads");
  await expect(page.getByTestId("pivot-breakdown")).toHaveValue("segment_portfolio");
  await expect(page.getByTestId(`pivot-chip-${parent}`)).toBeVisible();
  await expect(page.getByTestId("pivot-rad-Acquisition")).toBeChecked();
  await expect(page.getByTestId("pivot-rad-basis")).toHaveValue("Print");
  await expect(page.getByTestId("pivot-date-policy")).toContainText("Relative calendar years");
  // Rename changes only the name, while updating saves the displayed comparison settings.
  await page.getByTestId("pivot-view-name").fill("Renamed review");
  await page.getByTestId("pivot-view-rename").click();
  await expect(page.getByRole("status")).toContainText("View renamed.");
  await page.getByTestId("pivot-current-start").fill("2024-02-01");
  await page.getByTestId("pivot-current-end").fill("2024-02-29");
  await page.getByTestId("pivot-previous-start").fill("2023-02-01");
  await page.getByTestId("pivot-previous-end").fill("2023-02-28");
  await page.getByTestId("pivot-metric").selectOption("hot");
  await expect(page.getByTestId("pivot-view-dirty")).toBeVisible();
  await page.getByTestId("pivot-view-update").click();
  await expect(page.getByRole("status")).toContainText("Saved settings updated.");
  await page.getByTestId("pivot-reset").click();
  await page.getByTestId("pivot-view-reopen").click();
  await expect(page.getByTestId("pivot-current-end")).toHaveValue("2024-02-29");
  await expect(page.getByTestId("pivot-metric")).toHaveValue("hot");
  await expect(page.getByTestId("pivot-date-policy")).toContainText("Fixed custom dates");
  await expect(page.getByTestId("pivot-view-dirty")).toHaveCount(0);
  await page.getByTestId("pivot-view-create").click();
  await expect(page.getByRole("alert")).toContainText("already exists");
  // Requests exercise real authenticated routes; other-client and other-tenant IDs cannot read or change this view.
  const client2 = Number((await pool.query("INSERT INTO clients(tenant_id,name) VALUES($1,'HP') RETURNING id", [hp.tenantId])).rows[0].id);
  const foreignTenant = Number((await pool.query("INSERT INTO tenants(name,slug) VALUES('View isolation fixture',$1) RETURNING id", [`view-isolation-${hp.tenantId}`])).rows[0].id);
  try {
    const foreignClient = Number((await pool.query("INSERT INTO clients(tenant_id,name) VALUES($1,'HP') RETURNING id", [foreignTenant])).rows[0].id);
    const statuses = await page.evaluate(async ({ id, client2, foreignClient }) => {
      const request = async (client: number, method: string, suffix = "") => {
        const r = await fetch(`/api/analytics/hp-bi/pivot/views${suffix}?clientId=${client}`, {
          method, headers: { "Content-Type": "application/json" }, ...(method === "PATCH" ? { body: JSON.stringify({ name: "illegal" }) } : {}),
        });
        return { status: r.status, body: method === "GET" ? await r.json() : null };
      };
      return {
        empty: await request(client2, "GET"), otherPatch: await request(client2, "PATCH", `/${id}`),
        otherDelete: await request(client2, "DELETE", `/${id}`), foreign: await request(foreignClient, "GET"),
      };
    }, { id: view.id, client2, foreignClient });
    expect(statuses.empty).toEqual({ status: 200, body: [] });
    expect(statuses.otherPatch.status).toBe(404);
    expect(statuses.otherDelete.status).toBe(404);
    expect(statuses.foreign.status).toBe(404);
  } finally {
    await pool.query("DELETE FROM clients WHERE tenant_id=$1", [foreignTenant]);
    await pool.query("DELETE FROM tenants WHERE id=$1", [foreignTenant]);
  }
  await page.screenshot({ path: "/tmp/hp-parent-views.png", fullPage: true });
  await page.getByTestId("pivot-view-delete").click();
  await page.getByTestId("pivot-view-confirm-delete").click();
  await expect(page.getByRole("status")).toContainText("Saved view deleted.");
  await expect(page.getByTestId("pivot-current-end")).toHaveValue("2024-02-29");
  await page.reload();
  await page.getByTestId("tab-parent-comparison").click();
  await expect(page.getByTestId("pivot-view-select").locator("option")).toHaveCount(1);
});
