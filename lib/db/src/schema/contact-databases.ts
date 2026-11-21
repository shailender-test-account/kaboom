import { pgTable, serial, integer, text, timestamp, jsonb, uniqueIndex, index } from "drizzle-orm/pg-core";
import { contactsTable } from "./contacts";
import { segmentsTable } from "./segments";

export const contactDatabasesTable = pgTable("contact_databases", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull(),
  name: text("name").notNull(),
  segmentId: integer("segment_id").notNull().references(() => segmentsTable.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [uniqueIndex("contact_databases_tenant_name").on(t.tenantId, t.name)]);

export const contactDatasetsTable = pgTable("contact_datasets", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull(),
  databaseId: integer("database_id").references(() => contactDatabasesTable.id),
  segmentId: integer("segment_id").references(() => segmentsTable.id),
  clientId: integer("client_id"),
  name: text("name").notNull(),
  addedAt: timestamp("added_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [index("contact_datasets_scope_idx").on(t.tenantId, t.databaseId)]);

export const contactDatasetMembersTable = pgTable("contact_dataset_members", {
  id: serial("id").primaryKey(),
  datasetId: integer("dataset_id").notNull().references(() => contactDatasetsTable.id, { onDelete: "cascade" }),
  contactId: integer("contact_id").notNull().references(() => contactsTable.id, { onDelete: "cascade" }),
}, t => [
  uniqueIndex("contact_dataset_members_unique").on(t.datasetId, t.contactId),
  index("contact_dataset_members_contact_idx").on(t.contactId),
]);

export const contactVerificationsTable = pgTable("contact_verifications", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull(),
  contactId: integer("contact_id").notNull().references(() => contactsTable.id, { onDelete: "cascade" }),
  status: text("status").notNull().default("processing"),
  original: jsonb("original").notNull().default({}),
  proposed: jsonb("proposed").notNull().default({}),
  filledFields: jsonb("filled_fields").notNull().default([]),
  error: text("error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
}, t => [index("contact_verifications_contact_idx").on(t.tenantId, t.contactId, t.id)]);

// Independent of contact rows: deleting a contact must never replenish a budget.
export const contactVerificationUsageTable = pgTable("contact_verification_usage", {
  tenantId: integer("tenant_id").primaryKey(),
  requestLimit: integer("request_limit").notNull().default(0),
  attempts: integer("attempts").notNull().default(0),
  responses: integer("responses").notNull().default(0),
  legacyAttempts: integer("legacy_attempts").notNull().default(0),
});
