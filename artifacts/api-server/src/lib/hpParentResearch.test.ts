import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { pool } from "@workspace/db";
import { parentResearchName, resolveHpResearchSubject } from "./hpParentResearch";
import { loadHpMonitoringContext } from "./hpMonitoringContext";
import { processRunAccount } from "../intentResearchRunner";
import { fetchPerplexityEvents } from "./intentProviders";
import { monitoringHistory } from "./monitoringHistory";

vi.mock("./intentProviders", async importOriginal => ({
  ...await importOriginal<typeof import("./intentProviders")>(),
  fetchPerplexityEvents: vi.fn(async () => ({
    rows: [{ eventType: "branch_opening", occurredAt: new Date().toISOString(),
      sourceUrl: "https://example.com/northstar-india", excerpt: "Northstar Manufacturing announced a new office in Hyderabad, India.",
      confidence: 80, context: { country: "India" } }],
    stats: { requests: 1, pages: 1, retries: 0, rateLimited: 0, recordsFetched: 1, recordsNormalized: 1 },
  })),
}));
vi.mock("./researchEvidenceAutoReview", () => ({
  autoReviewPendingResearch: vi.fn(async () => ({ reviewed: 0, approved: 0, rejected: 0, pending: 1 })),
}));
vi.mock("./researchOpportunityInterpreter", async importOriginal => ({
  ...await importOriginal<typeof import("./researchOpportunityInterpreter")>(),
  refreshStoredResearchOpportunity: vi.fn(async () => null),
}));

const tenant = 1927634011;
let client: number, first: number, second: number, other: number, runId: number;
beforeAll(async () => {
  await pool.query("DELETE FROM clients WHERE tenant_id=$1", [tenant]);
  client = (await pool.query("INSERT INTO clients(tenant_id,name) VALUES($1,'HP') RETURNING id", [tenant])).rows[0].id;
  for (const name of ["Member One India", "Member Two India", "Unassigned India"]) {
    const id = (await pool.query("INSERT INTO companies(tenant_id,client_id,name) VALUES($1,$2,$3) RETURNING id",
      [tenant, client, name])).rows[0].id;
    if (!first) first = id; else if (!second) second = id; else other = id;
  }
  for (const id of [first, second]) await pool.query(`INSERT INTO hp_account_profiles
    (tenant_id,client_id,company_id,parent_key,parent_name,provenance) VALUES($1,$2,$3,'hp-top:test-parent','Northstar Manufacturing - WW','{}'::jsonb)`,
    [tenant, client, id]);
  runId = (await pool.query(`INSERT INTO intent_research_runs(tenant_id,client_id,provider,status,summary,idempotency_key)
    VALUES($1,$2,'perplexity','running',$3,'monitoring-activation:3:parent-test:9:perplexity-warm') RETURNING id`,
    [tenant, client, { request: { country: "India" } }])).rows[0].id;
  await pool.query(`INSERT INTO intent_research_run_accounts(tenant_id,run_id,account_id,status,attempts,started_at)
    SELECT $1,$2,id,'running',1,NOW() FROM unnest($3::int[]) id`, [tenant, runId, [first, second]]);
});
afterAll(async () => {
  for (const table of ["intent_evidence", "intent_research_run_accounts", "intent_research_runs",
    "hp_parent_research_accounts", "hp_account_profiles", "companies",
    "intent_entity_scores", "intent_signal_types", "intent_tiers", "intent_products",
    "intent_product_subcategories", "intent_product_categories", "clients"]) {
    await pool.query(`DELETE FROM ${table} WHERE tenant_id=$1`, [tenant]);
  }
});

