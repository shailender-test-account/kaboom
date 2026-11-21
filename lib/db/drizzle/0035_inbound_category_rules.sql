CREATE TABLE IF NOT EXISTS intent_inbound_category_rules (
  tenant_id INTEGER PRIMARY KEY,
  rules JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);