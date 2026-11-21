ALTER TABLE intent_inbound_submissions
  ADD COLUMN IF NOT EXISTS identity_review text,
  ADD COLUMN IF NOT EXISTS reviewed_email text,
  ADD COLUMN IF NOT EXISTS reviewed_source_account_id integer,
  ADD COLUMN IF NOT EXISTS reviewed_source_contact_id integer;
--> statement-breakpoint
ALTER TABLE intent_inbound_submissions
  ADD CONSTRAINT intent_inbound_submissions_identity_review_check
  CHECK (identity_review IS NULL OR identity_review IN ('keep','relink'));