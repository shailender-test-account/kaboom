ALTER TABLE intent_evidence
  ADD COLUMN IF NOT EXISTS import_run_id INTEGER;

CREATE INDEX IF NOT EXISTS intent_evidence_tenant_import_run_idx
  ON intent_evidence(tenant_id, import_run_id);

DROP INDEX IF EXISTS intent_import_runs_tenant_hash_uq;

CREATE UNIQUE INDEX IF NOT EXISTS intent_import_runs_tenant_hash_uq
  ON intent_import_runs(
    tenant_id,
    kind,
    COALESCE(client_id, 0),
    COALESCE(product_id, 0),
    COALESCE(audience_id, 0),
    file_hash
  );