ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "new_lead_notified_at" timestamp;
-- Backfill existing rows so the boot scan doesn't re-fire toasts for old leads.
UPDATE "leads" SET "new_lead_notified_at" = "created_at" WHERE "new_lead_notified_at" IS NULL;
