import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import express from "express";
import { randomUUID } from "node:crypto";
import { pool } from "@workspace/db";
import { answerPlanSchema, simpleEngagedAccountPlan, accountPlanRestrictions } from "./aiAnswerPlan";
import { compileAnswerQuery, queryAnswerPeople, termPattern } from "./aiAnswerQuery";
import { queryAnswerAccounts } from "./aiAnswerAccounts";
import router from "../routes/aiAnswer";

const mocked = vi.hoisted(() => ({ interpret: vi.fn() }));
vi.mock("./aiAnswerPlan", async importOriginal => ({
  ...await importOriginal<typeof import("./aiAnswerPlan")>(),
  interpretAnswerQuestion: mocked.interpret,
}));
const plan = (group: Record<string, unknown> = {}) => answerPlanSchema.parse({
  mode: "people", groups: [{ regions: ["north"], functions: ["IT"], products: ["HP Poly"], ...group }],
  interpretation: "North India AND IT AND HP Poly interest", unsupported: [],
});

describe("AI Answer safe plans", () => {
  it("understands the reported account question, including its typo, without dropping extra restrictions", () => {
    for (const word of ["show", "sjow"]) expect(simpleEngagedAccountPlan(`${word} me all accounts which have engaged with us at least once`))
      .toMatchObject({ mode: "accounts", groups: [{ interest: "engaged", products: [], since: null }], unsupported: [] });
    expect(simpleEngagedAccountPlan("how many companies have engaged with us at least once")?.mode).toBe("account-count");
    expect(simpleEngagedAccountPlan("show me all accounts which have engaged with us at least once since yesterday")).toBeNull();
    expect(simpleEngagedAccountPlan("show me all accounts which have engaged with us at least once and export their contacts")).toBeNull();
    expect(accountPlanRestrictions({ ...plan(), mode: "accounts" })).toHaveLength(1);
  });
  it("rejects unknown fields, invalid dates, reversed ranges and oversized plans", () => {
    expect(() => plan({ sql: "DELETE FROM contacts" })).toThrow();
    expect(() => plan({ since: "2026-02-30" })).toThrow();
    expect(() => plan({ since: "0000-01-01" })).toThrow();
    expect(() => plan({ since: "2026-10-10", until: "2026-10-01" })).toThrow();
    expect(() => plan({ scoreMin: 70, scoreMax: 20 })).toThrow();
    expect(() => plan({ products: Array(9).fill("Poly") })).toThrow();
  });
  it("binds all user input; expands Poly precisely without matching polymer or politeness", () => {
    const malicious = "Poly'); DROP TABLE contacts; --";
    const q = compileAnswerQuery(1, 9, plan({ products: [malicious] }));
    expect(q.ctes).not.toContain(malicious);
    expect(q.values.some(v => String(v).includes("DROP TABLE"))).toBe(true);
    expect(termPattern(["HP Poly"], "product")).toBe("\\m(poly|polycom|plantronics)\\M");
    expect(q.ctes).toContain("c.tenant_id=$1 AND c.client_id=$2 AND NOT c.is_anonymous");
  });
});

