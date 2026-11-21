CREATE TABLE IF NOT EXISTS "intent_monitoring_configs" (
 "id" serial PRIMARY KEY NOT NULL, "tenant_id" integer NOT NULL, "client_id" integer,
 "enabled" boolean DEFAULT false NOT NULL, "daily_limit" integer DEFAULT 500 NOT NULL,
 "last_scheduled_at" timestamp with time zone, "last_scheduled_count" integer DEFAULT 0 NOT NULL,
 "created_at" timestamp with time zone DEFAULT now() NOT NULL, "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
 CONSTRAINT "intent_monitoring_configs_daily_limit_ck" CHECK ("daily_limit" = 500),
 CONSTRAINT "intent_monitoring_configs_tenant_uq" UNIQUE ("tenant_id")
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "intent_monitoring_audiences" (
 "tenant_id" integer NOT NULL, "config_id" integer NOT NULL, "audience_id" integer NOT NULL,
 CONSTRAINT "intent_monitoring_audiences_pk" PRIMARY KEY ("tenant_id","config_id","audience_id")
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "intent_monitoring_categories" (
 "tenant_id" integer NOT NULL, "config_id" integer NOT NULL, "category_id" integer NOT NULL,
 CONSTRAINT "intent_monitoring_categories_pk" PRIMARY KEY ("tenant_id","config_id","category_id")
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "intent_monitoring_audiences_lookup_idx" ON "intent_monitoring_audiences" ("tenant_id","audience_id");
CREATE INDEX IF NOT EXISTS "intent_monitoring_categories_lookup_idx" ON "intent_monitoring_categories" ("tenant_id","category_id");
CREATE UNIQUE INDEX IF NOT EXISTS "intent_monitoring_configs_tenant_id_uq" ON "intent_monitoring_configs" ("tenant_id","id");
DO $$ BEGIN
 ALTER TABLE "intent_monitoring_audiences" ADD CONSTRAINT "intent_monitoring_audiences_config_fk" FOREIGN KEY ("tenant_id","config_id") REFERENCES "intent_monitoring_configs" ("tenant_id","id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
 ALTER TABLE "intent_monitoring_categories" ADD CONSTRAINT "intent_monitoring_categories_config_fk" FOREIGN KEY ("tenant_id","config_id") REFERENCES "intent_monitoring_configs" ("tenant_id","id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;