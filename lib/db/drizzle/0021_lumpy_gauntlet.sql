CREATE TABLE IF NOT EXISTS "intent_research_run_accounts" (
  "id" serial PRIMARY KEY NOT NULL,
  "tenant_id" integer NOT NULL,
  "run_id" integer NOT NULL,
  "account_id" integer NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "error" text,
  "started_at" timestamp with time zone,
  "completed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "intent_research_run_accounts_tenant_run_account_uq"
  ON "intent_research_run_accounts" USING btree ("tenant_id","run_id","account_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "intent_research_run_accounts_claim_idx"
  ON "intent_research_run_accounts" USING btree ("tenant_id","run_id","status","created_at");