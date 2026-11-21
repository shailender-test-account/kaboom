CREATE TABLE IF NOT EXISTS "intent_opportunity_handoffs" (
  "id" serial PRIMARY KEY NOT NULL,
  "tenant_id" integer NOT NULL,
  "account_id" integer NOT NULL,
  "client_id" integer NOT NULL,
  "product_id" integer NOT NULL,
  "method" text NOT NULL,
  "spreadsheet_id" text,
  "range_name" text,
  "idempotency_key" text NOT NULL,
  "handoff_status" text DEFAULT 'pending' NOT NULL,
  "source" text NOT NULL,
  "snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "error" text,
  "created_by" integer,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "intent_opportunity_handoffs_tenant_key_uq"
  ON "intent_opportunity_handoffs" ("tenant_id","idempotency_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "intent_opportunity_handoffs_account_idx"
  ON "intent_opportunity_handoffs" ("tenant_id","account_id","product_id","created_at");