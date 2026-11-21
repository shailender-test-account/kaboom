import { test, expect, root, accounts, identity, analysis, evidence, research, type Section } from "./fixtures/intent-detail";

const [alpha, beta] = accounts;
const sections: Section[] = ["identity", "evidence", "analysis", "research"];
const namedScope = "client=21&audience=31&product=41&categoryName=Security";
const legacyScope = "client=21&audience=31&product=41&categories=51&subcategories=61";

test("parent-owned research fills news and interpretation on parent and member account drilldowns", async ({ page, detail }) => {
  const news = "Alpha fixture account announced a new India delivery office in Hyderabad.";
  const source = { id: 89000, summary: news, sourceUrl: "https://alpha.example.invalid/news/india-office",
    occurredAt: "2026-11-03T00:00:00Z", publishedAt: "2026-11-03T00:00:00Z" };
  const researchContext = { kind: "business_context", label: "Business context", summary: news,
    evidence: [source], businessDirections: [{ theme: "Infrastructure & footprint", signal: "India delivery office",
      direction: "Validate local capacity build-out and deployment timing.", evidenceIds: [source.id] }],
    takeaways: [{ category: "IT Hardware", product: "HP business PCs", takeaway: "Possible device needs only if net-new roles require endpoints.",
      recommendation: "Confirm the India owner, actual seats and timing.", pitch: "Could phased HP deployment support the confirmed office plan?",
      evidenceIds: [source.id] }], possibleNeeds: [], nextAction: "Validate", caution: "Not declared buying intent" };
  const parent = { accountId: alpha.id, accountName: alpha.name, analysisAccountId: alpha.id,
    researchScope: "parent", memberAccountIds: [beta.id], lastCheckedAt: "2026-11-03T04:19:34Z",
    runStatus: "completed", findings: [], sourceEvidence: [source] };
  for (const item of [alpha, beta]) {
    detail.reply(item.id, "identity", identity(item));
    detail.reply(item.id, "analysis", analysis(item.id));
    detail.reply(item.id, "evidence", evidence(item.id));
    detail.reply(item.id, "research", { ...research, parentMonitoringContext: [parent] });
  }
  const reads: string[] = [];
  let retainedMemberMode = false;
  await page.route("**/api/intent/opportunities/monitored-accounts?**", async route => {
    const url = new URL(route.request().url());
    reads.push(url.search);
    const matchId = retainedMemberMode ? beta.id : alpha.id;
    await route.fulfill({ json: { items: url.searchParams.get("accountId") === String(matchId)
      ? [{ id: matchId, name: retainedMemberMode ? beta.name : alpha.name, latestRunStatus: "completed", researchContext }] : [],
      total: 1, page: 1, pageSize: 5 } });
  });
  for (const item of [alpha, beta]) {
    await page.goto(`${root}/intent/accounts/${item.id}?clientId=21`);
    await expect(page.getByRole("heading", { name: item.name, exact: true })).toBeVisible();
    await expect(page.getByRole("article", { name: "Key News" })).toContainText(news);
    await expect(page.getByRole("article", { name: "Key Interpretation of News" })).toContainText("Validate local capacity");
    // The current account summary intentionally shows only news and
    // interpretation; detailed source analysis remains below, not a third card.
    await expect(page.getByRole("article", { name: "Potential HP Product Fit" })).toHaveCount(0);
    await expect(page.getByText("Parent research pending.", { exact: false })).toHaveCount(0);
    await expect(page.getByText("No recent, validated account-specific news is available.", { exact: true })).toHaveCount(0);
    await page.getByRole("link", { name: "Read excerpt [1]" }).click();
    await expect(page.locator(`#research-source-${source.id}`)).toBeInViewport();
    await expect(page.getByRole("link", { name: "Open original source", exact: true })).toHaveAttribute("href", source.sourceUrl);
  }
  retainedMemberMode = true;
  detail.reply(alpha.id, "research", { ...research, parentMonitoringContext: [{...parent,sourceEvidence:[]}],
    memberMonitoringContext: [{...parent,accountId:beta.id,analysisAccountId:beta.id,accountName:beta.name,researchScope:"member",sourceEvidence:[source]}] });
  await page.goto(`${root}/intent/accounts/${alpha.id}?clientId=21`);
  await expect(page.getByText(`Retained member-company research: ${beta.name}. These sources have not been reassigned to the parent.`, {exact:true})).toBeVisible();
  await expect(page.getByRole("article", { name: "Key News" })).toContainText(news);
  await expect(page.getByRole("heading", {name:`Actual news excerpts & source links · ${beta.name}`,exact:true})).toHaveCount(1);
  await expect(page.getByText("Parent check completed, but no usable parent-company news survived source validation.", {exact:false})).toBeVisible();
  expect(reads.every(query => new URLSearchParams(query).get("completeResearch") === "false")).toBe(true);
  expect(detail.writes).toEqual([]);
});

