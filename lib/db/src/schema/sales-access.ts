import { pgTable, integer, text, primaryKey, index, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { usersTable } from "./users";
import { companiesTable } from "./contacts";

export const salesUserAccessTable = pgTable("sales_user_access", {
  tenantId: integer("tenant_id").notNull(),
  userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  visibility: text("visibility").notNull().default("owned"),
}, t => [
  primaryKey({ columns: [t.tenantId, t.userId] }),
  check("sales_user_access_visibility_check", sql`${t.visibility} IN ('owned','all')`),
]);
export const salesAccountOwnersTable = pgTable("sales_account_owners", {
  tenantId: integer("tenant_id").notNull(),
  clientId: integer("client_id").notNull(),
  accountId: integer("account_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
}, t => [
  primaryKey({ columns: [t.tenantId, t.accountId, t.userId] }),
  index("sales_account_owners_user_idx").on(t.tenantId, t.userId, t.accountId),
]);
export const insertSalesUserAccessSchema = createInsertSchema(salesUserAccessTable);
export const insertSalesAccountOwnerSchema = createInsertSchema(salesAccountOwnersTable);
