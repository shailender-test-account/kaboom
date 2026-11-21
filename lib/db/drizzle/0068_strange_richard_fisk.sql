CREATE TABLE "sales_account_owners" (
	"tenant_id" integer NOT NULL,
	"client_id" integer NOT NULL,
	"account_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	CONSTRAINT "sales_account_owners_tenant_id_account_id_user_id_pk" PRIMARY KEY("tenant_id","account_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "sales_user_access" (
	"tenant_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"visibility" text DEFAULT 'owned' NOT NULL,
	CONSTRAINT "sales_user_access_tenant_id_user_id_pk" PRIMARY KEY("tenant_id","user_id"),
	CONSTRAINT "sales_user_access_visibility_check" CHECK ("sales_user_access"."visibility" IN ('owned','all'))
);
--> statement-breakpoint
ALTER TABLE "sales_account_owners" ADD CONSTRAINT "sales_account_owners_account_id_companies_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_account_owners" ADD CONSTRAINT "sales_account_owners_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_user_access" ADD CONSTRAINT "sales_user_access_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sales_account_owners_user_idx" ON "sales_account_owners" USING btree ("tenant_id","user_id","account_id");