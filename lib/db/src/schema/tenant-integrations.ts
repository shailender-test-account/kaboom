import { pgTable, text, serial, timestamp, integer, jsonb, unique } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { tenantsTable } from "./tenants";

export const tenantIntegrationsTable = pgTable(
  "tenant_integrations",
  {
    id: serial("id").primaryKey(),
    tenantId: integer("tenant_id")
      .notNull()
      .references(() => tenantsTable.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    config: jsonb("config").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
  },
  (t) => [unique("tenant_integrations_tenant_id_provider_key").on(t.tenantId, t.provider)],
);

export const insertTenantIntegrationSchema = createInsertSchema(tenantIntegrationsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertTenantIntegration = z.infer<typeof insertTenantIntegrationSchema>;
export type TenantIntegration = typeof tenantIntegrationsTable.$inferSelect;
