ALTER TABLE "integration_sync_logs"
  ADD COLUMN IF NOT EXISTS "triggered_by_sync_log_id" integer;
