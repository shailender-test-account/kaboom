import { expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { pool } from "@workspace/db";
import { sortHpAccounts,filterHpAccountQualification } from "./hpAccountSort";
import { loadHpBi } from "./hpBiMetrics";
import { importHpWorkbook } from "./hpBiImport";
import { hpWorkbook, cleanHpCrmTenant } from "./testFixtures/hpCrm";

const row = (id: number, extra: Record<string, unknown> = {}) => ({ id, name: `Account ${id}`, parentKey: `p${id}`, contacts: 1, ...extra });
it("filters qualification over the full sorted parent list before pagination without inventing Cold",()=>{
  const rows=[{id:1,status:"Cold"},{id:2,status:"Warm"},{id:3,status:"Hot"},{id:4,status:"Hot"},{id:5,status:"Unqualified"}];
  expect(filterHpAccountQualification(rows,"Hot").slice(0,1).map(row=>row.id)).toEqual([3]);
  expect(filterHpAccountQualification(rows,"Hot").slice(1,2).map(row=>row.id)).toEqual([4]);
  expect(filterHpAccountQualification(rows,"Warm").map(row=>row.id)).toEqual([2]);
  expect(filterHpAccountQualification(rows,"Cold").map(row=>row.id)).toEqual([1]);
  expect(filterHpAccountQualification(rows)).toBe(rows);
  expect(rows).toHaveLength(5);
});
it.each(["contacts", "engagedContacts", "touchpoints", "leads", "hot", "opportunities", "closedWon", "closedLost", "score"] as const)(
  "sorts %s numerically in both directions", field => {
    const rows = [row(1, { [field]: 9 }), row(2, { [field]: 100 }), row(3, { [field]: 20 })];
    expect(sortHpAccounts([...rows], field, "desc").map(r => r.id)).toEqual([2, 3, 1]);
    expect(sortHpAccounts([...rows], field, "asc").map(r => r.id)).toEqual([1, 3, 2]);
  });
it.each(["name", "segment", "rad"] as const)("sorts %s alphabetically", field => {
  const rows = [row(1, { [field]: "Zulu" }), row(2, { [field]: "Alpha" })];
  expect(sortHpAccounts([...rows], field, "asc").map(r => r.id)).toEqual([2, 1]);
  expect(sortHpAccounts([...rows], field, "desc").map(r => r.id)).toEqual([1, 2]);
});
it.each(["status", "gtmStatus"] as const)("sorts %s by qualification, not alphabetically", field => {
  const rows = ["Warm", "Unqualified", "Hot"].map((status, i) => row(i + 1, field === "status" ? { status } : { gtm: { status } }));
  expect(sortHpAccounts([...rows], field, "desc").map(r => r.id)).toEqual([3, 1, 2]);
  expect(sortHpAccounts([...rows], field, "asc").map(r => r.id)).toEqual([2, 1, 3]);
});
it("sorts by actual date and keeps missing dates last in either direction", () => {
  const rows = [row(1, { lastActivity: null }), row(2, { lastActivity: "2026-01-31" }), row(3, { lastActivity: "2026-02-01" })];
  expect(sortHpAccounts([...rows], "lastActivity", "desc").map(r => r.id)).toEqual([3, 2, 1]);
  expect(sortHpAccounts([...rows], "lastActivity", "asc").map(r => r.id)).toEqual([2, 3, 1]);
});
it.each(["values", "bookedValues"] as const)("sorts %s in the selected currency, preserving zero and missing amounts", field => {
  const rows = [row(1, { [field]: { USD: 100000 } }), row(2, { [field]: { INR: 0 } }), row(3, { [field]: { INR: 500 } })];
  expect(sortHpAccounts([...rows], field, "desc", "INR").map(r => r.id)).toEqual([3, 2, 1]);
  expect(sortHpAccounts([...rows], field, "asc", "INR").map(r => r.id)).toEqual([2, 3, 1]);
  expect(sortHpAccounts([...rows], field, "desc", "USD")[0].id).toBe(1);
});
it("uses deterministic account-name ties and retains the existing default order", () => {
  const rows = [row(2, { hot: 1, touchpoints: 2 }), row(1, { hot: 1, touchpoints: 2 }), row(3, { hot: 2, touchpoints: 0 })];
  expect(sortHpAccounts([...rows]).map(r => r.id)).toEqual([3, 1, 2]);
});
it("sorts routed journey names alphabetically with unrouted accounts last", () => {
  const rows = [row(1, { journeys: [] }), row(2, { journeys: [{ name: "Security nurture" }] }), row(3, { journeys: [{ name: "Business services" }] })];
  expect(sortHpAccounts([...rows], "journey", "asc").map(r => r.id)).toEqual([3, 2, 1]);
  expect(sortHpAccounts([...rows], "journey", "desc").map(r => r.id)).toEqual([2, 3, 1]);
});
it("sorts the full filtered account universe before selecting pages", async () => {
  const tenant = Number((await pool.query("INSERT INTO tenants(name,slug) VALUES('Sort isolated test',$1) RETURNING id", [randomUUID()])).rows[0].id);
  try {
    const client = Number((await pool.query("INSERT INTO clients(tenant_id,name) VALUES($1,'HP') RETURNING id", [tenant])).rows[0].id);
    await importHpWorkbook(tenant, client, hpWorkbook(["UNIQUE ID", "SUBSIDIARY_LEGAL_NAME", "TOP_ID", "TOP_NAME"],
      [["A", "Alpha", "A", "Alpha"], ["B", "Beta", "B", "Beta"], ["C", "Gamma", "C", "Gamma"]]), "sort-fixture.xlsx", "accounts", {}, null);
    for (const [name, score] of [["Alpha", 9], ["Beta", 300], ["Gamma", 20]] as const) {
      await pool.query(`INSERT INTO contacts(tenant_id,client_id,company_id,first_name,email,lead_score)
        SELECT $1,$2,id,$3,$4,$5 FROM companies WHERE tenant_id=$1 AND name=$3`,
      [tenant, client, name, `${name}@example.invalid`, score]);
    }
    const filters = { clientId: client, year: 2026, page: 1, pageSize: 1, sortBy: "score" as const, sortDir: "desc" as const };
    const first = await loadHpBi(tenant, filters) as any;
    const second = await loadHpBi(tenant, { ...filters, page: 2 }) as any;
    expect(first.total).toBe(3);
    expect(first.accounts[0]).toMatchObject({ name: "Beta", score: 300 });
    expect(second.accounts[0]).toMatchObject({ name: "Gamma", score: 20 });
    const filtered = await loadHpBi(tenant, { ...filters, search: "Alpha" }) as any;
    expect(filtered.total).toBe(1); expect(filtered.accounts[0].name).toBe("Alpha");
    const cold=await loadHpBi(tenant,{...filters,qualification:"Cold",page:2}) as any;
    expect(cold.total).toBe(3);
    expect(cold.accounts).toHaveLength(1);
    expect(cold.accounts[0].status).toBe("Cold");
    expect(cold.matchingLegalAccounts).toBe(3);
    const hot=await loadHpBi(tenant,{...filters,qualification:"Hot"}) as any;
    expect(hot.total).toBe(0);
    expect(hot.accounts).toEqual([]);
    expect(hot.matchingLegalAccounts).toBe(0);
    expect(hot.summary.accounts).toBe(first.summary.accounts);
    expect(hot.summary.leads).toBe(first.summary.leads);
  } finally { await cleanHpCrmTenant(tenant); }
});
