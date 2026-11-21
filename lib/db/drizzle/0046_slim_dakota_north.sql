ALTER TABLE "journey_pages" ADD COLUMN "bi_category" text;--> statement-breakpoint
ALTER TABLE "journey_pages" ADD COLUMN "bi_product" text;--> statement-breakpoint
ALTER TABLE "journey_pages" ADD COLUMN "bi_program" text;--> statement-breakpoint
ALTER TABLE "hp_account_profiles" ADD COLUMN "edits" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "hp_bi_records" ADD COLUMN "history" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "hp_account_profiles" ADD CONSTRAINT "hp_account_profiles_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hp_bi_contacts" ADD CONSTRAINT "hp_bi_contacts_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hp_bi_records" ADD CONSTRAINT "hp_bi_records_account_id_companies_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hp_bi_records" ADD CONSTRAINT "hp_bi_records_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;