import { pgTable, text, serial, timestamp, integer, unique } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const playsTable = pgTable("abm_plays", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull(),
  clientId: integer("client_id").notNull(),
  name: text("name").notNull(),
  description: text("description"),
  status: text("status").notNull().default("draft"),
  targetAudience: text("target_audience"),
  sequenceId: integer("sequence_id"),
  startDate: timestamp("start_date", { withTimezone: true }),
  endDate: timestamp("end_date", { withTimezone: true }),
  contactsEnrolled: integer("contacts_enrolled").notNull().default(0),
  emailsSent: integer("emails_sent").notNull().default(0),
  pageViews: integer("page_views").notNull().default(0),
  createdBy: integer("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertPlaySchema = createInsertSchema(playsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertPlay = z.infer<typeof insertPlaySchema>;
export type Play = typeof playsTable.$inferSelect;

export const playContactsTable = pgTable("play_contacts", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull(),
  playId: integer("play_id").notNull(),
  contactId: integer("contact_id").notNull(),
  enrolledAt: timestamp("enrolled_at", { withTimezone: true }).notNull().defaultNow(),
  enrolledBy: integer("enrolled_by"),
}, (t) => [
  unique("play_contacts_play_contact_unique").on(t.playId, t.contactId),
]);

export const insertPlayContactSchema = createInsertSchema(playContactsTable).omit({ id: true, enrolledAt: true });
export type InsertPlayContact = z.infer<typeof insertPlayContactSchema>;
export type PlayContact = typeof playContactsTable.$inferSelect;
