import { describe, expect, it } from "vitest";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { reportDay, reportDayStart, reportDayEnd } from "./analyticsDay";

describe("Analytics Asia/Kolkata calendar days", () => {
  it("buckets and filters midnight events consistently, regardless of the database session timezone", async () => {
    for (const sessionZone of ["UTC", "America/Los_Angeles"]) {
      await db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL TIME ZONE ${sql.raw(`'${sessionZone}'`)}`);
        const result = await tx.execute(sql`
          WITH events(occurred_at) AS (
            VALUES
              ('2026-09-28T18:29:59Z'::timestamptz),
              ('2026-09-28T18:30:00Z'::timestamptz),
              ('2026-09-29T00:00:00Z'::timestamptz),
              ('2026-09-29T18:29:59Z'::timestamptz),
              ('2026-09-29T18:30:00Z'::timestamptz)
          )
          SELECT ${reportDay(sql`occurred_at`)}::text AS day, count(*)::int AS events
          FROM events
          WHERE occurred_at >= ${reportDayStart("2026-09-29")}
            AND occurred_at < ${reportDayEnd("2026-09-29")}
          GROUP BY 1 ORDER BY 1
        `);
        expect(result.rows).toEqual([{ day: "2026-09-29", events: 3 }]);
        const bounds = await tx.execute(sql`
          SELECT ${reportDayStart("2026-09-29")} AT TIME ZONE 'UTC' AS start_utc,
                 ${reportDayEnd("2026-09-29")} AT TIME ZONE 'UTC' AS end_utc
        `);
        expect(bounds.rows[0]).toMatchObject({
          start_utc: "2026-09-28 18:30:00",
          end_utc: "2026-09-29 18:30:00",
        });
      });
    }
  });
});