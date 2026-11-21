CREATE TABLE "intent_product_pricing" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_id" integer NOT NULL,
	"product_id" integer NOT NULL,
	"average_unit_price" numeric(14, 2) DEFAULT '0' NOT NULL,
	"currency" text DEFAULT 'INR' NOT NULL,
	"updated_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "intent_product_pricing_nonnegative_ck" CHECK ("intent_product_pricing"."average_unit_price" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "intent_product_pricing_tenant_product_uq" ON "intent_product_pricing" USING btree ("tenant_id","product_id");