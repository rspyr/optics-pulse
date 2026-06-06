-- Challenge cancellation attribution:
-- Store ServiceTitan's job-created timestamp separately from completion date so
-- lead-cohort reporting can count only downstream jobs from the selected leads.
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "st_job_origin_at" timestamp;

COMMENT ON COLUMN "jobs"."st_job_origin_at" IS 'ServiceTitan job createdOn timestamp. Used for lead-cohort downstream job attribution.';

CREATE INDEX IF NOT EXISTS "jobs_tenant_lead_origin_idx"
ON "jobs" ("tenant_id", "lead_id", "st_job_origin_at");
