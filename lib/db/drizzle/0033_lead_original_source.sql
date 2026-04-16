ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "original_source" text NOT NULL DEFAULT '';
UPDATE "leads" SET "original_source" = "source" WHERE "original_source" = '' OR "original_source" IS NULL;
