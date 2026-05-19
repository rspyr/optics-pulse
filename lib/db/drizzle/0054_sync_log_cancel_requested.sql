ALTER TABLE "integration_sync_logs"
  ADD COLUMN IF NOT EXISTS "cancel_requested" boolean NOT NULL DEFAULT false;
