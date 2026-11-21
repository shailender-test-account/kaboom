ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "inbound_manual" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "inbound_manual_at" timestamp with time zone;