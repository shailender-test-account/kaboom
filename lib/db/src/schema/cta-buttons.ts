import { pgTable, text, serial, timestamp, integer, jsonb, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const ctaButtonsTable = pgTable(
  "cta_buttons",
  {
    id: serial("id").primaryKey(),
    tenantId: integer("tenant_id").notNull(),
    name: text("name").notNull(),
    label: text("label").notNull(),
    actionType: text("action_type").notNull(),
    actionConfig: jsonb("action_config").notNull().default({}),
    styleConfig: jsonb("style_config").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("cta_buttons_tenant_idx").on(t.tenantId)],
);

export const insertCtaButtonSchema = createInsertSchema(ctaButtonsTable).omit({ id: true, createdAt: true });
export type InsertCtaButton = z.infer<typeof insertCtaButtonSchema>;
export type CtaButton = typeof ctaButtonsTable.$inferSelect;
