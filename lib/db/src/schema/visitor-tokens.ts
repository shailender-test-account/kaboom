import { pgTable, text, serial, timestamp, integer, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { contactsTable } from "./contacts";

export const visitorTokensTable = pgTable(
  "visitor_tokens",
  {
    id: serial("id").primaryKey(),
    token: text("token").notNull().unique(),
    contactId: integer("contact_id")
      .notNull()
      .references(() => contactsTable.id, { onDelete: "cascade" }),
    tenantId: integer("tenant_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("visitor_tokens_token_idx").on(t.token),
    index("visitor_tokens_contact_idx").on(t.contactId),
  ],
);

export const insertVisitorTokenSchema = createInsertSchema(visitorTokensTable).omit({ id: true, createdAt: true });
export type InsertVisitorToken = z.infer<typeof insertVisitorTokenSchema>;
export type VisitorToken = typeof visitorTokensTable.$inferSelect;
