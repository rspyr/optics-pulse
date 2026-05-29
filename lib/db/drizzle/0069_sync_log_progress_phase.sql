-- Surface *what* a long-running backfill chunk is doing, not just the chunk
-- window. The Meta async backfill advances through three slow phases per
-- chunk — generating the async report, paging the completed report, and
-- saving rows to the database — but until now the Settings panel only showed
-- the static chunk window, leaving a multi-minute chunk looking frozen.
--
-- The phase is stamped from inside the existing throttled liveness heartbeat
-- (no extra write volume) and cleared on terminal status. Null on
-- integrations that don't report a phase (e.g. the synchronous Google Ads
-- backfill).

ALTER TABLE "integration_sync_logs"
  ADD COLUMN IF NOT EXISTS "progress_phase" text;
