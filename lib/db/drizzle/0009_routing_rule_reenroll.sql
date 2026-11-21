-- Add reenroll_after_completion to journey_routing_rules.
-- When false (default), contacts who already completed a sequence are not
-- re-enrolled when a routing rule fires. Set true on the rule to allow
-- intentional re-enrollment after completion.
ALTER TABLE "journey_routing_rules" ADD COLUMN IF NOT EXISTS "reenroll_after_completion" boolean NOT NULL DEFAULT false;--> statement-breakpoint
