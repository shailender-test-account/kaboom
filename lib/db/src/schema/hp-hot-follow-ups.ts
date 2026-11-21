import { sql } from "drizzle-orm";
import { pgTable, serial, integer, text, timestamp, jsonb, uniqueIndex, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { contactsTable, companiesTable } from "./contacts";
import { usersTable } from "./users";

export const hpHotFollowUpsTable = pgTable("hp_hot_follow_ups", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull(),
  clientId: integer("client_id").notNull(),
  accountId: integer("account_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  contactId: integer("contact_id").notNull().references(() => contactsTable.id, { onDelete: "cascade" }),
  status: text("status").notNull().default("open"),
  evidence: jsonb("evidence").$type<{ product: string; months: number | null; at: string; reference: string }[]>().notNull().default(sql`'[]'::jsonb`),
  evidenceKey: text("evidence_key").notNull(),
  assigneeId: integer("assignee_id").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  completedBy: integer("completed_by").references(() => usersTable.id, { onDelete: "set null" }),
  completionNote: text("completion_note"),
}, t => [
  uniqueIndex("hp_hot_follow_up_contact").on(t.tenantId, t.contactId),
  index("hp_hot_follow_up_queue").on(t.tenantId, t.clientId, t.status, t.id),
]);
export const insertHpHotFollowUpSchema = createInsertSchema(hpHotFollowUpsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type HpHotFollowUp = typeof hpHotFollowUpsTable.$inferSelect;
