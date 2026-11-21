ALTER TABLE "intent_inbound_submissions" ADD COLUMN "identity_reviewed_by" integer;
--> statement-breakpoint
ALTER TABLE "intent_inbound_submissions" ADD COLUMN "identity_reviewed_at" timestamp with time zone;