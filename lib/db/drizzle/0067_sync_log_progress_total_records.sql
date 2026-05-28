-- Task #654 — show a percent-complete bar for the revenue recompute, not just
-- a running count. The recompute runs a full re-sync of invoices + estimates
-- and publishes `records_processed` after every batch, but without a known
-- total an operator can't tell whether a run is 10% or 90% done. Capture the
-- upstream total-count (estimated total of invoices / estimates for the tenant)
-- alongside `records_processed` so the UI can derive a percentage.
--
--  * progress_total_records — estimated total record count for non-chunked
--    progress runs. Null on syncs that don't report a total (e.g. incremental
--    polls and windowed backfills, which use the chunk columns instead).

ALTER TABLE "integration_sync_logs"
  ADD COLUMN IF NOT EXISTS "progress_total_records" integer;
