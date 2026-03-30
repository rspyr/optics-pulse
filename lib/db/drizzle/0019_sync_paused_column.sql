ALTER TABLE "tenant_funnel_types" ADD COLUMN IF NOT EXISTS "sync_paused" boolean DEFAULT true NOT NULL;
UPDATE "tenant_funnel_types" SET "sync_paused" = false WHERE "google_sheet_id" IS NOT NULL AND "column_mapping" IS NOT NULL AND "sync_row_watermark" IS NOT NULL;
