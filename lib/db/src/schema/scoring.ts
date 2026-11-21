import { pgTable, text, serial, timestamp, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const scoringRulesTable = pgTable("scoring_rules", {
  id: serial("id").primaryKey(),
  eventType: text("event_type").notNull(),
  points: integer("points").notNull(),
  description: text("description"),
  isActive: text("is_active").notNull().default("true"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const scoreThresholdsTable = pgTable("score_thresholds", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull(),
  label: text("label").notNull(),
  minScore: integer("min_score").notNull(),
  color: text("color").notNull().default("gray"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const activityEventsTable = pgTable("activity_events", {
  id: serial("id").primaryKey(),
  contactId: integer("contact_id"),
  contactName: text("contact_name"),
  clientId: integer("client_id"),
  eventType: text("event_type").notNull(),
  description: text("description").notNull(),
  metadata: text("metadata"),
  pointsEarned: integer("points_earned"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  // Formula-computed intent score snapshotted at the time this event was processed.
  // NULL for historical events (written before this column existed); those fall back
  // to nearest-preceding contact_stage_history.score_at_transition interpolation.
  intentScoreAt: integer("intent_score_at"),
});

export const contactNotesTable = pgTable("contact_notes", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull(),
  contactId: integer("contact_id").notNull(),
  authorId: integer("author_id"),
  body: text("body").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertScoringRuleSchema = createInsertSchema(scoringRulesTable).omit({ id: true, createdAt: true });
export type InsertScoringRule = z.infer<typeof insertScoringRuleSchema>;
export type ScoringRule = typeof scoringRulesTable.$inferSelect;

export const insertScoreThresholdSchema = createInsertSchema(scoreThresholdsTable).omit({ id: true, createdAt: true });
export type InsertScoreThreshold = z.infer<typeof insertScoreThresholdSchema>;
export type ScoreThreshold = typeof scoreThresholdsTable.$inferSelect;

export const insertActivityEventSchema = createInsertSchema(activityEventsTable).omit({ id: true, createdAt: true });
export type InsertActivityEvent = z.infer<typeof insertActivityEventSchema>;
export type ActivityEvent = typeof activityEventsTable.$inferSelect;

export const insertContactNoteSchema = createInsertSchema(contactNotesTable).omit({ id: true, createdAt: true });
export type InsertContactNote = z.infer<typeof insertContactNoteSchema>;
export type ContactNote = typeof contactNotesTable.$inferSelect;

export const scoreHistoryTable = pgTable("score_history", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull(),
  contactId: integer("contact_id").notNull(),
  oldScore: integer("old_score").notNull().default(0),
  newScore: integer("new_score").notNull(),
  delta: integer("delta").notNull(),
  source: text("source"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertScoreHistorySchema = createInsertSchema(scoreHistoryTable).omit({ id: true, createdAt: true });
export type InsertScoreHistory = z.infer<typeof insertScoreHistorySchema>;
export type ScoreHistory = typeof scoreHistoryTable.$inferSelect;
