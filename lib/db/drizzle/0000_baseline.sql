CREATE TABLE "tenants" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"plan" text DEFAULT 'free' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenants_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_id" integer NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"first_name" text NOT NULL,
	"last_name" text NOT NULL,
	"role" text DEFAULT 'viewer' NOT NULL,
	"avatar_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "clients" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_id" integer NOT NULL,
	"name" text NOT NULL,
	"domain" text,
	"industry" text,
	"company_size" text,
	"website" text,
	"logo_url" text,
	"description" text,
	"icp_notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "play_contacts" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_id" integer NOT NULL,
	"play_id" integer NOT NULL,
	"contact_id" integer NOT NULL,
	"enrolled_at" timestamp with time zone DEFAULT now() NOT NULL,
	"enrolled_by" integer,
	CONSTRAINT "play_contacts_play_contact_unique" UNIQUE("play_id","contact_id")
);
--> statement-breakpoint
CREATE TABLE "abm_plays" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_id" integer NOT NULL,
	"client_id" integer NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"target_audience" text,
	"sequence_id" integer,
	"start_date" timestamp with time zone,
	"end_date" timestamp with time zone,
	"contacts_enrolled" integer DEFAULT 0 NOT NULL,
	"emails_sent" integer DEFAULT 0 NOT NULL,
	"page_views" integer DEFAULT 0 NOT NULL,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "journey_pages" (
	"id" serial PRIMARY KEY NOT NULL,
	"journey_id" integer NOT NULL,
	"title" text NOT NULL,
	"page_type" text DEFAULT 'html' NOT NULL,
	"content" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"cta_text" text,
	"cta_enabled" text DEFAULT 'false' NOT NULL,
	"view_count" integer DEFAULT 0 NOT NULL,
	"page_stage" text DEFAULT 'aware',
	"score" integer DEFAULT 0 NOT NULL,
	"is_published" boolean DEFAULT true NOT NULL,
	"cta_type" text DEFAULT 'next',
	"cta_asset_url" text,
	"gating_action" text DEFAULT 'none' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "journeys" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_id" integer NOT NULL,
	"client_id" integer NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"theme" text DEFAULT 'dark' NOT NULL,
	"header_logo_url" text,
	"header_btn_text" text,
	"header_btn_url" text,
	"header_btn_type" text DEFAULT 'url' NOT NULL,
	"header_tagline" text,
	"navigation_mode" text DEFAULT 'free' NOT NULL,
	"start_date" timestamp with time zone,
	"end_date" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "journeys_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "companies" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_id" integer NOT NULL,
	"client_id" integer NOT NULL,
	"name" text NOT NULL,
	"domain" text,
	"industry" text,
	"size" text,
	"website" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contacts" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_id" integer NOT NULL,
	"client_id" integer,
	"company_id" integer,
	"first_name" text,
	"last_name" text,
	"email" text,
	"phone" text,
	"title" text,
	"tags" text[] DEFAULT '{}' NOT NULL,
	"lead_score" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"stage" text DEFAULT 'pre-aware' NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"last_activity" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"designation" text,
	"function" text,
	"employee_size" text,
	"company_revenue" text,
	"linkedin_url" text,
	"company_linkedin_url" text,
	"city" text,
	"pin" text,
	"state" text,
	"country" text,
	"hq_country" text,
	"company_name" text
);
--> statement-breakpoint
CREATE TABLE "deals" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_id" integer NOT NULL,
	"client_id" integer NOT NULL,
	"company_id" integer,
	"contact_id" integer,
	"title" text NOT NULL,
	"value" numeric(12, 2),
	"stage" text DEFAULT 'prospect' NOT NULL,
	"priority" text DEFAULT 'medium' NOT NULL,
	"expected_close_date" timestamp with time zone,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sequences" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_id" integer NOT NULL,
	"client_id" integer NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"nodes" text DEFAULT '[]' NOT NULL,
	"step_count" integer DEFAULT 0 NOT NULL,
	"enrolled_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "activity_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"contact_id" integer,
	"contact_name" text,
	"client_id" integer,
	"event_type" text NOT NULL,
	"description" text NOT NULL,
	"metadata" text,
	"points_earned" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contact_notes" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_id" integer NOT NULL,
	"contact_id" integer NOT NULL,
	"author_id" integer,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "score_thresholds" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_id" integer NOT NULL,
	"label" text NOT NULL,
	"min_score" integer NOT NULL,
	"color" text DEFAULT 'gray' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scoring_rules" (
	"id" serial PRIMARY KEY NOT NULL,
	"event_type" text NOT NULL,
	"points" integer NOT NULL,
	"description" text,
	"is_active" text DEFAULT 'true' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_id" integer NOT NULL,
	"contact_id" integer,
	"template_id" integer,
	"event_type" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_sequences" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_id" integer NOT NULL,
	"play_id" integer,
	"name" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"trigger_type" text DEFAULT 'MANUAL' NOT NULL,
	"trigger_config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"nodes_json" jsonb DEFAULT '{"nodes":[],"edges":[]}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_templates" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_id" integer NOT NULL,
	"name" text NOT NULL,
	"category" text DEFAULT 'Outreach' NOT NULL,
	"subject" text NOT NULL,
	"body_html" text DEFAULT '' NOT NULL,
	"body_text" text DEFAULT '' NOT NULL,
	"variables" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sequence_enrollments" (
	"id" serial PRIMARY KEY NOT NULL,
	"sequence_id" integer NOT NULL,
	"contact_id" integer NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"current_step_id" integer,
	"enrolled_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "sequence_steps" (
	"id" serial PRIMARY KEY NOT NULL,
	"sequence_id" integer NOT NULL,
	"step_order" integer DEFAULT 0 NOT NULL,
	"step_type" text DEFAULT 'email' NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"wait_duration" integer,
	"wait_unit" text DEFAULT 'hours',
	"condition_config" jsonb,
	"true_next_step_id" integer,
	"false_next_step_id" integer,
	"node_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_id" integer NOT NULL,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"body" text,
	"contact_id" integer,
	"read" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "journey_companies" (
	"id" serial PRIMARY KEY NOT NULL,
	"journey_id" integer NOT NULL,
	"company_id" integer NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "journey_contacts" (
	"id" serial PRIMARY KEY NOT NULL,
	"journey_id" integer NOT NULL,
	"contact_id" integer NOT NULL,
	"added_via" text DEFAULT 'manual' NOT NULL,
	"segment_id" integer,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "journey_routing_rules" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_id" integer NOT NULL,
	"condition_type" text NOT NULL,
	"condition_value" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"journey_id" integer NOT NULL,
	"enroll_sequence_id" integer,
	"apply_to" text DEFAULT 'all' NOT NULL,
	"apply_client_id" integer,
	"apply_segment_id" integer,
	"if_already_in_journey" text DEFAULT 'skip' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "journey_segments" (
	"id" serial PRIMARY KEY NOT NULL,
	"journey_id" integer NOT NULL,
	"segment_id" integer NOT NULL,
	"snapshot_mode" boolean DEFAULT false NOT NULL,
	"snapshot_contact_ids" integer[],
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_synced_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "segments" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_id" integer NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"segment_type" text DEFAULT 'dynamic' NOT NULL,
	"filter_criteria" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"static_contact_ids" integer[],
	"logic_operator" text DEFAULT 'AND' NOT NULL,
	"last_computed_count" integer DEFAULT 0 NOT NULL,
	"last_computed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sequence_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_id" integer NOT NULL,
	"sequence_id" integer NOT NULL,
	"journey_id" integer,
	"client_id" integer,
	"segment_id" integer,
	"contact_list_ids" integer[],
	"status" text DEFAULT 'pending' NOT NULL,
	"total_contacts" integer DEFAULT 0 NOT NULL,
	"enrolled" integer DEFAULT 0 NOT NULL,
	"skipped" integer DEFAULT 0 NOT NULL,
	"errors" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"started_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
