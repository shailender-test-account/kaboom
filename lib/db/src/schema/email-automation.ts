import { pgTable, text, serial, timestamp, integer, jsonb, uniqueIndex, boolean } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const emailTemplatesTable = pgTable("email_templates", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull(),
  name: text("name").notNull(),
  category: text("category").notNull().default("Outreach"),
  subject: text("subject").notNull(),
  bodyHtml: text("body_html").notNull().default(""),
  bodyText: text("body_text").notNull().default(""),
  variables: jsonb("variables").notNull().default([]),
  blocksJson: jsonb("blocks_json"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const emailSequencesTable = pgTable("email_sequences", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull(),
  playId: integer("play_id"),
  name: text("name").notNull(),
  status: text("status").notNull().default("draft"),
  triggerType: text("trigger_type").notNull().default("MANUAL"),
  triggerConfig: jsonb("trigger_config").notNull().default({}),
  nodesJson: jsonb("nodes_json").notNull().default({ nodes: [], edges: [] }),
  senderEmail: text("sender_email"),
  senderName: text("sender_name"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const sequenceStepsTable = pgTable("sequence_steps", {
  id: serial("id").primaryKey(),
  sequenceId: integer("sequence_id").notNull(),
  stepOrder: integer("step_order").notNull().default(0),
  stepType: text("step_type").notNull().default("email"),
  config: jsonb("config").notNull().default({}),
  waitDuration: integer("wait_duration"),
  waitUnit: text("wait_unit").default("hours"),
  conditionConfig: jsonb("condition_config"),
  trueNextStepId: integer("true_next_step_id"),
  falseNextStepId: integer("false_next_step_id"),
  nodeId: text("node_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const sequenceEnrollmentsTable = pgTable(
  "sequence_enrollments",
  {
    id: serial("id").primaryKey(),
    sequenceId: integer("sequence_id").notNull(),
    contactId: integer("contact_id").notNull(),
    status: text("status").notNull().default("active"),
    currentStepId: integer("current_step_id"),
    enrolledAt: timestamp("enrolled_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    /** Tracks consecutive resume failures for exponential backoff / errored cutoff. Reset to 0 on each successful resume. */
    resumeErrorCount: integer("resume_error_count").notNull().default(0),
  },
  (t) => [
    uniqueIndex("idx_seq_enrollments_active_unique")
      .on(t.sequenceId, t.contactId)
      .where(sql`status = 'active'`),
  ],
);

export const emailEventsTable = pgTable("email_events", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull(),
  contactId: integer("contact_id"),
  templateId: integer("template_id"),
  eventType: text("event_type").notNull(),
  metadata: jsonb("metadata").notNull().default({}),
  sendingPath: text("sending_path"),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertEmailTemplateSchema = createInsertSchema(emailTemplatesTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertEmailTemplate = z.infer<typeof insertEmailTemplateSchema>;
export type EmailTemplate = typeof emailTemplatesTable.$inferSelect;

export const insertEmailSequenceSchema = createInsertSchema(emailSequencesTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertEmailSequence = z.infer<typeof insertEmailSequenceSchema>;
export type EmailSequence = typeof emailSequencesTable.$inferSelect;

export const insertSequenceStepSchema = createInsertSchema(sequenceStepsTable).omit({ id: true, createdAt: true });
export type InsertSequenceStep = z.infer<typeof insertSequenceStepSchema>;
export type SequenceStep = typeof sequenceStepsTable.$inferSelect;

export const insertSequenceEnrollmentSchema = createInsertSchema(sequenceEnrollmentsTable).omit({ id: true, enrolledAt: true });
export type InsertSequenceEnrollment = z.infer<typeof insertSequenceEnrollmentSchema>;
export type SequenceEnrollment = typeof sequenceEnrollmentsTable.$inferSelect;

export const insertEmailEventSchema = createInsertSchema(emailEventsTable).omit({ id: true, occurredAt: true });
export type InsertEmailEvent = z.infer<typeof insertEmailEventSchema>;
export type EmailEvent = typeof emailEventsTable.$inferSelect;
