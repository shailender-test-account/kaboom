ALTER TABLE "contacts" ADD COLUMN IF NOT EXISTS "identifier" text;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN IF NOT EXISTS "velocity_bonus" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN IF NOT EXISTS "account_colleagues" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN IF NOT EXISTS "account_bonus" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN IF NOT EXISTS "dnc" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Note: idx_contacts_identifier_trgm (GIN/pg_trgm) intentionally omitted —
-- pg_trgm is not available on all PostgreSQL hosts.
