import { pgTable, serial, integer, text, jsonb, timestamp, uniqueIndex, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const hpMappingPresetsTable = pgTable("hp_mapping_presets", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull(),
  clientId: integer("client_id").notNull(),
  kind: text("kind").notNull(),
  name: text("name").notNull(),
  headers: jsonb("headers").$type<string[]>().notNull(),
  mappings: jsonb("mappings").$type<Record<string, string>>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [
  uniqueIndex("hp_mapping_preset_name").on(t.tenantId, t.clientId, t.kind, t.name),
  check("hp_mapping_preset_kind", sql`${t.kind} IN ('accounts','activities')`),
]);
export const insertHpMappingPresetSchema = createInsertSchema(hpMappingPresetsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertHpMappingPreset = z.infer<typeof insertHpMappingPresetSchema>;
export type HpMappingPreset = typeof hpMappingPresetsTable.$inferSelect;
