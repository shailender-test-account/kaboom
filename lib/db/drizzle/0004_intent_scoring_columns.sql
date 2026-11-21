-- Migration: Add composite intent scoring columns to contacts table
-- Applied: 2026-05-25 (Task #239 — multi-signal intent engine)
-- These columns are computed by intentScoring.ts and updated on every activity event.

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS intent_score          INTEGER      NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS raw_intent_score      INTEGER      NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS intent_state          TEXT         NOT NULL DEFAULT 'Browsing',
  ADD COLUMN IF NOT EXISTS suggested_next_action TEXT,
  ADD COLUMN IF NOT EXISTS distinct_active_days  INTEGER      NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS freq_score            NUMERIC(12,4),
  ADD COLUMN IF NOT EXISTS max_stage_score       NUMERIC(12,4),
  ADD COLUMN IF NOT EXISTS engagement_score      NUMERIC(12,4);

COMMENT ON COLUMN contacts.intent_score          IS 'Capped (0-100) composite intent score from multi-signal engine';
COMMENT ON COLUMN contacts.raw_intent_score      IS 'Uncapped raw intent score (may exceed 100)';
COMMENT ON COLUMN contacts.intent_state          IS 'Named state: Browsing|Stuck-Aware|Stuck-PreEngage|Evaluating-Engage|Decision-Action|Re-engaging|Dormant';
COMMENT ON COLUMN contacts.suggested_next_action IS 'Recommended next action derived from intent_state';
COMMENT ON COLUMN contacts.distinct_active_days  IS 'Number of calendar days with at least one activity event';
COMMENT ON COLUMN contacts.freq_score            IS 'Frequency-breadth multiplier fbm = 1 + 0.5*ln(1+distinct_active_days)';
COMMENT ON COLUMN contacts.max_stage_score       IS 'Stage progression bonus spb = 5*(max_stage_rank-1)';
COMMENT ON COLUMN contacts.engagement_score      IS 'Sum of per-session engagement contributions before fbm multiplier';
