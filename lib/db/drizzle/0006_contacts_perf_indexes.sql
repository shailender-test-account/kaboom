-- Performance indexes for contacts and related tables
-- Supports up to ~50k contacts without degradation
-- Note: trigram (pg_trgm) indexes are intentionally omitted — pg_trgm is not
-- available on all PostgreSQL hosts; ILIKE queries degrade gracefully without them.

-- contacts: tenant_id alone (base predicate on every query)
CREATE INDEX IF NOT EXISTS idx_contacts_tenant_id
  ON contacts (tenant_id);

--> statement-breakpoint

-- contacts: default sort — tenant + lead_score DESC
CREATE INDEX IF NOT EXISTS idx_contacts_tenant_lead_score
  ON contacts (tenant_id, lead_score DESC);

--> statement-breakpoint

-- contacts: intent score sort — tenant + intent_score DESC NULLS LAST
CREATE INDEX IF NOT EXISTS idx_contacts_tenant_intent_score
  ON contacts (tenant_id, intent_score DESC NULLS LAST);

--> statement-breakpoint

-- contacts: date sort / created_at range filter
CREATE INDEX IF NOT EXISTS idx_contacts_tenant_created_at
  ON contacts (tenant_id, created_at DESC);

--> statement-breakpoint

-- contacts: status filter
CREATE INDEX IF NOT EXISTS idx_contacts_tenant_status
  ON contacts (tenant_id, status);

--> statement-breakpoint

-- contacts: stage filter
CREATE INDEX IF NOT EXISTS idx_contacts_tenant_stage
  ON contacts (tenant_id, stage);

--> statement-breakpoint

-- contacts: intent_state filter
CREATE INDEX IF NOT EXISTS idx_contacts_tenant_intent_state
  ON contacts (tenant_id, intent_state);

--> statement-breakpoint

-- contacts: client_id filter
CREATE INDEX IF NOT EXISTS idx_contacts_tenant_client_id
  ON contacts (tenant_id, client_id);

--> statement-breakpoint

-- contacts: company_id join / filter
CREATE INDEX IF NOT EXISTS idx_contacts_tenant_company_id
  ON contacts (tenant_id, company_id);

--> statement-breakpoint

-- contacts: email lookup for import dedup
CREATE INDEX IF NOT EXISTS idx_contacts_tenant_email
  ON contacts (tenant_id, email);

--> statement-breakpoint

-- contacts: tags array — GIN for ANY(tags) filter
CREATE INDEX IF NOT EXISTS idx_contacts_tags_gin
  ON contacts USING GIN (tags);

--> statement-breakpoint

-- activity_events: per-contact enrichment IN queries
CREATE INDEX IF NOT EXISTS idx_activity_events_contact_id
  ON activity_events (contact_id);

--> statement-breakpoint

-- activity_events: per-contact ordered timeline
CREATE INDEX IF NOT EXISTS idx_activity_events_contact_created
  ON activity_events (contact_id, created_at DESC);

--> statement-breakpoint

-- activity_events: tenant + event_type for scoring queries
CREATE INDEX IF NOT EXISTS idx_activity_events_tenant_event_type
  ON activity_events (tenant_id, event_type);

--> statement-breakpoint

-- journey_contacts: contact_id IN lookups
CREATE INDEX IF NOT EXISTS idx_journey_contacts_contact_id
  ON journey_contacts (contact_id);

--> statement-breakpoint

-- journey_contacts: journey_id filter
CREATE INDEX IF NOT EXISTS idx_journey_contacts_journey_id
  ON journey_contacts (journey_id);

--> statement-breakpoint

-- sequence_enrollments: contact_id IN lookups
CREATE INDEX IF NOT EXISTS idx_seq_enrollments_contact_id
  ON sequence_enrollments (contact_id);

--> statement-breakpoint

-- play_contacts: contact_id IN lookups
CREATE INDEX IF NOT EXISTS idx_play_contacts_contact_id
  ON play_contacts (contact_id);

--> statement-breakpoint

-- form_submissions: contact_id IN lookups
CREATE INDEX IF NOT EXISTS idx_form_submissions_contact_id
  ON form_submissions (contact_id);

--> statement-breakpoint

-- form_submissions: form filter (formId IN query)
CREATE INDEX IF NOT EXISTS idx_form_submissions_tenant_form
  ON form_submissions (tenant_id, form_id);

--> statement-breakpoint

-- companies: tenant scoping
CREATE INDEX IF NOT EXISTS idx_companies_tenant_id
  ON companies (tenant_id);
