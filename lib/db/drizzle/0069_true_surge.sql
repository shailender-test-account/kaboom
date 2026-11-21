CREATE TABLE "sales_access_audit" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_id" integer NOT NULL,
	"actor_id" integer NOT NULL,
	"target_id" integer NOT NULL,
	"kind" text NOT NULL,
	"before_value" jsonb NOT NULL,
	"after_value" jsonb NOT NULL,
	"requested_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"outcome" text NOT NULL,
	CONSTRAINT "sales_access_audit_kind_check" CHECK ("sales_access_audit"."kind" IN ('owners','visibility')),
	CONSTRAINT "sales_access_audit_outcome_check" CHECK ("sales_access_audit"."outcome" IN ('changed','unchanged','rejected')),
	CONSTRAINT "sales_access_audit_value_check" CHECK ((
    ("sales_access_audit"."kind"='owners' AND jsonb_typeof("sales_access_audit"."before_value")='array' AND jsonb_typeof("sales_access_audit"."after_value")='array')
    OR ("sales_access_audit"."kind"='visibility' AND "sales_access_audit"."before_value" IN ('"owned"'::jsonb,'"all"'::jsonb)
      AND "sales_access_audit"."after_value" IN ('"owned"'::jsonb,'"all"'::jsonb))))
);
--> statement-breakpoint
CREATE INDEX "sales_access_audit_target_idx" ON "sales_access_audit" USING btree ("tenant_id","kind","target_id","id");--> statement-breakpoint
CREATE FUNCTION sales_access_audit_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Sales access history is append-only';
END;
$$;--> statement-breakpoint
CREATE TRIGGER sales_access_audit_immutable_rows BEFORE UPDATE OR DELETE ON sales_access_audit
FOR EACH ROW EXECUTE FUNCTION sales_access_audit_immutable();--> statement-breakpoint
CREATE TRIGGER sales_access_audit_immutable_truncate BEFORE TRUNCATE ON sales_access_audit
FOR EACH STATEMENT EXECUTE FUNCTION sales_access_audit_immutable();