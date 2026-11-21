CREATE TABLE "buying_committee_contacts" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_id" integer NOT NULL,
	"client_id" integer NOT NULL,
	"company_id" integer NOT NULL,
	"apollo_id" text NOT NULL,
	"name" text NOT NULL,
	"title" text,
	"email" text,
	"phone" text,
	"linkedin" text,
	"location" text,
	"categories" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sourced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "buying_committee_plans" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_id" integer NOT NULL,
	"client_id" integer NOT NULL,
	"name" text NOT NULL,
	"config" jsonb NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_by" integer NOT NULL,
	"approved_by" integer,
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "buying_committee_targets" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_id" integer NOT NULL,
	"plan_id" integer NOT NULL,
	"company_id" integer NOT NULL,
	"domain" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"requests" integer DEFAULT 0 NOT NULL,
	"responses" integer DEFAULT 0 NOT NULL,
	"found" integer DEFAULT 0 NOT NULL,
	"error" text,
	"lease" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "buying_committee_contacts" ADD CONSTRAINT "buying_committee_contacts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "buying_committee_targets" ADD CONSTRAINT "buying_committee_targets_plan_id_buying_committee_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."buying_committee_plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "buying_committee_targets" ADD CONSTRAINT "buying_committee_targets_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "buying_committee_contacts_identity_uq" ON "buying_committee_contacts" USING btree ("tenant_id","client_id","company_id","apollo_id");--> statement-breakpoint
CREATE INDEX "buying_committee_contacts_scope_idx" ON "buying_committee_contacts" USING btree ("tenant_id","client_id","company_id","id");--> statement-breakpoint
CREATE INDEX "buying_committee_plans_scope_idx" ON "buying_committee_plans" USING btree ("tenant_id","client_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "buying_committee_targets_plan_company_uq" ON "buying_committee_targets" USING btree ("plan_id","company_id");--> statement-breakpoint
CREATE INDEX "buying_committee_targets_scope_idx" ON "buying_committee_targets" USING btree ("tenant_id","plan_id");