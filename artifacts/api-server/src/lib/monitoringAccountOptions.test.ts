import { afterAll, beforeAll, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { pool } from "@workspace/db";
import { monitoringAccountOptions } from "./monitoringAccountOptions";
import { selectMonitoringRoster } from "./monitoringRosterAudience";

let tenantId: number, otherTenant: number, clientId: number, audienceId: number, foreignId: number;
let ids: number[] = [];
beforeAll(async () => {
  tenantId = Number((await pool.query("INSERT INTO tenants(name,slug) VALUES('Monitoring picker test',$1) RETURNING id", [randomUUID()])).rows[0].id);
  otherTenant = Number((await pool.query("INSERT INTO tenants(name,slug) VALUES('Monitoring other test',$1) RETURNING id", [randomUUID()])).rows[0].id);
  clientId = Number((await pool.query("INSERT INTO clients(tenant_id,name) VALUES($1,'Picker client') RETURNING id",[tenantId])).rows[0].id);
  const otherClient = Number((await pool.query("INSERT INTO clients(tenant_id,name) VALUES($1,'Other client') RETURNING id",[otherTenant])).rows[0].id);
  ids = (await pool.query(`INSERT INTO companies(tenant_id,client_id,name,domain)
    SELECT $1,$2,'GCC account '||lpad(n::text,3,'0'),'gcc'||n||'.example.test' FROM generate_series(1,55) n RETURNING id`,
  [tenantId,clientId])).rows.map(r => Number(r.id));
  foreignId = Number((await pool.query("INSERT INTO companies(tenant_id,client_id,name) VALUES($1,$2,'Foreign GCC') RETURNING id",[otherTenant,otherClient])).rows[0].id);
  audienceId = Number((await pool.query("INSERT INTO intent_audiences(tenant_id,client_id,name) VALUES($1,$2,'GCC list') RETURNING id",[tenantId,clientId])).rows[0].id);
  await pool.query("INSERT INTO intent_audience_companies(tenant_id,audience_id,company_id) SELECT $1,$2,x FROM unnest($3::int[]) x",[tenantId,audienceId,ids.slice(0,3)]);
  await pool.query(`INSERT INTO hp_account_profiles(tenant_id,client_id,company_id,parent_key,parent_name,gtm,provenance)
    SELECT $1,$2,x,x::text,'Roster parent',CASE WHEN x=$4 THEN 'GCC' ELSE 'MNC' END,'test'
    FROM unnest($3::int[]) x`,[tenantId,clientId,ids,ids[0]]);
});
it("prepares the entire owned roster, including non-GCC accounts, without loading it into the picker",async()=>{
  const selected=await selectMonitoringRoster(tenantId,clientId);
  expect(selected.memberCount).toBe(55);
  const repeated=await selectMonitoringRoster(tenantId,clientId);
  expect(repeated.id).toBe(selected.id);
  const membership=await pool.query("SELECT count(*)::int AS count FROM intent_audience_companies WHERE tenant_id=$1 AND audience_id=$2",[tenantId,selected.id]);
  expect(membership.rows[0].count).toBe(55);
  const page=await monitoringAccountOptions(tenantId,{clientId,audienceId:selected.id});
  expect(page.items).toHaveLength(25);
  expect(page.hasMore).toBe(true);
  await expect(selectMonitoringRoster(otherTenant,clientId)).rejects.toThrow("Unknown client roster");
  expect((await pool.query("SELECT count(*)::int AS count FROM intent_monitoring_configs WHERE tenant_id=$1",[tenantId])).rows[0].count).toBe(0);
  expect((await pool.query("SELECT count(*)::int AS count FROM intent_research_runs WHERE tenant_id=$1",[tenantId])).rows[0].count).toBe(0);
});
afterAll(async () => {
  for (const id of [tenantId,otherTenant].filter(Boolean)) {
    await pool.query("DELETE FROM intent_audience_companies WHERE tenant_id=$1",[id]);
    await pool.query("DELETE FROM intent_audiences WHERE tenant_id=$1",[id]);
    await pool.query("DELETE FROM companies WHERE tenant_id=$1",[id]);
    await pool.query("DELETE FROM clients WHERE tenant_id=$1",[id]);
    await pool.query("DELETE FROM tenants WHERE id=$1",[id]);
  }
});
it("paginates before enrichment and never returns all accounts", async () => {
  const first = await monitoringAccountOptions(tenantId,{});
  expect(first.items).toHaveLength(25); expect(first.hasMore).toBe(true);
  const last = await monitoringAccountOptions(tenantId,{page:3});
  expect(last.items).toHaveLength(5); expect(last.hasMore).toBe(false);
  expect(new Set([...first.items,...last.items].map(a=>a.id)).size).toBe(30);
  expect(first.items.every(a=>a.clientId===clientId)).toBe(true);
});
it("browses only the uploaded GCC list without selecting all its members", async () => {
  const result = await monitoringAccountOptions(tenantId,{audienceId,clientId});
  expect(result.items.map(a=>a.id)).toEqual(ids.slice(0,3));
  expect(result.hasMore).toBe(false);
  expect((await monitoringAccountOptions(tenantId,{audienceId,search:"003"})).items.map(a=>a.id)).toEqual([ids[2]]);
});
it("preserves selected names across pages/search without leaking other tenants", async () => {
  const result = await monitoringAccountOptions(tenantId,{ids:[ids[54],foreignId],search:"does not match",audienceId});
  expect(result.items.map(a=>a.id)).toEqual([ids[54]]);
  expect(result.hasMore).toBe(false);
  expect((await monitoringAccountOptions(otherTenant,{audienceId})).items).toHaveLength(0);
});
it("searches domains and respects client scope", async () => {
  expect((await monitoringAccountOptions(tenantId,{search:"gcc55.example.test"})).items.map(a=>a.id)).toEqual([ids[54]]);
  expect((await monitoringAccountOptions(tenantId,{clientId:clientId+10000000})).items).toHaveLength(0);
  expect((await monitoringAccountOptions(tenantId,{search:"%"})).items).toHaveLength(0);
});
