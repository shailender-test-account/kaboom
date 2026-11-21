import { test, expect } from "./fixtures/hp-crm";

const root = process.env.HP_CRM_E2E_URL || "http://localhost:80";

test("Journeys client filter uses the full client registry and intersects with other filters", async ({ page, hp }) => {
  test.setTimeout(60_000);
  const hpNewClientId = hp.clientId + 800_000;
  const emptyClientId = hp.clientId + 800_001;
  const clients = [
    { id: hp.clientId, name: "HP" },
    { id: hpNewClientId, name: "HP New" },
    { id: emptyClientId, name: "HP Empty" },
  ];
  const journeys = [
    { id: 980_001, name: "HDFC", slug: "hdfc", description: null, status: "draft",
      clientId: hp.clientId, clientName: "HP", clientLogoUrl: null, pageCount: 1, totalViews: 0,
      createdAt: "2025-01-01T00:00:00.000Z", linkedPlays: [], linkedPlaysCount: 0 },
    { id: 980_002, name: "The Future of Work", slug: "the-future-of-work", description: null, status: "published",
      clientId: hpNewClientId, clientName: "HP New", clientLogoUrl: null, pageCount: 2, totalViews: 7,
      createdAt: "2025-02-01T00:00:00.000Z", linkedPlays: [], linkedPlaysCount: 0 },
  ];
  // The fixture's private API does not mount the journeys router. Stub only the
  // two read-only registry/list GETs with isolated fixture records.
  await page.route("**/api/clients", route => route.request().method() === "GET"
    ? route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(clients) })
    : route.continue());
  await page.route("**/api/journeys", route => route.request().method() === "GET"
    ? route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(journeys) })
    : route.continue());
  const writes: string[] = [];
  page.on("request", request => {
    if (/\/api\/journeys(?:\/|$)/.test(new URL(request.url()).pathname) && request.method() !== "GET")
      writes.push(`${request.method()} ${new URL(request.url()).pathname}`);
  });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${root}/journeys`);
  await expect(page.getByRole("heading", { name: "Journeys" })).toBeVisible();
  await expect(page.getByRole("row", { name: /HDFC.*HP.*Draft/ })).toBeVisible();
  await expect(page.getByRole("row", { name: /The Future of Work.*HP New.*Published/ })).toBeVisible();

  const clientFilter = page.getByRole("combobox", { name: "Filter by client" });
  await clientFilter.click();
  await expect(page.getByRole("option", { name: "HP", exact: true })).toBeVisible();
  await expect(page.getByRole("option", { name: "HP New", exact: true })).toBeVisible();
  await expect(page.getByRole("option", { name: "HP Empty", exact: true })).toBeVisible();
  await page.getByRole("option", { name: "HP", exact: true }).click();
  await expect(page.getByRole("row", { name: /HDFC.*HP.*Draft/ })).toBeVisible();
  await expect(page.getByRole("row", { name: /The Future of Work/ })).toHaveCount(0);

  await clientFilter.click();
  await page.getByRole("option", { name: "HP New", exact: true }).click();
  await expect(page.getByRole("row", { name: /The Future of Work.*HP New.*Published/ })).toBeVisible();
  await expect(page.getByRole("row", { name: /HDFC/ })).toHaveCount(0);

  await clientFilter.click();
  await page.getByRole("option", { name: "All clients", exact: true }).click();
  await expect(page.getByRole("row", { name: /HDFC.*HP.*Draft/ })).toBeVisible();
  await expect(page.getByRole("row", { name: /The Future of Work.*HP New.*Published/ })).toBeVisible();

  await clientFilter.click();
  await page.getByRole("option", { name: "HP Empty", exact: true }).click();
  await expect(page.getByText("No journeys match your filters for HP Empty")).toBeVisible();
  await expect(page.getByRole("row", { name: /HDFC|The Future of Work/ })).toHaveCount(0);
  await clientFilter.click();
  await page.getByRole("option", { name: "All clients", exact: true }).click();
  await expect(page.getByRole("row", { name: /HDFC.*HP.*Draft/ })).toBeVisible();
  await expect(page.getByRole("row", { name: /The Future of Work.*HP New.*Published/ })).toBeVisible();

  await page.getByRole("combobox", { name: "Filter by status" }).click();
  await page.getByRole("option", { name: "Published", exact: true }).click();
  await page.getByPlaceholder("Search journeys...").fill("The Future of Work");
  await expect(page.getByRole("row", { name: /The Future of Work.*HP New.*Published/ })).toBeVisible();
  await expect(page.getByRole("row", { name: /HDFC/ })).toHaveCount(0);
  await page.getByRole("combobox", { name: "Filter by status" }).click();
  await page.getByRole("option", { name: "All statuses", exact: true }).click();
  await page.getByPlaceholder("Search journeys...").fill("");

  await page.screenshot({ path: "/tmp/journey-client-filter-desktop.png" });
  await page.setViewportSize({ width: 402, height: 874 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: "/tmp/journey-client-filter-mobile.png" });
  expect(writes).toEqual([]);
});
