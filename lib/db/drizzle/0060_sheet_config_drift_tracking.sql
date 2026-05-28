-- Track when a Google Sheet connected to Pulse first started drift-skipping
-- (because its column headers changed since the operator-approved mapping).
--
-- The sync poller sets `drift_detected_at` the first cycle it encounters
-- mismatched headers, and clears it the cycle headers come back into
-- alignment (or the operator re-approves a new mapping). `drift_notified_at`
-- is stamped after the alert notification is emitted so the poller only
-- pesters the agency owner once per drift episode, not every minute it
-- continues to be drift-skipped.
ALTER TABLE "google_sheet_configs"
  ADD COLUMN IF NOT EXISTS "drift_detected_at" timestamp;
ALTER TABLE "google_sheet_configs"
  ADD COLUMN IF NOT EXISTS "drift_notified_at" timestamp;
