import { pgTable, text, serial, timestamp, integer, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const assetDownloadsTable = pgTable(
  "asset_downloads",
  {
    id: serial("id").primaryKey(),
    tenantId: integer("tenant_id").notNull(),
    assetId: integer("asset_id").notNull(),
    visitorToken: text("visitor_token"),
    pageId: integer("page_id"),
    downloadedAt: timestamp("downloaded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("asset_downloads_asset_idx").on(t.assetId)],
);

export const insertAssetDownloadSchema = createInsertSchema(assetDownloadsTable).omit({ id: true, downloadedAt: true });
export type InsertAssetDownload = z.infer<typeof insertAssetDownloadSchema>;
export type AssetDownload = typeof assetDownloadsTable.$inferSelect;
