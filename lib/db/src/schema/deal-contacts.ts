import { pgTable, serial, integer, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { dealsTable } from "./deals";
import { contactsTable, companiesTable } from "./contacts";

/** Additional opportunity stakeholders; never replaces the deal's primary contact. */
export const dealContactsTable = pgTable("deal_contacts", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull(),
  clientId: integer("client_id").notNull(),
  companyId: integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  dealId: integer("deal_id").notNull().references(() => dealsTable.id, { onDelete: "cascade" }),
  contactId: integer("contact_id").notNull().references(() => contactsTable.id, { onDelete: "cascade" }),
  addedBy: integer("added_by"),
  addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [
  uniqueIndex("deal_contacts_owned_link").on(t.tenantId, t.dealId, t.contactId),
  index("deal_contacts_scope").on(t.tenantId, t.clientId, t.companyId, t.contactId),
]);
export const insertDealContactSchema = createInsertSchema(dealContactsTable).omit({ id: true, addedAt: true });
export type DealContact = typeof dealContactsTable.$inferSelect;
