import { pool } from "@workspace/db";
import { importApprovedGccProfiling } from "../src/lib/hpGccProfiling";
import { loadHpBi } from "../src/lib/hpBiMetrics";
import { test, expect } from "./fixtures/hp-crm";

const root = process.env.HP_CRM_E2E_URL || "http://localhost:80";

test("approved GCC directory profiling is visible as read-only account source context", async ({ page, hp }) => {
  test.setTimeout(60_000);
  const profile = (await pool.query(
    "SELECT hp_id,parent_key FROM hp_account_profiles WHERE tenant_id=$1 AND client_id=$2 AND company_id=$3",
    [hp.tenantId, hp.clientId, hp.companyId],
  )).rows[0];
  expect(profile.hp_id).toBeTruthy();
  const filters = { clientId: hp.clientId, year: 2026, parentKey: profile.parent_key, page: 1, pageSize: 25 };
  const baseline = await loadHpBi(hp.tenantId, filters, true) as any;
  const before = (await pool.query(`SELECT
    (SELECT count(*)::int FROM hp_bi_records WHERE tenant_id=$1 AND client_id=$2) records,
    (SELECT count(*)::int FROM intent_inbound_submissions WHERE tenant_id=$1 AND client_id=$2) submissions`,
  [hp.tenantId, hp.clientId])).rows[0];
  const fileHash = "e".repeat(64);
  const result = await importApprovedGccProfiling(hp.tenantId, hp.clientId, {
    fileName: "fixture.xlsx",
    fileHash,
    rows: [{ sourceRow: 2, values: {
      companyName: "Gcc directory", name: "Directory Example", title: "Head IT",
      email: "gcc-ui@example.invalid", email2: "gcc-alternate@example.invalid",
      phone: "9876543210", phone2: "9876543211", city: "Delhi",
    } }],
  }, [{ sourceCompany: "GCC Directory", accountId: hp.companyId, hpId: profile.hp_id }], true);
  expect(result.applied).toBe(true);
  expect(result.results[0]).toMatchObject({ outcome: "created", companyName: "Gcc directory", accountId: hp.companyId });
  const contactsBeforePending = Number((await pool.query(
    "SELECT count(*)::int AS n FROM contacts WHERE tenant_id=$1 AND client_id=$2", [hp.tenantId, hp.clientId],
  )).rows[0].n);
  const pendingMetadata = [
    { sourceRow: 3, fileHash, fileName: "fixture.xlsx", sheet: "GCC", importedAt: new Date().toISOString(),
      contactId: null, identityReview: "Email/phone matches a differently named contact; identity review required",
      values: { companyName: "GCC Directory", name: "Another Example", title: "Head IT",
        email: "gcc-ui@example.invalid", email2: "", phone: "9999999999", phone2: "", city: "Mumbai" } },
    { sourceRow: 4, fileHash, fileName: "fixture.xlsx", sheet: "GCC", importedAt: new Date().toISOString(),
      contactId: result.results[0].contactId, deleted: true,
      values: { companyName: "GCC Directory", name: "Deleted Example", title: "", email: "", email2: "",
        phone: "", phone2: "", city: "Hyderabad" } },
  ];
  const appended = await pool.query(`UPDATE hp_account_profiles
    SET dimensions=jsonb_set(dimensions,'{_gccProfiling}',
      COALESCE(dimensions->'_gccProfiling','[]'::jsonb)||$4::jsonb,true)
    WHERE tenant_id=$1 AND client_id=$2 AND company_id=$3
    RETURNING dimensions->'_gccProfiling' AS source_rows`,
  [hp.tenantId, hp.clientId, hp.companyId, JSON.stringify(pendingMetadata)]);
  expect(appended.rowCount).toBe(1);
  expect(appended.rows[0].source_rows).toHaveLength(3);
  expect(Number((await pool.query(
    "SELECT count(*)::int AS n FROM contacts WHERE tenant_id=$1 AND client_id=$2", [hp.tenantId, hp.clientId],
  )).rows[0].n)).toBe(contactsBeforePending);
  const after = (await pool.query(`SELECT
    (SELECT count(*)::int FROM hp_bi_records WHERE tenant_id=$1 AND client_id=$2) records,
    (SELECT count(*)::int FROM intent_inbound_submissions WHERE tenant_id=$1 AND client_id=$2) submissions`,
  [hp.tenantId, hp.clientId])).rows[0];
  expect(after).toEqual(before);

  // Qualification history is unrelated to this read-only source-profile check.
  await page.route("**/api/engagement-history**", route =>
    route.fulfill({ status: 501, contentType: "application/json", body: JSON.stringify({ error: "Outside this test scope" }) }));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${root}/analytics?clientId=${hp.clientId}`);
  await expect(page.getByTestId("hp-bi-dashboard")).toBeVisible();
  await expect(page.getByTestId("select-year")).toHaveValue("2026");
  await expect(page.getByTestId("layout-structured")).toHaveAttribute("aria-pressed", "true");
  await page.getByTestId(`account-metric-${hp.companyId}-hot`).click();
  await expect(page.getByTestId("structured-account")).toBeVisible();
  await expect(page.getByTestId("detail-metric-leads").locator("span").first()).toHaveText(String(baseline.account.leads));

  const card = page.getByTestId("gcc-profiling");
  await expect(card).toBeVisible();
  await expect(card.locator("summary")).toHaveText("GCC profiling — 2 source rows");
  await expect(card).toHaveAttribute("open", "");
  const city = page.getByTestId("ctx-City");
  await expect(city).toContainText("Delhi");
  await expect(city).toContainText("Mumbai");
  await expect(city).toContainText("GCC contact locations");
  const workbook = page.getByTestId("workbook-profile");
  expect(await page.evaluate(() => {
    const gcc = document.querySelector('[data-testid="gcc-profiling"]');
    const wb = document.querySelector('[data-testid="workbook-profile"]');
    return !!gcc && !!wb && !!(gcc.compareDocumentPosition(wb) & Node.DOCUMENT_POSITION_FOLLOWING);
  })).toBe(true);
  const sourceRows = page.getByTestId("gcc-profile-row");
  await expect(sourceRows).toHaveCount(2);
  const sourceRow = sourceRows.nth(0);
  const pendingRow = sourceRows.nth(1);
  await expect(sourceRow).toBeVisible();
  for (const value of [
    "Gcc directory", "Directory Example", "Head IT", "gcc-ui@example.invalid",
    "gcc-alternate@example.invalid", "9876543210", "9876543211", "Delhi",
    "fixture.xlsx / GCC / row 2",
  ]) await expect(sourceRow).toContainText(value);
  await expect(sourceRow).toContainText("Source company");
  await expect(sourceRow).toContainText("Alternate email");
  await expect(sourceRow).toContainText("Alternate phone");
  await expect(pendingRow).toBeVisible();
  for (const value of ["Another Example", "gcc-ui@example.invalid", "9999999999", "Mumbai", "fixture.xlsx / GCC / row 3"])
    await expect(pendingRow).toContainText(value);
  await expect(pendingRow).toContainText("Contact link pending review");
  await expect(pendingRow.getByTestId("gcc-identity-review")).toContainText("Needs identity review");
  await expect(pendingRow.getByTestId("gcc-identity-review")).toContainText("do not assume this email belongs to both people");
  await expect(card).not.toContainText("Deleted Example");
  await expect(card).toContainText("not responses, qualified leads or consent to outreach");
  const contactList = page.getByTestId("list-contacts");
  await expect(contactList).toContainText("Directory Example");
  await expect(contactList).toContainText("gcc-ui@example.invalid");
  await expect(contactList).not.toContainText("Another Example");
  await expect(contactList).not.toContainText("Deleted Example");
  await expect(contactList.locator("li")).toHaveCount(baseline.contacts.length + 1);
  await page.getByTestId("section-context").screenshot({ path: "/tmp/hp-gcc-city-structured-desktop.png" });

  await page.setViewportSize({ width: 402, height: 874 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByTestId("section-context").screenshot({ path: "/tmp/hp-gcc-city-structured-mobile.png" });

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByTestId("button-detail-back").click();
  await expect(page.getByTestId("sheet-account-detail")).toBeHidden();
  await page.getByTestId("layout-original").click();
  await expect(page.getByTestId("layout-original")).toHaveAttribute("aria-pressed", "true");
  await page.getByTestId(`account-metric-${hp.companyId}-hot`).click();
  const originalContext = page.getByTestId("original-account-context");
  await expect(originalContext).toBeVisible();
  await expect(originalContext.getByTestId("account-locations")).toContainText("Delhi");
  await expect(originalContext.getByTestId("account-locations")).toContainText("Mumbai");
  await expect(originalContext.getByTestId("account-locations")).toContainText("GCC contact locations");
  const originalCard = originalContext.getByTestId("gcc-profiling");
  await expect(originalCard).toHaveAttribute("open", "");
  await expect(originalCard.locator("summary")).toHaveText("GCC profiling — 2 source rows");
  await expect(originalCard.getByTestId("gcc-profile-row").nth(0)).toContainText("Directory Example");
  await expect(originalCard.getByTestId("gcc-profile-row").nth(1)).toContainText("Contact link pending review");
  await expect(originalCard).not.toContainText("Deleted Example");
  await page.screenshot({ path: "/tmp/hp-gcc-city-original-desktop.png", fullPage: true });
  await page.setViewportSize({ width: 402, height: 874 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await originalContext.screenshot({ path: "/tmp/hp-gcc-city-original-mobile.png" });
  const finalCounts = (await pool.query(`SELECT
    (SELECT count(*)::int FROM hp_bi_records WHERE tenant_id=$1 AND client_id=$2) records,
    (SELECT count(*)::int FROM intent_inbound_submissions WHERE tenant_id=$1 AND client_id=$2) submissions`,
  [hp.tenantId, hp.clientId])).rows[0];
  expect(finalCounts).toEqual(before);
});
