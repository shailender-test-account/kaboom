ALTER TABLE intent_inbound_submissions
  ADD COLUMN IF NOT EXISTS event_feedback JSONB NOT NULL DEFAULT '{}';