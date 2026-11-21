import { pgTable, text, serial, timestamp, integer, numeric, boolean, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const companiesTable = pgTable("companies", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull(),
  clientId: integer("client_id").notNull(),
  name: text("name").notNull(),
  domain: text("domain"),
  industry: text("industry"),
  size: text("size"),
  website: text("website"),
  inboundManual: boolean("inbound_manual").notNull().default(false),
  inboundManualAt: timestamp("inbound_manual_at", { withTimezone: true }),
  lastResearchedAt: timestamp("last_researched_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, table => [
  index("companies_tenant_client_research_idx").on(table.tenantId, table.clientId, table.lastResearchedAt, table.id),
]);

export const contactsTable = pgTable("contacts", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull(),
  clientId: integer("client_id"),
  companyId: integer("company_id"),
  firstName: text("first_name"),
  lastName: text("last_name"),
  email: text("email"),
  phone: text("phone"),
  title: text("title"),
  tags: text("tags").array().notNull().default([]),
  identifier: text("identifier"),
  leadScore: integer("lead_score").notNull().default(0),
  status: text("status").notNull().default("active"),
  stage: text("stage").notNull().default("pre-aware"),
  source: text("source").notNull().default("manual"),
  lastActivity: timestamp("last_activity", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
  // CSV import columns
  designation: text("designation"),
  function: text("function"),
  employeeSize: text("employee_size"),
  companyRevenue: text("company_revenue"),
  linkedinUrl: text("linkedin_url"),
  companyLinkedinUrl: text("company_linkedin_url"),
  city: text("city"),
  pin: text("pin"),
  state: text("state"),
  country: text("country"),
  hqCountry: text("hq_country"),
  companyName: text("company_name"),
  // Extended contact fields
  website: text("website"),
  // Intent scoring fields
  intentScore: integer("intent_score").notNull().default(0),
  rawIntentScore: integer("raw_intent_score").notNull().default(0),
  intentState: text("intent_state").notNull().default("Browsing"),
  suggestedNextAction: text("suggested_next_action"),
  distinctActiveDays: integer("distinct_active_days").notNull().default(0),
  freqScore: numeric("freq_score"),
  maxStageScore: numeric("max_stage_score"),
  engagementScore: numeric("engagement_score"),
  velocityBonus: integer("velocity_bonus").notNull().default(0),
  accountColleagues: integer("account_colleagues").notNull().default(0),
  accountBonus: integer("account_bonus").notNull().default(0),
  dnc: boolean("dnc").notNull().default(false),
  isAnonymous: boolean("is_anonymous").notNull().default(false),
});

export const insertCompanySchema = createInsertSchema(companiesTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertCompany = z.infer<typeof insertCompanySchema>;
export type Company = typeof companiesTable.$inferSelect;

export const insertContactSchema = createInsertSchema(contactsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertContact = z.infer<typeof insertContactSchema>;
export type Contact = typeof contactsTable.$inferSelect;
