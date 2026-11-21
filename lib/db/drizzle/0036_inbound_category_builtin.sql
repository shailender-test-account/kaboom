ALTER TABLE intent_inbound_category_rules
  ADD COLUMN use_builtin BOOLEAN NOT NULL DEFAULT TRUE;