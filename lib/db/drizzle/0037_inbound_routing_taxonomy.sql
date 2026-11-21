ALTER TABLE intent_inbound_routing_rules
  ADD COLUMN IF NOT EXISTS inbound_product_name TEXT,
  ADD COLUMN IF NOT EXISTS inbound_category_name TEXT;