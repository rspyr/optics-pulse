ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "oci_uploaded_at" timestamp;
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "enhanced_conversion_uploaded_at" timestamp;
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "capi_uploaded_at" timestamp;