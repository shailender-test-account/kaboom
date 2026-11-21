CREATE TABLE IF NOT EXISTS "deal_audit" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_id" integer NOT NULL,
	"client_id" integer NOT NULL,
	"deal_id" integer NOT NULL,
	"actor_id" integer,
	"action" text NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "deals" ADD COLUMN IF NOT EXISTS "currency" text;--> statement-breakpoint
ALTER TABLE "deals" ADD COLUMN IF NOT EXISTS "value_meaning" text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE "deals" ADD COLUMN IF NOT EXISTS "booked_value" numeric(12, 2);--> statement-breakpoint
ALTER TABLE "deals" ADD COLUMN IF NOT EXISTS "opportunity_confirmed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "deals" ADD COLUMN IF NOT EXISTS "actual_opportunity_date" date;--> statement-breakpoint
ALTER TABLE "deals" ADD COLUMN IF NOT EXISTS "actual_outcome_date" date;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "deal_audit_scope_idx" ON "deal_audit" USING btree ("tenant_id","client_id","deal_id");