ALTER TABLE "intent_research_runs" ADD COLUMN "request_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "intent_research_runs" ADD COLUMN "request_limit" integer;