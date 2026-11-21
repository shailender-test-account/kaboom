ALTER TABLE activity_events
  ADD COLUMN IF NOT EXISTS tenant_id integer;
ALTER TABLE activity_events
  ADD COLUMN IF NOT EXISTS is_bot boolean NOT NULL DEFAULT false;
ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS is_anonymous boolean NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION enqueue_intent_from_activity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  owning_account_id integer;
  contact_is_anonymous boolean;
  queue_source text;
BEGIN
  BEGIN
    IF NEW.contact_id IS NULL OR NEW.tenant_id IS NULL OR COALESCE(NEW.is_bot, false) THEN
      RETURN NEW;
    END IF;

    SELECT company_id,is_anonymous
      INTO owning_account_id,contact_is_anonymous
    FROM contacts
    WHERE tenant_id = NEW.tenant_id AND id = NEW.contact_id;

    IF NOT FOUND OR COALESCE(contact_is_anonymous, false) THEN
      RETURN NEW;
    END IF;

    queue_source := 'activity:' || COALESCE(NEW.event_type, 'unknown');

    INSERT INTO intent_recompute_queue(tenant_id, contact_id, source)
    VALUES(NEW.tenant_id, NEW.contact_id, queue_source)
    ON CONFLICT (tenant_id, contact_id)
      WHERE contact_id IS NOT NULL AND status IN ('pending', 'claimed')
    DO UPDATE SET
      status = 'pending',
      source = EXCLUDED.source,
      available_at = NOW(),
      claimed_at = NULL,
      error = NULL,
      updated_at = NOW();

    IF owning_account_id IS NOT NULL THEN
      INSERT INTO intent_recompute_queue(tenant_id, account_id, source)
      VALUES(NEW.tenant_id, owning_account_id, queue_source)
      ON CONFLICT (tenant_id, account_id)
        WHERE account_id IS NOT NULL AND status IN ('pending', 'claimed')
      DO UPDATE SET
        status = 'pending',
        source = EXCLUDED.source,
        available_at = NOW(),
        claimed_at = NULL,
        error = NULL,
        updated_at = NOW();
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'Intent activity enqueue failed for tenant %, contact %: %',
      NEW.tenant_id, NEW.contact_id, SQLERRM;
  END;

  RETURN NEW;
END;
$$;