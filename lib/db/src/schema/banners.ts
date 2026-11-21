import { pgTable, text, serial, timestamp, integer, jsonb, bigint, bigserial, index, check, unique } from "drizzle-orm/pg-core";
import { tenantsTable } from "./tenants";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const bannersTable = pgTable("banners", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull(),
  name: text("name").notNull(),
  position: text("position").notNull().default("top"),
  config: jsonb("config").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  zone: text("zone"),
  status: text("status").notNull().default("active"),
  startDate: timestamp("start_date", { withTimezone: true }),
  endDate: timestamp("end_date", { withTimezone: true }),
  originalWidth: integer("original_width"),
  originalHeight: integer("original_height"),
  fileSize: bigint("file_size", { mode: "number" }),
  originalFilename: text("original_filename"),
});

export const bannerEventsTable = pgTable(
  "banner_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    bannerId: integer("banner_id").notNull(),
    eventType: text("event_type").notNull(),
    visitorToken: text("visitor_token"),
    journeyId: integer("journey_id"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_banner_events_banner_id").on(t.bannerId),
    index("idx_banner_events_occurred_at").on(t.occurredAt),
    index("idx_banner_events_type_banner").on(t.bannerId, t.eventType),
    check(
      "banner_events_event_type_check",
      sql`${t.eventType} IN ('impression', 'click', 'dismiss')`,
    ),
  ],
);

export const insertBannerSchema = createInsertSchema(bannersTable).omit({ id: true, createdAt: true });
export type InsertBanner = z.infer<typeof insertBannerSchema>;
export type Banner = typeof bannersTable.$inferSelect;

export const insertBannerEventSchema = createInsertSchema(bannerEventsTable).omit({ id: true, occurredAt: true });
export type InsertBannerEvent = z.infer<typeof insertBannerEventSchema>;
export type BannerEvent = typeof bannerEventsTable.$inferSelect;

export const bannerZoneSettingsTable = pgTable(
  "banner_zone_settings",
  {
    id: serial("id").primaryKey(),
    tenantId: integer("tenant_id")
      .notNull()
      .references(() => tenantsTable.id, { onDelete: "cascade" }),
    zone: text("zone").notNull(),
    rotationIntervalSeconds: integer("rotation_interval_seconds").notNull().default(5),
    mobileBehavior: text("mobile_behavior").notNull().default("hide"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("banner_zone_settings_tenant_id_zone_unique").on(t.tenantId, t.zone)],
);

export const insertBannerZoneSettingsSchema = createInsertSchema(bannerZoneSettingsTable).omit({ id: true, createdAt: true });
export type InsertBannerZoneSettings = z.infer<typeof insertBannerZoneSettingsSchema>;
export type BannerZoneSettings = typeof bannerZoneSettingsTable.$inferSelect;
