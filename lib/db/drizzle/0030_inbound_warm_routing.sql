CREATE TABLE IF NOT EXISTS intent_inbound_routing_rules (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL,
  client_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  match_type TEXT NOT NULL CHECK (match_type IN ('product','category','fallback')),
  product_id INTEGER,
  category_id INTEGER,
  keywords JSONB NOT NULL DEFAULT '[]',
  journey_id INTEGER NOT NULL,
  sequence_id INTEGER NOT NULL,
  priority INTEGER NOT NULL DEFAULT 100,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_by INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS intent_inbound_routing_rules_lookup_idx
  ON intent_inbound_routing_rules (tenant_id, client_id, enabled, priority);

ALTER TABLE intent_inbound_submissions
  ADD COLUMN IF NOT EXISTS routed_rule_id INTEGER,
  ADD COLUMN IF NOT EXISTS routing_status TEXT NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS routing_error TEXT,
  ADD COLUMN IF NOT EXISTS routed_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS intent_inbound_submissions_routing_idx
  ON intent_inbound_submissions (tenant_id, routing_status, classification);