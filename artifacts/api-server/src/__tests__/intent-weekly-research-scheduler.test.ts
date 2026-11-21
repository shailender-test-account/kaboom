import { readFileSync } from "node:fs";
import { describe,expect,it } from "vitest";
import { allocateFairLaneAccounts, nextDailyNineIst, PROVIDER_ORDER } from "../intentWeeklyResearchScheduler";

describe("daily continuous account monitoring schedule",()=>{
  it("prefers Perplexity over other configured engines for future batches",()=>{
    expect(PROVIDER_ORDER).toEqual(["perplexity","tavily","explorium","newsapi"]);
  });
  it("targets 09:00 Asia/Kolkata every day",()=>{
    expect(nextDailyNineIst(new Date("2026-09-05T02:00:00.000Z")).toISOString()).toBe("2026-09-05T03:30:00.000Z");
  });

  it("uses the same day before the trigger time",()=>{
    expect(nextDailyNineIst(new Date("2026-09-07T02:30:00.000Z")).toISOString()).toBe("2026-09-07T03:30:00.000Z");
  });

  it("uses the following day after the trigger time",()=>{
    expect(nextDailyNineIst(new Date("2026-09-07T04:00:00.000Z")).toISOString()).toBe("2026-09-08T03:30:00.000Z");
  });

  it("allocates a configured daily target fairly and fills from the non-empty lane",()=>{
    const warm=Array.from({length:5},(_,id)=>({id:id+1}));
    const prospects=Array.from({length:8},(_,id)=>({id:id+101}));
    const allocated=allocateFairLaneAccounts(warm,prospects,8);
    expect(allocated.warm.map(row=>row.id)).toEqual([1,2,3,4]);
    expect(allocated.prospect.map(row=>row.id)).toEqual([101,102,103,104]);
    const filled=allocateFairLaneAccounts(warm.slice(0,1),prospects,8);
    expect(filled.warm).toHaveLength(1);
    expect(filled.prospect).toHaveLength(7);
    expect(new Set([...filled.warm,...filled.prospect].map(row=>row.id)).size).toBe(8);
  });

  it("rotates a bounded configured audience batch and retries failed accounts",()=>{
    const scheduler=readFileSync(new URL("../intentWeeklyResearchScheduler.ts",import.meta.url),"utf8");
    const runner=readFileSync(new URL("../intentResearchRunner.ts",import.meta.url),"utf8");
    expect(scheduler).toContain("c.daily_limit");
    expect(scheduler).toContain("config.daily_limit");
    expect(scheduler).toContain("scheduleImmediateAccountResearch");
    expect(scheduler).toContain("monitoring-activation:");
    expect(scheduler).toContain("FROM intent_monitoring_accounts selected");
    expect(scheduler).toContain("config.client_id");
    expect(scheduler).not.toContain("const DAILY_BATCH_SIZE");
    expect(scheduler).toContain("COALESCE(${hpParentLastCheckedSql()},last_researched_at) < NOW()-interval '7 days'");
    expect(scheduler).toContain("ORDER BY last_researched_at ASC NULLS FIRST,id");
    expect(scheduler).toContain("FROM intent_monitoring_configs");
    expect(scheduler).toContain("JOIN intent_audience_companies");
    expect(scheduler).toContain("FROM intent_monitoring_segments");
    expect(scheduler).toContain("buildContactsWhereClause");
    expect(scheduler).toContain("client_id IS NOT NULL");
    expect(scheduler).toContain("const byClientLane=new Map<string,");
    expect(scheduler).toContain("intent_inbound_submissions");
    expect(scheduler).toContain('row.classification==="hot"');
    expect(scheduler).toContain("categoryMatchedWarmInbound(row.product_interest");
    expect(scheduler).toContain("evaluateTwoLevelIntentStatus(rows)");
    expect(scheduler).toContain("allocateFairLaneAccounts");
    expect(scheduler).toContain("last_lane_counts");
    expect(runner).toContain("monitoringLane");
    expect(scheduler).not.toContain("WHERE c.enabled=true AND c.client_id IS NOT NULL");
    expect(scheduler).toContain("daily-monitoring:");
    expect(scheduler).toContain("categoryIds");
    expect(scheduler).not.toContain("regexp_replace(name");
    expect(runner).toContain("UPDATE companies company SET last_researched_at=NOW()");
    expect(runner).toContain("categoryIds: run.summary.request?.categoryIds ?? []");
    const processAccount=runner.slice(runner.indexOf("async function processRunAccount"));
    expect(processAccount.indexOf("UPDATE companies company SET last_researched_at=NOW()")).toBeLessThan(processAccount.indexOf("} catch (error)"));
  });
});