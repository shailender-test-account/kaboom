import { pgTable, serial, integer, text, jsonb, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { companiesTable, contactsTable } from "./contacts";

export const buyingCommitteePlansTable = pgTable("buying_committee_plans", {
  id: serial("id").primaryKey(), tenantId: integer("tenant_id").notNull(), clientId: integer("client_id").notNull(),
  name: text("name").notNull(), config: jsonb("config").notNull(), status: text("status").notNull().default("draft"),
  revision: integer("revision").notNull().default(1), createdBy: integer("created_by").notNull(),
  approvedBy: integer("approved_by"), approvedAt: timestamp("approved_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [index("buying_committee_plans_scope_idx").on(t.tenantId, t.clientId, t.id)]);

export const buyingCommitteeTargetsTable = pgTable("buying_committee_targets", {
  id: serial("id").primaryKey(), tenantId: integer("tenant_id").notNull(),
  planId: integer("plan_id").notNull().references(() => buyingCommitteePlansTable.id, { onDelete: "cascade" }),
  companyId: integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  domain: text("domain").notNull().default(""), status: text("status").notNull().default("pending"),
  requests: integer("requests").notNull().default(0), responses: integer("responses").notNull().default(0),
  found: integer("found").notNull().default(0), error: text("error"),
  lease: text("lease"),
  startedAt: timestamp("started_at", { withTimezone: true }), completedAt: timestamp("completed_at", { withTimezone: true }),
}, t => [uniqueIndex("buying_committee_targets_plan_company_uq").on(t.planId, t.companyId),
  index("buying_committee_targets_scope_idx").on(t.tenantId, t.planId)]);

export const buyingCommitteeContactsTable = pgTable("buying_committee_contacts", {
  id: serial("id").primaryKey(), tenantId: integer("tenant_id").notNull(), clientId: integer("client_id").notNull(),
  companyId: integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  apolloId: text("apollo_id").notNull(), name: text("name").notNull(), title: text("title"),
  email: text("email"), phone: text("phone"), linkedin: text("linkedin"), location: text("location"),
  categories: jsonb("categories").notNull().default([]),
  sourcedAt: timestamp("sourced_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [uniqueIndex("buying_committee_contacts_identity_uq").on(t.tenantId, t.clientId, t.companyId, t.apolloId),
  index("buying_committee_contacts_scope_idx").on(t.tenantId, t.clientId, t.companyId, t.id)]);

// References current CRM facts; never create a second copy of a person's details.
export const buyingCommitteeInternalContactsTable = pgTable("buying_committee_internal_contacts", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull(), clientId: integer("client_id").notNull(),
  companyId: integer("company_id").notNull().references(() => companiesTable.id, { onDelete: "cascade" }),
  contactId: integer("contact_id").notNull().references(() => contactsTable.id, { onDelete: "cascade" }),
  targetId: integer("target_id").notNull().references(() => buyingCommitteeTargetsTable.id, { onDelete: "cascade" }),
  categories: jsonb("categories").notNull().default([]),
  sourcedAt: timestamp("sourced_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [uniqueIndex("buying_committee_internal_target_contact_uq").on(t.targetId, t.contactId),
  index("buying_committee_internal_scope_idx").on(t.tenantId, t.clientId, t.companyId, t.contactId)]);
