ALTER TABLE intent_contact_discovery_runs
  ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS summary JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS error TEXT,
  ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS intent_discovery_runs_tenant_status_idx
  ON intent_contact_discovery_runs(tenant_id,status,created_at);