describe("AI Answer isolated data and HTTP", () => {
  let tenantId: number, foreignTenant: number, clientId: number, otherClient: number, foreignClient: number;
  let company: number, otherCompany: number, foreignCompany: number, url: string;
  let server: ReturnType<express.Application["listen"]>;
  const ids: Record<string, number> = {};
  const accounts: Record<string, number> = {};
  async function person(key: string, opts: Record<string, unknown> = {}, t = tenantId, cl = clientId, co = company) {
    const row = await pool.query(`INSERT INTO contacts(tenant_id,client_id,company_id,first_name,email,"function",state,city,country,intent_score,dnc,is_anonymous,title)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
    [t, cl, co, key, `${key}@fixture.invalid`, opts.function === undefined ? "IT" : opts.function,
      opts.state === undefined ? "Delhi" : opts.state, opts.city ?? null, opts.country ?? "India",
      opts.score ?? 55, opts.dnc ?? false, opts.anonymous ?? false, opts.title ?? null]);
    ids[key] = row.rows[0].id;
    return ids[key];
  }
  async function declared(key: string, product = "HP Poly", t = tenantId, cl = clientId, co = company) {
    await pool.query(`INSERT INTO intent_inbound_submissions(tenant_id,client_id,account_id,contact_id,drive_file_id,row_key,file_name,
      classification,classification_reason,product_interest,submitted_at)
      VALUES($1,$2,$3,$4,$5,$5,'AI fixture','warm','Test fixture',$6,'2026-10-01T06:00:00Z')`,
    [t, cl, co, ids[key], randomUUID(), product]);
  }
  async function recorded(key: string, product = "HP Poly", kind = "content") {
    await pool.query(`INSERT INTO hp_bi_records(tenant_id,client_id,account_id,contact_id,kind,occurred_at,product,source,source_key)
      VALUES($1,$2,$3,$4,$5,'2026-10-02T06:00:00Z',$6,'fixture',$7)`,
    [tenantId, clientId, company, ids[key], kind, product, randomUUID()]);
  }
  beforeAll(async () => {
    tenantId = Number((await pool.query("INSERT INTO tenants(name,slug) VALUES('AI Answer fixture',$1) RETURNING id", [randomUUID()])).rows[0].id);
    foreignTenant = Number((await pool.query("INSERT INTO tenants(name,slug) VALUES('AI foreign fixture',$1) RETURNING id", [randomUUID()])).rows[0].id);
    clientId = Number((await pool.query("INSERT INTO clients(tenant_id,name) VALUES($1,'HP') RETURNING id", [tenantId])).rows[0].id);
    otherClient = Number((await pool.query("INSERT INTO clients(tenant_id,name) VALUES($1,'Other') RETURNING id", [tenantId])).rows[0].id);
    foreignClient = Number((await pool.query("INSERT INTO clients(tenant_id,name) VALUES($1,'Foreign HP') RETURNING id", [foreignTenant])).rows[0].id);
    company = Number((await pool.query("INSERT INTO companies(tenant_id,client_id,name,industry) VALUES($1,$2,'AI North Company','Technology') RETURNING id", [tenantId, clientId])).rows[0].id);
    otherCompany = Number((await pool.query("INSERT INTO companies(tenant_id,client_id,name) VALUES($1,$2,'Other Company') RETURNING id", [tenantId, otherClient])).rows[0].id);
    foreignCompany = Number((await pool.query("INSERT INTO companies(tenant_id,client_id,name) VALUES($1,$2,'Foreign Company') RETURNING id", [foreignTenant, foreignClient])).rows[0].id);
    for (const [key, opts] of [
      ["declared", {}], ["engaged", {}], ["negative", {}], ["sales", { function: "Sales" }],
      ["south", { state: "Karnataka" }], ["unknown-location", { state: null }],
      ["unknown-function", { function: null, title: "IT Manager" }], ["polymer", {}],
      ["no-evidence", {}], ["dnc", { dnc: true }], ["both", {}],
      ["anonymous", { anonymous: true }], ["city-fallback", { state: null, city: "Gurugram" }],
      ["conflicting-location", { state: "Karnataka", city: "Delhi" }], ["foreign-country", { country: "USA" }],
      ["journey", {}], ["bot", {}], ["form", {}], ["knowledge-only", {}], ["review-kept", {}],
    ] as [string, Record<string, unknown>][]) await person(key, opts);
    for (const key of ["declared", "sales", "south", "unknown-location", "unknown-function", "dnc", "both", "anonymous", "city-fallback", "conflicting-location", "foreign-country"])
      await declared(key);
    await declared("negative", "Not interested in HP Poly");
    await declared("polymer", "Polymer packaging");
    await declared("both", "HP Print");
    await recorded("engaged");
    await declared("review-kept");
    await pool.query("UPDATE intent_inbound_submissions SET identity_review='keep' WHERE tenant_id=$1 AND contact_id=$2", [tenantId, ids["review-kept"]]);
    const journeyId = (await pool.query("INSERT INTO journeys(tenant_id,client_id,name,slug) VALUES($1,$2,'Poly fixture',$3) RETURNING id",
      [tenantId, clientId, randomUUID()])).rows[0].id;
    const pageId = (await pool.query("INSERT INTO journey_pages(journey_id,title,bi_product) VALUES($1,'HP Poly','HP Poly') RETURNING id", [journeyId])).rows[0].id;
    for (const key of ["journey", "bot"]) {
      const token = randomUUID();
      await pool.query("INSERT INTO visitor_tokens(tenant_id,contact_id,token) VALUES($1,$2,$3)", [tenantId, ids[key], token]);
      await pool.query(`INSERT INTO journey_events(tenant_id,journey_id,page_id,visitor_token,event_type,created_at,is_bot)
        VALUES($1,$2,$3,$4,'page_view','2026-10-02T06:00:00Z',$5)`, [tenantId, journeyId, pageId, token, key === "bot"]);
    }
    const formId = (await pool.query("INSERT INTO journey_forms(tenant_id,name,config) VALUES($1,'Product form',$2::jsonb) RETURNING id",
      [tenantId, JSON.stringify({ fields: [{ id: "answer", mapToContactField: "productInterest" }] })])).rows[0].id;
    await pool.query(`INSERT INTO form_submissions(tenant_id,journey_id,form_id,contact_id,field_values,submitted_at)
      VALUES($1,$2,$3,$4,'{"answer":"HP Poly"}'::jsonb,'2026-10-02T18:30:00Z')`, [tenantId, journeyId, formId, ids.form]);
    await pool.query(`INSERT INTO form_submissions(tenant_id,journey_id,contact_id,field_values,submitted_at)
      VALUES($1,$2,$3,'{"futureTopics":"HP Poly"}'::jsonb,'2026-10-03T06:00:00Z')`, [tenantId, journeyId, ids["knowledge-only"]]);
    await person("other-client", {}, tenantId, otherClient, otherCompany);
    await declared("other-client", "HP Poly", tenantId, otherClient, otherCompany);
    await person("foreign-tenant", {}, foreignTenant, foreignClient, foreignCompany);
    await declared("foreign-tenant", "HP Poly", foreignTenant, foreignClient, foreignCompany);
    for (const name of ["attendance-only", "invitation-only", "email-open-only", "bot-only", "unengaged", "untagged"]) {
      accounts[name] = Number((await pool.query("INSERT INTO companies(tenant_id,client_id,name) VALUES($1,$2,$3) RETURNING id",
        [tenantId, clientId, name])).rows[0].id);
    }
    for (const [name, kind, status] of [["attendance-only", "attendance", null], ["invitation-only", "invitation", null], ["email-open-only", "digital", "email_open"]]) {
      await pool.query(`INSERT INTO hp_bi_records(tenant_id,client_id,account_id,kind,occurred_at,status,source,source_key)
        VALUES($1,$2,$3,$4,'2024-01-01',$5,'fixture',$6)`,
      [tenantId, clientId, accounts[name!], kind, status, randomUUID()]);
    }
    const untaggedPage = Number((await pool.query("INSERT INTO journey_pages(journey_id,title) VALUES($1,'Generic page') RETURNING id", [journeyId])).rows[0].id);
    for (const name of ["bot-only", "untagged"]) {
      await person(name, {}, tenantId, clientId, accounts[name]);
      const token = randomUUID();
      await pool.query("INSERT INTO visitor_tokens(tenant_id,contact_id,token) VALUES($1,$2,$3)", [tenantId, ids[name], token]);
      await pool.query(`INSERT INTO journey_events(tenant_id,journey_id,page_id,visitor_token,event_type,created_at,is_bot)
        VALUES($1,$2,$3,$4,'page_view','2026-10-02T06:00:00Z',$5)`,
      [tenantId, journeyId, untaggedPage, token, name === "bot-only"]);
    }
    const app = express(); app.use(express.json());
    app.use((req: any, _res, next) => {
      req.isAuthenticated = () => req.headers["x-auth"] === "yes";
      req.user = { tenantId, role: "admin", id: null }; req.log = { warn() {} }; next();
    });
    app.use(router);
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>(resolve => server.once("listening", resolve));
    url = `http://127.0.0.1:${(server.address() as any).port}/ai-answer`;
  }, 30_000);
  afterAll(async () => {
    if (server) await new Promise<void>(resolve => server.close(() => resolve()));
    for (const id of [tenantId, foreignTenant].filter(Boolean)) {
      await pool.query("DELETE FROM journey_events WHERE tenant_id=$1", [id]);
      await pool.query("DELETE FROM form_submissions WHERE tenant_id=$1", [id]);
      await pool.query("DELETE FROM visitor_tokens WHERE tenant_id=$1", [id]);
      await pool.query("DELETE FROM journey_forms WHERE tenant_id=$1", [id]);
      await pool.query("DELETE FROM journey_pages WHERE journey_id IN (SELECT id FROM journeys WHERE tenant_id=$1)", [id]);
      for (const table of ["journeys", "hp_bi_records", "intent_inbound_submissions", "contacts", "companies", "clients"])
        await pool.query(`DELETE FROM ${table} WHERE tenant_id=$1`, [id]);
      await pool.query("DELETE FROM tenants WHERE id=$1", [id]);
    }
  });
  it("intersects North India, IT and product evidence; excludes missing, foreign and anonymous identities", async () => {
    const result = await queryAnswerPeople(tenantId, clientId, plan(), 1);
    expect(result.people.map(p => p.id).sort((a, b) => a - b)).toEqual(
      ["declared", "engaged", "journey", "form", "dnc", "both", "city-fallback"].map(k => ids[k]).sort((a, b) => a - b));
    expect(result.total).toBe(7);
    expect(result.people.every(p => p.evidence.length > 0)).toBe(true);
    expect(result.people.find(p => p.id === ids.dnc).dnc).toBe(true);
  });
  it("distinguishes declared from observed and requires all products when requested", async () => {
    expect((await queryAnswerPeople(tenantId, clientId, plan({ interest: "engaged" }), 1)).people.map(p => p.id)).toEqual([ids.engaged, ids.journey]);
    expect((await queryAnswerPeople(tenantId, clientId, plan({ products: ["HP Poly", "HP Print"], productMatch: "all" }), 1)).people.map(p => p.id)).toEqual([ids.both]);
    const explicit = await queryAnswerPeople(tenantId, clientId, plan({ interest: "declared" }), 1);
    expect(explicit.total).toBe(5);
    expect(explicit.people.flatMap(p => p.evidence).every(e => e.basis === "declared")).toBe(true);
  });
  it("requires real general engagement even without a product, and filters evidence dates rather than last_activity", async () => {
    const result = await queryAnswerPeople(tenantId, clientId, plan({
      regions: [], functions: [], products: [], interest: "engaged", since: "2026-10-02", until: "2026-10-02",
    }), 1);
    expect(result.people.map(p => p.id).sort((a, b) => a - b)).toEqual(
      ["engaged", "journey", "untagged"].map(k => ids[k]).sort((a, b) => a - b));
    expect(result.people.some(p => p.id === ids["no-evidence"] || p.id === ids.bot || p.id === ids["bot-only"])).toBe(false);
  });
  it("returns distinct owned accounts, including old contactless attendance and untagged human engagement", async () => {
    const p = simpleEngagedAccountPlan("show me all accounts which have engaged with us at least once")!;
    const result = await queryAnswerAccounts(tenantId, clientId, p, 1);
    expect(result.total).toBe(3);
    expect(result.accounts.map(a => a.id).sort((a, b) => a - b)).toEqual(
      [company, accounts["attendance-only"], accounts.untagged].sort((a, b) => a - b));
    expect(result.accounts.every(a => a.evidence.length && a.matchingRecords >= 1)).toBe(true);
    expect(result.people).toEqual([]);
    const dated = { ...p, groups: [{ ...p.groups[0], since: "2026-10-01" }] };
    expect((await queryAnswerAccounts(tenantId, clientId, dated, 1)).total).toBe(2);
    const product = { ...p, groups: [{ ...p.groups[0], products: ["HP Poly"] }] };
    expect((await queryAnswerAccounts(tenantId, clientId, product, 1)).accounts.map(a => a.id)).toEqual([company]);
    expect(await queryAnswerAccounts(tenantId, clientId, p, 2)).toMatchObject({ total: 3, accounts: [], page: 2 });
  });
  it("applies calendar dates, scores, literal cities and OR groups without dropping conditions", async () => {
    expect((await queryAnswerPeople(tenantId, clientId, plan({ since: "2026-10-04", interest: "declared" }), 1)).total).toBe(0);
    expect((await queryAnswerPeople(tenantId, clientId, plan({ since: "2026-10-03", until: "2026-10-03", interest: "declared" }), 1)).people.map(p => p.id)).toEqual([ids.form]);
    expect((await queryAnswerPeople(tenantId, clientId, plan({ scoreMin: 70 }), 1)).total).toBe(0);
    expect((await queryAnswerPeople(tenantId, clientId, plan({ cities: ["Gurugram"] }), 1)).people.map(p => p.id)).toEqual([ids["city-fallback"]]);
    const p = plan({ cities: ["Gurugram"] });
    p.groups.push(plan({ regions: ["south"], cities: [] }).groups[0]);
    expect((await queryAnswerPeople(tenantId, clientId, p, 1)).people.map(p => p.id).sort((a, b) => a - b))
      .toEqual([ids.south, ids["conflicting-location"], ids["city-fallback"]].sort((a, b) => a - b));
  });
  const post = (data: unknown, authenticated = true) => fetch(url, { method: "POST", headers: {
    "content-type": "application/json", ...(authenticated ? { "x-auth": "yes" } : {}),
  }, body: JSON.stringify(data) });
  it("enforces authentication and tenant-owned client before interpreting a question", async () => {
    expect((await post({ clientId, question: "show me all people" }, false)).status).toBe(401);
    expect((await post({ clientId: foreignClient, question: "show me all people" })).status).toBe(404);
    expect((await post({ clientId, question: "x" })).status).toBe(400);
    expect(mocked.interpret).not.toHaveBeenCalled();
  });
  it("returns exact totals and reuses a validated plan for paging without AI cost", async () => {
    mocked.interpret.mockResolvedValue(plan());
    const first = await post({ clientId, question: "North India IT people interested in HP Poly" });
    expect(first.status).toBe(200);
    const result: any = await first.json();
    expect(result).toMatchObject({ total: 7, pageSize: 25, clarification: [] });
    const second = await post({ clientId, question: result.question, plan: result.plan, page: 2 });
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ total: 7, people: [], page: 2 });
    expect(mocked.interpret).toHaveBeenCalledTimes(1);
  });
  it("asks for clarification instead of silently ignoring unsupported restrictions", async () => {
    mocked.interpret.mockResolvedValue({ ...plan(), unsupported: ["Revenue queries are not supported."] });
    const response = await post({ clientId, question: "North India IT Poly people with revenue over 1 crore" });
    expect(await response.json()).toMatchObject({ people: [], clarification: ["Revenue queries are not supported."] });
  });
  it("returns clarification for unsupported-only plans instead of a 502 or an unrestricted query", async () => {
    const unsupported = answerPlanSchema.parse({ mode: "accounts", groups: [],
      interpretation: "Top 10 Hot accounts with forecasted revenue", unsupported: [
        "Ranking is unsupported by AI Answer.", "Hot qualification is unsupported by AI Answer.", "Revenue forecasts are unsupported by AI Answer.",
      ] });
    mocked.interpret.mockResolvedValue(unsupported);
    const response = await post({ clientId, question: "Show the top 10 Hot accounts with forecasted revenue for next quarter." });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ total: 0, people: [], accounts: [], clarification: unsupported.unsupported });
    const reused = await post({ clientId, question: "Unsupported question", plan: unsupported });
    expect(reused.status).toBe(200);
    expect(await reused.json()).toMatchObject({ clarification: unsupported.unsupported, accounts: [], people: [] });
    expect((await post({ clientId, question: "Empty search", plan: { ...unsupported, unsupported: [] } })).status).toBe(400);
  });
  it("fails explicitly on provider errors and releases its search slot", async () => {
    mocked.interpret.mockRejectedValueOnce(new Error("provider unavailable"));
    expect((await post({ clientId, question: "North India IT people" })).status).toBe(502);
    mocked.interpret.mockResolvedValue(plan());
    expect((await post({ clientId, question: "North India IT Poly people" })).status).toBe(200);
  });
  it("executes the exact reported question without the provider and supports account counts and paging", async () => {
    mocked.interpret.mockClear();
    mocked.interpret.mockRejectedValue(new Error("This simple question must not call the provider"));
    const r = await post({ clientId, question: "sjow me all accounts which have engaged with us at least once" });
    expect(r.status).toBe(200);
    const result: any = await r.json();
    expect(result).toMatchObject({ total: 3, people: [], plan: { mode: "accounts" }, clarification: [] });
    expect(result.accounts).toHaveLength(3);
    const second = await post({ clientId, question: result.question, plan: result.plan, page: 2 });
    expect(await second.json()).toMatchObject({ total: 3, accounts: [], page: 2 });
    const count = await post({ clientId, question: "How many accounts have engaged with us at least once?" });
    expect(await count.json()).toMatchObject({ total: 3, plan: { mode: "account-count" } });
    expect(mocked.interpret).not.toHaveBeenCalled();
    const unsupported = await post({ clientId, question: "Accounts in North India", plan: { ...plan(), mode: "accounts" } });
    expect(await unsupported.json()).toMatchObject({ total: 0, accounts: [], clarification: [expect.stringMatching(/person-level/)] });
  });
});
