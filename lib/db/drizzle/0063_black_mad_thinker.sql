CREATE TABLE "hp_hot_follow_ups" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_id" integer NOT NULL,
	"client_id" integer NOT NULL,
	"account_id" integer NOT NULL,
	"contact_id" integer NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"evidence_key" text NOT NULL,
	"assignee_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"completed_by" integer,
	"completion_note" text
);
--> statement-breakpoint
ALTER TABLE "hp_hot_follow_ups" ADD CONSTRAINT "hp_hot_follow_ups_account_id_companies_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hp_hot_follow_ups" ADD CONSTRAINT "hp_hot_follow_ups_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hp_hot_follow_ups" ADD CONSTRAINT "hp_hot_follow_ups_assignee_id_users_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hp_hot_follow_ups" ADD CONSTRAINT "hp_hot_follow_ups_completed_by_users_id_fk" FOREIGN KEY ("completed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "hp_hot_follow_up_contact" ON "hp_hot_follow_ups" USING btree ("tenant_id","contact_id");--> statement-breakpoint
CREATE INDEX "hp_hot_follow_up_queue" ON "hp_hot_follow_ups" USING btree ("tenant_id","client_id","status","id");