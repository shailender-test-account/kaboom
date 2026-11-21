-- Migration: Add sending_path column to email_events
-- Records whether an email was sent via 'resend' (default) or 'smtp'.
-- Applied as part of sending-path delivery tracking feature.

ALTER TABLE "email_events" ADD COLUMN IF NOT EXISTS "sending_path" text;
