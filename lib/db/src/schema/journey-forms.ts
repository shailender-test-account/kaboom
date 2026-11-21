import { pgTable, text, serial, timestamp, integer, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const journeyFormsTable = pgTable("journey_forms", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull(),
  name: text("name").notNull(),
  config: jsonb("config").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertJourneyFormSchema = createInsertSchema(journeyFormsTable).omit({ id: true, createdAt: true });
export type InsertJourneyForm = z.infer<typeof insertJourneyFormSchema>;
export type JourneyForm = typeof journeyFormsTable.$inferSelect;
