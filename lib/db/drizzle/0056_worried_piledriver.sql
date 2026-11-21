CREATE TABLE "buying_committee_internal_contacts" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_id" integer NOT NULL,
	"client_id" integer NOT NULL,
	"company_id" integer NOT NULL,
	"contact_id" integer NOT NULL,
	"target_id" integer NOT NULL,
	"categories" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sourced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "buying_committee_internal_contacts" ADD CONSTRAINT "buying_committee_internal_contacts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "buying_committee_internal_contacts" ADD CONSTRAINT "buying_committee_internal_contacts_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "buying_committee_internal_contacts" ADD CONSTRAINT "buying_committee_internal_contacts_target_id_buying_committee_targets_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."buying_committee_targets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "buying_committee_internal_target_contact_uq" ON "buying_committee_internal_contacts" USING btree ("target_id","contact_id");--> statement-breakpoint
CREATE INDEX "buying_committee_internal_scope_idx" ON "buying_committee_internal_contacts" USING btree ("tenant_id","client_id","company_id","contact_id");