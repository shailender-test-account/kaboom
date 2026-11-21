import { pgTable, text, serial, timestamp, integer, boolean, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const journeysTable = pgTable("journeys", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull(),
  clientId: integer("client_id").notNull(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  description: text("description"),
  status: text("status").notNull().default("draft"),
  theme: text("theme").notNull().default("dark"),
  headerLogoUrl: text("header_logo_url"),
  headerLogoShowBg: boolean("header_logo_show_bg").notNull().default(true),
  headerBtnText: text("header_btn_text"),
  headerBtnUrl: text("header_btn_url"),
  headerBtnType: text("header_btn_type").notNull().default("url"),
  headerTagline: text("header_tagline"),
  navigationMode: text("navigation_mode").notNull().default("free"),
  viewerBg: jsonb("viewer_bg").$type<{ type: "color" | "gradient" | "image"; value: string; imageBlur?: number | null; overlay?: { color: string; opacity: number } | null } | null>(),
  scenarioVideos: jsonb("scenario_videos").$type<{ airport?: string; support?: string; home?: string } | null>(),
  startDate: timestamp("start_date", { withTimezone: true }),
  endDate: timestamp("end_date", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const journeyPagesTable = pgTable("journey_pages", {
  id: serial("id").primaryKey(),
  journeyId: integer("journey_id").notNull(),
  title: text("title").notNull(),
  pageType: text("page_type").notNull().default("html"),
  content: text("content"),
  sortOrder: integer("sort_order").notNull().default(0),
  ctaText: text("cta_text"),
  ctaEnabled: text("cta_enabled").notNull().default("false"),
  viewCount: integer("view_count").notNull().default(0),
  pageStage: text("page_stage").default("aware"),
  score: integer("score").notNull().default(0),
  isPublished: boolean("is_published").notNull().default(true),
  ctaType: text("cta_type").default("next"),
  ctaAssetUrl: text("cta_asset_url"),
  gatingAction: text("gating_action").notNull().default("none"),
  biCategory: text("bi_category"),
  biProduct: text("bi_product"),
  biProgram: text("bi_program"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertJourneySchema = createInsertSchema(journeysTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertJourney = z.infer<typeof insertJourneySchema>;
export type Journey = typeof journeysTable.$inferSelect;

export const insertJourneyPageSchema = createInsertSchema(journeyPagesTable).omit({ id: true, createdAt: true });
export type InsertJourneyPage = z.infer<typeof insertJourneyPageSchema>;
export type JourneyPage = typeof journeyPagesTable.$inferSelect;
