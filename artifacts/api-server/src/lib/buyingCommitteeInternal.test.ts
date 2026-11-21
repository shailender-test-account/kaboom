import { afterEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { pool } from "@workspace/db";
import { seedHpCrmAccounts, cleanHpCrmTenant } from "./testFixtures/hpCrm";
import { approveCommitteePlan, saveCommitteePlan } from "./buyingCommittee";
import { sourceCommitteeAccount } from "./buyingCommitteeApollo";
import { readCommitteeContacts } from "./buyingCommitteeContacts";
import { findInternalCommitteeContacts } from "./buyingCommitteeInternal";

afterEach(() => vi.unstubAllGlobals());

async function fixture(run: (f: {
  tenantId: number; clientId: number; companyId: number; siblingId: number;
  contact: (title: string, country: string | null, companyId?: number) => Promise<number>;
  plan: () => Promise<any>;
}) => Promise<void>) {
  const tenantId = Number((await pool.query("INSERT INTO tenants(name,slug) VALUES('Committee internal fixture',$1) RETURNING id", [randomUUID()])).rows[0].id);
  try {
    const clientId = Number((await pool.query("INSERT INTO clients(tenant_id,name) VALUES($1,'HP') RETURNING id", [tenantId])).rows[0].id);
    const hp = await seedHpCrmAccounts(tenantId, clientId);
    const contact = async (title: string, country: string | null, companyId = hp.companyId) =>
      Number((await pool.query(`INSERT INTO contacts(tenant_id,client_id,company_id,first_name,email,title,country)
        VALUES($1,$2,$3,'Internal Person',$4,$5,$6) RETURNING id`,
      [tenantId, clientId, companyId, `${randomUUID()}@samplecorp.com`, title, country])).rows[0].id);
    const plan = async () => {
      const draft = await saveCommitteePlan(tenantId, 1, { clientId, name: "Internal first", country: "India",
        includeRoster: true, audienceIds: [], accountIds: [hp.companyId], categories: ["Security"],
        designations: ["Chief Information Security Officer"], limitPerAccount: 3,
        domains: { [hp.companyId]: "samplecorp.com" } });
      return approveCommitteePlan(tenantId, 1, draft.plan.id, draft.plan.revision);
    };
    await run({ tenantId, clientId, companyId: hp.companyId, siblingId: hp.siblingId, contact, plan });
  } finally {
    await pool.query("DELETE FROM buying_committee_plans WHERE tenant_id=$1", [tenantId]);
    await pool.query("DELETE FROM tenant_integrations WHERE tenant_id=$1", [tenantId]);
    await cleanHpCrmTenant(tenantId);
  }
}

it("uses internal contacts without provider setup, top-up, duplicate CRM people or false engagement", async () => {
  await fixture(async f => {
    const existing = await f.contact("CISO", "IN");
    const engaged = await f.contact("Global Chief Information Security Officer", "India");
    await pool.query(`INSERT INTO activity_events(tenant_id,client_id,company_id,contact_id,event_type,is_bot,description)
      VALUES($1,$2,$3,$4,'email_reply',false,'Internal committee engagement fixture')`, [f.tenantId, f.clientId, f.companyId, engaged]);
    const draft = await f.plan(); // Approval remains possible without an external provider.
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const before = Number((await pool.query("SELECT count(*) n FROM contacts WHERE tenant_id=$1", [f.tenantId])).rows[0].n);
    // Exhausting the external budget must not prevent free internal matching.
    await pool.query("UPDATE buying_committee_targets SET requests=20 WHERE tenant_id=$1 AND plan_id=$2", [f.tenantId, draft.plan.id]);
    await sourceCommitteeAccount(f.tenantId, draft.plan.id, f.companyId, false);
    expect(fetch).not.toHaveBeenCalled();
    const target = (await pool.query("SELECT status,found,requests,responses FROM buying_committee_targets WHERE plan_id=$1", [draft.plan.id])).rows[0];
    expect(target).toMatchObject({ status: "completed", found: 2, requests: 20, responses: 0 });
    const result = await readCommitteeContacts(f.tenantId, f.clientId, [f.companyId], 1, 100, "India");
    expect(result.items.find(p => p.crmContactId === existing)).toMatchObject({ source: "Internal database", engaged: false, categories: ["Security"] });
    expect(result.items.find(p => p.crmContactId === engaged)).toMatchObject({ source: "Internal database", engaged: true, engagementSources: ["Email interaction"] });
    expect(result.items.filter(p => p.crmContactId === engaged)).toHaveLength(1);
    expect(Number((await pool.query("SELECT count(*) n FROM contacts WHERE tenant_id=$1", [f.tenantId])).rows[0].n)).toBe(before);
    await sourceCommitteeAccount(f.tenantId, draft.plan.id, f.companyId, false);
    expect(fetch).not.toHaveBeenCalled();
    await pool.query("UPDATE contacts SET first_name='Corrected name' WHERE id=$1", [existing]);
    const corrected = await readCommitteeContacts(f.tenantId, f.clientId, [f.companyId], 1, 100);
    expect(corrected.items.find(p => p.crmContactId === existing)?.name).toContain("Corrected name");
    await pool.query("DELETE FROM contacts WHERE id=$1", [existing]);
    expect((await readCommitteeContacts(f.tenantId, f.clientId, [f.companyId], 1, 100)).items.some(p => p.crmContactId === existing)).toBe(false);
  });
});

it("keeps exact legal-account, tenant, title and person-country scope; falls back only on zero matches", async () => {
  await fixture(async f => {
    await f.contact("CISO", "United States");
    await f.contact("CISO", null);
    await f.contact("Sales Manager", "India");
    await f.contact("CISO", "India", f.siblingId);
    expect(await findInternalCommitteeContacts(f.tenantId, f.clientId, f.companyId, "India", ["Chief Information Security Officer"], 3)).toEqual([]);
    expect(await findInternalCommitteeContacts(f.tenantId + 100000, f.clientId, f.companyId, "India", ["Chief Information Security Officer"], 3)).toEqual([]);
    await pool.query("INSERT INTO tenant_integrations(tenant_id,provider,config) VALUES($1,'apollo',$2::jsonb)",
      [f.tenantId, JSON.stringify({ apiKey: "test-only-key", enabled: true, maxRequestsPerRun: 20 })]);
    const approved = await f.plan();
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ people: [{ id: "fallback-person" }] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ matches: [{ id: "fallback-person", name: "Fallback Person",
        title: "CISO", email: "fallback@samplecorp.com", country: "India", organization: { primary_domain: "samplecorp.com" } }] })));
    vi.stubGlobal("fetch", fetch);
    await sourceCommitteeAccount(f.tenantId, approved.plan.id, f.companyId, false);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect((await pool.query("SELECT requests,found FROM buying_committee_targets WHERE plan_id=$1", [approved.plan.id])).rows[0])
      .toMatchObject({ requests: 2, found: 1 });
    expect((await readCommitteeContacts(f.tenantId, f.clientId, [f.companyId], 1, 100)).items.some(p => p.name === "Fallback Person")).toBe(true);
  });
});

it("requires explicit approval and does not hide missing-provider failures", async () => {
  await fixture(async f => {
    const approved = await f.plan(), fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    await expect(sourceCommitteeAccount(f.tenantId, approved.plan.id, f.companyId, false)).rejects.toMatchObject({ status: 409 });
    expect(fetch).not.toHaveBeenCalled();
    const target = (await pool.query("SELECT status,requests,error FROM buying_committee_targets WHERE plan_id=$1", [approved.plan.id])).rows[0];
    expect(target).toMatchObject({ status: "failed", requests: 0 });
    expect(target.error).toContain("No matching internal contacts");
    await f.contact("CISO", "India");
    await expect(sourceCommitteeAccount(f.tenantId, approved.plan.id, f.companyId, false)).rejects.toMatchObject({ status: 409 });
    await sourceCommitteeAccount(f.tenantId, approved.plan.id, f.companyId, true);
    expect((await pool.query("SELECT status,found FROM buying_committee_targets WHERE plan_id=$1", [approved.plan.id])).rows[0])
      .toMatchObject({ status: "completed", found: 1 });
    expect(fetch).not.toHaveBeenCalled();
  });
});
