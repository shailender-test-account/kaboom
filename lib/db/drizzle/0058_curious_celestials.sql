CREATE TABLE "contact_verification_usage" (
	"tenant_id" integer PRIMARY KEY NOT NULL,
	"request_limit" integer DEFAULT 0 NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"responses" integer DEFAULT 0 NOT NULL,
	"legacy_attempts" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
-- Historical attempts remain budget-consuming, but their HTTP response outcome
-- was not recorded. Never infer responses or credits from verification status.
INSERT INTO contact_verification_usage(tenant_id,attempts,legacy_attempts)
SELECT tenant_id,COUNT(*)::integer,COUNT(*)::integer
FROM contact_verifications GROUP BY tenant_id;
