CREATE TABLE IF NOT EXISTS score_history (
  id         SERIAL PRIMARY KEY,
  tenant_id  INTEGER NOT NULL,
  contact_id INTEGER NOT NULL,
  old_score  INTEGER NOT NULL DEFAULT 0,
  new_score  INTEGER NOT NULL,
  delta      INTEGER NOT NULL,
  source     TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_score_history_contact ON score_history (contact_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_score_history_tenant ON score_history (tenant_id, created_at DESC);
