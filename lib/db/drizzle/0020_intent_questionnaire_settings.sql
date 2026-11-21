CREATE TABLE IF NOT EXISTS intent_questionnaire_settings (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL,
  dimension TEXT NOT NULL,
  label TEXT NOT NULL,
  max_points INTEGER NOT NULL CHECK(max_points BETWEEN 0 AND 100),
  rules JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS intent_questionnaire_settings_tenant_dimension_uq
  ON intent_questionnaire_settings(tenant_id, dimension);