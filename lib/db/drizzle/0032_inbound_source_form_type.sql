ALTER TABLE intent_inbound_sources
  ADD COLUMN IF NOT EXISTS form_type TEXT NOT NULL DEFAULT 'lead_form';

UPDATE intent_inbound_sources
SET form_type = 'event_feedback'
WHERE lower(name) LIKE '%event%'
  AND lower(name) LIKE '%feedback%';

ALTER TABLE intent_inbound_sources
  DROP CONSTRAINT IF EXISTS intent_inbound_sources_form_type_ck;

ALTER TABLE intent_inbound_sources
  ADD CONSTRAINT intent_inbound_sources_form_type_ck
  CHECK (form_type IN ('lead_form','event_feedback'));