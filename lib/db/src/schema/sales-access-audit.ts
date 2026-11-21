import { pgTable, serial, integer, text, timestamp, jsonb, index, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";

// No identity snapshots or cascading FKs: history survives deletion without retaining PII.
export const salesAccessAuditTable = pgTable("sales_access_audit", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull(),
  actorId: integer("actor_id").notNull(),
  targetId: integer("target_id").notNull(),
  kind: text("kind").notNull(),
  beforeValue: jsonb("before_value").$type<number[] | "owned" | "all">().notNull(),
  afterValue: jsonb("after_value").$type<number[] | "owned" | "all">().notNull(),
  requestedAt: timestamp("requested_at", { withTimezone: true }).notNull(),
  recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  outcome: text("outcome").notNull(),
}, t => [
  index("sales_access_audit_target_idx").on(t.tenantId, t.kind, t.targetId, t.id),
  index("sales_access_audit_tenant_page_idx").on(t.tenantId, t.id),
  index("sales_access_audit_actor_page_idx").on(t.tenantId, t.actorId, t.id),
  index("sales_access_audit_date_idx").on(t.tenantId, t.recordedAt),
  check("sales_access_audit_kind_check", sql`${t.kind} IN ('owners','visibility')`),
  check("sales_access_audit_outcome_check", sql`${t.outcome} IN ('changed','unchanged','rejected')`),
  check("sales_access_audit_value_check", sql`(
    (${t.kind}='owners' AND jsonb_typeof(${t.beforeValue})='array' AND jsonb_typeof(${t.afterValue})='array')
    OR (${t.kind}='visibility' AND ${t.beforeValue} IN ('"owned"'::jsonb,'"all"'::jsonb)
      AND ${t.afterValue} IN ('"owned"'::jsonb,'"all"'::jsonb)))`),
]);
export const insertSalesAccessAuditSchema = createInsertSchema(salesAccessAuditTable);
export type SalesAccessAudit = typeof salesAccessAuditTable.$inferSelect;
export type InsertSalesAccessAudit = typeof salesAccessAuditTable.$inferInsert;
