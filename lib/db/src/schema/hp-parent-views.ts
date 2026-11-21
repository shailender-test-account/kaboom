import { pgTable, serial, integer, text, jsonb, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const hpParentViewsTable = pgTable("hp_parent_views", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull(),
  clientId: integer("client_id").notNull(),
  name: text("name").notNull(),
  config: jsonb("config").$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [uniqueIndex("hp_parent_view_name").on(t.tenantId, t.clientId, t.name)]);
export const insertHpParentViewSchema = createInsertSchema(hpParentViewsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertHpParentView = z.infer<typeof insertHpParentViewSchema>;
export type HpParentView = typeof hpParentViewsTable.$inferSelect;
