CREATE TABLE "intent_research_corrections" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" integer NOT NULL,
	"account_id" integer NOT NULL,
	"evidence_id" integer NOT NULL,
	"source_version" text NOT NULL,
	"proposal" jsonb NOT NULL,
	"status" text DEFAULT 'proposed' NOT NULL,
	"proposed_by" integer NOT NULL,
	"approved_by" integer,
	"reason" text,
	"applied_delta" jsonb,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"applied_at" timestamp with time zone,
	CONSTRAINT "intent_research_corrections_status_check" CHECK ("intent_research_corrections"."status" IN ('proposed','applied'))
);
--> statement-breakpoint
CREATE INDEX "intent_research_corrections_account_idx" ON "intent_research_corrections" USING btree ("tenant_id","account_id","created_at");