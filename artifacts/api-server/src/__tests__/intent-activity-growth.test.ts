import { describe, expect, it } from "vitest";
import { pool } from "@workspace/db";
import { mkdir, writeFile } from "node:fs/promises";
import { PRODUCT_INTENT_ACTIVITY_SQL } from "../lib/productIntentActivityQuery";

// Independent pre-hardening resolver, returning source fields without transport
// deduplication. Compare source ownership and review eligibility, not row order.
const legacy = `
SELECT s.account_id,s.source,s.summary,s.occurred_at,evidence.id AS evidence_id
FROM intent_signals s
JOIN intent_signal_types st ON st.tenant_id=s.tenant_id AND st.id=s.signal_type_id AND st.active
JOIN intent_products p ON p.tenant_id=s.tenant_id AND p.id=s.product_id
JOIN intent_product_categories pc ON pc.tenant_id=p.tenant_id AND pc.id=p.category_id
LEFT JOIN LATERAL (
  SELECT id FROM intent_evidence
  WHERE tenant_id=s.tenant_id AND (signal_id=s.id OR id=CASE WHEN s.payload->>'evidenceId' ~ '^[0-9]{1,9}$'
    THEN (s.payload->>'evidenceId')::int END) AND review_status='approved' ORDER BY id DESC LIMIT 1
) evidence ON true
WHERE s.tenant_id=$1 AND s.product_id=ANY($2::int[]) AND s.account_id=ANY($3::int[])
  AND s.occurred_at>=NOW()-interval '1 year' AND (s.expires_at IS NULL OR s.expires_at>NOW())
  AND (NOT EXISTS(SELECT 1 FROM intent_evidence ie WHERE ie.tenant_id=s.tenant_id AND ie.signal_id=s.id)
    OR EXISTS(SELECT 1 FROM intent_evidence ie WHERE ie.tenant_id=s.tenant_id AND ie.signal_id=s.id AND ie.review_status='approved'))`;

const identity = (rows: Record<string, unknown>[]) => rows.filter(row => row.account_id!=null).map(({ account_id, source, summary, occurred_at, evidence_id }) =>
  JSON.stringify([account_id, source, summary, occurred_at, evidence_id])).sort();

// Apples-to-apples resolver plans omit source projection in BOTH versions.
// The full production query is measured separately, including source transport.
const boundedResolver = PRODUCT_INTENT_ACTIVITY_SQL.slice(0,PRODUCT_INTENT_ACTIVITY_SQL.indexOf(",\nactivity_evidence")) +
  "\nSELECT account_id,source,summary,occurred_at,evidence_id FROM resolved_signals";
// Reuse ONLY the projection expressions so old/new full plans transfer identical
// source facts. Eligibility/resolution above remains an independent legacy SQL.
const contextExpression = PRODUCT_INTENT_ACTIVITY_SQL.slice(
  PRODUCT_INTENT_ACTIVITY_SQL.indexOf("jsonb_build_object('scope'"),
  PRODUCT_INTENT_ACTIVITY_SQL.indexOf(" AS evidence_context,"));
const rawExpression = PRODUCT_INTENT_ACTIVITY_SQL.slice(
  PRODUCT_INTENT_ACTIVITY_SQL.indexOf("jsonb_build_object('excerpt'"),
  PRODUCT_INTENT_ACTIVITY_SQL.indexOf(" AS raw_evidence\n"));
const legacyFull = legacy.replace("evidence.id AS evidence_id",`evidence.id AS evidence_id,
  row_number() OVER (PARTITION BY evidence.id)=1 AS has_activity_evidence,
  CASE WHEN row_number() OVER (PARTITION BY evidence.id)=1 THEN evidence.excerpt END AS evidence_excerpt,
  CASE WHEN row_number() OVER (PARTITION BY evidence.id)=1 THEN ${contextExpression} END AS evidence_context,
  CASE WHEN row_number() OVER (PARTITION BY evidence.id)=1 THEN ${rawExpression} END AS raw_evidence`)
  .replace("SELECT id FROM intent_evidence","SELECT id,excerpt,context,raw_evidence FROM intent_evidence");

type PlanNode = { Plans?: PlanNode[]; [key: string]: unknown };
const planNodes = (node: PlanNode): PlanNode[] => [node,...(node.Plans??[]).flatMap(planNodes)];

