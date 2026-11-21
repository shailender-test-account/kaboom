import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  connect: vi.fn(),
  readProductIntentScore: vi.fn(),
  readProductIntentScores: vi.fn(),
  role: "admin" as string,
  googleDriveConnected: vi.fn(),
  previewSource: vi.fn(),
  syncSource: vi.fn(),
}));

vi.mock("@workspace/db", () => ({
  pool: { query: mocks.query, connect: mocks.connect },
  db: {},
}));
vi.mock("../middlewares/requireAuth", async importOriginal => ({
  ...await importOriginal<typeof import("../middlewares/requireAuth")>(),
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { id: 1, tenantId: 7, role: mocks.role };
    next();
  },
}));
vi.mock("../lib/inboundAccounts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/inboundAccounts")>();
  return {
    ...actual,
    googleDriveConnectionAvailable: mocks.googleDriveConnected,
    previewInboundSource: mocks.previewSource,
    syncInboundSource: mocks.syncSource,
  };
});
vi.mock("../utils/segmentFilter", () => ({ buildContactsWhereClause: vi.fn() }));
vi.mock("../lib/alwaysOnIntent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/alwaysOnIntent")>();
  return {
    ...actual,
    readProductIntentActivity: vi.fn(async()=>new Map()),
    ensureIntentDefaults: vi.fn(),
    enqueueIntent: vi.fn(),
    matchEntities: vi.fn(),
    normalizedDomain: vi.fn(),
    recomputeIntent: vi.fn(),
    base2Decay: vi.fn(() => 1),
    saturateRepeatedSignals: vi.fn((values: number[]) => values.reduce((sum, value) => sum + value, 0)),
    readProductIntentScore: mocks.readProductIntentScore,
    readProductIntentScores: mocks.readProductIntentScores,
    selectIntentTier: vi.fn((score: number) => ({ key: score >= 70 ? "hot" : score >= 40 ? "warm" : "cold" })),
  };
});

import router from "../routes/intent";

const app = express().use(express.json()).use(router).use((error: Error, _req: any, res: any, _next: any) => {
  res.status(500).json({ error: error.message });
});
const result = (rows: any[]) => ({ rows, rowCount: rows.length });

const products = [
  { id: 101, name: "HP Anyware Services", category_name: "Software & Services", subcategory_name: "Digital Workspaces" },
  { id: 202, name: "HP Managed Print Services", category_name: "Commercial Printing", subcategory_name: "Enterprise Printing" },
];
const inbound = [
  {
    id: 1,
    form_type: "lead_form",
    account_id: 11,
    classification: "hot",
    classification_reason: "Explicit Anyware interest from a decision-maker with a three-month purchase timeframe.",
    product_interest: "HP Anyware Services",
    submitted_at: new Date("2026-09-22T10:00:00.000Z"),
    created_at: new Date("2026-09-22T10:00:00.000Z"),
  },
  {
    id: 2,
    form_type: "lead_form",
    account_id: 11,
    classification: "warm",
    classification_reason: "Anyware interest without committed timing.",
    product_interest: "HP Anyware Services",
    submitted_at: new Date("2026-09-21T10:00:00.000Z"),
    created_at: new Date("2026-09-21T10:00:00.000Z"),
  },
  {
    id: 3,
    form_type: "lead_form",
    account_id: 22,
    classification: "warm",
    classification_reason: "Anyware interest from a non-decision-maker.",
    product_interest: "HP Anyware Services",
    submitted_at: new Date("2026-09-20T10:00:00.000Z"),
    created_at: new Date("2026-09-20T10:00:00.000Z"),
  },
];

