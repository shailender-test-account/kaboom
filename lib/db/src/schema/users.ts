import { pgTable, text, serial, timestamp, integer, jsonb, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const usersTable = pgTable("users", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  sessionVersion: integer("session_version").notNull().default(0),
  mustChangePassword: boolean("must_change_password").notNull().default(false),
  temporaryPasswordExpiresAt: timestamp("temporary_password_expires_at", { withTimezone: true }),
  firstName: text("first_name").notNull(),
  lastName: text("last_name").notNull(),
  role: text("role").notNull().default("viewer"),
  sectionPermissions: jsonb("section_permissions").$type<Record<string, "none" | "view" | "manage"> | null>(),
  // NULL preserves existing unrestricted members; an explicit list is enforced
  // on every request. Empty list means no client access.
  clientIds: jsonb("client_ids").$type<number[] | null>(),
  avatarUrl: text("avatar_url"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertUserSchema = createInsertSchema(usersTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof usersTable.$inferSelect;
