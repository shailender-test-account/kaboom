import { pgTable, text, serial, timestamp, integer, boolean, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const segmentsTable = pgTable("segments", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull(),
  name: text("name").notNull(),
  description: text("description"),
  segmentType: text("segment_type").notNull().default("dynamic"),
  filterCriteria: jsonb("filter_criteria").notNull().default([]),
  staticContactIds: integer("static_contact_ids").array(),
  logicOperator: text("logic_operator").notNull().default("AND"),
  lastComputedCount: integer("last_computed_count").notNull().default(0),
  lastComputedAt: timestamp("last_computed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const journeyContactsTable = pgTable("journey_contacts", {
  id: serial("id").primaryKey(),
  journeyId: integer("journey_id").notNull(),
  contactId: integer("contact_id").notNull(),
  addedVia: text("added_via").notNull().default("manual"),
  segmentId: integer("segment_id"),
  addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
});

export const journeyCompaniesTable = pgTable("journey_companies", {
  id: serial("id").primaryKey(),
  journeyId: integer("journey_id").notNull(),
  companyId: integer("company_id").notNull(),
  addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
});

export const journeySegmentsTable = pgTable("journey_segments", {
  id: serial("id").primaryKey(),
  journeyId: integer("journey_id").notNull(),
  segmentId: integer("segment_id").notNull(),
  snapshotMode: boolean("snapshot_mode").notNull().default(false),
  snapshotContactIds: integer("snapshot_contact_ids").array(),
  addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
  lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
});

export const sequenceRunsTable = pgTable("sequence_runs", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull(),
  sequenceId: integer("sequence_id").notNull(),
  journeyId: integer("journey_id"),
  clientId: integer("client_id"),
  segmentId: integer("segment_id"),
  contactListIds: integer("contact_list_ids").array(),
  status: text("status").notNull().default("pending"),
  totalContacts: integer("total_contacts").notNull().default(0),
  enrolled: integer("enrolled").notNull().default(0),
  skipped: integer("skipped").notNull().default(0),
  errors: integer("errors").notNull().default(0),
  startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  startedBy: integer("started_by"),
  /** When false, contacts enrolled in the last 24 h may be re-enrolled in this run. */
  skipRecentlyEnrolled: boolean("skip_recently_enrolled").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const journeyRoutingRulesTable = pgTable("journey_routing_rules", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull(),
  conditionType: text("condition_type").notNull(),
  conditionValue: jsonb("condition_value").notNull().default({}),
  journeyId: integer("journey_id").notNull(),
  enrollSequenceId: integer("enroll_sequence_id"),
  applyTo: text("apply_to").notNull().default("all"),
  applyClientId: integer("apply_client_id"),
  applySegmentId: integer("apply_segment_id"),
  ifAlreadyInJourney: text("if_already_in_journey").notNull().default("skip"),
  reenrollAfterCompletion: boolean("reenroll_after_completion").notNull().default(false),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertSegmentSchema = createInsertSchema(segmentsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertSegment = z.infer<typeof insertSegmentSchema>;
export type Segment = typeof segmentsTable.$inferSelect;

export type SequenceRun = typeof sequenceRunsTable.$inferSelect;
export type JourneyRoutingRule = typeof journeyRoutingRulesTable.$inferSelect;
