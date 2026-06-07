-- migration:no-transaction
-- Challenge cancellation attribution:
-- Store ServiceTitan's job-created timestamp separately from completion date so
-- lead-cohort reporting can count only downstream jobs from the selected leads.
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "st_job_origin_at" timestamp;
--> statement-breakpoint

COMMENT ON COLUMN "jobs"."st_job_origin_at" IS 'ServiceTitan job createdOn timestamp. Used for lead-cohort downstream job attribution.';
--> statement-breakpoint

DROP INDEX CONCURRENTLY IF EXISTS "jobs_tenant_lead_origin_idx";
--> statement-breakpoint

CREATE INDEX CONCURRENTLY IF NOT EXISTS "jobs_tenant_lead_origin_idx"
ON "jobs" ("tenant_id", "lead_id", "st_job_origin_at");
