-- Task #395 — store backfill progress and error metadata as structured
-- columns instead of free-form strings inside `error_message`. The
-- backfill writers (`backfillGoogleAdsCampaigns`, `backfillServiceTitanJobs`,
-- `backfillMetaCampaigns`) used to stash `chunk N/M: …` and `partial: …`
-- strings into `error_message` so the Settings panel could reverse-parse
-- them with regex. That contract was fragile — any tweak to the writer's
-- wording silently broke the progress bar. These columns let writers and
-- readers share a typed contract instead.
--
--  * progress_current_chunk / progress_total_chunks — 1-based chunk index
--    + total chunks, populated while a backfill is running.
--  * progress_window_start / progress_window_end — inclusive YYYY-MM-DD
--    window covered by the current chunk.
--  * error_code — stable classification ('rate_limit',
--    'expired_credentials', 'permission_denied', 'not_configured',
--    'paused', 'already_running', 'tenant_not_found',
--    'upstream_server_error', 'network', 'timeout', 'unknown').
--  * partial — true when a later chunk threw mid-run; some rows already
--    landed before the failure.

ALTER TABLE "integration_sync_logs"
  ADD COLUMN IF NOT EXISTS "progress_current_chunk" integer,
  ADD COLUMN IF NOT EXISTS "progress_total_chunks" integer,
  ADD COLUMN IF NOT EXISTS "progress_window_start" text,
  ADD COLUMN IF NOT EXISTS "progress_window_end" text,
  ADD COLUMN IF NOT EXISTS "error_code" text,
  ADD COLUMN IF NOT EXISTS "partial" boolean NOT NULL DEFAULT false;
