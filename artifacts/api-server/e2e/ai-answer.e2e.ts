import { mkdir } from "node:fs/promises";
import { pool } from "@workspace/db";
import { test, expect } from "./fixtures/hp-crm";

const root = process.env.HP_CRM_E2E_URL || "http://localhost:80";
const question = "Show me all people from North India who are from IT function and have shown interest in HP Poly products.";
const emptyPlan = { mode: "people", groups: [{ regions: ["west"], functions: ["IT"], products: ["HP Poly"], interest: "any" }],
  interpretation: "West India, IT, HP Poly interest", unsupported: [] };
const clarifyPlan = { mode: "people", groups: [{}], interpretation: "Clarification required",
  unsupported: ["Exporting contacts is not supported."] };

test("protected AI Answer first-party search, paging, clearing and recovery", async ({ page, hp }) => {
  test.setTimeout(240_000);
  page.setDefaultTimeout(10_000);
  const company = hp.companyId;
  const extraClient = Number((await pool.query("INSERT INTO clients(tenant_id,name) VALUES($1,'Secondary fixture') RETURNING id", [hp.tenantId])).rows[0].id);
  const hits: number[] = [];
  for (let i = 0; i < 30; i++) {
    const id = Number((await pool.query(`INSERT INTO contacts(tenant_id,client_id,company_id,first_name,last_name,email,"function",state,country,intent_score,dnc)
      VALUES($1,$2,$3,$4,'Synthetic',$5,'IT','Delhi','India',$6,$7) RETURNING id`,
    [hp.tenantId, hp.clientId, company, `North${String(i).padStart(2,"0")}`, `north${i}@fixture.invalid`, 31 + i, i === 0])).rows[0].id);
    hits.push(id);
    if (i % 2 === 0) await pool.query(`INSERT INTO intent_inbound_submissions(tenant_id,client_id,account_id,contact_id,drive_file_id,row_key,file_name,classification,classification_reason,product_interest,submitted_at)
      VALUES($1,$2,$3,$4,$5,$5,'synthetic','warm','test','HP Poly','2026-01-02')`, [hp.tenantId,hp.clientId,company,id,`synthetic-${i}`]);
    else await pool.query(`INSERT INTO hp_bi_records(tenant_id,client_id,account_id,contact_id,kind,occurred_at,product,source,source_key)
      VALUES($1,$2,$3,$4,'content','2026-01-02','HP Poly','fixture',$5)`, [hp.tenantId,hp.clientId,company,id,`synthetic-${i}`]);
  }
  const exclude = async (name: string, fn: string | null, state: string | null, evidence: boolean) => {
    const id = Number((await pool.query(`INSERT INTO contacts(tenant_id,client_id,company_id,first_name,email,"function",state,country)
      VALUES($1,$2,$3,$4,$5,$6,$7,'India') RETURNING id`, [hp.tenantId,hp.clientId,company,name,`${name}@fixture.invalid`,fn,state])).rows[0].id);
    if (evidence) await pool.query(`INSERT INTO hp_bi_records(tenant_id,client_id,account_id,contact_id,kind,occurred_at,product,source,source_key)
      VALUES($1,$2,$3,$4,'content','2026-01-02','HP Poly','fixture',$5)`, [hp.tenantId,hp.clientId,company,id,`exclude-${name}`]);
  };
  await exclude("NorthSales", "Sales", "Delhi", true);
  await exclude("SouthIT", "IT", "Karnataka", true);
  await exclude("NorthNoEvidence", "IT", "Delhi", false);
  await exclude("MissingLocation", "IT", null, true);

  const errors: string[] = [];
  page.on("pageerror", e => errors.push(e.message));
  page.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
  const apiRequests: { body: any; started: number }[] = [];
  page.on("request", req => { if (new URL(req.url()).pathname === "/api/ai-answer" && req.method() === "POST") {
    try { apiRequests.push({ body: req.postDataJSON(), started: Date.now() }); } catch {}
  } });
  await page.goto(root);
  await page.getByRole("button", { name: "AI Answer", exact: true }).click();
  await expect(page.getByTestId("page-ai-answer")).toBeVisible();
  await page.getByTestId("select-client").click();
  await page.getByRole("option", { name: "HP", exact: true }).click();
  await page.getByTestId("input-question").fill(question);
  const t0 = Date.now();
  await page.getByTestId("button-ask").click();
  await expect(page.getByTestId("text-total")).toHaveText("30", { timeout: 90_000 });
  const elapsed = Date.now() - t0;
  const group = page.getByTestId("group-0");
  await expect(group).toContainText("Region: north");
  await expect(group).toContainText("Function: IT");
  await expect(group).toContainText("Product (any of): HP Poly");
  await expect(group).toContainText("AND");
  await expect(page.getByTestId(`badge-dnc-${hits[0]}`)).toBeVisible();
  await expect(page.getByTestId(`evidence-${hits[0]}-0`)).toContainText("Stated interest");
  await expect(page.getByTestId(`evidence-${hits[1]}-0`)).toContainText("Observed engagement");
  await expect(page.getByTestId(`text-score-${hits[0]}`)).toContainText("Global score 31");
  await expect(page.getByTestId("text-note-3")).toContainText("global contact scores");
  await expect(page.getByTestId("text-page-info")).toContainText("Page 1 of 2");
  await mkdir("test-results/ai-answer", { recursive: true });
  await page.getByTestId("text-total").scrollIntoViewIfNeeded();
  await page.screenshot({ path: "test-results/ai-answer/answered-desktop.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByTestId("text-total").scrollIntoViewIfNeeded();
  const mobileOverflow = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, viewport: innerWidth }));
  expect(mobileOverflow.width).toBeLessThanOrEqual(mobileOverflow.viewport + 1);
  await page.screenshot({ path: "test-results/ai-answer/answered-mobile.png", fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  const firstCall = apiRequests[0]?.body;
  const pageOneIds = await page.locator('[data-testid^="card-person-"]').evaluateAll(nodes =>
    nodes.map(n => n.getAttribute("data-testid")));
  expect(firstCall?.question).toBe(question);
  expect(firstCall?.plan).toBeUndefined();
  expect(firstCall?.clientId).toBe(hp.clientId);
  await page.getByTestId("button-next-page").click();
  await expect(page.getByTestId("text-page-info")).toContainText("Page 2 of 2");
  expect(apiRequests[1]?.body?.plan).toBeTruthy();
  expect(apiRequests[1]?.body?.plan?.groups?.[0]?.functions).toContain("IT");
  expect(apiRequests[1]?.body?.plan?.groups?.[0]?.regions).toContain("north");
  expect(apiRequests[1]?.body?.plan?.groups?.[0]?.interest).toBe("any");
  expect(apiRequests[1]?.body?.question).toBe(question);
  expect(await page.locator('[data-testid^="card-person-"]').count()).toBe(5);
  const pageTwoIds = await page.locator('[data-testid^="card-person-"]').evaluateAll(nodes =>
    nodes.map(n => n.getAttribute("data-testid")));
  expect(pageTwoIds.some(id => pageOneIds.includes(id))).toBe(false);

  await page.getByTestId("select-client").click();
  await page.getByRole("option", { name: "Secondary fixture", exact: true }).click();
  await expect(page.getByTestId("section-result")).toHaveCount(0);
  await page.getByTestId("input-question").fill("Find IT people in Maharashtra with HP Poly interest");
  await page.route("**/api/ai-answer", async route => {
    const body = route.request().postDataJSON();
    await route.fallback({ postData: JSON.stringify({ ...body, plan: emptyPlan }) });
  });
  await page.getByTestId("button-ask").click();
  await expect(page.getByTestId("state-empty")).toBeVisible();
  await page.unroute("**/api/ai-answer");

  await page.getByTestId("input-question").fill("Export all matching contacts");
  await expect(page.getByTestId("section-result")).toHaveCount(0);
  await page.route("**/api/ai-answer", async route => {
    const body = route.request().postDataJSON();
    await route.fallback({ postData: JSON.stringify({ ...body, plan: clarifyPlan }) });
  });
  await page.getByTestId("button-ask").click();
  await expect(page.getByTestId("state-clarification")).toBeVisible();
  await page.unroute("**/api/ai-answer");

  await page.getByTestId("input-question").fill("Search retry test with a supported request");
  let failed = false;
  await page.route("**/api/ai-answer", async route => {
    if (!failed) { failed = true; await route.fulfill({ status: 502, contentType: "application/json", body: JSON.stringify({ error: "deliberate test outage" }) }); return; }
    const body = route.request().postDataJSON();
    await route.fallback({ postData: JSON.stringify({ ...body, plan: { ...emptyPlan, interpretation: "Retry returned a live empty database result" } }) });
  });
  await page.getByTestId("button-ask").click();
  await expect(page.getByTestId("state-error")).toBeVisible();
  await expect(page.getByTestId("button-retry")).toBeVisible();
  await page.getByTestId("button-retry").click();
  await expect(page.getByTestId("state-empty")).toBeVisible();
  await page.unroute("**/api/ai-answer");
  await page.getByTestId("button-reset").click();
  await expect(page.getByTestId("section-result")).toHaveCount(0);
  console.log(JSON.stringify({ expectedMatches: 30, firstResponseMs: elapsed, apiCalls: apiRequests.length,
    firstPlanOmitted: firstCall?.plan === undefined, pagingPlanPresent: !!apiRequests[1]?.body?.plan,
    consoleErrors: errors, mobileOverflow }));
  expect(errors.filter(e => !e.includes("501 (Not Implemented)") && !e.includes("502 (Bad Gateway)"))).toEqual([]);
  expect(errors.filter(e => e.includes("502 (Bad Gateway)"))).toHaveLength(1);
});
