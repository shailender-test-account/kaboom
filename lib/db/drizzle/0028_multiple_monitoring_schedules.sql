ALTER TABLE "intent_monitoring_configs" ADD COLUMN IF NOT EXISTS "name" text DEFAULT 'Monitoring schedule' NOT NULL;--> statement-breakpoint
ALTER TABLE "intent_monitoring_configs" DROP CONSTRAINT IF EXISTS "intent_monitoring_configs_tenant_uq";--> statement-breakpoint
DROP INDEX IF EXISTS "intent_monitoring_configs_tenant_uq";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "intent_monitoring_configs_tenant_enabled_idx" ON "intent_monitoring_configs" ("tenant_id","enabled");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "intent_monitoring_accounts" (
 "tenant_id" integer NOT NULL,
 "config_id" integer NOT NULL,
 "company_id" integer NOT NULL,
 CONSTRAINT "intent_monitoring_accounts_pk" PRIMARY KEY ("tenant_id","config_id","company_id")
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "intent_monitoring_accounts_lookup_idx" ON "intent_monitoring_accounts" ("tenant_id","company_id");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "intent_monitoring_accounts" ADD CONSTRAINT "intent_monitoring_accounts_config_fk" FOREIGN KEY ("tenant_id","config_id") REFERENCES "intent_monitoring_configs" ("tenant_id","id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;