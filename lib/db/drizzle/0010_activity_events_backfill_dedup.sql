-- Prevent duplicate sequence_enrollment_skipped events when two concurrent
-- backfill/recompute scoring runs process the same contact on the same UTC day.
--
-- Background: persistIntentResult in intentScoring.ts writes a
-- sequence_enrollment_skipped event with source='backfill' or
-- source='admin_recompute' and metadata->>'reason'='backfill_suppressed'
-- whenever a non-live scoring run detects an intent-state transition but
-- suppresses routing-rule evaluation.  A SELECT+INSERT race window allows two
-- concurrent runs to both pass the duplicate check and both insert, producing
-- an extra row.
--
-- This migration fixes the race at the database level.  The scope is
-- intentionally narrow:
--   • Only rows where source IN ('backfill','admin_recompute')
--   • Only rows where metadata->>'reason' = 'backfill_suppressed'
--   • Only rows where metadata->>'new_intent_state' IS NOT NULL
-- This ensures sequence_enrollment_skipped rows written by other application
-- paths (e.g. DNC checks, enrollment guards without source metadata) are never
-- touched.
--
-- Step 1: Remove pre-existing duplicates that would block CREATE UNIQUE INDEX.
-- For each (tenant_id, contact_id, source, new_intent_state, UTC day) group
-- keep the oldest row (lowest id) and delete any later duplicates.
DELETE FROM activity_events
WHERE event_type = 'sequence_enrollment_skipped'
  AND source IN ('backfill', 'admin_recompute')
  AND metadata::jsonb->>'reason' = 'backfill_suppressed'
  AND metadata::jsonb->>'new_intent_state' IS NOT NULL
  AND id NOT IN (
    SELECT MIN(id)
    FROM activity_events
    WHERE event_type = 'sequence_enrollment_skipped'
      AND source IN ('backfill', 'admin_recompute')
      AND metadata::jsonb->>'reason' = 'backfill_suppressed'
      AND metadata::jsonb->>'new_intent_state' IS NOT NULL
    GROUP BY
      tenant_id,
      contact_id,
      source,
      (metadata::jsonb->>'new_intent_state'),
      date_trunc('day', created_at AT TIME ZONE 'UTC')
  );--> statement-breakpoint

-- Step 2: Partial unique index scoped to the same narrow predicate.
-- The WHERE clause matches only the backfill-suppressed events, so the index
-- has zero impact on other sequence_enrollment_skipped rows or any other
-- event type.
CREATE UNIQUE INDEX IF NOT EXISTS idx_activity_events_backfill_skipped_dedup
  ON activity_events (
    tenant_id,
    contact_id,
    source,
    (metadata::jsonb->>'new_intent_state'),
    date_trunc('day', created_at AT TIME ZONE 'UTC')
  )
  WHERE event_type = 'sequence_enrollment_skipped'
    AND source IN ('backfill', 'admin_recompute')
    AND metadata::jsonb->>'reason' = 'backfill_suppressed'
    AND metadata::jsonb->>'new_intent_state' IS NOT NULL;--> statement-breakpoint
