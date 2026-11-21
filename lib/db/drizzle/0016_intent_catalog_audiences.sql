CREATE TABLE IF NOT EXISTS intent_product_categories (
  id SERIAL PRIMARY KEY, tenant_id INTEGER NOT NULL, name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(tenant_id,name)
);
CREATE TABLE IF NOT EXISTS intent_product_subcategories (
  id SERIAL PRIMARY KEY, tenant_id INTEGER NOT NULL, category_id INTEGER NOT NULL, name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(tenant_id,category_id,name)
);
CREATE TABLE IF NOT EXISTS intent_products (
  id SERIAL PRIMARY KEY, tenant_id INTEGER NOT NULL, category_id INTEGER NOT NULL, subcategory_id INTEGER,
  name TEXT NOT NULL, active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(tenant_id,name)
);
CREATE INDEX IF NOT EXISTS intent_products_tenant_category_idx ON intent_products(tenant_id,category_id,subcategory_id);
CREATE TABLE IF NOT EXISTS intent_audiences (
  id SERIAL PRIMARY KEY, tenant_id INTEGER NOT NULL, client_id INTEGER, name TEXT NOT NULL, description TEXT, created_by INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(tenant_id,name)
);
CREATE TABLE IF NOT EXISTS intent_audience_companies (
  id SERIAL PRIMARY KEY, tenant_id INTEGER NOT NULL, audience_id INTEGER NOT NULL, company_id INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(tenant_id,audience_id,company_id)
);
CREATE INDEX IF NOT EXISTS intent_audience_companies_company_idx ON intent_audience_companies(tenant_id,company_id);
ALTER TABLE intent_signals ADD COLUMN IF NOT EXISTS product_id INTEGER;
ALTER TABLE intent_import_runs ADD COLUMN IF NOT EXISTS product_id INTEGER;
ALTER TABLE intent_import_runs ADD COLUMN IF NOT EXISTS audience_id INTEGER;
ALTER TABLE intent_audiences ADD COLUMN IF NOT EXISTS client_id INTEGER;
CREATE INDEX IF NOT EXISTS intent_audiences_tenant_client_idx ON intent_audiences(tenant_id,client_id);
CREATE INDEX IF NOT EXISTS intent_signals_tenant_product_entity_idx ON intent_signals(tenant_id,product_id,account_id,occurred_at);