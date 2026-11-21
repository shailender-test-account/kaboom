CREATE TABLE IF NOT EXISTS "verified_journey_sessions" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_id" integer NOT NULL,
	"account_id" integer NOT NULL,
	"contact_id" integer NOT NULL,
	"journey_id" integer NOT NULL,
	"anchor_event_id" integer NOT NULL,
	"event_ids" integer[] NOT NULL,
	"activity_event_ids" integer[] DEFAULT '{}' NOT NULL,
	"evidence" text NOT NULL,
	"reviewed_by" integer NOT NULL,
	"reviewed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_by" integer,
	"revoked_at" timestamp with time zone,
	"revoke_reason" text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "verified_journey_sessions_tenant_account_idx" ON "verified_journey_sessions" USING btree ("tenant_id","account_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "verified_journey_sessions_tenant_anchor_idx" ON "verified_journey_sessions" USING btree ("tenant_id","anchor_event_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "verified_journey_sessions_event_ids_idx" ON "verified_journey_sessions" USING gin ("event_ids");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "verified_journey_sessions_activity_ids_idx" ON "verified_journey_sessions" USING gin ("activity_event_ids");