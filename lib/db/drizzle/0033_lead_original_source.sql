ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "original_source" text;
UPDATE "leads" SET "original_source" = "source" WHERE "original_source" IS NULL;
ALTER TABLE "leads" ALTER COLUMN "original_source" SET NOT NULL;
