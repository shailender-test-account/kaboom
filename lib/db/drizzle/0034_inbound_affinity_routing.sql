ALTER TABLE intent_inbound_routing_rules
  ADD COLUMN IF NOT EXISTS classification TEXT NOT NULL DEFAULT 'warm';

ALTER TABLE intent_inbound_routing_rules
  DROP CONSTRAINT IF EXISTS intent_inbound_routing_rules_classification_ck;

ALTER TABLE intent_inbound_routing_rules
  ADD CONSTRAINT intent_inbound_routing_rules_classification_ck
  CHECK (classification IN ('hot', 'warm', 'all'));

ALTER TABLE intent_inbound_routing_rules
  ALTER COLUMN journey_id DROP NOT NULL;