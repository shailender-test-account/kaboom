-- Deduplicate any existing active enrollment pairs before adding the unique index.
-- Keeps the oldest row (lowest id) for each (sequence_id, contact_id) pair where
-- status = 'active', deleting any later duplicates that crept in.
DELETE FROM sequence_enrollments
WHERE status = 'active'
  AND id NOT IN (
    SELECT MIN(id)
    FROM sequence_enrollments
    WHERE status = 'active'
    GROUP BY sequence_id, contact_id
  );--> statement-breakpoint

-- Partial unique index: prevents two concurrent INSERTs from creating duplicate
-- active enrollments for the same contact+sequence pair. A partial (WHERE status='active')
-- constraint is used so that a contact whose enrollment completed can be re-enrolled.
CREATE UNIQUE INDEX IF NOT EXISTS idx_seq_enrollments_active_unique
  ON sequence_enrollments (sequence_id, contact_id)
  WHERE status = 'active';--> statement-breakpoint
