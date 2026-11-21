CREATE TABLE "user_sessions" (
	"sid" varchar PRIMARY KEY NOT NULL,
	"sess" json NOT NULL,
	"expire" timestamp (6) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "media_assets" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_id" integer NOT NULL,
	"name" text NOT NULL,
	"object_path" text NOT NULL,
	"mime_type" text DEFAULT 'application/octet-stream' NOT NULL,
	"file_size" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cta_buttons" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_id" integer NOT NULL,
	"name" text NOT NULL,
	"label" text NOT NULL,
	"action_type" text NOT NULL,
	"action_config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"style_config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "banner_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"banner_id" integer NOT NULL,
	"event_type" text NOT NULL,
	"visitor_token" text,
	"journey_id" integer,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "banner_events_event_type_check" CHECK ("banner_events"."event_type" IN ('impression', 'click', 'dismiss'))
);
--> statement-breakpoint
CREATE TABLE "banners" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_id" integer NOT NULL,
	"name" text NOT NULL,
	"position" text DEFAULT 'top' NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"zone" text,
	"status" text DEFAULT 'active' NOT NULL,
	"start_date" timestamp with time zone,
	"end_date" timestamp with time zone,
	"original_width" integer,
	"original_height" integer,
	"file_size" bigint,
	"original_filename" text
);
--> statement-breakpoint
CREATE TABLE "journey_forms" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_id" integer NOT NULL,
	"name" text NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "page_components" (
	"id" serial PRIMARY KEY NOT NULL,
	"journey_page_id" integer NOT NULL,
	"component_type" text NOT NULL,
	"component_id" integer NOT NULL,
	"position" text DEFAULT 'inline' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"override_config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "form_submissions" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_id" integer NOT NULL,
	"form_id" integer,
	"contact_id" integer,
	"journey_id" integer,
	"page_id" integer,
	"visitor_token" text,
	"field_values" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"action_type" text,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "asset_downloads" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_id" integer NOT NULL,
	"asset_id" integer NOT NULL,
	"visitor_token" text,
	"page_id" integer,
	"downloaded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenant_integrations" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_id" integer NOT NULL,
	"provider" text NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_integrations_tenant_id_provider_key" UNIQUE("tenant_id","provider")
);
--> statement-breakpoint
CREATE TABLE "visitor_tokens" (
	"id" serial PRIMARY KEY NOT NULL,
	"token" text NOT NULL,
	"contact_id" integer NOT NULL,
	"tenant_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "visitor_tokens_token_unique" UNIQUE("token")
);
--> statement-breakpoint
ALTER TABLE "page_components" ADD CONSTRAINT "page_components_journey_page_id_journey_pages_id_fk" FOREIGN KEY ("journey_page_id") REFERENCES "public"."journey_pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_submissions" ADD CONSTRAINT "form_submissions_form_id_journey_forms_id_fk" FOREIGN KEY ("form_id") REFERENCES "public"."journey_forms"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_submissions" ADD CONSTRAINT "form_submissions_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_submissions" ADD CONSTRAINT "form_submissions_journey_id_journeys_id_fk" FOREIGN KEY ("journey_id") REFERENCES "public"."journeys"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_integrations" ADD CONSTRAINT "tenant_integrations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visitor_tokens" ADD CONSTRAINT "visitor_tokens_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_session_expire" ON "user_sessions" USING btree ("expire");--> statement-breakpoint
CREATE INDEX "cta_buttons_tenant_idx" ON "cta_buttons" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_banner_events_banner_id" ON "banner_events" USING btree ("banner_id");--> statement-breakpoint
CREATE INDEX "idx_banner_events_occurred_at" ON "banner_events" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "idx_banner_events_type_banner" ON "banner_events" USING btree ("banner_id","event_type");--> statement-breakpoint
CREATE INDEX "page_components_page_idx" ON "page_components" USING btree ("journey_page_id");--> statement-breakpoint
CREATE INDEX "idx_form_submissions_tenant" ON "form_submissions" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_form_submissions_form" ON "form_submissions" USING btree ("form_id");--> statement-breakpoint
CREATE INDEX "idx_form_submissions_contact" ON "form_submissions" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "asset_downloads_asset_idx" ON "asset_downloads" USING btree ("asset_id");--> statement-breakpoint
CREATE INDEX "visitor_tokens_token_idx" ON "visitor_tokens" USING btree ("token");--> statement-breakpoint
CREATE INDEX "visitor_tokens_contact_idx" ON "visitor_tokens" USING btree ("contact_id");