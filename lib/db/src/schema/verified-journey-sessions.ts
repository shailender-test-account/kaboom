import { pgTable, serial, integer, text, timestamp, index } from "drizzle-orm/pg-core";

// Event IDs are snapshotted at review time. A browser token is never assigned to a contact.
export const verifiedJourneySessionsTable = pgTable("verified_journey_sessions", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull(),
  accountId: integer("account_id").notNull(),
  contactId: integer("contact_id").notNull(),
  journeyId: integer("journey_id").notNull(),
  anchorEventId: integer("anchor_event_id").notNull(),
  eventIds: integer("event_ids").array().notNull(),
  activityEventIds: integer("activity_event_ids").array().notNull().default([]),
  evidence: text("evidence").notNull(),
  reviewedBy: integer("reviewed_by").notNull(),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }).notNull().defaultNow(),
  revokedBy: integer("revoked_by"),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  revokeReason: text("revoke_reason"),
}, (t) => [
  index("verified_journey_sessions_tenant_account_idx").on(t.tenantId, t.accountId),
  index("verified_journey_sessions_tenant_anchor_idx").on(t.tenantId, t.anchorEventId),
  index("verified_journey_sessions_event_ids_idx").using("gin", t.eventIds),
  index("verified_journey_sessions_activity_ids_idx").using("gin", t.activityEventIds),
]);