describe("inbound qualification in Intent Engine APIs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.role = "admin";
    mocks.googleDriveConnected.mockResolvedValue(true);
    mocks.previewSource.mockResolvedValue({ files: 1, scannedFiles: 1, fields: [], hasCompanyNameMapping: true, errors: [] });
    mocks.syncSource.mockResolvedValue({ status: "completed", files: 1, imported: 1, skipped: 0, failed: 0, routing: {}, errors: [] });
    const coldScore = { score: 0, tier: "cold", lastSignalAt: null, contributions: [] };
    mocks.readProductIntentScore.mockResolvedValue(coldScore);
    mocks.readProductIntentScores.mockImplementation(async (_tenantId: number, _productIds: number[], accountIds: number[]) =>
      new Map(accountIds.map(accountId => [accountId, coldScore])),
    );
    mocks.query.mockImplementation(async (sql: string, params: any[] = []) => {
      if (sql.includes("FROM intent_inbound_category_rules")) return result([]);
      if (sql.includes("SELECT\n    (SELECT count(*)::int FROM intent_product_categories")) {
        return result([{ categories: 4, subcategories: 24, products: 59 }]);
      }
      if (sql.includes("SELECT id FROM intent_products WHERE tenant_id=$1 AND active=true")) {
        return result(products.map(({ id }) => ({ id })));
      }
      if (sql.includes("SELECT p.id FROM intent_products p") && sql.includes("p.category_id=ANY")) {
        return result(products.filter(product => !params[1] || product.id === params[1]).map(({ id }) => ({ id })));
      }
      if(sql.startsWith("SELECT c.id FROM companies c")&&sql.includes("LEFT JOIN intent_entity_scores"))return result([{id:11},{id:22}]);
      if(sql.includes("SELECT DISTINCT ac.company_id AS id"))return result([]);
      if(sql.startsWith("SELECT (SELECT count(*)::int FROM companies c"))return result([{accounts:2,signals:4}]);
      if(sql.includes("LIMIT $10 OFFSET $9")){
        const candidates=[{id:11,name:"Hot account",domain:"hot.test",industry:"Technology"},
          {id:22,name:"Warm account",domain:"warm.test",industry:"Technology"}];
        return result(candidates.slice(Number(params[8]),Number(params[8])+Number(params[9])));
      }
      if (sql.includes('SELECT c.id,c.name,c.domain,c.industry,c.client_id AS "clientId"')||sql.startsWith("SELECT count(*)::int AS total FROM companies c")) {
        const ranking=JSON.parse(params[8]);
        const rows=[
          { id: 11, name: "Hot account", domain: "hot.test", industry: "Technology" },
          { id: 22, name: "Warm account", domain: "warm.test", industry: "Technology" },
        ].map(row=>({...row,...ranking.find((item:any)=>item.id===row.id)}))
          .filter(row=>!params[9]||params[9].includes(row.tier));
        if(sql.startsWith("SELECT count(*)"))return result([{total:rows.length}]);
        return result(rows.slice(params[12],params[12]+params[11]).map(row=>({...row,total:rows.length})));
      }
      if (sql.includes("SELECT c.id FROM companies c") && sql.includes("intent_inbound_submissions ib")) {
        return result((params[1] as number[]).map(id => ({ id })));
      }
      if (sql.includes("SELECT p.id,p.name,c.name AS category_name")) return result(products);
      if (sql.includes("SELECT s.id,s.account_id,s.product_id")) return result([]);
      if (sql.includes("FROM intent_inbound_submissions") && sql.includes("classification IN ('hot','warm')")) {
        return result(inbound.filter(row => (params[1] as number[]).includes(row.account_id)));
      }
      if (sql.includes("FROM intent_evidence WHERE tenant_id=$1 AND account_id=ANY") || sql.includes("FROM intent_evidence e JOIN companies c ON c.tenant_id=e.tenant_id AND c.id=e.account_id")) return result([]);
      if (sql.includes("FROM intent_tiers WHERE tenant_id=$1 AND active")) {
        return result([
          { key: "cold", label: "Cold", color: "slate", min_score: 0 },
          { key: "warm", label: "Warm", color: "amber", min_score: 40 },
          { key: "hot", label: "Hot", color: "red", min_score: 70 },
        ]);
      }
      if (sql.includes("FROM intent_entity_scores es") && sql.includes("es.account_id=$2")) {
        return result([{
          id: 11,
          name: "Hot account",
          domain: "hot.test",
          industry: "Technology",
          score: 0,
          previousScore: 0,
          trendDelta: 0,
          lastSignalAt: null,
          updatedAt: null,
          contributions: [],
          tierKey: "cold",
          tierLabel: "Cold",
          tierColor: "slate",
        }]);
      }
      if (sql.includes("FROM intent_score_history")) return result([]);
      if (sql.includes("FROM intent_signals s JOIN intent_signal_types")) return result([]);
      if (sql.includes("FROM intent_recommendations")) return result([]);
      if (sql.includes("FROM contacts c JOIN intent_entity_scores")) return result([]);
      if (sql.includes("FROM intent_evidence e LEFT JOIN intent_signals")) return result([]);
      if (sql.includes("SELECT count(*)::int AS count,max(s.occurred_at)")) return result([{ count: 0, latestAt: null }]);
      if (sql.includes("SELECT key,label,color FROM intent_tiers")) {
        const key = params[1];
        return result([{ key, label: key === "hot" ? "Hot" : "Cold", color: key === "hot" ? "red" : "slate" }]);
      }
      throw new Error(`Unexpected pool query: ${sql.slice(0, 140)}`);
    });
  });

  it("keeps shared navigation aggregate-only without canonical qualification",async()=>{
    const response=await request(app).get("/intent/overview?navOnly=true").expect(200);
    expect(response.body).toMatchObject({totalAccounts:2,activeSignals30d:4,hotAccounts:null,qualificationDeferred:true});
    expect(mocks.query.mock.calls.some(([sql])=>String(sql).includes("c.id=ANY"))).toBe(false);
    expect(mocks.query.mock.calls.some(([sql])=>String(sql).includes("s.product_id,p.name"))).toBe(false);
  });

  it("bounds qualification to one batch and continues without reloading previous candidates",async()=>{
    const first=await request(app).get("/intent/accounts?bounded=true&pageSize=1").expect(200);
    expect(first.body).toMatchObject({scanned:1,hasMore:true,nextCursor:1,partial:true});
    expect(first.body.accounts.map((row:any)=>row.id)).toEqual([11]);
    const firstScope=mocks.query.mock.calls.find(([sql])=>String(sql).startsWith("SELECT c.id FROM companies c")&&String(sql).includes("c.id=ANY"));
    expect(firstScope?.[1]).toEqual([7,[11]]);
    const second=await request(app).get("/intent/accounts?bounded=true&pageSize=1&cursor=1").expect(200);
    expect(second.body).toMatchObject({scanned:1,hasMore:false,nextCursor:null});
    expect(second.body.accounts.map((row:any)=>row.id)).toEqual([22]);
    expect(mocks.query.mock.calls.some(([sql])=>String(sql).includes("jsonb_to_recordset"))).toBe(false);
  });

  it("keeps an empty filtered batch resumable and rejects invalid cursors",async()=>{
    const result=await request(app).get("/intent/accounts?bounded=true&pageSize=1&tier=cold").expect(200);
    expect(result.body).toMatchObject({accounts:[],scanned:1,hasMore:true,nextCursor:1});
    await request(app).get("/intent/accounts?bounded=true&cursor=-1").expect(400);
  });

  it("loads public evidence once per batch and re-reads corrections on the next request",async()=>{
    const implementation=mocks.query.getMockImplementation()!;
    let corrected=false;
    mocks.query.mockImplementation(async(sql:string,params:any[]=[])=>{
      const response=await implementation(sql,params);
      if(corrected&&sql.includes("FROM intent_inbound_submissions")&&sql.includes("classification IN ('hot','warm')")){
        return result(response.rows.map((row:any)=>({...row,classification:"warm",classification_reason:"Corrected purchase timeframe."})));
      }
      return response;
    });
    const first=await request(app).get("/intent/accounts?bounded=true&pageSize=1").expect(200);
    expect(first.body.accounts[0]).toMatchObject({id:11,tierKey:"hot",score:100});
    const evidenceReads=()=>mocks.query.mock.calls.filter(([sql])=>String(sql).includes("FROM intent_evidence e JOIN companies c"));
    expect(evidenceReads()).toHaveLength(1);
    expect(evidenceReads()[0][1]).toEqual([7,[11]]);
    corrected=true;
    const second=await request(app).get("/intent/accounts?bounded=true&pageSize=1").expect(200);
    expect(second.body.accounts[0]).toMatchObject({id:11,tierKey:"warm",score:50});
    expect(evidenceReads()).toHaveLength(2);
  });

  it("scans at most five candidates with all prefilters and reports only loaded matches",async()=>{
    const implementation=mocks.query.getMockImplementation()!;
    mocks.query.mockImplementation(async(sql:string,params:any[]=[])=>{
      if(sql.includes("LIMIT $10 OFFSET $9")){
        expect(params.slice(0,8)).toEqual([7,3,9,"%Acme%","public_event","%India%",null,null]);
        expect(params.slice(8)).toEqual([0,6]);
        return result([11,22,33,44,55,66].map(id=>({id,name:`Account ${id}`})));
      }
      return implementation(sql,params);
    });
    const response=await request(app).get("/intent/accounts?bounded=true&pageSize=100&tier=hot&clientId=3&audienceId=9&search=Acme&source=public_event&country=India").expect(200);
    expect(response.body).toMatchObject({partial:true,scanned:5,pageSize:5,hasMore:true,nextCursor:5,total:1,totalPages:1});
    expect(response.body.accounts.map((row:any)=>row.id)).toEqual([11]);
    const evidenceRead=mocks.query.mock.calls.find(([sql])=>String(sql).includes("FROM intent_evidence e JOIN companies c"));
    expect(evidenceRead?.[1]).toEqual([7,[11,22,33,44,55]]);
  });

  it("keeps list, detail, product affinity, and unrelated scopes aligned", async () => {
    const list = await request(app).get("/intent/accounts");
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    expect(list.body.accounts).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 11, tierKey: "hot", score: 100 }),
      expect.objectContaining({ id: 22, tierKey: "warm", score: 50 }),
    ]));

    const detail = await request(app).get("/intent/accounts/11").expect(200);
    expect(detail.body).toMatchObject({
      tierKey: "hot",
      score: 100,
      productAnalysis: {
        inboundIntent: {
          classification: "hot",
          affinities: ["HP Anyware Services"],
        },
      },
      intentStatus: {
        accountStatus: "hot",
        accountExplanation: expect.stringContaining("first-party inbound qualification"),
        accountDrivingSignals: [
          expect.objectContaining({
            signalType: "lead_form",
            quote: "Explicit Anyware interest from a decision-maker with a three-month purchase timeframe.",
          }),
        ],
      },
    });

    const unrelated = await request(app).get("/intent/accounts?productId=202").expect(200);
    expect(unrelated.body.accounts).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 11, tierKey: "cold", score: 0 }),
      expect.objectContaining({ id: 22, tierKey: "cold", score: 0 }),
    ]));
  });

  it("filters and paginates by canonical inbound tier rather than stored score order", async () => {
    const original = mocks.query.getMockImplementation()!;
    const candidates = [...Array.from({ length: 24 }, (_, index) => ({
      id: 100 + index, name: `Cold ${index}`, total: 26,
    })), { id: 22, name: "Warm account", total: 26 }, { id: 11, name: "Hot account", total: 26 }];
    mocks.query.mockImplementation((sql: string, params: any[] = []) => {
      if(sql.startsWith("SELECT c.id FROM companies c")&&sql.includes("LEFT JOIN intent_entity_scores"))
        return Promise.resolve(result(candidates.map(({id})=>({id}))));
      return original(sql, params);
    });

    const hot = await request(app).get("/intent/accounts?tier=hot&pageSize=1").expect(200);
    expect(hot.body).toMatchObject({ total: 1, totalPages: 1, accounts: [{ id: 11, tierKey: "hot" }] });
    const next = await request(app).get("/intent/accounts?tier=hot&pageSize=1&page=2").expect(200);
    expect(next.body).toMatchObject({ total: 1, totalPages: 1, accounts: [] });
    const warm = await request(app).get("/intent/accounts?tier=warm&pageSize=1").expect(200);
    expect(warm.body).toMatchObject({ total: 1, totalPages: 1, accounts: [{ id: 22, tierKey: "warm" }] });
  });

  it("relinks only the reviewed response to the email owner without merging contacts or history", async () => {
    const statements:string[]=[];
    const client={release:vi.fn(),query:vi.fn(async(sql:string)=>{
      statements.push(sql);
      if(sql.includes("FROM intent_inbound_submissions s"))return result([{
        tenant_id:7,id:91,account_id:11,contact_id:null,client_id:8,
        identity_review:null,reviewed_source_account_id:null,
        raw_fields:{Email:"owner@example.test",Phone:"555-0100"},field_mappings:{},
        routing_status:"error",
      }]);
      if(sql.includes("FROM contacts WHERE tenant_id"))return result([{id:32,company_id:22,client_id:8}]);
      return result([]);
    })};
    mocks.connect.mockResolvedValue(client);
    const response=await request(app).post("/intent/inbound/responses/91/identity-review").send({
      action:"relink",ownerContactId:32,sourceAccountId:11,sourceContactId:null,email:"owner@example.test",
    }).expect(200);
    expect(response.body).toEqual({review:"relink"});
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining("UPDATE intent_inbound_submissions SET"),
      [22,32,"relink","owner@example.test",11,"pending",null,7,91,null,expect.any(Number)]);
    expect(statements.some(sql=>sql.includes("identity_reviewed_by=$11,identity_reviewed_at=NOW()"))).toBe(true);
    expect(statements).not.toEqual(expect.arrayContaining([expect.stringMatching(/DELETE|UPDATE contacts|UPDATE sequence_enrollments/)]));
    expect(statements.at(-1)).toBe("COMMIT");
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("shows source phone and account evidence beside the cross-account email owner", async () => {
    mocks.query.mockImplementation(async(sql:string)=>{
      if(sql.includes("SELECT name FROM companies"))return result([{name:"Source Co"}]);
      if(sql.includes("FROM intent_inbound_submissions s")&&sql.includes('AS "answers"'))return result([{
        id:91,accountId:11,clientId:8,contactId:null,identityReview:"keep",reviewedSourceAccountId:null,
        identityReviewedBy:7,identityReviewerName:"Sam Admin",identityReviewedAt:new Date("2026-09-27T10:00:00Z"),
        answers:{Email:"owner@example.test",Phone:"555-0100",Name:"Alex Smith"},
        fieldMappings:{},affinityReviews:{},productInterest:null,
      }]);
      if(sql.includes("FROM intent_products p JOIN intent_product_categories")||sql.includes("FROM intent_inbound_category_rules"))return result([]);
      if(sql.includes("FROM contacts ct LEFT JOIN companies"))return result([
        {id:30,accountId:11,clientId:8,name:"Alex Other",email:null,phone:"555-0100",accountName:"Source Co"},
        {id:32,accountId:22,clientId:8,name:"Alex Smith",email:"owner@example.test",phone:"555-0900",accountName:"Owner Co"},
      ]);
      if(sql.includes("SELECT id,name FROM companies"))return result([{id:11,name:"Source Co"}]);
      throw new Error(`Unexpected query: ${sql}`);
    });
    const response=await request(app).get("/intent/inbound/accounts/11/responses");
    expect(response.status,JSON.stringify(response.body)).toBe(200);
    expect(response.body.responses[0].identityConflict).toMatchObject({
      email:"owner@example.test",sourceAccountName:"Source Co",
      sourceContact:{id:30,phone:"555-0100",accountName:"Source Co"},
      owner:{id:32,phone:"555-0900",accountName:"Owner Co"},canRelink:true,
      review:"keep",reviewedById:7,reviewedByName:"Sam Admin",
      reviewedAt:"2026-09-27T10:00:00.000Z",
    });
  });

  it("refuses identity review if the email owner changed account", async () => {
    const client={release:vi.fn(),query:vi.fn(async(sql:string)=>{
      if(sql.includes("FROM intent_inbound_submissions s"))return result([{
        account_id:11,contact_id:null,client_id:8,raw_fields:{Email:"owner@example.test"},field_mappings:{},
      }]);
      if(sql.includes("FROM contacts WHERE tenant_id"))return result([{id:32,company_id:11,client_id:8}]);
      return result([]);
    })};
    mocks.connect.mockResolvedValue(client);
    await request(app).post("/intent/inbound/responses/91/identity-review").send({
      action:"relink",ownerContactId:32,sourceAccountId:11,sourceContactId:null,email:"owner@example.test",
    }).expect(409);
    expect(client.query).not.toHaveBeenCalledWith(expect.stringContaining("UPDATE intent_inbound_submissions SET"),expect.anything());
    expect(client.query).toHaveBeenCalledWith("ROLLBACK");
  });

  it("creates separate source records with independent IDs and never edits the first source",async()=>{
    let nextId=40;
    mocks.query.mockImplementation(async(sql:string,params:any[]=[])=>
      sql.includes("FROM clients")?result([{one:1}])
      :sql.includes("INSERT INTO intent_inbound_sources")?result([{
        id:nextId++,name:params[2],clientId:params[1],folderUrl:params[3],formType:params[5],
        enabled:params[6],fieldMappings:params[7],lastSyncedAt:null,lastSyncStatus:"never",lastSyncSummary:{},
      }])
      :result([]));
    const payload=(folder:string)=>({clientId:8,name:folder,folderUrl:`https://drive.google.com/drive/folders/${folder}`,formType:"lead_form"});
    const first=await request(app).post("/intent/inbound/sources").send(payload("folderA")).expect(201);
    const second=await request(app).post("/intent/inbound/sources").send(payload("folderB")).expect(201);
    expect([first.body.source.id,second.body.source.id]).toEqual([40,41]);
    expect(mocks.query.mock.calls.filter(([sql])=>String(sql).includes("INSERT INTO intent_inbound_sources"))).toHaveLength(2);
    expect(mocks.query).not.toHaveBeenCalledWith(expect.stringContaining("UPDATE intent_inbound_sources"),expect.anything());
  });

  it("restricts source mutations to admins and reports duplicate folders as a friendly conflict",async()=>{
    mocks.role="member";
    await request(app).post("/intent/inbound/sources").send({
      clientId:8,folderUrl:"https://drive.google.com/drive/folders/folderA",formType:"lead_form",
    }).expect(403);
    expect(mocks.query).not.toHaveBeenCalled();

    mocks.role="admin";
    mocks.query.mockImplementation(async(sql:string)=>{
      if(sql.includes("FROM clients"))return result([{one:1}]);
      if(sql.includes("INSERT INTO intent_inbound_sources"))throw Object.assign(new Error("unique"),{code:"23505"});
      return result([]);
    });
    const duplicate=await request(app).post("/intent/inbound/sources").send({
      clientId:8,folderUrl:"https://drive.google.com/drive/folders/folderA",formType:"lead_form",
    }).expect(409);
    expect(duplicate.body.error).toMatch(/already configured/);
  });

  it("lists only tenant sources and previews or syncs the explicitly selected source",async()=>{
    mocks.query.mockImplementation(async(sql:string,params:any[]=[])=>
      sql.includes("SELECT id,name,client_id AS")?result([{id:40,name:"First",clientId:8}])
      :sql.includes("SELECT enabled FROM intent_inbound_sources")?result([{enabled:true}])
      :sql.includes("FROM intent_inbound_sources")?result([{one:1}])
      :result([]));
    const list=await request(app).get("/intent/inbound/sources").expect(200);
    expect(list.body).toMatchObject({sources:[{id:40,name:"First"}],googleDriveConnected:true});
    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining("FROM intent_inbound_sources WHERE tenant_id=$1 ORDER BY id"),[7]);
    await request(app).get("/intent/inbound/sources/41/preview").expect(200);
    await request(app).post("/intent/inbound/sources/41/sync").expect(200);
    expect(mocks.previewSource).toHaveBeenCalledWith(7,41);
    expect(mocks.syncSource).toHaveBeenCalledWith(7,41);
  });

  it("keeps source previews admin-only because preview results contain sample values",async()=>{
    mocks.role="editor";
    await request(app).get("/intent/inbound/sources/41/preview").expect(403);
    expect(mocks.previewSource).not.toHaveBeenCalled();
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("validates optional dashboard source IDs against the current tenant",async()=>{
    await request(app).get("/intent/inbound/dashboard?sourceId=not-an-id").expect(400);
    mocks.query.mockResolvedValue(result([]));
    await request(app).get("/intent/inbound/dashboard?sourceId=41").expect(404);
  });

  it("refuses to change campaign identity after a source imported submissions",async()=>{
    const client={release:vi.fn(),query:vi.fn(async(sql:string)=>{
      if(sql.includes("SELECT id,client_id,folder_id,form_type"))return result([{id:40,client_id:8,folder_id:"folderA",form_type:"lead_form"}]);
      if(sql.includes("AS has_submissions"))return result([{has_submissions:true}]);
      return result([]);
    })};
    mocks.connect.mockResolvedValue(client);
    mocks.query.mockResolvedValue(result([{one:1}]));
    const response=await request(app).put("/intent/inbound/sources/40").send({
      clientId:8,name:"Changed",folderUrl:"https://drive.google.com/drive/folders/folderB",formType:"event_feedback",
    }).expect(409);
    expect(response.body.error).toMatch(/Create a new inbound source/);
    expect(client.query).not.toHaveBeenCalledWith(expect.stringContaining("UPDATE intent_inbound_sources"),expect.anything());
    expect(client.query).toHaveBeenCalledWith("ROLLBACK");
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("applies the imported-source identity guard to the legacy singleton update",async()=>{
    const client={release:vi.fn(),query:vi.fn(async(sql:string)=>{
      if(sql.includes("SELECT id,client_id,folder_id,form_type"))return result([{id:40,client_id:8,folder_id:"folderA",form_type:"lead_form"}]);
      if(sql.includes("AS has_submissions"))return result([{has_submissions:true}]);
      return result([]);
    })};
    mocks.connect.mockResolvedValue(client);
    mocks.query.mockImplementation(async(sql:string)=>
      sql.includes("FROM clients")?result([{one:1}])
      :sql.includes("SELECT id FROM intent_inbound_sources")?result([{id:40}])
      :result([]));
    const response=await request(app).put("/intent/inbound/source").send({
      clientId:8,name:"Legacy edit",folderUrl:"https://drive.google.com/drive/folders/folderB",formType:"event_feedback",
    }).expect(409);
    expect(response.body.error).toMatch(/Create a new inbound source/);
    expect(client.query).not.toHaveBeenCalledWith(expect.stringContaining("UPDATE intent_inbound_sources"),expect.anything());
    expect(client.query).toHaveBeenCalledWith("ROLLBACK");
  });

  it("does not let legacy sync skip a disabled first source in favor of a later source",async()=>{
    mocks.query.mockImplementation(async(sql:string)=>
      sql.includes("FROM intent_inbound_sources")?result([{id:40,enabled:false}])
      :result([]));
    const response=await request(app).post("/intent/inbound/source/sync").expect(409);
    expect(response.body.error).toMatch(/first configured/);
    expect(mocks.query).toHaveBeenCalledWith(
      "SELECT id,enabled FROM intent_inbound_sources WHERE tenant_id=$1 ORDER BY id LIMIT 1",[7],
    );
    expect(mocks.syncSource).not.toHaveBeenCalled();
  });

  it("filters account response history to the selected tenant source",async()=>{
    mocks.query.mockImplementation(async(sql:string,params:any[]=[])=>
      sql.includes("SELECT 1 FROM intent_inbound_sources")?result([{one:1}])
      :sql.includes("SELECT name FROM companies")?result([{name:"Acme"}])
      :sql.includes("FROM intent_inbound_submissions s")&&sql.includes('AS "answers"')?result([])
      :result([]));
    await request(app).get("/intent/inbound/accounts/11/responses?sourceId=42").expect(200);
    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringContaining("WHERE s.tenant_id=$1 AND s.account_id=$2 AND ($3::int IS NULL OR s.source_id=$3)"),
      [7,11,42],
    );
  });
});