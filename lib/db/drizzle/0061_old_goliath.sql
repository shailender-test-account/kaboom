CREATE TABLE "sales_feedback_sources" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_id" integer NOT NULL,
	"client_id" integer NOT NULL,
	"name" text NOT NULL,
	"folder_url" text NOT NULL,
	"folder_id" text NOT NULL,
	"type" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"field_mappings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"file_versions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_synced_at" timestamp with time zone,
	"last_error" text
);
--> statement-breakpoint
CREATE TABLE "sales_feedback" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_id" integer NOT NULL,
	"client_id" integer NOT NULL,
	"source_id" integer,
	"account_id" integer,
	"contact_id" integer,
	"type" text NOT NULL,
	"occurred_at" timestamp with time zone,
	"rep_name" text NOT NULL,
	"feedback" text NOT NULL,
	"next_action" text,
	"product" text,
	"timing_months" integer,
	"proposed_temperature" text,
	"review_status" text DEFAULT 'pending' NOT NULL,
	"approved_qualification" boolean DEFAULT false NOT NULL,
	"review_note" text,
	"reviewed_at" timestamp with time zone,
	"reviewed_by" integer,
	"review_history" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"file_name" text,
	"file_id" text,
	"sheet_name" text,
	"row_number" integer,
	"record_key" text NOT NULL,
	"content_hash" text NOT NULL,
	"raw_fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sales_feedback_sources" ADD CONSTRAINT "sales_feedback_sources_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_feedback_sources" ADD CONSTRAINT "sales_feedback_sources_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_feedback" ADD CONSTRAINT "sales_feedback_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_feedback" ADD CONSTRAINT "sales_feedback_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_feedback" ADD CONSTRAINT "sales_feedback_source_id_sales_feedback_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sales_feedback_sources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_feedback" ADD CONSTRAINT "sales_feedback_account_id_companies_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_feedback" ADD CONSTRAINT "sales_feedback_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sales_feedback_sources_owner" ON "sales_feedback_sources" USING btree ("tenant_id","client_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sales_feedback_revision" ON "sales_feedback" USING btree ("tenant_id","record_key","content_hash");--> statement-breakpoint
CREATE INDEX "sales_feedback_account" ON "sales_feedback" USING btree ("tenant_id","client_id","account_id","contact_id");--> statement-breakpoint
CREATE INDEX "sales_feedback_review" ON "sales_feedback" USING btree ("tenant_id","review_status","id");