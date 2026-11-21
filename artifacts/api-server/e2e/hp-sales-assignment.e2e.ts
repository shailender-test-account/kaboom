import { pool } from "@workspace/db";
import { importHpWorkbook } from "../src/lib/hpBiImport";
import { hpWorkbook } from "../src/lib/testFixtures/hpCrm";
import { test, expect } from "./fixtures/hp-crm";

const root = process.env.HP_CRM_E2E_URL || "http://localhost:80";

test("HP Analytics explains qualification badges and shows current roster salesperson assignments", async ({ page, hp }) => {
  test.setTimeout(60_000);
  const existing = await pool.query(`SELECT company_id,hp_id,parent_key,parent_name,eam_email,pam_email
    FROM hp_account_profiles WHERE tenant_id=$1 AND client_id=$2 AND company_id=ANY($3::int[])`,
  [hp.tenantId, hp.clientId, [hp.companyId, hp.siblingId]]);
  expect(existing.rows).toHaveLength(2);
  const assignedBefore = existing.rows.find(profile => Number(profile.company_id) === hp.companyId);
  const blankBefore = existing.rows.find(profile => Number(profile.company_id) === hp.siblingId);
  expect(assignedBefore?.eam_email).toBeFalsy();
  expect(assignedBefore?.pam_email).toBeFalsy();
  expect(blankBefore?.eam_email).toBeFalsy();
  expect(blankBefore?.pam_email).toBeFalsy();

  // Add a separate, unassigned fixture parent. Keep CRM A and CRM B grouped
  // together so the UI also shows the actual member name beside the assignment.
  await importHpWorkbook(hp.tenantId, hp.clientId, hpWorkbook(
    ["UNIQUE ID", "SUBSIDIARY_LEGAL_NAME", "TOP_ID", "TOP_NAME", "FY25 GTM", "PS RAD"],
    [["CRM-C", "CRM C", "CRM-C-P", "CRM C Parent", "GCC", "R2"]],
  ), "sales-assignment-fixture.xlsx", "accounts", {}, null);
  const emptyProfile = await pool.query(`SELECT company_id,eam_email,pam_email
    FROM hp_account_profiles WHERE tenant_id=$1 AND client_id=$2 AND hp_id='CRM-C'`,
  [hp.tenantId, hp.clientId]);
  expect(emptyProfile.rows).toHaveLength(1);
  expect(emptyProfile.rows[0].eam_email).toBeFalsy();
  expect(emptyProfile.rows[0].pam_email).toBeFalsy();
  const emptyCompanyId = Number(emptyProfile.rows[0].company_id);
  await pool.query(`UPDATE hp_account_profiles SET eam_email=$4,pam_email=$5
    WHERE tenant_id=$1 AND client_id=$2 AND company_id=$3`,
  [hp.tenantId, hp.clientId, hp.companyId, "source.eam@hp.example", "source.pam@hp.example"]);

  const responsePromise = page.waitForResponse(response => {
    const url = new URL(response.url());
    return url.pathname === "/api/analytics/hp-bi" && response.request().method() === "GET"
      && url.searchParams.get("clientId") === String(hp.clientId);
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${root}/analytics?clientId=${hp.clientId}`);
  await expect(page.getByTestId("hp-bi-dashboard")).toBeVisible();
  const response = await responsePromise;
  expect(response.status()).toBe(200);
  const report = await response.json();
  const assignedAccount = report.accounts.find((account: any) => account.id === hp.companyId);
  const blankAccount = report.accounts.find((account: any) => account.id === emptyCompanyId);
  expect(assignedAccount.salesPeople).toEqual([
    { role: "EAM", email: "source.eam@hp.example", accounts: [{ id: hp.companyId, name: "CRM A", hpId: "CRM-A" }] },
    { role: "PAM", email: "source.pam@hp.example", accounts: [{ id: hp.companyId, name: "CRM A", hpId: "CRM-A" }] },
  ]);
  expect(blankAccount.salesPeople).toEqual([]);

  const table = page.getByTestId("table-accounts-wrap");
  await expect(table).toBeVisible();
  const headings = (await table.locator("thead tr th").allTextContents()).map(text => text.trim());
  expect(headings.slice(0, 3)).toEqual(["Parent / account", "HP salesperson", "Routed journey"]);
  const assignedRow = page.getByTestId(`row-account-${hp.companyId}`);
  const assignedCell = page.getByTestId(`hp-sales-person-${hp.companyId}`);
  await expect(assignedRow).toBeVisible();
  await expect(assignedCell).toContainText("EAM:");
  await expect(assignedCell).toContainText("source.eam@hp.example");
  await expect(assignedCell).toContainText("PAM:");
  await expect(assignedCell).toContainText("source.pam@hp.example");
  await expect(assignedCell).toContainText("CRM A");
  await expect(assignedCell).not.toContainText("CRM B");
  await expect(assignedCell).not.toContainText("crm-a@example.invalid");
  expect(await assignedRow.locator("td").nth(1).getAttribute("data-testid")).toBe(`hp-sales-person-${hp.companyId}`);
  const blankCell = page.getByTestId(`hp-sales-person-${emptyCompanyId}`);
  await expect(blankCell).toHaveText("Not assigned in roster");

  const statusTitle = "Overall current qualification across contacts, lead forms and GTM responses, across all dates. Any qualifying Hot evidence makes the account Hot. Journey points do not determine this badge.";
  const gtmTitle = "HP assessment of questionnaire/event-feedback answers, across all dates: a product/service requirement with a purchase timeline of 0–6 months is Hot; other product responses are Warm.";
  const sourceTitle = "Saved inbound classifications, not the HP reassessment. H/W/C counts Hot/Warm/Cold accounts within this parent group, not leads or respondents.";
  await expect(table.getByTestId(`flag-status-${hp.companyId}`)).toHaveAttribute("title", statusTitle);
  await expect(table.getByTestId(`gtm-status-${hp.companyId}`)).toHaveAttribute("title", gtmTitle);
  await expect(table.getByTestId(`gtm-source-${hp.companyId}`)).toHaveAttribute("title", sourceTitle);
  const explanation = page.locator("details").filter({ hasText: "What do the three qualification badges mean?" });
  await expect(explanation.locator("summary")).toHaveText("What do the three qualification badges mean?");
  await explanation.locator("summary").click();
  await expect(explanation).toContainText(statusTitle);
  await expect(explanation).toContainText(gtmTitle);
  await expect(explanation).toContainText(sourceTitle);
  await expect(explanation).toContainText("These are different views of the same account, not three separate Hot leads.");

  const tableScroller = table.locator("div.overflow-x-auto");
  await expect(tableScroller).toHaveCSS("overflow-x", "auto");
  await page.screenshot({ path: "/tmp/hp-sales-assignment-desktop.png", fullPage: true });
  await page.setViewportSize({ width: 402, height: 874 });
  const mobileLayout = await page.evaluate(() => {
    const scroller = document.querySelector('[data-testid="table-accounts-wrap"] .overflow-x-auto') as HTMLElement;
    return { documentWidth: document.documentElement.scrollWidth, viewportWidth: window.innerWidth,
      overflowX: getComputedStyle(scroller).overflowX, tableWidth: scroller.scrollWidth, viewportTableWidth: scroller.clientWidth };
  });
  expect(mobileLayout.documentWidth).toBeLessThanOrEqual(mobileLayout.viewportWidth);
  expect(mobileLayout.overflowX).toBe("auto");
  expect(mobileLayout.tableWidth).toBeGreaterThan(mobileLayout.viewportTableWidth);
  await page.screenshot({ path: "/tmp/hp-sales-assignment-mobile.png", fullPage: true });
});