for (const scope of [namedScope, legacyScope]) {
  test(`signed-in Command Center name opens progressively and retries only evidence (${scope.includes("categoryName") ? "named" : "catalog"} scope)`, async ({ page, detail }) => {
    test.setTimeout(90_000);
    const identityGate = detail.hold(alpha.id, "identity");
    const evidenceGate = detail.hold(alpha.id, "evidence");
    const researchGate = detail.hold(alpha.id, "research");
    const analysisGate = detail.hold(alpha.id, "analysis");
    // Both automatic attempts fail; a manual retry will use a new reply.
    detail.reply(alpha.id, "evidence", { error: "Fixture evidence unavailable" }, 503);
    await page.goto(`${root}/intent?${scope}`);
    await expect(page.getByRole("heading", { name: "Good morning, Browser." })).toBeVisible();
    const name = page.getByRole("link", { name: alpha.name, exact: true });
    await expect(name).toHaveAttribute("href", `/intent/accounts/${alpha.id}?${scope}`);
    await name.click();
    await expect(page).toHaveURL(`${root}/intent/accounts/${alpha.id}?${scope}`);
    await expect(page.getByText("Loading account identity…")).toBeVisible();
    expect(detail.count(alpha.id, "evidence")).toBe(0);
    identityGate.release(identity(alpha));
    await expect(page.getByRole("heading", { name: alpha.name, exact: true })).toBeVisible();
    const back = page.getByRole("link", { name: "Command Center", exact: true });
    await expect(back).toHaveAttribute("href", `/intent/accounts?${scope}`);
    await expect(page.getByText("Loading supporting evidence…")).toBeVisible();
    await expect(page.getByText("Loading qualification…")).toBeVisible();
    await expect(page.getByText("Loading research brief…")).toBeVisible();
    await expect(page.getByText("No raw evidence records", { exact: false })).toHaveCount(0);
    await expect(page.getByText("No confirmed buying-intent driver", { exact: false })).toHaveCount(0);

    analysisGate.release(analysis(alpha.id));
    await expect(page.getByText(`Qualification for ${alpha.id}`, { exact: true })).toBeVisible();
    // Research stays pending through the failure and retry of evidence.
    evidenceGate.release({ error: "Fixture evidence unavailable" }, 503);
    const retry = page.getByRole("button", { name: "Retry supporting evidence" });
    await expect(retry).toBeVisible();
    await expect(page.getByRole("heading", { name: alpha.name, exact: true })).toBeVisible();
    const before = Object.fromEntries(sections.map(section => [section, detail.count(alpha.id, section)]));
    expect(before.evidence).toBe(2);
    detail.reply(alpha.id, "evidence", evidence(alpha.id));
    await retry.click();
    await expect(retry).toHaveCount(0);
    await expect(page.getByText(`Evidence for ${alpha.id}`, { exact: true }).first()).toBeVisible();
    for (const section of sections) {
      expect(detail.count(alpha.id, section), `Only evidence should refetch, not ${section}`)
        .toBe(before[section] + (section === "evidence" ? 1 : 0));
    }
    await expect(page.getByTitle(`Open Buyer ${alpha.id}`)).toHaveAttribute("href", `/intent/contacts/${alpha.id + 10}?${scope}`);
    await expect(page.getByText("Loading research brief…")).toBeVisible();
    researchGate.release(research);
    await expect(page.getByText("Loading research brief…")).toHaveCount(0);
    await expect(page.getByText(`Qualification for ${alpha.id}`, { exact: true })).toBeVisible();

    // Assert the actual network contract, not just the visible scope labels.
    const panels = detail.reads.filter(read => read.section);
    expect(new Set(panels.map(read => read.section))).toEqual(new Set(sections));
    const listRead = detail.reads.find(read => read.path === "/api/intent/accounts")!;
    expect(listRead.query).toMatchObject({ clientId: "21", audienceId: "31" });
    if (scope.includes("categoryName")) expect(listRead.query.categoryName).toBe("Security");
    else expect(listRead.query.categoryIds).toBe("51");
    for (const read of panels) {
      expect(read.query).toMatchObject({ clientId: "21", audienceId: "31", productId: "41" });
      if (scope.includes("categoryName")) expect(read.query.categoryName).toBe("Security");
      else expect(read.query).toMatchObject({ categoryIds: "51", subcategoryIds: "61" });
    }
    await back.click();
    await expect(page).toHaveURL(`${root}/intent/accounts?${scope}`);
    await expect(page.getByText(alpha.name, { exact: true })).toBeVisible();
  });
}

