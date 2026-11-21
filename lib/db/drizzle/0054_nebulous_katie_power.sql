CREATE TABLE "buying_committee_export_audits" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_id" integer NOT NULL,
	"requested_by" integer NOT NULL,
	"client_id" integer,
	"account_ids" integer[] DEFAULT '{}'::integer[] NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"row_count" integer DEFAULT 0 NOT NULL,
	"outcome" text DEFAULT 'started' NOT NULL,
	CONSTRAINT "buying_committee_export_audits_outcome_check" CHECK ("buying_committee_export_audits"."outcome" IN ('started','completed','rejected','cancelled','failed')),
	CONSTRAINT "buying_committee_export_audits_rows_check" CHECK ("buying_committee_export_audits"."row_count" >= 0)
);
--> statement-breakpoint
CREATE INDEX "buying_committee_export_audits_scope_idx" ON "buying_committee_export_audits" USING btree ("tenant_id","started_at");