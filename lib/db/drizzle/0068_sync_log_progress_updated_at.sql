-- Reaper keys staleness off inactivity, not absolute age. A backfill that
-- legitimately runs for many hours but keeps stamping forward progress must
-- never be reaped, while one that stamps progress and then silently dies
-- (OOM on a single task, an unhandled rejection mid-loop) must be recovered
-- shortly after it stops making progress — not only at the next restart.
--
-- The reaper selects rows where COALESCE(progress_updated_at, started_at) is
-- older than the inactivity threshold. Progress writers stamp this column on
-- every chunk advance / batch of records processed; it is null until the
-- first progress write, where the reaper falls back to started_at.

ALTER TABLE "integration_sync_logs"
  ADD COLUMN IF NOT EXISTS "progress_updated_at" timestamp;
