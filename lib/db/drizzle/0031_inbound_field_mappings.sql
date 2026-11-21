ALTER TABLE intent_inbound_sources
  ADD COLUMN IF NOT EXISTS field_mappings JSONB NOT NULL DEFAULT '{}';