test("rapid account switching never renders late Alpha panels under Beta identity", async ({ page, detail }) => {
  test.setTimeout(90_000);
  detail.reply(alpha.id, "identity", identity(alpha));
  const late = {
    evidence: detail.hold(alpha.id, "evidence"),
    analysis: detail.hold(alpha.id, "analysis"),
    research: detail.hold(alpha.id, "research"),
  };
  const betaIdentity = detail.hold(beta.id, "identity");
  const betaPanels = {
    evidence: detail.hold(beta.id, "evidence"),
    analysis: detail.hold(beta.id, "analysis"),
    research: detail.hold(beta.id, "research"),
  };
  await page.goto(`${root}/intent?${namedScope}`);
  await page.getByRole("link", { name: alpha.name, exact: true }).click();
  await expect(page.getByRole("heading", { name: alpha.name, exact: true })).toBeVisible();
  await expect.poll(() => ["evidence", "analysis", "research"].map(section => detail.count(alpha.id, section as Section))).toEqual([1, 1, 1]);
  // Switch detail IDs via Wouter's history integration without a document reload
  // or an intervening unmount to catch placeholder/previous-data leakage too.
  await page.evaluate(url => window.history.pushState({}, "", url), `/intent/accounts/${beta.id}?${namedScope}`);
  await expect(page.getByText("Loading account identity…")).toBeVisible();
  await expect(page.getByRole("heading", { name: alpha.name, exact: true })).toHaveCount(0);
  betaIdentity.release(identity(beta));
  await expect(page.getByRole("heading", { name: beta.name, exact: true })).toBeVisible();
  await expect.poll(() => ["evidence", "analysis", "research"].map(section => detail.count(beta.id, section as Section))).toEqual([1, 1, 1]);
  late.evidence.release(evidence(alpha.id));
  late.analysis.release(analysis(alpha.id));
  late.research.release({ ...research, canonicalResearchIntent: {
    categoryName: "Security", score: 99, tier: "hot", rationale: "Late Alpha research", source: "research_propensity",
  } });
  await expect.poll(() => detail.responded.filter(key => key.startsWith(`${alpha.id}:`)).length).toBe(4);
  // Let React paint after the deliberately late responses; no sleep or SLA.
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(page.getByText(`Evidence for ${alpha.id}`, { exact: true })).toHaveCount(0);
  await expect(page.getByText(`Qualification for ${alpha.id}`, { exact: true })).toHaveCount(0);
  await expect(page.getByText("Late Alpha research", { exact: false })).toHaveCount(0);
  await expect(page.getByTitle(`Open Buyer ${alpha.id}`)).toHaveCount(0);
  await expect(page.getByText("Loading supporting evidence…")).toBeVisible();
  await expect(page.getByText("Loading qualification…")).toBeVisible();
  betaPanels.evidence.release(evidence(beta.id));
  betaPanels.analysis.release(analysis(beta.id));
  betaPanels.research.release(research);
  await expect(page.getByText(`Evidence for ${beta.id}`, { exact: true }).first()).toBeVisible();
  await expect(page.getByText(`Qualification for ${beta.id}`, { exact: true })).toBeVisible();
  await expect(page.getByTitle(`Open Buyer ${beta.id}`)).toBeVisible();
  await expect(page.getByRole("heading", { name: beta.name, exact: true })).toBeVisible();
  await expect(page.getByText(`Evidence for ${alpha.id}`, { exact: true })).toHaveCount(0);
  await expect(page.getByText(`Qualification for ${alpha.id}`, { exact: true })).toHaveCount(0);
});
