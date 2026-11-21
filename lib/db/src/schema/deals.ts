import { pgTable, text, serial, timestamp, integer, numeric, boolean, date, jsonb, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const dealsTable = pgTable("deals", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull(),
  clientId: integer("client_id").notNull(),
  companyId: integer("company_id"),
  contactId: integer("contact_id"),
  title: text("title").notNull(),
  value: numeric("value", { precision: 12, scale: 2 }),
  currency: text("currency"),
  valueMeaning: text("value_meaning").notNull().default("unknown"),
  bookedValue: numeric("booked_value", { precision: 12, scale: 2 }),
  opportunityConfirmed: boolean("opportunity_confirmed").notNull().default(false),
  actualOpportunityDate: date("actual_opportunity_date", { mode: "string" }),
  actualOutcomeDate: date("actual_outcome_date", { mode: "string" }),
  stage: text("stage").notNull().default("prospect"),
  priority: text("priority").notNull().default("medium"),
  expectedCloseDate: timestamp("expected_close_date", { withTimezone: true }),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, t => [index("deals_reporting_scope_idx").on(t.tenantId, t.clientId, t.companyId)]);

export const insertDealSchema = createInsertSchema(dealsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertDeal = z.infer<typeof insertDealSchema>;
export type Deal = typeof dealsTable.$inferSelect;

// No cascade FK: deletion retains the identity needed to suppress stale Excel mirrors.
export const dealAuditTable = pgTable("deal_audit", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull(),
  clientId: integer("client_id").notNull(),
  dealId: integer("deal_id").notNull(),
  actorId: integer("actor_id"),
  action: text("action").notNull(),
  before: jsonb("before"),
  after: jsonb("after"),
  changedAt: timestamp("changed_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [index("deal_audit_scope_idx").on(t.tenantId, t.clientId, t.dealId)]);
export const insertDealAuditSchema = createInsertSchema(dealAuditTable).omit({ id: true, changedAt: true });
export type InsertDealAudit = z.infer<typeof insertDealAuditSchema>;
export type DealAudit = typeof dealAuditTable.$inferSelect;
