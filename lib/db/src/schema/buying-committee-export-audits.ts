import { sql } from "drizzle-orm";
import { pgTable, serial, integer, text, timestamp, index, check } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";

// Intentionally no person fields, request/error blobs, CSV data, IPs or user agents.
// IDs survive deletion of the exported contacts without retaining their personal details.
export const buyingCommitteeExportAuditsTable = pgTable("buying_committee_export_audits", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull(),
  requestedBy: integer("requested_by").notNull(),
  clientId: integer("client_id"),
  accountIds: integer("account_ids").array().notNull().default(sql`'{}'::integer[]`),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  rowCount: integer("row_count").notNull().default(0),
  outcome: text("outcome").notNull().default("started"),
}, t => [
  index("buying_committee_export_audits_scope_idx").on(t.tenantId, t.startedAt),
  check("buying_committee_export_audits_outcome_check",
    sql`${t.outcome} IN ('started','completed','rejected','cancelled','failed')`),
  check("buying_committee_export_audits_rows_check", sql`${t.rowCount} >= 0`),
]);

export const insertBuyingCommitteeExportAuditSchema = createInsertSchema(buyingCommitteeExportAuditsTable)
  .omit({ id: true, startedAt: true, finishedAt: true });
export type BuyingCommitteeExportAudit = typeof buyingCommitteeExportAuditsTable.$inferSelect;
export type InsertBuyingCommitteeExportAudit = typeof buyingCommitteeExportAuditsTable.$inferInsert;