describe("HP parent-first research", () => {
  it("uses stable roster hierarchy, creates no extra roster member and never copies a member domain", async () => {
    expect(parentResearchName("3M COMPANY - WW")).toBe("3M COMPANY");
    const [a, b] = await Promise.all([resolveHpResearchSubject(tenant, first), resolveHpResearchSubject(tenant, second)]);
    expect(a.accountId).toBe(b.accountId);
    expect(a.accountId).not.toBe(first);
    expect(a.scope).toBe("parent");
    expect(a.accountName).toBe("Northstar Manufacturing");
    expect((await pool.query("SELECT domain FROM companies WHERE id=$1", [a.accountId])).rows[0].domain).toBeNull();
    expect((await pool.query("SELECT count(*)::int AS n FROM hp_account_profiles WHERE tenant_id=$1", [tenant])).rows[0].n).toBe(2);
    expect((await resolveHpResearchSubject(tenant, other)).scope).toBe("member");
    expect((await resolveHpResearchSubject(tenant, a.accountId)).scope).toBe("parent");
    await expect(resolveHpResearchSubject(tenant + 1, first)).rejects.toThrow();
  });
  it("researches the parent only once for siblings and keeps ownership, country, history and qualification separate", async () => {
    const old = (await pool.query(`INSERT INTO intent_evidence(tenant_id,account_id,evidence_kind,provider,excerpt,source_url,event_type)
      VALUES($1,$2,'public_event','manual','Member One India announces a Hyderabad office in India.','https://example.com/member','branch_opening')
      RETURNING id`, [tenant, first])).rows[0].id;
    const accounts = (await pool.query("SELECT id,account_id,attempts FROM intent_research_run_accounts WHERE tenant_id=$1 ORDER BY id", [tenant])).rows;
    const run = { id: runId, tenant_id: tenant, client_id: client, audience_id: null, provider: "perplexity" as const,
      request_count: 0, confirmed_request_count: 0, request_limit: 20, summary: { request: { country: "India" } } };
    await Promise.all(accounts.map(account => processRunAccount(run, account)));
    expect(fetchPerplexityEvents).toHaveBeenCalledTimes(1);
    const subject = await resolveHpResearchSubject(tenant, first);
    expect(vi.mocked(fetchPerplexityEvents).mock.calls[0][1]).toMatchObject({ country: "India", accountIds: [subject.accountId] });
    const evidence = (await pool.query("SELECT account_id,context FROM intent_evidence WHERE tenant_id=$1", [tenant])).rows;
    expect(evidence).toHaveLength(2);
    expect(evidence.find(row => row.account_id === subject.accountId)?.context.researchSubject.scope).toBe("parent");
    expect((await pool.query("SELECT account_id FROM intent_evidence WHERE id=$1", [old])).rows[0].account_id).toBe(first);
    const completed = (await pool.query("SELECT status,summary FROM intent_research_run_accounts WHERE tenant_id=$1", [tenant])).rows;
    expect(completed.every(row => row.status === "completed")).toBe(true);
    expect(completed.filter(row => row.summary.reusedParentCheck)).toHaveLength(1);
    expect((await pool.query("SELECT last_researched_at FROM companies WHERE id=$1", [first])).rows[0].last_researched_at).toBeNull();
    expect((await pool.query("SELECT last_researched_at FROM companies WHERE id=$1", [subject.accountId])).rows[0].last_researched_at).toBeTruthy();
    expect((await pool.query("SELECT id FROM intent_inbound_submissions WHERE tenant_id=$1", [tenant])).rows).toEqual([]);
    const context = await loadHpMonitoringContext(tenant, client, [first, second]);
    expect(context[0]).toMatchObject({ accountId: subject.accountId, researchScope: "parent" });
    expect(context[0].memberAccountIds).toEqual(expect.arrayContaining([first, second]));
    expect(context[0].lastCheckedAt).toBeTruthy();
    expect(context.find(row => row.accountId === first)?.researchScope).toBe("member");
    const accomplishment = await monitoringHistory(tenant, 1);
    expect(accomplishment.totalCompletedAccounts).toBe(1);
    expect(accomplishment.totalCompletedChecks).toBe(1);
  });
});
