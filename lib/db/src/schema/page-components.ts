import { pgTable, text, serial, timestamp, integer, jsonb, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { journeyPagesTable } from "./journeys";

export const pageComponentsTable = pgTable(
  "page_components",
  {
    id: serial("id").primaryKey(),
    journeyPageId: integer("journey_page_id")
      .notNull()
      .references(() => journeyPagesTable.id, { onDelete: "cascade" }),
    componentType: text("component_type").notNull(),
    componentId: integer("component_id").notNull(),
    position: text("position").notNull().default("inline"),
    sortOrder: integer("sort_order").notNull().default(0),
    overrideConfig: jsonb("override_config").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("page_components_page_idx").on(t.journeyPageId)],
);

export const insertPageComponentSchema = createInsertSchema(pageComponentsTable).omit({ id: true, createdAt: true });
export type InsertPageComponent = z.infer<typeof insertPageComponentSchema>;
export type PageComponent = typeof pageComponentsTable.$inferSelect;