describe.skipIf(!process.env.DATABASE_URL)("activity evidence resolution SQL", () => {
  it.skipIf(process.env.INTENT_ACTIVITY_GROWTH !== "1")("inspects read-only plans on the heaviest current development accounts", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN READ ONLY");
      await client.query("SET LOCAL statement_timeout='30s'");
      const { rows: accounts } = await client.query(`SELECT tenant_id,account_id,count(*) AS signals
        FROM intent_signals WHERE product_id IS NOT NULL AND account_id IS NOT NULL
          AND occurred_at>=NOW()-interval '1 year'
        GROUP BY tenant_id,account_id ORDER BY count(*) DESC LIMIT 5`);
      if (!accounts.length) throw new Error("Development history is empty; populate representative data before measuring");
      const tenant = accounts[0].tenant_id;
      const accountIds = accounts.filter(row => row.tenant_id===tenant).map(row => row.account_id);
      const { rows: products } = await client.query("SELECT id FROM intent_products WHERE tenant_id=$1",[tenant]);
      const params = [tenant,products.map(row => row.id),accountIds];
      const expected = await client.query(legacy,params);
      const actual = await client.query(PRODUCT_INTENT_ACTIVITY_SQL,params);
      expect(identity(actual.rows)).toEqual(identity(expected.rows));
      const report: unknown[] = [];
      for (let repeat=0;repeat<3;repeat++) {
        for (const [name,query] of [["legacy",legacy],["bounded",boundedResolver],["legacyFull",legacyFull],["full",PRODUCT_INTENT_ACTIVITY_SQL]]) {
          const { rows } = await client.query(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${query}`,params);
          report.push({repeat,name,plan:rows[0]["QUERY PLAN"][0]});
        }
      }
      const dir = "../../generated-artifacts/intent-activity-growth";
      await mkdir(dir,{recursive:true});
      // Plans/timings only: no excerpts, summaries or provider payloads.
      await writeFile(`${dir}/development-plans.json`,JSON.stringify(report,null,2));
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  },120_000);

  it("matches legacy eligibility and newest approved selection in isolated development histories", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL statement_timeout='30s'");
      // Only temporary tables are written. The application's tables, workers,
      // providers and scores are never touched; all fixtures roll back.
      await client.query(`CREATE TEMP TABLE intent_signals (
        id int PRIMARY KEY,tenant_id int,account_id int,product_id int,signal_type_id int,
        source text,summary text,payload jsonb,occurred_at timestamptz,expires_at timestamptz
      ) ON COMMIT DROP;
      CREATE INDEX ON intent_signals(tenant_id,account_id,occurred_at);
      CREATE TEMP TABLE intent_signal_types(id int,tenant_id int,active boolean) ON COMMIT DROP;
      CREATE TEMP TABLE intent_products(id int,tenant_id int,category_id int) ON COMMIT DROP;
      CREATE TEMP TABLE intent_product_categories(id int,tenant_id int) ON COMMIT DROP;
      CREATE TEMP TABLE intent_evidence(
        id int PRIMARY KEY,tenant_id int,signal_id int,review_status text,excerpt text,context jsonb,raw_evidence jsonb
      ) ON COMMIT DROP;
      CREATE INDEX ON intent_evidence(tenant_id,signal_id);
      INSERT INTO intent_signal_types VALUES (1,7,true),(2,7,false),(1,8,true);
      INSERT INTO intent_products VALUES (1,7,1),(2,7,1),(3,7,99),(1,8,1);
      INSERT INTO intent_product_categories VALUES (1,7),(1,8);
      INSERT INTO intent_signals
      SELECT n,7,8,1,1,'public_event','signal '||n,'{"evidenceId":100}',now()-interval '1 day',NULL
      FROM generate_series(1,20) n;
      INSERT INTO intent_evidence VALUES
        (100,7,NULL,'approved','India source',
          '{"scope":{"country":"India"},"originalExcerpt":"India source","aiReview":{"unused":"not transferred"}}',
          '{"excerpt":"India original","context":{"sourceTitle":"India title","rawEvent":{"data":{"city":"Hyderabad"}}},"unused":"not transferred"}'),
        (101,7,1,'approved','linked newer','{}','{}'),
        (102,7,1,'rejected','not newest approved','{}','{}'),
        (90,7,2,'approved','linked older','{}','{}'),
        (103,7,3,'pending','payload cannot rescue','{}','{}'),
        (104,8,4,'rejected','other tenant cannot veto','{}','{}'),
        (105,8,NULL,'approved','other tenant payload','{}','{}'),
        (106,7,NULL,'rejected','rejected payload','{}','{}'),
        (107,7,NULL,'approved',NULL,'{}','{}'),
        (108,7,20,'approved','signal only','{}','{}');
      UPDATE intent_signals SET payload='{"evidenceId":105}' WHERE id=5;
      UPDATE intent_signals SET payload='{"evidenceId":106}' WHERE id=6;
      UPDATE intent_signals SET payload='{"evidenceId":107}' WHERE id=7;
      UPDATE intent_signals SET payload='{"evidenceId":"9999999999999999999999"}' WHERE id=8;
      UPDATE intent_signals SET payload='{"evidenceId":"invalid"}' WHERE id=9;
      UPDATE intent_signals SET payload='{}' WHERE id IN (10,20);
      UPDATE intent_signals SET expires_at=now() WHERE id=11;
      UPDATE intent_signals SET occurred_at=now()-interval '1 year 1 second' WHERE id=12;
      UPDATE intent_signals SET occurred_at=now()-interval '1 year' WHERE id=13;
      UPDATE intent_signals SET signal_type_id=2 WHERE id=14;
      UPDATE intent_signals SET product_id=3 WHERE id=15;
      UPDATE intent_signals SET product_id=2 WHERE id=16;
      UPDATE intent_signals SET tenant_id=8 WHERE id=17;
      UPDATE intent_signals SET account_id=9 WHERE id=18;
      UPDATE intent_signals SET payload='{"evidenceId":102}' WHERE id=19;`);
      const params = [7, [1], [8]];
      const assertEquivalent = async () => {
        const expected = await client.query(legacy, params);
        const actual = await client.query(PRODUCT_INTENT_ACTIVITY_SQL, params);
        expect(identity(actual.rows)).toEqual(identity(expected.rows));
      // Source ownership/ordering is deliberately unspecified. Normalize transport
        // deduplication before comparing the actual projected source fields.
        const before = (await client.query(legacyFull,params)).rows;
        const sources = (items: typeof before) => items.filter(row => row.evidence_id!=null && row.has_activity_evidence)
          .map(row => JSON.stringify([row.evidence_id,row.evidence_excerpt,row.evidence_context,row.raw_evidence])).sort();
        expect(sources(actual.rows)).toEqual(sources(before));
        return actual.rows;
      };
      const rows = await assertEquivalent();
      const selected = Object.fromEntries(rows.filter(row => row.account_id!=null).map(row => [row.summary, row.evidence_id]));
      expect(selected).toEqual({
        "signal 1":101,"signal 2":100,"signal 4":100,"signal 5":null,"signal 6":null,
        "signal 7":107,"signal 8":null,"signal 9":null,"signal 10":null,"signal 13":100,
        "signal 19":null,"signal 20":108,
      });
      expect(rows.filter(row => row.evidence_id===100 && row.has_activity_evidence)).toHaveLength(1);
      const shared = rows.find(row => row.evidence_id===100 && row.has_activity_evidence)!;
      expect(shared.evidence_context).toEqual({scope:{country:"India"},country:null,originalExcerpt:"India source",aiReview:true});
      expect(shared.raw_evidence.excerpt).toBe("India original");
      expect(shared.raw_evidence.context.rawEvent.data.city).toBe("Hyderabad");
      expect(shared.raw_evidence).not.toHaveProperty("unused");
      await client.query("UPDATE intent_evidence SET review_status='rejected' WHERE id=100");
      expect((await assertEquivalent()).find(row => row.summary==="signal 2")?.evidence_id).toBe(90);

      if (process.env.INTENT_ACTIVITY_GROWTH !== "1") return;
      await client.query(`INSERT INTO intent_signals
        SELECT n,7,8,1,1,'public_event','bulk '||n,'{"evidenceId":107}',now(),NULL
        FROM generate_series(1000,4199) n`);
      const report: unknown[] = [];
      for (const history of [10_000,100_000,500_000]) {
        await client.query(`INSERT INTO intent_evidence
          SELECT n,CASE WHEN n%2=0 THEN 7 ELSE 8 END,1000000+n,
            CASE WHEN n%3=0 THEN 'pending' ELSE 'approved' END,
            'Unrelated India history', '{}',jsonb_build_object('unused',repeat('x',2048))
          FROM generate_series((SELECT GREATEST(COALESCE(max(id),0),1000) + 1 FROM intent_evidence),$1::int) n`, [history+1000]);
        await client.query("ANALYZE intent_evidence; ANALYZE intent_signals");
        await assertEquivalent();
        for (const [name, query] of [["legacy",legacy],["bounded",boundedResolver],["legacyFull",legacyFull],["full",PRODUCT_INTENT_ACTIVITY_SQL]]) {
          const { rows } = await client.query(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${query}`,params);
          const plan = rows[0]["QUERY PLAN"][0];
          if (name==="bounded" || name==="full") {
            const evidenceReads = planNodes(plan.Plan).filter(node => node["Relation Name"]==="intent_evidence");
            expect(evidenceReads.length).toBeGreaterThan(0);
            expect(evidenceReads.every(node => node["Node Type"]==="Index Scan")).toBe(true);
            // Payload/source primary-key probes depend on distinct requested
            // evidence IDs, never the 3,200 signals or unrelated history size.
            for (const read of evidenceReads.filter(node => node["Index Name"]==="intent_evidence_pkey"))
              expect(Number(read["Actual Loops"])).toBeLessThanOrEqual(5);
          }
          report.push({history,name,plan});
          console.log(JSON.stringify({history,name,ms:plan["Execution Time"],blocks:plan.Plan["Shared Hit Blocks"],
            localBlocks:plan.Plan["Local Hit Blocks"],rows:plan.Plan["Actual Rows"]}));
        }
      }
      const dir = "../../generated-artifacts/intent-activity-growth";
      await mkdir(dir,{recursive:true});
      await writeFile(`${dir}/plans.json`,JSON.stringify(report,null,2));
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  },120_000);
});
