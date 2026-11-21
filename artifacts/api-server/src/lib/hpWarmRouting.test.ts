import { beforeAll, afterAll, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { pool } from "@workspace/db";
import { seedHpCrmAccounts, cleanHpCrmTenant } from "./testFixtures/hpCrm";
import { loadHpPriorityEvidence, priorityForAccounts, warmRoutingCandidates } from "./hpAccountPriorityData";
import { loadHpWarmRouting, routeHpWarmBatch, runHpWarmSweep, loadHpWarmClients } from "./hpWarmRouting";
import { loadHpWarmRoutingStatus } from "./hpWarmRoutingStatus";
import { loadHpBi } from "./hpBiMetrics";

let tenantId: number, clientId: number, journeyId: number, ruleId: number, sequenceId: number;
let hp: Awaited<ReturnType<typeof seedHpCrmAccounts>>;
beforeAll(async () => {
  vi.stubEnv("HP_WARM_JOURNEY_ROUTING_ENABLED", "false");
  tenantId = Number((await pool.query("INSERT INTO tenants(name,slug) VALUES('HP priority test',$1) RETURNING id", [randomUUID()])).rows[0].id);
  clientId = Number((await pool.query("INSERT INTO clients(tenant_id,name) VALUES($1,'HP') RETURNING id", [tenantId])).rows[0].id);
  hp = await seedHpCrmAccounts(tenantId, clientId);
  journeyId = Number((await pool.query("INSERT INTO journeys(tenant_id,client_id,name,slug,status) VALUES($1,$2,'Warm device nurture',$3,'published') RETURNING id",
    [tenantId, clientId, randomUUID()])).rows[0].id);
  sequenceId = Number((await pool.query("INSERT INTO email_sequences(tenant_id,client_id,name,status) VALUES($1,$2,'Never send test','active') RETURNING id", [tenantId, clientId])).rows[0].id);
  ruleId = Number((await pool.query(`INSERT INTO intent_inbound_routing_rules(tenant_id,client_id,name,match_type,classification,
    inbound_product_name,journey_id,sequence_id,enabled)
    VALUES($1,$2,'Approved device Warm rule','product','warm','Managed Device Service / Device as a Service',$3,$4,true) RETURNING id`,
  [tenantId, clientId, journeyId, sequenceId])).rows[0].id);
  await pool.query(`INSERT INTO intent_inbound_submissions(tenant_id,client_id,account_id,contact_id,drive_file_id,row_key,file_name,
    form_type,classification,classification_reason,product_interest,purchase_timeframe_months,submitted_at,raw_fields)
    VALUES($1,$2,$3,$4,$5,$5,'priority-test.xlsx','event_feedback','warm','test','HP Device as a Service',6,NOW(),'{"answer":"test"}')`,
  [tenantId, clientId, hp.companyId, hp.contactId, randomUUID()]);
});
afterAll(async () => {
  vi.unstubAllEnvs();
  if (!tenantId) return;
  await pool.query("DELETE FROM journey_contacts WHERE journey_id=$1", [journeyId]);
  await pool.query("DELETE FROM intent_inbound_routing_rules WHERE tenant_id=$1", [tenantId]);
  await pool.query("DELETE FROM email_sequences WHERE tenant_id=$1", [tenantId]);
  await pool.query("DELETE FROM journeys WHERE tenant_id=$1", [tenantId]);
  await cleanHpCrmTenant(tenantId);
});
it("loads actual SQL evidence and exposes weighted scores before filtering/paging", async () => {
  vi.stubEnv("COPIED_DATA_SAFE_MODE", "false");
  const now = new Date();
  const evidence = await loadHpPriorityEvidence(tenantId, clientId, [hp.companyId], now);
  expect(priorityForAccounts(evidence, new Set([hp.companyId]), now)).toMatchObject({ score: 45.5, status: "Warm", forms: 45.5 });
  const report: any = await loadHpBi(tenantId, { clientId, year: 2026, page: 1, pageSize: 1, qualification: "Warm" });
  expect(report.accounts[0].priority).toMatchObject({ score: 45.5, declaredQualification: "Warm", routing: { status: "Ready" } });
});
it("routes once, records evidence and never creates a sequence enrollment", async () => {
  vi.stubEnv("COPIED_DATA_SAFE_MODE", "false");
  expect((await routeHpWarmBatch(tenantId, clientId)).routed).toBe(1);
  expect((await routeHpWarmBatch(tenantId, clientId)).routed).toBe(0);
  expect(Number((await pool.query("SELECT count(*) FROM sequence_enrollments WHERE sequence_id=$1", [sequenceId])).rows[0].count)).toBe(0);
  expect(Number((await pool.query("SELECT count(*) FROM activity_events WHERE tenant_id=$1 AND event_type='hp_warm_routed'", [tenantId])).rows[0].count)).toBe(1);
  const data = await loadHpPriorityEvidence(tenantId, clientId, [hp.companyId]);
  const routing = await loadHpWarmRouting(tenantId, clientId, [hp.companyId]);
  expect(routing.describe(priorityForAccounts(data, new Set([hp.companyId])), data, new Set([hp.companyId]), new Date()).status).toBe("Active");
});
it("preserves safe mode and DNC, rejects disabled mappings and never falls back arbitrarily", async () => {
  await pool.query("DELETE FROM journey_contacts WHERE journey_id=$1", [journeyId]);
  vi.stubEnv("COPIED_DATA_SAFE_MODE", "true");
  expect((await routeHpWarmBatch(tenantId, clientId)).routed).toBe(0);
  vi.stubEnv("COPIED_DATA_SAFE_MODE", "false");
  await pool.query("UPDATE contacts SET dnc=true WHERE id=$1", [hp.contactId]);
  expect((await routeHpWarmBatch(tenantId, clientId)).routed).toBe(0);
  await pool.query("UPDATE contacts SET dnc=false WHERE id=$1", [hp.contactId]);
  await pool.query("UPDATE intent_inbound_routing_rules SET enabled=false WHERE id=$1", [ruleId]);
  expect((await routeHpWarmBatch(tenantId, clientId)).routed).toBe(0);
  await pool.query("UPDATE intent_inbound_routing_rules SET enabled=true WHERE id=$1", [ruleId]);
});
it("does not use inferred research to bypass a respondent's answers or identity review", async () => {
  const now = new Date();
  const data = { forms: [], activities: [{ accountId: 1, contactId: 2, stage: "action", at: now.toISOString() }],
    signals: [{ accountId: 1, heat: "Hot" as const, at: now.toISOString(), url: "https://news.test", products: ["HP Device as a Service"] }],
    respondents: new Set<number>(), blockedContacts: new Set<number>() };
  expect(warmRoutingCandidates(data, new Set([1]), now)).toHaveLength(1);
  data.respondents.add(2);
  expect(warmRoutingCandidates(data, new Set([1]), now)).toHaveLength(0);
  data.respondents.clear(); data.blockedContacts.add(2);
  expect(warmRoutingCandidates(data, new Set([1]), now)).toHaveLength(0);
});
it("allows the explicitly approved journey-only switch without starting sequence outreach", async () => {
  vi.stubEnv("COPIED_DATA_SAFE_MODE", "true");
  vi.stubEnv("HP_WARM_JOURNEY_ROUTING_ENABLED", "true");
  expect((await routeHpWarmBatch(tenantId, clientId)).routed).toBe(1);
  expect(Number((await pool.query("SELECT count(*) FROM sequence_enrollments WHERE sequence_id=$1", [sequenceId])).rows[0].count)).toBe(0);
});
it("persists bounded progress across independent invocations and completes a sweep", async () => {
  vi.stubEnv("COPIED_DATA_SAFE_MODE", "false");
  // Split the fixture's two legal accounts into separate parent groups.
  await pool.query("UPDATE hp_account_profiles SET parent_key=CASE WHEN company_id=$2 THEN 'a' ELSE 'b' END WHERE tenant_id=$1",
    [tenantId, hp.companyId]);
  const first = await runHpWarmSweep(tenantId, clientId, 1);
  expect(first?.cursor).toBe("a");
  let state = (await pool.query("SELECT * FROM hp_warm_sweeps WHERE tenant_id=$1", [tenantId])).rows[0];
  expect(state.last_success_at).toBeInstanceOf(Date);
  expect(state.last_completed_at).toBeNull();
  const second = await runHpWarmSweep(tenantId, clientId, 1);
  expect(second?.checks.map(c => c.parentKey)).toEqual(["b"]);
  expect(second?.cursor).toBe("b");
  expect((await runHpWarmSweep(tenantId, clientId, 1))?.cursor).toBe("");
  state = (await pool.query("SELECT * FROM hp_warm_sweeps WHERE tenant_id=$1", [tenantId])).rows[0];
  expect(state.last_completed_at).toBeInstanceOf(Date);
  expect((await loadHpWarmRoutingStatus(tenantId, clientId, undefined, "")).counts).toMatchObject({ routed: 1, not_eligible: 1 });
});

it("keeps progress and success timestamps unchanged while paused or another process holds the lock", async () => {
  const before = (await pool.query("SELECT * FROM hp_warm_sweeps WHERE tenant_id=$1", [tenantId])).rows[0];
  vi.stubEnv("COPIED_DATA_SAFE_MODE", "true");
  vi.stubEnv("HP_WARM_JOURNEY_ROUTING_ENABLED", "false");
  expect(await runHpWarmSweep(tenantId, clientId)).toBeUndefined();
  expect((await loadHpWarmRoutingStatus(tenantId, clientId, undefined, "")).paused).toBe(true);
  vi.stubEnv("COPIED_DATA_SAFE_MODE", "false");
  const other = await pool.connect();
  try {
    await other.query("SELECT pg_advisory_lock(714035,$1)", [clientId]);
    expect(await runHpWarmSweep(tenantId, clientId)).toBeUndefined();
  } finally {
    await other.query("SELECT pg_advisory_unlock(714035,$1)", [clientId]); other.release();
  }
  expect((await pool.query("SELECT * FROM hp_warm_sweeps WHERE tenant_id=$1", [tenantId])).rows[0]).toEqual(before);
});

it("retains a failed batch's cursor, retries safely and isolates tenant/client status", async () => {
  await pool.query("UPDATE hp_warm_sweeps SET cursor='a' WHERE tenant_id=$1", [tenantId]);
  const before = (await pool.query("SELECT * FROM hp_warm_sweeps WHERE tenant_id=$1", [tenantId])).rows[0];
  const query = pool.query.bind(pool);
  const spy = vi.spyOn(pool, "query").mockImplementation(((text: any, ...args: any[]) => {
    if (typeof text === "string" && text.startsWith("WITH owned AS")) throw new Error("fixture batch read failure");
    return (query as any)(text, ...args);
  }) as any);
  try { await expect(runHpWarmSweep(tenantId, clientId, 1)).rejects.toThrow("fixture batch read failure"); }
  finally { spy.mockRestore(); }
  const failed = (await pool.query("SELECT * FROM hp_warm_sweeps WHERE tenant_id=$1", [tenantId])).rows[0];
  expect(failed.cursor).toBe("a");
  expect(failed.last_success_at).toEqual(before.last_success_at);
  expect(failed.last_failure_at).toBeInstanceOf(Date);
  expect((await runHpWarmSweep(tenantId, clientId, 1))?.checks.map(c => c.parentKey)).toEqual(["b"]);
  expect((await pool.query("SELECT last_failure_at FROM hp_warm_sweeps WHERE tenant_id=$1", [tenantId])).rows[0].last_failure_at).toBeNull();
  expect((await loadHpWarmRoutingStatus(tenantId + 100000, clientId, undefined, "")).items).toEqual([]);
  expect(await runHpWarmSweep(tenantId + 100000, clientId)).toBeUndefined();
});

it("distinguishes DNC-blocked and missing product mappings and shows only selected outcomes", async () => {
  await pool.query("UPDATE hp_warm_sweeps SET cursor='' WHERE tenant_id=$1", [tenantId]);
  await pool.query("UPDATE contacts SET dnc=true WHERE id=$1", [hp.contactId]);
  await runHpWarmSweep(tenantId, clientId);
  let report = await loadHpWarmRoutingStatus(tenantId, clientId, "blocked", "");
  expect(report.items).toHaveLength(1);
  expect(report.items[0].reason).toContain("DNC");
  await pool.query("UPDATE contacts SET dnc=false WHERE id=$1", [hp.contactId]);
  await pool.query("UPDATE intent_inbound_routing_rules SET enabled=false WHERE id=$1", [ruleId]);
  await runHpWarmSweep(tenantId, clientId);
  report = await loadHpWarmRoutingStatus(tenantId, clientId, "unmapped", "");
  expect(report.items).toHaveLength(1);
  expect(report.items[0].reason).toContain("HP Device as a Service");
  expect((await loadHpWarmRoutingStatus(tenantId, clientId, "routed", "")).items).toHaveLength(0);
  await pool.query("UPDATE intent_inbound_routing_rules SET enabled=true WHERE id=$1", [ruleId]);
  expect(Number((await pool.query("SELECT count(*) FROM sequence_enrollments WHERE sequence_id=$1", [sequenceId])).rows[0].count)).toBe(0);
});

it("enforces admin-only, tenant-owned HP access at the HTTP boundary", async () => {
  const { default: express } = await import("express");
  const { default: request } = await import("supertest");
  const { default: router } = await import("../routes/hpBi");
  let role = "admin", authenticated = true;
  const app = express();
  app.use((req: any, _res, next) => {
    req.isAuthenticated = () => authenticated;
    req.user = { tenantId, role, sectionPermissions: { analytics: "write" } };
    req.log = { warn() {} };
    next();
  });
  app.use(router);
  const path = `/analytics/hp-bi/warm-routing?clientId=${clientId}`;
  expect((await request(app).get(path)).status).toBe(200);
  role = "manager";
  expect((await request(app).get(path)).status).toBe(403);
  authenticated = false;
  expect((await request(app).get(path)).status).toBe(401);
  authenticated = true; role = "admin";
  expect((await request(app).get("/analytics/hp-bi/warm-routing?clientId=999999999")).status).toBe(404);
  expect((await request(app).get(`${path}&status=bad`)).status).toBe(400);
});

it("pages unchecked groups without duplicates and hides accounts moved outside client ownership", async () => {
  const added = await pool.query(`WITH created AS (
    INSERT INTO companies(tenant_id,client_id,name)
    SELECT $1,$2,'Routing page fixture '||lpad(n::text,3,'0') FROM generate_series(1,55) n RETURNING id,name)
    INSERT INTO hp_account_profiles(tenant_id,client_id,company_id,parent_key,parent_name,provenance)
    SELECT $1,$2,id,'page-'||name,name,'routing-test' FROM created RETURNING company_id`, [tenantId, clientId]);
  try {
    const first = await loadHpWarmRoutingStatus(tenantId, clientId, "unchecked", "");
    expect(first.items).toHaveLength(50);
    expect(first.counts.unchecked).toBe(55);
    const second = await loadHpWarmRoutingStatus(tenantId, clientId, "unchecked", first.nextCursor!);
    expect(second.items).toHaveLength(5);
    expect(second.nextCursor).toBeNull();
    expect(new Set([...first.items, ...second.items].map(r => r.parentKey)).size).toBe(55);
    // A stale profile is not authority to expose a company whose ownership changed.
    const other = (await pool.query("INSERT INTO clients(tenant_id,name) VALUES($1,'Other routing fixture') RETURNING id", [tenantId])).rows[0].id;
    await pool.query("UPDATE companies SET client_id=$2 WHERE id=$1", [added.rows[0].company_id, other]);
    expect((await loadHpWarmRoutingStatus(tenantId, clientId, "unchecked", "")).counts.unchecked).toBe(54);
  } finally {
    await pool.query("DELETE FROM companies WHERE id=ANY($1::int[])", [added.rows.map(r => r.company_id)]);
  }
});

it("does not advance a failed checkpoint and safely retries membership already written by that batch", async () => {
  await pool.query("UPDATE hp_warm_sweeps SET cursor='' WHERE tenant_id=$1", [tenantId]);
  await pool.query("DELETE FROM journey_contacts WHERE journey_id=$1", [journeyId]);
  const before = (await pool.query("SELECT * FROM hp_warm_sweeps WHERE tenant_id=$1", [tenantId])).rows[0];
  const checks = (await pool.query("SELECT * FROM hp_warm_checks WHERE tenant_id=$1 ORDER BY parent_key", [tenantId])).rows;
  const connection = await pool.connect();
  const query = connection.query.bind(connection);
  const querySpy = vi.spyOn(connection, "query").mockImplementation(((text: any, ...args: any[]) => {
    if (typeof text === "string" && text.startsWith("INSERT INTO hp_warm_checks")) throw new Error("fixture checkpoint failure");
    return (query as any)(text, ...args);
  }) as any);
  const connectSpy = vi.spyOn(pool, "connect").mockResolvedValueOnce(connection as never);
  try { await expect(runHpWarmSweep(tenantId, clientId, 1)).rejects.toThrow("fixture checkpoint failure"); }
  finally { querySpy.mockRestore(); connectSpy.mockRestore(); }
  const failed = (await pool.query("SELECT * FROM hp_warm_sweeps WHERE tenant_id=$1", [tenantId])).rows[0];
  expect(failed.cursor).toBe(before.cursor);
  expect(failed.last_success_at).toEqual(before.last_success_at);
  expect((await pool.query("SELECT * FROM hp_warm_checks WHERE tenant_id=$1 ORDER BY parent_key", [tenantId])).rows).toEqual(checks);
  expect((await pool.query("SELECT 1 FROM journey_contacts WHERE journey_id=$1", [journeyId])).rowCount).toBe(1);
  const events = (await pool.query("SELECT count(*) FROM activity_events WHERE tenant_id=$1 AND event_type='hp_warm_routed'", [tenantId])).rows[0].count;
  expect((await runHpWarmSweep(tenantId, clientId, 1))?.routed).toBe(0);
  expect((await pool.query("SELECT count(*) FROM activity_events WHERE tenant_id=$1 AND event_type='hp_warm_routed'", [tenantId])).rows[0].count).toBe(events);
});

it.each(["HP India", "Hewlett-Packard", "Hewlett Packard India", " HP Inc. "])(
  "uses the API HP eligibility policy for discovery, checkpoints, diagnostics and priority: %s", async name => {
    vi.stubEnv("COPIED_DATA_SAFE_MODE", "false");
    await pool.query("UPDATE clients SET name=$2 WHERE id=$1", [clientId, name]);
    await pool.query("UPDATE hp_warm_sweeps SET cursor='' WHERE tenant_id=$1", [tenantId]);
    try {
      expect((await loadHpWarmClients()).some(c => Number(c.id) === clientId && Number(c.tenant_id) === tenantId)).toBe(true);
      expect((await runHpWarmSweep(tenantId, clientId, 1))?.cursor).toBe("a");
      const status = await loadHpWarmRoutingStatus(tenantId, clientId, undefined, "");
      expect(status.sweep.cursor).toBe("a");
      expect(status.sweep.lastSuccessAt).toBeInstanceOf(Date);
      expect(status.counts).toMatchObject({ routed: 1, not_eligible: 1 });
      expect(status.items).toHaveLength(2);
      const report: any = await loadHpBi(tenantId, { clientId, year: 2026, page: 1, pageSize: 25 });
      expect(report.accounts.find((a: any) => a.id === hp.companyId).priority)
        .toMatchObject({ status: "Warm", score: 45.5 });
    } finally { await pool.query("UPDATE clients SET name='HP' WHERE id=$1", [clientId]); }
  });
