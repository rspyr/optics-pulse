-- Add diagnostic columns to tracker_submit_attempts so we can capture the
-- full request shape (origin, content-length, supplied field NAMES — never
-- values) and so the new /api/collect/diagnostics beacon endpoint can write
-- into the same table with kind='diagnostic'.
--
-- Idempotent guards because this table was created via direct SQL during the
-- 2026-04 outage triage and may already exist in some environments.

ALTER TABLE "tracker_submit_attempts" ADD COLUMN IF NOT EXISTS "kind" text NOT NULL DEFAULT 'submit';--> statement-breakpoint
ALTER TABLE "tracker_submit_attempts" ADD COLUMN IF NOT EXISTS "origin" text;--> statement-breakpoint
ALTER TABLE "tracker_submit_attempts" ADD COLUMN IF NOT EXISTS "content_length" integer;--> statement-breakpoint
ALTER TABLE "tracker_submit_attempts" ADD COLUMN IF NOT EXISTS "supplied_field_names" jsonb;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tsa_kind_created_idx" ON "tracker_submit_attempts" ("kind","created_at");--> statement-breakpoint
-- Backfill kind from endpoint for existing rows so historical queries are consistent.
UPDATE "tracker_submit_attempts" SET "kind" = "endpoint" WHERE "kind" = 'submit' AND "endpoint" <> 'submit';
