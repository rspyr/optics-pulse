-- Task #377 — record which underscore-prefixed customer field keys were
-- stripped at ingest (along with the form they came from) so Verify
-- Tracker can warn operators that one of their inputs is colliding with
-- our reserved bookkeeping keys (`_custom`, `_consent`, `_source`, …)
-- and is silently being dropped before the lead is stored.
--
-- Shape: `{ keys: string[], formId: string|null, formName: string|null,
-- formType: string|null }`. Null on rows where nothing was dropped, which
-- is the overwhelming majority — this column is sparse by design.

ALTER TABLE "tracker_submit_attempts"
  ADD COLUMN IF NOT EXISTS "dropped_reserved_field_keys" jsonb;
