import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { pool } from "@workspace/db";
import {
  activityCompanyFilter,
  activityClientFilter,
  companyIdFilter,
  inboundCompanySelectionQuery,
  journeyCompanyFilter,
  journeyClientFilter,
  parseCompanySelection,
  rawCallAnalysisContactColumn,
  rawContactCompanyFilter,
  selectedCompanySelectionQuery,
} from "../routes/analytics";

const dialect = new PgDialect();

describe.skipIf(!process.env.DATABASE_URL)("analytics company scoping SQL", () => {
  it("executes single/multiple account filters and inbound-only cohorts, including empty cohorts", async () => {
    const client = await pool.connect();
    const run = async (statement: ReturnType<typeof sql>) => {
      const compiled = dialect.sqlToQuery(statement);
      return client.query(compiled.sql, compiled.params);
    };
    try {
      await client.query("BEGIN");
      await client.query(`CREATE TEMP TABLE companies (
        id int, tenant_id int, client_id int, inbound_manual boolean, inbound_manual_at timestamptz
      ) ON COMMIT DROP`);
      await client.query(`CREATE TEMP TABLE intent_inbound_submissions (
        id int, tenant_id int, client_id int, account_id int, source_id int,
        raw_fields jsonb, created_at timestamptz
      ) ON COMMIT DROP`);
      await client.query(`CREATE TEMP TABLE contacts (
        id int, tenant_id int, company_id int
      ) ON COMMIT DROP`);
      await client.query(`CREATE TEMP TABLE activity_events (
        id int, tenant_id int, company_id int, contact_id int,
        visitor_token text, journey_id int, client_id int, created_at timestamptz
      ) ON COMMIT DROP`);
      await client.query(`CREATE TEMP TABLE call_logs (
        id int, tenant_id int, contact_id int
      ) ON COMMIT DROP`);
      await client.query(`CREATE TEMP TABLE call_analysis (
        id int, tenant_id int, call_log_id int, contact_id int
      ) ON COMMIT DROP`);
      await client.query(`CREATE TEMP TABLE journey_events (
        id int, tenant_id int, visitor_token text, journey_id int, created_at timestamptz
      ) ON COMMIT DROP`);
      await client.query(`CREATE TEMP TABLE verified_journey_sessions (
        id int, tenant_id int, account_id int, event_ids int[], activity_event_ids int[], revoked_at timestamptz
      ) ON COMMIT DROP`);
      await client.query(`CREATE TEMP TABLE journeys (
        id int, tenant_id int, client_id int
      ) ON COMMIT DROP`);
      await client.query(`CREATE TEMP TABLE visitor_tokens (
        tenant_id int, token text, contact_id int
      ) ON COMMIT DROP`);
      await client.query(`CREATE TEMP TABLE form_submissions (
        tenant_id int, visitor_token text, contact_id int, submitted_at timestamptz
      ) ON COMMIT DROP`);

      await client.query(`INSERT INTO companies(id,tenant_id,client_id,inbound_manual) VALUES
        (100,7,10,false), (101,7,10,true), (102,7,10,false),
        (103,7,11,true), (104,8,10,true)`);
      await client.query(`INSERT INTO intent_inbound_submissions(tenant_id,client_id,account_id) VALUES (7,10,100)`);
      await client.query(`INSERT INTO contacts VALUES (1,7,100), (2,7,101)`);
      await client.query(`INSERT INTO activity_events(id,tenant_id,company_id,contact_id) VALUES
        (1,7,NULL,1), (2,7,101,1), (3,7,NULL,2)`);
      await client.query(`INSERT INTO call_logs VALUES (1,7,1), (2,7,2), (3,8,1)`);
      await client.query(`INSERT INTO call_analysis VALUES (1,7,1,NULL), (2,7,NULL,2)`);
      await client.query(`INSERT INTO journey_events(id,tenant_id,visitor_token) VALUES
        (1,7,'visitor-token'), (2,7,'form-token'), (3,7,'anonymous-token')`);
      await client.query(`INSERT INTO visitor_tokens VALUES (7,'visitor-token',1)`);
      await client.query(`INSERT INTO form_submissions VALUES
        (7,'form-token',2,'2026-02-01T00:00:00Z')`);

      const singleSelection = parseCompanySelection({ companyId: "100" });
      const multipleSelection = parseCompanySelection({ companyIds: "100,101" });
      expect(singleSelection.companyIds).toEqual([100]);
      expect(multipleSelection.companyIds).toEqual([100, 101]);

      const validSingleSelection = await run(selectedCompanySelectionQuery(7, singleSelection.companyIds!, 10));
      expect(validSingleSelection.rows.map((row: any) => row.id)).toEqual([100]);
      const validMultipleSelection = await run(selectedCompanySelectionQuery(7, multipleSelection.companyIds!, 10));
      expect(validMultipleSelection.rows.map((row: any) => row.id)).toEqual([100, 101]);
      const wrongClientSelection = await run(selectedCompanySelectionQuery(7, [103], 10));
      expect(wrongClientSelection.rows).toEqual([]);
      const wrongTenantSelection = await run(selectedCompanySelectionQuery(8, [100], 10));
      expect(wrongTenantSelection.rows).toEqual([]);

      const oneAccount = await run(sql`
        SELECT id FROM companies WHERE tenant_id=7
          ${companyIdFilter(sql`id`, singleSelection.companyIds)} ORDER BY id
      `);
      expect(oneAccount.rows.map((row: any) => row.id)).toEqual([100]);

      const multipleAccounts = await run(sql`
        SELECT id FROM companies WHERE tenant_id=7
          ${companyIdFilter(sql`id`, multipleSelection.companyIds)} ORDER BY id
      `);
      expect(multipleAccounts.rows.map((row: any) => row.id)).toEqual([100, 101]);

      const activityOne = await run(sql`
        SELECT ae.id FROM activity_events ae WHERE ae.tenant_id=7
          ${activityCompanyFilter("ae", [100])} ORDER BY ae.id
      `);
      expect(activityOne.rows.map((row: any) => row.id)).toEqual([1]);
      const activityMany = await run(sql`
        SELECT ae.id FROM activity_events ae WHERE ae.tenant_id=7
          ${activityCompanyFilter("ae", [100, 101])} ORDER BY ae.id
      `);
      expect(activityMany.rows.map((row: any) => row.id)).toEqual([1, 2, 3]);
      const activityEmpty = await run(sql`
        SELECT ae.id FROM activity_events ae WHERE ae.tenant_id=7
          ${activityCompanyFilter("ae", [])}
      `);
      expect(activityEmpty.rows).toEqual([]);

      const journeyOne = await run(sql`
        SELECT je.id FROM journey_events je WHERE je.tenant_id=7
          ${journeyCompanyFilter([100])} ORDER BY je.id
      `);
      expect(journeyOne.rows.map((row: any) => row.id)).toEqual([1]);
      const journeyMany = await run(sql`
        SELECT je.id FROM journey_events je WHERE je.tenant_id=7
          ${journeyCompanyFilter([100, 101])} ORDER BY je.id
      `);
      expect(journeyMany.rows.map((row: any) => row.id)).toEqual([1, 2]);
      const journeyEmpty = await run(sql`
        SELECT je.id FROM journey_events je WHERE je.tenant_id=7
          ${journeyCompanyFilter([])}
      `);
      expect(journeyEmpty.rows).toEqual([]);

      const abmRows = await run(sql`
        SELECT je.id, c.company_id
        FROM journey_events je
        LEFT JOIN visitor_tokens vt ON vt.token=je.visitor_token AND vt.tenant_id=je.tenant_id
        LEFT JOIN LATERAL (
          SELECT contact_id FROM form_submissions fs
          WHERE fs.tenant_id=je.tenant_id AND fs.visitor_token=je.visitor_token
            AND fs.contact_id IS NOT NULL
          ORDER BY fs.submitted_at DESC LIMIT 1
        ) fs ON TRUE
        LEFT JOIN contacts c ON c.id=COALESCE(vt.contact_id,fs.contact_id) AND c.tenant_id=je.tenant_id
        WHERE je.tenant_id=7
          ${journeyCompanyFilter([100, 101])}
          ${companyIdFilter(sql`c.company_id`, [100, 101])}
        ORDER BY je.id
      `);
      expect(abmRows.rows.map((row: any) => row.id)).toEqual([1, 2]);
      const abmCount = await run(sql`
        SELECT COUNT(*)::int AS total
        FROM journey_events je
        LEFT JOIN visitor_tokens vt ON vt.token=je.visitor_token AND vt.tenant_id=je.tenant_id
        LEFT JOIN LATERAL (
          SELECT contact_id FROM form_submissions fs
          WHERE fs.tenant_id=je.tenant_id AND fs.visitor_token=je.visitor_token
            AND fs.contact_id IS NOT NULL
          ORDER BY fs.submitted_at DESC LIMIT 1
        ) fs ON TRUE
        LEFT JOIN contacts c ON c.id=COALESCE(vt.contact_id,fs.contact_id) AND c.tenant_id=je.tenant_id
        WHERE je.tenant_id=7
          ${journeyCompanyFilter([100, 101])}
          ${companyIdFilter(sql`c.company_id`, [100, 101])}
          AND NOT EXISTS (
            SELECT 1 FROM activity_events ae2
            WHERE ae2.tenant_id=je.tenant_id
              ${activityCompanyFilter("ae2", [100, 101])}
              AND ae2.contact_id=COALESCE(vt.contact_id,fs.contact_id)
          )
      `);
      expect(abmCount.rows[0].total).toBe(0);

      const inboundOnly = await run(inboundCompanySelectionQuery(7, 10));
      expect(inboundOnly.rows.map((row: any) => row.id).sort()).toEqual([100, 101]);
      const inboundOnlyStats = await run(sql`
        SELECT count(*)::int AS total FROM companies WHERE tenant_id=7
          ${companyIdFilter(sql`id`, inboundOnly.rows.map((row: any) => Number(row.id)))}
      `);
      expect(inboundOnlyStats.rows[0].total).toBe(2);

      const noEligibleInboundAccounts = await run(inboundCompanySelectionQuery(7, 12));
      expect(noEligibleInboundAccounts.rows).toEqual([]);
      const emptyInboundStats = await run(sql`
        SELECT count(*)::int AS total FROM companies WHERE tenant_id=7
          ${companyIdFilter(sql`id`, noEligibleInboundAccounts.rows.map((row: any) => Number(row.id)))}
      `);
      expect(emptyInboundStats.rows[0].total).toBe(0);

      // An admin-reviewed same-person link moves only eligible journey visits,
      // not other journeys or visits before the manual account existed.
      await client.query(`INSERT INTO journeys VALUES (9,7,10),(10,7,11)`);
      await client.query(`UPDATE activity_events SET client_id=11 WHERE id=1`);
      await client.query(`UPDATE companies SET inbound_manual_at='2026-09-28T00:00:00Z' WHERE id=101`);
      await client.query(`INSERT INTO intent_inbound_submissions(id,tenant_id,client_id,account_id,source_id,raw_fields,created_at)
        VALUES (11,7,10,101,NULL,'{"manualProvenance":"manual","trackedContact":{"contactId":1,"journeyId":9}}'::jsonb,'2026-09-28T00:00:00Z')`);
      await client.query(`UPDATE activity_events SET journey_id=9,created_at='2026-09-28T12:00:00Z' WHERE id=1`);
      await client.query(`UPDATE journey_events SET journey_id=9,created_at='2026-09-28T12:00:00Z' WHERE id=1`);
      await client.query(`INSERT INTO activity_events(id,tenant_id,company_id,contact_id,journey_id,created_at)
        VALUES (4,7,NULL,1,10,'2026-09-28T12:00:00Z'),(5,7,NULL,1,9,'2026-09-27T12:00:00Z')`);
      await client.query(`INSERT INTO journey_events(id,tenant_id,visitor_token,journey_id,created_at)
        VALUES (4,7,'visitor-token',10,'2026-09-28T12:00:00Z'),
               (5,7,'visitor-token',9,'2026-09-27T12:00:00Z')`);
      const linkedActivity = await run(sql`SELECT ae.id FROM activity_events ae WHERE ae.tenant_id=7
        ${activityCompanyFilter("ae", [101])} ORDER BY ae.id`);
      expect(linkedActivity.rows.map((row: any) => row.id)).toEqual([1, 2, 3]);
      const scopedActivity = await run(sql`SELECT ae.id FROM activity_events ae WHERE ae.tenant_id=7
        ${activityCompanyFilter("ae", [101])} ${activityClientFilter("ae", 10)} ORDER BY ae.id`);
      expect(scopedActivity.rows.map((row: any) => row.id)).toEqual([1]);
      const retainedActivity = await run(sql`SELECT ae.id FROM activity_events ae WHERE ae.tenant_id=7
        ${activityCompanyFilter("ae", [100])} ORDER BY ae.id`);
      expect(retainedActivity.rows.map((row: any) => row.id)).toEqual([4, 5]);
      const linkedJourney = await run(sql`SELECT je.id FROM journey_events je WHERE je.tenant_id=7
        ${journeyCompanyFilter([101])} ORDER BY je.id`);
      expect(linkedJourney.rows.map((row: any) => row.id)).toEqual([1, 2]);
      const scopedJourney = await run(sql`SELECT je.id FROM journey_events je WHERE je.tenant_id=7
        ${journeyCompanyFilter([101])} ${journeyClientFilter(10)} ORDER BY je.id`);
      expect(scopedJourney.rows.map((row: any) => row.id)).toEqual([1]);
      const retainedJourney = await run(sql`SELECT je.id FROM journey_events je WHERE je.tenant_id=7
        ${journeyCompanyFilter([100])} ORDER BY je.id`);
      expect(retainedJourney.rows.map((row: any) => row.id)).toEqual([4, 5]);
      await client.query(`UPDATE intent_inbound_submissions SET raw_fields=
        jsonb_set(raw_fields,'{trackedContact,effectiveFrom}','"2026-09-26T00:00:00.000Z"'::jsonb)
        WHERE id=11`);
      const backdatedJourney = await run(sql`SELECT je.id FROM journey_events je WHERE je.tenant_id=7
        ${journeyCompanyFilter([101])} ORDER BY je.id`);
      expect(backdatedJourney.rows.map((row: any) => row.id)).toEqual([1, 2, 5]);
      // Explicitly verified event IDs must not claim another event sharing
      // the browser token, another journey, or another tenant.
      await client.query(`INSERT INTO journey_events(id,tenant_id,visitor_token,journey_id,created_at) VALUES
        (6,7,'anonymous-token',9,'2026-09-28T12:00:00Z'),
        (7,7,'anonymous-token',9,'2026-09-28T13:00:00Z'),
        (8,7,'anonymous-token',10,'2026-09-28T12:00:00Z')`);
      await client.query(`INSERT INTO activity_events(id,tenant_id,company_id,contact_id,visitor_token,journey_id,created_at)
        VALUES (6,7,NULL,NULL,'anonymous-token',9,'2026-09-28T12:00:00Z'),
               (7,7,NULL,NULL,'anonymous-token',9,'2026-09-28T13:00:00Z')`);
      await client.query(`INSERT INTO verified_journey_sessions VALUES (1,7,101,ARRAY[6]::int[],ARRAY[6]::int[],NULL)`);
      const verified = await run(sql`SELECT je.id FROM journey_events je WHERE je.tenant_id=7
        ${journeyCompanyFilter([101])} ORDER BY je.id`);
      expect(verified.rows.map((row: any) => row.id)).toEqual([1, 2, 5, 6]);
      const verifiedActivity = await run(sql`SELECT ae.id FROM activity_events ae WHERE ae.tenant_id=7
        ${activityCompanyFilter("ae", [101])} ORDER BY ae.id`);
      expect(verifiedActivity.rows.map((row: any) => row.id)).toEqual([1, 2, 3, 5, 6]);
      await client.query(`UPDATE verified_journey_sessions SET revoked_at=NOW() WHERE id=1`);
      const revoked = await run(sql`SELECT je.id FROM journey_events je WHERE je.tenant_id=7
        ${journeyCompanyFilter([101])} ORDER BY je.id`);
      expect(revoked.rows.map((row: any) => row.id)).toEqual([1, 2, 5]);
      const revokedActivity = await run(sql`SELECT ae.id FROM activity_events ae WHERE ae.tenant_id=7
        ${activityCompanyFilter("ae", [101])} ORDER BY ae.id`);
      expect(revokedActivity.rows.map((row: any) => row.id)).toEqual([1, 2, 3, 5]);

      const callsSingle = await client.query(
        `SELECT count(*)::int AS total FROM call_logs cl WHERE cl.tenant_id=$1
          ${rawContactCompanyFilter("cl.contact_id", [100])}`,
        [7, [100]],
      );
      expect(callsSingle.rows[0].total).toBe(1);
      const callsEmpty = await client.query(
        `SELECT count(*)::int AS total FROM call_logs cl WHERE cl.tenant_id=$1
          ${rawContactCompanyFilter("cl.contact_id", [])}`,
        [7],
      );
      expect(callsEmpty.rows[0].total).toBe(0);
      const callIntelligenceScoped = await client.query(
        `SELECT ca.id FROM call_analysis ca WHERE ca.tenant_id=$1
          ${rawContactCompanyFilter(rawCallAnalysisContactColumn("ca"), [100])}`,
        [7, [100]],
      );
      expect(callIntelligenceScoped.rows.map((row: any) => row.id)).toEqual([1]);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});