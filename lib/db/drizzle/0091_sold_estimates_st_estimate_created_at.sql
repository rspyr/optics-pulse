-- migration:no-transaction
-- Challenge estimate attribution:
-- Store ServiceTitan's estimate-created timestamp so estimate and sold-value
-- reporting can stay anchored to the selected lead cohort.
ALTER TABLE "sold_estimates" ADD COLUMN IF NOT EXISTS "st_estimate_created_at" timestamp;
--> statement-breakpoint

COMMENT ON COLUMN "sold_estimates"."st_estimate_created_at" IS 'ServiceTitan estimate createdOn timestamp. Used for lead-cohort downstream estimate attribution.';
--> statement-breakpoint

DROP INDEX CONCURRENTLY IF EXISTS "sold_estimates_tenant_lead_created_idx";
--> statement-breakpoint

CREATE INDEX CONCURRENTLY IF NOT EXISTS "sold_estimates_tenant_lead_created_idx"
ON "sold_estimates" ("tenant_id", "lead_id", "st_estimate_created_at");
