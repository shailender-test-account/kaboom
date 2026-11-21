CREATE TABLE "hp_parent_research_accounts" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_id" integer NOT NULL,
	"client_id" integer NOT NULL,
	"parent_key" text NOT NULL,
	"parent_name" text NOT NULL,
	"account_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "hp_parent_research_accounts" ADD CONSTRAINT "hp_parent_research_accounts_account_id_companies_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "hp_parent_research_scope_idx" ON "hp_parent_research_accounts" USING btree ("tenant_id","client_id","parent_key");--> statement-breakpoint
CREATE UNIQUE INDEX "hp_parent_research_account_idx" ON "hp_parent_research_accounts" USING btree ("account_id");