import { sql, type SQL } from "drizzle-orm";

// Calendar dates in reports are Asia/Kolkata dates, not UTC dates or DB-session dates.
// Convert the local midnight to an instant so indexed timestamptz columns remain bare.
export const reportDayStart = (day: string): SQL =>
  sql`(${day}::date::timestamp AT TIME ZONE 'Asia/Kolkata')`;
export const reportDayEnd = (day: string): SQL =>
  sql`((${day}::date + 1)::timestamp AT TIME ZONE 'Asia/Kolkata')`;
export const reportDay = (instant: SQL): SQL =>
  sql`(${instant} AT TIME ZONE 'Asia/Kolkata')::date`;