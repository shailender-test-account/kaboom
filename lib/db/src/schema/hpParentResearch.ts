import { pgTable, serial, integer, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { companiesTable } from "./contacts";

/** Research identities only: deliberately no HP roster/profile or contact is created. */
export const hpParentResearchAccountsTable = pgTable("hp_parent_research_accounts", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull(),
  clientId: integer("client_id").notNull(),
  parentKey: text("parent_key").notNull(),
  parentName: text("parent_name").notNull(),
  accountId: integer("account_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [
  uniqueIndex("hp_parent_research_scope_idx").on(table.tenantId, table.clientId, table.parentKey),
  uniqueIndex("hp_parent_research_account_idx").on(table.accountId),
]);
