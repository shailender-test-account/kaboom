import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { pool } from "@workspace/db";

// Exercise the actual lateral lookup used by the timeline, with isolated sent
// and activity rows. A template edit is deliberately not part of this lookup.
const routeSource = readFileSync(new URL("../routes/analytics.ts", import.meta.url), "utf8");
const subjectEnd = routeSource.indexOf(") sent_message ON TRUE");
const subjectStart = routeSource.lastIndexOf("LEFT JOIN LATERAL (", subjectEnd);
if (subjectStart < 0 || subjectEnd < 0) throw new Error("Inbound click subject lookup not found");
const subjectJoin = routeSource.slice(subjectStart, subjectEnd + ") sent_message ON TRUE".length);

describe.skipIf(!process.env.DATABASE_URL)("inbound click subject history", () => {
  it("uses the sent snapshot and refuses to guess after a second send with a changed subject", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`CREATE TEMP TABLE email_events (
        tenant_id int, contact_id int, template_id int, event_type text,
        metadata jsonb, occurred_at timestamptz
      ) ON COMMIT DROP`);
      await client.query(`CREATE TEMP TABLE activity_events (
        tenant_id int, contact_id int, event_type text,
        metadata text, created_at timestamptz
      ) ON COMMIT DROP`);

      const lookup = async (enrollmentId: number | null = 7) => {
        const result = await client.query<{ subject: string | null }>(`
          SELECT sent_message.subject
          FROM (VALUES (1::int)) ae(tenant_id)
          CROSS JOIN (VALUES (2::int)) c(id)
          CROSS JOIN (VALUES (3::int, $1::jsonb, '2026-02-01T12:00:00Z'::timestamptz))
            click_email(template_id, metadata, occurred_at)
          ${subjectJoin}
        `, [JSON.stringify(enrollmentId === null ? {} : { enrollmentId })]);
        return result.rows[0].subject;
      };

      await client.query(`INSERT INTO activity_events VALUES
        (1, 2, 'email_sent',
         '{"templateId":3,"enrollmentId":7,"subject":"Original subject"}',
         '2026-02-01T09:00:00Z')`);
      expect(await lookup()).toBe("Original subject"); // Legacy activity snapshot

      await client.query(`INSERT INTO email_events VALUES
        (1, 2, 3, 'sent', '{"enrollmentId":7,"subject":"Original subject"}',
         '2026-02-01T09:00:00Z')`);
      expect(await lookup()).toBe("Original subject"); // New sent snapshot

      await client.query(`INSERT INTO email_events VALUES
        (1, 2, 3, 'sent', '{"enrollmentId":7,"subject":"Edited subject"}',
         '2026-02-01T10:00:00Z')`);
      expect(await lookup()).toBeNull(); // Late click on the first email is ambiguous
      expect(await lookup(null)).toBeNull(); // Legacy click is ambiguous too
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});