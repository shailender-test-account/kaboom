import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { pool } from "@workspace/db";
import { monitoringHistory, monitoringHistoryAccounts } from "./monitoringHistory";

let tenant: number, other: number;
const runs: number[] = [];
async function run(owner: number, key: string, provider = "tavily") {
  const result = await pool.query(`INSERT INTO intent_research_runs(tenant_id,provider,status,idempotency_key)
    VALUES($1,$3,'completed',$2) RETURNING id`, [owner,key,provider]);
  runs.push(result.rows[0].id);
  return result.rows[0].id as number;
}
async function check(owner: number, runId: number, accountId: number, status: string, offset: string | null) {
  await pool.query(`INSERT INTO intent_research_run_accounts(tenant_id,run_id,account_id,status,completed_at)
    VALUES($1,$2,$3,$4,CASE WHEN $5::text IS NULL THEN NULL ELSE
      (((NOW() AT TIME ZONE 'Asia/Kolkata')::date)::timestamp AT TIME ZONE 'Asia/Kolkata')+$5::interval END)`,
  [owner,runId,accountId,status,offset]);
}
beforeAll(async()=>{
  tenant=(await pool.query("INSERT INTO tenants(name,slug) VALUES('Monitoring history test',$1) RETURNING id",[randomUUID()])).rows[0].id;
  other=(await pool.query("INSERT INTO tenants(name,slug) VALUES('Other history test',$1) RETURNING id",[randomUUID()])).rows[0].id;
  const a=await run(tenant,"monitoring-activation:111:batch:9:tavily-warm");
  const b=await run(tenant,"daily-monitoring:2026-01-01:111:9:perplexity-prospect","perplexity");
  const c=await run(tenant,"monitoring-activation:222:batch:9:tavily-warm");
  const manual=await run(tenant,"manual-monitoring-unrelated");
  const foreign=await run(other,"monitoring-activation:111:batch:9:tavily-warm");
  await check(tenant,a,1,"completed","0 seconds");
  await check(tenant,b,1,"completed","0 seconds"); // Two engines, one account.
  await check(tenant,a,2,"failed","0 seconds");
  await check(tenant,a,3,"pending",null); // No completion, no accomplishment.
  await check(tenant,a,9,"failed","0 seconds");
  await pool.query(`UPDATE intent_research_run_accounts SET error='Superseded by admin-selected monitoring recovery'
    WHERE tenant_id=$1 AND run_id=$2 AND account_id=9`,[tenant,a]);
  await check(tenant,b,2,"completed","-1 second"); // Previous IST calendar day.
  await check(tenant,c,4,"completed","0 seconds");
  await check(tenant,manual,5,"completed","0 seconds");
  await check(other,foreign,6,"completed","0 seconds");
});
it("range drilldowns match unique account and check summary totals across IST days",async()=>{
  const summary=await monitoringHistory(tenant,2,111);
  const result=await monitoringHistoryAccounts(tenant,summary.items[1].date,"completed",1,20,111,summary.items[0].date);
  expect(result.totalAccounts).toBe(summary.totalCompletedAccounts);
  expect(result.totalChecks).toBe(summary.totalCompletedChecks);
  expect(result.items.map((account:any)=>account.accountId)).toEqual([1,2]);
});
afterAll(async()=>{
  if(runs.length){
    await pool.query("DELETE FROM intent_research_run_accounts WHERE run_id=ANY($1::int[])",[runs]);
    await pool.query("DELETE FROM intent_research_runs WHERE id=ANY($1::int[])",[runs]);
  }
  await pool.query("DELETE FROM tenants WHERE id=ANY($1::int[])",[[tenant,other].filter(Boolean)]);
});
describe("Daily monitoring accomplishment",()=>{
  it("uses real completions, IST days and distinct accounts rather than provider totals or capacity",async()=>{
    const result=await monitoringHistory(tenant,2,111);
    expect(result.timeZone).toBe("Asia/Kolkata");
    expect(result.items).toHaveLength(2);
    expect(result.items[0]).toMatchObject({completedAccounts:1,completedChecks:2,failedChecks:1});
    expect(result.items[1]).toMatchObject({completedAccounts:1,completedChecks:1,failedChecks:0});
    expect(result.totalCompletedAccounts).toBe(2);
    expect(result.totalCompletedChecks).toBe(3);
    expect(result.totalFailedChecks).toBe(1);
  });
  it("retains failed history after recovery without calling failure a completion",async()=>{
    const result=await monitoringHistory(tenant,1,111);
    expect(result.totalCompletedAccounts).toBe(1);
    expect(result.totalFailedChecks).toBe(1);
  });
  it("supports all schedules while excluding manual checks and other tenants",async()=>{
    const result=await monitoringHistory(tenant,2);
    expect(result.totalCompletedAccounts).toBe(3);
    expect(result.totalCompletedChecks).toBe(4);
  });
  it("returns zero dates and zero totals for a schedule without activity",async()=>{
    const result=await monitoringHistory(tenant,7,999);
    expect(result.items).toHaveLength(7);
    expect(result.items.every(day=>day.completedAccounts===0&&day.completedChecks===0&&day.failedChecks===0)).toBe(true);
    expect(result.totalCompletedAccounts).toBe(0);
  });
  it("drills down with the same IST boundary, schedule and tenant scope, deduplicating engines",async()=>{
    const summary=await monitoringHistory(tenant,2,111);
    const today=summary.items[0].date;
    const detail=await monitoringHistoryAccounts(tenant,today,"completed",1,20,111);
    expect(detail).toMatchObject({totalAccounts:1,totalChecks:2});
    expect(detail.items).toHaveLength(1);
    expect(detail.items[0]).toMatchObject({accountId:1,accountName:null,completedChecks:2,failedChecks:0});
    expect(detail.items[0].attempts.map((a:any)=>a.provider).sort()).toEqual(["perplexity","tavily"]);
    const yesterday=await monitoringHistoryAccounts(tenant,summary.items[1].date,"completed",1,20,111);
    expect(yesterday.items.map((a:any)=>a.accountId)).toEqual([2]);
    const all=await monitoringHistoryAccounts(tenant,today,"completed",1,20);
    expect(all.items.map((a:any)=>a.accountId)).toEqual([1,4]);
    const failed=await monitoringHistoryAccounts(tenant,today,"failed",1,20,111);
    expect(failed).toMatchObject({totalAccounts:1,totalChecks:1});
    expect(failed.items.map((a:any)=>a.accountId)).toEqual([2]); // Excludes administrative supersession.
  });
  it("keeps failed attempts after recovery, pages distinct accounts and reports totals on empty pages",async()=>{
    const failedRun=await run(tenant,"daily-monitoring:2026-01-01:333:recovery:tavily-warm");
    const recovered=await run(tenant,"daily-monitoring:2026-01-01:333:recovery:perplexity-prospect","perplexity");
    await check(tenant,failedRun,20,"failed","1 second");
    await check(tenant,recovered,20,"completed","2 seconds");
    await check(tenant,recovered,21,"completed","2 seconds");
    await check(tenant,recovered,22,"completed","2 seconds");
    const today=(await monitoringHistory(tenant,1,333)).items[0].date;
    const failure=await monitoringHistoryAccounts(tenant,today,"failed",1,1,333);
    expect(failure.items[0]).toMatchObject({accountId:20,completedChecks:1,failedChecks:1});
    expect(failure.items[0].attempts.map((a:any)=>a.status)).toEqual(["failed","completed"]);
    const pages=await Promise.all([1,2,3,4].map(page=>monitoringHistoryAccounts(tenant,today,"completed",page,1,333)));
    expect(pages.map(p=>p.items.map((a:any)=>a.accountId))).toEqual([[20],[21],[22],[]]);
    for(const page of pages) expect(page).toMatchObject({totalAccounts:3,totalChecks:3});
    const noActivity=await monitoringHistoryAccounts(tenant,today,"completed",1,20,999);
    expect(noActivity).toMatchObject({totalAccounts:0,totalChecks:0,items:[]});
  });
  it("includes the full IST day and excludes the next midnight regardless of session time zone",async()=>{
    const boundary=await run(tenant,"monitoring-activation:444:boundary:tavily-warm");
    await check(tenant,boundary,30,"completed","-1 second");
    await check(tenant,boundary,31,"completed","0 seconds");
    await check(tenant,boundary,32,"completed","23 hours 59 minutes 59 seconds");
    await check(tenant,boundary,33,"completed","24 hours");
    const today=(await monitoringHistory(tenant,1,444)).items[0].date;
    const detail=await monitoringHistoryAccounts(tenant,today,"completed",1,20,444);
    expect(detail).toMatchObject({totalAccounts:2,totalChecks:2});
    expect(detail.items.map((a:any)=>a.accountId)).toEqual([31,32]);
    expect((await monitoringHistory(tenant,1,444)).totalCompletedAccounts).toBe(detail.totalAccounts);
  });
});
