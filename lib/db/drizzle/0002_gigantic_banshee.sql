CREATE TABLE "banner_zone_settings" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_id" integer NOT NULL,
	"zone" text NOT NULL,
	"rotation_interval_seconds" integer DEFAULT 5 NOT NULL,
	"mobile_behavior" text DEFAULT 'hide' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "banner_zone_settings_tenant_id_zone_unique" UNIQUE("tenant_id","zone")
);
--> statement-breakpoint
ALTER TABLE "banner_zone_settings" ADD CONSTRAINT "banner_zone_settings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;