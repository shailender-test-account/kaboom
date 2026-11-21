import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import express from "express";
import supertest from "supertest";
import { randomUUID } from "node:crypto";
import { pool } from "@workspace/db";
import committeeRouter from "../routes/buyingCommittee";
import { seedHpCrmAccounts, cleanHpCrmTenant } from "./testFixtures/hpCrm";
import { lookupCommitteeDomain, publicDomainCandidates, committeeSourceUrl } from "./buyingCommitteeDomains";
import { committeePlan, saveCommitteePlan, approveCommitteePlan } from "./buyingCommittee";

const provider = vi.hoisted(() => ({ configured: vi.fn(), proxy: vi.fn() }));
vi.mock("./intentProviders", () => ({ providerConfigured: provider.configured }));
vi.mock("@replit/connectors-sdk", () => ({ ReplitConnectors: class { proxy = provider.proxy; } }));
let tenantId: number, clientId: number, parentId: number;
let hp: Awaited<ReturnType<typeof seedHpCrmAccounts>>;
const scope = () => ({ clientId, accountId: hp.companyId, includeRoster: true, audienceIds: [], research: false, acknowledgeCost: false });
function api(role = "admin", tenant = tenantId) {
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { req.isAuthenticated = (() => role !== "anonymous") as any; req.user = { id: 1, tenantId: tenant, role } as any; next(); });
  app.use(committeeRouter); return supertest(app);
}
beforeAll(async () => {
  tenantId = Number((await pool.query("INSERT INTO tenants(name,slug) VALUES('Website lookup tests',$1) RETURNING id", [randomUUID()])).rows[0].id);
  clientId = Number((await pool.query("INSERT INTO clients(tenant_id,name) VALUES($1,'HP') RETURNING id", [tenantId])).rows[0].id);
  hp = await seedHpCrmAccounts(tenantId, clientId);
  parentId = Number((await pool.query("INSERT INTO companies(tenant_id,client_id,name) VALUES($1,$2,'CRM Parent') RETURNING id", [tenantId, clientId])).rows[0].id);
});
beforeEach(async () => {
  provider.configured.mockImplementation(async (_tenant: number, name: string) => name === "tavily");
  await pool.query("UPDATE companies SET domain=NULL,website=NULL WHERE tenant_id=$1", [tenantId]);
});
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });
afterAll(async () => {
  if (!tenantId) return;
  await pool.query("DELETE FROM buying_committee_plans WHERE tenant_id=$1", [tenantId]);
  await cleanHpCrmTenant(tenantId);
});
it("checks authentication, admin role, tenant, client and selected source before any provider request", async () => {
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  const url = "/buying-committee/domain-lookup";
  expect((await api("anonymous").post(url).send(scope())).status).toBe(401);
  expect((await api("member").post(url).send(scope())).status).toBe(403);
  expect((await api("admin", tenantId + 100000).post(url).send(scope())).status).toBe(404);
  expect((await api().post(url).send({ ...scope(), clientId: clientId + 100000 })).status).toBe(404);
  expect((await api().post(url).send({ ...scope(), accountId: parentId, research: true, acknowledgeCost: true })).status).toBe(404);
  expect((await api().post(url).send({ ...scope(), includeRoster: false })).status).toBe(404);
  expect((await api().post(url).send({ ...scope(), audienceIds: [999999999] })).status).toBe(404);
  expect((await api().post(url).send({ ...scope(), accountId: 0 })).status).toBe(400);
  expect(fetch).not.toHaveBeenCalled();
});
it("returns empty missing-company evidence without guessing or invoking research", async () => {
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  const response = await api().post("/buying-committee/domain-lookup").send(scope());
  expect(response.status).toBe(200);
  expect(response.headers["cache-control"]).toBe("private, no-store");
  expect(response.body).toMatchObject({ legalName: "CRM A", parentName: "CRM Parent", candidates: [], provider: null, requests: 0 });
  expect(response.body.warnings.join(" ")).toMatch(/Do not infer a domain/);
  expect(fetch).not.toHaveBeenCalled();
});
it("reuses owned CRM website and parent evidence, distinguishes ambiguity and warns about shared domains", async () => {
  await pool.query("UPDATE companies SET website='https://legal-company.com/about' WHERE id=$1", [hp.companyId]);
  await pool.query("UPDATE companies SET domain='group-company.com' WHERE id=$1", [parentId]);
  await pool.query("UPDATE companies SET domain='legal-company.com' WHERE id=$1", [hp.siblingId]);
  const result = await lookupCommitteeDomain(tenantId, scope());
  expect(result.candidates).toEqual(expect.arrayContaining([
    expect.objectContaining({ domain: "legal-company.com", sourceUrl: "https://legal-company.com/about", relationship: "legal-company" }),
    expect.objectContaining({ domain: "group-company.com", relationship: "parent-company" }),
  ]));
  expect(result.warnings.join(" ")).toMatch(/Multiple possible websites/);
  expect(result.warnings.join(" ")).toMatch(/Shared CRM domains/);
  expect(result.warnings.join(" ")).toMatch(/Parent-company evidence does not establish/);
});
it("requires acknowledgement, limits public search to one request/five results and preserves evidence links", async () => {
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ results: [
    { url: "https://legal-company.com/legal", title: "CRM A legal company", content: "Official legal details" },
    { url: "https://different-company.com/about", title: "CRM Parent group website", content: "Group overview" },
    { url: "https://www.linkedin.com/company/company", title: "CRM A" },
  ] }), { status: 200 }));
  vi.stubGlobal("fetch", fetch);
  await expect(lookupCommitteeDomain(tenantId, { ...scope(), research: true })).rejects.toMatchObject({ status: 400 });
  expect(fetch).not.toHaveBeenCalled();
  const result = await lookupCommitteeDomain(tenantId, { ...scope(), research: true, acknowledgeCost: true });
  expect(result).toMatchObject({ provider: "tavily", requests: 1 });
  expect(fetch).toHaveBeenCalledTimes(1);
  const request = JSON.parse(fetch.mock.calls[0][1].body);
  expect(request).toMatchObject({ max_results: 5, search_depth: "basic", include_answer: false });
  expect(request.query).toContain('"CRM A"');
  expect(result.candidates).toHaveLength(2);
  expect(result.candidates[0]).toMatchObject({ sourceUrl: "https://legal-company.com/legal", relationship: "legal-company" });
  expect(result.candidates[1].relationship).toBe("parent-company");
});
it("uses the existing Perplexity connector when Tavily is unavailable, with one bounded search and no fallback on Tavily errors", async () => {
  provider.configured.mockImplementation(async (_tenant: number, name: string) => name === "perplexity");
  provider.proxy.mockResolvedValueOnce(new Response(JSON.stringify({ results: [
    { url: "https://legal-company.com/legal", title: "CRM A official company", snippet: "Corporate details" },
  ] }), { status: 200 }));
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  const result = await lookupCommitteeDomain(tenantId, { ...scope(), research: true, acknowledgeCost: true });
  expect(result).toMatchObject({ provider: "perplexity", requests: 1 });
  expect(result.candidates[0].evidence).toContain("Corporate details");
  expect(provider.proxy).toHaveBeenCalledWith("perplexity", "/search", expect.objectContaining({ method: "POST" }));
  expect(JSON.parse(provider.proxy.mock.calls[0][2].body)).toMatchObject({ max_results: 5 });
  expect(provider.proxy).toHaveBeenCalledTimes(1);
  expect(fetch).not.toHaveBeenCalled();
});
it("surfaces unavailable providers and errors without retrying or treating failure as free", async () => {
  provider.configured.mockResolvedValue(false);
  await expect(lookupCommitteeDomain(tenantId, { ...scope(), research: true, acknowledgeCost: true })).rejects.toMatchObject({ status: 409 });
  provider.configured.mockResolvedValue(true);
  for (const result of [
    new Response("failure", { status: 429 }),
    new Response(JSON.stringify({ bad: "payload" }), { status: 200 }),
  ]) {
    const fetch = vi.fn().mockResolvedValue(result); vi.stubGlobal("fetch", fetch);
    await expect(lookupCommitteeDomain(tenantId, { ...scope(), research: true, acknowledgeCost: true })).rejects.toThrow(/may have incurred cost/);
    expect(fetch).toHaveBeenCalledTimes(1);
  }
});
it("serializes concurrent paid requests per tenant and releases the guard after failure", async () => {
  let reject!: (error: Error) => void;
  const fetch = vi.fn().mockImplementation(() => new Promise((_resolve, fail) => { reject = fail; }));
  vi.stubGlobal("fetch", fetch);
  const first = lookupCommitteeDomain(tenantId, { ...scope(), research: true, acknowledgeCost: true }).catch(error => error);
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  await expect(lookupCommitteeDomain(tenantId, { ...scope(), research: true, acknowledgeCost: true })).rejects.toMatchObject({ status: 409 });
  reject(new Error("timeout"));
  expect(await first).toMatchObject({ status: 502 });
  fetch.mockResolvedValueOnce(new Response(JSON.stringify({ results: [] }), { status: 200 }));
  expect((await lookupCommitteeDomain(tenantId, { ...scope(), research: true, acknowledgeCost: true })).requests).toBe(1);
  expect(fetch).toHaveBeenCalledTimes(2);
});
it("never persists lookup results; only explicitly saving confirmed draft values affects plan targets, not CRM or approval", async () => {
  const config = { clientId, name: "Domain review", country: "India", includeRoster: true, audienceIds: [], accountIds: [hp.companyId],
    categories: ["Security" as const], designations: ["CISO"], limitPerAccount: 3, domains: { [hp.companyId]: "" } };
  const saved = await saveCommitteePlan(tenantId, 1, config);
  await pool.query("UPDATE companies SET website='https://confirmed-website.com/legal' WHERE id=$1", [hp.companyId]);
  const result = await lookupCommitteeDomain(tenantId, scope());
  expect(result.candidates[0].domain).toBe("confirmed-website.com");
  expect((await committeePlan(tenantId, saved.plan.id)).targets[0].domain).toBe("");
  const updated = await saveCommitteePlan(tenantId, 1, { ...config, domains: { [hp.companyId]: result.candidates[0].domain } }, saved.plan.id);
  expect(updated.plan.status).toBe("draft");
  expect(updated.plan.approved_at).toBeNull();
  expect(updated.targets[0]).toMatchObject({ domain: "confirmed-website.com", requests: 0, status: "pending" });
  const crm = (await pool.query("SELECT domain,website FROM companies WHERE id=$1", [hp.companyId])).rows[0];
  expect(crm).toMatchObject({ domain: null, website: "https://confirmed-website.com/legal" });
  const shared = await saveCommitteePlan(tenantId, 1, { ...config, accountIds: [hp.companyId, hp.siblingId],
    domains: { [hp.companyId]: "group-company.com", [hp.siblingId]: "group-company.com" } });
  await expect(approveCommitteePlan(tenantId, 1, shared.plan.id, shared.plan.revision)).rejects.toThrow(/share a domain/);
});
it("rejects unsafe links and bounds/deduplicates public candidates without treating snippets as verified identity", () => {
  for (const url of ["javascript:alert(1)", "https://user:password@company.com", "https://127.0.0.1/admin", "ftp://company.com", "company.com"]) expect(committeeSourceUrl(url)).toBe("");
  const rows = Array.from({ length: 9 }, (_, i) => ({ url: `https://company${i}.com`, title: "Unrelated company" }));
  expect(publicDomainCandidates(rows, "Legal Name")).toHaveLength(5);
  expect(publicDomainCandidates([rows[0], rows[0]], "Legal Name")).toHaveLength(1);
  expect(publicDomainCandidates(rows, "Legal Name").every(c => c.relationship === "uncertain")).toBe(true);
});
