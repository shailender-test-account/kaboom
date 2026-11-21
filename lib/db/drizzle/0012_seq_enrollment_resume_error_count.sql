-- Add resume_error_count to sequence_enrollments so the resume runner can apply
-- exponential backoff and eventually mark permanently-failing enrollments as
-- 'errored' rather than looping forever.
ALTER TABLE sequence_enrollments
  ADD COLUMN IF NOT EXISTS resume_error_count INTEGER NOT NULL DEFAULT 0;
