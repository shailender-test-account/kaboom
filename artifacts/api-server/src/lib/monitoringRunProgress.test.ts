import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { pool } from "@workspace/db";
import { readLatestMonitoringRuns } from "./monitoringRunProgress";
import { monitoringBatchAccounts } from "./monitoringBatchAccounts";

let tenant: number, other: number, warm: number, prospect: number, retry: number;
async function run(owner:number,key:string,lane:string,total:number,retryOf:number|null=null){
  return (await pool.query(`INSERT INTO intent_research_runs
    (tenant_id,provider,status,idempotency_key,retry_of_id,summary,started_at)
    VALUES($1,'tavily','partial',$2,$3,$4,NOW()+($5::int*interval '1 second')) RETURNING id`,
    [owner,key,retryOf,JSON.stringify({monitoringLane:lane,laneCounts:{eligible:total,scheduled:total,deferred:0}}),retryOf?1:0])).rows[0].id as number;
}
async function checks(owner:number,runId:number,start:number,total:number,completed:number){
  await pool.query(`INSERT INTO intent_research_run_accounts(tenant_id,run_id,account_id,status,completed_at)
    SELECT $1,$2,$3+n,CASE WHEN n<=$5 THEN 'completed' ELSE 'failed' END,NOW()
    FROM generate_series(1,$4::int) n`,[owner,runId,start,total,completed]);
}
beforeAll(async()=>{
  tenant=(await pool.query("INSERT INTO tenants(name,slug) VALUES('Batch progress test',$1) RETURNING id",[randomUUID()])).rows[0].id;
  other=(await pool.query("INSERT INTO tenants(name,slug) VALUES('Other batch progress test',$1) RETURNING id",[randomUUID()])).rows[0].id;
  warm=await run(tenant,"monitoring-activation:3:2026-10-28T12:46:22.503Z:9:tavily-warm","warm",10);
  prospect=await run(tenant,"monitoring-activation:3:2026-10-28T12:46:22.503Z:9:tavily-prospect","prospect",190);
  await checks(tenant,warm,0,10,8);
  await checks(tenant,prospect,10,190,178);
  retry=await run(tenant,`monitoring-activation:3:retry-${warm}:9:perplexity-warm`,"warm",2,warm);
  await checks(tenant,retry,8,2,2);
  await pool.query("UPDATE intent_research_runs SET status='completed',provider='perplexity' WHERE id=$1",[retry]);
  const foreign=await run(other,"monitoring-activation:3:foreign:9:tavily-warm","warm",1);
  await checks(other,foreign,1000,1,1);
  const unrelated=await run(tenant,"monitoring-activation:4:other-schedule:9:tavily-warm","warm",1);
  await checks(tenant,unrelated,2000,1,1);
});
afterAll(async()=>{
  const owners=[tenant,other].filter(Boolean);
  await pool.query("DELETE FROM intent_research_run_accounts WHERE tenant_id=ANY($1::int[])",[owners]);
  await pool.query("DELETE FROM intent_research_runs WHERE tenant_id=ANY($1::int[])",[owners]);
  await pool.query("DELETE FROM tenants WHERE id=ANY($1::int[])",[owners]);
});
it("drills into the same retry-aware batch, lanes and statuses without duplicating recovered accounts",async()=>{
  const all=await monitoringBatchAccounts(tenant,3,warm,"all",1,20);
  expect(all.totalAccounts).toBe(200);
  expect(all.items).toHaveLength(20);
  const completed=await monitoringBatchAccounts(tenant,3,warm,"completed",1,20);
  const failed=await monitoringBatchAccounts(tenant,3,retry,"failed",1,20);
  expect(completed.totalAccounts).toBe(188);
  expect(failed.totalAccounts).toBe(12);
  expect(failed.items.every((item:any)=>item.accountId>10)).toBe(true);
  expect((await monitoringBatchAccounts(tenant,3,warm,"completed",1,20,"warm")).totalAccounts).toBe(10);
  expect((await monitoringBatchAccounts(tenant,3,warm,"all",1,20,"prospect")).totalAccounts).toBe(190);
  expect((await monitoringBatchAccounts(tenant,3,warm,"remaining",1,20)).totalAccounts).toBe(0);
  expect((await monitoringBatchAccounts(other,3,warm,"all",1,20)).totalAccounts).toBe(0);
  expect((await monitoringBatchAccounts(tenant,4,warm,"all",1,20)).totalAccounts).toBe(0);
  const next=await monitoringBatchAccounts(tenant,3,warm,"all",2,20);
  expect(next.items[0].accountId).toBeGreaterThan(all.items.at(-1).accountId);
});
const totals=(runs:Awaited<ReturnType<typeof readLatestMonitoringRuns>>)=>runs.reduce((sum,r)=>({
  total:sum.total+Number(r.summary.accountsTotal),
  completed:sum.completed+Number(r.summary.accountsCompleted),
  failed:sum.failed+Number(r.summary.accountsFailed),
  remaining:sum.remaining+Number(r.summary.accountsRemaining),
  scheduled:sum.scheduled+Number((r.summary.laneCounts as any)?.scheduled??0),
}),{total:0,completed:0,failed:0,remaining:0,scheduled:0});

it("keeps all 200 original accounts after a two-account retry, without counting accounts or lane allocations twice",async()=>{
  const runs=await readLatestMonitoringRuns(tenant,3);
  expect(runs.map(r=>r.id).sort()).toEqual([warm,prospect,retry].sort());
  expect(totals(runs)).toEqual({total:200,completed:188,failed:12,remaining:0,scheduled:200});
  expect(runs.find(r=>r.id===warm)).toMatchObject({status:"completed",summary:{accountsCompleted:8,accountsFailed:0}});
  expect(runs.find(r=>r.id===prospect)).toMatchObject({status:"partial",summary:{accountsCompleted:178,accountsFailed:12}});
});
it("follows nested retries and uses the latest attempt per account, including pending work",async()=>{
  const nested=await run(tenant,`monitoring-activation:3:retry-${retry}:9:tavily-warm`,"warm",2,retry);
  await pool.query("UPDATE intent_research_runs SET started_at=NOW()+interval '2 seconds',status='queued' WHERE id=$1",[nested]);
  await checks(tenant,nested,8,2,0);
  await pool.query("UPDATE intent_research_run_accounts SET status='pending',completed_at=NULL WHERE run_id=$1",[nested]);
  const runs=await readLatestMonitoringRuns(tenant,3);
  expect(totals(runs)).toEqual({total:200,completed:186,failed:12,remaining:2,scheduled:200});
  expect(runs.find(r=>r.id===nested)).toMatchObject({status:"queued"});
});
it("switches to a genuinely new batch instead of merging every historical schedule run",async()=>{
  const fresh=await run(tenant,"daily-monitoring:2026-10-30:3:9:tavily-prospect","prospect",1);
  await pool.query("UPDATE intent_research_runs SET started_at=NOW()+interval '3 seconds' WHERE id=$1",[fresh]);
  await checks(tenant,fresh,3000,1,1);
  const runs=await readLatestMonitoringRuns(tenant,3);
  expect(runs.map(r=>r.id)).toEqual([fresh]);
  expect(totals(runs)).toEqual({total:1,completed:1,failed:0,remaining:0,scheduled:1});
  expect(await readLatestMonitoringRuns(tenant,9999)).toEqual([]);
});
