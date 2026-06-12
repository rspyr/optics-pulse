ALTER TABLE "tenants"
  ADD COLUMN IF NOT EXISTS "st_jobs_sync_utc_minute_offset" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "tenants"
  ADD COLUMN IF NOT EXISTS "st_revenue_sync_utc_minute_offset" integer DEFAULT 5 NOT NULL;
--> statement-breakpoint
ALTER TABLE "integration_sync_logs"
  ADD COLUMN IF NOT EXISTS "scheduled_for_utc" timestamp;
--> statement-breakpoint
DO $$
BEGIN
  ALTER TABLE "tenants"
    ADD CONSTRAINT "tenants_st_jobs_sync_utc_minute_offset_check"
    CHECK ("st_jobs_sync_utc_minute_offset" BETWEEN 0 AND 14);
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  ALTER TABLE "tenants"
    ADD CONSTRAINT "tenants_st_revenue_sync_utc_minute_offset_check"
    CHECK ("st_revenue_sync_utc_minute_offset" BETWEEN 0 AND 14);
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "integration_sync_logs_scheduled_slot_idx"
  ON "integration_sync_logs" ("tenant_id", "integration", "sync_type", "scheduled_for_utc")
  WHERE "scheduled_for_utc" IS NOT NULL;
