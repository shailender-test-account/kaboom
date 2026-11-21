CREATE TABLE IF NOT EXISTS intent_inbound_sources (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL,
  client_id INTEGER NOT NULL,
  name TEXT NOT NULL DEFAULT 'Inbound forms',
  folder_url TEXT NOT NULL,
  folder_id TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  last_synced_at TIMESTAMPTZ,
  last_sync_status TEXT NOT NULL DEFAULT 'never',
  last_sync_summary JSONB NOT NULL DEFAULT '{}',
  created_by INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS intent_inbound_sources_tenant_folder_uq
  ON intent_inbound_sources (tenant_id, folder_id);
CREATE INDEX IF NOT EXISTS intent_inbound_sources_tenant_enabled_idx
  ON intent_inbound_sources (tenant_id, enabled);

CREATE TABLE IF NOT EXISTS intent_inbound_submissions (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL,
  source_id INTEGER NOT NULL REFERENCES intent_inbound_sources(id) ON DELETE CASCADE,
  client_id INTEGER NOT NULL,
  account_id INTEGER NOT NULL,
  contact_id INTEGER,
  drive_file_id TEXT NOT NULL,
  drive_modified_at TIMESTAMPTZ,
  row_key TEXT NOT NULL,
  file_name TEXT NOT NULL,
  form_type TEXT NOT NULL DEFAULT 'questionnaire',
  classification TEXT NOT NULL CHECK (classification IN ('hot','warm')),
  classification_reason TEXT NOT NULL,
  explicit_interest BOOLEAN NOT NULL DEFAULT FALSE,
  requested_demo BOOLEAN NOT NULL DEFAULT FALSE,
  purchase_timeframe_months INTEGER,
  is_decision_maker BOOLEAN NOT NULL DEFAULT FALSE,
  feedback TEXT,
  product_interest TEXT,
  submitted_at TIMESTAMPTZ,
  raw_fields JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS intent_inbound_submissions_row_uq
  ON intent_inbound_submissions (tenant_id, source_id, drive_file_id, row_key);
CREATE INDEX IF NOT EXISTS intent_inbound_submissions_account_idx
  ON intent_inbound_submissions (tenant_id, account_id, classification);
CREATE INDEX IF NOT EXISTS intent_inbound_submissions_contact_idx
  ON intent_inbound_submissions (tenant_id, contact_id);