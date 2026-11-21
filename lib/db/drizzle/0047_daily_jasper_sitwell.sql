CREATE TABLE "hp_mapping_presets" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_id" integer NOT NULL,
	"client_id" integer NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"headers" jsonb NOT NULL,
	"mappings" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hp_mapping_preset_kind" CHECK ("hp_mapping_presets"."kind" IN ('accounts','activities'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "hp_mapping_preset_name" ON "hp_mapping_presets" USING btree ("tenant_id","client_id","kind","name");