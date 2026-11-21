CREATE TABLE "hp_account_profiles" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_id" integer NOT NULL,
	"client_id" integer NOT NULL,
	"company_id" integer NOT NULL,
	"hp_id" text,
	"deployment" text,
	"gtm" text,
	"account_group" text,
	"state_ut" text,
	"zone" text,
	"parent_sub" text,
	"top_id" text,
	"top_name" text,
	"mid_id" text,
	"mid_name" text,
	"act_st" text,
	"st_name" text,
	"partial_st" text,
	"partial_name" text,
	"org_id" text,
	"opsi" text,
	"legal_name" text,
	"city" text,
	"state" text,
	"relationship_link" text,
	"industry_vertical" text,
	"industry_segment" text,
	"hpi_segment" text,
	"e_cat" text,
	"emp_size" text,
	"ps_tam_k" text,
	"prt_tam_k" text,
	"ps_rad" text,
	"prt_rad" text,
	"rtm_ps" text,
	"ps_partners" text,
	"rtm_print" text,
	"print_partners" text,
	"eam_email" text,
	"pam_email" text,
	"rm_email" text,
	"isr_email" text,
	"zm_email" text,
	"poly_am_email" text,
	"poly_mgr_email" text,
	"parent_key" text NOT NULL,
	"parent_name" text NOT NULL,
	"dimensions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"variants" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"aliases" text[] DEFAULT '{}' NOT NULL,
	"is_new" boolean DEFAULT false NOT NULL,
	"provenance" text NOT NULL,
	"abm_classification" text,
	"top_200" boolean DEFAULT false NOT NULL,
	"global_account" boolean,
	"profiled" boolean,
	"buying_behavior" text,
	"propensity" text,
	"buyer_categories" text[] DEFAULT '{}' NOT NULL,
	"whitespace_categories" text[] DEFAULT '{}' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hp_bi_contacts" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_id" integer NOT NULL,
	"client_id" integer NOT NULL,
	"contact_id" integer NOT NULL,
	"is_new" boolean NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hp_bi_imports" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_id" integer NOT NULL,
	"client_id" integer NOT NULL,
	"file_name" text NOT NULL,
	"file_hash" text NOT NULL,
	"kind" text NOT NULL,
	"rows" integer NOT NULL,
	"accounts" integer NOT NULL,
	"result" jsonb NOT NULL,
	"imported_by" integer,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hp_bi_matches" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_id" integer NOT NULL,
	"client_id" integer NOT NULL,
	"source_key" text NOT NULL,
	"reason" text NOT NULL,
	"payload" jsonb NOT NULL,
	"resolved_account_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hp_bi_records" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_id" integer NOT NULL,
	"client_id" integer NOT NULL,
	"account_id" integer NOT NULL,
	"contact_id" integer,
	"kind" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"category" text,
	"product" text,
	"horizon_months" numeric,
	"order_value" numeric,
	"currency" text,
	"status" text,
	"source" text NOT NULL,
	"source_name" text,
	"source_key" text NOT NULL,
	"external_event_id" text,
	"lineage" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "hp_profile_company" ON "hp_account_profiles" USING btree ("tenant_id","client_id","company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "hp_profile_stable_id" ON "hp_account_profiles" USING btree ("tenant_id","client_id","hp_id");--> statement-breakpoint
CREATE INDEX "hp_profile_scope" ON "hp_account_profiles" USING btree ("tenant_id","client_id","parent_key");--> statement-breakpoint
CREATE UNIQUE INDEX "hp_contact_provenance" ON "hp_bi_contacts" USING btree ("tenant_id","client_id","contact_id");--> statement-breakpoint
CREATE UNIQUE INDEX "hp_match_key" ON "hp_bi_matches" USING btree ("tenant_id","client_id","source_key");--> statement-breakpoint
CREATE UNIQUE INDEX "hp_record_source" ON "hp_bi_records" USING btree ("tenant_id","client_id","source_key");--> statement-breakpoint
CREATE INDEX "hp_record_period" ON "hp_bi_records" USING btree ("tenant_id","client_id","occurred_at","account_id");