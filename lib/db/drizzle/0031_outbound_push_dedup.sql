ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "oci_uploaded_at" timestamp;
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "enhanced_conversion_uploaded_at" timestamp;
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "capi_uploaded_at" timestamp;

DROP INDEX IF EXISTS "idx_attribution_events_tenant_billing_address";
CREATE INDEX IF NOT EXISTS "idx_attribution_events_tenant_billing_address"
  ON "attribution_events" ("tenant_id", "billing_address")
  WHERE "billing_address" IS NOT NULL;