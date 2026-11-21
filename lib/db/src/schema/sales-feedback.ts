import { pgTable, serial, integer, text, boolean, timestamp, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import { tenantsTable } from "./tenants";
import { clientsTable } from "./clients";
import { contactsTable, companiesTable } from "./contacts";
import { usersTable } from "./users";

export const salesFeedbackSourcesTable = pgTable("sales_feedback_sources", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().references(() => tenantsTable.id, {onDelete:"cascade"}),
  clientId: integer("client_id").notNull().references(() => clientsTable.id, {onDelete:"cascade"}),
  name: text("name").notNull(), folderUrl: text("folder_url").notNull(), folderId: text("folder_id").notNull(),
  type: text("type").notNull(), enabled: boolean("enabled").notNull().default(false),
  fieldMappings: jsonb("field_mappings").$type<Record<string,string>>().notNull().default({}),
  fileVersions: jsonb("file_versions").$type<Record<string,string>>().notNull().default({}),
  lastSyncedAt: timestamp("last_synced_at",{withTimezone:true}), lastError: text("last_error"),
}, t => [index("sales_feedback_sources_owner").on(t.tenantId,t.clientId)]);

export const salesFeedbackTable = pgTable("sales_feedback", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().references(() => tenantsTable.id, {onDelete:"cascade"}),
  clientId: integer("client_id").notNull().references(() => clientsTable.id, {onDelete:"cascade"}),
  sourceId: integer("source_id").references(() => salesFeedbackSourcesTable.id,{onDelete:"restrict"}),
  accountId: integer("account_id").references(() => companiesTable.id,{onDelete:"cascade"}),
  contactId: integer("contact_id").references(() => contactsTable.id,{onDelete:"cascade"}),
  type: text("type").notNull(), occurredAt: timestamp("occurred_at",{withTimezone:true}),
  repName: text("rep_name").notNull(), feedback: text("feedback").notNull(), nextAction: text("next_action"),
  product: text("product"), timingMonths: integer("timing_months"), proposedTemperature: text("proposed_temperature"),
  reviewStatus: text("review_status").notNull().default("pending"),
  approvedQualification: boolean("approved_qualification").notNull().default(false),
  reviewNote: text("review_note"), reviewedAt: timestamp("reviewed_at",{withTimezone:true}), reviewedBy: integer("reviewed_by"),
  reviewHistory: jsonb("review_history").$type<unknown[]>().notNull().default([]),
  fileName: text("file_name"), fileId: text("file_id"), sheetName: text("sheet_name"), rowNumber: integer("row_number"),
  recordKey: text("record_key").notNull(), contentHash: text("content_hash").notNull(),
  rawFields: jsonb("raw_fields").$type<Record<string,unknown>>().notNull().default({}),
  createdBy: integer("created_by").references(() => usersTable.id, {onDelete:"set null"}),
  createdAt: timestamp("created_at",{withTimezone:true}).notNull().defaultNow(),
}, t => [
  uniqueIndex("sales_feedback_revision").on(t.tenantId,t.recordKey,t.contentHash),
  index("sales_feedback_account").on(t.tenantId,t.clientId,t.accountId,t.contactId),
  index("sales_feedback_review").on(t.tenantId,t.reviewStatus,t.id),
]);
