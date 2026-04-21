ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "resubmission_count" integer NOT NULL DEFAULT 0;
