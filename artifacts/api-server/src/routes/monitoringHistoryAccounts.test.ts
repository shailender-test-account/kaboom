import express from "express";
import supertest from "supertest";
import { afterEach, expect, it, vi } from "vitest";
import router from "./monitoringHistoryAccounts";
import { sectionAccess } from "../middlewares/sectionAccess";
import { pool } from "@workspace/db";
import { monitoringHistoryAccounts } from "../lib/monitoringHistory";
import { monitoringBatchAccounts } from "../lib/monitoringBatchAccounts";

vi.mock("@workspace/db",()=>({pool:{query:vi.fn()}}));
vi.mock("../lib/monitoringHistory",()=>({monitoringHistoryAccounts:vi.fn()}));
vi.mock("../lib/monitoringBatchAccounts",()=>({monitoringBatchAccounts:vi.fn()}));
afterEach(()=>vi.clearAllMocks());
function api(permissions: object | null = {monitoring:"view"}, authenticated=true) {
  const app=express();
  app.use((req,_res,next)=>{
    req.isAuthenticated=(()=>authenticated) as any;
    req.user={tenantId:71,role:"viewer",sectionPermissions:permissions} as any;
    next();
  });
  app.use("/api",sectionAccess,router);
  return supertest(app);
}
const path="/api/intent/monitoring-history/accounts";
const params={date:"2026-10-29",status:"completed",configId:4};
it("passes an inclusive range and rejects invalid, reversed or overlong ranges",async()=>{
  for(const endDate of ["2026-02-30","2026-10-28","2027-02-01"]) {
    await api().get(path).query({...params,endDate}).expect(400);
  }
  expect(monitoringHistoryAccounts).not.toHaveBeenCalled();
  vi.mocked(pool.query).mockResolvedValueOnce({rowCount:1} as any);
  vi.mocked(monitoringHistoryAccounts).mockResolvedValueOnce({
    date:params.date,timeZone:"Asia/Kolkata",status:"completed",page:1,pageSize:20,totalAccounts:0,totalChecks:0,items:[],
  });
  await api().get(path).query({...params,endDate:"2026-11-05"}).expect(200);
  expect(monitoringHistoryAccounts).toHaveBeenCalledWith(71,params.date,"completed",1,20,4,"2026-11-05",null);
});
it("protects batch drilldowns and validates run ownership and pagination",async()=>{
  const batchPath="/api/intent/monitoring-history/batch-accounts";
  const query={configId:4,runId:8,status:"remaining"};
  await api({intent:"view"}).get(batchPath).query(query).expect(403);
  await api({},false).get(batchPath).query(query).expect(401);
  await api().get(batchPath).query({...query,page:0}).expect(400);
  vi.mocked(pool.query).mockResolvedValueOnce({rowCount:0} as any);
  await api().get(batchPath).query(query).expect(404);
  expect(monitoringBatchAccounts).not.toHaveBeenCalled();
  vi.mocked(pool.query).mockResolvedValueOnce({rowCount:1} as any);
  vi.mocked(monitoringBatchAccounts).mockResolvedValueOnce({
    configId:4,runId:8,status:"remaining",page:1,pageSize:20,totalAccounts:0,items:[],
  });
  await api().get(batchPath).query({...query,lane:"warm",tenantId:999}).expect(200);
  expect(monitoringBatchAccounts).toHaveBeenCalledWith(71,4,8,"remaining",1,20,"warm",null);
});
it("requires sign-in and monitoring read rights, not just intent rights",async()=>{
  await api({},false).get(path).query(params).expect(401);
  await api({intent:"view"}).get(path).query(params).expect(403);
  expect(monitoringHistoryAccounts).not.toHaveBeenCalled();
});
it("does not expose foreign schedules and derives tenant scope from the user",async()=>{
  vi.mocked(pool.query).mockResolvedValueOnce({rowCount:0} as any);
  await api().get(path).query({...params,tenantId:999}).expect(404);
  expect(pool.query).toHaveBeenCalledWith(expect.any(String),[71,4]);
  expect(monitoringHistoryAccounts).not.toHaveBeenCalled();
});
it("returns validated, read-only results for a monitoring viewer",async()=>{
  vi.mocked(pool.query).mockResolvedValueOnce({rowCount:1} as any);
  vi.mocked(monitoringHistoryAccounts).mockResolvedValueOnce({
    ...params,timeZone:"Asia/Kolkata",status:"completed",page:2,pageSize:10,totalAccounts:0,totalChecks:0,items:[],
  });
  await api().get(path).query({...params,page:2,pageSize:10,tenantId:999}).expect(200);
  expect(monitoringHistoryAccounts).toHaveBeenCalledWith(71,params.date,"completed",2,10,4,undefined,null);
});
it("rejects invalid calendar days, statuses, schedule IDs and pagination",async()=>{
  for(const input of [
    {date:"2026-02-30"},{date:"2026-2-03"},{date:"0000-01-01"},{status:"pending"},
    {page:0},{page:1.5},{pageSize:101},{pageSize:0},{configId:-1},
  ]) await api().get(path).query({...params,...input}).expect(400);
  expect(monitoringHistoryAccounts).not.toHaveBeenCalled();
  expect(pool.query).not.toHaveBeenCalled();
});
