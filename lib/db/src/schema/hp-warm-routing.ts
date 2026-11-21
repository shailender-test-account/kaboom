import { pgTable, integer, text, jsonb, timestamp, primaryKey, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { tenantsTable } from "./tenants";
import { clientsTable } from "./clients";

export const hpWarmSweepsTable = pgTable("hp_warm_sweeps", {
  tenantId: integer("tenant_id").notNull().references(() => tenantsTable.id, { onDelete: "cascade" }),
  clientId: integer("client_id").notNull().references(() => clientsTable.id, { onDelete: "cascade" }),
  cursor: text("cursor").notNull().default(""),
  lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
  lastCompletedAt: timestamp("last_completed_at", { withTimezone: true }),
  lastFailureAt: timestamp("last_failure_at", { withTimezone: true }),
}, t => [primaryKey({ columns: [t.tenantId, t.clientId] })]);

export const hpWarmChecksTable = pgTable("hp_warm_checks", {
  tenantId: integer("tenant_id").notNull().references(() => tenantsTable.id, { onDelete: "cascade" }),
  clientId: integer("client_id").notNull().references(() => clientsTable.id, { onDelete: "cascade" }),
  parentKey: text("parent_key").notNull(),
  status: text("status").notNull(),
  reason: text("reason").notNull(),
  journeys: jsonb("journeys").$type<string[]>().notNull(),
  checkedAt: timestamp("checked_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [
  primaryKey({ columns: [t.tenantId, t.clientId, t.parentKey] }),
  check("hp_warm_check_status", sql`${t.status} IN ('routed','blocked','unmapped','not_eligible')`),
]);
export const insertHpWarmSweepSchema = createInsertSchema(hpWarmSweepsTable);
export const insertHpWarmCheckSchema = createInsertSchema(hpWarmChecksTable);
export type HpWarmSweep = typeof hpWarmSweepsTable.$inferSelect;
export type HpWarmCheck = typeof hpWarmChecksTable.$inferSelect;
