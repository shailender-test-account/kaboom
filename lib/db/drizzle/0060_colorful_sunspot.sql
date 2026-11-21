CREATE TABLE "hp_warm_checks" (
	"tenant_id" integer NOT NULL,
	"client_id" integer NOT NULL,
	"parent_key" text NOT NULL,
	"status" text NOT NULL,
	"reason" text NOT NULL,
	"journeys" jsonb NOT NULL,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hp_warm_checks_tenant_id_client_id_parent_key_pk" PRIMARY KEY("tenant_id","client_id","parent_key"),
	CONSTRAINT "hp_warm_check_status" CHECK ("hp_warm_checks"."status" IN ('routed','blocked','unmapped','not_eligible'))
);
--> statement-breakpoint
CREATE TABLE "hp_warm_sweeps" (
	"tenant_id" integer NOT NULL,
	"client_id" integer NOT NULL,
	"cursor" text DEFAULT '' NOT NULL,
	"last_success_at" timestamp with time zone,
	"last_completed_at" timestamp with time zone,
	"last_failure_at" timestamp with time zone,
	CONSTRAINT "hp_warm_sweeps_tenant_id_client_id_pk" PRIMARY KEY("tenant_id","client_id")
);
--> statement-breakpoint
ALTER TABLE "hp_warm_checks" ADD CONSTRAINT "hp_warm_checks_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hp_warm_checks" ADD CONSTRAINT "hp_warm_checks_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hp_warm_sweeps" ADD CONSTRAINT "hp_warm_sweeps_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hp_warm_sweeps" ADD CONSTRAINT "hp_warm_sweeps_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;