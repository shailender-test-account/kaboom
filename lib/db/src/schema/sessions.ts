import { pgTable, varchar, json, timestamp, index } from "drizzle-orm/pg-core";

export const userSessionsTable = pgTable(
  "user_sessions",
  {
    sid: varchar("sid").primaryKey(),
    sess: json("sess").notNull(),
    expire: timestamp("expire", { precision: 6, mode: "date" }).notNull(),
  },
  (t) => [index("idx_session_expire").on(t.expire)],
);

export type UserSession = typeof userSessionsTable.$inferSelect;
