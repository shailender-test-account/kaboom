import { pgTable, serial, integer, text, timestamp, jsonb, uniqueIndex, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const intentOpportunityHandoffsTable = pgTable("intent_opportunity_handoffs", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull(),
  accountId: integer("account_id").notNull(),
  clientId: integer("client_id").notNull(),
  productId: integer("product_id").notNull(),
  method: text("method").notNull(),
  spreadsheetId: text("spreadsheet_id"),
  rangeName: text("range_name"),
  idempotencyKey: text("idempotency_key").notNull(),
  handoffStatus: text("handoff_status").notNull().default("pending"),
  source: text("source").notNull(),
  snapshot: jsonb("snapshot").notNull().default({}),
  error: text("error"),
  createdBy: integer("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
}, table => [
  uniqueIndex("intent_opportunity_handoffs_tenant_key_uq").on(table.tenantId, table.idempotencyKey),
  index("intent_opportunity_handoffs_account_idx").on(table.tenantId, table.accountId, table.productId, table.createdAt),
]);

export const insertIntentOpportunityHandoffSchema = createInsertSchema(intentOpportunityHandoffsTable)
  .omit({ id: true, createdAt: true });
export type InsertIntentOpportunityHandoff = z.infer<typeof insertIntentOpportunityHandoffSchema>;
export type IntentOpportunityHandoff = typeof intentOpportunityHandoffsTable.$inferSelect;