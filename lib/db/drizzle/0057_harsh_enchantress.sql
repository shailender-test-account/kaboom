CREATE TABLE "contact_databases" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_id" integer NOT NULL,
	"name" text NOT NULL,
	"segment_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contact_dataset_members" (
	"id" serial PRIMARY KEY NOT NULL,
	"dataset_id" integer NOT NULL,
	"contact_id" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contact_datasets" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_id" integer NOT NULL,
	"database_id" integer,
	"segment_id" integer,
	"client_id" integer,
	"name" text NOT NULL,
	"added_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contact_verifications" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_id" integer NOT NULL,
	"contact_id" integer NOT NULL,
	"status" text DEFAULT 'processing' NOT NULL,
	"original" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"proposed" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"filled_fields" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "contact_databases" ADD CONSTRAINT "contact_databases_segment_id_segments_id_fk" FOREIGN KEY ("segment_id") REFERENCES "public"."segments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_dataset_members" ADD CONSTRAINT "contact_dataset_members_dataset_id_contact_datasets_id_fk" FOREIGN KEY ("dataset_id") REFERENCES "public"."contact_datasets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_dataset_members" ADD CONSTRAINT "contact_dataset_members_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_datasets" ADD CONSTRAINT "contact_datasets_database_id_contact_databases_id_fk" FOREIGN KEY ("database_id") REFERENCES "public"."contact_databases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_datasets" ADD CONSTRAINT "contact_datasets_segment_id_segments_id_fk" FOREIGN KEY ("segment_id") REFERENCES "public"."segments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_verifications" ADD CONSTRAINT "contact_verifications_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "contact_databases_tenant_name" ON "contact_databases" USING btree ("tenant_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "contact_dataset_members_unique" ON "contact_dataset_members" USING btree ("dataset_id","contact_id");--> statement-breakpoint
CREATE INDEX "contact_dataset_members_contact_idx" ON "contact_dataset_members" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "contact_datasets_scope_idx" ON "contact_datasets" USING btree ("tenant_id","database_id");--> statement-breakpoint
CREATE INDEX "contact_verifications_contact_idx" ON "contact_verifications" USING btree ("tenant_id","contact_id","id");